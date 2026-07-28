import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import electronUpdater from "electron-updater";
import { DekiAgentRuntime } from "@deki-ai/agent-runtime";
import { AgentSupervisor } from "@deki-ai/agent-supervisor";
import { GitCheckpointManager } from "@deki-ai/git-checkpoint";
import {
  ArtifactStore,
  WorktreeRunner,
  WorkspaceDriftError,
  scheduleWriteWaves,
  validateWriteSet,
  writeSetsOverlap,
  type WorktreeResource,
} from "@deki-ai/runner";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ensureDekiDirectories,
  formatError,
  getDekiPaths,
  isWorkspaceTrusted,
  listRecentWorkspaces,
  loadMcpConfig,
  readMcpConfig,
  readMcpLocalConfig,
  revokeWorkspaceTrust,
  resolveWorkspace,
  trustWorkspace,
  writeMcpConfig,
  writeMcpLocalConfig,
  workspaceId,
  type DekiPaths,
} from "@deki-ai/config";
import { McpManager } from "@deki-ai/mcp-manager";
import { MemoryEngine } from "@deki-ai/memory-engine";
import {
  TaskOrchestrator,
  TaskStore,
  type PromptExecutionInput,
} from "@deki-ai/task-orchestrator";
import {
  ModelConfigStore,
  SettingsStore,
  settingsPatchSchema,
  type ModelProviderInput,
  type PermissionCategory,
  type SettingsPatch,
  type SettingsScope,
  type SettingsSnapshot,
} from "@deki-ai/settings";
import {
  agentEventSchema,
  auditRecordSummarySchema,
  bootstrapStateSchema,
  commandResultSchema,
  clearDataInputSchema,
  dataUsageSchema,
  gitCheckpointCreateInputSchema,
  gitCheckpointIdInputSchema,
  gitCheckpointSchema,
  IPC_CHANNELS,
  mcpServerEditorSchema,
  mcpToolSummarySchema,
  memoryMutationSchema,
  memoryListInputSchema,
  memoryMoveInputSchema,
  openWorkspaceInputSchema,
  optimizePromptInputSchema,
  optimizePromptResultSchema,
  approvePlanInputSchema,
  planDetailSchema,
  planEventSchema,
  planIdInputSchema,
  planListInputSchema,
  planSummarySchema,
  revisePlanInputSchema,
  replanInputSchema,
  modelProviderInputSchema,
  modelProviderCatalogResultSchema,
  redactedModelProviderSchema,
  conversationMessageSchema,
  forkSessionInputSchema,
  renameSessionInputSchema,
  sessionIdInputSchema,
  sessionSearchInputSchema,
  sessionHistoryStateSchema,
  sessionSummarySchema,
  skillStatusSchema,
  skillActionInputSchema,
  taskDetailSchema,
  taskEventSchema,
  taskIdInputSchema,
  taskListInputSchema,
  taskSummarySchema,
  taskInputResponseSchema,
  taskApprovalDecisionInputSchema,
  integrationDecisionInputSchema,
  artifactChunkInputSchema,
  artifactChunkSchema,
  taskSubmissionResultSchema,
  rememberInputSchema,
  removeModelProviderInputSchema,
  resetSettingsInputSchema,
  selectModelInputSchema,
  sendPromptInputSchema,
  settingsSnapshotSchema,
  updateSettingsInputSchema,
  updateSessionConfigurationInputSchema,
  type AgentEvent,
  type BootstrapState,
  type CommandResult,
  type McpServerEditor,
  type MemoryScope,
  type OptimizePromptResult,
  type PlanDetail,
  type PlanEvent,
  type PlanListInput,
  type TaskEvent,
  type TaskListInput,
  type TaskSubmissionResult,
  type UpdateSessionConfigurationInput,
  type WorkerRequest,
  workerRequestSchema,
  workerResultSchema,
} from "@deki-ai/shared";

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
  },
}]);

let controller: DesktopController | undefined;
let taskStore: TaskStore | undefined;
let taskOrchestrator: TaskOrchestrator | undefined;
let agentSupervisor: AgentSupervisor | undefined;
const workspaceControllers = new Map<string, DesktopController>();
let quitting = false;
let shutdownComplete = false;
let updateCheckTimer: NodeJS.Timeout | undefined;
let appliedUpdateConfiguration = "";
const repositoryWriteLocks = new Map<string, Promise<void>>();
const { autoUpdater } = electronUpdater;

class DesktopController {
  readonly #workspace: string | undefined;
  readonly #runtimeWorkspace: string;
  readonly #scopeId: string;
  readonly #projectFeatures: boolean;
  readonly #paths: DekiPaths;
  readonly #memory: MemoryEngine;
  readonly #mcp = new McpManager();
  readonly #settings: SettingsStore;
  readonly #models: ModelConfigStore;
  readonly #checkpoints: GitCheckpointManager | undefined;
  readonly #tasks: TaskOrchestrator;
  readonly #resumeLatest: boolean;
  #runtime: DekiAgentRuntime | undefined;
  #trusted = false;
  #starting: Promise<void> | undefined;
  #diagnostics: string[] = [];
  #reloadPending = false;
  #recentWorkspaces: string[];

