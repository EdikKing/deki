import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import electronUpdater from "electron-updater";
import { DekiAgentRuntime } from "@deki-ai/agent-runtime";
import { GitCheckpointManager } from "@deki-ai/git-checkpoint";
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
  approvalDecisionInputSchema,
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
  taskRecordSchema,
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
  type TaskEvent,
  type TaskListInput,
  type TaskSubmissionResult,
  type UpdateSessionConfigurationInput,
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
let quitting = false;
let updateCheckTimer: NodeJS.Timeout | undefined;
let appliedUpdateConfiguration = "";
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
    this.#tasks = new TaskOrchestrator({
      store: new TaskStore(paths.tasksDatabase),
      workspaceId: scopeId,
      concurrency: settings.snapshot().effective.agent.maxConcurrentRuns,
      executor: async ({ task, run, execution, signal }) => {
        const runtime = this.#runtime;
        if (!runtime) throw new Error("Agent Runtime 尚未就绪");
        const promptExecution = execution as PromptExecutionInput;
        const handle = await runtime.startPrompt({
          taskId: task.id,
          runId: run.id,
          prompt: task.goal,
          context: {
            sourceSessionId: promptExecution.sourceSessionId,
            ...(promptExecution.sourceSessionFile
              ? { sourceSessionFile: promptExecution.sourceSessionFile }
              : {}),
            ...(promptExecution.sourceEntryId
              ? { sourceEntryId: promptExecution.sourceEntryId }
              : {}),
            preferFork: promptExecution.preferFork,
          },
        });
        if (signal.aborted) await handle.cancel();
        return handle;
      },
      onEvent: (event) => {
        broadcastTaskEvent(event);
        if (
          this.#reloadPending
          && (
            event.type === "task.succeeded"
            || event.type === "task.failed"
            || event.type === "task.cancelled"
            || event.type === "task.interrupted"
          )
        ) {
          setImmediate(() => {
            void this.#reloadRuntimeWhenIdle();
          });
        }
      },
    });
    this.#resumeLatest = resumeLatest;
    this.#recentWorkspaces = recentWorkspaces;
    this.#settings.subscribe((snapshot) => {
      applyNativeSettings(snapshot);
      broadcastSettings(snapshot);
    });
  }

  static async create(
    workspace?: string,
    options: { resumeLatest?: boolean } = {},
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
      await listRecentWorkspaces(paths.configFile),
      options.resumeLatest === true,
    );
    instance.#trusted = workspace
      ? await isWorkspaceTrusted(paths.configFile, workspace)
      : true;
    if (instance.#trusted) {
      await instance.#startRuntime();
    }
    return instance;
  }

  get workspacePath(): string | undefined {
    return this.#workspace;
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

  async sendPrompt(prompt: string): Promise<TaskSubmissionResult> {
    const trimmed = prompt.trim();
    if (trimmed.startsWith("/")) {
      return this.#run(async (runtime) => runtime.prompt(trimmed));
    }
    if (!this.#trusted) {
      return { ok: false, error: "请先信任当前工作区" };
    }
    const runtime = this.#runtime;
    if (!runtime) {
      return { ok: false, error: "Agent Runtime 尚未就绪" };
    }
    try {
      const snapshot = runtime.snapshot();
      const sessionId = snapshot.sessionId;
      if (!sessionId) throw new Error("当前会话尚未就绪");
      const hasPending = this.#tasks.listTasks({
        statuses: ["queued", "running", "waiting_approval", "waiting_user"],
        limit: 500,
      }).some((task) => task.sessionId === sessionId || !task.sessionId);
      const preferFork = snapshot.streaming || hasPending;
      const context = runtime.capturePromptContext(preferFork);
      const task = this.#tasks.submitPrompt({
        title: createTaskTitle(trimmed),
        prompt: trimmed,
        kind: preferFork ? "background" : "interactive",
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
        },
      });
      return { ok: true, task };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async abort(): Promise<CommandResult> {
    const sessionId = this.#runtime?.snapshot().sessionId;
    const task = sessionId
      ? this.#tasks.currentTaskForSession(sessionId)
      : undefined;
    return task
      ? this.cancelTask(task.id)
      : this.#run(async (runtime) => runtime.abort());
  }

  listTasks(input: TaskListInput) {
    return this.#tasks.listTasks({
      limit: input.limit,
      ...(input.statuses ? { statuses: input.statuses } : {}),
    });
  }

  getTask(taskId: string) {
    return this.#tasks.getTask(taskId) ?? null;
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

  respondToApproval(
    requestId: string,
    decision: "allow_once" | "allow_session" | "allow_project" | "deny",
  ): CommandResult {
    return this.#runtime?.respondToApproval(requestId, decision)
      ? { ok: true }
      : { ok: false, error: "审批请求已失效或不存在" };
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
    await this.#tasks.dispose();
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
    this.#tasks.pause();
    await this.#runtime?.dispose();
    this.#runtime = undefined;
    await this.#startRuntime();
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
            this.#reloadPending = false;
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
  controller = await DesktopController.create(workspace, {
    resumeLatest: process.argv.includes("--resume"),
  });
  registerIpcHandlers();
  await configureAppProtocol();
  createWindow();
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
    const { prompt } = sendPromptInputSchema.parse(raw);
    return taskSubmissionResultSchema.parse(await controller?.sendPrompt(prompt));
  });
  ipcMain.handle(IPC_CHANNELS.abortRun, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await controller?.abort());
  });
  ipcMain.handle(IPC_CHANNELS.listTasks, (event, raw) => {
    assertTrustedSender(event);
    const input = taskListInputSchema.parse(raw ?? {});
    return taskRecordSchema.array().parse(controller?.listTasks(input) ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.getTask, (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return taskDetailSchema.nullable().parse(controller?.getTask(taskId) ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.cancelTask, async (event, raw) => {
    assertTrustedSender(event);
    const { taskId } = taskIdInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.cancelTask(taskId));
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
    const input = approvalDecisionInputSchema.parse(raw);
    return commandResultSchema.parse(
      controller?.respondToApproval(input.requestId, input.decision)
        ?? { ok: false, error: "Runtime 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.revokeWorkspaceTrust, async (event) => {
    assertTrustedSender(event);
    const result = await controller?.revokeTrust()
      ?? { ok: false, error: "Runtime 尚未就绪" };
    if (result.ok) {
      await controller?.dispose();
      controller = await DesktopController.create();
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
    await controller?.dispose();
    controller = undefined;
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
    await controller?.dispose();
    controller = undefined;
    await moveToTrashOrBackup(target);
    await ensureDekiDirectories(paths);
    controller = await DesktopController.create(workspace);
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
    await controller?.dispose();
    controller = await DesktopController.create(workspace);
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

app.on("before-quit", () => {
  quitting = true;
  void controller?.dispose();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
