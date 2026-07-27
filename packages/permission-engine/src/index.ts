import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  rename,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  DekiSettings,
  PermissionCategory,
  PermissionPolicy,
} from "@deki-ai/settings";
import type {
  AgentEvent,
  CapabilityProvider,
  HealthStatus,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@deki-ai/shared";

export type ApprovalDecision =
  | "allow_once"
  | "allow_session"
  | "allow_project"
  | "deny";

type AgentEventInput<T extends AgentEvent = AgentEvent> =
  T extends AgentEvent ? Omit<T, "eventId" | "timestamp" | "sessionId"> : never;

export interface PermissionRequest {
  callId: string;
  category: PermissionCategory;
  title: string;
  description: string;
  details: Record<string, unknown>;
  diff?: string;
  policy?: PermissionPolicy;
  grantKey?: string;
}

export interface PermissionEngineOptions {
  workspace: string;
  logsRoot: string;
  settings: DekiSettings;
  sessionId: () => string | undefined;
  model: () => string | undefined;
  emit: (event: AgentEvent) => void;
  persistProjectGrant?: (category: PermissionCategory, grantKey?: string) => Promise<void>;
}

interface PendingApproval {
  request: PermissionRequest;
  resolve: (decision: ApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AuthorizedOperation {
  request: PermissionRequest;
  policy: PermissionPolicy;
  decision: ApprovalDecision;
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class PermissionEngine {
  readonly #options: PermissionEngineOptions;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #sessionGrants = new Set<string>();
  readonly #authorized = new Map<string, AuthorizedOperation>();
  readonly #cleanupPromise: Promise<void>;

  constructor(options: PermissionEngineOptions) {
    this.#options = options;
    this.#cleanupPromise = cleanupAuditLogs(
      options.logsRoot,
      options.settings.permissions.auditRetentionDays,
    );
  }

  get workspace(): string {
    return this.#options.workspace;
  }

  async authorize(request: PermissionRequest): Promise<void> {
    const grantKey = request.grantKey ?? request.category;
    const fullAccess = Object.values(
      this.#options.settings.permissions.policies,
    ).every((policy) => policy === "allow");
    const policy = this.#sessionGrants.has(grantKey)
      ? "allow"
      : fullAccess
        ? "allow"
        : request.policy ?? this.#options.settings.permissions.policies[request.category];
    let decision: ApprovalDecision = policy === "allow" ? "allow_once" : "deny";
    if (policy === "ask") decision = await this.#ask(request);
    if (decision === "allow_session") this.#sessionGrants.add(grantKey);
    if (decision === "allow_project") {
      this.#sessionGrants.add(grantKey);
      await this.#options.persistProjectGrant?.(request.category, request.grantKey);
    }
    if (policy === "deny" || decision === "deny") {
      await this.#audit(request, policy, decision, {
        status: "denied",
        error: "权限策略拒绝了操作",
      });
      throw new PermissionDeniedError(`权限策略拒绝了操作：${request.title}`);
    }
    this.#authorized.set(request.callId, { request, policy, decision });
  }

  async authorizePath(
    callId: string,
    operation: "read" | "write" | "delete",
    requestedPath: string,
    diff?: string,
  ): Promise<string> {
    const normalizedWorkspace = await realpath(this.#options.workspace);
    const path = await normalizeWorkspacePath(normalizedWorkspace, requestedPath);
    const sensitive = isSensitivePath(path);
    const outside = !isWithin(normalizedWorkspace, path);
    const category: PermissionCategory = sensitive
      ? "sensitiveFiles"
      : outside
        ? "outsideWorkspace"
        : operation === "read"
          ? "workspace.read"
          : operation === "delete"
            ? "workspace.delete"
            : "workspace.write";
    await this.authorize({
      callId,
      category,
      title: `${operation.toUpperCase()} ${relative(normalizedWorkspace, path) || "."}`,
      description: outside ? "目标位于工作区外" : "目标位于受信任工作区内",
      details: { operation, path },
      ...(diff ? { diff } : {}),
    });
    return path;
  }

  async authorizeShell(callId: string, command: string): Promise<void> {
    const boundaryViolation = inspectShellBoundary(command);
    const category = boundaryViolation?.category ?? classifyShell(command);
    await this.authorize({
      callId,
      category,
      title: `Shell: ${command.slice(0, 120)}`,
      description: boundaryViolation?.description ?? shellDescription(category),
      details: {
        command: redactText(command),
        cwd: this.#options.workspace,
        networkTargets: extractNetworkTargets(command),
      },
    });
  }

  async authorizeMove(
    callId: string,
    sourcePath: string,
    destinationPath: string,
    diff: string,
  ): Promise<{ source: string; destination: string }> {
    const workspace = await realpath(this.#options.workspace);
    const source = await normalizeWorkspacePath(workspace, sourcePath);
    const destination = await normalizeWorkspacePath(workspace, destinationPath);
    const paths = [source, destination];
    const sensitive = paths.some(isSensitivePath);
    const outside = paths.some((path) => !isWithin(workspace, path));
    await this.authorize({
      callId,
      category: sensitive
        ? "sensitiveFiles"
        : outside
          ? "outsideWorkspace"
          : "workspace.delete",
      title: `MOVE ${relative(workspace, source)} → ${relative(workspace, destination)}`,
      description: outside ? "源路径或目标路径位于工作区外" : "移动工作区内的文件或目录",
      details: { operation: "move", source, destination },
      diff,
    });
    return { source, destination };
  }

  respond(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.#pending.delete(requestId);
    pending.resolve(decision);
    this.#emit({
      type: "approval.resolved",
      requestId,
      decision,
    });
    return true;
  }

  dispose(): void {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      pending.resolve("deny");
      this.#pending.delete(requestId);
    }
  }

  async recordDiff(callId: string, diff: string): Promise<void> {
    const authorized = this.#authorized.get(callId);
    if (authorized) authorized.request.diff = diff;
    this.#emit({ type: "diff.available", callId, diff });
  }

  async recordExecution(
    callId: string,
    status: "succeeded" | "failed",
    detail?: unknown,
  ): Promise<void> {
    const authorized = this.#authorized.get(callId);
    if (!authorized) return;
    this.#authorized.delete(callId);
    await this.#audit(
      authorized.request,
      authorized.policy,
      authorized.decision,
      status === "succeeded"
        ? { status, result: detail }
        : { status, error: detail instanceof Error ? detail.message : String(detail) },
    );
  }

  async #ask(request: PermissionRequest): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    const expiresAt = new Date(
      Date.now() + this.#options.settings.permissions.approvalTimeoutMs,
    ).toISOString();
    const decision = new Promise<ApprovalDecision>((resolveDecision) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        resolveDecision("deny");
        this.#emit({
          type: "approval.resolved",
          requestId,
          decision: "deny",
        });
      }, this.#options.settings.permissions.approvalTimeoutMs);
      this.#pending.set(requestId, { request, resolve: resolveDecision, timeout });
    });
    this.#emit({
      type: "approval.requested",
      requestId,
      category: request.category,
      title: request.title,
      description: request.description,
      details: redactValue(request.details),
      ...(request.diff ? { diff: redactText(request.diff) } : {}),
      expiresAt,
    });
    return decision;
  }

  async #audit(
    request: PermissionRequest,
    policy: PermissionPolicy,
    decision: ApprovalDecision,
    execution: {
      status: "denied" | "succeeded" | "failed";
      result?: unknown;
      error?: string;
    },
  ): Promise<void> {
    await this.#cleanupPromise;
    const recordId = randomUUID();
    const day = new Date().toISOString().slice(0, 10);
    const record = {
      id: recordId,
      timestamp: new Date().toISOString(),
      sessionId: this.#options.sessionId(),
      model: this.#options.model(),
      workspace: this.#options.workspace,
      callId: request.callId,
      category: request.category,
      policy,
      decision,
      execution: redactValue(execution),
      details: redactValue(request.details),
      ...(request.diff ? { diff: redactText(request.diff) } : {}),
    };
    await mkdir(this.#options.logsRoot, { recursive: true });
    await appendFile(
      resolve(this.#options.logsRoot, `audit-${day}.jsonl`),
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    this.#emit({ type: "audit.recorded", recordId });
  }

  #emit(event: AgentEventInput): void {
    this.#options.emit({
      ...event,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      ...(this.#options.sessionId() ? { sessionId: this.#options.sessionId() } : {}),
    } as AgentEvent);
  }
}

