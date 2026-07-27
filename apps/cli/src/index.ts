import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDekiDirectories,
  getDekiPaths,
  isWorkspaceTrusted,
  loadMcpConfig,
  readMcpConfig,
  readMcpLocalConfig,
  resolveWorkspace,
  workspaceId,
  writeMcpConfig,
} from "@deki-ai/config";
import { GitCheckpointManager, isGitAvailable } from "@deki-ai/git-checkpoint";
import { McpManager } from "@deki-ai/mcp-manager";
import { DEKI_VERSION } from "@deki-ai/shared";
import {
  ModelConfigStore,
  SettingsStore,
  modelProviderInputSchema,
  permissionCategorySchema,
  permissionPolicySchema,
} from "@deki-ai/settings";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface ParsedArguments {
  positionals: string[];
  options: Map<string, string | true | string[]>;
}

const repeatableOptions = new Set(["arg"]);
const valueOptions = new Set([
  "api-key",
  "arg",
  "command",
  "cwd",
  "data-dir",
  "description",
  "file",
  "limit",
  "message",
  "scope",
  "workspace",
]);

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    const key = rawKey ?? "";
    if (!key) throw new Error("无效的命令行选项");
    let value: string | true = inlineValue ?? true;
    if (inlineValue === undefined && valueOptions.has(key)) {
      const next = argv[index + 1];
      if (!next || (next.startsWith("--") && key !== "arg")) {
        throw new Error(`--${key} 需要一个值`);
      }
      value = next;
      index += 1;
    }
    if (repeatableOptions.has(key)) {
      const previous = options.get(key);
      options.set(key, [...(Array.isArray(previous) ? previous : []), String(value)]);
    } else {
      options.set(key, value);
    }
  }
  return { positionals, options };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = consoleIo,
): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if (parsed.options.has("help") || parsed.positionals[0] === "help") {
      io.stdout(helpText);
      return 0;
    }
    if (parsed.options.has("version")) {
      io.stdout(`Deki CLI ${DEKI_VERSION}`);
      return 0;
    }
    const dataDirectory = optionString(parsed, "data-dir");
    const paths = getDekiPaths(dataDirectory ? resolve(dataDirectory) : undefined);
    await ensureDekiDirectories(paths);
    const command = parsed.positionals[0];
    if (!command || !knownCommands.has(command)) {
      const requested = command && !command.startsWith("-") ? command : optionString(parsed, "workspace");
      const workspace = parsed.options.has("general")
        ? undefined
        : await resolveWorkspace(["--workspace", requested ?? process.cwd()], process.cwd());
      await launchDesktop(workspace, false);
      io.stdout(workspace ? `已启动 Deki：${workspace}` : "已启动 Deki 普通会话");
      return 0;
    }

    if (command === "resume") {
      const workspace = parsed.options.has("general")
        ? undefined
        : await workspaceFrom(parsed, parsed.positionals[1]);
      await launchDesktop(workspace, true);
      io.stdout(workspace ? `正在恢复项目会话：${workspace}` : "正在恢复普通会话");
      return 0;
    }
    if (command === "doctor") return runDoctor(parsed, paths, io);
    if (command === "models") return runModels(parsed, paths, io);
    if (command === "skills") return runSkills(parsed, paths, io);
    if (command === "mcp") return runMcp(parsed, paths, io);
    if (command === "permissions") return runPermissions(parsed, paths, io);
    if (command === "audit") return runAudit(parsed, paths, io);
    if (command === "checkpoint") return runCheckpoint(parsed, io);
    io.stderr(`未知命令：${command}`);
    return 2;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runDoctor(
  parsed: ParsedArguments,
  paths: ReturnType<typeof getDekiPaths>,
  io: CliIo,
): Promise<number> {
  const workspace = parsed.options.has("general") ? undefined : await workspaceFrom(parsed);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({
    name: "Node.js",
    ok: satisfiesNodeVersion(process.versions.node),
    detail: process.versions.node,
  });
  checks.push({
    name: "Git",
    ok: await isGitAvailable(),
    detail: await isGitAvailable() ? "available" : "not found",
  });
  const settings = await createSettingsStore(paths, workspace);
  const snapshot = await settings.initialize();
  checks.push({
    name: "Settings",
    ok: snapshot.diagnostics.length === 0,
    detail: snapshot.diagnostics.join("; ") || `revision ${snapshot.revision}`,
  });
  const providers = await new ModelConfigStore(paths.modelsFile).list();
  const environmentCredentials = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
  ].filter((name) => Boolean(process.env[name]));
  checks.push({
    name: "Cloud models",
    ok: providers.some((provider) => provider.hasApiKey) || environmentCredentials.length > 0,
    detail: `${providers.filter((provider) => provider.hasApiKey).length} stored provider(s), ${environmentCredentials.length} environment credential(s)`,
  });
  if (workspace) {
    checks.push({
      name: "Workspace trust",
      ok: await isWorkspaceTrusted(paths.configFile, workspace),
      detail: workspace,
    });
    const manager = new GitCheckpointManager(workspace);
    checks.push({
      name: "Git checkpoint",
      ok: Boolean(await manager.repositoryRoot()),
      detail: await manager.repositoryRoot() ?? "not a Git repository",
    });
    try {
      const config = await readMcpConfig(workspace);
      checks.push({
        name: "MCP config",
        ok: true,
        detail: `${Object.keys(config.mcpServers).length} server(s)`,
      });
    } catch (error) {
      checks.push({ name: "MCP config", ok: false, detail: formatError(error) });
    }
    const skills = await discoverSkills(workspace, snapshot.effective.skills.globalPaths);
    checks.push({
      name: "Skills",
      ok: skills.every((skill) => skill.valid),
      detail: `${skills.length} discovered, ${skills.filter((skill) => !skill.valid).length} invalid`,
    });
  }
  printValue(io, parsed, checks, () =>
    checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n"));
  return checks.every((check) => check.ok) ? 0 : 1;
}

