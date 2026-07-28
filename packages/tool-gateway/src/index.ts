import Ajv, { type ValidateFunction } from "ajv";
import type {
  CapabilityProvider,
  HealthStatus,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@deki-ai/shared";

export interface GatewayTool extends ToolDefinition {
  providerId: string;
  providerToolName: string;
  internalName: string;
  modelName: string;
}

export interface ToolGatewayEvent {
  type: "started" | "completed";
  callId: string;
  toolName: string;
  input?: unknown;
  result?: ToolResult;
  error?: string;
}

export type ToolGatewayListener = (event: ToolGatewayEvent) => void;

export interface ToolGatewayOptions {
  outputLimitBytes?: number;
  maxConcurrentCalls?: number;
}

const DEFAULT_OUTPUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_MAX_CONCURRENT_CALLS = 4;
const TRUNCATION_LABEL = "…Tool 输出已截断";

export class ToolGateway {
  readonly #providers = new Map<string, CapabilityProvider>();
  readonly #tools = new Map<string, GatewayTool>();
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #listeners = new Set<ToolGatewayListener>();
  readonly #ajv = new Ajv({ allErrors: true, strict: false });
  readonly #outputLimitBytes: number;
  readonly #calls: CallLimiter;

  constructor(options: ToolGatewayOptions = {}) {
    this.#outputLimitBytes = positiveInteger(
      options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      "outputLimitBytes",
    );
    this.#calls = new CallLimiter(positiveInteger(
      options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
      "maxConcurrentCalls",
    ));
  }

  async register(provider: CapabilityProvider): Promise<GatewayTool[]> {
    if (this.#providers.has(provider.id)) {
      throw new Error(`CapabilityProvider 已存在: ${provider.id}`);
    }
    if (!isSafeSegment(provider.id)) {
      throw new Error(`CapabilityProvider ID 无效: ${provider.id}`);
    }

    const definitions = await provider.listTools();
    const tools = definitions.map((definition) => this.#createGatewayTool(provider.id, definition));

    for (const tool of tools) {
      if (this.#tools.has(tool.modelName)) {
        throw new Error(`Tool 名称冲突: ${tool.modelName}`);
      }
    }

    this.#providers.set(provider.id, provider);
    for (const tool of tools) {
      this.#tools.set(tool.modelName, tool);
      this.#validators.set(tool.modelName, this.#ajv.compile(tool.inputSchema));
    }
    return tools;
  }

  listTools(): GatewayTool[] {
    return [...this.#tools.values()];
  }

  assertAllowed(
    modelName: string,
    input: unknown,
    context: ToolCallContext,
  ): void {
    const tool = this.#tools.get(modelName);
    if (!tool) throw new Error(`未知 Tool: ${modelName}`);
    assertToolAllowed(tool, input, context);
  }

  async unregister(providerId: string, dispose = true): Promise<boolean> {
    const provider = this.#providers.get(providerId);
    if (!provider) return false;
    this.#providers.delete(providerId);
    for (const [modelName, tool] of this.#tools) {
      if (tool.providerId !== providerId) continue;
      this.#tools.delete(modelName);
      this.#validators.delete(modelName);
    }
    if (dispose) await provider.dispose();
    return true;
  }

  subscribe(listener: ToolGatewayListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async call(
    modelName: string,
    input: unknown,
    context: ToolCallContext,
    timeoutMs = 30_000,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(modelName);
    if (!tool) {
      throw new Error(`未知 Tool: ${modelName}`);
    }
    const provider = this.#providers.get(tool.providerId);
    if (!provider) {
      throw new Error(`Tool Provider 不可用: ${tool.providerId}`);
    }
    assertToolAllowed(tool, input, context);

    const validator = this.#validators.get(modelName);
    if (validator && !validator(input)) {
      const message = this.#ajv.errorsText(validator.errors);
      throw new Error(`Tool 参数无效: ${message}`);
    }

    this.#emit({
      type: "started",
      callId: context.callId,
      toolName: modelName,
      input: redactSensitiveValue(input),
    });

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = context.signal
      ? AbortSignal.any([context.signal, timeoutController.signal])
      : timeoutController.signal;
    let release: (() => void) | undefined;

    try {
      release = await this.#calls.acquire(signal);
      const providerCall = Promise.resolve().then(() => provider.callTool(
        tool.providerToolName,
        input,
        { ...context, signal },
      ));
      void providerCall.then(
        () => release?.(),
        () => release?.(),
      );
      const result = sanitizeToolResult(
        await abortable(providerCall, signal),
        this.#outputLimitBytes,
      );
      this.#emit({
        type: "completed",
        callId: context.callId,
        toolName: modelName,
        result,
      });
      return result;
    } catch (error) {
      const normalized = normalizeCallError(
        error,
        timeoutController.signal.aborted,
        context.signal?.aborted === true,
        timeoutMs,
      );
      this.#emit({
        type: "completed",
        callId: context.callId,
        toolName: modelName,
        error: normalized.message,
      });
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<Record<string, HealthStatus>> {
    const results = await Promise.all(
      [...this.#providers.entries()].map(async ([id, provider]) => {
        try {
          const status = await provider.healthCheck();
          return [
            id,
            {
              ...status,
              ...(status.message
                ? { message: redactSensitiveText(status.message) }
                : {}),
            },
          ] as const;
        } catch (error) {
          return [
            id,
            {
              state: "error",
              message: redactSensitiveText(
                error instanceof Error ? error.message : String(error),
              ),
            } satisfies HealthStatus,
          ] as const;
        }
      }),
    );
    return Object.fromEntries(results);
  }

  async dispose(): Promise<void> {
    const providers = [...this.#providers.values()];
    this.#calls.dispose();
    this.#providers.clear();
    this.#tools.clear();
    this.#validators.clear();
    this.#listeners.clear();
    await Promise.allSettled(providers.map((provider) => provider.dispose()));
  }

  #createGatewayTool(providerId: string, definition: ToolDefinition): GatewayTool {
    if (!isSafeSegment(definition.name)) {
      throw new Error(`Tool 名称无效: ${definition.name}`);
    }
    const internalName = `${providerId}.${definition.name}`;
    const modelName = `${providerId}__${definition.name}`;
    return {
      ...definition,
      providerId,
      providerToolName: definition.name,
      internalName,
      modelName,
    };
  }

  #emit(event: ToolGatewayEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not be able to interrupt or alter a tool call.
      }
    }
  }
}

