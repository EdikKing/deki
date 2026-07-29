import { contextBridge, ipcRenderer } from "electron";
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
  memoryRecordSchema,
  memoryMutationSchema,
  memoryListInputSchema,
  memoryMoveInputSchema,
  mcpServerEditorSchema,
  mcpToolSummarySchema,
  modelProviderInputSchema,
  modelProviderCatalogResultSchema,
  optimizePromptInputSchema,
  optimizePromptResultSchema,
  redactedModelProviderSchema,
  conversationMessageSchema,
  forkSessionInputSchema,
  renameSessionInputSchema,
  sessionIdInputSchema,
  sessionHistoryStateSchema,
  sessionSearchInputSchema,
  sessionSummarySchema,
  skillStatusSchema,
  skillActionInputSchema,
  taskDetailSchema,
  taskEventSchema,
  taskIdInputSchema,
  taskListInputSchema,
  taskSummarySchema,
  taskSubmissionResultSchema,
  promptSubmissionOptionsSchema,
  approvePlanInputSchema,
  planDetailSchema,
  planEventSchema,
  planIdInputSchema,
  planListInputSchema,
  planSummarySchema,
  revisePlanInputSchema,
  replanInputSchema,
  taskInputResponseSchema,
  integrationDecisionInputSchema,
  artifactChunkInputSchema,
  artifactChunkSchema,
  settingsPatchSchema,
  settingsScopeSchema,
  settingsSnapshotSchema,
  updateSessionConfigurationInputSchema,
  type DekiDesktopApi,
} from "@deki-ai/shared";