async function runModels(
  parsed: ParsedArguments,
  paths: ReturnType<typeof getDekiPaths>,
  io: CliIo,
): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const store = new ModelConfigStore(paths.modelsFile);
  if (action === "list") {
    const providers = await store.list();
    printValue(io, parsed, providers, () => providers.length === 0
      ? "尚未配置模型 Provider"
      : providers.map((provider) =>
          `${provider.id}\t${provider.hasApiKey ? "key: configured" : "key: missing"}\t${provider.models.length} model(s)`).join("\n"));
    return 0;
  }
  if (action === "import") {
    const file = optionString(parsed, "file") ?? parsed.positionals[2];
    if (!file) throw new Error("用法：deki models import --file provider.json");
    const raw: unknown = JSON.parse(await readFile(resolve(file), "utf8"));
    const provider = modelProviderInputSchema.parse(raw);
    await store.upsert(provider);
    io.stdout(`已导入模型 Provider：${provider.id}`);
    return 0;
  }
  if (action === "remove") {
    const id = parsed.positionals[2];
    if (!id) throw new Error("用法：deki models remove <provider-id>");
    await store.remove(id);
    io.stdout(`已移除模型 Provider：${id}`);
    return 0;
  }
  throw new Error(`未知 models 子命令：${action}`);
}

