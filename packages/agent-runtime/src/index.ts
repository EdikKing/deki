import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type AgentSessionEvent,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadMcpConfig, type DekiPaths } from "@deki-ai/config";
import { GitCheckpointManager } from "@deki-ai/git-checkpoint";
import { McpManager } from "@deki-ai/mcp-manager";
import { MemoryEngine } from "@deki-ai/memory-engine";
import {
  PermissionEngine,
  WorkspaceToolsProvider,
  type ApprovalDecision,
} from "@deki-ai/permission-engine";
import { ModelConfigStore, type DekiSettings } from "@deki-ai/settings";
import {
  DEKI_VERSION,
  type AgentEvent,
  type CapabilityProvider,
  type ConversationMessage,
  type MemoryRecord,
  type MemoryScope,
  type ModelSummary,
  type SessionSummary,
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
  mcpEnvironment?: Record<string, Record<string, string>>;
  persistProjectGrant?: (
    category: import("@deki-ai/settings").PermissionCategory,
    grantKey?: string,
  ) => Promise<void>;
  onEvent: (event: AgentEvent) => void;
  resumeLatest?: boolean;
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
  readonly #gateway: ToolGateway;
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
  #checkpointManager: GitCheckpointManager | undefined;
  #runtimeToolSignature = toolDefinitionSignature([]);

  constructor(options: DekiAgentRuntimeOptions) {
    this.#options = options;
    this.#gateway = new ToolGateway({
      outputLimitBytes: options.settings.advanced.toolOutputLimitBytes,
      maxConcurrentCalls: options.settings.agent.maxConcurrentRuns,
    });
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
      if (
        this.#options.settings.workspace.detectGit
        && this.#options.settings.workspace.gitCheckpointBeforeWrite
      ) {
        const manager = new GitCheckpointManager(this.#options.workspace);
        if (await manager.repositoryRoot()) {
          this.#checkpointManager = manager;
          this.#addDiagnostic("已启用修改前 Git Checkpoint");
        }
      }
      await this.#gateway.register(new WorkspaceToolsProvider(
        this.#permissions,
        this.#options.settings.advanced.toolOutputLimitBytes,
        this.#options.settings.workspace.contextIgnore,
        this.#checkpointManager
          ? async (operation) => {
              const checkpoint = await this.#checkpointManager?.create(
                `Before agent ${operation}`,
              );
              if (checkpoint) {
                this.#emit({
                  type: "diagnostic",
                  level: "info",
                  message: `已创建 Git Checkpoint: ${checkpoint.id}`,
                });
              }
            }
          : undefined,
      ));

      this.#recalledMemories = this.#options.settings.memory.projectMemoryEnabled
        && this.#options.settings.workspace.loadProjectMemory
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
        const mcpConfig = await this.#loadRuntimeMcpConfig();
        const mcpProviders = await this.#options.mcpManager.start(
          mcpConfig,
          this.#options.settings.mcp.startupTimeoutMs,
        );
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
      if (this.#options.settings.workspace.detectGit) {
        try {
          await access(join(this.#options.workspace, ".git"));
          this.#addDiagnostic("已检测到 Git 工作区");
        } catch {
          this.#addDiagnostic("当前项目不是 Git 工作区");
        }
      }
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
    const configuredProviders = await new ModelConfigStore(this.#options.paths.modelsFile).list();
    const disabledProviders = new Set(
      configuredProviders
        .filter((provider) => provider.enabled === false)
        .map((provider) => provider.id),
    );
    this.#models = [...await this.#modelRuntime.getAvailable()]
      .filter((model) => !disabledProviders.has(model.provider));
    const configured = this.#projectFeaturesEnabled()
      ? this.#options.settings.models.projectModel
      : this.#options.settings.models.generalModel;
    this.#selectedModel = this.#models.find(
      (model) => `${model.provider}/${model.id}` === configured,
    ) ?? this.#models[0];

    if (!this.#selectedModel) {
      this.#addDiagnostic(
        "未发现可用云模型。请在“设置 → 模型与提供方”中填写 API Key，或通过进程环境变量提供凭据。",
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
    if (trimmed.startsWith("/remember --task ")) {
      this.remember(trimmed.slice("/remember --task ".length), "task");
      return;
    }
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
    if (
      this.#options.settings.agent.autoNameSessions
      && !runtime.session.sessionName
    ) {
      runtime.session.setSessionName(createSessionTitle(trimmed));
    }
    await this.#injectRelevantMemories(trimmed);

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

  remember(content: string, requestedScope?: MemoryScope): MemoryRecord {
    const scope = requestedScope
      ?? (this.#projectFeaturesEnabled() ? "project" : "user");
    if (scope === "user" && !this.#options.settings.memory.userMemoryEnabled) {
      throw new Error("普通会话的用户记忆未启用，请先在设置中开启");
    }
    if (scope === "project" && !this.#projectFeaturesEnabled()) {
      throw new Error("普通会话没有项目记忆作用域");
    }
    if (scope === "project" && !this.#options.settings.memory.projectMemoryEnabled) {
      throw new Error("项目记忆未启用，请先在设置中开启");
    }
    if (scope === "task" && !this.#options.settings.memory.taskMemoryEnabled) {
      throw new Error("任务记忆未启用，请先在设置中开启");
    }
    const sessionId = this.#runtime?.session.sessionId;
    if (scope === "task" && !sessionId) {
      throw new Error("当前会话尚未就绪，没有任务记忆作用域");
    }
    const memory = this.#options.memoryEngine.createMemory({
      scope,
      scopeId: scope === "project"
        ? this.#options.scopeId
        : scope === "task"
          ? sessionId!
          : "user",
      content,
      source: {
        kind: "user_command",
        ...(sessionId ? { sessionId } : {}),
      },
      ...(scope === "task" ? { type: "task-state" as const } : {}),
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

    this.#recalledMemories = this.#recallMemories("");
    const result = await runtime.newSession();
    if (result.cancelled) return;
    this.#recalledMemories = this.#recallMemories(
      "",
      runtime.session.sessionId,
    );
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

  async listSessions(): Promise<SessionSummary[]> {
    const runtime = this.#runtime;
    const directory = join(this.#options.paths.sessionsRoot, this.#options.scopeId);
    const sessions = await SessionManager.list(this.#options.workspace, directory);
    return sessions
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map((session) => ({
        id: session.id,
        ...(session.name ? { name: session.name } : {}),
        createdAt: session.created.toISOString(),
        updatedAt: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        current: session.id === runtime?.session.sessionId,
      }));
  }

  getSessionHistory(): ConversationMessage[] {
    const messages = this.#runtime?.session.messages ?? [];
    return messages.reduce<ConversationMessage[]>((history, message, index) => {
      const value = asUnknownRecord(message);
      if (value.role !== "user" && value.role !== "assistant") return history;
      const content = extractMessageText(value.content);
      const reasoning = value.role === "assistant"
        ? extractMessageThinking(value.content)
        : "";
      if (!content && !reasoning) return history;
      const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
        ? new Date(value.timestamp).toISOString()
        : undefined;
      const next: ConversationMessage = {
        id: `${this.#runtime?.session.sessionId ?? "session"}-${index}`,
        role: value.role,
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(typeof value.provider === "string" ? { providerId: value.provider } : {}),
        ...(typeof value.model === "string" ? { modelId: value.model } : {}),
      };
      const previous = history.at(-1);
      if (next.role === "assistant" && previous?.role === "assistant") {
        history[history.length - 1] = {
          ...previous,
          content: [previous.content, next.content].filter(Boolean).join("\n\n"),
          ...((previous.reasoning || next.reasoning)
            ? { reasoning: [previous.reasoning, next.reasoning].filter(Boolean).join("\n\n") }
            : {}),
          ...(next.providerId ? { providerId: next.providerId } : {}),
          ...(next.modelId ? { modelId: next.modelId } : {}),
        };
        return history;
      }
      history.push(next);
      return history;
    }, []);
  }

  async switchSession(id: string): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) throw new Error("Agent 尚未就绪");
    if (runtime.session.isStreaming) throw new Error("Agent 正在运行，无法切换会话");
    const session = await this.#findSession(id);
    const result = await runtime.switchSession(session.path);
    if (result.cancelled) return;
    this.#emit({
      type: "session.ready",
      model: this.#selectedModel ? toModelSummary(this.#selectedModel) : undefined,
    });
  }

  async renameSession(id: string, name: string): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) throw new Error("Agent 尚未就绪");
    const normalized = name.trim();
    if (!normalized) throw new Error("会话名称不能为空");
    if (id === runtime.session.sessionId) {
      runtime.session.setSessionName(normalized);
      return;
    }
    const session = await this.#findSession(id);
    SessionManager.open(
      session.path,
      join(this.#options.paths.sessionsRoot, this.#options.scopeId),
      this.#options.workspace,
    ).appendSessionInfo(normalized);
  }

  async getSessionPath(id: string): Promise<string> {
    return (await this.#findSession(id)).path;
  }

  async startMcpServer(id: string): Promise<boolean> {
    if (!this.#projectFeaturesEnabled()) throw new Error("普通会话不支持 MCP");
    const config = await this.#loadRuntimeMcpConfig();
    const server = config.mcpServers[id];
    if (!server) throw new Error("未找到 MCP Server");
    await this.#gateway.unregister(id, false);
    const provider = await this.#options.mcpManager.startServer(
      id,
      server,
      this.#options.settings.mcp.startupTimeoutMs,
    );
    if (!provider) throw new Error(this.#options.mcpManager.getStatuses().find((item) => item.id === id)?.error ?? "MCP 启动失败");
    await this.#gateway.register(provider);
    const definitionsChanged = toolDefinitionSignature(this.#gateway.listTools())
      !== this.#runtimeToolSignature;
    if (!definitionsChanged) this.#syncActiveTools();
    return definitionsChanged;
  }

  async stopMcpServer(id: string): Promise<void> {
    await this.#gateway.unregister(id, false);
    await this.#options.mcpManager.stopServer(id);
    this.#syncActiveTools();
  }

  async reloadMcpServers(): Promise<boolean> {
    for (const status of this.#options.mcpManager.getStatuses()) {
      await this.#gateway.unregister(status.id, false);
    }
    const config = await this.#loadRuntimeMcpConfig();
    const providers = await this.#options.mcpManager.start(
      config,
      this.#options.settings.mcp.startupTimeoutMs,
    );
    for (const provider of providers) await this.#gateway.register(provider);
    const definitionsChanged = toolDefinitionSignature(this.#gateway.listTools())
      !== this.#runtimeToolSignature;
    if (!definitionsChanged) this.#syncActiveTools();
    return definitionsChanged;
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
      const recalled = this.#recallMemories("", sessionManager.getSessionId());
      this.#recalledMemories = recalled;
      const contextFiles = this.#projectFeaturesEnabled()
        ? await loadConfiguredContextFiles(
            cwd,
            this.#options.settings.workspace.contextFiles,
            this.#options.settings.workspace.contextIgnore,
          )
        : [];
      const modelContext = selectedModel.contextWindow ?? 128_000;
      const compactionThreshold = Math.min(
        this.#options.settings.agent.compactionThreshold,
        Math.max(1_000, modelContext - 1_000),
      );
      const settingsManager = SettingsManager.inMemory({
        compaction: {
          enabled: this.#options.settings.agent.compactionEnabled,
          reserveTokens: Math.max(1_000, modelContext - compactionThreshold),
          keepRecentTokens: Math.max(1_000, Math.min(20_000, Math.floor(compactionThreshold / 4))),
        },
        hideThinkingBlock: !this.#options.settings.agent.showThinkingSummary,
        retry: {
          enabled: this.#options.settings.models.maxRetries > 0,
          maxRetries: this.#options.settings.models.maxRetries,
          provider: {
            timeoutMs: this.#options.settings.models.timeoutMs,
            maxRetries: this.#options.settings.models.maxRetries,
          },
        },
      });
      const services = await createAgentSessionServices({
        cwd,
        agentDir: this.#options.paths.root,
        modelRuntime,
        settingsManager,
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
            agentsFiles: dedupeContextFiles([
              ...current.agentsFiles.filter((file) =>
                !matchesContextIgnore(file.path, this.#options.settings.workspace.contextIgnore)),
              ...contextFiles,
              ...(recalled.length === 0
                ? []
                : [
                  {
                    path: "deki://memory/project.md",
                    content: renderMemoryContext(recalled),
                  },
                ]),
            ]),
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
      this.#runtimeToolSignature = toolDefinitionSignature(tools);
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

    const sessionDirectory = join(
      this.#options.paths.sessionsRoot,
      this.#options.scopeId,
    );
    const restoreRecent = this.#options.resumeLatest === true
      || (
        this.#options.settings.general.restoreSession
        && this.#options.settings.general.startupMode === "last-session"
      );
    this.#runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.#options.workspace,
      agentDir: this.#options.paths.root,
      sessionManager: restoreRecent
        ? SessionManager.continueRecent(this.#options.workspace, sessionDirectory)
        : SessionManager.create(this.#options.workspace, sessionDirectory),
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
        const permissionControlled = tool.providerId !== "workspace" && tool.providerId !== "deki";
        if (permissionControlled) {
          const readOnly = tool.readOnlyHint === true;
          const policy = this.#options.settings.mcp.toolPolicies[tool.internalName]
            ?? tool.permission;
          await this.#permissions?.authorize({
            callId: toolCallId,
            category: readOnly ? "mcp.read" : "mcp.write",
            title: `MCP ${tool.internalName}`,
            description: readOnly
              ? "MCP Server 明确标注此 Tool 为只读"
              : "MCP Server 未提供只读保证，此 Tool 按可能有副作用处理",
            details: {
              provider: tool.providerId,
              tool: tool.providerToolName,
              input: params,
              networkTargets: collectNetworkTargets(params),
            },
            ...(policy ? { policy } : {}),
            grantKey: tool.internalName,
          });
        }
        try {
          const result = await this.#gateway.call(
            tool.modelName,
            params,
            context,
            tool.timeoutMs ?? this.#options.settings.mcp.callTimeoutMs,
          );
          if (permissionControlled) {
            await this.#permissions?.recordExecution(toolCallId, "succeeded", {
              isError: result.isError === true,
              contentItems: result.content.length,
            });
          }
          return {
            content: result.content,
            details: result.details ?? {},
          };
        } catch (error) {
          if (permissionControlled) {
            await this.#permissions?.recordExecution(toolCallId, "failed", error);
          }
          throw error;
        }
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
      void this.#createAutomaticMemoryCandidates();
    }
    const translated = translatePiAgentEvent(event);
    if (translated) {
      this.#emit(translated);
    }
  }

  async #injectRelevantMemories(query: string): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    const memories = this.#recallMemories(query, runtime.session.sessionId);
    this.#recalledMemories = memories;
    if (memories.length === 0) return;
    await runtime.session.sendCustomMessage({
      customType: "deki.memory.recall",
      content: renderMemoryContext(memories),
      display: false,
      details: {
        query,
        memoryIds: memories.map((memory) => memory.id),
      },
    }, { triggerTurn: false });
    this.#emit({ type: "memory.used", memories });
  }

  #recallMemories(query: string, sessionId?: string): MemoryRecord[] {
    const persistent = this.#projectFeaturesEnabled()
      ? this.#options.settings.memory.projectMemoryEnabled
        && this.#options.settings.workspace.loadProjectMemory
        ? this.#options.memoryEngine.recallMemories(
            "project",
            this.#options.scopeId,
            query,
            {
              limit: this.#options.settings.memory.projectRecallLimit,
              characterBudget: this.#options.settings.memory.projectCharacterBudget,
            },
          )
        : []
      : this.#options.settings.memory.userMemoryEnabled
        ? this.#options.memoryEngine.recallMemories(
            "user",
            "user",
            query,
            {
              limit: this.#options.settings.memory.userRecallLimit,
              characterBudget: this.#options.settings.memory.userCharacterBudget,
            },
          )
        : [];
    const task = sessionId && this.#options.settings.memory.taskMemoryEnabled
      ? this.#options.memoryEngine.recallMemories(
          "task",
          sessionId,
          query,
          {
            limit: this.#options.settings.memory.taskRecallLimit,
            characterBudget: this.#options.settings.memory.taskCharacterBudget,
          },
        )
      : [];
    return dedupeMemories([...task, ...persistent]);
  }

  async #createAutomaticMemoryCandidates(): Promise<void> {
    const prompt = this.#lastPrompt;
    this.#lastPrompt = undefined;
    if (!prompt || !this.#options.settings.memory.automaticCandidates) return;
    const project = this.#projectFeaturesEnabled();
    if (!project && !this.#options.settings.memory.userMemoryEnabled) return;
    const modelRuntime = this.#modelRuntime;
    const model = this.#selectedModel;
    if (!modelRuntime || !model) return;
    try {
      const recentAssistant = [...(this.#runtime?.session.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant");
      const response = await modelRuntime.completeSimple(model, {
        systemPrompt: [
          "你是长期记忆提取器。",
          "只提取以后仍有帮助、用户未必会再次说明的稳定事实、偏好、决定或经验。",
          "不要保存密钥、令牌、密码、源码内容、临时任务状态或可从项目文件重新获取的信息。",
          "输出严格 JSON 数组，最多 3 项；每项格式为 {\"content\":\"...\",\"type\":\"preference|fact|decision|experience\"}。",
          "没有值得保存的内容时输出 []。",
        ].join("\n"),
        messages: [{
          role: "user",
          timestamp: Date.now(),
          content: [
            `用户任务：${prompt.slice(0, 4_000)}`,
            `任务结果：${extractMessageText(asUnknownRecord(recentAssistant).content).slice(0, 4_000)}`,
          ].join("\n\n"),
        }],
      }, {
        maxTokens: Math.min(1_200, this.#options.settings.models.maxOutputTokens),
        timeoutMs: this.#options.settings.models.timeoutMs,
        maxRetries: this.#options.settings.models.maxRetries,
      });
      const parsed = parseMemoryCandidates(extractMessageText(response.content));
      for (const candidate of parsed.slice(0, 3)) {
        const memory = this.#options.memoryEngine.createMemory({
          scope: project ? "project" : "user",
          scopeId: project ? this.#options.scopeId : "user",
          content: candidate.content,
          source: {
            kind: "agent_candidate",
            ...(this.#runtime?.session.sessionId
              ? { sessionId: this.#runtime.session.sessionId }
              : {}),
            detail: `由 ${model.provider}/${model.id} 在成功任务结束后生成，等待用户确认`,
          },
          type: candidate.type,
          status: "pending",
        });
        this.#emit({ type: "memory.saved", memory });
      }
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

  async #loadRuntimeMcpConfig() {
    const config = await loadMcpConfig(this.#options.workspace);
    return {
      mcpServers: Object.fromEntries(Object.entries(config.mcpServers).map(([id, server]) => [
        id,
        {
          ...server,
          ...(this.#options.mcpEnvironment?.[id]
            ? { environment: this.#options.mcpEnvironment[id] }
            : {}),
        },
      ])),
    };
  }

  #syncActiveTools(): void {
    this.#runtime?.session.setActiveToolsByName(
      this.#gateway.listTools().map((tool) => tool.modelName),
    );
  }

  async #findSession(id: string) {
    const directory = join(this.#options.paths.sessionsRoot, this.#options.scopeId);
    const sessions = await SessionManager.list(this.#options.workspace, directory);
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error("未找到会话");
    return session;
  }
}

export function translatePiAgentEvent(
  event: AgentSessionEvent,
): AgentEventInput | undefined {
  switch (event.type) {
    case "message_update": {
      if (event.assistantMessageEvent.type === "text_delta") {
        return {
            type: "message.delta",
            delta: event.assistantMessageEvent.delta,
            providerId: event.assistantMessageEvent.partial.provider,
            modelId: event.assistantMessageEvent.partial.model,
          };
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        return {
          type: "message.reasoning.delta",
          delta: event.assistantMessageEvent.delta,
          providerId: event.assistantMessageEvent.partial.provider,
          modelId: event.assistantMessageEvent.partial.model,
        };
      }
      return undefined;
    }
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

export function toolDefinitionSignature(
  tools: ReadonlyArray<Pick<GatewayTool, "modelName" | "description" | "inputSchema">>,
): string {
  return JSON.stringify(
    tools
      .map((tool) => ({
        name: tool.modelName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
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
    (memory) =>
      `- [${memory.scope}:${memory.id}] ${memory.content}（来源：${memory.source.kind}）`,
  );
  return [
    "# Deki 相关长期记忆",
    "",
    "以下内容由用户明确保存，仅在与当前任务相关时使用：",
    "",
    ...lines,
  ].join("\n");
}

function dedupeMemories(memories: readonly MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    if (seen.has(memory.id)) return false;
    seen.add(memory.id);
    return true;
  });
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

function createSessionTitle(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? prompt;
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    const record = asUnknownRecord(item);
    return record.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  }).join("");
}

function extractMessageThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    const record = asUnknownRecord(item);
    return record.type === "thinking" && typeof record.thinking === "string"
      ? [record.thinking]
      : [];
  }).join("");
}

function parseMemoryCandidates(value: string): Array<{
  content: string;
  type: "preference" | "fact" | "decision" | "experience";
}> {
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  const parsed: unknown = JSON.parse(value.slice(start, end + 1));
  if (!Array.isArray(parsed)) return [];
  const allowed = new Set(["preference", "fact", "decision", "experience"]);
  return parsed.flatMap((item) => {
    const record = asUnknownRecord(item);
    if (
      typeof record.content !== "string"
      || !record.content.trim()
      || typeof record.type !== "string"
      || !allowed.has(record.type)
    ) return [];
    return [{
      content: record.content.trim().slice(0, 2_000),
      type: record.type as "preference" | "fact" | "decision" | "experience",
    }];
  });
}

async function loadConfiguredContextFiles(
  workspace: string,
  configuredFiles: string[],
  ignore: string[],
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const configured of configuredFiles) {
    const normalized = configured.replaceAll("\\", "/").replaceAll(/^\.\//g, "");
    if (!normalized || normalized.startsWith("../") || normalized.startsWith("/")) continue;
    if (matchesContextIgnore(normalized, ignore)) continue;
    try {
      files.push({
        path: join(workspace, normalized),
        content: await readFile(join(workspace, normalized), "utf8"),
      });
    } catch {
      // Optional project context files are skipped when absent or unreadable.
    }
  }
  return files;
}

function matchesContextIgnore(path: string, ignore: string[]): boolean {
  const normalized = path.replaceAll("\\", "/");
  return ignore.some((pattern) => {
    const candidate = pattern.replaceAll("\\", "/").replaceAll(/^\.\//g, "").replaceAll(/\*+/g, "");
    return Boolean(candidate)
      && (normalized === candidate
        || normalized.startsWith(`${candidate}/`)
        || normalized.split("/").includes(candidate));
  });
}

function dedupeContextFiles<T extends { path: string }>(files: T[]): T[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.path.replaceAll("\\", "/");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectNetworkTargets(value: unknown): string[] {
  const targets = new Set<string>();
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      for (const match of current.match(/https?:\/\/[^\s"'<>]+/giu) ?? []) targets.add(match);
    } else if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else if (typeof current === "object" && current !== null) {
      for (const child of Object.values(current)) visit(child);
    }
  };
  visit(value);
  return [...targets].slice(0, 20);
}