const api: DekiDesktopApi = {
  async getBootstrapState() {
    return bootstrapStateSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getBootstrapState),
    );
  },
  async chooseWorkspace() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.chooseWorkspace),
    );
  },
  async openWorkspace(workspace) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.openWorkspace, { workspace }),
    );
  },
  async openGeneralChat() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.openGeneralChat),
    );
  },
  async trustWorkspace() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.trustWorkspace),
    );
  },
  async sendPrompt(prompt, options) {
    const parsedOptions = promptSubmissionOptionsSchema.parse(options ?? {});
    return taskSubmissionResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.sendPrompt, {
        prompt,
        attachments: parsedOptions.attachments,
        mode: parsedOptions.mode,
        interactionMode: parsedOptions.interactionMode,
      }),
    );
  },
  async optimizePrompt(prompt) {
    const input = optimizePromptInputSchema.parse({ prompt });
    return optimizePromptResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.optimizePrompt, input),
    );
  },
  async abortRun() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.abortRun),
    );
  },
  async listTasks(input) {
    return taskSummarySchema.array().parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.listTasks,
        taskListInputSchema.parse(input ?? {}),
      ),
    );
  },
  async getTask(taskId) {
    return taskDetailSchema.nullable().parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.getTask,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async cancelTask(taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.cancelTask,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async pauseTask(taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.pauseTask,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async resumeTask(taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.resumeTask,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async retryTask(taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.retryTask,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async promoteTask(taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.promoteTask,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async openTaskSession(taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.openTaskSession,
        taskIdInputSchema.parse({ taskId }),
      ),
    );
  },
  async respondToTaskInput(taskId, requestId, value) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.respondToTaskInput,
        taskInputResponseSchema.parse({ taskId, requestId, value }),
      ),
    );
  },
  async respondToIntegration(taskId, requestId, decision) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.respondToIntegration,
        integrationDecisionInputSchema.parse({ taskId, requestId, decision }),
      ),
    );
  },
  async readArtifactChunk(artifactId, offset, limit) {
    return artifactChunkSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.readArtifactChunk,
        artifactChunkInputSchema.parse({ artifactId, offset, limit }),
      ),
    );
  },
  async listPlans(input) {
    return planSummarySchema.array().parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.listPlans,
        planListInputSchema.parse(input ?? {}),
      ),
    );
  },
  async getPlan(planId) {
    return planDetailSchema.nullable().parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.getPlan,
        planIdInputSchema.parse({ planId }),
      ),
    );
  },
  async approvePlan(planId, revision) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.approvePlan,
        approvePlanInputSchema.parse({ planId, revision }),
      ),
    );
  },
  async requestPlanRevision(planId, feedback, options) {
    return taskSubmissionResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.revisePlan,
        revisePlanInputSchema.parse({
          planId,
          feedback,
          mode: options?.mode ?? "foreground",
        }),
      ),
    );
  },
  async requestPlanReplan(planId, reason, affectedStepIds) {
    return taskSubmissionResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.replan,
        replanInputSchema.parse({
          planId,
          reason,
          affectedStepIds: affectedStepIds ?? [],
        }),
      ),
    );
  },
  async abandonPlan(planId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.abandonPlan,
        planIdInputSchema.parse({ planId }),
      ),
    );
  },
  async openPlanSession(planId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.openPlanSession,
        planIdInputSchema.parse({ planId }),
      ),
    );
  },
  async newSession() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.newSession),
    );
  },
  async listSessions(query) {
    return sessionSummarySchema.array().parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.listSessions,
        sessionSearchInputSchema.parse({ query: query ?? "" }),
      ),
    );
  },
  async getSessionHistory() {
    return conversationMessageSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getSessionHistory),
    );
  },
  async getSessionHistoryState() {
    return sessionHistoryStateSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getSessionHistoryState),
    );
  },
  async forkSession(entryId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.forkSession,
        forkSessionInputSchema.parse({ entryId }),
      ),
    );
  },
  async switchSession(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.switchSession,
        sessionIdInputSchema.parse({ id }),
      ),
    );
  },
  async renameSession(id, name) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.renameSession,
        renameSessionInputSchema.parse({ id, name }),
      ),
    );
  },
  async deleteSession(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.deleteSession,
        sessionIdInputSchema.parse({ id }),
      ),
    );
  },
  async remember(content, scope) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.remember, {
        content,
        ...(scope ? { scope } : {}),
      }),
    );
  },
  async listMemories(scope, query) {
    const result = await ipcRenderer.invoke(
      IPC_CHANNELS.listMemories,
      memoryListInputSchema.parse({
        ...(scope ? { scope } : {}),
        ...(query ? { query } : {}),
      }),
    );
    return memoryRecordSchema.array().parse(result);
  },
  async selectModel(provider, id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.selectModel, { provider, id }),
    );
  },
  async updateSessionConfiguration(input) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.updateSessionConfiguration,
        updateSessionConfigurationInputSchema.parse(input),
      ),
    );
  },
  async getSettings() {
    return settingsSnapshotSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getSettings),
    );
  },
  async updateSettings(scope, patch, expectedRevision) {
    return settingsSnapshotSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.updateSettings, {
        scope: settingsScopeSchema.parse(scope),
        patch: settingsPatchSchema.parse(patch),
        expectedRevision,
      }),
    );
  },
  async resetSettings(scope, keys, expectedRevision) {
    return settingsSnapshotSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.resetSettings, {
        scope: settingsScopeSchema.parse(scope),
        ...(keys ? { keys } : {}),
        expectedRevision,
      }),
    );
  },
  async listModelProviders() {
    return redactedModelProviderSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listModelProviders),
    );
  },
  async upsertModelProvider(provider) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.upsertModelProvider,
        modelProviderInputSchema.parse(provider),
      ),
    );
  },
  async removeModelProvider(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.removeModelProvider, { id }),
    );
  },
  async testModelProvider(provider) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.testModelProvider,
        modelProviderInputSchema.parse(provider),
      ),
    );
  },
  async fetchModelProviderModels(provider) {
    return modelProviderCatalogResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.fetchModelProviderModels,
        modelProviderInputSchema.parse(provider),
      ),
    );
  },
  async respondToApproval(requestId, decision, taskId) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.respondToApproval, {
        requestId,
        decision,
        ...(taskId ? { taskId } : {}),
      }),
    );
  },
  async revokeWorkspaceTrust() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.revokeWorkspaceTrust),
    );
  },
  async exportDiagnostics() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.exportDiagnostics),
    );
  },
  async openDataDirectory() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.openDataDirectory),
    );
  },
  async openThirdPartyLicenses() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.openThirdPartyLicenses),
    );
  },
  async checkForUpdates() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
    );
  },
  async listMcpServers() {
    return mcpServerEditorSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listMcpServers),
    );
  },
  async upsertMcpServer(server) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.upsertMcpServer,
        mcpServerEditorSchema.parse(server),
      ),
    );
  },
  async removeMcpServer(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.removeMcpServer, { id }),
    );
  },
  async reloadMcpServers() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.reloadMcpServers),
    );
  },
  async startMcpServer(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.startMcpServer, { id }),
    );
  },
  async stopMcpServer(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.stopMcpServer, { id }),
    );
  },
  async restartMcpServer(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.restartMcpServer, { id }),
    );
  },
  async testMcpServer(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.testMcpServer, { id }),
    );
  },
  async listMcpServerTools(id) {
    return mcpToolSummarySchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listMcpServerTools, { id }),
    );
  },
  async listSkills() {
    return skillStatusSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listSkills),
    );
  },
  async reloadSkills() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.reloadSkills),
    );
  },
  async updateSkill(path) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.updateSkill,
        skillActionInputSchema.parse({ path }),
      ),
    );
  },
  async pinSkillVersion(path, version) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.pinSkillVersion,
        skillActionInputSchema.parse({
          path,
          pinnedVersion: version ?? null,
        }),
      ),
    );
  },
  async updateMemory(input) {
    return memoryRecordSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.updateMemory,
        memoryMutationSchema.parse(input),
      ),
    );
  },
  async deleteMemory(id, scope) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.deleteMemory, {
        id,
        ...(scope ? { scope } : {}),
      }),
    );
  },
  async clearMemoryScope(scope) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.clearMemoryScope,
        memoryListInputSchema.parse({ scope }),
      ),
    );
  },
  async moveMemory(id, from, to) {
    return memoryRecordSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.moveMemory,
        memoryMoveInputSchema.parse({ id, from, to }),
      ),
    );
  },
  async getDataUsage() {
    return dataUsageSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getDataUsage),
    );
  },
  async listAuditRecords() {
    return auditRecordSummarySchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listAuditRecords),
    );
  },
  async listGitCheckpoints() {
    return gitCheckpointSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listGitCheckpoints),
    );
  },
  async createGitCheckpoint(message) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.createGitCheckpoint,
        gitCheckpointCreateInputSchema.parse({ ...(message ? { message } : {}) }),
      ),
    );
  },
  async previewGitCheckpoint(id) {
    return String(await ipcRenderer.invoke(
      IPC_CHANNELS.previewGitCheckpoint,
      gitCheckpointIdInputSchema.parse({ id }),
    ));
  },
  async restoreGitCheckpoint(id) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.restoreGitCheckpoint,
        gitCheckpointIdInputSchema.parse({ id }),
      ),
    );
  },
  async factoryReset() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.factoryReset),
    );
  },
  async exportData() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.exportData),
    );
  },
  async importData() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.importData),
    );
  },
  async clearData(category) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.clearData,
        clearDataInputSchema.parse({ category }),
      ),
    );
  },
  subscribeSettings(listener) {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      listener(settingsSnapshotSchema.parse(raw));
    };
    ipcRenderer.on(IPC_CHANNELS.settingsChanged, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsChanged, handler);
  },
  subscribeAgentEvents(listener) {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      listener(agentEventSchema.parse(raw));
    };
    ipcRenderer.on(IPC_CHANNELS.agentEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler);
  },
  subscribeTaskEvents(listener) {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      listener(taskEventSchema.parse(raw));
    };
    ipcRenderer.on(IPC_CHANNELS.taskEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.taskEvent, handler);
  },
  subscribePlanEvents(listener) {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      listener(planEventSchema.parse(raw));
    };
    ipcRenderer.on(IPC_CHANNELS.planEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.planEvent, handler);
  },
  subscribeOpenTask(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, taskId: unknown) => {
      if (typeof taskId === "string") listener(taskId);
    };
    ipcRenderer.on(IPC_CHANNELS.openTask, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.openTask, wrapped);
  },
  subscribeOpenPlan(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, planId: unknown) => {
      if (typeof planId === "string") listener(planId);
    };
    ipcRenderer.on(IPC_CHANNELS.openPlan, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.openPlan, wrapped);
  },
};

contextBridge.exposeInMainWorld("deki", api);