async function runSkills(
  parsed: ParsedArguments,
  paths: ReturnType<typeof getDekiPaths>,
  io: CliIo,
): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const workspace = await workspaceFrom(parsed);
  const settings = await createSettingsStore(paths, workspace);
  const snapshot = await settings.initialize();
  if (action === "list") {
    const skills = await discoverSkills(workspace, snapshot.effective.skills.globalPaths);
    printValue(io, parsed, skills, () => skills.length === 0
      ? "未发现 Skill"
      : skills.map((skill) =>
          `${skill.valid ? "✓" : "✗"} ${skill.name}\t${skill.path}${skill.diagnostics.length ? `\t${skill.diagnostics.join("; ")}` : ""}`).join("\n"));
    return skills.every((skill) => skill.valid) ? 0 : 1;
  }
  if (action === "validate") {
    const requested = parsed.positionals[2];
    if (!requested) throw new Error("用法：deki skills validate <SKILL.md|skill-directory>");
    const path = await skillFilePath(resolve(requested));
    const result = await validateSkill(path);
    printValue(io, parsed, result, () =>
      `${result.valid ? "✓" : "✗"} ${result.name}\n${result.diagnostics.join("\n")}`);
    return result.valid ? 0 : 1;
  }
  if (action === "create") {
    const name = parsed.positionals[2];
    if (!name || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(name)) {
      throw new Error("Skill 名称只能包含小写字母、数字、下划线和连字符");
    }
    const description = optionString(parsed, "description") ?? `${name} skill for Deki`;
    const directory = join(workspace, ".deki", "skills", name);
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    await writeFile(join(directory, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
      "Describe when and how this skill should be used.",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o644 });
    io.stdout(`已创建 ${join(directory, "SKILL.md")}`);
    return 0;
  }
  if (action === "pin" || action === "unpin") {
    const requested = parsed.positionals[2];
    if (!requested) throw new Error(`用法：deki skills ${action} <path>`);
    const path = await skillFilePath(resolve(requested));
    const content = await readFile(path, "utf8");
    const version = /^---[\s\S]*?^version:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1]?.trim();
    if (action === "pin" && !version) throw new Error("Skill 未声明 version");
    await writeFile(
      path,
      setSkillFrontmatterValue(content, "pinned-version", action === "pin" ? version : undefined),
      { encoding: "utf8", mode: 0o600 },
    );
    io.stdout(action === "pin" ? `已锁定 Skill 版本 ${version}` : "已解除 Skill 版本锁定");
    return 0;
  }
  if (action === "update") {
    const requested = parsed.positionals[2];
    if (!requested) throw new Error("用法：deki skills update <path>");
    const path = await skillFilePath(resolve(requested));
    const content = await readFile(path, "utf8");
    if (/^pinned-version:\s*\S+/mu.test(content)) {
      throw new Error("Skill 已锁定版本，请先运行 skills unpin");
    }
    const source = /^---[\s\S]*?^source:\s*(https:\/\/\S+)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
    if (!source) throw new Error("Skill 未声明 HTTPS source");
    const response = await fetch(source);
    if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`);
    const next = await response.text();
    if (next.length > 1_000_000) throw new Error("Skill 更新内容超过 1 MB 限制");
    const currentName = /^---[\s\S]*?^name:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1]?.trim();
    const nextName = /^---[\s\S]*?^name:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(next)?.[1]?.trim();
    if (!currentName || currentName !== nextName) throw new Error("更新源的 Skill 名称不一致");
    const temporary = `${path}.update-${crypto.randomUUID()}`;
    await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    io.stdout(`已更新 ${currentName}`);
    return 0;
  }
  throw new Error(`未知 skills 子命令：${action}`);
}

async function runMcp(
  parsed: ParsedArguments,
  paths: ReturnType<typeof getDekiPaths>,
  io: CliIo,
): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const workspace = await workspaceFrom(parsed);
  if (action === "list") {
    const config = await readMcpConfig(workspace);
    const servers = Object.entries(config.mcpServers).map(([id, server]) => ({
      id,
      command: server.command,
      args: server.args,
      enabled: server.enabled,
    }));
    printValue(io, parsed, servers, () => servers.length === 0
      ? "未配置 MCP Server"
      : servers.map((server) =>
          `${server.enabled ? "enabled" : "disabled"}\t${server.id}\t${server.command} ${server.args.join(" ")}`).join("\n"));
    return 0;
  }
  if (action === "add") {
    const id = parsed.positionals[2];
    const command = optionString(parsed, "command");
    if (!id || !/^[A-Za-z0-9_-]+$/u.test(id) || !command) {
      throw new Error("用法：deki mcp add <id> --command <command> [--arg value] [--cwd relative]");
    }
    const cwd = optionString(parsed, "cwd");
    if (cwd && (isAbsolute(cwd) || normalize(cwd).startsWith(".."))) {
      throw new Error("MCP cwd 必须是工作区内的相对路径");
    }
    const config = await readMcpConfig(workspace);
    config.mcpServers[id] = {
      command,
      args: optionStrings(parsed, "arg"),
      ...(cwd ? { cwd } : {}),
      enabled: !parsed.options.has("disabled"),
      tools: {},
    };
    await writeMcpConfig(workspace, config);
    io.stdout(`已添加 MCP Server：${id}`);
    return 0;
  }
  if (action === "remove") {
    const id = parsed.positionals[2];
    if (!id) throw new Error("用法：deki mcp remove <id>");
    const config = await readMcpConfig(workspace);
    delete config.mcpServers[id];
    await writeMcpConfig(workspace, config);
    io.stdout(`已移除 MCP Server：${id}`);
    return 0;
  }
  if (action === "test") {
    const id = parsed.positionals[2];
    if (!id) throw new Error("用法：deki mcp test <id>");
    const config = await loadMcpConfig(workspace);
    const server = config.mcpServers[id];
    if (!server) throw new Error(`未找到 MCP Server：${id}`);
    const local = await readMcpLocalConfig(
      join(paths.projectsRoot, workspaceId(workspace), "mcp-local.json"),
    );
    const manager = new McpManager();
    try {
      const result = await manager.testServer(id, {
        ...server,
        ...(local.servers[id]?.environment
          ? { environment: local.servers[id]?.environment }
          : {}),
      });
      printValue(io, parsed, result, () => result.state === "ready"
        ? `✓ ${id}: ready, ${result.toolCount} tool(s)`
        : `✗ ${id}: ${result.error ?? "unknown error"}`);
      return result.state === "ready" ? 0 : 1;
    } finally {
      await manager.dispose();
    }
  }
  throw new Error(`未知 mcp 子命令：${action}`);
}

async function runPermissions(
  parsed: ParsedArguments,
  paths: ReturnType<typeof getDekiPaths>,
  io: CliIo,
): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const workspace = parsed.options.has("general") ? undefined : await workspaceFrom(parsed);
  const store = await createSettingsStore(paths, workspace);
  const snapshot = await store.initialize();
  if (action === "list") {
    const policies = snapshot.effective.permissions.policies;
    printValue(io, parsed, policies, () =>
      Object.entries(policies).map(([category, policy]) => `${category}\t${policy}`).join("\n"));
    return 0;
  }
  if (action === "set") {
    const category = permissionCategorySchema.parse(parsed.positionals[2]);
    const policy = permissionPolicySchema.parse(parsed.positionals[3]);
    const requestedScope = optionString(parsed, "scope") ?? "global";
    if (requestedScope !== "global" && requestedScope !== "project") {
      throw new Error("--scope 只能是 global 或 project");
    }
    if (requestedScope === "project" && !workspace) {
      throw new Error("项目权限需要 --workspace");
    }
    await store.update(
      requestedScope === "project" ? "projectLocal" : "global",
      {
        permissions: {
          policies: {
            ...snapshot.effective.permissions.policies,
            [category]: policy,
          },
        },
      },
      snapshot.revision,
    );
    io.stdout(`已设置 ${category}=${policy}（${requestedScope}）`);
    return 0;
  }
  throw new Error(`未知 permissions 子命令：${action}`);
}

async function runAudit(
  parsed: ParsedArguments,
  paths: ReturnType<typeof getDekiPaths>,
  io: CliIo,
): Promise<number> {
  const limit = optionInteger(parsed, "limit", 100, 1, 1_000);
  const entries = await readAuditEntries(paths.logsRoot, limit);
  printValue(io, parsed, entries, () => entries.length === 0
    ? "暂无审计记录"
    : entries.map((entry) =>
        `${String(entry.timestamp ?? "")}\t${String(entry.category ?? "")}\t${String((entry.execution as Record<string, unknown> | undefined)?.status ?? entry.decision ?? "")}`).join("\n"));
  return 0;
}

async function runCheckpoint(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number> {
  const action = parsed.positionals[1] ?? "list";
  const workspace = await workspaceFrom(parsed);
  const manager = new GitCheckpointManager(workspace);
  if (action === "list") {
    const checkpoints = await manager.list(
      optionInteger(parsed, "limit", 50, 1, 1_000),
    );
    printValue(io, parsed, checkpoints, () => checkpoints.length === 0
      ? "暂无 Git Checkpoint"
      : checkpoints.map((checkpoint) =>
          `${checkpoint.id}\t${checkpoint.commit.slice(0, 12)}\t${checkpoint.message}`).join("\n"));
    return 0;
  }
  if (action === "create") {
    const checkpoint = await manager.create(
      optionString(parsed, "message") ?? "Manual CLI checkpoint",
    );
    printValue(io, parsed, checkpoint, () =>
      `已创建 ${checkpoint.id} (${checkpoint.commit.slice(0, 12)})，当前 ${checkpoint.changedFiles} 个变更文件`);
    return 0;
  }
  if (action === "show") {
    const id = requiredCheckpointId(parsed);
    const checkpoint = await manager.get(id);
    printValue(io, parsed, checkpoint, () => [
      `ID: ${checkpoint.id}`,
      `Commit: ${checkpoint.commit}`,
      `Created: ${checkpoint.createdAt}`,
      `Message: ${checkpoint.message}`,
    ].join("\n"));
    return 0;
  }
  if (action === "diff") {
    io.stdout(await manager.diff(requiredCheckpointId(parsed)));
    return 0;
  }
  if (action === "restore") {
    const id = requiredCheckpointId(parsed);
    if (!parsed.options.has("yes")) {
      throw new Error("恢复会覆盖工作区文件；确认后请添加 --yes。恢复前会自动创建安全 Checkpoint。");
    }
    const result = await manager.restore(id);
    io.stdout(`已恢复 ${result.restored.id}；恢复前状态保存在 ${result.safetyCheckpoint.id}`);
    return 0;
  }
  if (action === "remove") {
    if (!parsed.options.has("yes")) {
      throw new Error("删除 Checkpoint 引用不可撤销；确认后请添加 --yes");
    }
    const checkpoint = await manager.remove(requiredCheckpointId(parsed));
    io.stdout(`已删除 Checkpoint 引用：${checkpoint.id}`);
    return 0;
  }
  throw new Error(`未知 checkpoint 子命令：${action}`);
}

async function launchDesktop(workspace: string | undefined, resume: boolean): Promise<void> {
  const arguments_ = [
    ...(workspace ? ["--workspace", workspace] : []),
    ...(resume ? ["--resume"] : []),
  ];
  const configured = process.env.DEKI_DESKTOP_PATH;
  if (configured) {
    await spawnDetached(configured, arguments_);
    return;
  }
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Deki.app/Contents/MacOS/Deki",
        join(homedir(), "Applications", "Deki.app", "Contents", "MacOS", "Deki"),
      ]
    : process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "Deki", "Deki.exe")]
      : [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      await spawnDetached(candidate, arguments_);
      return;
    } catch {
      // Continue to the development workspace fallback.
    }
  }
  const repository = await findDekiRepository(import.meta.dirname);
  if (repository) {
    await spawnDetached("pnpm", ["--dir", repository, "dev", "--", ...arguments_]);
    return;
  }
  const onPath = await findOnPath(process.platform === "win32" ? "deki-desktop.exe" : "deki-desktop");
  if (onPath) {
    await spawnDetached(onPath, arguments_);
    return;
  }
  throw new Error("未找到 Deki 桌面程序；可设置 DEKI_DESKTOP_PATH 指向可执行文件");
}

async function spawnDetached(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  child.unref();
}

async function createSettingsStore(
  paths: ReturnType<typeof getDekiPaths>,
  workspace?: string,
): Promise<SettingsStore> {
  return new SettingsStore({
    globalFile: paths.settingsFile,
    ...(workspace ? { workspace } : {}),
    ...(workspace
      ? { projectLocalFile: join(paths.projectsRoot, workspaceId(workspace), "settings.json") }
      : {}),
  });
}

async function workspaceFrom(
  parsed: ParsedArguments,
  positional?: string,
): Promise<string> {
  const requested = optionString(parsed, "workspace") ?? positional ?? process.cwd();
  return resolveWorkspace(["--workspace", requested], process.cwd());
}

function optionString(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function optionStrings(parsed: ParsedArguments, name: string): string[] {
  const value = parsed.options.get(name);
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

function optionInteger(
  parsed: ParsedArguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optionString(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function requiredCheckpointId(parsed: ParsedArguments): string {
  const id = parsed.positionals[2];
  if (!id) throw new Error(`用法：deki checkpoint ${parsed.positionals[1] ?? "show"} <id>`);
  return id;
}

function printValue(
  io: CliIo,
  parsed: ParsedArguments,
  value: unknown,
  text: () => string,
): void {
  io.stdout(parsed.options.has("json") ? JSON.stringify(value, null, 2) : text());
}

function satisfiesNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major === 22 && minor >= 19;
}

interface SkillResult {
  name: string;
  path: string;
  valid: boolean;
  diagnostics: string[];
}

async function discoverSkills(
  workspace: string,
  globalPaths: string[],
): Promise<SkillResult[]> {
  const roots = [
    join(workspace, ".deki", "skills"),
    join(workspace, ".agents", "skills"),
    join(workspace, ".pi", "skills"),
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".codex", "skills"),
    ...globalPaths,
  ];
  const skills: SkillResult[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) skills.push(await validateSkill(join(root, entry.name, "SKILL.md")));
    }
  }
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  return skills.map((skill) => (counts.get(skill.name) ?? 0) > 1
    ? { ...skill, valid: false, diagnostics: [...skill.diagnostics, "Skill 名称冲突"] }
    : skill);
}

async function validateSkill(path: string): Promise<SkillResult> {
  const diagnostics: string[] = [];
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { name: basename(dirname(path)), path, valid: false, diagnostics: ["缺少或无法读取 SKILL.md"] };
  }
  const name = /^---[\s\S]*?^name:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1]?.trim()
    ?? basename(dirname(path));
  const description = /^---[\s\S]*?^description:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1]?.trim();
  if (!/^---\n[\s\S]*?\n---/u.test(content)) diagnostics.push("缺少 YAML frontmatter");
  if (!name) diagnostics.push("缺少 frontmatter name");
  if (!description) diagnostics.push("缺少 frontmatter description");
  return { name, path, valid: diagnostics.length === 0, diagnostics };
}

function setSkillFrontmatterValue(
  content: string,
  key: string,
  value: string | undefined,
): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!frontmatter) throw new Error("Skill 缺少 YAML frontmatter");
  const line = new RegExp(`^${key}:.*$`, "mu");
  let body = frontmatter[1] ?? "";
  if (value) {
    body = line.test(body)
      ? body.replace(line, `${key}: ${value}`)
      : `${body}\n${key}: ${value}`;
  } else {
    body = body.replace(line, "").replaceAll(/\n{3,}/g, "\n\n").trimEnd();
  }
  return content.replace(frontmatter[0], `---\n${body}\n---`);
}

async function skillFilePath(path: string): Promise<string> {
  try {
    return (await stat(path)).isDirectory() ? join(path, "SKILL.md") : path;
  } catch {
    return path.endsWith("SKILL.md") ? path : join(path, "SKILL.md");
  }
}

async function readAuditEntries(logsRoot: string, limit: number): Promise<Record<string, unknown>[]> {
  let files: string[];
  try {
    files = (await readdir(logsRoot))
      .filter((file) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const file of files) {
    const lines = (await readFile(join(logsRoot, file), "utf8")).split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          entries.push(value as Record<string, unknown>);
        }
      } catch {
        // Keep valid audit lines visible if one historical entry is malformed.
      }
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}

async function findDekiRepository(start: string): Promise<string | undefined> {
  let current = resolve(start);
  while (current !== dirname(current)) {
    try {
      const packageJson: unknown = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (
        typeof packageJson === "object"
        && packageJson !== null
        && "name" in packageJson
        && packageJson.name === "deki"
      ) return current;
    } catch {
      // Continue walking upward.
    }
    current = dirname(current);
  }
  return undefined;
}

async function findOnPath(command: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, command);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const knownCommands = new Set([
  "resume",
  "doctor",
  "models",
  "skills",
  "mcp",
  "permissions",
  "audit",
  "checkpoint",
]);

const helpText = `Deki CLI

用法：
  deki [path] [--general]                   启动桌面会话
  deki resume [path] [--general]            恢复最近会话
  deki doctor [--workspace path] [--json]   检查环境、模型、Skill、MCP 和 Git
  deki models list
  deki models import --file provider.json
  deki models remove <provider-id>
  deki skills list [--workspace path]
  deki skills create <name> [--description text]
  deki skills validate <path>
  deki skills update <path>
  deki skills pin|unpin <path>
  deki mcp list [--workspace path]
  deki mcp add <id> --command cmd [--arg value] [--cwd relative]
  deki mcp remove <id>
  deki mcp test <id>
  deki permissions list [--workspace path]
  deki permissions set <category> <allow|ask|deny> [--scope global|project]
  deki audit [--limit 100] [--json]
  deki checkpoint list [--limit 50]
  deki checkpoint create [--message text]
  deki checkpoint show <id>
  deki checkpoint diff <id>
  deki checkpoint restore <id> --yes
  deki checkpoint remove <id> --yes

全局选项：
  --workspace <path>  指定工作区
  --data-dir <path>   覆盖 ~/.deki（适合测试和便携环境）
  --json              结构化输出
  --help              显示帮助
  --version           显示版本
`;

const consoleIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

function isMainModule(url: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === url;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