export class PlanModePolicyError extends Error {
  readonly code = "PLAN_MODE_READ_ONLY";
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Plan 模式仅允许读取和分析操作：${toolName}`);
    this.name = "PlanModePolicyError";
    this.toolName = toolName;
  }
}

function assertToolAllowed(
  tool: GatewayTool,
  input: unknown,
  context: ToolCallContext,
): void {
  if (context.interactionMode !== "plan") return;
  if (tool.effect === "write") {
    throw new PlanModePolicyError(tool.modelName);
  }
  if (tool.effect === "read"
    || tool.effect === "network-read"
    || tool.effect === "interaction"
    || tool.effect === "plan-control"
    || tool.readOnlyHint === true) {
    return;
  }
  if (tool.providerToolName === "bash" && isReadOnlyShellInput(input)) return;
  throw new PlanModePolicyError(tool.modelName);
}

function isReadOnlyShellInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") return false;
  const value = command.trim().toLocaleLowerCase();
  if (/[|;&><`$]/.test(value)) return false;
  return /^(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log|show))\b/.test(value);
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bgh[opusr]_[A-Za-z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    );
}

export function redactSensitiveValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export function sanitizeToolResult(result: ToolResult, limitBytes: number): ToolResult {
  const limit = positiveInteger(limitBytes, "limitBytes");
  if (!result || !Array.isArray(result.content)) {
    throw new Error("Tool 返回结果无效");
  }

  const content: ToolResult["content"] = [];
  let remaining = limit;
  let truncated = false;

  for (const item of result.content) {
    if (item.type === "text" && typeof item.text === "string") {
      const text = redactSensitiveText(item.text);
      const bytes = Buffer.byteLength(text);
      if (bytes <= remaining) {
        content.push({ type: "text", text });
        remaining -= bytes;
        continue;
      }
      const notice = `${TRUNCATION_LABEL}（原始 ${bytes} bytes）`;
      content.push({
        type: "text",
        text: truncateUtf8WithNotice(text, remaining, notice),
      });
      remaining = 0;
      truncated = true;
      break;
    }

    if (
      item.type === "image"
      && typeof item.data === "string"
      && typeof item.mimeType === "string"
    ) {
      const bytes = Buffer.byteLength(item.data) + Buffer.byteLength(item.mimeType);
      if (bytes <= remaining) {
        content.push(item);
        remaining -= bytes;
        continue;
      }
      const notice = `${TRUNCATION_LABEL}（图片 ${bytes} bytes）`;
      content.push({ type: "text", text: truncateUtf8WithNotice("", remaining, notice) });
      remaining = 0;
      truncated = true;
      break;
    }

    throw new Error("Tool 返回了不支持的内容类型");
  }

  let details: unknown;
  if (result.details !== undefined) {
    const redactedDetails = redactSensitiveValue(result.details);
    const detailsBytes = serializedByteLength(redactedDetails);
    if (detailsBytes <= remaining) {
      details = redactedDetails;
      remaining -= detailsBytes;
    } else {
      const summary = {
        truncated: true,
        originalBytes: detailsBytes,
        message: TRUNCATION_LABEL,
      };
      if (serializedByteLength(summary) <= remaining) details = summary;
      truncated = true;
    }
  }

  if (truncated && details === undefined && remaining > 0) {
    content.push({
      type: "text",
      text: truncateUtf8WithNotice("", remaining, TRUNCATION_LABEL),
    });
  }

  return {
    content,
    ...(details !== undefined ? { details } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

class CallLimiter {
  readonly #limit: number;
  #active = 0;
  #disposed = false;
  readonly #waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.#disposed) return Promise.reject(new Error("Tool Gateway 已关闭"));
    if (signal.aborted) return Promise.reject(abortError());
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiting.indexOf(waiter);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(abortError());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  dispose(): void {
    this.#disposed = true;
    for (const waiter of this.#waiting.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("Tool Gateway 已关闭"));
    }
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  #release(): void {
    this.#active -= 1;
    if (this.#disposed) return;
    while (this.#waiting.length > 0) {
      const waiter = this.#waiting.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      this.#active += 1;
      waiter.resolve(this.#releaseOnce());
      return;
    }
  }
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[REDACTED CIRCULAR VALUE]";
    seen.add(value);
    const result = value.map((child) => redactValue(child, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[REDACTED CIRCULAR VALUE]";
    seen.add(value);
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /api.?key|auth(?:orization)?|cookie|credential|password|secret|token/i.test(key)
        ? "[REDACTED]"
        : redactValue(child, seen),
    ]));
    seen.delete(value);
    return result;
  }
  return value;
}

function truncateUtf8WithNotice(value: string, limit: number, notice: string): string {
  if (limit <= 0) return "";
  const noticeBytes = Buffer.byteLength(notice);
  if (noticeBytes >= limit) return truncateUtf8(notice, limit);
  const prefix = truncateUtf8(value, limit - noticeBytes - 1);
  return prefix ? `${prefix}\n${notice}` : notice;
}

function truncateUtf8(value: string, limit: number): string {
  if (limit <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > limit) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("Tool 调用已取消");
  error.name = "AbortError";
  return error;
}

function normalizeCallError(
  error: unknown,
  timedOut: boolean,
  callerAborted: boolean,
  timeoutMs: number,
): Error {
  if (timedOut && !callerAborted) {
    return new Error(`Tool 调用超时（${timeoutMs}ms）`);
  }
  if (callerAborted || (error instanceof Error && error.name === "AbortError")) {
    return abortError();
  }
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return new Error(message);
}