  private constructor(
    workspace: string | undefined,
    runtimeWorkspace: string,
    scopeId: string,
    paths: DekiPaths,
    memory: MemoryEngine,
    settings: SettingsStore,
    tasks: TaskOrchestrator,
    recentWorkspaces: string[],
    resumeLatest: boolean,
  ) {
    this.#workspace = workspace;
    this.#runtimeWorkspace = runtimeWorkspace;
    this.#scopeId = scopeId;
    this.#projectFeatures = workspace !== undefined;
    this.#paths = paths;
    this.#memory = memory;
    this.#settings = settings;
    this.#models = new ModelConfigStore(paths.modelsFile);
    this.#checkpoints = workspace ? new GitCheckpointManager(workspace) : undefined;
    this.#tasks = tasks;
    this.#resumeLatest = resumeLatest;
    this.#recentWorkspaces = recentWorkspaces;
    this.#settings.subscribe((snapshot) => {
      applyNativeSettings(snapshot);
      broadcastSettings(snapshot);
    });
  }

  static async create(
    workspace?: string,
    options: {
      resumeLatest?: boolean;
      tasks?: TaskOrchestrator;
      trustedEphemeral?: boolean;
    } = {},
  ): Promise<DesktopController> {
    const paths = getDekiPaths();
    await ensureDekiDirectories(paths);
    const runtimeWorkspace = workspace ?? join(paths.root, "general");
    await mkdir(runtimeWorkspace, { recursive: true });
    const memory = new MemoryEngine(paths.memoryDatabase);
    const scopeId = workspace ? workspaceId(workspace) : "general";
    const settings = new SettingsStore({
      globalFile: paths.settingsFile,
      ...(workspace ? { workspace } : {}),
      ...(workspace
        ? { projectLocalFile: join(paths.projectsRoot, scopeId, "settings.json") }
        : {}),
    });
    const settingsSnapshot = await settings.initialize();
    memory.governMemories(
      settingsSnapshot.effective.memory.lowConfidenceArchiveThreshold,
    );
    applyNativeSettings(settingsSnapshot);
    await cleanupGeneralLogs(
      paths.logsRoot,
      settingsSnapshot.effective.privacy.logRetentionDays,
    );
    await cleanupExpiredSessions(
      runtimeWorkspace,
      join(paths.sessionsRoot, scopeId),
      settingsSnapshot.effective.agent.sessionRetentionDays,
    );
    const instance = new DesktopController(
      workspace,
      runtimeWorkspace,
      scopeId,
      paths,
      memory,
      settings,
      options.tasks ?? requireTaskOrchestrator(),
      await listRecentWorkspaces(paths.configFile),
      options.resumeLatest === true,
    );
    instance.#trusted = workspace
      ? options.trustedEphemeral === true
        || await isWorkspaceTrusted(paths.configFile, workspace)
      : true;
    if (instance.#trusted) {
      await instance.#startRuntime();
    }
    return instance;
  }

  get workspacePath(): string | undefined {
    return this.#workspace;
  }

  get scopeId(): string {
    return this.#scopeId;
  }

  get availableForTasks(): boolean {
    return this.#trusted
      && !this.#reloadPending
      && Boolean(this.#runtime?.snapshot().ready);
  }

  get trusted(): boolean {
    return this.#trusted;
  }

  getState(): BootstrapState {
    const snapshot = this.#runtime?.snapshot();
    return bootstrapStateSchema.parse({
      ...(this.#workspace ? { workspace: this.#workspace } : {}),
      trusted: this.#trusted,
      ready: snapshot?.ready ?? false,
      streaming: snapshot?.streaming ?? false,
      ...(snapshot?.sessionId ? { sessionId: snapshot.sessionId } : {}),
      models: snapshot?.models ?? [],
      ...(snapshot?.selectedModel ? { selectedModel: snapshot.selectedModel } : {}),
      ...(snapshot?.sessionConfiguration
        ? { sessionConfiguration: snapshot.sessionConfiguration }
        : {}),
      memories: [
        ...(this.#projectFeatures
          ? this.#memory.listProjectMemories(this.#scopeId)
          : this.#settings.snapshot().effective.memory.userMemoryEnabled
            ? this.#memory.listMemories("user", "user", { limit: 100 })
            : []),
        ...(this.#projectFeatures && this.#settings.snapshot().effective.memory.workspaceMemoryEnabled
          ? this.#memory.listMemories("workspace", this.#scopeId, { limit: 100 })
          : []),
        ...(this.#projectFeatures && this.#settings.snapshot().effective.memory.branchMemoryEnabled
          ? this.#memory.listMemories(
              "branch",
              this.#runtime?.memoryScopeId("branch") ?? `${this.#scopeId}:no-branch`,
              { limit: 100 },
            )
          : []),
        ...(snapshot?.sessionId && this.#settings.snapshot().effective.memory.taskMemoryEnabled
          ? this.#memory.listMemories("task", snapshot.sessionId, { limit: 100 })
          : []),
      ],
      recalledMemories: snapshot?.recalledMemories ?? [],
      mcpServers: this.#mcp.getStatuses(),
      skills: snapshot?.skills ?? [],
      diagnostics: [...this.#diagnostics, ...(snapshot?.diagnostics ?? [])],
      ...(snapshot?.modelUsage ? { modelUsage: snapshot.modelUsage } : {}),
      activeRunCount: this.#tasks.activeRunCount,
      recentWorkspaces: this.#recentWorkspaces,
    });
  }

  async trust(): Promise<CommandResult> {
    if (!this.#workspace) {
      return { ok: true };
    }
    try {
      await trustWorkspace(this.#paths.configFile, this.#workspace);
      this.#recentWorkspaces = await listRecentWorkspaces(this.#paths.configFile);
      this.#trusted = true;
      await this.#startRuntime();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async sendPrompt(
    prompt: string,
    mode: "foreground" | "background" = "foreground",
    interactionMode: "act" | "plan" = "act",
  ): Promise<TaskSubmissionResult> {
    const trimmed = prompt.trim();
    if (trimmed.startsWith("/")) {
      if (mode === "background") {
        return { ok: false, error: "会话命令不能在后台运行" };
      }
      return this.#run(async (runtime) => runtime.prompt(trimmed));
    }
    if (!this.#trusted) {
      return { ok: false, error: "请先信任当前工作区" };
    }
    if (interactionMode === "plan" && !this.#projectFeatures) {
      return { ok: false, error: "Plan 模式只在受信任的项目会话中可用" };
    }
    const runtime = this.#runtime;
    if (!runtime) {
      return { ok: false, error: "Agent Runtime 尚未就绪" };
    }
    try {
      const snapshot = runtime.snapshot();
      const sessionId = snapshot.sessionId;
      if (!sessionId) throw new Error("当前会话尚未就绪");
      if (mode === "foreground" && snapshot.streaming) {
        return { ok: false, error: "当前会话正在运行，请使用“后台运行”提交新任务" };
      }
      const hasPending = this.#tasks.listTasks({
        statuses: ["queued", "running", "waiting_approval", "waiting_user"],
        workspaceIds: [this.#scopeId],
        limit: 500,
      }).some((task) => task.sessionId === sessionId || !task.sessionId);
      const preferFork = mode === "background" || snapshot.streaming || hasPending;
      const context = runtime.capturePromptContext(preferFork);
      const task = this.#tasks.submitPrompt({
        workspaceId: this.#scopeId,
        ...(this.#workspace ? { workspacePath: this.#workspace } : {}),
        title: createTaskTitle(trimmed),
        prompt: trimmed,
        kind: interactionMode === "plan"
          ? "planning"
          : mode === "background" ? "background" : "interactive",
        execution: {
          type: "agent-prompt",
          sourceSessionId: context.sourceSessionId,
          ...(context.sourceSessionFile
            ? { sourceSessionFile: context.sourceSessionFile }
            : {}),
          ...(context.sourceEntryId
            ? { sourceEntryId: context.sourceEntryId }
            : {}),
          preferFork,
          interactionMode,
          deliveryMode: mode,
        },
      });
      return { ok: true, task };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async optimizePrompt(prompt: string): Promise<OptimizePromptResult> {
    if (!this.#trusted) {
      return { ok: false, error: "请先信任当前工作区" };
    }
    const runtime = this.#runtime;
    if (!runtime) {
      return { ok: false, error: "Agent Runtime 尚未就绪" };
    }
    try {
      return {
        ok: true,
        prompt: await runtime.optimizePrompt(prompt),
      };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async abort(): Promise<CommandResult> {
    const sessionId = this.#runtime?.snapshot().sessionId;
    const task = sessionId
      ? this.#tasks.currentTaskForSession(this.#scopeId, sessionId)
      : undefined;
    return task
      ? this.cancelTask(task.id)
      : this.#run(async (runtime) => runtime.abort());
  }

  listTasks(input: TaskListInput) {
    return this.#tasks.listTaskSummaries({
      limit: input.limit,
      workspaceIds: input.workspaceIds ?? [this.#scopeId],
      ...(input.statuses ? { statuses: input.statuses } : {}),
      ...(input.query ? { query: input.query } : {}),
    });
  }

  getTask(taskId: string) {
    return this.#tasks.getTask(taskId) ?? null;
  }

  listPlans(input: PlanListInput) {
    return taskStore?.listPlans({
      limit: input.limit,
      workspaceIds: input.workspaceIds ?? [this.#scopeId],
      ...(input.statuses ? { statuses: input.statuses } : {}),
      ...(input.query ? { query: input.query } : {}),
    }) ?? [];
  }

  getPlan(planId: string) {
    return taskStore?.getPlan(planId) ?? null;
  }

  async approvePlan(planId: string, revision: number): Promise<CommandResult> {
    if (!this.#trusted || !this.#runtime) {
      return { ok: false, error: "项目未受信任或 Runtime 尚未就绪" };
    }
    try {
      const detail = taskStore?.getPlan(planId);
      if (!detail || detail.plan.workspaceId !== this.#scopeId) {
        return { ok: false, error: "未找到当前项目的计划" };
      }
      if (detail.planningTask?.status !== "succeeded") {
        return { ok: false, error: "规划任务尚未成功完成，不能批准计划" };
      }
      const context = await this.#resolvePlanCheckpoint(detail, true);
      taskStore!.approvePlan(planId, revision, {
        title: `执行计划：${createTaskTitle(detail.plan.goal)}`,
        execution: {
          type: "agent-prompt",
          sourceSessionId: context.sourceSessionId,
          ...(context.sourceSessionFile
            ? { sourceSessionFile: context.sourceSessionFile }
            : {}),
          ...(context.sourceEntryId ? { sourceEntryId: context.sourceEntryId } : {}),
          preferFork: true,
          interactionMode: "plan-execution",
          planId,
          planRevision: revision,
          deliveryMode: "background",
        },
      });
      this.#tasks.start();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async requestPlanRevision(
    planId: string,
    feedback: string,
    mode: "foreground" | "background" = "foreground",
    affectedStepIds: string[] = [],
  ): Promise<TaskSubmissionResult> {
    if (!this.#trusted || !this.#runtime) {
      return { ok: false, error: "项目未受信任或 Runtime 尚未就绪" };
    }
    try {
      const detail = taskStore?.getPlan(planId);
      if (!detail || detail.plan.workspaceId !== this.#scopeId) {
        return { ok: false, error: "未找到当前项目的计划" };
      }
      const activeExecution = detail.executionTask
        && ["running", "waiting_approval", "waiting_user"].includes(
          detail.executionTask.status,
        );
      const context = activeExecution
        ? taskStore!.getExecution(detail.executionTask!.id)
        : await this.#resolvePlanCheckpoint(detail, mode === "background");
      const activeStepIds = detail.stepStates.filter(
        (state) => state.revision === detail.plan.currentRevision
          && (state.status === "running" || state.status === "blocked"),
      ).map((state) => state.stepId);
      const request = this.#tasks.requestPlanRevision(planId, {
        feedback,
        affectedStepIds: affectedStepIds.length > 0 ? affectedStepIds : activeStepIds,
        title: `修订计划：${createTaskTitle(detail.plan.goal)}`,
        execution: {
          type: "agent-prompt",
          sourceSessionId: context.sourceSessionId,
          ...(context.sourceSessionFile
            ? { sourceSessionFile: context.sourceSessionFile }
            : {}),
          ...(context.sourceEntryId ? { sourceEntryId: context.sourceEntryId } : {}),
          preferFork: mode === "background",
          interactionMode: "plan",
          planId,
          planRevision: detail.plan.currentRevision,
          deliveryMode: mode,
        },
      });
      return { ok: true, task: await request.planningTask };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async requestPlanReplan(
    planId: string,
    reason: string,
    affectedStepIds: string[] = [],
  ): Promise<TaskSubmissionResult> {
    const detail = taskStore?.getPlan(planId);
    if (!detail || detail.plan.workspaceId !== this.#scopeId) {
      return { ok: false, error: "未找到当前项目的计划" };
    }
    if (
      detail.plan.status === "executing"
      && detail.plan.executionTaskId
    ) {
      try {
        const request = this.#tasks.requestReplan(detail.plan.executionTaskId, {
          planId,
          reason,
          affectedStepIds,
          title: `修订计划：${createTaskTitle(detail.plan.goal)}`,
          deliveryMode: "foreground",
        });
        if (!request) {
          return { ok: false, error: "计划执行任务当前不能重新规划" };
        }
        return { ok: true, task: await request.planningTask };
      } catch (error) {
        return { ok: false, error: formatError(error) };
      }
    }
    return await this.requestPlanRevision(planId, reason, "foreground", affectedStepIds);
  }

  async #resolvePlanCheckpoint(
    detail: PlanDetail,
    preferFork: boolean,
  ): Promise<PromptExecutionInput> {
    const taskIds = [
      taskStore?.getLatestPlanningTask(detail.plan.id)?.id,
      detail.plan.executionTaskId,
    ].filter((id): id is string => Boolean(id));
    for (const taskId of taskIds) {
      const execution = taskStore?.getExecution(taskId);
      if (!execution) continue;
      if (!execution.sourceSessionFile || !execution.sourceEntryId) {
        throw new Error("计划最新 checkpoint 尚未持久化，不能从旧上下文继续");
      }
      const context = {
        sourceSessionId: execution.sourceSessionId,
        sourceSessionFile: execution.sourceSessionFile,
        sourceEntryId: execution.sourceEntryId,
        preferFork,
      };
      await this.#runtime!.validatePromptContext(context);
      return { ...execution, ...context };
    }
    const context = await this.#runtime!.captureSessionPromptContext(
      detail.plan.sessionId,
      preferFork,
    );
    await this.#runtime!.validatePromptContext(context);
    return {
      type: "agent-prompt",
      ...context,
      deliveryMode: "foreground",
    };
  }

  async abandonPlan(planId: string): Promise<CommandResult> {
    try {
      const detail = taskStore?.getPlan(planId);
      if (!detail || detail.plan.workspaceId !== this.#scopeId) {
        return { ok: false, error: "未找到当前项目的计划" };
      }
      if (detail.plan.executionTaskId) {
        await this.#tasks.cancelTask(detail.plan.executionTaskId);
      }
      if (taskStore?.getPlan(planId)?.plan.status !== "abandoned") {
        taskStore!.abandonPlan(planId);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  openPlanSession(planId: string): Promise<CommandResult> {
    const plan = taskStore?.getPlan(planId)?.plan;
    if (!plan) return Promise.resolve({ ok: false, error: "未找到计划" });
    return this.openTaskSession(plan.sessionId);
  }

  async cancelTask(taskId: string): Promise<CommandResult> {
    try {
      return await this.#tasks.cancelTask(taskId)
        ? { ok: true }
        : { ok: false, error: "未找到可取消的任务" };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async executeTask(input: {
    task: import("@deki-ai/shared").TaskRecord;
    run: import("@deki-ai/shared").RunRecord;
    execution: PromptExecutionInput;
    signal: AbortSignal;
  }) {
    const runtime = this.#runtime;
    if (!runtime) throw new Error("任务所属工作区 Runtime 尚未就绪");
    const prompt = input.task.kind === "plan-execution" && input.task.planId
      ? renderPlanExecutionPrompt(taskStore?.getPlan(input.task.planId), input.task.goal)
      : input.execution.interactionMode === "plan"
        ? renderPlanningPrompt(input.task.goal, input.execution.planId, taskStore)
        : input.task.kind === "worker" && input.execution.workerContext
          ? renderWorkerPrompt(
            input.execution.workerProfile!,
            input.execution.workerContext,
            input.execution.worktreeContext,
          )
        : input.execution.continuation
          ? renderTaskContinuation(input.task, taskStore)
          : input.task.goal;
    const handle = await runtime.startPrompt({
      taskId: input.task.id,
      runId: input.run.id,
      prompt,
      context: {
        sourceSessionId: input.execution.sourceSessionId,
        ...(input.execution.sourceSessionFile
          ? { sourceSessionFile: input.execution.sourceSessionFile }
          : {}),
        ...(input.execution.sourceEntryId
          ? { sourceEntryId: input.execution.sourceEntryId }
          : {}),
        preferFork: input.execution.preferFork,
        interactionMode: input.execution.interactionMode ?? "act",
        ...(input.execution.planId ? { planId: input.execution.planId } : {}),
        ...(input.execution.planRevision
          ? { planRevision: input.execution.planRevision }
          : {}),
        ...(input.execution.workerProfile
          ? { workerProfile: input.execution.workerProfile }
          : {}),
        ...(input.execution.workerContext
          ? { workerContext: input.execution.workerContext }
          : {}),
      },
    });
    if (input.signal.aborted) await handle.cancel();
    return handle;
  }

  async openTaskSession(sessionId: string): Promise<CommandResult> {
    if (this.#runtime?.snapshot().sessionId === sessionId) return { ok: true };
    return this.switchSession(sessionId);
  }

  async newSession(): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.newSession());
  }

  async listSessions(query = "") {
    return this.#runtime?.listSessions(query) ?? [];
  }

  getSessionHistory() {
    return this.#runtime?.getSessionHistory() ?? [];
  }

  getSessionHistoryState() {
    return this.#runtime?.getSessionHistoryState() ?? {
      messages: [],
      events: [],
      runState: "idle" as const,
    };
  }

  async forkSession(entryId: string): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.forkSession(entryId));
  }

  async switchSession(id: string): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.switchSession(id));
  }

  async renameSession(id: string, name: string): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.renameSession(id, name));
  }

  async deleteSession(id: string): Promise<CommandResult> {
    const runtime = this.#runtime;
    if (!runtime) return { ok: false, error: "Agent Runtime 尚未就绪" };
    if (runtime.snapshot().sessionId === id) {
      return { ok: false, error: "不能删除当前会话，请先切换到其他会话" };
    }
    if (runtime.isSessionRunning(id)) {
      return { ok: false, error: "不能删除仍在后台运行的会话" };
    }
    try {
      await shell.trashItem(await runtime.getSessionPath(id));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async remember(content: string, scope?: MemoryScope): Promise<CommandResult> {
    return this.#run(async (runtime) => {
      runtime.remember(content, scope);
    });
  }

  async selectModel(provider: string, id: string): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.selectModel(provider, id));
  }

  async updateSessionConfiguration(
    input: UpdateSessionConfigurationInput,
  ): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.updateSessionConfiguration(input));
  }

  getSettings(): SettingsSnapshot {
    return this.#settings.snapshot();
  }

  async updateSettings(
    scope: SettingsScope,
    patch: SettingsPatch,
    expectedRevision: string,
  ): Promise<SettingsSnapshot> {
    if (!this.#workspace && scope !== "global" && scope !== "session") {
      throw new Error("普通会话只能修改全局或当前会话设置");
    }
    assertSettingsScopePatch(scope, patch);
    const before = this.#settings.snapshot();
    const snapshot = await this.#settings.update(scope, patch, expectedRevision);
    this.#tasks.setConcurrency(snapshot.effective.agent.maxConcurrentRuns);
    if (requiresRuntimeReload(before, snapshot)) {
      await this.#reloadRuntimeWhenIdle();
    }
    return snapshot;
  }

  async resetSettings(
    scope: SettingsScope,
    keys: string[] | undefined,
    expectedRevision: string,
  ): Promise<SettingsSnapshot> {
    if (!this.#workspace && scope !== "global" && scope !== "session") {
      throw new Error("普通会话只能修改全局或当前会话设置");
    }
    const before = this.#settings.snapshot();
    const snapshot = await this.#settings.reset(scope, keys, expectedRevision);
    this.#tasks.setConcurrency(snapshot.effective.agent.maxConcurrentRuns);
    if (requiresRuntimeReload(before, snapshot)) {
      await this.#reloadRuntimeWhenIdle();
    }
    return snapshot;
  }

  listModelProviders() {
    return this.#models.list();
  }

  async upsertModelProvider(input: ModelProviderInput): Promise<CommandResult> {
    if (this.#runtime?.snapshot().streaming || this.#tasks.activeRunCount > 0) {
      return { ok: false, error: "模型运行期间不能修改 Provider" };
    }
    try {
      await this.#models.upsert(input);
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async removeModelProvider(id: string): Promise<CommandResult> {
    if (this.#runtime?.snapshot().streaming) {
      return { ok: false, error: "模型运行期间不能删除 Provider" };
    }
    try {
      await this.#models.remove(id);
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async testModelProvider(input: ModelProviderInput): Promise<CommandResult> {
    try {
      const result = await this.#models.test(input);
      return { ok: true, error: `连接成功，端点返回 ${result.modelCount} 个模型` };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async fetchModelProviderModels(input: ModelProviderInput) {
    try {
      const models = await this.#models.fetchModels(input);
      return { ok: true, models };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async respondToApproval(
    requestId: string,
    decision: "allow_once" | "allow_session" | "allow_project" | "deny",
  ): Promise<CommandResult> {
    return await this.#runtime?.respondToApproval(requestId, decision)
      ? { ok: true }
      : { ok: false, error: "审批请求已失效或不存在" };
  }

  async respondToTaskInput(requestId: string, value: string): Promise<CommandResult> {
    return await this.#runtime?.respondToTaskInput(requestId, value)
      ? { ok: true }
      : { ok: false, error: "用户输入请求已失效或不存在" };
  }

  async revokeTrust(): Promise<CommandResult> {
    if (!this.#workspace) return { ok: true };
    try {
      await revokeWorkspaceTrust(this.#paths.configFile, this.#workspace);
      await this.#runtime?.dispose();
      this.#runtime = undefined;
      this.#trusted = false;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async openDataDirectory(): Promise<CommandResult> {
    const error = await shell.openPath(this.#paths.root);
    return error ? { ok: false, error } : { ok: true };
  }

  async openThirdPartyLicenses(): Promise<CommandResult> {
    const file = app.isPackaged
      ? join(process.resourcesPath, "THIRD_PARTY_LICENSES.md")
      : join(app.getAppPath(), "resources", "THIRD_PARTY_LICENSES.md");
    const error = await shell.openPath(file);
    return error ? { ok: false, error } : { ok: true };
  }

  async exportDiagnostics(owner?: BrowserWindow): Promise<CommandResult> {
    const selection = owner
      ? await dialog.showSaveDialog(owner, {
          title: "导出脱敏诊断包",
          defaultPath: `deki-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        })
      : await dialog.showSaveDialog({
          title: "导出脱敏诊断包",
          defaultPath: `deki-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        });
    if (selection.canceled || !selection.filePath) return { ok: true };
    const payload = {
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      workspaceMode: this.#workspace ? "project" : "general",
      trusted: this.#trusted,
      settings: redactSettingsForExport(this.#settings.snapshot()),
      providers: await this.#models.list(),
      runtime: this.getState(),
      recentAudit: (await this.listAuditRecords()).slice(0, 20).map((record) => ({
        id: record.id,
        timestamp: record.timestamp,
        category: record.category,
        policy: record.policy,
        decision: record.decision,
        status: record.status,
      })),
    };
    await writeFile(selection.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true };
  }

  async exportData(owner?: BrowserWindow): Promise<CommandResult> {
    const selection = owner
      ? await dialog.showSaveDialog(owner, {
          title: "导出 Deki 数据",
          defaultPath: `deki-export-${new Date().toISOString().slice(0, 10)}.json`,
        })
      : await dialog.showSaveDialog({
          title: "导出 Deki 数据",
          defaultPath: `deki-export-${new Date().toISOString().slice(0, 10)}.json`,
        });
    if (selection.canceled || !selection.filePath) return { ok: true };
    const snapshot = this.#settings.snapshot();
    const payload = {
      format: "deki-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      globalSettings: snapshot.global,
      memories: this.listMemories().map((memory) => ({
        content: memory.content,
        type: memory.type,
        pinned: memory.pinned,
        status: memory.status,
      })),
      providers: await this.#models.list(),
      excluded: ["apiKeys", "projectSource", "auditDiffs", "machinePaths"],
    };
    await writeFile(selection.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true };
  }

  async importData(owner?: BrowserWindow): Promise<CommandResult> {
    const selection = owner
      ? await dialog.showOpenDialog(owner, {
          title: "导入 Deki 数据",
          filters: [{ name: "Deki JSON", extensions: ["json"] }],
          properties: ["openFile"],
        })
      : await dialog.showOpenDialog({
          title: "导入 Deki 数据",
          filters: [{ name: "Deki JSON", extensions: ["json"] }],
          properties: ["openFile"],
        });
    const file = selection.filePaths[0];
    if (selection.canceled || !file) return { ok: true };
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isRecord(raw) || raw.format !== "deki-export" || raw.version !== 1) {
        throw new Error("不是支持的 Deki 导出文件");
      }
      const globalSettings = settingsPatchSchema.parse(raw.globalSettings ?? {});
      const memories = Array.isArray(raw.memories) ? raw.memories : [];
      const providers = redactedModelProviderSchema.array().parse(
        Array.isArray(raw.providers) ? raw.providers : [],
      );
      const confirmation = owner
        ? await dialog.showMessageBox(owner, {
            type: "question",
            title: "确认导入",
            message: "导入全局设置、Provider 元数据和记忆？",
            detail: `设置分类 ${Object.keys(globalSettings).length} 个，Provider ${providers.length} 个，记忆 ${memories.length} 条。可选择合并或替换当前作用域；API Key 不会导入。`,
            buttons: ["取消", "合并", "替换当前作用域"],
            defaultId: 0,
            cancelId: 0,
          })
        : { response: 1 };
      if (confirmation.response === 0) return { ok: true };
      let snapshot = this.#settings.snapshot();
      if (confirmation.response === 2) {
        snapshot = await this.#settings.reset("global", undefined, snapshot.revision);
      }
      await this.#settings.update("global", globalSettings, snapshot.revision);
      const scope = this.#projectFeatures ? "project" : "user";
      const scopeId = this.#projectFeatures ? this.#scopeId : "user";
      if (confirmation.response === 2) this.#memory.clearScope(scope, scopeId);
      const existing = new Set(this.#memory.listMemories(scope, scopeId, { limit: 10_000 })
        .map((memory) => memory.content));
      for (const candidate of memories) {
        if (!isRecord(candidate) || typeof candidate.content !== "string") continue;
        if (existing.has(candidate.content.trim())) continue;
        try {
          this.#memory.createMemory({
            scope,
            scopeId,
            content: candidate.content,
            source: { kind: "migration", detail: "Deki 数据导入" },
            type: isMemoryType(candidate.type) ? candidate.type : "fact",
            status: candidate.status === "pending" ? "pending" : "active",
          });
        } catch {
          // Invalid or sensitive entries are skipped; no secret is forced into memory.
        }
      }
      for (const provider of providers) {
        await this.#models.upsert({
          id: provider.id,
          ...(provider.name ? { name: provider.name } : {}),
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.api ? { api: provider.api } : {}),
          apiKey: { action: "keep" },
          ...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
          ...(provider.headers ? { headers: provider.headers } : {}),
          models: provider.models,
        });
      }
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  listMemories(requestedScope?: MemoryScope, query?: string) {
    const { scope, scopeId } = this.#resolveMemoryScope(requestedScope);
    return [
      ...this.#memory.listMemories(scope, scopeId, { ...(query ? { query } : {}) }),
      ...this.#memory.listMemories(scope, scopeId, {
        status: "pending",
        ...(query ? { query } : {}),
      }),
    ];
  }

  async listMcpServers(): Promise<McpServerEditor[]> {
    if (!this.#workspace || !this.#trusted) return [];
    const config = await readMcpConfig(this.#workspace);
    const local = await readMcpLocalConfig(this.#mcpLocalFile());
    const statuses = new Map(this.#mcp.getStatuses().map((status) => [status.id, status]));
    return Object.entries(config.mcpServers).map(([id, server]) => {
      const status = statuses.get(id);
      return {
        id,
        command: server.command,
        args: server.args,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        enabled: server.enabled,
        tools: server.tools,
        ...(local.servers[id]?.environment
          ? {
              environment: Object.fromEntries(
                Object.keys(local.servers[id].environment).map((key) => [key, "[REDACTED]"]),
              ),
            }
          : {}),
        state: status?.state ?? "stopped",
        toolCount: status?.toolCount ?? 0,
        ...(status?.error ? { error: status.error } : {}),
        ...(status?.lastCheckedAt ? { lastCheckedAt: status.lastCheckedAt } : {}),
        ...(status?.reconnectAttempt === undefined
          ? {}
          : { reconnectAttempt: status.reconnectAttempt }),
      };
    });
  }

  async upsertMcpServer(server: McpServerEditor): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted) {
      return { ok: false, error: "MCP 只在受信任项目中可用" };
    }
    if (server.cwd && (isAbsolute(server.cwd) || normalize(server.cwd).startsWith(".."))) {
      return { ok: false, error: "MCP cwd 必须是项目内的相对路径" };
    }
    try {
      const config = await readMcpConfig(this.#workspace);
      const previous = config.mcpServers[server.id];
      const local = await readMcpLocalConfig(this.#mcpLocalFile());
      const previousEnvironment = local.servers[server.id]?.environment ?? {};
      const environment = Object.fromEntries(Object.entries(server.environment ?? {})
        .flatMap(([key, value]) => {
          const resolvedValue = value === "[REDACTED]" ? previousEnvironment[key] ?? "" : value;
          return key.trim() && resolvedValue ? [[key, resolvedValue] as const] : [];
        }));
      if (Object.keys(environment).length > 0) {
        local.servers[server.id] = { environment };
      } else {
        delete local.servers[server.id];
      }
      config.mcpServers[server.id] = {
        command: server.command,
        args: server.args,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        enabled: server.enabled,
        tools: server.tools,
      };
      await writeMcpConfig(this.#workspace, config);
      await writeMcpLocalConfig(this.#mcpLocalFile(), local);
      if (server.enabled) {
        const definitionsChanged = await this.#runtime?.startMcpServer(server.id);
        if (definitionsChanged) await this.#reloadRuntimeWhenIdle();
      } else if (previous?.enabled) {
        await this.#runtime?.stopMcpServer(server.id);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async removeMcpServer(id: string): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted) {
      return { ok: false, error: "MCP 只在受信任项目中可用" };
    }
    try {
      const config = await readMcpConfig(this.#workspace);
      delete config.mcpServers[id];
      await writeMcpConfig(this.#workspace, config);
      const local = await readMcpLocalConfig(this.#mcpLocalFile());
      delete local.servers[id];
      await writeMcpLocalConfig(this.#mcpLocalFile(), local);
      await this.#runtime?.stopMcpServer(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async reloadMcpServers(): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted) {
      return { ok: false, error: "MCP 只在受信任项目中可用" };
    }
    try {
      const definitionsChanged = await this.#runtime?.reloadMcpServers();
      if (definitionsChanged) await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async startMcpServer(id: string): Promise<CommandResult> {
    return this.#setMcpServerEnabled(id, true);
  }

  async stopMcpServer(id: string): Promise<CommandResult> {
    return this.#setMcpServerEnabled(id, false);
  }

  async restartMcpServer(id: string): Promise<CommandResult> {
    return this.#setMcpServerEnabled(id, true);
  }

  async testMcpServer(id: string): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted) return { ok: false, error: "MCP 只在受信任项目中可用" };
    const server = (await loadMcpConfig(this.#workspace)).mcpServers[id];
    if (!server) return { ok: false, error: "未找到 MCP Server" };
    const environment = (await readMcpLocalConfig(this.#mcpLocalFile()))
      .servers[id]?.environment;
    const result = await this.#mcp.testServer(
      `probe-${id}`,
      { ...server, ...(environment ? { environment } : {}) },
      this.#settings.snapshot().effective.mcp.startupTimeoutMs,
    );
    return result.state === "ready"
      ? { ok: true, error: `连接成功，发现 ${result.toolCount} 个 Tool` }
      : { ok: false, error: result.error ?? "连接失败" };
  }

  async #setMcpServerEnabled(id: string, enabled: boolean): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted) {
      return { ok: false, error: "MCP 只在受信任项目中可用" };
    }
    try {
      const config = await readMcpConfig(this.#workspace);
      const server = config.mcpServers[id];
      if (!server) return { ok: false, error: "未找到 MCP Server" };
      server.enabled = enabled;
      await writeMcpConfig(this.#workspace, config);
      if (enabled) {
        const definitionsChanged = await this.#runtime?.startMcpServer(id);
        if (definitionsChanged) await this.#reloadRuntimeWhenIdle();
      } else {
        await this.#runtime?.stopMcpServer(id);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async listMcpServerTools(id: string) {
    return (await this.#mcp.listServerTools(id)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.readOnlyHint === undefined ? {} : { readOnlyHint: tool.readOnlyHint }),
      enabled: tool.enabled !== false,
      ...(tool.permission ? { permission: tool.permission } : {}),
      ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
    }));
  }

  async listSkills() {
    const settings = this.#settings.snapshot().effective.skills;
    const roots = [
      ...(this.#workspace && this.#trusted
        ? [
            { path: join(this.#workspace, ".deki", "skills"), source: "project" as const },
            { path: join(this.#workspace, ".agents", "skills"), source: "project" as const },
            { path: join(this.#workspace, ".pi", "skills"), source: "project" as const },
          ]
        : []),
      { path: join(homedir(), ".pi", "agent", "skills"), source: "global" as const },
      { path: join(homedir(), ".agents", "skills"), source: "global" as const },
      { path: join(homedir(), ".codex", "skills"), source: "global" as const },
      ...settings.globalPaths.map((path) => ({ path, source: "global" as const })),
    ];
    const skills: Array<{
      name: string;
      path: string;
      source: "project" | "global";
      enabled: boolean;
      valid: boolean;
      trusted: boolean;
      diagnostics: string[];
      version?: string;
      pinnedVersion?: string;
      sourceUrl?: string;
    }> = [];
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = join(root.path, entry.name, "SKILL.md");
        const diagnostics: string[] = [];
        let name = entry.name;
        let metadata: {
          version?: string;
          pinnedVersion?: string;
          sourceUrl?: string;
        } = {};
        try {
          const content = await readFile(skillFile, "utf8");
          const declared = /^---[\s\S]*?^name:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
          const description = /^---[\s\S]*?^description:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
          const version = /^---[\s\S]*?^version:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
          const pinnedVersion = /^---[\s\S]*?^pinned-version:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
          const sourceUrl = /^---[\s\S]*?^source:\s*(https:\/\/\S+)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
          metadata = {
            ...(version ? { version: version.trim() } : {}),
            ...(pinnedVersion ? { pinnedVersion: pinnedVersion.trim() } : {}),
            ...(sourceUrl ? { sourceUrl: sourceUrl.trim() } : {}),
          };
          if (declared) name = declared.trim();
          else diagnostics.push("缺少 frontmatter name");
          if (!description) diagnostics.push("缺少 frontmatter description");
          diagnostics.push(...await validateSkillDependencies(
            content,
            resolve(skillFile, ".."),
            this.#workspace,
          ));
        } catch {
          diagnostics.push("缺少或无法读取 SKILL.md");
        }
        skills.push({
          name,
          path: skillFile,
          source: root.source,
          enabled: settings.enabled && !settings.disabledNames.includes(name),
          valid: diagnostics.length === 0,
          trusted: root.source === "project" ? this.#trusted : true,
          diagnostics,
          ...metadata,
        });
      }
    }
    const counts = new Map<string, number>();
    for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
    return skills.map((skill) => counts.get(skill.name)! > 1
      ? { ...skill, valid: false, diagnostics: [...skill.diagnostics, "Skill 名称冲突"] }
      : skill);
  }

  async reloadSkills(): Promise<CommandResult> {
    try {
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async updateSkill(path: string): Promise<CommandResult> {
    const skill = (await this.listSkills()).find((candidate) => candidate.path === path);
    if (!skill) return { ok: false, error: "未找到 Skill" };
    if (!skill.valid) return { ok: false, error: "Skill 校验未通过，不能更新" };
    if (skill.pinnedVersion) {
      return { ok: false, error: `Skill 已锁定在 ${skill.pinnedVersion}，请先解除版本锁定` };
    }
    if (!skill.sourceUrl) {
      return { ok: false, error: "Skill 未声明可更新的 frontmatter source URL" };
    }
    try {
      const response = await net.fetch(skill.sourceUrl);
      if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`);
      const content = await response.text();
      if (content.length > 1_000_000) throw new Error("Skill 更新内容超过 1 MB 限制");
      const declared = /^---[\s\S]*?^name:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1]?.trim();
      if (!declared || declared !== skill.name) {
        throw new Error("更新源的 Skill 名称与本地版本不一致");
      }
      const temporary = `${skill.path}.update-${crypto.randomUUID()}`;
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, skill.path);
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async pinSkillVersion(path: string, version?: string): Promise<CommandResult> {
    const skill = (await this.listSkills()).find((candidate) => candidate.path === path);
    if (!skill) return { ok: false, error: "未找到 Skill" };
    const pinned = version?.trim();
    if (pinned && skill.version && pinned !== skill.version) {
      return { ok: false, error: `只能锁定当前已安装版本 ${skill.version}` };
    }
    try {
      const content = await readFile(skill.path, "utf8");
      const next = setSkillFrontmatterValue(content, "pinned-version", pinned);
      await writeFile(skill.path, next, { encoding: "utf8", mode: 0o600 });
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async updateMemory(input: {
    id: string;
    scope?: MemoryScope;
    content?: string;
    pinned?: boolean;
    status?: "active" | "pending" | "superseded" | "archived";
  }) {
    const { scope, scopeId } = this.#resolveMemoryScope(input.scope);
    return this.#memory.updateMemory(scope, scopeId, input.id, {
      ...(input.content ? { content: input.content } : {}),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  deleteMemory(id: string, requestedScope?: MemoryScope): CommandResult {
    const { scope, scopeId } = this.#resolveMemoryScope(requestedScope);
    return this.#memory.deleteMemory(scope, scopeId, id)
      ? { ok: true }
      : { ok: false, error: "未找到记忆" };
  }

  clearMemoryScope(requestedScope: MemoryScope): CommandResult {
    const { scope, scopeId } = this.#resolveMemoryScope(requestedScope);
    const count = this.#memory.clearScope(scope, scopeId);
    return { ok: true, error: `已清理 ${count} 条记忆` };
  }

  moveMemory(
    id: string,
    from: MemoryScope,
    to: MemoryScope,
  ) {
    const source = this.#resolveMemoryScope(from);
    const target = this.#resolveMemoryScope(to);
    return this.#memory.moveMemory(
      source.scope,
      source.scopeId,
      id,
      target.scope,
      target.scopeId,
    );
  }

  async getDataUsage() {
    const [sessionsBytes, memoryBytes, tasksBytes, logsBytes, configBytes] = await Promise.all([
      directorySize(this.#paths.sessionsRoot),
      directorySize(resolve(this.#paths.memoryDatabase, "..")),
      directorySize(resolve(this.#paths.tasksDatabase, "..")),
      directorySize(this.#paths.logsRoot),
      Promise.all([
        fileSize(this.#paths.configFile),
        fileSize(this.#paths.settingsFile),
        fileSize(this.#paths.modelsFile),
        directorySize(this.#paths.projectsRoot),
      ]).then((values) => values.reduce((sum, value) => sum + value, 0)),
    ]);
    return {
      totalBytes: sessionsBytes + memoryBytes + tasksBytes + logsBytes + configBytes,
      sessionsBytes,
      memoryBytes,
      tasksBytes,
      logsBytes,
      configBytes,
    };
  }

  async listAuditRecords() {
    let files;
    try {
      files = (await readdir(this.#paths.logsRoot))
        .filter((file) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file))
        .sort()
        .reverse()
        .slice(0, 7);
    } catch {
      return [];
    }
    const records = [];
    for (const file of files) {
      try {
        for (const line of (await readFile(join(this.#paths.logsRoot, file), "utf8"))
          .split("\n").filter(Boolean).reverse()) {
          const raw: unknown = JSON.parse(line);
          if (!isRecord(raw) || !isRecord(raw.execution)) continue;
          records.push(auditRecordSummarySchema.parse({
            id: String(raw.id ?? ""),
            timestamp: String(raw.timestamp ?? ""),
            category: String(raw.category ?? ""),
            policy: String(raw.policy ?? ""),
            decision: String(raw.decision ?? ""),
            status: String(raw.execution.status ?? ""),
            ...(raw.details === undefined ? {} : { details: raw.details }),
            ...(typeof raw.diff === "string" ? { diff: raw.diff } : {}),
          }));
          if (records.length >= 100) return records;
        }
      } catch {
        // A malformed historical line is skipped without hiding valid audit records.
      }
    }
    return records;
  }

  async listGitCheckpoints() {
    if (!this.#workspace || !this.#trusted || !this.#checkpoints) return [];
    return this.#checkpoints.list();
  }

  async createGitCheckpoint(message?: string): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted || !this.#checkpoints) {
      return { ok: false, error: "Git Checkpoint 只在受信任的 Git 项目中可用" };
    }
    if (this.#runtime?.snapshot().streaming) {
      return { ok: false, error: "Agent 正在运行，暂时不能创建 Checkpoint" };
    }
    try {
      const checkpoint = await this.#checkpoints.create(message);
      this.#diagnostics.push(`已创建 Git Checkpoint: ${checkpoint.id}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async previewGitCheckpoint(id: string): Promise<string> {
    if (!this.#workspace || !this.#trusted || !this.#checkpoints) {
      throw new Error("Git Checkpoint 只在受信任的 Git 项目中可用");
    }
    return this.#checkpoints.diff(id);
  }

  async restoreGitCheckpoint(id: string): Promise<CommandResult> {
    if (!this.#workspace || !this.#trusted || !this.#checkpoints) {
      return { ok: false, error: "Git Checkpoint 只在受信任的 Git 项目中可用" };
    }
    if (this.#runtime?.snapshot().streaming) {
      return { ok: false, error: "Agent 正在运行，暂时不能恢复 Checkpoint" };
    }
    try {
      const result = await this.#checkpoints.restore(id);
      this.#diagnostics.push(
        `已恢复 ${result.restored.id}；恢复前状态保存在 ${result.safetyCheckpoint.id}`,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async dispose(): Promise<void> {
    await this.#runtime?.dispose();
    this.#runtime = undefined;
    this.#memory.close();
  }

  async #reloadRuntimeWhenIdle(): Promise<void> {
    if (!this.#trusted) return;
    if (this.#runtime?.snapshot().streaming) {
      this.#diagnostics.push("设置已保存，将在当前运行结束后重建 Runtime");
      this.#reloadPending = true;
      return;
    }
    this.#reloadPending = true;
    try {
      await this.#runtime?.dispose();
      this.#runtime = undefined;
      await this.#startRuntime();
    } finally {
      this.#reloadPending = false;
      this.#tasks.start();
    }
  }

  async #startRuntime(): Promise<void> {
    if (this.#runtime) return;
    if (this.#starting) return this.#starting;

    this.#starting = (async () => {
      const runtime = new DekiAgentRuntime({
        workspace: this.#runtimeWorkspace,
        scopeId: this.#scopeId,
        projectFeatures: this.#projectFeatures,
        paths: this.#paths,
        memoryEngine: this.#memory,
        mcpManager: this.#mcp,
        settings: this.#settings.snapshot().effective,
        resumeLatest: this.#resumeLatest,
        mcpEnvironment: this.#workspace
          ? Object.fromEntries(Object.entries(
              (await readMcpLocalConfig(this.#mcpLocalFile())).servers,
            ).map(([id, value]) => [id, value.environment]))
          : {},
        persistProjectGrant: async (category, grantKey) =>
          this.#persistProjectGrant(category, grantKey),
        acquireResumeLease: (taskId, requestId) =>
          this.#tasks.acquireResumeLease(taskId, requestId),
        planTools: {
          submit: async (input, context) => {
            if (
              context.interactionMode !== "plan"
              || !context.taskId
              || !context.runId
            ) {
              throw new Error("plan.submit 只能在 Planning Task 中调用");
            }
            const task = taskStore?.getTask(context.taskId);
            const sessionId = task?.sessionId ?? context.sessionId;
            if (!task || task.kind !== "planning" || !sessionId) {
              throw new Error("未找到当前 Planning Task");
            }
            if (task.planId) {
              throw new Error("修订已有计划时必须调用 plan.revise");
            }
            return taskStore!.createPlan({
              workspaceId: task.workspaceId,
              ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}),
              sessionId,
              planningTaskId: task.id,
              goal: input.goal,
              assumptions: input.assumptions,
              constraints: input.constraints,
              steps: input.steps,
            });
          },
          revise: async (input, context) => {
            if (context.interactionMode !== "plan" || !context.taskId) {
              throw new Error("plan.revise 只能在 Planning Task 中调用");
            }
            const detail = taskStore?.getPlan(input.planId);
            if (!detail || detail.plan.currentRevision !== input.basedOnRevision) {
              throw new Error("计划版本已经变化，请基于最新版本重新修订");
            }
            return taskStore!.revisePlan(input.planId, {
              planningTaskId: context.taskId,
              ...(input.feedback ? { feedback: input.feedback } : {}),
              assumptions: input.assumptions,
              constraints: input.constraints,
              steps: input.steps,
            });
          },
          updateStep: async (input, context) => {
            if (
              context.interactionMode !== "plan-execution"
              || context.planId !== input.planId
            ) {
              throw new Error("plan.update_step 只能更新当前执行计划");
            }
            return taskStore!.updatePlanStep(input.planId, {
              revision: input.revision,
              stepId: input.stepId,
              status: input.status,
              ...(input.summary ? { summary: input.summary } : {}),
              ...(input.evidence ? { evidence: input.evidence } : {}),
              ...(input.reason ? { reason: input.reason } : {}),
              ...(context.taskId ? { taskId: context.taskId } : {}),
              ...(context.runId ? { runId: context.runId } : {}),
            });
          },
          requestReplan: async (input, context) => {
            if (
              context.interactionMode !== "plan-execution"
              || context.planId !== input.planId
              || !context.taskId
            ) {
              throw new Error("plan.request_replan 只能由当前计划执行任务调用");
            }
            const request = this.#tasks.requestReplan(context.taskId, {
              planId: input.planId,
              reason: input.reason,
              affectedStepIds: input.affectedStepIds,
              ...(input.evidence ? { evidence: input.evidence } : {}),
              deliveryMode: "background",
            });
            return { accepted: Boolean(request), reason: input.reason };
          },
        },
        workerTools: {
          delegate: async (requests, context) => {
            if (
              context.interactionMode === "worker"
              || !context.taskId
              || !context.runId
              || !context.sessionId
            ) {
              throw new Error("只有主 Agent 可以派发 Worker");
            }
            const parsed = workerRequestSchema.array().min(1).max(2).parse(requests);
            if (parsed.some((request) => request.profile === "implementer")) {
              if (parsed.some((request) => request.profile !== "implementer")) {
                throw new Error("同一批次不能混合 Implementer 与只读 Worker");
              }
              return this.#delegateImplementers(
                parsed as Extract<WorkerRequest, { profile: "implementer" }>[],
                context,
              );
            }
            const settings = this.#settings.snapshot().effective.agent;
            return this.#tasks.delegateWorkers({
              parentTaskId: context.taskId,
              parentRunId: context.runId,
              toolCallId: context.callId,
              requests: parsed,
              sourceSessionId: context.sessionId,
              deliveryMode: taskStore?.getDeliveryMode(context.taskId) ?? "background",
              budget: {
                maxWorkers: settings.workerMaxPerRoot,
                maxDurationMs: settings.workerTimeoutMs,
                maxInputTokens: settings.workerMaxInputTokens,
                maxOutputTokens: settings.workerMaxOutputTokens,
                maxToolCalls: settings.workerMaxToolCalls,
              },
            });
          },
          submitResult: async (result, context) => {
            if (
              context.interactionMode !== "worker"
              || !context.taskId
              || !context.runId
            ) {
              throw new Error("worker.submit_result 只能由 Worker 调用");
            }
            return this.#tasks.saveWorkerResult(
              context.taskId,
              context.runId,
              workerResultSchema.parse(result),
            );
          },
          runTest: async (target, context) => {
            if (
              context.interactionMode !== "worker"
              || context.workerProfile !== "tester"
              || !context.taskId
              || !context.runId
            ) {
              throw new Error("只有当前 Tester Worker 可以运行受控测试");
            }
            const result = await runWorkerTestInSnapshot(
              this.#runtimeWorkspace,
              target,
              this.#settings.snapshot().effective.agent.workerTimeoutMs,
              (testResult) => taskStore!.createArtifact({
                taskId: context.taskId!,
                runId: context.runId!,
                kind: "test-result",
                title: `Tester: ${target}`,
                content: testResult.output,
                metadata: {
                  target,
                  exitCode: testResult.exitCode,
                  durationMs: testResult.durationMs,
                  timedOut: testResult.timedOut,
                  isolatedCopy: true,
                },
              }).id,
            );
            return {
              target,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
              artifactId: result.artifactId,
            };
          },
        },
        onEvent: (event) => {
          this.#tasks.handleAgentEvent(event);
          broadcastEvent(event);
          if (event.type === "diagnostic") {
            void writeDiagnosticLog(
              this.#paths.logsRoot,
              this.#settings.snapshot().effective.advanced.logLevel,
              event,
            );
          }
          if (
            this.#reloadPending
            && (event.type === "run.completed" || event.type === "run.failed")
          ) {
            setImmediate(() => {
              void this.#reloadRuntimeWhenIdle();
            });
          }
        },
      });
      try {
        await runtime.initialize();
        this.#runtime = runtime;
        if (runtime.snapshot().ready) this.#tasks.start();
      } catch (error) {
        await runtime.dispose();
        const message = `Runtime 初始化失败: ${formatError(error)}`;
        this.#diagnostics.push(message);
        broadcastEvent(createDiagnosticEvent(message));
      }
    })();

    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #delegateImplementers(
    requests: Extract<WorkerRequest, { profile: "implementer" }>[],
    context: import("@deki-ai/shared").ToolCallContext,
  ) {
    if (
      !this.#workspace
      || !context.taskId
      || !context.runId
      || !context.sessionId
    ) throw new Error("Implementer 只能从受信任 Git 项目任务派发");
    const runner = new WorktreeRunner(this.#workspace, {
      worktreesRoot: join(this.#paths.worktreesRoot, this.#scopeId),
      timeoutMs: 600_000,
    });
    const repository = await runner.inspectRepository();
    const releaseRepository = await acquireRepositoryWriteLock(
      repository.commonDirectory,
    );
    const normalized = requests.map((request, index) => ({
      request: {
        ...request,
        writeSet: validateWriteSet(request.writeSet),
      },
      index,
    }));
    const predictedOverlaps: string[] = [];
    for (let left = 0; left < normalized.length; left += 1) {
      for (let right = left + 1; right < normalized.length; right += 1) {
        predictedOverlaps.push(...writeSetsOverlap(
          normalized[left]!.request.writeSet,
          normalized[right]!.request.writeSet,
        ));
      }
    }
    const waves = scheduleWriteWaves(normalized.map((entry) => ({
      ...entry,
      writeSet: entry.request.writeSet,
    })));
    let baseline;
    let integrationResource: WorktreeResource;
    try {
      baseline = await runner.createBaseline(
        `Deki write batch ${context.taskId}`,
      );
      integrationResource = await runner.createWorktree({
        rootTaskId: taskStore!.getTask(context.taskId)!.rootTaskId,
        resourceId: randomUUID(),
        kind: "integration",
        baseCommit: baseline.commit,
        repository: baseline.repository,
      });
    } catch (error) {
      releaseRepository();
      throw error;
    }
    taskStore!.saveRunnerResource({
      id: integrationResource.id,
      rootTaskId: taskStore!.getTask(context.taskId)!.rootTaskId,
      taskId: context.taskId,
      runId: context.runId,
      kind: "integration",
      path: integrationResource.path,
      branchRef: integrationResource.branchRef,
      baseCommit: integrationResource.baseCommit,
      status: "active",
    });
    const integration = taskStore!.createIntegration({
      rootTaskId: taskStore!.getTask(context.taskId)!.rootTaskId,
      taskId: context.taskId,
      baselineCommit: baseline.commit,
      predictedOverlaps: [...new Set(predictedOverlaps)],
      workerTaskIds: [],
    });
    const settings = this.#settings.snapshot().effective.agent;
    const allResults: import("@deki-ai/shared").WorkerResultEnvelope[] = [];
    const workerTaskIds: string[] = [];
    const actualFileOwners = new Map<string, string>();
    const actualOverlaps = new Set<string>();
    let currentBase = baseline.commit;
    let cleaned = false;
    try {
      taskStore!.updateIntegration(integration.id, { status: "merging" });
      for (const [waveIndex, wave] of waves.entries()) {
        const waveRequests = wave.map((entry) => entry.request);
        const worktreeContexts = wave.map((entry) => ({
          baselineCommit: baseline.commit,
          baseCommit: currentBase,
          baselineRef: baseline.ref,
          repositoryRoot: baseline.repository.repositoryRoot,
          commonDirectory: baseline.repository.commonDirectory,
          workspaceRelativePath: baseline.repository.workspaceRelativePath,
          writeSet: entry.request.writeSet,
          validationTargets: entry.request.validationTargets,
          wave: waveIndex,
        }));
        const results = await this.#tasks.delegateWorkers({
          parentTaskId: context.taskId,
          parentRunId: context.runId,
          toolCallId: `${context.callId}-wave-${waveIndex}`,
          requests: waveRequests,
          worktreeContexts,
          sourceSessionId: context.sessionId,
          deliveryMode: taskStore?.getDeliveryMode(context.taskId) ?? "background",
          budget: {
            maxWorkers: settings.workerMaxPerRoot,
            maxDurationMs: settings.workerTimeoutMs,
            maxInputTokens: settings.workerMaxInputTokens,
            maxOutputTokens: settings.workerMaxOutputTokens,
            maxToolCalls: settings.workerMaxToolCalls,
          },
        });
        allResults.push(...results);
        for (const result of results) {
          workerTaskIds.push(result.task.id);
          if (result.status !== "succeeded") {
            throw new Error(`Implementer 未成功：${result.task.title}`);
          }
          const implementation = taskStore!.getImplementationResult(result.task.id);
          if (!implementation?.commit || implementation.scopeViolation) {
            throw new Error(`Implementer 缺少可集成提交：${result.task.title}`);
          }
          for (const path of implementation.changedFiles) {
            const owner = actualFileOwners.get(path);
            if (owner && owner !== result.task.id) actualOverlaps.add(path);
            actualFileOwners.set(path, result.task.id);
          }
          const picked = await runner.cherryPick(
            integrationResource,
            implementation.commit,
          );
          if (!picked.ok) {
            const conflictText = [
              "Integration cherry-pick conflict",
              ...picked.conflictFiles.map((path) =>
                `${picked.conflictKinds[path] ?? "UU"} ${path}`),
            ].join("\n");
            const artifact = taskStore!.createArtifact({
              taskId: context.taskId,
              runId: context.runId,
              kind: "evidence",
              title: "Integration Conflict",
              content: conflictText,
              metadata: {
                conflictFiles: picked.conflictFiles,
                conflictKinds: picked.conflictKinds,
                automaticResolution: false,
              },
            });
            taskStore!.updateIntegration(integration.id, {
              status: "conflicted",
              conflictFiles: picked.conflictFiles,
              actualOverlaps: [...actualOverlaps],
              workerTaskIds,
              diffArtifactId: artifact.id,
            });
            throw new Error(
              `集成冲突需要用户决定，未静默覆盖：${picked.conflictFiles.join(", ")}`,
            );
          }
        }
        currentBase = (await runner.integrationPatch(
          integrationResource,
          baseline.commit,
        )).commit;
      }

      taskStore!.updateIntegration(integration.id, {
        status: "testing",
        actualOverlaps: [...actualOverlaps],
        workerTaskIds,
      });
      const validationTargets = requests.flatMap((request) => request.validationTargets);
      const validationResults = await runner.validateIntegration(
        integrationResource,
        validationTargets,
      );
      const artifactStore = new ArtifactStore(this.#paths.artifactsRoot);
      const validationArtifactIds: string[] = [];
      for (const validation of validationResults) {
        const id = randomUUID();
        const file = await artifactStore.write(
          this.#scopeId,
          taskStore!.getTask(context.taskId)!.rootTaskId,
          id,
          "log",
          validation.output,
        );
        taskStore!.createArtifact({
          id,
          taskId: context.taskId,
          runId: context.runId,
          kind: "test-result",
          title: `Integration ${validation.target.cwd ?? "."}: ${validation.target.script}`,
          uri: file.uri,
          metadata: {
            sha256: file.sha256,
            size: file.size,
            target: validation.target,
            exitCode: validation.exitCode,
            durationMs: validation.durationMs,
            timedOut: validation.timedOut,
          },
        });
        validationArtifactIds.push(id);
      }
      if (validationResults.some((result) => result.exitCode !== 0)) {
        taskStore!.updateIntegration(integration.id, {
          status: "failed",
          validationArtifactIds,
          workerTaskIds,
        });
        throw new Error("集成验证失败，结果未应用到用户工作区");
      }
      const finalized = await runner.integrationPatch(
        integrationResource,
        baseline.commit,
      );
      const patchId = randomUUID();
      const patchFile = await artifactStore.write(
        this.#scopeId,
        taskStore!.getTask(context.taskId)!.rootTaskId,
        patchId,
        "patch",
        finalized.patch,
      );
      taskStore!.createArtifact({
        id: patchId,
        taskId: context.taskId,
        runId: context.runId,
        kind: "patch",
        title: "Final Integration Patch",
        uri: patchFile.uri,
        metadata: {
          sha256: patchFile.sha256,
          size: patchFile.size,
          baselineCommit: baseline.commit,
          integrationCommit: finalized.commit,
          changedFiles: finalized.changedFiles,
        },
      });
      const diffId = randomUUID();
      const diffFile = await artifactStore.write(
        this.#scopeId,
        taskStore!.getTask(context.taskId)!.rootTaskId,
        diffId,
        "diff",
        finalized.patch,
      );
      taskStore!.createArtifact({
        id: diffId,
        taskId: context.taskId,
        runId: context.runId,
        kind: "diff",
        title: "Final Integration Diff",
        uri: diffFile.uri,
        metadata: {
          sha256: diffFile.sha256,
          size: diffFile.size,
          complete: true,
        },
      });
      const integrationCommitArtifactId = randomUUID();
      const integrationRef = await runner.createArtifactRef(
        integrationCommitArtifactId,
        finalized.commit,
      );
      taskStore!.createArtifact({
        id: integrationCommitArtifactId,
        taskId: context.taskId,
        runId: context.runId,
        kind: "commit",
        title: `Integration Commit ${finalized.commit.slice(0, 12)}`,
        content: finalized.commit,
        metadata: { ref: integrationRef, commit: finalized.commit },
      });
      taskStore!.updateRunnerResource(integrationResource.id, "cleanup_pending");
      await runner.cleanup(integrationResource);
      cleaned = true;
      taskStore!.updateRunnerResource(integrationResource.id, "cleaned");
      taskStore!.updateIntegration(integration.id, {
        status: "awaiting_apply",
        integrationCommit: finalized.commit,
        actualOverlaps: [...actualOverlaps],
        workerTaskIds,
        validationArtifactIds,
        patchArtifactId: patchId,
        diffArtifactId: diffId,
        cleanupStatus: "cleaned",
      });

      let requestId = randomUUID();
      for (;;) {
        const decision = await this.#tasks.awaitIntegrationDecision({
          taskId: context.taskId,
          runId: context.runId,
          requestId,
          payload: {
            integrationId: integration.id,
            patchArtifactId: patchId,
            diffArtifactId: diffId,
            validationArtifactIds,
            changedFiles: finalized.changedFiles,
            baselineCommit: baseline.commit,
            integrationCommit: finalized.commit,
          },
        });
        if (decision === "cancel") {
          taskStore!.updateIntegration(integration.id, { status: "cancelled" });
          taskStore!.finishIntegrationDecision(
            context.taskId,
            context.runId,
            decision,
            requestId,
          );
          return allResults;
        }
        if (decision === "artifact_only") {
          taskStore!.updateIntegration(integration.id, { status: "artifact_only" });
          taskStore!.resumeAfterIntegrationDecision(
            context.taskId,
            context.runId,
            decision,
            requestId,
          );
          return allResults;
        }
        try {
          await runner.applyPatch({
            baselineCommit: baseline.commit,
            integrationCommit: finalized.commit,
            patch: finalized.patch,
          });
          taskStore!.updateIntegration(integration.id, { status: "applied" });
          taskStore!.resumeAfterIntegrationDecision(
            context.taskId,
            context.runId,
            decision,
            requestId,
          );
          return allResults;
        } catch (error) {
          if (!(error instanceof WorkspaceDriftError)) throw error;
          taskStore!.resolveRequest(requestId, {
            decision,
            error: error.message,
          });
          taskStore!.createArtifact({
            taskId: context.taskId,
            runId: context.runId,
            kind: "evidence",
            title: "Application Conflict",
            content: error.message,
            metadata: { driftedFiles: error.paths },
          });
          requestId = randomUUID();
        }
      }
    } finally {
      if (!cleaned) {
        try {
          taskStore!.updateRunnerResource(integrationResource.id, "cleanup_pending");
          await runner.cleanup(integrationResource);
          taskStore!.updateRunnerResource(integrationResource.id, "cleaned");
          taskStore!.updateIntegration(integration.id, { cleanupStatus: "cleaned" });
        } catch (error) {
          taskStore!.updateRunnerResource(
            integrationResource.id,
            "cleanup_failed",
            formatError(error),
          );
          taskStore!.updateIntegration(integration.id, {
            cleanupStatus: "failed",
            cleanupError: formatError(error),
          });
        }
      }
      releaseRepository();
    }
  }

  async #run(
    operation: (runtime: DekiAgentRuntime) => Promise<void>,
  ): Promise<CommandResult> {
    if (!this.#trusted) {
      return { ok: false, error: "请先信任当前工作区" };
    }
    if (!this.#runtime) {
      return { ok: false, error: "Agent Runtime 尚未就绪" };
    }
    try {
      await operation(this.#runtime);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async #persistProjectGrant(category: PermissionCategory, grantKey?: string): Promise<void> {
    if (!this.#workspace) return;
    const snapshot = this.#settings.snapshot();
    if (grantKey?.includes(".")) {
      await this.#settings.update("projectLocal", {
        mcp: {
          toolPolicies: {
            ...snapshot.effective.mcp.toolPolicies,
            [grantKey]: "allow",
          },
        },
      }, snapshot.revision);
      return;
    }
    await this.#settings.update("projectLocal", {
      permissions: {
        policies: {
          ...snapshot.effective.permissions.policies,
          [category]: "allow",
        },
      },
    }, snapshot.revision);
  }

  #resolveMemoryScope(requested?: MemoryScope): {
    scope: MemoryScope;
    scopeId: string;
  } {
    const scope = requested ?? (this.#projectFeatures ? "project" : "user");
    if (scope === "project") {
      if (!this.#projectFeatures) throw new Error("普通会话没有项目记忆作用域");
      return { scope, scopeId: this.#scopeId };
    }
    if (scope === "workspace") {
      if (!this.#projectFeatures) throw new Error("普通会话没有工作区记忆作用域");
      return { scope, scopeId: this.#scopeId };
    }
    if (scope === "branch") {
      if (!this.#projectFeatures) throw new Error("普通会话没有分支记忆作用域");
      return {
        scope,
        scopeId: this.#runtime?.memoryScopeId("branch") ?? `${this.#scopeId}:no-branch`,
      };
    }
    if (scope === "task") {
      const sessionId = this.#runtime?.snapshot().sessionId;
      if (!sessionId) throw new Error("当前会话尚未就绪，没有任务记忆作用域");
      return { scope, scopeId: sessionId };
    }
    return { scope: "user", scopeId: "user" };
  }

  #mcpLocalFile(): string {
    return join(this.#paths.projectsRoot, this.#scopeId, "mcp-local.json");
  }
}

function assertSettingsScopePatch(scope: SettingsScope, patch: SettingsPatch): void {
  if (scope === "global" || scope === "session") return;
  const allowed = new Set([
    "models",
    "agent",
    "workspace",
    "permissions",
    "mcp",
    "skills",
    "memory",
  ]);
  const invalid = Object.keys(patch).filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    throw new Error(`项目作用域不能保存这些设置：${invalid.join(", ")}`);
  }
  if (patch.skills?.globalPaths !== undefined) {
    throw new Error("额外全局 Skill 路径只能保存在全局设置中");
  }
}

async function cleanupExpiredSessions(
  cwd: string,
  sessionDirectory: string,
  retentionDays: number,
): Promise<void> {
  try {
    const sessions = await SessionManager.list(cwd, sessionDirectory);
    if (sessions.length <= 1) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const sorted = sessions.sort(
      (left, right) => right.modified.getTime() - left.modified.getTime(),
    );
    await Promise.allSettled(sorted.slice(1)
      .filter((session) => session.modified.getTime() < cutoff)
      .map((session) => shell.trashItem(session.path)));
  } catch {
    // A malformed historical session must not prevent the desktop app from starting.
  }
}

async function cleanupGeneralLogs(logsRoot: string, retentionDays: number): Promise<void> {
  try {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const files = await readdir(logsRoot, { withFileTypes: true });
    await Promise.allSettled(files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => {
        const path = join(logsRoot, entry.name);
        if ((await stat(path)).mtimeMs < cutoff) await rm(path);
      }));
  } catch {
    // Log retention cleanup must not prevent startup.
  }
}

async function writeDiagnosticLog(
  logsRoot: string,
  configuredLevel: "error" | "warn" | "info" | "debug",
  event: Extract<AgentEvent, { type: "diagnostic" }>,
): Promise<void> {
  const weights = { error: 0, warning: 1, info: 2 } as const;
  const threshold = configuredLevel === "error" ? 0 : configuredLevel === "warn" ? 1 : 2;
  if (weights[event.level] > threshold) return;
  try {
    await mkdir(logsRoot, { recursive: true });
    await appendFile(
      join(logsRoot, "deki.log"),
      `${event.timestamp} ${event.level.toUpperCase()} ${event.message}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Logging must not affect runtime behavior.
  }
}

async function bootstrap(): Promise<void> {
  const workspace = await resolveStartupWorkspace(process.argv);
  await initializeDesktopState(
    workspace,
    process.argv.includes("--resume"),
  );
  registerIpcHandlers();
  await configureAppProtocol();
  createWindow();
}

async function initializeDesktopState(
  workspace: string | undefined,
  resumeLatest = false,
): Promise<void> {
  const paths = getDekiPaths();
  await ensureDekiDirectories(paths);
  taskStore = new TaskStore(paths.tasksDatabase);
  await cleanupStaleRunnerResources(taskStore, paths);
  taskStore.recoverInterrupted();
  taskStore.subscribePlans((event) => {
    broadcastPlanEvent(event);
    maybeNotifyPlanEvent(event);
  });
  const knownWorkspaces = await listRecentWorkspaces(paths.configFile);
  for (const knownWorkspace of [
    ...knownWorkspaces,
    ...(workspace && !knownWorkspaces.includes(workspace) ? [workspace] : []),
  ]) {
    taskStore.backfillWorkspacePath(workspaceId(knownWorkspace), knownWorkspace);
  }
  agentSupervisor = new AgentSupervisor();
  taskOrchestrator = new TaskOrchestrator({
    store: taskStore,
    concurrency: 1,
    recoverOnStart: false,
    workspaceAvailability: (task) => {
      if (task.workspacePath && !existsSync(task.workspacePath)) {
        return { runnable: false, attentionReason: "workspace_missing" };
      }
      const host = workspaceControllers.get(task.workspaceId);
      if (!host) return { runnable: false, attentionReason: "runtime_unavailable" };
      if (!host.trusted) return { runnable: false, attentionReason: "workspace_untrusted" };
      return host.availableForTasks
        ? { runnable: true }
        : { runnable: false, attentionReason: "runtime_unavailable" };
    },
    executor: async (input) => {
      const host = workspaceControllers.get(input.task.workspaceId);
      if (!host) throw new Error("任务所属工作区尚未加载");
      if (input.execution.worktreeContext) {
        return agentSupervisor!.track(
          input.task,
          input.run,
          await executeWorktreeTask(host, {
            ...input,
            execution: input.execution as PromptExecutionInput,
          }),
        );
      }
      const handle = await host.executeTask({
        ...input,
        execution: input.execution as PromptExecutionInput,
      });
      return agentSupervisor!.track(input.task, input.run, handle);
    },
    onEvent: (event) => {
      broadcastTaskEvent(event);
      maybeNotifyTaskEvent(event);
    },
  });
  controller = await getOrCreateController(workspace, {
    resumeLatest,
  });
  taskOrchestrator.setConcurrency(
    controller.getSettings().effective.agent.maxConcurrentRuns,
  );
  await restoreQueuedWorkspaceHosts();
  taskOrchestrator.start();
}

async function shutdownDesktopState(): Promise<void> {
  await taskOrchestrator?.dispose({ closeStore: false });
  await agentSupervisor?.dispose();
  await Promise.allSettled(
    [...workspaceControllers.values()].map((host) => host.dispose()),
  );
  workspaceControllers.clear();
  taskStore?.close();
  taskStore = undefined;
  taskOrchestrator = undefined;
  agentSupervisor = undefined;
  controller = undefined;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: "Deki",
    backgroundColor: "#0b1020",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden",
        }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.DEKI_LAUNCH_SMOKE === "1") {
    window.webContents.once("did-finish-load", () => {
      console.log("DEKI_LAUNCH_SMOKE_READY");
    });
  }
  window.on("close", () => {
    if (
      process.platform === "darwin"
      && !quitting
      && controller?.getSettings().effective.general.closeBehavior === "quit"
    ) {
      app.quit();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadURL("app://deki/index.html");
  }
  return window;
}

async function configureAppProtocol(): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL) return;
  const rendererRoot = resolve(import.meta.dirname, "../renderer");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(rendererRoot, normalize(requested));
    if (file !== rendererRoot && !file.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getBootstrapState, (event) => {
    assertTrustedSender(event);
    return controller?.getState() ?? createEmptyBootstrapState();
  });
  ipcMain.handle(IPC_CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const selection = owner
      ? await dialog.showOpenDialog(owner, {
          title: "选择 Deki 项目",
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "选择 Deki 项目",
          properties: ["openDirectory", "createDirectory"],
        });
    if (selection.canceled || !selection.filePaths[0]) {
      return commandResultSchema.parse({ ok: true });
    }

    try {
      const workspace = await resolveWorkspace(
        ["--workspace", selection.filePaths[0]],
        process.cwd(),
      );
      return commandResultSchema.parse(await switchToWorkspace(workspace, {
        trustSelectedWorkspace: true,
      }));
    } catch (error) {
      return commandResultSchema.parse({
        ok: false,
        error: formatError(error),
      });
    }
  });
  ipcMain.handle(IPC_CHANNELS.openWorkspace, async (event, raw) => {
    assertTrustedSender(event);
    const { workspace } = openWorkspaceInputSchema.parse(raw);
    const paths = getDekiPaths();
    const recent = await listRecentWorkspaces(paths.configFile);
    if (!recent.includes(workspace)) {
      return commandResultSchema.parse({ ok: false, error: "工作区不在最近项目列表中" });
    }
    try {
      const resolved = await resolveWorkspace(["--workspace", workspace], process.cwd());
      return commandResultSchema.parse(await switchToWorkspace(resolved));
    } catch (error) {
      return commandResultSchema.parse({ ok: false, error: formatError(error) });
    }
  });
  ipcMain.handle(IPC_CHANNELS.openGeneralChat, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await switchToWorkspace(undefined));
  });
  ipcMain.handle(IPC_CHANNELS.trustWorkspace, async (event) => {
    assertTrustedSender(event);
    if (!controller) {
      return commandResultSchema.parse({
        ok: false,
        error: "请先选择工作区",
      });
    }
    const result = commandResultSchema.parse(await controller?.trust());
    if (result.ok && process.argv.includes("--e2e-fixture-events")) {
      emitE2eFixtureEvents();
    }
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.sendPrompt, async (event, raw) => {
    assertTrustedSender(event);
    const { prompt, mode, interactionMode } = sendPromptInputSchema.parse(raw);
    return taskSubmissionResultSchema.parse(
      await controller?.sendPrompt(prompt, mode, interactionMode),
    );
  });
  ipcMain.handle(IPC_CHANNELS.optimizePrompt, async (event, raw) => {
    assertTrustedSender(event);
    const { prompt } = optimizePromptInputSchema.parse(raw);
    return optimizePromptResultSchema.parse(
      await controller?.optimizePrompt(prompt)
        ?? { ok: false, error: "Agent Runtime 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.abortRun, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await controller?.abort());
  });
  ipcMain.handle(IPC_CHANNELS.listTasks, (event, raw) => {
    assertTrustedSender(event);
    const input = taskListInputSchema.parse(raw ?? {});
    return taskSummarySchema.array().parse(
      taskOrchestrator?.listTaskSummaries({
        limit: input.limit,
        ...(input.statuses ? { statuses: input.statuses } : {}),
        ...(input.workspaceIds ? { workspaceIds: input.workspaceIds } : {}),
        ...(input.query ? { query: input.query } : {}),
      }) ?? [],
    );
  });
  ipcMain.handle(IPC_CHANNELS.getTask, (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return taskDetailSchema.nullable().parse(taskOrchestrator?.getTask(taskId) ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.cancelTask, async (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return commandResultSchema.parse(await runTaskCommand(
      () => taskOrchestrator?.cancelTask(taskId),
      "任务不存在或不能取消",
    ));
  });
  ipcMain.handle(IPC_CHANNELS.pauseTask, async (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return commandResultSchema.parse(await runTaskCommand(
      () => taskOrchestrator?.pauseTask(taskId),
      "任务不存在或不能暂停",
    ));
  });
  ipcMain.handle(IPC_CHANNELS.resumeTask, (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return commandResultSchema.parse(runTaskCommandSync(
      () => taskOrchestrator?.resumeTask(taskId),
      "任务不存在或不能恢复",
    ));
  });
  ipcMain.handle(IPC_CHANNELS.retryTask, (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return commandResultSchema.parse(runTaskCommandSync(
      () => taskOrchestrator?.retryTask(taskId),
      "任务不存在或不能重试",
    ));
  });
  ipcMain.handle(IPC_CHANNELS.promoteTask, (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return commandResultSchema.parse(runTaskCommandSync(
      () => taskOrchestrator?.promoteTask(taskId),
      "任务不存在或不能转到后台",
    ));
  });
  ipcMain.handle(IPC_CHANNELS.openTaskSession, async (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    const task = taskOrchestrator?.getTask(taskId)?.task;
    if (!task?.sessionId) {
      return commandResultSchema.parse({ ok: false, error: "任务尚未绑定会话" });
    }
    if (task.workspaceId !== "general" && !task.workspacePath) {
      return commandResultSchema.parse({
        ok: false,
        error: "任务所属项目路径不可用，无法打开会话",
      });
    }
    try {
      const host = await getOrCreateController(task.workspacePath);
      controller = host;
      return commandResultSchema.parse(await host.openTaskSession(task.sessionId));
    } catch (error) {
      return commandResultSchema.parse({ ok: false, error: formatError(error) });
    }
  });
  ipcMain.handle(IPC_CHANNELS.respondToTaskInput, async (event, raw) => {
    assertTrustedSender(event);
    const input = taskInputResponseSchema.parse(raw);
    const task = taskOrchestrator?.getTask(input.taskId)?.task;
    const host = task ? workspaceControllers.get(task.workspaceId) : undefined;
    if (!task || !host) {
      return commandResultSchema.parse({ ok: false, error: "任务输入请求已失效" });
    }
    return commandResultSchema.parse(await host.respondToTaskInput(
      input.requestId,
      input.value,
    ));
  });
  ipcMain.handle(IPC_CHANNELS.respondToIntegration, async (event, raw) => {
    assertTrustedSender(event);
    const input = integrationDecisionInputSchema.parse(raw);
    if (taskOrchestrator?.respondToIntegration(
      input.taskId,
      input.requestId,
      input.decision,
    )) return commandResultSchema.parse({ ok: true });
    return commandResultSchema.parse(await respondToPersistedIntegration(input));
  });
  ipcMain.handle(IPC_CHANNELS.readArtifactChunk, async (event, raw) => {
    assertTrustedSender(event);
    const input = artifactChunkInputSchema.parse(raw);
    const artifact = taskStore?.getArtifact(input.artifactId);
    if (!artifact) throw new Error("未找到 Artifact");
    if (artifact.content !== undefined) {
      const totalBytes = Buffer.byteLength(artifact.content);
      const content = Buffer.from(artifact.content).subarray(
        input.offset,
        input.offset + input.limit,
      ).toString("utf8");
      const nextOffset = Math.min(totalBytes, input.offset + Buffer.byteLength(content));
      return artifactChunkSchema.parse({
        artifactId: artifact.id,
        content,
        offset: input.offset,
        nextOffset,
        totalBytes,
        done: nextOffset >= totalBytes,
      });
    }
    if (!artifact.uri) throw new Error("Artifact 没有可读取内容");
    const chunk = await new ArtifactStore(getDekiPaths().artifactsRoot).readChunk(
      artifact.uri,
      input.offset,
      input.limit,
    );
    return artifactChunkSchema.parse({
      artifactId: artifact.id,
      offset: input.offset,
      ...chunk,
    });
  });
  ipcMain.handle(IPC_CHANNELS.listPlans, (event, raw) => {
    assertTrustedSender(event);
    const input = planListInputSchema.parse(raw ?? {});
    return planSummarySchema.array().parse(taskStore?.listPlans({
      limit: input.limit,
      ...(input.statuses ? { statuses: input.statuses } : {}),
      ...(input.workspaceIds ? { workspaceIds: input.workspaceIds } : {}),
      ...(input.query ? { query: input.query } : {}),
    }) ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.getPlan, (event, raw) => {
    assertTrustedSender(event);
    const { planId } = planIdInputSchema.parse(raw);
    return planDetailSchema.nullable().parse(taskStore?.getPlan(planId) ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.approvePlan, async (event, raw) => {
    assertTrustedSender(event);
    const { planId, revision } = approvePlanInputSchema.parse(raw);
    const plan = taskStore?.getPlan(planId)?.plan;
    const host = plan ? workspaceControllers.get(plan.workspaceId) : undefined;
    return commandResultSchema.parse(
      await host?.approvePlan(planId, revision)
      ?? { ok: false, error: "计划所属项目尚未加载" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.revisePlan, async (event, raw) => {
    assertTrustedSender(event);
    const { planId, feedback, mode } = revisePlanInputSchema.parse(raw);
    const plan = taskStore?.getPlan(planId)?.plan;
    const host = plan ? workspaceControllers.get(plan.workspaceId) : undefined;
    return taskSubmissionResultSchema.parse(
      await host?.requestPlanRevision(planId, feedback, mode)
      ?? { ok: false, error: "计划所属项目尚未加载" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.replan, async (event, raw) => {
    assertTrustedSender(event);
    const { planId, reason, affectedStepIds } = replanInputSchema.parse(raw);
    const plan = taskStore?.getPlan(planId)?.plan;
    const host = plan ? workspaceControllers.get(plan.workspaceId) : undefined;
    return taskSubmissionResultSchema.parse(
      await host?.requestPlanReplan(planId, reason, affectedStepIds)
      ?? { ok: false, error: "计划所属项目尚未加载" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.abandonPlan, async (event, raw) => {
    assertTrustedSender(event);
    const { planId } = planIdInputSchema.parse(raw);
    const plan = taskStore?.getPlan(planId)?.plan;
    const host = plan ? workspaceControllers.get(plan.workspaceId) : undefined;
    return commandResultSchema.parse(
      await host?.abandonPlan(planId)
      ?? { ok: false, error: "计划所属项目尚未加载" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.openPlanSession, async (event, raw) => {
    assertTrustedSender(event);
    const { planId } = planIdInputSchema.parse(raw);
    const plan = taskStore?.getPlan(planId)?.plan;
    if (!plan) return commandResultSchema.parse({ ok: false, error: "未找到计划" });
    const host = await getOrCreateController(plan.workspacePath);
    controller = host;
    return commandResultSchema.parse(await host.openPlanSession(planId));
  });
  ipcMain.handle(IPC_CHANNELS.newSession, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await controller?.newSession());
  });
  ipcMain.handle(IPC_CHANNELS.listSessions, async (event, raw) => {
    assertTrustedSender(event);
    const { query } = sessionSearchInputSchema.parse(raw ?? {});
    return sessionSummarySchema.array().parse(await controller?.listSessions(query) ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.getSessionHistory, (event) => {
    assertTrustedSender(event);
    return conversationMessageSchema.array().parse(controller?.getSessionHistory() ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.getSessionHistoryState, (event) => {
    assertTrustedSender(event);
    return sessionHistoryStateSchema.parse(controller?.getSessionHistoryState() ?? {
      messages: [],
      events: [],
      runState: "idle",
    });
  });
  ipcMain.handle(IPC_CHANNELS.forkSession, async (event, raw) => {
    assertTrustedSender(event);
    const { entryId } = forkSessionInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.forkSession(entryId));
  });
  ipcMain.handle(IPC_CHANNELS.switchSession, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = sessionIdInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.switchSession(id));
  });
  ipcMain.handle(IPC_CHANNELS.renameSession, async (event, raw) => {
    assertTrustedSender(event);
    const { id, name } = renameSessionInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.renameSession(id, name));
  });
  ipcMain.handle(IPC_CHANNELS.deleteSession, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = sessionIdInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.deleteSession(id));
  });
  ipcMain.handle(IPC_CHANNELS.remember, async (event, raw) => {
    assertTrustedSender(event);
    const { content, scope } = rememberInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.remember(content, scope));
  });
  ipcMain.handle(IPC_CHANNELS.listMemories, (event, raw) => {
    assertTrustedSender(event);
    const { scope, query } = memoryListInputSchema.parse(raw ?? {});
    return controller?.listMemories(scope, query) ?? [];
  });
  ipcMain.handle(IPC_CHANNELS.selectModel, async (event, raw) => {
    assertTrustedSender(event);
    const { provider, id } = selectModelInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.selectModel(provider, id));
  });
  ipcMain.handle(IPC_CHANNELS.updateSessionConfiguration, async (event, raw) => {
    assertTrustedSender(event);
    const input = updateSessionConfigurationInputSchema.parse(raw);
    return commandResultSchema.parse(
      await controller?.updateSessionConfiguration(input),
    );
  });
  ipcMain.handle(IPC_CHANNELS.getSettings, (event) => {
    assertTrustedSender(event);
    if (!controller) throw new Error("设置系统尚未就绪");
    return settingsSnapshotSchema.parse(controller.getSettings());
  });
  ipcMain.handle(IPC_CHANNELS.updateSettings, async (event, raw) => {
    assertTrustedSender(event);
    if (!controller) throw new Error("设置系统尚未就绪");
    const input = updateSettingsInputSchema.parse(raw);
    return settingsSnapshotSchema.parse(
      await controller.updateSettings(input.scope, input.patch, input.expectedRevision),
    );
  });
  ipcMain.handle(IPC_CHANNELS.resetSettings, async (event, raw) => {
    assertTrustedSender(event);
    if (!controller) throw new Error("设置系统尚未就绪");
    const input = resetSettingsInputSchema.parse(raw);
    return settingsSnapshotSchema.parse(
      await controller.resetSettings(input.scope, input.keys, input.expectedRevision),
    );
  });
  ipcMain.handle(IPC_CHANNELS.listModelProviders, async (event) => {
    assertTrustedSender(event);
    return redactedModelProviderSchema.array().parse(
      await controller?.listModelProviders() ?? [],
    );
  });
  ipcMain.handle(IPC_CHANNELS.upsertModelProvider, async (event, raw) => {
    assertTrustedSender(event);
    const input = modelProviderInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.upsertModelProvider(input));
  });
  ipcMain.handle(IPC_CHANNELS.removeModelProvider, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = removeModelProviderInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.removeModelProvider(id));
  });
  ipcMain.handle(IPC_CHANNELS.testModelProvider, async (event, raw) => {
    assertTrustedSender(event);
    const input = modelProviderInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.testModelProvider(input));
  });
  ipcMain.handle(IPC_CHANNELS.fetchModelProviderModels, async (event, raw) => {
    assertTrustedSender(event);
    const input = modelProviderInputSchema.parse(raw);
    return modelProviderCatalogResultSchema.parse(
      await controller?.fetchModelProviderModels(input)
        ?? { ok: false, error: "模型系统尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.respondToApproval, async (event, raw) => {
    assertTrustedSender(event);
    const input = taskApprovalDecisionInputSchema.parse(raw);
    const task = input.taskId
      ? taskOrchestrator?.getTask(input.taskId)?.task
      : undefined;
    const host = task
      ? workspaceControllers.get(task.workspaceId)
      : controller;
    return commandResultSchema.parse(await host?.respondToApproval(
      input.requestId,
      input.decision,
    ) ?? { ok: false, error: "Runtime 尚未就绪" });
  });
  ipcMain.handle(IPC_CHANNELS.revokeWorkspaceTrust, async (event) => {
    assertTrustedSender(event);
    const result = await controller?.revokeTrust()
      ?? { ok: false, error: "Runtime 尚未就绪" };
    if (result.ok) {
      const previous = controller;
      if (previous) workspaceControllers.delete(previous.scopeId);
      await previous?.dispose();
      controller = await getOrCreateController(undefined);
    }
    return commandResultSchema.parse(result);
  });
  ipcMain.handle(IPC_CHANNELS.openDataDirectory, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await controller?.openDataDirectory());
  });
  ipcMain.handle(IPC_CHANNELS.openThirdPartyLicenses, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(
      await controller?.openThirdPartyLicenses()
        ?? { ok: false, error: "设置系统尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.checkForUpdates, async (event) => {
    assertTrustedSender(event);
    if (!app.isPackaged) {
      return commandResultSchema.parse({
        ok: false,
        error: "开发构建不检查更新；请使用已签名安装包验证更新源",
      });
    }
    try {
      const result = await autoUpdater.checkForUpdatesAndNotify();
      const version = result?.updateInfo.version;
      return commandResultSchema.parse({
        ok: true,
        ...(version ? { error: `更新检查完成，远端版本 ${version}` } : {}),
      });
    } catch (error) {
      return commandResultSchema.parse({ ok: false, error: formatError(error) });
    }
  });
  ipcMain.handle(IPC_CHANNELS.exportDiagnostics, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(
      await controller?.exportDiagnostics(BrowserWindow.fromWebContents(event.sender) ?? undefined),
    );
  });
  ipcMain.handle(IPC_CHANNELS.listMcpServers, async (event) => {
    assertTrustedSender(event);
    return mcpServerEditorSchema.array().parse(await controller?.listMcpServers() ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.upsertMcpServer, async (event, raw) => {
    assertTrustedSender(event);
    const input = mcpServerEditorSchema.parse(raw);
    return commandResultSchema.parse(await controller?.upsertMcpServer(input));
  });
  ipcMain.handle(IPC_CHANNELS.removeMcpServer, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = removeModelProviderInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.removeMcpServer(id));
  });
  ipcMain.handle(IPC_CHANNELS.reloadMcpServers, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(
      await controller?.reloadMcpServers()
        ?? { ok: false, error: "Runtime 尚未就绪" },
    );
  });
  for (const [channel, action] of [
    [IPC_CHANNELS.startMcpServer, (id: string) => controller?.startMcpServer(id)],
    [IPC_CHANNELS.stopMcpServer, (id: string) => controller?.stopMcpServer(id)],
    [IPC_CHANNELS.restartMcpServer, (id: string) => controller?.restartMcpServer(id)],
    [IPC_CHANNELS.testMcpServer, (id: string) => controller?.testMcpServer(id)],
  ] as const) {
    ipcMain.handle(channel, async (event, raw) => {
      assertTrustedSender(event);
      const { id } = removeModelProviderInputSchema.parse(raw);
      return commandResultSchema.parse(
        await action(id) ?? { ok: false, error: "MCP Manager 尚未就绪" },
      );
    });
  }
  ipcMain.handle(IPC_CHANNELS.listMcpServerTools, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = removeModelProviderInputSchema.parse(raw);
    return mcpToolSummarySchema.array().parse(
      await controller?.listMcpServerTools(id) ?? [],
    );
  });
  ipcMain.handle(IPC_CHANNELS.listSkills, async (event) => {
    assertTrustedSender(event);
    return skillStatusSchema.array().parse(await controller?.listSkills() ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.reloadSkills, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(
      await controller?.reloadSkills() ?? { ok: false, error: "Skill Loader 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.updateSkill, async (event, raw) => {
    assertTrustedSender(event);
    const { path } = skillActionInputSchema.parse(raw);
    return commandResultSchema.parse(
      await controller?.updateSkill(path) ?? { ok: false, error: "Skill Registry 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.pinSkillVersion, async (event, raw) => {
    assertTrustedSender(event);
    const { path, pinnedVersion } = skillActionInputSchema.parse(raw);
    return commandResultSchema.parse(
      await controller?.pinSkillVersion(path, pinnedVersion ?? undefined)
        ?? { ok: false, error: "Skill Registry 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.updateMemory, (event, raw) => {
    assertTrustedSender(event);
    if (!controller) throw new Error("Memory Engine 尚未就绪");
    const input = memoryMutationSchema.parse(raw);
    return controller.updateMemory({
      id: input.id,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.status ? { status: input.status } : {}),
    });
  });
  ipcMain.handle(IPC_CHANNELS.deleteMemory, (event, raw) => {
    assertTrustedSender(event);
    const input = memoryMutationSchema.pick({ id: true, scope: true }).parse(raw);
    return commandResultSchema.parse(
      controller?.deleteMemory(input.id, input.scope) ?? { ok: false, error: "Memory Engine 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.clearMemoryScope, (event, raw) => {
    assertTrustedSender(event);
    const { scope } = memoryListInputSchema.parse(raw);
    return commandResultSchema.parse(
      controller?.clearMemoryScope(scope ?? "user")
        ?? { ok: false, error: "Memory Engine 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.moveMemory, (event, raw) => {
    assertTrustedSender(event);
    if (!controller) throw new Error("Memory Engine 尚未就绪");
    const input = memoryMoveInputSchema.parse(raw);
    return controller.moveMemory(input.id, input.from, input.to);
  });
  ipcMain.handle(IPC_CHANNELS.getDataUsage, async (event) => {
    assertTrustedSender(event);
    return dataUsageSchema.parse(await controller?.getDataUsage() ?? {
      totalBytes: 0,
      sessionsBytes: 0,
      memoryBytes: 0,
      tasksBytes: 0,
      logsBytes: 0,
      configBytes: 0,
    });
  });
  ipcMain.handle(IPC_CHANNELS.listAuditRecords, async (event) => {
    assertTrustedSender(event);
    return auditRecordSummarySchema.array().parse(
      await controller?.listAuditRecords() ?? [],
    );
  });
  ipcMain.handle(IPC_CHANNELS.listGitCheckpoints, async (event) => {
    assertTrustedSender(event);
    return gitCheckpointSchema.array().parse(
      await controller?.listGitCheckpoints() ?? [],
    );
  });
  ipcMain.handle(IPC_CHANNELS.createGitCheckpoint, async (event, raw) => {
    assertTrustedSender(event);
    const { message } = gitCheckpointCreateInputSchema.parse(raw ?? {});
    return commandResultSchema.parse(await controller?.createGitCheckpoint(message));
  });
  ipcMain.handle(IPC_CHANNELS.previewGitCheckpoint, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = gitCheckpointIdInputSchema.parse(raw);
    return await controller?.previewGitCheckpoint(id) ?? "";
  });
  ipcMain.handle(IPC_CHANNELS.restoreGitCheckpoint, async (event, raw) => {
    assertTrustedSender(event);
    const { id } = gitCheckpointIdInputSchema.parse(raw);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const preview = await controller?.previewGitCheckpoint(id) ?? "";
    const confirmation = owner
      ? await dialog.showMessageBox(owner, {
          type: "warning",
          title: "恢复 Git Checkpoint",
          message: "将工作区文件恢复到所选 Checkpoint？",
          detail: `${preview.slice(0, 4_000)}${preview.length > 4_000 ? "\n…Diff 已截断" : ""}\n\n恢复前会自动创建安全 Checkpoint；现有未跟踪文件不会被删除。`,
          buttons: ["取消", "创建安全快照并恢复"],
          defaultId: 0,
          cancelId: 0,
        })
      : { response: 0 };
    if (confirmation.response !== 1) return commandResultSchema.parse({ ok: true });
    return commandResultSchema.parse(await controller?.restoreGitCheckpoint(id));
  });
  ipcMain.handle(IPC_CHANNELS.factoryReset, async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const confirmation = owner
      ? await dialog.showMessageBox(owner, {
          type: "warning",
          title: "恢复出厂设置",
          message: "将 Deki 的本地数据移动到废纸篓并重新启动？",
          detail: "包括设置、模型密钥、会话、记忆、项目本机配置和审计日志。项目源码不会被删除。",
          buttons: ["取消", "移动到废纸篓并重置"],
          defaultId: 0,
          cancelId: 0,
        })
      : await dialog.showMessageBox({
          type: "warning",
          title: "恢复出厂设置",
          message: "将 Deki 的本地数据移动到废纸篓并重新启动？",
          buttons: ["取消", "移动到废纸篓并重置"],
          defaultId: 0,
          cancelId: 0,
        });
    if (confirmation.response !== 1) return commandResultSchema.parse({ ok: true });
    const paths = getDekiPaths();
    await shutdownDesktopState();
    try {
      await shell.trashItem(paths.root);
    } catch {
      const backup = `${paths.root}.backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
      await rename(paths.root, backup);
    }
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 100);
    return commandResultSchema.parse({ ok: true });
  });
  ipcMain.handle(IPC_CHANNELS.exportData, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(
      await controller?.exportData(BrowserWindow.fromWebContents(event.sender) ?? undefined)
        ?? { ok: false, error: "数据系统尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.importData, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(
      await controller?.importData(BrowserWindow.fromWebContents(event.sender) ?? undefined)
        ?? { ok: false, error: "数据系统尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.clearData, async (event, raw) => {
    assertTrustedSender(event);
    const { category } = clearDataInputSchema.parse(raw);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const confirmation = owner
      ? await dialog.showMessageBox(owner, {
          type: "warning",
          title: "清理本地数据",
          message: `将 ${category} 移动到废纸篓？`,
          detail: "相关 Runtime、MCP 和数据库会先安全关闭，然后重新创建当前会话。",
          buttons: ["取消", "移到废纸篓"],
          defaultId: 0,
          cancelId: 0,
        })
      : { response: 0 };
    if (confirmation.response !== 1) return commandResultSchema.parse({ ok: true });
    const workspace = controller?.workspacePath;
    const paths = getDekiPaths();
    const target = category === "sessions"
      ? paths.sessionsRoot
      : category === "memories"
        ? resolve(paths.memoryDatabase, "..")
        : category === "tasks"
          ? resolve(paths.tasksDatabase, "..")
          : paths.logsRoot;
    if (category === "tasks" && taskStore) {
      await cleanupStaleRunnerResources(taskStore, paths);
      await Promise.allSettled(taskStore.listArtifactGitRefs().map(async ({ ref, workspacePath }) => {
        await new WorktreeRunner(workspacePath, {
          worktreesRoot: join(paths.worktreesRoot, workspaceId(workspacePath)),
        }).removeArtifactRef(ref);
      }));
    }
    await shutdownDesktopState();
    await moveToTrashOrBackup(target);
    if (category === "tasks") {
      await moveToTrashOrBackup(paths.artifactsRoot);
      await moveToTrashOrBackup(paths.worktreesRoot);
    }
    await ensureDekiDirectories(paths);
    await initializeDesktopState(workspace);
    return commandResultSchema.parse({ ok: true });
  });
}

async function resolveStartupWorkspace(
  argv: readonly string[],
): Promise<string | undefined> {
  if (!argv.includes("--workspace")) return undefined;
  return resolveWorkspace(argv, process.cwd());
}

function createEmptyBootstrapState(): BootstrapState {
  return bootstrapStateSchema.parse({
    trusted: false,
    ready: false,
    streaming: false,
    models: [],
    memories: [],
    recalledMemories: [],
    mcpServers: [],
    skills: [],
    diagnostics: [],
  });
}

async function switchToWorkspace(
  workspace: string | undefined,
  options: { trustSelectedWorkspace?: boolean } = {},
): Promise<CommandResult> {
  try {
    if (controller && controller.workspacePath !== workspace) {
      const sessionId = controller.getState().sessionId;
      const activeTask = sessionId
        ? taskOrchestrator?.currentTaskForSession(controller.scopeId, sessionId)
        : undefined;
      if (activeTask?.kind === "interactive") {
        taskOrchestrator?.promoteTask(activeTask.id);
      }
    }
    controller = await getOrCreateController(workspace);
    if (
      workspace
      && options.trustSelectedWorkspace
      && !controller.getState().trusted
    ) {
      return controller.trust();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function requireTaskOrchestrator(): TaskOrchestrator {
  if (!taskOrchestrator) throw new Error("Task Orchestrator 尚未初始化");
  return taskOrchestrator;
}

function controllerKey(workspace: string | undefined): string {
  return workspace ? workspaceId(workspace) : "general";
}

async function getOrCreateController(
  workspace: string | undefined,
  options: { resumeLatest?: boolean } = {},
): Promise<DesktopController> {
  const key = controllerKey(workspace);
  const existing = workspaceControllers.get(key);
  if (existing) return existing;
  const created = await DesktopController.create(workspace, {
    ...options,
    tasks: requireTaskOrchestrator(),
  });
  workspaceControllers.set(key, created);
  agentSupervisor?.registerWorkspace(key);
  taskOrchestrator?.start();
  return created;
}

async function restoreQueuedWorkspaceHosts(): Promise<void> {
  const queued = requireTaskOrchestrator().listTaskSummaries({
    statuses: ["queued"],
    limit: 500,
  });
  const workspaces = [...new Set(
    queued.map((summary) => summary.task.workspacePath).filter(
      (workspace): workspace is string => Boolean(workspace),
    ),
  )];
  await Promise.allSettled(workspaces.map(async (workspace) => {
    if (await isWorkspaceTrusted(getDekiPaths().configFile, workspace)) {
      await getOrCreateController(workspace);
    }
  }));
}

async function executeWorktreeTask(
  _host: DesktopController,
  input: {
    task: import("@deki-ai/shared").TaskRecord;
    run: import("@deki-ai/shared").RunRecord;
    execution: PromptExecutionInput;
    signal: AbortSignal;
  },
) {
  const context = input.execution.worktreeContext;
  const workspace = input.task.workspacePath;
  if (!context || !workspace || input.execution.workerProfile !== "implementer") {
    throw new Error("Worktree Runner 只能执行具有完整上下文的 Implementer");
  }
  const paths = getDekiPaths();
  const runner = new WorktreeRunner(workspace, {
    worktreesRoot: join(paths.worktreesRoot, input.task.workspaceId),
    timeoutMs: 600_000,
  });
  const resource = await runner.createWorktree({
    rootTaskId: input.task.rootTaskId,
    resourceId: input.task.id,
    kind: "worker",
    baseCommit: context.baseCommit,
    repository: {
      repositoryRoot: context.repositoryRoot,
      commonDirectory: context.commonDirectory,
      workspaceRelativePath: context.workspaceRelativePath,
    },
  });
  taskStore!.saveRunnerResource({
    id: resource.id,
    rootTaskId: input.task.rootTaskId,
    taskId: input.task.id,
    runId: input.run.id,
    kind: "worker",
    path: resource.path,
    branchRef: resource.branchRef,
    baseCommit: resource.baseCommit,
    status: "active",
  });
  const ephemeral = await DesktopController.create(resource.cwd, {
    tasks: requireTaskOrchestrator(),
    trustedEphemeral: true,
  });
  let handle;
  try {
    handle = await ephemeral.executeTask(input);
  } catch (error) {
    await runner.cleanup(resource).catch(() => undefined);
    taskStore!.updateRunnerResource(resource.id, "cleaned");
    await ephemeral.dispose();
    throw error;
  }
  const completion = (async () => {
    let agentError: unknown;
    try {
      await handle.completion;
    } catch (error) {
      agentError = error;
    }
    try {
      const finalized = await runner.finalizeImplementer({
        resource,
        writeSet: validateWriteSet(context.writeSet),
        validationTargets: context.validationTargets,
        signal: input.signal,
      });
      const artifactStore = new ArtifactStore(paths.artifactsRoot);
      const patchId = randomUUID();
      const patchFile = await artifactStore.write(
        input.task.workspaceId,
        input.task.rootTaskId,
        patchId,
        "patch",
        finalized.patch,
      );
      taskStore!.createArtifact({
        id: patchId,
        taskId: input.task.id,
        runId: input.run.id,
        kind: "patch",
        title: "Implementer Patch",
        uri: patchFile.uri,
        metadata: {
          sha256: patchFile.sha256,
          size: patchFile.size,
          baselineCommit: context.baseCommit,
          changedFiles: finalized.changedFiles,
          outOfScopeFiles: finalized.outOfScopeFiles,
        },
      });
      const validationArtifactIds: string[] = [];
      for (const validation of finalized.validations) {
        const id = randomUUID();
        const file = await artifactStore.write(
          input.task.workspaceId,
          input.task.rootTaskId,
          id,
          "log",
          validation.output,
        );
        taskStore!.createArtifact({
          id,
          taskId: input.task.id,
          runId: input.run.id,
          kind: "test-result",
          title: `${validation.target.cwd ?? "."}: ${validation.target.script}`,
          uri: file.uri,
          metadata: {
            sha256: file.sha256,
            size: file.size,
            target: validation.target,
            exitCode: validation.exitCode,
            durationMs: validation.durationMs,
            timedOut: validation.timedOut,
            isolatedWorktree: true,
          },
        });
        validationArtifactIds.push(id);
      }
      let commitArtifactId: string | undefined;
      if (finalized.commit) {
        commitArtifactId = randomUUID();
        const ref = await runner.createArtifactRef(commitArtifactId, finalized.commit);
        taskStore!.createArtifact({
          id: commitArtifactId,
          taskId: input.task.id,
          runId: input.run.id,
          kind: "commit",
          title: `Implementer Commit ${finalized.commit.slice(0, 12)}`,
          content: finalized.commit,
          metadata: { ref, commit: finalized.commit },
        });
      }
      taskStore!.saveImplementationResult({
        taskId: input.task.id,
        runId: input.run.id,
        baselineCommit: context.baseCommit,
        ...(finalized.commit ? { commit: finalized.commit } : {}),
        changedFiles: finalized.changedFiles,
        patchArtifactId: patchId,
        ...(commitArtifactId ? { commitArtifactId } : {}),
        validationArtifactIds,
        scopeViolation: finalized.outOfScopeFiles.length > 0,
        createdAt: new Date().toISOString(),
      });
      taskStore!.updateRunnerResource(resource.id, "finalized");
      if (finalized.outOfScopeFiles.length > 0) {
        throw new Error(`Implementer 修改超出声明范围：${finalized.outOfScopeFiles.join(", ")}`);
      }
      if (finalized.changedFiles.length === 0) throw new Error("Implementer 未产生修改");
      if (finalized.validations.some((validation) => validation.exitCode !== 0)) {
        throw new Error("Implementer 验证失败");
      }
      if (!finalized.commit) throw new Error("Runner 未生成 Implementer Commit");
      if (agentError) throw agentError;
    } finally {
      try {
        taskStore!.updateRunnerResource(resource.id, "cleanup_pending");
        await runner.cleanup(resource);
        taskStore!.updateRunnerResource(resource.id, "cleaned");
      } catch (cleanupError) {
        taskStore!.updateRunnerResource(
          resource.id,
          "cleanup_failed",
          formatError(cleanupError),
        );
      }
      await ephemeral.dispose();
    }
  })();
  return {
    sessionId: handle.sessionId,
    ...(handle.modelProvider ? { modelProvider: handle.modelProvider } : {}),
    ...(handle.modelId ? { modelId: handle.modelId } : {}),
    completion,
    cancel: () => handle.cancel(),
    captureContext: () => ({
      ...handle.captureContext(),
      worktreeContext: context,
    }),
    captureUsage: () => handle.captureUsage(),
  };
}

async function cleanupStaleRunnerResources(
  store: TaskStore,
  paths: DekiPaths,
): Promise<void> {
  for (const record of store.listRunnerResources([
    "allocating",
    "active",
    "finalized",
    "cleanup_pending",
    "cleanup_failed",
  ])) {
    const task = store.getTask(record.taskId);
    if (!task?.workspacePath) {
      store.updateRunnerResource(record.id, "cleanup_failed", "任务工作区路径不可用");
      continue;
    }
    try {
      const runner = new WorktreeRunner(task.workspacePath, {
        worktreesRoot: join(paths.worktreesRoot, task.workspaceId),
        timeoutMs: 120_000,
      });
      const repository = await runner.inspectRepository();
      const branch = record.branchRef.replace(/^refs\/heads\//u, "");
      await runner.cleanup({
        id: record.id,
        kind: record.kind,
        path: record.path,
        cwd: repository.workspaceRelativePath
          ? join(record.path, repository.workspaceRelativePath)
          : record.path,
        branch,
        branchRef: record.branchRef,
        baseCommit: record.baseCommit,
        repository,
      });
      store.updateRunnerResource(record.id, "cleaned");
    } catch (error) {
      store.updateRunnerResource(record.id, "cleanup_failed", formatError(error));
    }
  }
}

async function acquireRepositoryWriteLock(key: string): Promise<() => void> {
  const previous = repositoryWriteLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveLock) => {
    releaseCurrent = resolveLock;
  });
  const tail = previous.then(() => current);
  repositoryWriteLocks.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (repositoryWriteLocks.get(key) === tail) repositoryWriteLocks.delete(key);
  };
}

async function respondToPersistedIntegration(input: {
  taskId: string;
  requestId: string;
  decision: "apply" | "artifact_only" | "cancel";
}): Promise<CommandResult> {
  try {
    const detail = taskStore?.getTaskDetail(input.taskId);
    const request = detail?.requests.find((candidate) =>
      candidate.id === input.requestId
      && candidate.kind === "integration_approval"
      && candidate.status === "pending");
    const integration = detail?.integration;
    const runId = detail?.task.currentRunId;
    if (!detail || !request || !integration || !runId) {
      return { ok: false, error: "集成审批请求已失效" };
    }
    if (input.decision === "apply") {
      if (
        !detail.task.workspacePath
        || !integration.integrationCommit
        || !integration.patchArtifactId
      ) throw new Error("集成记录缺少应用所需信息");
      const artifact = taskStore!.getArtifact(integration.patchArtifactId);
      if (!artifact?.uri && artifact?.content === undefined) {
        throw new Error("集成 Patch Artifact 已丢失");
      }
      const patch = artifact.content ?? await readFile(artifact.uri!, "utf8");
      await new WorktreeRunner(detail.task.workspacePath, {
        worktreesRoot: join(getDekiPaths().worktreesRoot, detail.task.workspaceId),
        timeoutMs: 600_000,
      }).applyPatch({
        baselineCommit: integration.baselineCommit,
        integrationCommit: integration.integrationCommit,
        patch,
      });
      taskStore!.updateIntegration(integration.id, { status: "applied" });
    } else {
      taskStore!.updateIntegration(integration.id, {
        status: input.decision === "artifact_only" ? "artifact_only" : "cancelled",
      });
    }
    taskStore!.finishIntegrationDecision(
      input.taskId,
      runId,
      input.decision,
      input.requestId,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

async function runTaskCommand(
  operation: () => Promise<boolean> | undefined,
  error: string,
): Promise<CommandResult> {
  try {
    return await operation() ? { ok: true } : { ok: false, error };
  } catch (reason) {
    return { ok: false, error: formatError(reason) };
  }
}

function runTaskCommandSync(
  operation: () => boolean | undefined,
  error: string,
): CommandResult {
  try {
    return operation() ? { ok: true } : { ok: false, error };
  } catch (reason) {
    return { ok: false, error: formatError(reason) };
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!url || !isAllowedRendererUrl(url)) {
    throw new Error("拒绝来自未知页面的 IPC 请求");
  }
}

function isAllowedRendererUrl(url: string): boolean {
  if (url.startsWith("app://deki/")) return true;
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return devUrl !== undefined && new URL(url).origin === new URL(devUrl).origin;
}

function broadcastEvent(raw: AgentEvent): void {
  const event = agentEventSchema.parse(raw);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.agentEvent, event);
    }
  }
}

function broadcastTaskEvent(raw: TaskEvent): void {
  const event = taskEventSchema.parse(raw);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.taskEvent, event);
    }
  }
}

function broadcastPlanEvent(raw: PlanEvent): void {
  const event = planEventSchema.parse(raw);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.planEvent, event);
    }
  }
}

function maybeNotifyPlanEvent(event: PlanEvent): void {
  if (
    quitting
    || !Notification.isSupported()
    || !["plan.completed", "plan.replan_requested"].includes(event.type)
  ) return;
  const plan = taskStore?.getPlan(event.planId)?.plan;
  if (!plan) return;
  const deliveryMode = event.taskId
    ? taskStore?.getDeliveryMode(event.taskId)
    : plan.executionTaskId
      ? taskStore?.getDeliveryMode(plan.executionTaskId)
      : "foreground";
  if (event.type === "plan.completed" && deliveryMode !== "background") return;
  const body = event.type === "plan.completed"
      ? "计划执行完成"
      : "计划需要重新规划";
  const notification = new Notification({
    title: createTaskTitle(plan.goal),
    body,
  });
  notification.on("click", () => {
    let window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) window = createWindow();
    window.show();
    window.focus();
    window.webContents.send(IPC_CHANNELS.openPlan, plan.id);
  });
  notification.show();
}

function maybeNotifyTaskEvent(event: TaskEvent): void {
  if (quitting) return;
  const detail = taskOrchestrator?.getTask(event.taskId);
  if (!detail || !Notification.isSupported()) return;
  const task = detail.task;
  // Worker lifecycle is surfaced through the parent Agent Tree. Only the root
  // task owns desktop notifications, otherwise a two-worker batch can produce
  // three notifications for one user action.
  if (task.kind === "worker") return;
  const deliveryMode = taskStore?.getDeliveryMode(task.id) ?? "foreground";
  if (
    event.type === "task.succeeded"
    && task.kind === "planning"
    && task.planId
    && deliveryMode === "background"
  ) {
    const notification = new Notification({
      title: task.title,
      body: "计划已生成，等待审阅",
    });
    notification.on("click", () => {
      let window = BrowserWindow.getAllWindows()[0];
      if (!window || window.isDestroyed()) window = createWindow();
      window.show();
      window.focus();
      window.webContents.send(IPC_CHANNELS.openPlan, task.planId);
    });
    notification.show();
    return;
  }
  const activeState = controller?.getState();
  const isActiveSession = controller?.scopeId === task.workspaceId
    && activeState?.sessionId === task.sessionId;
  const attention = event.type === "task.waiting_approval"
    || event.type === "task.waiting_user";
  const backgroundSuccess = event.type === "task.succeeded"
    && deliveryMode === "background"
    && task.kind !== "planning"
    && task.kind !== "plan-execution";
  const abnormal = event.type === "task.failed" || event.type === "task.interrupted";
  const backgroundAttention = attention
    && (deliveryMode === "background" || !isActiveSession);
  if (!backgroundAttention && !backgroundSuccess && !abnormal) return;
  const body = attention
    ? "任务需要你的处理"
    : event.type === "task.succeeded"
      ? "后台任务已完成"
      : event.type === "task.failed"
        ? "任务执行失败"
        : "任务已中断";
  const notification = new Notification({ title: task.title, body });
  notification.on("click", () => {
    let window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) window = createWindow();
    window.show();
    window.focus();
    window.webContents.send(IPC_CHANNELS.openTask, task.id);
  });
  notification.show();
}

function broadcastSettings(raw: SettingsSnapshot): void {
  const settings = settingsSnapshotSchema.parse(raw);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.settingsChanged, settings);
    }
  }
}

function createTaskTitle(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? prompt;
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine;
}

function renderPlanningPrompt(
  goal: string,
  planId: string | undefined,
  store: TaskStore | undefined,
): string {
  if (planId) {
    const detail = store?.getPlan(planId);
    const revision = detail?.revisions.find(
      (candidate) => candidate.revision === detail.plan.currentRevision,
    );
    const eventFeedback = [...(detail?.events ?? [])].reverse().find(
      (event) => event.type === "plan.replan_requested",
    )?.payload.feedback;
    const feedback = detail?.plan.replanReason
      ?? (typeof eventFeedback === "string" ? eventFeedback : undefined);
    return [
      "你处于 Plan 模式。只允许读取和分析，不得修改文件或执行有副作用的工具。",
      "检查项目实际状态后，基于当前计划和反馈生成完整的新版本。",
      `必须调用 plan__revise，planId=${planId}，basedOnRevision=${detail?.plan.currentRevision ?? 1}。`,
      typeof feedback === "string" ? `用户反馈或重新规划原因：${feedback}` : "",
      detail?.plan.affectedStepIds.length
        ? `受影响步骤：${detail.plan.affectedStepIds.join(", ")}`
        : "",
      detail?.plan.replanEvidence.length
        ? `重新规划证据：${JSON.stringify(detail.plan.replanEvidence)}`
        : "",
      revision ? `当前版本：${JSON.stringify(revision)}` : "",
      `目标：${goal}`,
    ].filter(Boolean).join("\n\n");
  }
  return [
    "你处于 Plan 模式。只允许读取和分析，不得修改文件或执行有副作用的工具。",
    "充分检查项目结构、现有实现和约束后，生成可直接交给工程师实施的结构化计划。",
    "完成分析后必须调用 plan__submit；不要只在聊天中输出 Markdown 计划。",
    "步骤 ID 必须稳定且唯一，依赖必须构成无环图，每一步都要包含验证方式。",
    `目标：${goal}`,
  ].join("\n\n");
}

function renderWorkerPrompt(
  profile: import("@deki-ai/shared").WorkerProfileId,
  context: import("@deki-ai/shared").WorkerContextPackage,
  worktreeContext?: PromptExecutionInput["worktreeContext"],
): string {
  const role = profile === "explorer"
    ? "Explorer：搜索代码并收集可验证证据"
    : profile === "tester"
      ? "Tester：分析测试，并仅通过受控测试工具在临时副本验证"
      : profile === "reviewer"
        ? "Reviewer：审查实现、安全和回归风险"
        : profile === "implementer"
          ? "Implementer：只在隔离 Git worktree 内完成声明范围的修改"
          : "Integrator：只解决系统提供的受限集成冲突";
  if (profile === "implementer") {
    return [
      `你是 ${role}。`,
      "真实用户工作区不会被你的中间状态修改。只能修改上下文包和 Worktree Context 声明的 writeSet；不得修改范围外文件。",
      "不得执行 git add、commit、reset、branch、worktree、push 等 Git 写操作，提交和清理由 Runner 负责。",
      "可以使用工作区编辑工具和受控验证工具。完成后必须调用 worker__submit_result 提交结构化总结；不要创建其他 Worker。",
      `上下文包：${JSON.stringify(context)}`,
      `Worktree Context：${JSON.stringify(worktreeContext)}`,
    ].join("\n\n");
  }
  return [
    `你是只读 ${role}。`,
    "不得修改真实工作区，不得调用 Bash、写入、删除、安装依赖或 Git 写操作。",
    "只处理给定子任务，不要尝试创建其他 Worker，也不要假装已经执行未运行的验证。",
    "完成调查后必须调用 worker__submit_result 提交结构化结果；证据必须能定位到文件、命令、Artifact 或 URL。",
    `上下文包：${JSON.stringify(context)}`,
  ].join("\n\n");
}

function renderTaskContinuation(
  task: import("@deki-ai/shared").TaskRecord,
  store: TaskStore | undefined,
): string {
  const workers = store?.getTaskDetail(task.id)?.children ?? [];
  const persistedResults = workers.flatMap((worker) => {
    const detail = store?.getTaskDetail(worker.task.id);
    return detail?.workerResult
      ? [{
          taskId: worker.task.id,
          profile: worker.task.assignedProfile,
          status: worker.task.status,
          result: detail.workerResult,
        }]
      : [];
  });
  return [
    "继续完成此前任务。先检查当前会话和工作区状态，不要重复已经完成的步骤，",
    "也不要盲目重放可能产生副作用的工具调用。",
    "此前的 Worker 派发不会自动重放；只把下面已持久化的结构化结果作为证据使用。",
    persistedResults.length > 0
      ? `已有 Worker 结果：${JSON.stringify(persistedResults)}`
      : "当前没有已完成并持久化的 Worker 结果。",
    `原始目标：${task.goal}`,
  ].join("\n\n");
}

async function runWorkerTestInSnapshot(
  workspace: string,
  target: string,
  timeoutMs: number,
  persistResult: (result: {
    output: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
  }) => string | Promise<string>,
): Promise<{
  output: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  artifactId: string;
}> {
  const manifestPath = join(workspace, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (
    !/^(?:test(?::[A-Za-z0-9_.-]+)?|lint|typecheck)$/.test(target)
    || typeof manifest.scripts?.[target] !== "string"
  ) {
    throw new Error("Tester 只能运行项目已声明的 test、lint 或 typecheck 脚本");
  }
  const size = await directorySizeForWorker(workspace);
  if (size > 2 * 1024 * 1024 * 1024) {
    throw new Error("工作区超过 2 GiB，无法创建安全测试副本");
  }
  const snapshotRoot = await mkdtemp(join(tmpdir(), "deki-worker-test-"));
  const snapshot = join(snapshotRoot, "workspace");
  const startedAt = Date.now();
  try {
    await cloneWorkerWorkspace(workspace, snapshot, workspace);
    const executable = existsSync(join(workspace, "pnpm-lock.yaml"))
      ? process.platform === "win32" ? "pnpm.cmd" : "pnpm"
      : existsSync(join(workspace, "yarn.lock"))
        ? process.platform === "win32" ? "yarn.cmd" : "yarn"
        : existsSync(join(workspace, "bun.lockb"))
          ? process.platform === "win32" ? "bun.exe" : "bun"
          : process.platform === "win32" ? "npm.cmd" : "npm";
    const home = join(snapshotRoot, "home");
    const temporary = join(snapshotRoot, "tmp");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(temporary, { recursive: true }),
    ]);
    const environment = Object.fromEntries(
      ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "LANG", "LC_ALL", "TERM"]
        .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
    );
    const output = await new Promise<{
      text: string;
      exitCode: number;
      timedOut: boolean;
    }>(
      (resolveRun, rejectRun) => {
        const child = spawn(executable, ["run", target], {
          cwd: snapshot,
          shell: false,
          env: {
            ...environment,
            HOME: home,
            USERPROFILE: home,
            TMPDIR: temporary,
            TEMP: temporary,
            TMP: temporary,
            CI: "1",
            NO_COLOR: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        const append = (chunk: Buffer) => {
          text = `${text}${chunk.toString("utf8")}`.slice(-1_000_000);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        let timedOut = false;
        let forceKill: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          append(Buffer.from(`\nTester 运行超过 ${timeoutMs}ms，已终止。\n`));
          child.kill("SIGTERM");
          forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
        }, timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          if (forceKill) clearTimeout(forceKill);
          rejectRun(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (forceKill) clearTimeout(forceKill);
          resolveRun({ text, exitCode: timedOut ? -1 : code ?? -1, timedOut });
        });
      },
    );
    const result = {
      output: output.text,
      exitCode: output.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: output.timedOut,
    };
    const artifactId = await persistResult(result);
    return { ...result, artifactId };
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

async function directorySizeForWorker(root: string): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) total += (await stat(path)).size;
      if (total > 2 * 1024 * 1024 * 1024) return;
    }
  };
  await visit(root);
  return total;
}

async function cloneWorkerWorkspace(
  source: string,
  destination: string,
  workspaceRoot: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) {
      const target = await readlink(sourcePath);
      if (isAbsolute(target)) {
        throw new Error(`Tester 快照拒绝绝对符号链接：${sourcePath}`);
      }
      const resolvedTarget = resolve(dirname(sourcePath), target);
      if (!isPathInside(workspaceRoot, resolvedTarget)) {
        throw new Error(`Tester 快照拒绝指向工作区外的符号链接：${sourcePath}`);
      }
      await symlink(target, destinationPath);
      continue;
    }
    if (info.isDirectory()) {
      await cloneWorkerWorkspace(sourcePath, destinationPath, workspaceRoot);
      continue;
    }
    if (!info.isFile()) continue;
    try {
      await cloneWorkerFile(sourcePath, destinationPath);
    } catch (error) {
      throw new Error(
        `无法为 Tester 创建写时复制快照：${sourcePath}（${formatError(error)}）`,
        { cause: error },
      );
    }
  }
}

async function cloneWorkerFile(source: string, destination: string): Promise<void> {
  const args = process.platform === "darwin"
    ? ["-c", source, destination]
    : process.platform === "linux"
      ? ["--reflink=always", "--", source, destination]
      : undefined;
  if (!args) throw new Error("当前平台不支持安全的写时复制 Tester 快照");
  await new Promise<void>((resolveClone, rejectClone) => {
    const child = spawn("cp", args, {
      shell: false,
      env: Object.fromEntries(
        ["PATH", "SystemRoot", "WINDIR"]
          .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
      ),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errorText = `${errorText}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.once("error", rejectClone);
    child.once("close", (code) => {
      if (code === 0) resolveClone();
      else rejectClone(new Error(errorText.trim() || `cp exited with ${code ?? -1}`));
    });
  });
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function renderPlanExecutionPrompt(
  detail: PlanDetail | undefined,
  fallbackGoal: string,
): string {
  if (!detail) throw new Error("未找到已批准计划");
  const revisionNumber = detail.plan.approvedRevision ?? detail.plan.currentRevision;
  const revision = detail.revisions.find(
    (candidate) => candidate.revision === revisionNumber,
  );
  if (!revision) throw new Error("未找到已批准计划版本");
  const states = detail.stepStates.filter((state) => state.revision === revisionNumber);
  return [
    "执行下面已由用户批准的计划。严格按依赖顺序串行执行，一次只执行一个步骤。",
    "开始步骤前调用 plan__update_step 标记 running；完成后标记 completed 并提供摘要和证据。",
    "如需只读 Worker 协助，worker__delegate 请求必须携带当前 planId、revision 和 stepId，以便结论关联到步骤。",
    "若关键假设失效、风险显著变化或步骤无法完成，调用 plan__request_replan，不要自行改写计划。",
    "恢复执行时先检查工作区和会话实际状态，不要重复已完成步骤，也不要盲目重放有副作用的调用。",
    `planId=${detail.plan.id}`,
    `revision=${revisionNumber}`,
    `目标：${detail.plan.goal || fallbackGoal}`,
    `计划：${JSON.stringify(revision)}`,
    `当前步骤状态：${JSON.stringify(states)}`,
  ].join("\n\n");
}

function applyNativeSettings(snapshot: SettingsSnapshot): void {
  app.setLoginItemSettings({ openAtLogin: snapshot.effective.general.launchAtLogin });
  const proxyUrl = snapshot.effective.advanced.proxyUrl.trim();
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  }
  const caPath = snapshot.effective.advanced.customCaPath.trim();
  if (caPath) process.env.NODE_EXTRA_CA_CERTS = caPath;
  else delete process.env.NODE_EXTRA_CA_CERTS;
  if (app.isReady()) {
    void session.defaultSession.setProxy(proxyUrl
      ? { proxyRules: proxyUrl }
      : { mode: "direct" });
  }
  applyAutoUpdateSettings(snapshot);
}

function applyAutoUpdateSettings(snapshot: SettingsSnapshot): void {
  if (!app.isPackaged || !app.isReady()) return;

  const enabled = snapshot.effective.updates.enabled
    && snapshot.effective.general.checkUpdates;
  const channel = snapshot.effective.updates.channel === "beta" ? "beta" : "latest";
  const configuration = `${enabled}:${channel}`;
  if (configuration === appliedUpdateConfiguration) return;
  appliedUpdateConfiguration = configuration;

  if (updateCheckTimer) {
    clearTimeout(updateCheckTimer);
    updateCheckTimer = undefined;
  }
  if (!enabled) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = channel === "beta";
  autoUpdater.channel = channel;
  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = undefined;
    void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      console.error("Deki update check failed:", formatError(error));
    });
  }, 10_000);
}

function requiresRuntimeReload(before: SettingsSnapshot, after: SettingsSnapshot): boolean {
  return JSON.stringify({
    agent: before.effective.agent,
    advanced: before.effective.advanced,
    models: before.effective.models,
    mcp: before.effective.mcp,
    skills: before.effective.skills,
    memory: before.effective.memory,
    permissions: before.effective.permissions,
    workspace: before.effective.workspace,
  }) !== JSON.stringify({
    agent: after.effective.agent,
    advanced: after.effective.advanced,
    models: after.effective.models,
    mcp: after.effective.mcp,
    skills: after.effective.skills,
    memory: after.effective.memory,
    permissions: after.effective.permissions,
    workspace: after.effective.workspace,
  });
}

function redactSettingsForExport(snapshot: SettingsSnapshot): unknown {
  return {
    revision: snapshot.revision,
    effective: snapshot.effective,
    sources: snapshot.sources,
    diagnostics: snapshot.diagnostics,
  };
}

async function directorySize(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(entries.map((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? directorySize(child) : fileSize(child);
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateSkillDependencies(
  content: string,
  skillDirectory: string,
  workspace: string | undefined,
): Promise<string[]> {
  const raw = /^---[\s\S]*?^dependencies:\s*(.+?)\s*$[\s\S]*?^---/mu.exec(content)?.[1];
  if (!raw) return [];
  const dependencies = raw.replaceAll(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replaceAll(/^["']|["']$/g, ""))
    .filter(Boolean);
  const diagnostics: string[] = [];
  for (const dependency of dependencies) {
    let found = false;
    if (dependency.startsWith("./") || dependency.startsWith("../")) {
      try {
        await stat(resolve(skillDirectory, dependency));
        found = true;
      } catch {
        found = false;
      }
    } else if (dependency.startsWith("npm:")) {
      const packageName = dependency.slice(4);
      const candidates = [
        workspace ? join(workspace, "node_modules", packageName, "package.json") : "",
        join(process.cwd(), "node_modules", packageName, "package.json"),
      ].filter(Boolean);
      for (const candidate of candidates) {
        try {
          await stat(candidate);
          found = true;
          break;
        } catch {
          // Continue checking available package roots.
        }
      }
    } else if (dependency.startsWith("command:")) {
      const command = dependency.slice(8);
      for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        try {
          await stat(join(directory, command));
          found = true;
          break;
        } catch {
          // Continue searching PATH.
        }
      }
    } else {
      diagnostics.push(`无法识别依赖声明：${dependency}`);
      continue;
    }
    if (!found) diagnostics.push(`缺少依赖：${dependency}`);
  }
  return diagnostics;
}

function isMemoryType(
  value: unknown,
): value is "preference" | "fact" | "decision" | "experience" | "task-state" {
  return ["preference", "fact", "decision", "experience", "task-state"].includes(
    String(value),
  );
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

async function moveToTrashOrBackup(target: string): Promise<void> {
  try {
    await stat(target);
  } catch {
    return;
  }
  try {
    await shell.trashItem(target);
  } catch {
    const backup = `${target}.backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    await rename(target, backup);
  }
}

function createDiagnosticEvent(message: string): AgentEvent {
  return agentEventSchema.parse({
    type: "diagnostic",
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level: "error",
    message,
  });
}

function emitE2eFixtureEvents(): void {
  const base = {
    timestamp: new Date().toISOString(),
    sessionId: "e2e-session",
  };
  broadcastEvent({
    ...base,
    type: "message.reasoning.delta",
    eventId: crypto.randomUUID(),
    delta: "先检查用户目标，再确认当前运行状态。",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  broadcastEvent({
    ...base,
    type: "message.delta",
    eventId: crypto.randomUUID(),
    delta: "这是模拟的流式响应。\n\n```ts\nconst ready = true;\n```",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  broadcastEvent({
    ...base,
    type: "tool.started",
    eventId: crypto.randomUUID(),
    callId: "e2e-tool-call",
    toolName: "deki__project_info",
    input: {},
  });
  broadcastEvent({
    ...base,
    type: "tool.completed",
    eventId: crypto.randomUUID(),
    callId: "e2e-tool-call",
    toolName: "deki__project_info",
    isError: false,
    result: { content: [{ type: "text", text: "fixture" }] },
  });
  broadcastEvent({
    ...base,
    type: "diff.available",
    eventId: crypto.randomUUID(),
    callId: "e2e-tool-call",
    diff: "--- a/example.txt\n+++ b/example.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
  });
  broadcastEvent({
    ...base,
    type: "message.completed",
    eventId: crypto.randomUUID(),
  });
  broadcastEvent({
    ...base,
    type: "run.completed",
    eventId: crypto.randomUUID(),
  });
}

app.whenReady()
  .then(bootstrap)
  .catch((error) => {
    console.error(error);
    app.quit();
  });

app.on("window-all-closed", () => {
  const keepRunning = controller?.getSettings().effective.general.closeBehavior
    === "keep-running";
  if (process.platform !== "darwin" && !keepRunning) {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  quitting = true;
  void shutdownDesktopState().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
