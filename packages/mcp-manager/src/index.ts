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

export class McpManager {
  readonly #providers = new Map<string, McpProvider>();
  readonly #statuses = new Map<string, ServerStatus>();
  readonly #listeners = new Set<StatusListener>();

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
    server: McpServerConfig,
    startupTimeoutMs = 20_000,
  ): Promise<CapabilityProvider | undefined> {
    await this.stopServer(id);
    this.#setStatus({ id, state: "starting", toolCount: 0 });
    const provider = new McpProvider(id, server, (error) => {
      this.#providers.delete(id);
      this.#setStatus({ id, state: "error", toolCount: 0, error });
    });
    try {
      await provider.connect(startupTimeoutMs);
      this.#providers.set(id, provider);
      const tools = await provider.listTools();
      this.#setStatus({ id, state: "ready", toolCount: tools.length });
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
    const provider = this.#providers.get(id);
    this.#providers.delete(id);
    if (provider) await provider.dispose();
    if (this.#statuses.has(id)) {
      this.#setStatus({ id, state: "stopped", toolCount: 0 });
    }
  }

  async restartServer(
    id: string,
    server: McpServerConfig,
    startupTimeoutMs = 20_000,
  ): Promise<CapabilityProvider | undefined> {
    return this.startServer(id, server, startupTimeoutMs);
  }

  async listServerTools(id: string): Promise<ToolDefinition[]> {
    return this.#providers.get(id)?.listTools() ?? [];
  }

  async testServer(
    id: string,
    server: McpServerConfig,
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
    const providers = [...this.#providers.values()];
    this.#providers.clear();
    await Promise.allSettled(providers.map((provider) => provider.dispose()));
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
  readonly #config: McpServerConfig;
  readonly #onDisconnect: (error: string) => void;
  #client: Client | undefined;
  #transport: StdioClientTransport | undefined;
  #tools: ToolDefinition[] = [];
  #disposing = false;

  constructor(
    id: string,
    config: McpServerConfig,
    onDisconnect: (error: string) => void,
  ) {
    this.id = id;
    this.#config = config;
    this.#onDisconnect = onDisconnect;
  }

  async connect(startupTimeoutMs = 20_000): Promise<void> {
    const client = new Client({
      name: "deki",
      version: "0.0.0",
    });
    const transport = new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args,
      ...(this.#config.cwd ? { cwd: this.#config.cwd } : {}),
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

    await client.connect(transport, { signal: AbortSignal.timeout(startupTimeoutMs) });
    const response = await client.listTools();
    this.#client = client;
    this.#transport = transport;
    this.#tools = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? `MCP tool ${tool.name}`,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  async listTools(): Promise<ToolDefinition[]> {
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
