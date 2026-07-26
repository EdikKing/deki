import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  ModelRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type AgentSessionEvent,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadMcpConfig, type DekiPaths } from "@deki-ai/config";
import { McpManager } from "@deki-ai/mcp-manager";
import { MemoryEngine } from "@deki-ai/memory-engine";
import {
  PermissionEngine,
  WorkspaceToolsProvider,
  type ApprovalDecision,
} from "@deki-ai/permission-engine";
import type { DekiSettings } from "@deki-ai/settings";
import {
  DEKI_VERSION,
  type AgentEvent,
  type CapabilityProvider,
  type MemoryRecord,
  type ModelSummary,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
} from "@deki-ai/shared";
import { ToolGateway, type GatewayTool } from "@deki-ai/tool-gateway";

export interface DekiAgentRuntimeOptions {
  workspace: string;
  scopeId: string;
  projectFeatures?: boolean;
  paths: DekiPaths;
  memoryEngine: MemoryEngine;
  mcpManager: McpManager;
  settings: DekiSettings;
  persistProjectGrant?: (category: import("@deki-ai/settings").PermissionCategory) => Promise<void>;
  onEvent: (event: AgentEvent) => void;
}

export interface RuntimeSnapshot {
  ready: boolean;
  streaming: boolean;
  sessionId?: string;
  models: ModelSummary[];
  selectedModel?: ModelSummary;
  recalledMemories: MemoryRecord[];
  skills: string[];
  diagnostics: string[];
}

type ModelType = Model<any>;
type AgentEventInput<T extends AgentEvent = AgentEvent> =
  T extends AgentEvent ? Omit<T, "eventId" | "timestamp" | "sessionId"> : never;

export class AgentSessionEventSubscription {
  #unsubscribe: (() => void) | undefined;

  bind(
    session: Pick<AgentSessionRuntime["session"], "subscribe">,
    listener: (event: AgentSessionEvent) => void,
  ): void {
    this.dispose();
    this.#unsubscribe = session.subscribe(listener);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}

export class DekiAgentRuntime {
  readonly #options: DekiAgentRuntimeOptions;
  readonly #gateway = new ToolGateway();
  #modelRuntime: ModelRuntime | undefined;
  #models: ModelType[] = [];
  #selectedModel: ModelType | undefined;
  #runtime: AgentSessionRuntime | undefined;
  readonly #sessionEvents = new AgentSessionEventSubscription();
  #recalledMemories: MemoryRecord[] = [];
  #skills: string[] = [];
  #diagnostics: string[] = [];
  #streaming = false;
  #permissions: PermissionEngine | undefined;
  #lastPrompt: string | undefined;

  constructor(options: DekiAgentRuntimeOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    if (this.#projectFeaturesEnabled()) {
      this.#permissions = new PermissionEngine({
        workspace: this.#options.workspace,
        logsRoot: this.#options.paths.logsRoot,
        settings: this.#options.settings,
        sessionId: () => this.#runtime?.session.sessionId,
        model: () => this.#selectedModel
          ? `${this.#selectedModel.provider}/${this.#selectedModel.id}`
          : undefined,
        emit: this.#options.onEvent,
        ...(this.#options.persistProjectGrant
          ? { persistProjectGrant: this.#options.persistProjectGrant }
          : {}),
      });
      await this.#gateway.register(new WorkspaceToolsProvider(
        this.#permissions,
        this.#options.settings.advanced.toolOutputLimitBytes,
      ));

      this.#recalledMemories = this.#options.settings.memory.projectMemoryEnabled
        ? this.#options.memoryEngine.recallProjectMemories(
            this.#options.scopeId,
            "",
            {
              limit: this.#options.settings.memory.projectRecallLimit,
              characterBudget: this.#options.settings.memory.projectCharacterBudget,
            },
          )
        : [];

      await this.#gateway.register(new ProjectInfoProvider(this.#options.workspace));

