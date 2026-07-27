import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig, McpServerConfig } from "@deki-ai/config";
import type {
  CapabilityProvider,
  HealthStatus,
  ServerStatus,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@deki-ai/shared";

type StatusListener = (status: ServerStatus) => void;
export type McpServerRuntimeConfig = McpServerConfig & {
  environment?: Record<string, string>;
};

export interface McpResilienceOptions {
  healthCheckIntervalMs?: number;
  autoRestart?: boolean;
  maxReconnectAttempts?: number;
  startupTimeoutMs?: number;
  secretResolver?: (name: string) => string | undefined | Promise<string | undefined>;
}

export class McpManager {
  readonly #providers = new Map<string, McpProvider>();
  readonly #statuses = new Map<string, ServerStatus>();
  readonly #listeners = new Set<StatusListener>();
  readonly #configs = new Map<string, McpServerRuntimeConfig>();
  readonly #reconnectTimers = new Map<string, NodeJS.Timeout>();
  #healthTimer: NodeJS.Timeout | undefined;
  #options: Required<Omit<McpResilienceOptions, "secretResolver">>
    & Pick<McpResilienceOptions, "secretResolver"> = {
      healthCheckIntervalMs: 30_000,
      autoRestart: false,
      maxReconnectAttempts: 5,
      startupTimeoutMs: 20_000,
    };

  constructor(options: McpResilienceOptions = {}) {
    this.configureResilience(options);
  }

  configureResilience(options: McpResilienceOptions): void {
    this.#options = { ...this.#options, ...options };
    this.#restartHealthTimer();
  }

  subscribe(listener: StatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getStatuses(): ServerStatus[] {
    return [...this.#statuses.values()];
  }

  getProviders(): CapabilityProvider[] {
    return [...this.#providers.values()];
  }

  async start(config: McpConfig, startupTimeoutMs = 20_000): Promise<CapabilityProvider[]> {
    await this.dispose();
    this.#statuses.clear();

    const enabled = Object.entries(config.mcpServers).filter(([, server]) => server.enabled);
    await Promise.all(
      enabled.map(([id, server]) => this.startServer(id, server, startupTimeoutMs)),
    );

    return this.getProviders();
  }

  async startServer(
    id: string,
    server: McpServerRuntimeConfig,
    startupTimeoutMs = 20_000,
  ): Promise<CapabilityProvider | undefined> {
    await this.stopServer(id);
    this.#configs.set(id, server);
    this.#setStatus({ id, state: "starting", toolCount: 0 });
    const provider = new McpProvider(
      id,
      server,
      (error) => void this.#recover(id, error),
      this.#options.secretResolver,
    );
    try {
      await provider.connect(startupTimeoutMs);
      this.#providers.set(id, provider);
      const tools = await provider.listTools();
      this.#setStatus({ id, state: "ready", toolCount: tools.length });
      this.#restartHealthTimer();
      return provider;
    } catch (error) {
      await provider.dispose();
      this.#setStatus({
        id,
        state: "error",
        toolCount: 0,
        error: formatError(error),
      });
      return undefined;
    }
  }

  async stopServer(id: string): Promise<void> {
    const timer = this.#reconnectTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#reconnectTimers.delete(id);
    const provider = this.#providers.get(id);
    this.#providers.delete(id);
    if (provider) await provider.dispose();
    if (this.#statuses.has(id)) {
      this.#setStatus({ id, state: "stopped", toolCount: 0 });
    }
  }

  async restartServer(
    id: string,
    server: McpServerRuntimeConfig,
    startupTimeoutMs = 20_000,
  ): Promise<CapabilityProvider | undefined> {
    return this.startServer(id, server, startupTimeoutMs);
  }

  async listServerTools(id: string): Promise<ToolDefinition[]> {
    return this.#providers.get(id)?.listAllTools() ?? [];
  }

  async testServer(
    id: string,
    server: McpServerRuntimeConfig,
    startupTimeoutMs = 20_000,
  ): Promise<{ state: "ready" | "error"; toolCount: number; error?: string }> {
    const probe = new McpProvider(id, server, () => {});
    try {
      await probe.connect(startupTimeoutMs);
      const tools = await probe.listTools();
      const health = await probe.healthCheck();
      return health.state === "ready"
        ? { state: "ready", toolCount: tools.length }
        : { state: "error", toolCount: 0, error: health.message ?? "健康检查失败" };
    } catch (error) {
      return { state: "error", toolCount: 0, error: formatError(error) };
    } finally {
      await probe.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = undefined;
    for (const timer of this.#reconnectTimers.values()) clearTimeout(timer);
    this.#reconnectTimers.clear();
    const providers = [...this.#providers.values()];
    this.#providers.clear();
    await Promise.allSettled(providers.map((provider) => provider.dispose()));
  }

  async checkHealth(): Promise<ServerStatus[]> {
    await Promise.all([...this.#providers.entries()].map(async ([id, provider]) => {
      const health = await provider.healthCheck();
      const tools = await provider.listTools();
      if (health.state === "ready") {
        this.#setStatus({
          id,
          state: "ready",
          toolCount: tools.length,
          lastCheckedAt: new Date().toISOString(),
        });
        return;
      }
      if (health.state === "degraded") {
        this.#setStatus({
          id,
          state: "degraded",
          toolCount: tools.length,
          error: health.message,
          lastCheckedAt: new Date().toISOString(),
        });
        return;
      }
      await this.#recover(id, health.message ?? "MCP 健康检查失败");
    }));
    return this.getStatuses();
  }

  async #recover(id: string, error: string): Promise<void> {
    const provider = this.#providers.get(id);
    const config = this.#configs.get(id);
    if (!provider || !config) {
      this.#setStatus({ id, state: "error", toolCount: 0, error });
      return;
    }
    const previous = this.#statuses.get(id)?.reconnectAttempt ?? 0;
    if (!this.#options.autoRestart || previous >= this.#options.maxReconnectAttempts) {
      this.#providers.delete(id);
      void provider.dispose();
      this.#setStatus({
        id,
        state: "error",
        toolCount: 0,
        error,
        reconnectAttempt: previous,
        lastCheckedAt: new Date().toISOString(),
      });
      return;
    }
    if (this.#reconnectTimers.has(id)) return;
    const attempt = previous + 1;
    this.#setStatus({
      id,
      state: "reconnecting",
      toolCount: 0,
      error,
      reconnectAttempt: attempt,
      lastCheckedAt: new Date().toISOString(),
    });
    const delay = Math.min(30_000, 500 * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(id);
      void provider.reconnect(this.#options.startupTimeoutMs)
        .then(async () => {
          const tools = await provider.listTools();
          this.#setStatus({
            id,
            state: "ready",
            toolCount: tools.length,
            reconnectAttempt: 0,
            lastCheckedAt: new Date().toISOString(),
          });
        })
        .catch((reason: unknown) => this.#recover(id, formatError(reason)));
    }, delay);
    timer.unref();
    this.#reconnectTimers.set(id, timer);
  }

  #restartHealthTimer(): void {
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = undefined;
    if (this.#options.healthCheckIntervalMs <= 0) return;
    this.#healthTimer = setInterval(() => {
      void this.checkHealth();
    }, this.#options.healthCheckIntervalMs);
    this.#healthTimer.unref();
  }

  #setStatus(status: ServerStatus): void {
    this.#statuses.set(status.id, status);
    for (const listener of this.#listeners) {
      listener(status);
    }
  }
}

