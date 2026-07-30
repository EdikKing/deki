import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  InMemoryCredentialStore,
  type ImageContent,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
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
  agentEventSchema,
  DEKI_VERSION,
  permissionPoliciesSchema,
  resolveSystemLocale,
  type AgentEvent,
  type CapabilityProvider,
  type ConversationMessage,
  type MemoryRecord,
  type MemoryScope,
  type ModelSummary,
  type PermissionPolicies,
  type PromptAttachment,
  type PlanStep,
  type SessionSummary,
  type SessionHistoryState,
  type ThinkingLevel,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
  type UpdateSessionConfigurationInput,
  type WorkerProfileId,
  type WorkerRequest,
  type WorkerResult,
  type WorkerResultEnvelope,
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
  acquireResumeLease?: (
    taskId: string,
    requestId: string,
  ) => Promise<{ commit(): void; release(): void } | null>;
  planTools?: {
    submit(input: {
      goal: string;
      assumptions: string[];
      constraints: string[];
      steps: PlanStep[];
    }, context: ToolCallContext): Promise<unknown>;
    revise(input: {
      planId: string;
      basedOnRevision: number;
      feedback?: string;
      assumptions: string[];
      constraints: string[];
      steps: PlanStep[];
    }, context: ToolCallContext): Promise<unknown>;
    updateStep(input: {
      planId: string;
      revision: number;
      stepId: string;
      status: "running" | "completed" | "blocked";
      summary?: string;
      evidence?: string[];
      reason?: string;
    }, context: ToolCallContext): Promise<unknown>;
    requestReplan(input: {
      planId: string;
      reason: string;
      affectedStepIds: string[];
      evidence?: string[];
    }, context: ToolCallContext): Promise<unknown>;
  };
  workerTools?: {
    delegate(
      requests: WorkerRequest[],
      context: ToolCallContext,
    ): Promise<WorkerResultEnvelope[]>;
    submitResult(
      result: WorkerResult,
      context: ToolCallContext,
    ): Promise<WorkerResult>;
    runTest(
      target: string,
      context: ToolCallContext,
    ): Promise<unknown>;
  };
  resumeLatest?: boolean;
}

export interface RuntimeSnapshot {
  ready: boolean;
  streaming: boolean;
  sessionId?: string;
  models: ModelSummary[];
  selectedModel?: ModelSummary;
  sessionConfiguration?: {
    permissionPolicies: PermissionPolicies;
    thinkingLevel: ThinkingLevel;
    interactionMode: "act" | "plan";
  };
  recalledMemories: MemoryRecord[];
  skills: string[];
  diagnostics: string[];
  modelUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    contextTokens: number | null;
    contextWindow: number;
    remainingTokens: number | null;
    percent: number | null;
  };
}

export interface AgentPromptContext {
  sourceSessionId: string;
  sourceSessionFile?: string;
  sourceEntryId?: string;
  preferFork: boolean;
  interactionMode?: "act" | "plan" | "plan-execution" | "worker";
  planId?: string;
  planRevision?: number;
  workerProfile?: WorkerProfileId;
  workerContext?: import("@deki-ai/shared").WorkerContextPackage;
  requestedModel?: string;
  outputTokenScale?: 1 | 0.75 | 0.5;
  lowerThinking?: boolean;
}

export interface AgentPromptRunHandle {
  taskId: string;
  runId: string;
  sessionId: string;
  modelProvider?: string;
  modelId?: string;
  completion: Promise<void>;
  cancel(): Promise<void>;
  captureContext(): AgentPromptContext & { type: "agent-prompt" };
  captureUsage(): {
    inputTokens: number;
    outputTokens: number;
    toolCallCount: number;
  };
}

type ModelType = Model<any>;
type AgentEventInput<T extends AgentEvent = AgentEvent> =
  T extends AgentEvent
    ? Omit<T, "eventId" | "timestamp" | "sessionId" | "taskId" | "runId">
    : never;

