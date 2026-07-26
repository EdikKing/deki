import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { DekiAgentRuntime } from "@deki-ai/agent-runtime";
import {
  ensureDekiDirectories,
  formatError,
  getDekiPaths,
  isWorkspaceTrusted,
  listRecentWorkspaces,
  readMcpConfig,
  revokeWorkspaceTrust,
  resolveWorkspace,
  trustWorkspace,
  writeMcpConfig,
  workspaceId,
  type DekiPaths,
} from "@deki-ai/config";
import { McpManager } from "@deki-ai/mcp-manager";
import { MemoryEngine } from "@deki-ai/memory-engine";
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
  approvalDecisionInputSchema,
  bootstrapStateSchema,
  commandResultSchema,
  clearDataInputSchema,
  dataUsageSchema,
  IPC_CHANNELS,
  mcpServerEditorSchema,
  memoryMutationSchema,
  openWorkspaceInputSchema,
  modelProviderInputSchema,
  redactedModelProviderSchema,
  rememberInputSchema,
  removeModelProviderInputSchema,
  resetSettingsInputSchema,
  selectModelInputSchema,
  sendPromptInputSchema,
  settingsSnapshotSchema,
  updateSettingsInputSchema,
  type AgentEvent,
  type BootstrapState,
  type CommandResult,
  type McpServerEditor,
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
  ) {
    this.#workspace = workspace;
    this.#runtimeWorkspace = runtimeWorkspace;
    this.#scopeId = scopeId;
    this.#projectFeatures = workspace !== undefined;
    this.#paths = paths;
    this.#memory = memory;
    this.#settings = settings;
    this.#models = new ModelConfigStore(paths.modelsFile);
    this.#recentWorkspaces = recentWorkspaces;
    this.#settings.subscribe((snapshot) => {
      applyNativeSettings(snapshot);
      broadcastSettings(snapshot);
    });
  }

  static async create(workspace?: string): Promise<DesktopController> {
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
    applyNativeSettings(settingsSnapshot);
    const instance = new DesktopController(
      workspace,
      runtimeWorkspace,
      scopeId,
      paths,
      memory,
      settings,
      await listRecentWorkspaces(paths.configFile),
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
      memories: this.#projectFeatures
        ? this.#memory.listProjectMemories(this.#scopeId)
        : [],
      recalledMemories: snapshot?.recalledMemories ?? [],
      mcpServers: this.#mcp.getStatuses(),
      skills: snapshot?.skills ?? [],
      diagnostics: [...this.#diagnostics, ...(snapshot?.diagnostics ?? [])],
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

  async sendPrompt(prompt: string): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.prompt(prompt));
  }

  async abort(): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.abort());
  }

  async newSession(): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.newSession());
  }

  async remember(content: string): Promise<CommandResult> {
    return this.#run(async (runtime) => {
      runtime.remember(content);
    });
  }

  async selectModel(provider: string, id: string): Promise<CommandResult> {
    return this.#run(async (runtime) => runtime.selectModel(provider, id));
  }

  getSettings(): SettingsSnapshot {
    return this.#settings.snapshot();
  }

  async updateSettings(
    scope: SettingsScope,
    patch: SettingsPatch,
    expectedRevision: string,
  ): Promise<SettingsSnapshot> {
    if (!this.#workspace && scope !== "global") {
      throw new Error("普通会话只能修改全局设置");
    }
    const before = this.#settings.snapshot();
    const snapshot = await this.#settings.update(scope, patch, expectedRevision);
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
    if (!this.#workspace && scope !== "global") {
      throw new Error("普通会话只能修改全局设置");
    }
    const before = this.#settings.snapshot();
    const snapshot = await this.#settings.reset(scope, keys, expectedRevision);
    if (requiresRuntimeReload(before, snapshot)) {
      await this.#reloadRuntimeWhenIdle();
    }
    return snapshot;
  }

  listModelProviders() {
    return this.#models.list();
  }

  async upsertModelProvider(input: ModelProviderInput): Promise<CommandResult> {
    if (this.#runtime?.snapshot().streaming) {
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
      const confirmation = owner
        ? await dialog.showMessageBox(owner, {
            type: "question",
            title: "确认导入",
            message: "导入全局设置和记忆？",
            detail: `设置分类 ${Object.keys(globalSettings).length} 个，记忆 ${memories.length} 条。API Key 不会从导出文件导入。`,
            buttons: ["取消", "导入"],
            defaultId: 0,
            cancelId: 0,
          })
        : { response: 1 };
      if (confirmation.response !== 1) return { ok: true };
      const snapshot = this.#settings.snapshot();
      await this.#settings.update("global", globalSettings, snapshot.revision);
      const scope = this.#projectFeatures ? "project" : "user";
      const scopeId = this.#projectFeatures ? this.#scopeId : "user";
      for (const candidate of memories) {
        if (!isRecord(candidate) || typeof candidate.content !== "string") continue;
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
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  listMemories() {
    const scope = this.#projectFeatures ? "project" : "user";
    const scopeId = this.#projectFeatures ? this.#scopeId : "user";
    if (!this.#projectFeatures && !this.#settings.snapshot().effective.memory.userMemoryEnabled) {
      return [];
    }
    return [
      ...this.#memory.listMemories(scope, scopeId),
      ...this.#memory.listMemories(scope, scopeId, { status: "pending" }),
    ];
  }

  async listMcpServers(): Promise<McpServerEditor[]> {
    if (!this.#workspace || !this.#trusted) return [];
    const config = await readMcpConfig(this.#workspace);
    return Object.entries(config.mcpServers).map(([id, server]) => ({
      id,
      command: server.command,
      args: server.args,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      enabled: server.enabled,
    }));
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
      config.mcpServers[server.id] = {
        command: server.command,
        args: server.args,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        enabled: server.enabled,
      };
      await writeMcpConfig(this.#workspace, config);
      await this.#reloadRuntimeWhenIdle();
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
      await this.#reloadRuntimeWhenIdle();
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
      await this.#reloadRuntimeWhenIdle();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }

  async updateMemory(input: {
    id: string;
    content?: string;
    pinned?: boolean;
    status?: "active" | "pending" | "superseded" | "archived";
  }) {
    const scope = this.#projectFeatures ? "project" : "user";
    const scopeId = this.#projectFeatures ? this.#scopeId : "user";
    return this.#memory.updateMemory(scope, scopeId, input.id, {
      ...(input.content ? { content: input.content } : {}),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  deleteMemory(id: string): CommandResult {
    const scope = this.#projectFeatures ? "project" : "user";
    const scopeId = this.#projectFeatures ? this.#scopeId : "user";
    return this.#memory.deleteMemory(scope, scopeId, id)
      ? { ok: true }
      : { ok: false, error: "未找到记忆" };
  }

  async getDataUsage() {
    const [sessionsBytes, memoryBytes, logsBytes, configBytes] = await Promise.all([
      directorySize(this.#paths.sessionsRoot),
      directorySize(resolve(this.#paths.memoryDatabase, "..")),
      directorySize(this.#paths.logsRoot),
      Promise.all([
        fileSize(this.#paths.configFile),
        fileSize(this.#paths.settingsFile),
        fileSize(this.#paths.modelsFile),
        directorySize(this.#paths.projectsRoot),
      ]).then((values) => values.reduce((sum, value) => sum + value, 0)),
    ]);
    return {
      totalBytes: sessionsBytes + memoryBytes + logsBytes + configBytes,
      sessionsBytes,
      memoryBytes,
      logsBytes,
      configBytes,
    };
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
        persistProjectGrant: async (category) => this.#persistProjectGrant(category),
        onEvent: (event) => {
          broadcastEvent(event);
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

  async #persistProjectGrant(category: PermissionCategory): Promise<void> {
    if (!this.#workspace) return;
    const snapshot = this.#settings.snapshot();
    await this.#settings.update("projectLocal", {
      permissions: {
        policies: {
          ...snapshot.effective.permissions.policies,
          [category]: "allow",
        },
      },
    }, snapshot.revision);
  }
}

async function bootstrap(): Promise<void> {
  const workspace = await resolveStartupWorkspace(process.argv);
  controller = await DesktopController.create(workspace);
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
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
      return commandResultSchema.parse(await switchToWorkspace(workspace));
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
    return commandResultSchema.parse(await controller?.sendPrompt(prompt));
  });
  ipcMain.handle(IPC_CHANNELS.abortRun, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await controller?.abort());
  });
  ipcMain.handle(IPC_CHANNELS.newSession, async (event) => {
    assertTrustedSender(event);
    return commandResultSchema.parse(await controller?.newSession());
  });
  ipcMain.handle(IPC_CHANNELS.remember, async (event, raw) => {
    assertTrustedSender(event);
    const { content } = rememberInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.remember(content));
  });
  ipcMain.handle(IPC_CHANNELS.listMemories, (event) => {
    assertTrustedSender(event);
    return controller?.listMemories() ?? [];
  });
  ipcMain.handle(IPC_CHANNELS.selectModel, async (event, raw) => {
    assertTrustedSender(event);
    const { provider, id } = selectModelInputSchema.parse(raw);
    return commandResultSchema.parse(await controller?.selectModel(provider, id));
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
  ipcMain.handle(IPC_CHANNELS.updateMemory, (event, raw) => {
    assertTrustedSender(event);
    if (!controller) throw new Error("Memory Engine 尚未就绪");
    const input = memoryMutationSchema.parse(raw);
    return controller.updateMemory({
      id: input.id,
      ...(input.content ? { content: input.content } : {}),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.status ? { status: input.status } : {}),
    });
  });
  ipcMain.handle(IPC_CHANNELS.deleteMemory, (event, raw) => {
    assertTrustedSender(event);
    const { id } = removeModelProviderInputSchema.parse(raw);
    return commandResultSchema.parse(
      controller?.deleteMemory(id) ?? { ok: false, error: "Memory Engine 尚未就绪" },
    );
  });
  ipcMain.handle(IPC_CHANNELS.getDataUsage, async (event) => {
    assertTrustedSender(event);
    return dataUsageSchema.parse(await controller?.getDataUsage() ?? {
      totalBytes: 0,
      sessionsBytes: 0,
      memoryBytes: 0,
      logsBytes: 0,
      configBytes: 0,
    });
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

async function switchToWorkspace(workspace: string): Promise<CommandResult> {
  try {
    await controller?.dispose();
    controller = await DesktopController.create(workspace);
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

function broadcastSettings(raw: SettingsSnapshot): void {
  const settings = settingsSnapshotSchema.parse(raw);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.settingsChanged, settings);
    }
  }
}

function applyNativeSettings(snapshot: SettingsSnapshot): void {
  app.setLoginItemSettings({ openAtLogin: snapshot.effective.general.launchAtLogin });
}

function requiresRuntimeReload(before: SettingsSnapshot, after: SettingsSnapshot): boolean {
  return JSON.stringify({
    models: before.effective.models,
    mcp: before.effective.mcp,
    skills: before.effective.skills,
    memory: before.effective.memory,
    permissions: before.effective.permissions,
  }) !== JSON.stringify({
    models: after.effective.models,
    mcp: after.effective.mcp,
    skills: after.effective.skills,
    memory: after.effective.memory,
    permissions: after.effective.permissions,
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

function isMemoryType(
  value: unknown,
): value is "preference" | "fact" | "decision" | "experience" | "task-state" {
  return ["preference", "fact", "decision", "experience", "task-state"].includes(
    String(value),
  );
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
    type: "message.delta",
    eventId: crypto.randomUUID(),
    delta: "这是模拟的流式响应。",
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
  void controller?.dispose();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