      if (this.#options.settings.mcp.startEnabledServers) {
        const mcpConfig = await loadMcpConfig(this.#options.workspace);
        const mcpProviders = await this.#options.mcpManager.start(mcpConfig);
        for (const provider of mcpProviders) {
          try {
            await this.#gateway.register(provider);
          } catch (error) {
            this.#addDiagnostic(`MCP Tool 注册失败 (${provider.id}): ${formatError(error)}`, "error");
          }
        }
      }

      this.#skills = this.#options.settings.skills.enabled
        ? await discoverWorkspaceSkills(this.#options.workspace)
        : [];
      this.#addDiagnostic(
        this.#skills.length > 0
          ? `已发现项目 Skill: ${this.#skills.join(", ")}`
          : "当前工作区未发现项目 Skill",
      );
    } else {
      this.#addDiagnostic("普通会话模式：未启用项目 Tool、Skill、MCP 和记忆");
      if (this.#options.settings.memory.userMemoryEnabled) {
        this.#recalledMemories = this.#options.memoryEngine.recallMemories(
          "user",
          "user",
          "",
          {
            limit: this.#options.settings.memory.userRecallLimit,
            characterBudget: this.#options.settings.memory.userCharacterBudget,
          },
        );
      }
    }

    this.#modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: this.#options.paths.modelsFile,
      allowModelNetwork: false,
    });
    this.#models = [...await this.#modelRuntime.getAvailable()];
    const configured = this.#projectFeaturesEnabled()
      ? this.#options.settings.models.projectModel
      : this.#options.settings.models.generalModel;
    this.#selectedModel = this.#models.find(
      (model) => `${model.provider}/${model.id}` === configured,
    ) ?? this.#models[0];

    if (!this.#selectedModel) {
      this.#addDiagnostic(
        "未发现可用云模型。请在终端设置 OPENAI_API_KEY、ANTHROPIC_API_KEY 等环境变量后重新启动。",
        "warning",
      );
      return;
    }

    await this.#createRuntime();
  }

  snapshot(): RuntimeSnapshot {
    const sessionId = this.#runtime?.session.sessionId;
    return {
      ready: this.#runtime !== undefined,
      streaming: this.#streaming,
      ...(sessionId ? { sessionId } : {}),
      models: this.#models.map(toModelSummary),
      ...(this.#selectedModel
        ? { selectedModel: toModelSummary(this.#selectedModel) }
        : {}),
      recalledMemories: [...this.#recalledMemories],
      skills: [...this.#skills],
      diagnostics: [...this.#diagnostics],
    };
  }

  async prompt(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (trimmed.startsWith("/remember ")) {
      this.remember(trimmed.slice("/remember ".length));
      return;
    }

    const runtime = this.#runtime;
    if (!runtime) {
      throw new Error("Agent 尚未就绪，请先配置云模型环境变量");
    }
    if (runtime.session.isStreaming) {
      throw new Error("Agent 正在运行，请等待完成或先停止");
    }

    this.#streaming = true;
    this.#lastPrompt = trimmed;
    try {
      await runtime.session.prompt(trimmed);
    } catch (error) {
      this.#streaming = false;
      this.#emit({
        type: "run.failed",
        error: formatError(error),
      });
      throw error;
    }
  }

  remember(content: string): MemoryRecord {
    if (!this.#projectFeaturesEnabled() && !this.#options.settings.memory.userMemoryEnabled) {
      throw new Error("普通会话的用户记忆未启用，请先在设置中开启");
    }
    if (this.#projectFeaturesEnabled() && !this.#options.settings.memory.projectMemoryEnabled) {
      throw new Error("项目记忆未启用，请先在设置中开启");
    }
    const memory = this.#options.memoryEngine.createMemory({
      scope: this.#projectFeaturesEnabled() ? "project" : "user",
      scopeId: this.#projectFeaturesEnabled() ? this.#options.scopeId : "user",
      content,
      source: {
        kind: "user_command",
        ...(this.#runtime?.session.sessionId
          ? { sessionId: this.#runtime.session.sessionId }
          : {}),
      },
    });
    this.#emit({ type: "memory.saved", memory });
    return memory;
  }

  async newSession(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) {
      throw new Error("Agent 尚未就绪");
    }
    if (runtime.session.isStreaming) {
      throw new Error("Agent 正在运行，无法新建会话");
    }

    this.#recalledMemories = this.#projectFeaturesEnabled()
      ? this.#options.settings.memory.projectMemoryEnabled
        ? this.#options.memoryEngine.recallProjectMemories(
            this.#options.scopeId,
            "",
            {
              limit: this.#options.settings.memory.projectRecallLimit,
              characterBudget: this.#options.settings.memory.projectCharacterBudget,
            },
          )
        : []
      : this.#options.settings.memory.userMemoryEnabled
        ? this.#options.memoryEngine.listMemories("user", "user", {
            limit: this.#options.settings.memory.userRecallLimit,
          }).filter((memory, index, all) => {
            const used = all.slice(0, index).reduce((sum, item) => sum + item.content.length, 0);
            return used + memory.content.length <= this.#options.settings.memory.userCharacterBudget;
          })
        : [];
    const result = await runtime.newSession();
    if (result.cancelled) return;
    if (this.#recalledMemories.length > 0) {
      this.#emit({
        type: "memory.used",
        memories: this.#recalledMemories,
      });
    }
    this.#emit({
      type: "session.ready",
      model: this.#selectedModel ? toModelSummary(this.#selectedModel) : undefined,
    });
  }

  async selectModel(provider: string, id: string): Promise<void> {
    const model = this.#models.find(
      (candidate) => candidate.provider === provider && candidate.id === id,
    );
    if (!model) {
      throw new Error(`模型不可用: ${provider}/${id}`);
    }
    this.#selectedModel = model;
    if (this.#runtime) {
      await this.#runtime.session.setModel(model);
    } else {
      await this.#createRuntime();
    }
  }

  async abort(): Promise<void> {
    if (!this.#runtime?.session.isStreaming) return;
    await this.#runtime.session.abort();
    this.#streaming = false;
  }

  respondToApproval(requestId: string, decision: ApprovalDecision): boolean {
    return this.#permissions?.respond(requestId, decision) ?? false;
  }

  async dispose(): Promise<void> {
    this.#sessionEvents.dispose();
    this.#permissions?.dispose();
    this.#permissions = undefined;
    if (this.#runtime) {
      await this.#runtime.dispose();
      this.#runtime = undefined;
    }
    await this.#gateway.dispose();
    await this.#options.mcpManager.dispose();
  }

  async #createRuntime(): Promise<void> {
    const modelRuntime = this.#modelRuntime;
    const selectedModel = this.#selectedModel;
    if (!modelRuntime || !selectedModel) return;

    const sessionDirectory = join(
      this.#options.paths.sessionsRoot,
      this.#options.scopeId,
    );
    const createRuntime = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
      sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"];
    }) => {
      const recalled = [...this.#recalledMemories];
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.#options.paths.root,
        modelRuntime,
        resourceLoaderOptions: {
          noContextFiles: !this.#projectFeaturesEnabled(),
          noExtensions: !this.#projectFeaturesEnabled(),
          noPromptTemplates: !this.#projectFeaturesEnabled(),
          noSkills: !this.#projectFeaturesEnabled(),
          noThemes: !this.#projectFeaturesEnabled(),
          additionalSkillPaths: this.#projectFeaturesEnabled()
            ? [
                join(cwd, ".deki", "skills"),
                join(cwd, ".agents", "skills"),
                join(cwd, ".pi", "skills"),
                ...this.#options.settings.skills.globalPaths,
              ]
            : [],
          skillsOverride: (base) => ({
            ...base,
            skills: base.skills.filter(
              (skill) => !this.#options.settings.skills.disabledNames.includes(skill.name),
            ),
          }),
          agentsFilesOverride: (current) => ({
            agentsFiles: recalled.length === 0
              ? current.agentsFiles
              : [
                  ...current.agentsFiles,
                  {
                    path: "deki://memory/project.md",
                    content: renderMemoryContext(recalled),
                  },
                ],
          }),
        },
      });
      if (this.#projectFeaturesEnabled()) {
        this.#skills = [...new Set([
          ...this.#skills,
          ...services.resourceLoader.getSkills().skills.map((skill) => skill.name),
        ])];
        this.#addDiagnostic(
          this.#skills.length > 0
            ? `已加载项目 Skill: ${this.#skills.join(", ")}`
            : "项目 Skill Loader 已运行，未加载任何 Skill",
        );
      }
      for (const diagnostic of services.diagnostics) {
        this.#addDiagnostic(diagnostic.message, diagnostic.type);
      }

      const tools = this.#projectFeaturesEnabled()
        ? this.#gateway.listTools()
        : [];
      return {
        ...await createAgentSessionFromServices({
          services,
          sessionManager,
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
          model: selectedModel,
          tools: this.#projectFeaturesEnabled()
            ? tools.map((tool) => tool.modelName)
            : [],
          customTools: tools.map((tool) => this.#toPiTool(tool)),
        }),
        services,
        diagnostics: services.diagnostics,
      };
    };

    this.#runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.#options.workspace,
      agentDir: this.#options.paths.root,
      sessionManager: SessionManager.create(this.#options.workspace, sessionDirectory),
    });
    this.#runtime.session.setAutoCompactionEnabled(
      this.#options.settings.agent.compactionEnabled,
    );
    this.#runtime.session.setAutoRetryEnabled(
      this.#options.settings.models.maxRetries > 0,
    );
    this.#runtime.session.setThinkingLevel(
      this.#options.settings.models.thinkingLevel,
    );
    this.#runtime.setRebindSession(async (session) => {
      this.#bindSession(session);
    });
    this.#bindSession(this.#runtime.session);
    if (this.#recalledMemories.length > 0) {
      this.#emit({ type: "memory.used", memories: this.#recalledMemories });
    }
    this.#emit({
      type: "session.ready",
      model: toModelSummary(selectedModel),
    });
  }

  #toPiTool(tool: GatewayTool): PiToolDefinition {
    return defineTool({
      name: tool.modelName,
      label: tool.internalName,
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      execute: async (toolCallId, params, signal) => {
        const context: ToolCallContext = {
          callId: toolCallId,
          workspace: this.#options.workspace,
          ...(signal ? { signal } : {}),
        };
        if (tool.providerId !== "workspace" && tool.providerId !== "deki") {
          const readOnly = /^(?:get|list|read|search|find|query|status|health)/i.test(
            tool.providerToolName,
          );
          await this.#permissions?.authorize({
            callId: toolCallId,
            category: readOnly ? "mcp.read" : "mcp.write",
            title: `MCP ${tool.internalName}`,
            description: readOnly
              ? "MCP Tool 被识别为只读调用"
              : "MCP Tool 可能产生外部副作用",
            details: { provider: tool.providerId, tool: tool.providerToolName, input: params },
          });
        }
        const result = await this.#gateway.call(
          tool.modelName,
          params,
          context,
          this.#options.settings.mcp.callTimeoutMs,
        );
        return {
          content: result.content,
          details: result.details ?? {},
        };
      },
    });
  }

  #bindSession(session: AgentSessionRuntime["session"]): void {
    this.#sessionEvents.bind(session, (event) => {
      this.#handleSessionEvent(event);
    });
  }

  #handleSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_end") {
      this.#streaming = false;
      this.#createAutomaticMemoryCandidate();
    }
    const translated = translatePiAgentEvent(event);
    if (translated) {
      this.#emit(translated);
    }
  }

  #createAutomaticMemoryCandidate(): void {
    const prompt = this.#lastPrompt;
    this.#lastPrompt = undefined;
    if (!prompt || !this.#options.settings.memory.automaticCandidates) return;
    const project = this.#projectFeaturesEnabled();
    if (!project && !this.#options.settings.memory.userMemoryEnabled) return;
    try {
      const content = prompt.length > 500 ? `${prompt.slice(0, 500)}…` : prompt;
      const memory = this.#options.memoryEngine.createMemory({
        scope: project ? "project" : "user",
        scopeId: project ? this.#options.scopeId : "user",
        content,
        source: {
          kind: "agent_candidate",
          ...(this.#runtime?.session.sessionId
            ? { sessionId: this.#runtime.session.sessionId }
            : {}),
          detail: "成功任务结束后生成，等待用户确认",
        },
        type: "experience",
        status: "pending",
      });
      this.#emit({ type: "memory.saved", memory });
    } catch (error) {
      this.#addDiagnostic(`自动记忆候选未保存: ${formatError(error)}`, "warning");
    }
  }

  #addDiagnostic(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    if (!this.#diagnostics.includes(message)) {
      this.#diagnostics.push(message);
    }
    this.#emit({ type: "diagnostic", level, message });
  }

  #emit(event: AgentEventInput): void {
    this.#options.onEvent({
      ...event,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...(this.#runtime?.session.sessionId
        ? { sessionId: this.#runtime.session.sessionId }
        : {}),
    } as AgentEvent);
  }

  #projectFeaturesEnabled(): boolean {
    return this.#options.projectFeatures !== false;
  }
}