interface AgentExecutionContext {
  sessionId: string;
  taskId: string;
  runId: string;
  interactionMode: "act" | "plan" | "plan-execution" | "worker";
  planId?: string;
  planRevision?: number;
  workerProfile?: WorkerProfileId;
}

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
  readonly #sessionModels = new Map<string, ModelType>();
  readonly #sessionPermissionPolicies = new Map<string, PermissionPolicies>();
  readonly #sessionInteractionModes = new Map<string, "act" | "plan">();
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
  #branchScopeId = "detached";
  #createRuntimeFactory: CreateAgentSessionRuntimeFactory | undefined;
  readonly #backgroundRuntimes = new Set<AgentSessionRuntime>();
  readonly #backgroundUnsubscribers = new Map<AgentSessionRuntime, () => void>();
  readonly #runContextsBySession = new Map<string, AgentExecutionContext>();
  readonly #runCancellers = new Map<string, () => Promise<void>>();
  readonly #userInputRequests = new Map<string, {
    execution: AgentExecutionContext;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }>();
  readonly #executionContext = new AsyncLocalStorage<AgentExecutionContext>();

  constructor(options: DekiAgentRuntimeOptions) {
    this.#options = options;
    this.#gateway = new ToolGateway({
      outputLimitBytes: options.settings.advanced.toolOutputLimitBytes,
      maxConcurrentCalls: options.settings.agent.maxConcurrentRuns,
    });
  }

  async initialize(): Promise<void> {
    this.#branchScopeId = await resolveBranchScopeId(
      this.#options.workspace,
      this.#options.scopeId,
    );
    this.#options.mcpManager.configureResilience({
      healthCheckIntervalMs: this.#options.settings.mcp.healthCheckIntervalMs,
      autoRestart: this.#options.settings.mcp.autoRestart,
      maxReconnectAttempts: this.#options.settings.mcp.maxReconnectAttempts,
      startupTimeoutMs: this.#options.settings.mcp.startupTimeoutMs,
    });
    if (this.#projectFeaturesEnabled()) {
      this.#permissions = new PermissionEngine({
        workspace: this.#options.workspace,
        logsRoot: this.#options.paths.logsRoot,
        settings: this.#options.settings,
        sessionId: () =>
          this.#executionContext.getStore()?.sessionId
          ?? this.#runtime?.session.sessionId,
        model: () => {
          const sessionId = this.#executionContext.getStore()?.sessionId
            ?? this.#runtime?.session.sessionId;
          const model = sessionId
            ? this.#sessionModels.get(sessionId) ?? this.#selectedModel
            : this.#selectedModel;
          return model
            ? `${model.provider}/${model.id}`
            : undefined;
        },
        resolvePolicies: () => this.#permissionPoliciesForSession(
          this.#executionContext.getStore()?.sessionId
            ?? this.#runtime?.session.sessionId,
        ),
        emit: (event) => {
          const execution = event.sessionId
            ? this.#runContextsBySession.get(event.sessionId)
            : this.#executionContext.getStore();
          this.#forwardEvent(execution
            ? {
                ...event,
                taskId: execution.taskId,
                runId: execution.runId,
              }
            : event);
        },
        taskId: () => this.#executionContext.getStore()?.taskId,
        runId: () => this.#executionContext.getStore()?.runId,
        ...(this.#options.acquireResumeLease
          ? { acquireResumeLease: this.#options.acquireResumeLease }
          : {}),
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
              tokenBudget: this.#options.settings.memory.projectTokenBudget,
            },
          )
        : [];

      await this.#gateway.register(new ProjectInfoProvider(this.#options.workspace));
      if (this.#options.planTools) {
        await this.#gateway.register(new PlanToolsProvider(this.#options.planTools));
      }
      if (this.#options.workerTools) {
        await this.#gateway.register(new WorkerToolsProvider(this.#options.workerTools));
        await this.#gateway.register(new TestToolsProvider(this.#options.workerTools));
      }

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
            tokenBudget: this.#options.settings.memory.userTokenBudget,
          },
        );
      }
    }
    await this.#gateway.register(new TaskInteractionProvider(
      (input, context) => this.#requestUserInput(input, context),
    ));

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
    const stats = this.#runtime?.session.getSessionStats();
    const context = stats?.contextUsage;
    const contextWindow = context?.contextWindow
      ?? this.#selectedModel?.contextWindow
      ?? 128_000;
    const streaming = this.#streaming
      || [...this.#backgroundRuntimes].some((runtime) => runtime.session.isStreaming);
    return {
      ready: this.#runtime !== undefined,
      streaming,
      ...(sessionId ? { sessionId } : {}),
      models: this.#models.map(toModelSummary),
      ...(this.#selectedModel
        ? { selectedModel: toModelSummary(this.#selectedModel) }
        : {}),
      ...(this.#runtime
        ? {
            sessionConfiguration: {
              permissionPolicies: this.#permissionPoliciesForSession(sessionId),
              thinkingLevel: this.#runtime.session.thinkingLevel as ThinkingLevel,
              interactionMode: this.#interactionModeForSession(sessionId),
            },
          }
        : {}),
      recalledMemories: [...this.#recalledMemories],
      skills: [...this.#skills],
      diagnostics: [...this.#diagnostics],
      ...(stats
        ? {
            modelUsage: {
              inputTokens: stats.tokens.input,
              outputTokens: stats.tokens.output,
              cacheReadTokens: stats.tokens.cacheRead,
              cacheWriteTokens: stats.tokens.cacheWrite,
              contextTokens: context?.tokens ?? null,
              contextWindow,
              remainingTokens: context?.tokens === null || context?.tokens === undefined
                ? null
                : Math.max(0, contextWindow - context.tokens),
              percent: context?.percent ?? null,
            },
          }
        : {}),
    };
  }

  async prompt(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (trimmed.startsWith("/")) {
      await this.#executeCommand(trimmed);
      return;
    }
    const handle = await this.startPrompt({
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      prompt: trimmed,
      context: this.capturePromptContext(false),
    });
    await handle.completion;
  }

  async optimizePrompt(prompt: string): Promise<string> {
    const modelRuntime = this.#modelRuntime;
    const model = this.#selectedModel;
    if (!modelRuntime || !model) {
      throw new Error("Agent 尚未就绪，请先配置云模型环境变量");
    }
    const input = prompt.trim();
    const projectConnected = this.#projectFeaturesEnabled();
    const request = async (content: string) => {
      const response = await modelRuntime.completeSimple(model, {
        systemPrompt: renderPromptOptimizerSystemPrompt(projectConnected),
        messages: [{
          role: "user",
          timestamp: Date.now(),
          content,
        }],
      }, {
        maxTokens: Math.min(2_400, this.#options.settings.models.maxOutputTokens),
        timeoutMs: this.#options.settings.models.timeoutMs,
        maxRetries: this.#options.settings.models.maxRetries,
      });
      return unwrapPromptOptimization(extractMessageText(response.content));
    };
    let optimized = await request(input);
    if (projectConnected && isClarificationHeavyPrompt(optimized)) {
      optimized = await request([
        "请重新改写下面的原始输入。",
        "上一次结果错误地要求用户补充项目类型、技术栈、代码路径等信息；这些都应由目标 Agent 直接检查当前工作区获得。",
        "不要回复用户，也不要列出需要用户补充的项目资料。请输出一份能立即执行的项目调查任务说明。",
        "",
        `原始输入：${input}`,
      ].join("\n"));
    }
    if (projectConnected && isClarificationHeavyPrompt(optimized)) {
      optimized = renderProjectInvestigationFallback(input);
    }
    if (!optimized) throw new Error("模型没有返回可用的优化结果");
    return optimized;
  }

  capturePromptContext(preferFork: boolean): AgentPromptContext {
    const session = this.#runtime?.session;
    if (!session) {
      throw new Error("Agent 尚未就绪，请先配置云模型环境变量");
    }
    let sourceSessionFile = session.sessionFile;
    const sourceEntryId = session.sessionManager.getLeafId() ?? undefined;
    if (preferFork && (!sourceSessionFile || !existsSync(sourceSessionFile))) {
      const header = session.sessionManager.getHeader();
      if (!header) throw new Error("当前会话缺少持久化头信息");
      const checkpointDirectory = join(
        this.#options.paths.sessionsRoot,
        this.#options.scopeId,
        "checkpoints",
      );
      mkdirSync(checkpointDirectory, { recursive: true });
      sourceSessionFile = join(
        checkpointDirectory,
        `${session.sessionId}-${Date.now()}-${crypto.randomUUID()}.jsonl`,
      );
      writeFileSync(
        sourceSessionFile,
        `${[header, ...session.sessionManager.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
        { flag: "wx" },
      );
    }
    return {
      sourceSessionId: session.sessionId,
      ...(sourceSessionFile ? { sourceSessionFile } : {}),
      ...(sourceEntryId ? { sourceEntryId } : {}),
      preferFork,
    };
  }

  async validatePromptContext(context: AgentPromptContext): Promise<void> {
    if (!context.sourceSessionFile) {
      throw new Error("计划上下文尚未持久化，无法创建安全分支");
    }
    if (!context.sourceEntryId) {
      throw new Error("计划上下文缺少精确的会话位置，无法创建安全分支");
    }
    try {
      await access(context.sourceSessionFile);
    } catch {
      throw new Error("计划上下文对应的会话文件已不存在");
    }
    const manager = SessionManager.open(
      context.sourceSessionFile,
      join(this.#options.paths.sessionsRoot, this.#options.scopeId),
      this.#options.workspace,
    );
    if (!manager.getEntry(context.sourceEntryId)) {
      throw new Error("计划上下文对应的会话位置已不存在");
    }
  }

  async captureSessionPromptContext(
    sessionId: string,
    preferFork: boolean,
  ): Promise<AgentPromptContext> {
    if (this.#runtime?.session.sessionId === sessionId) {
      return this.capturePromptContext(preferFork);
    }
    const session = await this.#findSession(sessionId);
    const manager = SessionManager.open(
      session.path,
      join(this.#options.paths.sessionsRoot, this.#options.scopeId),
      this.#options.workspace,
    );
    const sourceEntryId = manager.getLeafId() ?? undefined;
    return {
      sourceSessionId: sessionId,
      sourceSessionFile: session.path,
      ...(sourceEntryId ? { sourceEntryId } : {}),
      preferFork,
    };
  }

  async startPrompt(input: {
    taskId: string;
    runId: string;
    prompt: string;
    attachments?: PromptAttachment[];
    context: AgentPromptContext;
  }): Promise<AgentPromptRunHandle> {
    const trimmed = input.prompt.trim();
    if (!trimmed || trimmed.startsWith("/")) {
      throw new Error("Task Prompt 必须是非命令文本");
    }
    const runtime = this.#runtime;
    if (!runtime) {
      throw new Error("Agent 尚未就绪，请先配置云模型环境变量");
    }
    if (
      input.context.preferFork
      || runtime.session.isStreaming
      || runtime.session.sessionId !== input.context.sourceSessionId
    ) {
      return this.#startConcurrentPrompt(input);
    }
    if (
      this.#options.settings.agent.autoNameSessions
      && !runtime.session.sessionName
    ) {
      runtime.session.setSessionName(createSessionTitle(trimmed));
    }
    await this.#injectRelevantMemories(trimmed);

    const execution: AgentExecutionContext = {
      sessionId: runtime.session.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      interactionMode: input.context.interactionMode ?? "act",
      ...(input.context.planId ? { planId: input.context.planId } : {}),
      ...(input.context.planRevision
        ? { planRevision: input.context.planRevision }
        : {}),
    };
    this.#runContextsBySession.set(execution.sessionId, execution);
    this.#lastPrompt = trimmed;
    this.#appendRunState("running");
    this.#streaming = true;
    this.#emitForSession(runtime.session, { type: "run.started" }, execution);
    const completion = this.#executionContext.run(execution, async () => {
      try {
        const prepared = await preparePromptAttachments(trimmed, input.attachments ?? []);
        await runtime.session.prompt(prepared.prompt, { images: prepared.images });
      } catch (error) {
        this.#appendRunState("failed", formatError(error));
        this.#emitForSession(runtime.session, {
          type: "run.failed",
          error: formatError(error),
        }, execution);
        throw error;
      } finally {
        this.#streaming = false;
        this.#runContextsBySession.delete(execution.sessionId);
        this.#runCancellers.delete(input.taskId);
      }
    });
    const cancel = async () => {
      if (runtime.session.isStreaming) await runtime.session.abort();
    };
    this.#runCancellers.set(input.taskId, cancel);
    return {
      taskId: input.taskId,
      runId: input.runId,
      sessionId: execution.sessionId,
      ...(runtime.session.model?.provider
        ? { modelProvider: runtime.session.model.provider }
        : {}),
      ...(runtime.session.model?.id ? { modelId: runtime.session.model.id } : {}),
      completion,
      cancel,
      captureContext: () => ({
        type: "agent-prompt",
        sourceSessionId: runtime.session.sessionId,
        ...(runtime.session.sessionFile
          ? { sourceSessionFile: runtime.session.sessionFile }
          : {}),
        ...(runtime.session.sessionManager.getLeafId()
          ? { sourceEntryId: runtime.session.sessionManager.getLeafId()! }
          : {}),
        preferFork: true,
        interactionMode: input.context.interactionMode ?? "act",
        ...(input.context.planId ? { planId: input.context.planId } : {}),
        ...(input.context.planRevision
          ? { planRevision: input.context.planRevision }
          : {}),
        ...(input.context.requestedModel
          ? { requestedModel: input.context.requestedModel }
          : {}),
        ...(input.context.outputTokenScale
          ? { outputTokenScale: input.context.outputTokenScale }
          : {}),
        ...(input.context.lowerThinking === undefined
          ? {}
          : { lowerThinking: input.context.lowerThinking }),
      }),
      captureUsage: () => {
        const stats = runtime.session.getSessionStats();
        return {
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          toolCallCount: 0,
        };
      },
    };
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
    if (scope === "workspace" && !this.#projectFeaturesEnabled()) {
      throw new Error("普通会话没有工作区记忆作用域");
    }
    if (scope === "workspace" && !this.#options.settings.memory.workspaceMemoryEnabled) {
      throw new Error("工作区记忆未启用，请先在设置中开启");
    }
    if (scope === "branch" && !this.#projectFeaturesEnabled()) {
      throw new Error("普通会话没有分支记忆作用域");
    }
    if (scope === "branch" && !this.#options.settings.memory.branchMemoryEnabled) {
      throw new Error("分支记忆未启用，请先在设置中开启");
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
        : scope === "workspace"
          ? this.#options.scopeId
          : scope === "branch"
            ? this.#branchScopeId
        : scope === "task"
          ? sessionId!
          : "user",
      content,
      source: {
        kind: "user_command",
        ...(sessionId ? { sessionId } : {}),
      },
      ...((scope === "task" || scope === "branch")
        ? { type: "task-state" as const }
        : {}),
    });
    this.#emit({ type: "memory.saved", memory });
    return memory;
  }

  memoryScopeId(scope: MemoryScope): string {
    if (scope === "user") return "user";
    if (scope === "project" || scope === "workspace") return this.#options.scopeId;
    if (scope === "branch") return this.#branchScopeId;
    const sessionId = this.#runtime?.session.sessionId;
    if (!sessionId) throw new Error("当前会话尚未就绪，没有任务记忆作用域");
    return sessionId;
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
    this.#registerSessionConfiguration(runtime.session);
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

  async listSessions(query = ""): Promise<SessionSummary[]> {
    const runtime = this.#runtime;
    const directory = join(this.#options.paths.sessionsRoot, this.#options.scopeId);
    const sessions = await SessionManager.list(this.#options.workspace, directory);
    const normalized = query.trim().toLocaleLowerCase();
    const idsByPath = new Map(sessions.map((session) => [session.path, session.id]));
    const runningSessionIds = new Set([
      ...(runtime?.session.isStreaming ? [runtime.session.sessionId] : []),
      ...[...this.#backgroundRuntimes]
        .filter((candidate) => candidate.session.isStreaming)
        .map((candidate) => candidate.session.sessionId),
    ]);
    return sessions
      .filter((session) => !normalized
        || session.name?.toLocaleLowerCase().includes(normalized)
        || session.firstMessage.toLocaleLowerCase().includes(normalized)
        || session.allMessagesText.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .flatMap((session): SessionSummary[] => {
        let manager: SessionManager | undefined;
        try {
          manager = SessionManager.open(session.path, directory, this.#options.workspace);
        } catch {
          // Keep damaged user sessions discoverable so they can still be inspected or removed.
        }
        if (manager && !isSessionVisibleInSidebar(manager)) return [];
        const historicalRunState = manager ? readRunState(manager) : "failed";
        return [{
          id: session.id,
          ...(session.name ? { name: session.name } : {}),
          createdAt: session.created.toISOString(),
          updatedAt: session.modified.toISOString(),
          messageCount: session.messageCount,
          firstMessage: session.firstMessage,
          current: session.id === runtime?.session.sessionId,
          ...(session.parentSessionPath
            ? { parentSessionId: idsByPath.get(session.parentSessionPath) }
            : {}),
          runState: runningSessionIds.has(session.id)
            ? "running" as const
            : historicalRunState,
        }];
      });
  }

  getSessionHistory(): ConversationMessage[] {
    const manager = this.#runtime?.session.sessionManager;
    return manager
      ? readConversationHistory(manager, this.#runtime?.session.sessionId ?? "session")
      : [];
  }

  getSessionHistoryState(): SessionHistoryState {
    const manager = this.#runtime?.session.sessionManager;
    return manager
      ? readSessionHistoryState(
          manager,
          this.#runtime?.session.sessionId ?? "session",
          Boolean(this.#runtime?.session.isStreaming),
        )
      : { messages: [], events: [], runState: "idle" };
  }

  getTaskSessionHistoryState(sessionFile: string, taskId: string): SessionHistoryState {
    const scopeDirectory = join(
      this.#options.paths.sessionsRoot,
      this.#options.scopeId,
    );
    const workerDirectory = join(scopeDirectory, "workers");
    const normalizedScopeDirectory = resolve(scopeDirectory);
    const normalizedWorkerDirectory = resolve(workerDirectory);
    const normalizedFile = resolve(sessionFile);
    if (!normalizedFile.startsWith(`${normalizedScopeDirectory}${sep}`)) {
      throw new Error("只能读取当前项目的内部 Plan 节点会话");
    }
    const manager = SessionManager.open(
      normalizedFile,
      scopeDirectory,
      this.#options.workspace,
    );
    const workerSession = normalizedFile.startsWith(`${normalizedWorkerDirectory}${sep}`);
    const taskOnlySession = manager.getBranch().some((entry) => (
      entry.type === "custom"
      && entry.customType === "deki.session-visibility"
      && isRecord(entry.data)
      && entry.data.visibility === "task-only"
      && entry.data.taskId === taskId
    ));
    if (!workerSession && !taskOnlySession) {
      throw new Error("只能读取当前项目的内部 Plan 节点会话");
    }
    return readSessionHistoryState(manager, manager.getSessionId(), false);
  }

  async forkSession(entryId: string): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) throw new Error("Agent 尚未就绪");
    if (runtime.session.isStreaming) throw new Error("Agent 正在运行，无法分叉会话");
    if (!runtime.session.sessionManager.getEntry(entryId)) {
      throw new Error("未找到分叉位置");
    }
    const inheritedModel = this.#selectedModel;
    const inheritedThinkingLevel = runtime.session.thinkingLevel as ThinkingLevel;
    const inheritedPermissionPolicies = this.#permissionPoliciesForSession(
      runtime.session.sessionId,
    );
    const inheritedInteractionMode = this.#interactionModeForSession(
      runtime.session.sessionId,
    );
    const result = await runtime.fork(entryId, { position: "at" });
    if (result.cancelled) return;
    if (inheritedModel) await runtime.session.setModel(inheritedModel);
    runtime.session.setThinkingLevel(inheritedThinkingLevel);
    this.#persistSessionPermissionPolicies(
      runtime.session,
      inheritedPermissionPolicies,
    );
    runtime.session.sessionManager.appendCustomEntry("deki.interaction-mode", {
      version: 1,
      mode: inheritedInteractionMode,
    });
    this.#sessionInteractionModes.set(runtime.session.sessionId, inheritedInteractionMode);
    this.#registerSessionConfiguration(runtime.session);
    runtime.session.sessionManager.appendCustomEntry("deki.session-visibility", {
      version: 1,
      visibility: "sidebar",
      reason: "user-fork",
    });
    runtime.session.setSessionName(
      `${runtime.session.sessionName ?? "会话"} · 分叉`,
    );
    this.#emit({
      type: "session.ready",
      model: this.#selectedModel ? toModelSummary(this.#selectedModel) : undefined,
    });
  }

  async switchSession(id: string): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) throw new Error("Agent 尚未就绪");
    if (runtime.session.isStreaming) throw new Error("Agent 正在运行，无法切换会话");
    if (this.isSessionRunning(id)) throw new Error("目标会话仍在后台运行，暂时不能切换");
    const session = await this.#findSession(id);
    const result = await runtime.switchSession(session.path);
    if (result.cancelled) return;
    this.#registerSessionConfiguration(runtime.session);
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

  isSessionRunning(id: string): boolean {
    return (this.#runtime?.session.sessionId === id && this.#runtime.session.isStreaming)
      || [...this.#backgroundRuntimes].some(
        (runtime) => runtime.session.sessionId === id && runtime.session.isStreaming,
      );
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
      this.#sessionModels.set(this.#runtime.session.sessionId, model);
    } else {
      await this.#createRuntime();
    }
  }

  async updateSessionConfiguration(
    input: UpdateSessionConfigurationInput,
  ): Promise<void> {
    const session = this.#runtime?.session;
    if (!session) throw new Error("当前会话尚未就绪");
    if (session.isStreaming) throw new Error("Agent 正在运行，无法修改会话配置");
    if (input.permissionPolicies) {
      if (!this.#projectFeaturesEnabled()) {
        throw new Error("普通会话不会访问本地项目，无需设置权限");
      }
      this.#persistSessionPermissionPolicies(session, input.permissionPolicies);
    }
    if (input.thinkingLevel) {
      session.setThinkingLevel(input.thinkingLevel);
    }
    if (input.interactionMode) {
      session.sessionManager.appendCustomEntry("deki.interaction-mode", {
        version: 1,
        mode: input.interactionMode,
      });
      this.#sessionInteractionModes.set(session.sessionId, input.interactionMode);
    }
  }

  async abort(): Promise<void> {
    await Promise.allSettled([
      ...(this.#runtime?.session.isStreaming ? [this.#runtime.session.abort()] : []),
      ...[...this.#backgroundRuntimes]
        .filter((runtime) => runtime.session.isStreaming)
        .map((runtime) => runtime.session.abort()),
    ]);
    this.#streaming = false;
  }

  async cancelTask(taskId: string): Promise<void> {
    const cancel = this.#runCancellers.get(taskId);
    if (!cancel) throw new Error("未找到正在运行的任务");
    await cancel();
  }

  async respondToApproval(
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    return await this.#permissions?.respond(requestId, decision) ?? false;
  }

  async respondToTaskInput(requestId: string, value: string): Promise<boolean> {
    const pending = this.#userInputRequests.get(requestId);
    if (!pending) return false;
    const lease = this.#options.acquireResumeLease
      ? await this.#options.acquireResumeLease(pending.execution.taskId, requestId)
      : undefined;
    if (this.#options.acquireResumeLease && !lease) return false;
    if (this.#userInputRequests.get(requestId) !== pending) {
      lease?.release();
      return false;
    }
    this.#userInputRequests.delete(requestId);
    lease?.commit();
    this.#executionContext.run(pending.execution, () => {
      this.#emit({
        type: "user_input.resolved",
        requestId,
        value,
      });
    });
    pending.resolve(value);
    return true;
  }

  async dispose(): Promise<void> {
    this.#sessionEvents.dispose();
    this.#permissions?.dispose();
    this.#permissions = undefined;
    if (this.#runtime) {
      await this.#runtime.dispose();
      this.#runtime = undefined;
    }
    for (const unsubscribe of this.#backgroundUnsubscribers.values()) unsubscribe();
    this.#backgroundUnsubscribers.clear();
    await Promise.allSettled(
      [...this.#backgroundRuntimes].map((runtime) => runtime.dispose()),
    );
    this.#backgroundRuntimes.clear();
    this.#runContextsBySession.clear();
    this.#runCancellers.clear();
    this.#sessionModels.clear();
    this.#sessionPermissionPolicies.clear();
    for (const pending of this.#userInputRequests.values()) {
      pending.reject(new Error("Runtime 已关闭"));
    }
    this.#userInputRequests.clear();
    await this.#gateway.dispose();
    await this.#options.mcpManager.dispose();
  }

  async #startConcurrentPrompt(input: {
    taskId: string;
    runId: string;
    prompt: string;
    attachments?: PromptAttachment[];
    context: AgentPromptContext;
  }): Promise<AgentPromptRunHandle> {
    const createRuntime = this.#createRuntimeFactory;
    const sourceFile = input.context.sourceSessionFile;
    if (!createRuntime) throw new Error("Agent Runtime 尚未就绪");
    const workerMode = input.context.interactionMode === "worker";
    if (workerMode && (!input.context.workerProfile || !input.context.workerContext)) {
      throw new Error("Worker 缺少 Profile 或最小上下文包");
    }
    const sessionDirectory = join(
      this.#options.paths.sessionsRoot,
      this.#options.scopeId,
      ...(workerMode ? ["workers"] : []),
    );
    if (!workerMode && !sourceFile) {
      throw new Error("源会话尚未持久化，不能创建并发分支");
    }
    if (!workerMode) {
      try {
        await access(sourceFile!);
      } catch {
        throw new Error("任务恢复失败：最新会话文件已不存在");
      }
    }
    const sessionManager = workerMode
      ? SessionManager.create(this.#options.workspace, sessionDirectory)
      : SessionManager.forkFrom(
        sourceFile!,
        this.#options.workspace,
        sessionDirectory,
        { parentSession: sourceFile! },
      );
    if (workerMode) {
      sessionManager.appendCustomEntry("deki.worker-context", {
        version: 1,
        profile: input.context.workerProfile,
        context: input.context.workerContext,
      });
      sessionManager.appendCustomEntry("deki.model-route", {
        version: 1,
        requestedModel: input.context.requestedModel,
        outputTokenScale: input.context.outputTokenScale ?? 1,
        lowerThinking: input.context.lowerThinking ?? false,
      });
      const sourceSession = this.#sessionById(input.context.sourceSessionId);
      const configuredWorkerModel = this.#options.settings.agent.workerModel
        ? this.#models.find((model) =>
          `${model.provider}/${model.id}` === this.#options.settings.agent.workerModel)
        : undefined;
      const requestedModel = input.context.requestedModel
        ? this.#models.find((model) =>
            `${model.provider}/${model.id}` === input.context.requestedModel)
        : undefined;
      const inheritedModel = requestedModel
        ?? configuredWorkerModel
        ?? this.#sessionModels.get(input.context.sourceSessionId)
        ?? sourceSession?.model
        ?? this.#selectedModel;
      if (inheritedModel) {
        sessionManager.appendModelChange(inheritedModel.provider, inheritedModel.id);
      }
      sessionManager.appendThinkingLevelChange(
        input.context.lowerThinking
          ? lowerThinkingLevel(
              sourceSession?.thinkingLevel
                ?? this.#options.settings.models.thinkingLevel,
            )
          : sourceSession?.thinkingLevel
            ?? this.#options.settings.models.thinkingLevel,
      );
      sessionManager.appendCustomEntry("deki.permission-policies", {
        version: 1,
        policies: this.#permissionPoliciesForSession(input.context.sourceSessionId),
      });
    } else if (input.context.sourceEntryId) {
      if (!sessionManager.getEntry(input.context.sourceEntryId)) {
        throw new Error("任务恢复失败：最新会话位置已不存在");
      }
      sessionManager.branch(input.context.sourceEntryId);
    }
    if (!workerMode) {
      const internalPlanSession = input.context.interactionMode === "plan-execution"
        || (
          input.context.interactionMode === "plan"
          && Boolean(input.context.planId)
        );
      sessionManager.appendCustomEntry("deki.session-visibility", {
        version: 1,
        visibility: internalPlanSession ? "task-only" : "sidebar",
        reason: internalPlanSession ? "plan-internal" : "background-prompt",
        taskId: input.taskId,
        runId: input.runId,
      });
    }
    const background = await createAgentSessionRuntime(createRuntime, {
      cwd: this.#options.workspace,
      agentDir: this.#options.paths.root,
      sessionManager,
    });
    background.session.setSessionName(createSessionTitle(input.prompt));
    background.session.setAutoCompactionEnabled(
      this.#options.settings.agent.compactionEnabled,
    );
    background.session.setAutoRetryEnabled(
      this.#options.settings.models.maxRetries > 0,
    );
    this.#registerSessionConfiguration(background.session, false);
    const execution: AgentExecutionContext = {
      sessionId: background.session.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      interactionMode: input.context.interactionMode ?? "act",
      ...(input.context.workerProfile
        ? { workerProfile: input.context.workerProfile }
        : {}),
      ...(input.context.planId ? { planId: input.context.planId } : {}),
      ...(input.context.planRevision
        ? { planRevision: input.context.planRevision }
        : {}),
    };
    this.#runContextsBySession.set(execution.sessionId, execution);
    this.#backgroundRuntimes.add(background);
    const unsubscribe = background.session.subscribe((event) => {
      if (event.type === "agent_end") {
        background.session.sessionManager.appendCustomEntry("deki.run-state", {
          state: "idle",
          updatedAt: new Date().toISOString(),
        });
      }
      const translated = translatePiAgentEvent(event);
      if (translated) {
        this.#emitForSession(background.session, translated, execution);
      }
      if (event.type === "message_end") {
        const stats = background.session.getSessionStats();
        this.#emitForSession(background.session, {
          type: "usage.updated",
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          toolCallCount: 0,
        }, execution);
      }
    });
    this.#backgroundUnsubscribers.set(background, unsubscribe);
    const memories = workerMode
      ? []
      : this.#recallMemories(input.prompt, background.session.sessionId);
    if (memories.length > 0) {
      await background.session.sendCustomMessage({
        customType: "deki.memory.recall",
        content: renderMemoryContext(memories),
        display: false,
        details: {
          query: input.prompt,
          memoryIds: memories.map((memory) => memory.id),
        },
      }, { triggerTurn: false });
    }
    background.session.sessionManager.appendCustomEntry("deki.run-state", {
      state: "running",
      updatedAt: new Date().toISOString(),
    });
    this.#emitForSession(background.session, { type: "run.started" }, execution);
    const completion = this.#executionContext.run(
      execution,
      async () => {
        const prepared = await preparePromptAttachments(
          input.prompt,
          input.attachments ?? [],
        );
        await background.session.prompt(prepared.prompt, { images: prepared.images });
      },
    )
      .catch((error: unknown) => {
        background.session.sessionManager.appendCustomEntry("deki.run-state", {
          state: "failed",
          error: formatError(error),
          updatedAt: new Date().toISOString(),
        });
        this.#emitForSession(background.session, {
          type: "run.failed",
          error: formatError(error),
        }, execution);
        throw error;
      })
      .finally(async () => {
        background.session.sessionManager.appendCustomEntry("deki.run-state", {
          state: "idle",
          updatedAt: new Date().toISOString(),
        });
        this.#backgroundUnsubscribers.get(background)?.();
        this.#backgroundUnsubscribers.delete(background);
        this.#backgroundRuntimes.delete(background);
        this.#runContextsBySession.delete(execution.sessionId);
        this.#runCancellers.delete(input.taskId);
        this.#sessionModels.delete(background.session.sessionId);
        this.#sessionPermissionPolicies.delete(background.session.sessionId);
        this.#sessionInteractionModes.delete(background.session.sessionId);
        await background.dispose();
      });
    const cancel = async () => {
      if (background.session.isStreaming) await background.session.abort();
    };
    this.#runCancellers.set(input.taskId, cancel);
    return {
      taskId: input.taskId,
      runId: input.runId,
      sessionId: execution.sessionId,
      ...(background.session.model?.provider
        ? { modelProvider: background.session.model.provider }
        : {}),
      ...(background.session.model?.id
        ? { modelId: background.session.model.id }
        : {}),
      completion,
      cancel,
      captureContext: () => ({
        type: "agent-prompt",
        sourceSessionId: background.session.sessionId,
        ...(background.session.sessionFile
          ? { sourceSessionFile: background.session.sessionFile }
          : {}),
        ...(background.session.sessionManager.getLeafId()
          ? { sourceEntryId: background.session.sessionManager.getLeafId()! }
          : {}),
        preferFork: true,
        interactionMode: input.context.interactionMode ?? "act",
        ...(input.context.workerProfile
          ? { workerProfile: input.context.workerProfile }
          : {}),
        ...(input.context.workerContext
          ? { workerContext: input.context.workerContext }
          : {}),
        ...(input.context.planId ? { planId: input.context.planId } : {}),
        ...(input.context.planRevision
          ? { planRevision: input.context.planRevision }
          : {}),
      }),
      captureUsage: () => {
        const stats = background.session.getSessionStats();
        return {
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          toolCallCount: 0,
        };
      },
    };
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
      const workerProfile = readWorkerProfile(sessionManager);
      const recalled = workerProfile
        ? []
        : this.#recallMemories("", sessionManager.getSessionId());
      this.#recalledMemories = recalled;
      const workerModel = this.#options.settings.agent.workerModel
        ? this.#models.find((model) =>
          `${model.provider}/${model.id}` === this.#options.settings.agent.workerModel)
        : undefined;
      const baseSessionModel = resolveSessionModel(
        this.#models,
        sessionManager,
        workerModel ?? selectedModel,
      );
      const route = readModelRoute(sessionManager);
      const outputScale = route?.outputTokenScale ?? 1;
      const sessionModel: ModelType = outputScale === 1
        ? baseSessionModel
        : {
            ...baseSessionModel,
            maxTokens: Math.max(
              256,
              Math.floor(
                Math.min(
                  baseSessionModel.maxTokens
                    ?? this.#options.settings.models.maxOutputTokens,
                  this.#options.settings.models.maxOutputTokens,
                ) * outputScale,
              ),
            ),
          };
      const contextFiles = this.#projectFeaturesEnabled() && !workerProfile
        ? await loadConfiguredContextFiles(
            cwd,
            this.#options.settings.workspace.contextFiles,
            this.#options.settings.workspace.contextIgnore,
          )
        : [];
      const modelContext = sessionModel.contextWindow ?? 128_000;
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
          noContextFiles: !this.#projectFeaturesEnabled() || Boolean(workerProfile),
          noExtensions: !this.#projectFeaturesEnabled() || Boolean(workerProfile),
          noPromptTemplates: !this.#projectFeaturesEnabled() || Boolean(workerProfile),
          noSkills: !this.#projectFeaturesEnabled() || Boolean(workerProfile),
          noThemes: !this.#projectFeaturesEnabled() || Boolean(workerProfile),
          additionalSkillPaths: this.#projectFeaturesEnabled() && !workerProfile
            ? [
                join(cwd, ".deki", "skills"),
                join(cwd, ".agents", "skills"),
                join(cwd, ".pi", "skills"),
                ...defaultGlobalSkillPaths(),
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
            agentsFiles: workerProfile ? [] : dedupeContextFiles([
              {
                path: "deki://built-in/git-commit-conventions.md",
                content: renderBuiltInGitCommitInstructions(
                  this.#options.settings.general.locale,
                ),
              },
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

      const availableTools = this.#projectFeaturesEnabled()
        ? this.#gateway.listTools()
        : this.#gateway.listTools().filter((tool) => tool.providerId === "interaction");
      const tools = workerProfile
        ? availableTools.filter((tool) =>
          workerProfile === "implementer" || workerProfile === "integrator"
            ? (
              (
                tool.providerId === "worker"
                && tool.providerToolName === "submit_result"
              )
              || tool.providerId === "workspace"
              || tool.providerId === "test"
              || tool.effect === "read"
              || tool.effect === "network-read"
              || tool.readOnlyHint === true
            )
            :
          (
            tool.providerId === "worker"
            && tool.providerToolName === "submit_result"
          )
          || (
            tool.providerId === "test"
            && workerProfile === "tester"
          )
          || (
            tool.providerToolName !== "bash"
            && (tool.effect === "read"
              || tool.effect === "network-read"
              || tool.readOnlyHint === true)
          ))
        : availableTools;
      this.#runtimeToolSignature = toolDefinitionSignature(tools);
      return {
        ...await createAgentSessionFromServices({
          services,
          sessionManager,
          ...(sessionStartEvent ? { sessionStartEvent } : {}),
          model: sessionModel,
          tools: tools.map((tool) => tool.modelName),
          customTools: tools.map((tool) =>
            this.#toPiTool(tool, () => sessionManager.getSessionId())),
        }),
        services,
        diagnostics: services.diagnostics,
      };
    };
    this.#createRuntimeFactory = createRuntime;

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
    this.#registerSessionConfiguration(this.#runtime.session);
    this.#runtime.setRebindSession(async (session) => {
      this.#bindSession(session);
    });
    this.#bindSession(this.#runtime.session);
    if (readRunState(this.#runtime.session.sessionManager) === "interrupted") {
      const timeline = this.getSessionHistoryState().events;
      for (const request of timeline.filter(
        (event): event is Extract<AgentEvent, { type: "approval.requested" }> =>
          event.type === "approval.requested"
          && !timeline.some(
            (candidate) => candidate.type === "approval.resolved"
              && candidate.requestId === event.requestId,
          ),
      )) {
        this.#emit({
          type: "approval.resolved",
          requestId: request.requestId,
          decision: "deny",
        });
      }
      this.#appendRunState("interrupted", "应用异常退出，上一轮运行未完成");
      this.#addDiagnostic("已恢复异常退出的会话；上一轮运行已标记为中断", "warning");
    }
    if (this.#recalledMemories.length > 0) {
      this.#emit({ type: "memory.used", memories: this.#recalledMemories });
    }
    this.#emit({
      type: "session.ready",
      model: this.#selectedModel
        ? toModelSummary(this.#selectedModel)
        : undefined,
    });
  }

  #registerSessionConfiguration(
    session: AgentSessionRuntime["session"],
    makeCurrent = true,
  ): void {
    const sessionId = session.sessionId;
    const model = session.model
      ? this.#models.find(
          (candidate) => candidate.provider === session.model?.provider
            && candidate.id === session.model?.id,
        ) ?? session.model
      : undefined;
    if (model) {
      this.#sessionModels.set(sessionId, model);
      if (makeCurrent) this.#selectedModel = model;
    }

    const entries = session.sessionManager.getBranch();
    if (!entries.some((entry) => entry.type === "thinking_level_change")) {
      session.setThinkingLevel(this.#options.settings.models.thinkingLevel);
    }
    const savedPolicies = [...entries].reverse().find(
      (entry) => entry.type === "custom"
        && entry.customType === "deki.permission-policies",
    );
    const parsedPolicies = savedPolicies?.type === "custom"
      ? permissionPoliciesSchema.safeParse(
          isRecord(savedPolicies.data) ? savedPolicies.data.policies : undefined,
        )
      : undefined;
    this.#sessionPermissionPolicies.set(
      sessionId,
      parsedPolicies?.success
        ? { ...parsedPolicies.data }
        : { ...this.#options.settings.permissions.policies },
    );
    const savedMode = [...entries].reverse().find(
      (entry) => entry.type === "custom"
        && entry.customType === "deki.interaction-mode",
    );
    const mode = savedMode?.type === "custom"
      && isRecord(savedMode.data)
      && (savedMode.data.mode === "act" || savedMode.data.mode === "plan")
      ? savedMode.data.mode
      : "act";
    this.#sessionInteractionModes.set(sessionId, mode);
  }

  #permissionPoliciesForSession(sessionId: string | undefined): PermissionPolicies {
    const policies = sessionId
      ? this.#sessionPermissionPolicies.get(sessionId)
      : undefined;
    return {
      ...(policies ?? this.#options.settings.permissions.policies),
    };
  }

  #interactionModeForSession(sessionId: string | undefined): "act" | "plan" {
    return sessionId ? this.#sessionInteractionModes.get(sessionId) ?? "act" : "act";
  }

  #persistSessionPermissionPolicies(
    session: AgentSessionRuntime["session"],
    policies: PermissionPolicies,
  ): void {
    const parsed = permissionPoliciesSchema.parse(policies);
    session.sessionManager.appendCustomEntry("deki.permission-policies", {
      version: 1,
      policies: parsed,
    });
    this.#sessionPermissionPolicies.set(session.sessionId, { ...parsed });
  }

  #toPiTool(tool: GatewayTool, sessionId: () => string): PiToolDefinition {
    return defineTool({
      name: tool.modelName,
      label: tool.internalName,
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      execute: async (toolCallId, params, signal) => {
        const effectiveSessionId = sessionId();
        const execute = async () => {
        const executionContext = this.#runContextsBySession.get(effectiveSessionId)
          ?? this.#executionContext.getStore();
        const context: ToolCallContext = {
          callId: toolCallId,
          workspace: this.#options.workspace,
          ...(executionContext?.sessionId
            ? { sessionId: executionContext.sessionId }
            : {}),
          ...(executionContext?.taskId ? { taskId: executionContext.taskId } : {}),
          ...(executionContext?.runId ? { runId: executionContext.runId } : {}),
          ...(executionContext?.planId ? { planId: executionContext.planId } : {}),
          interactionMode: executionContext?.interactionMode ?? "act",
          ...(executionContext?.workerProfile
            ? { workerProfile: executionContext.workerProfile }
            : {}),
          ...(signal ? { signal } : {}),
        };
        this.#gateway.assertAllowed(tool.modelName, params, context);
        const permissionControlled = tool.providerId !== "workspace"
          && tool.providerId !== "deki"
          && tool.providerId !== "interaction"
          && tool.providerId !== "plan"
          && tool.providerId !== "worker"
          && tool.providerId !== "test";
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
        };
        const execution = this.#runContextsBySession.get(effectiveSessionId);
        return execution
          ? this.#executionContext.run(execution, execute)
          : execute();
      },
    });
  }

  async #requestUserInput(
    input: TaskInteractionInput,
    context: ToolCallContext,
  ): Promise<string> {
    const execution = this.#executionContext.getStore();
    if (!execution) throw new Error("用户输入 Tool 只能在任务运行中调用");
    const requestId = context.callId;
    const value = await new Promise<string>((resolve, reject) => {
      const abort = () => {
        this.#userInputRequests.delete(requestId);
        const error = new Error("用户输入请求已取消");
        error.name = "AbortError";
        reject(error);
      };
      if (context.signal?.aborted) return abort();
      context.signal?.addEventListener("abort", abort, { once: true });
      this.#userInputRequests.set(requestId, {
        execution,
        resolve: (answer) => {
          context.signal?.removeEventListener("abort", abort);
          resolve(answer);
        },
        reject,
      });
      this.#emit({
        type: "user_input.requested",
        requestId,
        title: input.question,
        ...(input.description ? { description: input.description } : {}),
        ...(input.options?.length ? { options: input.options } : {}),
      });
    });
    return value;
  }

  #bindSession(session: AgentSessionRuntime["session"]): void {
    this.#sessionEvents.bind(session, (event) => {
      this.#handleSessionEvent(event);
    });
  }

  #handleSessionEvent(event: AgentSessionEvent): void {
    const session = this.#runtime?.session;
    if (event.type === "agent_end") {
      this.#streaming = false;
      this.#appendRunState("idle");
      void this.#createAutomaticMemoryCandidates();
    }
    const translated = translatePiAgentEvent(event);
    if (translated && session) {
      this.#emitForSession(session, translated);
    }
    if (event.type === "message_end" && session) {
      const stats = session.getSessionStats();
      this.#emitForSession(session, {
        type: "usage.updated",
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        toolCallCount: 0,
      });
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
              tokenBudget: this.#options.settings.memory.projectTokenBudget,
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
              tokenBudget: this.#options.settings.memory.userTokenBudget,
            },
          )
        : [];
    const workspace = this.#projectFeaturesEnabled()
      && this.#options.settings.memory.workspaceMemoryEnabled
      ? this.#options.memoryEngine.recallMemories(
          "workspace",
          this.#options.scopeId,
          query,
          {
            limit: this.#options.settings.memory.workspaceRecallLimit,
            tokenBudget: this.#options.settings.memory.workspaceTokenBudget,
          },
        )
      : [];
    const branch = this.#projectFeaturesEnabled()
      && this.#options.settings.memory.branchMemoryEnabled
      ? this.#options.memoryEngine.recallMemories(
          "branch",
          this.#branchScopeId,
          query,
          {
            limit: this.#options.settings.memory.branchRecallLimit,
            tokenBudget: this.#options.settings.memory.branchTokenBudget,
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
            tokenBudget: this.#options.settings.memory.taskTokenBudget,
          },
        )
      : [];
    return dedupeMemories([...task, ...branch, ...workspace, ...persistent]);
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
    const execution = this.#executionContext.getStore();
    const sessionId = execution?.sessionId
      ?? this.#runtime?.session.sessionId;
    const complete = {
      ...event,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...(sessionId
        ? { sessionId }
        : {}),
      ...(execution
        ? { taskId: execution.taskId, runId: execution.runId }
        : {}),
    } as AgentEvent;
    this.#forwardEvent(complete);
  }

  #forwardEvent(event: AgentEvent): void {
    if (shouldPersistTimelineEvent(event)) {
      const session = event.sessionId
        ? this.#sessionById(event.sessionId)
        : this.#runtime?.session;
      session?.sessionManager.appendCustomEntry("deki.timeline", event);
    }
    this.#options.onEvent(event);
  }

  #sessionById(id: string): AgentSessionRuntime["session"] | undefined {
    if (this.#runtime?.session.sessionId === id) return this.#runtime.session;
    return [...this.#backgroundRuntimes]
      .find((runtime) => runtime.session.sessionId === id)?.session;
  }

  #emitForSession(
    session: AgentSessionRuntime["session"],
    event: AgentEventInput,
    execution = this.#runContextsBySession.get(session.sessionId),
  ): void {
    const complete = {
      ...event,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.sessionId,
      ...(execution
        ? { taskId: execution.taskId, runId: execution.runId }
        : {}),
    } as AgentEvent;
    if (shouldPersistTimelineEvent(complete)) {
      session.sessionManager.appendCustomEntry("deki.timeline", complete);
    }
    this.#options.onEvent(complete);
  }

  #appendRunState(
    state: "idle" | "running" | "interrupted" | "failed",
    error?: string,
  ): void {
    this.#runtime?.session.sessionManager.appendCustomEntry("deki.run-state", {
      state,
      ...(error ? { error } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async #executeCommand(input: string): Promise<void> {
    const [command = "", ...parts] = splitCommand(input);
    const argument = parts.join(" ").trim();
    let output: string;
    switch (command) {
      case "/remember": {
        const scoped = parseRememberCommand(parts);
        const memory = this.remember(scoped.content, scoped.scope);
        output = `已保存 ${memory.scope} 记忆：${memory.content}`;
        break;
      }
      case "/model": {
        if (!argument) {
          output = this.#models.map((model) => {
            const selected = model === this.#selectedModel ? "* " : "  ";
            return `${selected}${model.provider}/${model.id} (${model.name})`;
          }).join("\n") || "没有可用模型";
          break;
        }
        const [provider, ...idParts] = argument.split("/");
        const id = idParts.join("/");
        if (!provider || !id) throw new Error("用法：/model <provider/model>");
        await this.selectModel(provider, id);
        output = `已切换模型：${provider}/${id}`;
        break;
      }
      case "/skills":
        output = this.#skills.length > 0 ? this.#skills.join("\n") : "未加载 Skill";
        break;
      case "/mcp":
        output = this.#options.mcpManager.getStatuses().map(
          (status) => `${status.id}\t${status.state}\t${status.toolCount} tools`,
        ).join("\n") || "未配置 MCP Server";
        break;
      case "/tools":
        output = this.#runtime?.session.getActiveToolNames().join("\n") || "未启用 Tool";
        break;
      case "/permissions":
        output = Object.entries(this.#options.settings.permissions.policies)
          .map(([category, policy]) => `${category}\t${policy}`)
          .join("\n");
        break;
      case "/diff": {
        const diff = [...(this.getSessionHistoryState().events)]
          .reverse()
          .find((event) => event.type === "diff.available");
        output = diff?.type === "diff.available" ? diff.diff : "当前会话没有 Diff";
        break;
      }
      case "/compact":
        if (!this.#runtime) throw new Error("Agent 尚未就绪");
        await this.#runtime.session.compact(argument || undefined);
        output = "上下文压缩完成";
        break;
      case "/resume": {
        if (!argument) {
          output = (await this.listSessions()).map(
            (session) => `${session.current ? "* " : "  "}${session.id}\t${session.name ?? session.firstMessage}`,
          ).join("\n") || "没有历史会话";
          break;
        }
        await this.switchSession(argument);
        output = `已恢复会话：${argument}`;
        break;
      }
      case "/memories": {
        const memories = this.#recallMemories("", this.#runtime?.session.sessionId);
        output = memories.map(
          (memory) => `${memory.id}\t${memory.scope}\t${memory.type}\t${memory.content}`,
        ).join("\n") || "没有可用记忆";
        break;
      }
      case "/forget": {
        if (!argument) throw new Error("用法：/forget <memory-id|all>");
        const scope = this.#projectFeaturesEnabled() ? "project" : "user";
        const scopeId = scope === "project" ? this.#options.scopeId : "user";
        if (argument === "all") {
          const count = this.#options.memoryEngine.clearScope(scope, scopeId);
          output = `已删除 ${count} 条 ${scope} 记忆`;
        } else {
          const deleted = this.#options.memoryEngine.deleteMemory(scope, scopeId, argument);
          if (!deleted) throw new Error("未找到记忆");
          output = `已删除记忆：${argument}`;
        }
        break;
      }
      case "/doctor":
        output = [
          `runtime: ${this.#runtime ? "ready" : "not-ready"}`,
          `model: ${this.#selectedModel ? `${this.#selectedModel.provider}/${this.#selectedModel.id}` : "none"}`,
          `skills: ${this.#skills.length}`,
          `mcp: ${this.#options.mcpManager.getStatuses().length}`,
          ...this.#diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
        ].join("\n");
        break;
      default:
        throw new Error(
          `未知会话命令：${command}。可用命令：/remember /model /skills /mcp /tools /permissions /diff /compact /resume /memories /forget /doctor`,
        );
    }
    this.#emit({ type: "command.result", command, input, output });
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

const LEGACY_PLAN_EXECUTION_PROMPT =
  "执行下面已由用户批准的计划。严格按依赖顺序串行执行，一次只执行一个步骤。";

export function isSessionVisibleInSidebar(
  manager: Pick<SessionManager, "getBranch">,
): boolean {
  const entries = manager.getBranch();
  const savedVisibility = [...entries].reverse().find(
    (candidate) => candidate.type === "custom"
      && candidate.customType === "deki.session-visibility",
  );
  if (
    savedVisibility?.type === "custom"
    && isRecord(savedVisibility.data)
    && savedVisibility.data.visibility === "task-only"
  ) return false;
  if (
    savedVisibility?.type === "custom"
    && isRecord(savedVisibility.data)
    && savedVisibility.data.visibility === "sidebar"
  ) return true;

  // Plan execution sessions created before visibility metadata was introduced
  // contain this exact internal prompt. Keep those historical runs out of the
  // user chat list while retaining their JSONL for Task Center and audit access.
  return !entries.some((entry) => {
    if (entry.type !== "message") return false;
    const message = asUnknownRecord(entry.message);
    return message.role === "user"
      && extractMessageText(message.content).startsWith(LEGACY_PLAN_EXECUTION_PROMPT);
  });
}

function readConversationHistory(
  manager: Pick<SessionManager, "getBranch">,
  sessionId: string,
): ConversationMessage[] {
  return manager.getBranch().reduce<ConversationMessage[]>((history, entry, index) => {
    if (entry.type !== "message") return history;
    const value = asUnknownRecord(entry.message);
    if (value.role !== "user" && value.role !== "assistant") return history;
    const content = extractMessageText(value.content);
    const reasoning = value.role === "assistant"
      ? extractMessageThinking(value.content)
      : "";
    const attachments = value.role === "user"
      ? extractMessageAttachments(value.content)
      : [];
    if (!content && !reasoning && attachments.length === 0) return history;
    const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      ? new Date(value.timestamp).toISOString()
      : undefined;
    const next: ConversationMessage = {
      id: `${sessionId}-${entry.id || index}`,
      entryId: entry.id,
      role: value.role,
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(typeof value.provider === "string" ? { providerId: value.provider } : {}),
      ...(typeof value.model === "string" ? { modelId: value.model } : {}),
      ...(attachments.length ? { attachments } : {}),
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

function readSessionHistoryState(
  manager: Pick<SessionManager, "getBranch" | "getEntries">,
  sessionId: string,
  streaming: boolean,
): SessionHistoryState {
  const events = manager.getBranch().flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "deki.timeline") return [];
    const parsed = agentEventSchema.safeParse(entry.data);
    return parsed.success ? [parsed.data] : [];
  });
  const commandMessages = events.flatMap<ConversationMessage>((event) =>
    event.type === "command.result"
      ? [
          {
            id: `${event.eventId}-input`,
            role: "user",
            content: event.input ?? event.command,
            timestamp: event.timestamp,
          },
          {
            id: `${event.eventId}-output`,
            role: "assistant",
            content: event.output,
            timestamp: event.timestamp,
          },
        ]
      : []);
  return {
    messages: [...readConversationHistory(manager, sessionId), ...commandMessages].sort(
      (left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? ""),
    ),
    events,
    runState: streaming ? "running" : readRunState(manager),
  };
}

function readWorkerProfile(
  manager: Pick<SessionManager, "getBranch">,
): WorkerProfileId | undefined {
  const entry = [...manager.getBranch()].reverse().find(
    (candidate) => candidate.type === "custom"
      && candidate.customType === "deki.worker-context",
  );
  if (entry?.type !== "custom" || !isRecord(entry.data)) return undefined;
  const profile = entry.data.profile;
  return profile === "explorer"
    || profile === "tester"
    || profile === "reviewer"
    || profile === "implementer"
    || profile === "integrator"
    ? profile
    : undefined;
}

function readModelRoute(
  manager: Pick<SessionManager, "getBranch">,
): {
  outputTokenScale: 1 | 0.75 | 0.5;
  lowerThinking: boolean;
} | undefined {
  const entry = [...manager.getBranch()].reverse().find(
    (candidate) => candidate.type === "custom"
      && candidate.customType === "deki.model-route",
  );
  if (entry?.type !== "custom" || !isRecord(entry.data)) return undefined;
  const scale = entry.data.outputTokenScale;
  if (scale !== 1 && scale !== 0.75 && scale !== 0.5) return undefined;
  return {
    outputTokenScale: scale,
    lowerThinking: entry.data.lowerThinking === true,
  };
}

function lowerThinkingLevel(
  level: DekiSettings["models"]["thinkingLevel"] | "max",
): DekiSettings["models"]["thinkingLevel"] {
  if (level === "max") return "high";
  if (level === "xhigh" || level === "high") return "medium";
  if (level === "medium") return "low";
  if (level === "low") return "minimal";
  return level;
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
      effect: "read",
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

type PlanToolHandlers = NonNullable<DekiAgentRuntimeOptions["planTools"]>;

class PlanToolsProvider implements CapabilityProvider {
  readonly id = "plan";
  readonly #handlers: PlanToolHandlers;

  constructor(handlers: PlanToolHandlers) {
    this.#handlers = handlers;
  }

  async listTools(): Promise<ToolDefinition[]> {
    const stepSchema = {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 100 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", minLength: 1, maxLength: 10_000 },
        dependencies: { type: "array", items: { type: "string" }, maxItems: 30 },
        candidateFiles: { type: "array", items: { type: "string" }, maxItems: 100 },
        validation: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 30,
        },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        parallelizable: { type: "boolean" },
        assignedProfile: { type: "string" },
        executionProfile: {
          type: "string",
          enum: ["explorer", "implementer", "tester"],
        },
        writeSet: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              kind: { type: "string", enum: ["file", "directory"] },
              exclusive: { type: "boolean" },
            },
            required: ["path", "kind", "exclusive"],
            additionalProperties: false,
          },
        },
        validationTargets: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              cwd: { type: "string" },
              script: {
                type: "string",
                pattern: "^(?:test(?::[A-Za-z0-9_.-]+)?|lint|typecheck)$",
              },
            },
            required: ["script"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "id", "title", "description", "dependencies", "candidateFiles",
        "validation", "risk", "parallelizable", "executionProfile",
      ],
      additionalProperties: false,
    };
    const planContent = {
      goal: { type: "string", minLength: 1, maxLength: 100_000 },
      assumptions: { type: "array", items: { type: "string" }, maxItems: 100 },
      constraints: { type: "array", items: { type: "string" }, maxItems: 100 },
      steps: { type: "array", items: stepSchema, minItems: 1, maxItems: 30 },
    };
    return [
      {
        name: "submit",
        description: "提交当前只读分析得到的结构化实施计划，供用户审阅。",
        inputSchema: {
          type: "object",
          properties: planContent,
          required: ["goal", "assumptions", "constraints", "steps"],
          additionalProperties: false,
        },
        effect: "plan-control",
      },
      {
        name: "revise",
        description: "根据反馈创建计划的新版本，不修改历史版本。",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string", format: "uuid" },
            basedOnRevision: { type: "integer", minimum: 1 },
            feedback: { type: "string", maxLength: 10_000 },
            ...planContent,
          },
          required: [
            "planId", "basedOnRevision", "goal", "assumptions", "constraints", "steps",
          ],
          additionalProperties: false,
        },
        effect: "plan-control",
      },
      {
        name: "update_step",
        description: "更新当前执行版本中的计划步骤状态。",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string", format: "uuid" },
            revision: { type: "integer", minimum: 1 },
            stepId: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["running", "completed", "blocked"] },
            summary: { type: "string", maxLength: 10_000 },
            evidence: { type: "array", items: { type: "string" }, maxItems: 100 },
            reason: { type: "string", maxLength: 10_000 },
          },
          required: ["planId", "revision", "stepId", "status"],
          additionalProperties: false,
        },
        effect: "plan-control",
      },
      {
        name: "request_replan",
        description: "执行条件偏离已批准计划时暂停执行并请求重新规划。",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string", format: "uuid" },
            reason: { type: "string", minLength: 1, maxLength: 10_000 },
            affectedStepIds: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 30,
            },
            evidence: { type: "array", items: { type: "string" }, maxItems: 100 },
          },
          required: ["planId", "reason", "affectedStepIds"],
          additionalProperties: false,
        },
        effect: "plan-control",
      },
    ];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    const value = input as any;
    let result: unknown;
    if (name === "submit") result = await this.#handlers.submit(value, context);
    else if (name === "revise") result = await this.#handlers.revise(value, context);
    else if (name === "update_step") result = await this.#handlers.updateStep(value, context);
    else if (name === "request_replan") {
      result = await this.#handlers.requestReplan(value, context);
    } else {
      throw new Error(`未知 Plan Tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose(): Promise<void> {}
}

type WorkerToolHandlers = NonNullable<DekiAgentRuntimeOptions["workerTools"]>;

class WorkerToolsProvider implements CapabilityProvider {
  readonly id = "worker";
  readonly #handlers: WorkerToolHandlers;

  constructor(handlers: WorkerToolHandlers) {
    this.#handlers = handlers;
  }

  async listTools(): Promise<ToolDefinition[]> {
    const requestSchema = {
      type: "object",
      properties: {
        profile: {
          type: "string",
          enum: ["explorer", "tester", "reviewer", "implementer"],
        },
        objective: { type: "string", minLength: 1, maxLength: 100_000 },
        successCriteria: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 5_000 },
          minItems: 1,
          maxItems: 30,
        },
        constraints: { type: "array", items: { type: "string" }, maxItems: 100 },
        knownFacts: { type: "array", items: { type: "string" }, maxItems: 100 },
        fileHints: { type: "array", items: { type: "string" }, maxItems: 100 },
        symbolHints: { type: "array", items: { type: "string" }, maxItems: 100 },
        plan: {
          type: "object",
          properties: {
            planId: { type: "string", format: "uuid" },
            revision: { type: "integer", minimum: 1 },
            stepId: { type: "string", minLength: 1, maxLength: 100 },
          },
          required: ["planId", "revision"],
          additionalProperties: false,
        },
        writeSet: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1, maxLength: 2_000 },
              kind: { type: "string", enum: ["file", "directory"] },
              exclusive: { type: "boolean" },
            },
            required: ["path", "kind"],
            additionalProperties: false,
          },
        },
        validationTargets: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              cwd: { type: "string", minLength: 1, maxLength: 2_000 },
              script: {
                type: "string",
                pattern: "^(?:test(?::[A-Za-z0-9_.-]+)?|lint|typecheck)$",
              },
            },
            required: ["script"],
            additionalProperties: false,
          },
        },
      },
      required: ["profile", "objective", "successCriteria"],
      additionalProperties: false,
    };
    const evidenceSchema = {
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { const: "file" },
            path: { type: "string" },
            lineStart: { type: "integer", minimum: 1 },
            lineEnd: { type: "integer", minimum: 1 },
            excerpt: { type: "string" },
          },
          required: ["kind", "path"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "command" },
            target: { type: "string" },
            exitCode: { type: "integer" },
            outputArtifactId: { type: "string", format: "uuid" },
          },
          required: ["kind", "target", "exitCode"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "artifact" },
            artifactId: { type: "string", format: "uuid" },
            description: { type: "string" },
          },
          required: ["kind", "artifactId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            kind: { const: "url" },
            url: { type: "string", format: "uri" },
            description: { type: "string" },
          },
          required: ["kind", "url"],
          additionalProperties: false,
        },
      ],
    };
    return [
      {
        name: "delegate",
        description: "派发两个以内同类型 Worker；Implementer 必须声明写入范围和验证目标，不能与只读 Worker 混合。",
        inputSchema: {
          type: "object",
          properties: {
            requests: {
              type: "array",
              items: requestSchema,
              minItems: 1,
              maxItems: 2,
            },
          },
          required: ["requests"],
          additionalProperties: false,
        },
        effect: "plan-control",
        timeoutMs: 3_600_000,
      },
      {
        name: "submit_result",
        description: "提交当前 Worker 的最终结构化调查结果；Worker 结束前必须调用。",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", minLength: 1, maxLength: 20_000 },
            findings: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                properties: {
                  claim: { type: "string", minLength: 1 },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  evidence: { type: "array", items: evidenceSchema, maxItems: 100 },
                },
                required: ["claim", "confidence", "evidence"],
                additionalProperties: false,
              },
            },
            artifacts: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 100,
            },
            risks: { type: "array", items: { type: "string" }, maxItems: 100 },
            unresolved: { type: "array", items: { type: "string" }, maxItems: 100 },
            recommendedNextActions: {
              type: "array",
              items: { type: "string" },
              maxItems: 100,
            },
            review: {
              type: "object",
              properties: {
                verdict: {
                  type: "string",
                  enum: ["approved", "changes_requested", "blocked"],
                },
                findings: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    properties: {
                      severity: {
                        type: "string",
                        enum: ["low", "medium", "high", "critical"],
                      },
                      summary: { type: "string", minLength: 1, maxLength: 5_000 },
                      evidence: { type: "array", items: evidenceSchema, maxItems: 30 },
                    },
                    required: ["severity", "summary", "evidence"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["verdict", "findings"],
              additionalProperties: false,
            },
          },
          required: [
            "summary",
            "findings",
            "artifacts",
            "risks",
            "unresolved",
            "recommendedNextActions",
          ],
          additionalProperties: false,
        },
        effect: "plan-control",
      },
    ];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    let result: unknown;
    if (name === "delegate") {
      const value = input as { requests: WorkerRequest[] };
      result = await this.#handlers.delegate(value.requests, context);
    } else if (name === "submit_result") {
      result = await this.#handlers.submitResult(input as WorkerResult, context);
    } else {
      throw new Error(`未知 Worker Tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose(): Promise<void> {}
}

class TestToolsProvider implements CapabilityProvider {
  readonly id = "test";
  readonly #handlers: WorkerToolHandlers;

  constructor(handlers: WorkerToolHandlers) {
    this.#handlers = handlers;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "run",
      description: "在临时只读来源副本中运行项目已声明的 test/lint/typecheck 脚本。",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: ["target"],
        additionalProperties: false,
      },
      effect: "read",
      timeoutMs: 600_000,
    }];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    if (name !== "run") throw new Error(`未知 Test Tool: ${name}`);
    if (context.workerProfile !== "tester") {
      throw new Error("只有 Tester Worker 可以运行测试");
    }
    const target = (input as { target?: unknown }).target;
    if (typeof target !== "string" || !target.trim()) throw new Error("target 不能为空");
    const result = await this.#handlers.runTest(target.trim(), context);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose(): Promise<void> {}
}

