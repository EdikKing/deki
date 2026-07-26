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

export class ToolGateway {
  readonly #providers = new Map<string, CapabilityProvider>();
  readonly #tools = new Map<string, GatewayTool>();
  readonly #validators = new Map<string, ValidateFunction>();
  readonly #listeners = new Set<ToolGatewayListener>();
  readonly #ajv = new Ajv({ allErrors: true, strict: false });

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

    const validator = this.#validators.get(modelName);
    if (validator && !validator(input)) {
      const message = this.#ajv.errorsText(validator.errors);
      throw new Error(`Tool 参数无效: ${message}`);
    }

    this.#emit({
      type: "started",
      callId: context.callId,
      toolName: modelName,
      input,
    });

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = context.signal
      ? AbortSignal.any([context.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const result = await provider.callTool(tool.providerToolName, input, {
        ...context,
        signal,
      });
      this.#emit({
        type: "completed",
        callId: context.callId,
        toolName: modelName,
        result,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#emit({
        type: "completed",
        callId: context.callId,
        toolName: modelName,
        error: message,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<Record<string, HealthStatus>> {
    const results = await Promise.all(
      [...this.#providers.entries()].map(async ([id, provider]) => {
        try {
          return [id, await provider.healthCheck()] as const;
        } catch (error) {
          return [
            id,
            {
              state: "error",
              message: error instanceof Error ? error.message : String(error),
            } satisfies HealthStatus,
          ] as const;
        }
      }),
    );
    return Object.fromEntries(results);
  }

  async dispose(): Promise<void> {
    const providers = [...this.#providers.values()];
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
      listener(event);
    }
  }
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