export function translatePiAgentEvent(
  event: AgentSessionEvent,
): AgentEventInput | undefined {
  switch (event.type) {
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta"
        ? {
            type: "message.delta",
            delta: event.assistantMessageEvent.delta,
          }
        : undefined;
    case "message_end":
      return { type: "message.completed" };
    case "tool_execution_start":
      return {
        type: "tool.started",
        callId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
      };
    case "tool_execution_update":
      return {
        type: "tool.updated",
        callId: event.toolCallId,
        toolName: event.toolName,
        update: event.partialResult,
      };
    case "tool_execution_end":
      return {
        type: "tool.completed",
        callId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        result: event.result,
      };
    case "agent_end":
      return { type: "run.completed" };
    default:
      return undefined;
  }
}

class ProjectInfoProvider implements CapabilityProvider {
  readonly id = "deki";
  readonly #workspace: string;

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "project_info",
      description: "返回当前 Deki 工作区的路径、产品版本和权限保护状态。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }];
  }

  async callTool(
    name: string,
    _input: unknown,
    _context: ToolCallContext,
  ): Promise<ToolResult> {
    if (name !== "project_info") {
      throw new Error(`未知 Deki Tool: ${name}`);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          workspace: this.#workspace,
          version: DEKI_VERSION,
          mode: "permission-protected",
        }, null, 2),
      }],
      details: { readOnly: true },
    };
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose(): Promise<void> {}
}

function renderMemoryContext(memories: readonly MemoryRecord[]): string {
  const lines = memories.map(
    (memory) => `- [${memory.id}] ${memory.content}（来源：${memory.source.kind}）`,
  );
  return [
    "# Deki 项目记忆",
    "",
    "以下内容由用户明确保存，仅在与当前任务相关时使用：",
    "",
    ...lines,
  ].join("\n");
}

async function discoverWorkspaceSkills(workspace: string): Promise<string[]> {
  const roots = [
    join(workspace, ".deki", "skills"),
    join(workspace, ".agents", "skills"),
    join(workspace, ".pi", "skills"),
  ];
  const names = new Set<string>();

  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          await access(join(root, entry.name, "SKILL.md"));
          names.add(entry.name);
        } catch {
          // A directory without SKILL.md is not a Skill.
        }
      }
    } catch {
      // Missing optional Skill roots are expected.
    }
  }
  return [...names].sort();
}

function toModelSummary(model: ModelType): ModelSummary {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