interface TaskInteractionInput {
  question: string;
  description?: string;
  options?: string[];
}

class TaskInteractionProvider implements CapabilityProvider {
  readonly id = "interaction";
  readonly #request: (
    input: TaskInteractionInput,
    context: ToolCallContext,
  ) => Promise<string>;

  constructor(
    request: (
      input: TaskInteractionInput,
      context: ToolCallContext,
    ) => Promise<string>,
  ) {
    this.#request = request;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "request_user_input",
      description: "当继续任务必须由用户选择或补充信息时，暂停当前任务并请求用户回答。",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", minLength: 1, maxLength: 500 },
          description: { type: "string", maxLength: 10_000 },
          options: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 500 },
            maxItems: 20,
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      readOnlyHint: true,
      effect: "interaction",
      timeoutMs: 86_400_000,
    }];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    if (name !== "request_user_input") throw new Error(`未知交互 Tool: ${name}`);
    const raw = input as Partial<TaskInteractionInput>;
    if (typeof raw.question !== "string" || !raw.question.trim()) {
      throw new Error("question 不能为空");
    }
    const value = await this.#request({
      question: raw.question.trim(),
      ...(typeof raw.description === "string" && raw.description.trim()
        ? { description: raw.description.trim() }
        : {}),
      ...(Array.isArray(raw.options)
        ? { options: raw.options.filter((item): item is string => typeof item === "string") }
        : {}),
    }, context);
    return {
      content: [{ type: "text", text: value }],
      details: { userProvided: true },
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

export function renderBuiltInGitCommitInstructions(
  configuredLocale: DekiSettings["general"]["locale"] = "system",
  systemLocale = resolveSystemLocale(),
): string {
  const locale = configuredLocale === "system" ? systemLocale : configuredLocale;
  const language = locale === "zh-CN" ? "简体中文（zh-CN）" : "English (en-US)";
  return [
    "# Deki 内置 Git 提交规范",
    "",
    "当用户明确要求创建 Git 提交时，必须遵守以下规则：",
    "",
    "- 使用 Conventional Commits 格式：`type(scope): description`；scope 可省略。",
    "- type 使用标准英文关键字，例如 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。",
    "- 破坏性变更使用 `type(scope)!: description`，并按需添加 `BREAKING CHANGE:` footer。",
    `- 当前提交语言是 ${language}。description、正文和说明性 footer 使用该语言；type、scope、Git trailer 键、路径、符号和代码标识符不翻译。`,
    "- description 使用祈使语气，简洁说明本次提交完成的单一变更，不以句号结尾。",
    "- 提交前检查实际暂存差异，根据变更内容选择 type 和 scope；不要提交与用户任务无关的文件。",
    "- 仓库自身的提交规则（例如 DCO 签署、必需 footer 或更严格的格式）仍须同时遵守。",
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
    ...defaultGlobalSkillPaths(),
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
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  };
}

function defaultGlobalSkillPaths(): string[] {
  return [
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".codex", "skills"),
  ];
}