class McpProvider implements CapabilityProvider {
  readonly id: string;
  readonly #config: McpServerRuntimeConfig;
  readonly #onDisconnect: (error: string) => void;
  readonly #secretResolver: McpResilienceOptions["secretResolver"];
  #client: Client | undefined;
  #transport: StdioClientTransport | undefined;
  #tools: ToolDefinition[] = [];
  #disposing = false;

  constructor(
    id: string,
    config: McpServerRuntimeConfig,
    onDisconnect: (error: string) => void,
    secretResolver?: McpResilienceOptions["secretResolver"],
  ) {
    this.id = id;
    this.#config = config;
    this.#onDisconnect = onDisconnect;
    this.#secretResolver = secretResolver;
  }

  async connect(startupTimeoutMs = 20_000): Promise<void> {
    const client = new Client({
      name: "deki",
      version: "0.0.0",
    });
    const environment = this.#config.environment
      ? await resolveSecretReferences(this.#config.environment, this.#secretResolver)
      : undefined;
    const transport = new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args,
      ...(this.#config.cwd ? { cwd: this.#config.cwd } : {}),
      ...(environment
        ? {
            env: {
              ...Object.fromEntries(Object.entries(process.env)
                .flatMap(([key, value]) => value === undefined ? [] : [[key, value] as const])),
              ...environment,
            },
          }
        : {}),
      stderr: "pipe",
    });
    client.onclose = () => {
      if (!this.#disposing) {
        this.#onDisconnect("MCP stdio 连接已意外关闭");
      }
    };
    client.onerror = (error) => {
      if (!this.#disposing) {
        this.#onDisconnect(formatError(error));
      }
    };

    this.#client = client;
    this.#transport = transport;
    await client.connect(transport, { signal: AbortSignal.timeout(startupTimeoutMs) });
    const response = await client.listTools();
    this.#tools = response.tools.map((tool) => {
      const rule = this.#config.tools[tool.name];
      return {
        name: tool.name,
        description: tool.description ?? `MCP tool ${tool.name}`,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        readOnlyHint: tool.annotations?.readOnlyHint === true,
        enabled: rule?.enabled ?? true,
        ...(rule?.permission ? { permission: rule.permission } : {}),
        ...(rule?.timeoutMs ? { timeoutMs: rule.timeoutMs } : {}),
      };
    });
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.#tools.filter((tool) => tool.enabled !== false);
  }

  listAllTools(): ToolDefinition[] {
    return [...this.#tools];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const client = this.#client;
    if (!client) {
      throw new Error(`MCP Server 尚未连接: ${this.id}`);
    }

    const result = await client.callTool(
      {
        name,
        arguments: isRecord(input) ? input : {},
      },
      CallToolResultSchema,
      context.signal ? { signal: context.signal } : undefined,
    );

    const content = Array.isArray(result.content) ? result.content : [];
    return {
      content: content.map((item: unknown) => normalizeContent(item)),
      details: result.structuredContent,
      isError: result.isError === true,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.#client) {
      return { state: "error", message: "MCP Server 未连接" };
    }
    try {
      await this.#client.ping();
      return { state: "ready" };
    } catch (error) {
      return { state: "error", message: formatError(error) };
    }
  }

  async reconnect(startupTimeoutMs = 20_000): Promise<void> {
    const client = this.#client;
    const transport = this.#transport;
    this.#disposing = true;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools = [];
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      // The old connection is already unusable.
    }
    this.#disposing = false;
    await this.connect(startupTimeoutMs);
  }

  async dispose(): Promise<void> {
    this.#disposing = true;
    const client = this.#client;
    this.#client = undefined;
    this.#tools = [];
    if (client) {
      await client.close();
    } else if (this.#transport) {
      await this.#transport.close();
    }
    this.#transport = undefined;
  }
}

export async function resolveSecretReferences(
  environment: Record<string, string>,
  resolver: McpResilienceOptions["secretResolver"] = (name) => process.env[name],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    const match = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value.trim());
    if (!match) {
      result[key] = value;
      continue;
    }
    const secret = await resolver?.(match[1]!);
    if (!secret) throw new Error(`未找到 MCP Secret: ${match[1]}`);
    result[key] = secret;
  }
  return result;
}

function normalizeContent(item: unknown): ToolResult["content"][number] {
  if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
    return { type: "text", text: item.text };
  }
  if (
    isRecord(item)
    && item.type === "image"
    && typeof item.data === "string"
    && typeof item.mimeType === "string"
  ) {
    return {
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
    };
  }
  return {
    type: "text",
    text: JSON.stringify(item),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