export class WorkspaceToolsProvider implements CapabilityProvider {
  readonly id = "workspace";
  readonly #permissions: PermissionEngine;
  readonly #outputLimitBytes: number;
  readonly #ignore: string[];
  readonly #beforeMutation:
    | ((operation: "edit" | "write" | "delete" | "move" | "bash", context: ToolCallContext) => Promise<void>)
    | undefined;

  constructor(
    permissions: PermissionEngine,
    outputLimitBytes = 1_000_000,
    ignore: string[] = [".git", "node_modules", "dist", "out", "release"],
    beforeMutation?: (
      operation: "edit" | "write" | "delete" | "move" | "bash",
      context: ToolCallContext,
    ) => Promise<void>,
  ) {
    this.#permissions = permissions;
    this.#outputLimitBytes = outputLimitBytes;
    this.#ignore = ignore;
    this.#beforeMutation = beforeMutation;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      tool("read", "Read a UTF-8 text file in the trusted workspace.", {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 10_000 },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      tool("ls", "List files and directories.", pathSchema),
      tool("find", "Find file paths by a case-insensitive name substring.", {
        type: "object",
        properties: {
          path: { type: "string" },
          pattern: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 2_000 },
        },
        required: ["path", "pattern"],
        additionalProperties: false,
      }),
      tool("grep", "Search UTF-8 project files for text or a regular expression.", {
        type: "object",
        properties: {
          path: { type: "string" },
          pattern: { type: "string", minLength: 1 },
          regex: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 2_000 },
        },
        required: ["path", "pattern"],
        additionalProperties: false,
      }),
      tool("edit", "Replace an exact text fragment in a workspace file.", {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      }),
      tool("write", "Create or replace a UTF-8 text file in the workspace.", {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      tool("delete", "Delete a file or directory in the trusted workspace.", pathSchema),
      tool("move", "Move a file or directory within the trusted workspace.", {
        type: "object",
        properties: {
          source: { type: "string" },
          destination: { type: "string" },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      }),
      tool("bash", "Run a shell command in the trusted workspace.", {
        type: "object",
        properties: { command: { type: "string", minLength: 1 } },
        required: ["command"],
        additionalProperties: false,
      }),
    ];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    try {
      const params = asRecord(input);
      let result: ToolResult;
      if (name === "read") result = await this.#read(params, context);
      else if (name === "ls") result = await this.#ls(params, context);
      else if (name === "find") result = await this.#find(params, context);
      else if (name === "grep") result = await this.#grep(params, context);
      else if (name === "edit") result = await this.#edit(params, context);
      else if (name === "write") result = await this.#write(params, context);
      else if (name === "delete") result = await this.#delete(params, context);
      else if (name === "move") result = await this.#move(params, context);
      else if (name === "bash") result = await this.#bash(params, context);
      else throw new Error(`未知工作区 Tool: ${name}`);
      await this.#permissions.recordExecution(context.callId, "succeeded", {
        isError: result.isError === true,
        contentItems: result.content.length,
      });
      return result;
    } catch (error) {
      await this.#permissions.recordExecution(context.callId, "failed", error);
      throw error;
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    return { state: "ready" };
  }

  async dispose(): Promise<void> {}

  async #read(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const path = await this.#permissions.authorizePath(
      context.callId,
      "read",
      stringParam(params, "path"),
    );
    const lines = (await readFile(path, "utf8")).split("\n");
    const offset = numberParam(params, "offset", 0);
    const limit = numberParam(params, "limit", 500);
    return textResult(lines.slice(offset, offset + limit).join("\n"), this.#outputLimitBytes);
  }

  async #ls(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const path = await this.#permissions.authorizePath(
      context.callId,
      "read",
      stringParam(params, "path"),
    );
    const entries = await readdir(path, { withFileTypes: true });
    return textResult(
      entries.map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`).join("\n"),
      this.#outputLimitBytes,
    );
  }

  async #find(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const root = await this.#permissions.authorizePath(
      context.callId,
      "read",
      stringParam(params, "path"),
    );
    const pattern = stringParam(params, "pattern").toLocaleLowerCase();
    const limit = numberParam(params, "limit", 500);
    const files = await walkFiles(root, limit * 5, this.#ignore);
    const matches = files.filter((file) => basename(file).toLocaleLowerCase().includes(pattern)).slice(0, limit);
    return textResult(matches.map((file) => relative(this.#permissions.workspace, file)).join("\n"), this.#outputLimitBytes);
  }

  async #grep(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const root = await this.#permissions.authorizePath(
      context.callId,
      "read",
      stringParam(params, "path"),
    );
    const pattern = stringParam(params, "pattern");
    const matcher = params.regex === true ? new RegExp(pattern, "iu") : undefined;
    const limit = numberParam(params, "limit", 500);
    const results: string[] = [];
    for (const file of await walkFiles(root, 5_000, this.#ignore)) {
      if (results.length >= limit) break;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let index = 0; index < lines.length && results.length < limit; index += 1) {
        const line = lines[index] ?? "";
        if (matcher ? matcher.test(line) : line.includes(pattern)) {
          results.push(`${relative(this.#permissions.workspace, file)}:${index + 1}:${line}`);
        }
      }
    }
    return textResult(results.join("\n"), this.#outputLimitBytes);
  }

  async #edit(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const requestedPath = stringParam(params, "path");
    const oldText = stringParam(params, "oldText");
    const newText = stringParam(params, "newText");
    const resolved = await normalizeWorkspacePath(this.#permissions.workspace, requestedPath);
    const before = await readFile(resolved, "utf8");
    const matches = before.split(oldText).length - 1;
    if (matches !== 1) throw new Error(`oldText 必须精确匹配一次，当前匹配 ${matches} 次`);
    const after = before.replace(oldText, newText);
    const diff = createUnifiedDiff(
      relative(await realpath(this.#permissions.workspace), resolved),
      before,
      after,
    );
    const path = await this.#permissions.authorizePath(context.callId, "write", requestedPath, diff);
    await this.#beforeMutation?.("edit", context);
    await writeFile(path, after, "utf8");
    await this.#permissions.recordDiff(context.callId, diff);
    return textResult(diff, this.#outputLimitBytes);
  }

  async #write(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const requestedPath = stringParam(params, "path");
    const content = stringParam(params, "content");
    const resolved = await normalizeWorkspacePath(this.#permissions.workspace, requestedPath);
    let before = "";
    try {
      before = await readFile(resolved, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const diff = createUnifiedDiff(
      relative(await realpath(this.#permissions.workspace), resolved),
      before,
      content,
    );
    const path = await this.#permissions.authorizePath(context.callId, "write", requestedPath, diff);
    await this.#beforeMutation?.("write", context);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    await this.#permissions.recordDiff(context.callId, diff);
    return textResult(diff, this.#outputLimitBytes);
  }

  async #bash(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const command = stringParam(params, "command");
    await this.#permissions.authorizeShell(context.callId, command);
    if (classifyShell(command) !== "shell.safe") {
      await this.#beforeMutation?.("bash", context);
    }
    const before = await snapshotWorkspace(this.#permissions.workspace, this.#ignore);
    try {
      const output = await runShell(command, this.#permissions.workspace, context.signal, this.#outputLimitBytes);
      const after = await snapshotWorkspace(this.#permissions.workspace, this.#ignore);
      const diff = diffSnapshots(before, after);
      if (diff) await this.#permissions.recordDiff(context.callId, diff);
      return textResult(diff ? `${output}\n\n${diff}` : output, this.#outputLimitBytes);
    } catch (error) {
      const after = await snapshotWorkspace(this.#permissions.workspace, this.#ignore);
      const diff = diffSnapshots(before, after);
      if (diff) await this.#permissions.recordDiff(context.callId, diff);
      throw error;
    }
  }

  async #delete(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const requestedPath = stringParam(params, "path");
    const resolved = await normalizeWorkspacePath(this.#permissions.workspace, requestedPath);
    const before = await snapshotPath(resolved);
    const relativePath = relative(await realpath(this.#permissions.workspace), resolved);
    const diff = before.size === 0
      ? `--- a/${relativePath}\n+++ /dev/null\n@@ deleted path @@`
      : [...before.entries()].map(([path, content]) =>
          createUnifiedDiff(relativePathForSnapshot(relativePath, path), content, "")).join("\n");
    const path = await this.#permissions.authorizePath(context.callId, "delete", requestedPath, diff);
    await this.#beforeMutation?.("delete", context);
    await rm(path, { recursive: true });
    await this.#permissions.recordDiff(context.callId, diff);
    return textResult(diff, this.#outputLimitBytes);
  }

  async #move(params: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult> {
    const sourcePath = stringParam(params, "source");
    const destinationPath = stringParam(params, "destination");
    const source = await normalizeWorkspacePath(this.#permissions.workspace, sourcePath);
    const before = await snapshotPath(source);
    const workspace = await realpath(this.#permissions.workspace);
    const sourceRelative = relative(workspace, source);
    const destination = await normalizeWorkspacePath(workspace, destinationPath);
    const destinationRelative = relative(workspace, destination);
    const diff = before.size === 0
      ? `rename ${sourceRelative} => ${destinationRelative}`
      : [...before.entries()].flatMap(([path, content]) => {
          const child = relativePathForSnapshot("", path);
          return [
            createUnifiedDiff(relativePathForSnapshot(sourceRelative, child), content, ""),
            createUnifiedDiff(relativePathForSnapshot(destinationRelative, child), "", content),
          ];
        }).join("\n");
    const authorized = await this.#permissions.authorizeMove(
      context.callId,
      sourcePath,
      destinationPath,
      diff,
    );
    await this.#beforeMutation?.("move", context);
    await mkdir(dirname(authorized.destination), { recursive: true });
    await rename(authorized.source, authorized.destination);
    await this.#permissions.recordDiff(context.callId, diff);
    return textResult(diff, this.#outputLimitBytes);
  }
}

export async function normalizeWorkspacePath(
  workspace: string,
  requestedPath: string,
): Promise<string> {
  const candidate = resolve(workspace, requestedPath);
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    let parent = dirname(candidate);
    while (parent !== dirname(parent)) {
      try {
        const realParent = await realpath(parent);
        return resolve(realParent, relative(parent, candidate));
      } catch (parentError) {
        if (!isNotFound(parentError)) throw parentError;
        parent = dirname(parent);
      }
    }
    return candidate;
  }
}

export function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLocaleLowerCase();
  return (
    /(^|\/)\.env(?:\.|$)/.test(normalized)
    || /(^|\/)\.ssh(\/|$)/.test(normalized)
    || /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(normalized)
    || normalized.includes("/library/application support/google/chrome/")
    || normalized.includes("/library/keychains/")
    || normalized.includes("/browser/")
  );
}

export function classifyShell(command: string): PermissionCategory {
  const value = command.trim().toLocaleLowerCase();
  if (/(^|\s)(sudo|doas|su)\b/.test(value)) return "privileged";
  if (/\bgit\s+push\b/.test(value)) return "git.push";
  if (/\bgit\s+commit\b/.test(value)) return "git.commit";
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:add|install|update|remove)\b/.test(value)
    || /\b(?:pip|cargo|brew|apt|dnf)\s+(?:install|add|remove|upgrade)\b/.test(value)) {
    return "dependencies.install";
  }
  if (/\b(?:curl|wget|ssh|scp|nc|telnet)\b/.test(value)) return "network";
  if (/\b(?:rm|mv|cp)\b/.test(value) || /[|;&><`$]/.test(value)) return "shell.unknown";
  if (/^(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log))\b/.test(value)) {
    return "shell.safe";
  }
  return "shell.unknown";
}

export function inspectShellBoundary(command: string): {
  category: "outsideWorkspace" | "sensitiveFiles";
  description: string;
} | undefined {
  const normalized = command.replaceAll("\\", "/").toLocaleLowerCase();
  if (
    /(^|[\s"'=])(?:~\/|\.\.\/|\/(?!dev\/null(?:\s|$))|[a-z]:\/)/u.test(normalized)
    || /\$(?:home|userprofile|appdata)\b|\$\{(?:home|userprofile|appdata)\}|%(?:userprofile|appdata)%/iu.test(command)
    || /(?:^|[\s;&|])(?:bash|sh|zsh|fish|cmd|powershell|pwsh)\s+(?:-c|\/c)\b/iu.test(command)
    || /(?:^|[\s;&|])(?:node|python\d*|ruby|perl|php|osascript)\s+(?:-e|-c)\b/iu.test(command)
    || /\beval\b|\$\(|`/u.test(command)
  ) {
    return {
      category: "outsideWorkspace",
      description: "命令包含无法安全限定到工作区的路径或动态执行方式",
    };
  }
  if (
    isSensitivePath(normalized)
    || /(^|[\s"'=])(?:\.env(?:\.|[\s"';&|]|$)|\.ssh\/|id_rsa\b|id_ed25519\b|credentials\b|secrets?\b)/u.test(normalized)
  ) {
    return {
      category: "sensitiveFiles",
      description: "命令引用了敏感文件或凭据位置",
    };
  }
  return undefined;
}

export function createUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const body = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
  return body.join("\n");
}

export function redactText(value: string): string {
  return value
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bgh[opusr]_[A-Za-z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN[\s\S]+?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /key|token|secret|password/i.test(key) ? "[REDACTED]" : redactValue(child),
    ]));
  }
  return value;
}

async function cleanupAuditLogs(logsRoot: string, retentionDays: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(logsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/u.exec(entry.name);
      if (!match?.[1] || match[1] >= cutoffDay) return;
      try {
        await unlink(resolve(logsRoot, entry.name));
      } catch {
        // Retention cleanup must not block a tool call.
      }
    }));
}

function isWithin(workspace: string, path: string): boolean {
  const relation = relative(workspace, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function shellDescription(category: PermissionCategory): string {
  if (category === "privileged") return "提权命令默认拒绝";
  if (category === "dependencies.install") return "依赖安装会修改项目或系统状态";
  if (category === "git.commit" || category === "git.push") return "Git 写操作需要明确批准";
  if (category === "network") return "命令将访问网络";
  return category === "shell.safe" ? "已识别为常规只读/验证命令" : "命令较复杂或可能修改状态";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const pathSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
} as const;

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  return { name, description, inputSchema };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool 参数必须是对象");
  }
  return value as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string") throw new Error(`${name} 必须是字符串`);
  return value;
}

function numberParam(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = params[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textResult(text: string, limit: number): ToolResult {
  const bytes = Buffer.byteLength(text);
  const normalized = bytes <= limit
    ? text
    : `${Buffer.from(text).subarray(0, limit).toString("utf8")}\n…输出已截断（${bytes} bytes）`;
  return { content: [{ type: "text", text: normalized }] };
}

async function walkFiles(
  root: string,
  limit: number,
  ignore: string[] = [".git", "node_modules", "dist", "out", "release"],
): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      files.push(current);
      continue;
    }
    for (const entry of entries) {
      const relativeEntry = relative(root, resolve(current, entry.name)).replaceAll("\\", "/");
      if (ignore.some((pattern) => matchesIgnore(relativeEntry, entry.name, pattern))) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

async function snapshotWorkspace(
  workspace: string,
  ignore?: string[],
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of await walkFiles(workspace, 2_000, ignore)) {
    try {
      const content = await readFile(file);
      if (content.byteLength <= 2_000_000 && !content.includes(0)) {
        snapshot.set(relative(workspace, file), content.toString("utf8"));
      }
    } catch {
      // Files may disappear while a command is running.
    }
  }
  return snapshot;
}

async function snapshotPath(path: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of await walkFiles(path, 2_000)) {
    try {
      const content = await readFile(file);
      if (content.byteLength <= 2_000_000 && !content.includes(0)) {
        snapshot.set(relative(path, file), content.toString("utf8"));
      }
    } catch {
      // Binary, unreadable, or concurrently removed files use the path-only preview.
    }
  }
  return snapshot;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .sort()
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => createUnifiedDiff(path, before.get(path) ?? "", after.get(path) ?? ""))
    .join("\n");
}

function relativePathForSnapshot(root: string, child: string): string {
  return [root, child]
    .filter((part) => part && part !== ".")
    .join("/")
    .replaceAll(/\/+/g, "/");
}

function extractNetworkTargets(command: string): string[] {
  const urls = command.match(/https?:\/\/[^\s"'<>]+/giu) ?? [];
  const sshTargets = [...command.matchAll(/\b(?:ssh|scp)\s+(?:-[^\s]+\s+)*([^\s]+)/giu)]
    .flatMap((match) => match[1] ? [match[1]] : []);
  return [...new Set([...urls, ...sshTargets])].slice(0, 20);
}

function matchesIgnore(relativePath: string, name: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replaceAll(/^\.\//g, "").replaceAll(/\*+/g, "");
  return Boolean(normalized)
    && (name === normalized || relativePath === normalized || relativePath.startsWith(`${normalized}/`));
}

async function runShell(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<string> {
  const shell = process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { command: process.env.SHELL ?? "/bin/sh", args: ["-lc", command] };
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(shell.command, shell.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const append = (chunk: Buffer) => {
      if (bytes >= limit) return;
      chunks.push(chunk.subarray(0, Math.max(0, limit - bytes)));
      bytes += chunk.length;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signalName) => {
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolveOutput(output || "(no output)");
      else reject(new Error(`${output}\n命令退出：${code ?? signalName ?? "unknown"}`.trim()));
    });
  });
}