async function resolveBranchScopeId(workspace: string, scopeId: string): Promise<string> {
  try {
    const head = (await readFile(join(workspace, ".git", "HEAD"), "utf8")).trim();
    const branch = head.startsWith("ref: refs/heads/")
      ? head.slice("ref: refs/heads/".length)
      : `detached-${head.slice(0, 12)}`;
    return `${scopeId}:${branch}`;
  } catch {
    return `${scopeId}:no-branch`;
  }
}

function readRunState(
  manager: Pick<SessionManager, "getEntries"> | undefined,
): "idle" | "running" | "interrupted" | "failed" {
  if (!manager) return "idle";
  const latest = [...manager.getEntries()].reverse().find(
    (entry) => entry.type === "custom" && entry.customType === "deki.run-state",
  );
  if (!latest || latest.type !== "custom") return "idle";
  const data = asUnknownRecord(latest.data);
  if (data.state === "running") return "interrupted";
  if (data.state === "interrupted" || data.state === "failed") return data.state;
  return "idle";
}

function shouldPersistTimelineEvent(event: AgentEvent): boolean {
  return event.type === "run.started"
    || event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "tool.started"
    || event.type === "tool.updated"
    || event.type === "tool.completed"
    || event.type === "approval.requested"
    || event.type === "approval.resolved"
    || event.type === "diff.available"
    || event.type === "audit.recorded"
    || event.type === "command.result";
}

