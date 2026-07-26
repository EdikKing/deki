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
  redactedModelProviderSchema,
  conversationMessageSchema,
  renameSessionInputSchema,
  sessionIdInputSchema,
  sessionSummarySchema,
  skillStatusSchema,
  settingsPatchSchema,
  settingsScopeSchema,
  settingsSnapshotSchema,
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
  async trustWorkspace() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.trustWorkspace),
    );
  },
  async sendPrompt(prompt) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.sendPrompt, { prompt }),
    );
  },
  async abortRun() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.abortRun),
    );
  },
  async newSession() {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.newSession),
    );
  },
  async listSessions() {
    return sessionSummarySchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.listSessions),
    );
  },
  async getSessionHistory() {
    return conversationMessageSchema.array().parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getSessionHistory),
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
  async respondToApproval(requestId, decision) {
    return commandResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.respondToApproval, {
        requestId,
        decision,
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
};

contextBridge.exposeInMainWorld("deki", api);