function splitCommand(input: string): string[] {
  return input.match(/(?:[^\s"]+|"[^"]*")+/gu)?.map(
    (part) => part.startsWith("\"") && part.endsWith("\"")
      ? part.slice(1, -1)
      : part,
  ) ?? [];
}

function parseRememberCommand(parts: string[]): {
  scope?: MemoryScope;
  content: string;
} {
  const flag = parts[0]?.startsWith("--") ? parts.shift() : undefined;
  const scope = flag === "--task"
    ? "task"
    : flag === "--workspace"
      ? "workspace"
      : flag === "--branch"
        ? "branch"
        : flag === "--project"
          ? "project"
          : flag === "--user"
            ? "user"
            : undefined;
  if (flag && !scope) throw new Error(`未知记忆作用域：${flag}`);
  const content = parts.join(" ").trim();
  if (!content) {
    throw new Error("用法：/remember [--user|--project|--workspace|--branch|--task] <内容>");
  }
  return { ...(scope ? { scope } : {}), content };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSessionModel(
  models: readonly ModelType[],
  sessionManager: SessionManager,
  fallback: ModelType,
): ModelType {
  const savedModel = [...sessionManager.getBranch()].reverse().find(
    (entry) => entry.type === "model_change",
  );
  if (savedModel?.type !== "model_change") return fallback;
  return models.find(
    (model) => model.provider === savedModel.provider
      && model.id === savedModel.modelId,
  ) ?? fallback;
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
  if (typeof content === "string") return stripInternalPlanPrompt(
    stripAttachmentContext(content),
  );
  if (!Array.isArray(content)) return "";
  const text = content.flatMap((item) => {
    const record = asUnknownRecord(item);
    return record.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  }).join("");
  return stripInternalPlanPrompt(stripAttachmentContext(text));
}

function stripInternalPlanPrompt(content: string): string {
  return content.trimStart().startsWith("<deki_internal_plan_execution>")
    ? ""
    : content;
}

function extractMessageAttachments(
  content: unknown,
): NonNullable<ConversationMessage["attachments"]> {
  const items = Array.isArray(content) ? content : [];
  const rawText = items.flatMap((item) => {
    const value = asUnknownRecord(item);
    return value.type === "text" && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("");
  const metadataMatch = rawText.match(
    /<deki_attachment_metadata>(.*?)<\/deki_attachment_metadata>/u,
  );
  const metadata = (() => {
    if (!metadataMatch?.[1]) return [];
    try {
      const parsed = JSON.parse(metadataMatch[1]) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        const value = asUnknownRecord(item);
        return typeof value.name === "string"
          && typeof value.mimeType === "string"
          && typeof value.size === "number"
          ? [{
              name: value.name,
              mimeType: value.mimeType,
              size: value.size,
            }]
          : [];
      });
    } catch {
      return [];
    }
  })();
  const imageItems = items.flatMap((item) => {
    const value = asUnknownRecord(item);
    if (
      value.type !== "image"
      || typeof value.data !== "string"
      || typeof value.mimeType !== "string"
    ) return [];
    return [{
      name: "",
      mimeType: value.mimeType,
      size: Math.floor(value.data.length * 0.75),
      dataUrl: `data:${value.mimeType};base64,${value.data}`,
    }];
  });
  if (metadata.length === 0) {
    return imageItems.map((item, index) => ({
      ...item,
      name: `image-${index + 1}`,
    }));
  }
  let imageIndex = 0;
  return metadata.map((item) => {
    if (!isVisionImage(item.mimeType)) return item;
    const image = imageItems[imageIndex++];
    return image ? { ...item, dataUrl: image.dataUrl } : item;
  });
}

function stripAttachmentContext(text: string): string {
  return text
    .replace(/\n*<attached_files>[\s\S]*<\/attached_files>\s*$/u, "")
    .replace(/^<deki_attachment_only>[\s\S]*<\/deki_attachment_only>$/u, "")
    .trimEnd();
}

async function preparePromptAttachments(
  prompt: string,
  attachments: PromptAttachment[],
): Promise<{ prompt: string; images: ImageContent[] }> {
  if (attachments.length === 0) return { prompt, images: [] };
  const images: ImageContent[] = [];
  const descriptions: string[] = [];
  let includedTextBytes = 0;
  for (const attachment of attachments) {
    const buffer = await readFile(attachment.path);
    if (buffer.byteLength !== attachment.size) {
      throw new Error(`附件已损坏或大小发生变化：${attachment.name}`);
    }
    if (isVisionImage(attachment.mimeType)) {
      images.push({
        type: "image",
        data: buffer.toString("base64"),
        mimeType: attachment.mimeType,
      });
      descriptions.push(`- ${escapeAttachmentMarkup(attachment.name)} (${attachment.mimeType}, image included)`);
      continue;
    }
    if (isTextAttachment(attachment.name, attachment.mimeType)) {
      const remaining = Math.max(0, 500_000 - includedTextBytes);
      const slice = buffer.subarray(0, Math.min(buffer.byteLength, remaining));
      includedTextBytes += slice.byteLength;
      const truncated = slice.byteLength < buffer.byteLength;
      descriptions.push([
        `- ${escapeAttachmentMarkup(attachment.name)} (${attachment.mimeType}, ${attachment.size} bytes)`,
        "```",
        slice.toString("utf8"),
        truncated ? "\n[内容过长，已截断]" : "",
        "```",
      ].join("\n"));
      continue;
    }
    descriptions.push(
      `- ${escapeAttachmentMarkup(attachment.name)} (${attachment.mimeType}, ${attachment.size} bytes; local path: ${escapeAttachmentMarkup(attachment.path)})`,
    );
  }
  return {
    prompt: [
      prompt,
      "",
      "<attached_files>",
      `<deki_attachment_metadata>${JSON.stringify(attachments.map((item) => ({
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
      }))).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}</deki_attachment_metadata>`,
      ...descriptions,
      "</attached_files>",
    ].join("\n"),
    images,
  };
}

function escapeAttachmentMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isVisionImage(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    mimeType.toLocaleLowerCase(),
  );
}

function isTextAttachment(name: string, mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  if ([
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/sql",
  ].includes(mimeType.toLocaleLowerCase())) return true;
  return /\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|kt|log|md|mjs|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/iu.test(name);
}

function unwrapPromptOptimization(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/iu);
  return (fenced?.[1] ?? trimmed).trim();
}

function renderPromptOptimizerSystemPrompt(projectConnected: boolean): string {
  const environment = projectConnected
    ? [
        "运行环境：目标 AI Agent 已连接用户当前选择的项目工作区。",
        "它可以自行读取和搜索代码、配置、依赖、测试、Git 历史及项目文档，并可运行受控检查。",
        "用户提到“当前项目”“这个项目”“代码库”时，指的就是这个已连接工作区；绝对不要反问项目类型、技术栈、仓库路径或代码规模。",
      ]
    : [
        "运行环境：当前是未连接项目的普通会话。",
        "只有在缺失信息确实阻止任务执行时，才保留最少量的待确认项。",
      ];
  return [
    "你是一名 AI Agent 任务说明优化专家。",
    "你的输出会直接替换用户输入框中的草稿，随后由另一个 Agent 执行；你不是在回答用户的问题。",
    "先理解用户真正想达成的结果，再把草稿改写成可立即执行的任务说明。",
    ...environment,
    "",
    "必须遵守：",
    "1. 保持用户原本的语言、目标和授权范围，不擅自增加修改、部署、发布或其他操作。",
    "2. 能由 Agent 通过工作区、代码、配置、测试、Git 或工具获得的信息，必须改写为调查步骤，不能要求用户补充。",
    "3. 只有业务偏好、外部系统权限、密钥、破坏性决定等无法从项目中获得且会实质影响结果的信息，才可标记为“待确认”。",
    "4. 分析、审查、寻找优化点等请求默认只检查并报告，不修改文件；除非用户明确要求实施。",
    "5. 对项目审查类请求，应要求 Agent 基于证据识别问题，按影响、紧迫性和实施成本排序，并给出文件位置或检查结果作为依据。",
    "6. 工作步骤应具体但不过度限定技术方案；先检查实际项目，再决定哪些架构、性能、安全、测试、依赖、可维护性、开发体验或用户体验维度相关。",
    "7. 输出以明确目标开头，并按需包含检查范围、工作步骤、交付物、约束和验收标准；简单请求保持简洁。",
    "8. 不要以“请补充信息”“请提供资料”“我需要了解”开头，不要把优化结果写成对用户的问卷。",
    "9. 只输出优化后的任务说明，不解释改写过程，不使用代码围栏。",
  ].join("\n");
}

function isClarificationHeavyPrompt(content: string): boolean {
  if (!content.trim()) return false;
  return [
    /请补充.{0,20}(信息|资料)/u,
    /请提供.{0,20}(信息|资料)/u,
    /提供上述信息后/u,
    /需要(?:先)?了解.{0,20}(项目|信息)/u,
    /(?:please provide|need more information|could you clarify)/iu,
  ].some((pattern) => pattern.test(content));
}

function renderProjectInvestigationFallback(input: string): string {
  const chinese = /\p{Script=Han}/u.test(input);
  if (!chinese) {
    return [
      `Goal: Work from the currently connected repository to complete this request: ${input}`,
      "",
      "Work steps:",
      "1. Inspect the project documentation, manifests, configuration, directory structure, implementation, tests, and relevant Git context to establish how the project actually works.",
      "2. Identify the review dimensions supported by evidence, such as architecture, correctness, maintainability, performance, security, dependencies, testing, developer experience, and user experience.",
      "3. Run safe, relevant checks where useful and distinguish verified findings from hypotheses.",
      "4. Prioritize findings by impact, urgency, risk, and implementation effort. For each finding, include evidence locations, the recommended change, expected benefit, and a practical next step.",
      "",
      "Constraints: Derive technical context from the repository instead of asking the user for information available there. Preserve the original authorization scope; do not modify files when the request only asks for analysis or recommendations.",
      "",
      "Deliverable: A concise, prioritized optimization report covering quick wins, larger improvements, risks, and a recommended implementation order.",
    ].join("\n");
  }
  return [
    `目标：基于当前已连接的项目工作区完成以下请求：${input}`,
    "",
    "工作步骤：",
    "1. 主动检查项目文档、依赖清单、配置、目录结构、核心实现、测试和相关 Git 信息，先建立对项目现状的真实理解。",
    "2. 根据实际证据选择需要审查的维度，例如架构、正确性、可维护性、性能、安全、依赖、测试、开发体验和用户体验，不做脱离代码的泛泛推测。",
    "3. 在有帮助时运行安全且相关的检查，明确区分已验证问题和待验证假设。",
    "4. 按影响、紧迫性、风险和实施成本排列优化项；每项给出文件或检查结果依据、改进建议、预期收益和可执行的下一步。",
    "",
    "约束：能从项目中获得的信息由 Agent 自行调查，不要求用户补充。严格保持原始请求的授权范围；如果只是要求分析或建议，不修改文件。",
    "",
    "交付物：一份简洁、按优先级排序的优化报告，包含快速收益项、中长期改进、主要风险和推荐实施顺序。",
  ].join("\n");
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
