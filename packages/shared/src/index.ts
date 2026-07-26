import { z } from "zod";

export const permissionPolicySchema = z.enum(["allow", "ask", "deny"]);
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;
export const permissionCategorySchema = z.enum([
  "workspace.read", "workspace.write", "workspace.delete", "shell.safe",
  "shell.unknown", "dependencies.install", "git.commit", "git.push",
  "outsideWorkspace", "sensitiveFiles", "privileged", "network",
  "mcp.read", "mcp.write",
]);
export type PermissionCategory = z.infer<typeof permissionCategorySchema>;

const generalSchema = z.object({
  locale: z.enum(["system", "zh-CN", "en-US"]),
  startupMode: z.enum(["general", "last-session"]),
  restoreSession: z.boolean(),
  closeBehavior: z.enum(["quit", "keep-running"]),
  launchAtLogin: z.boolean(),
  checkUpdates: z.boolean(),
}).strict();
const appearanceSchema = z.object({
  theme: z.enum(["system", "dark", "light"]),
  accent: z.enum(["indigo", "blue", "violet", "emerald"]),
  fontSize: z.number().int().min(11).max(22),
  codeFont: z.string(),
  density: z.enum(["compact", "comfortable"]),
  sidebarWidth: z.number().int().min(200).max(420),
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
}).strict();
const modelDefaultsSchema = z.object({
  generalModel: z.string(),
  projectModel: z.string(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  maxOutputTokens: z.number().int(),
  timeoutMs: z.number().int(),
  maxRetries: z.number().int(),
}).strict();
const agentSettingsSchema = z.object({
  autoNameSessions: z.boolean(),
  compactionEnabled: z.boolean(),
  compactionThreshold: z.number().int(),
  maxConcurrentRuns: z.number().int(),
  showThinkingSummary: z.boolean(),
  sessionRetentionDays: z.number().int(),
}).strict();
const workspaceSettingsSchema = z.object({
  contextIgnore: z.array(z.string()),
  contextFiles: z.array(z.string()),
  detectGit: z.boolean(),
  gitCheckpointBeforeWrite: z.boolean(),
  loadProjectMemory: z.boolean(),
}).strict();
const permissionsSettingsSchema = z.object({
  policies: z.record(permissionCategorySchema, permissionPolicySchema),
  approvalTimeoutMs: z.number().int(),
  auditRetentionDays: z.number().int(),
  showDiffAfterWrite: z.boolean(),
}).strict();
const mcpSettingsSchema = z.object({
  startEnabledServers: z.boolean(),
  startupTimeoutMs: z.number().int(),
  callTimeoutMs: z.number().int(),
  toolPolicies: z.record(z.string(), permissionPolicySchema),
}).strict();
const skillsSettingsSchema = z.object({
  enabled: z.boolean(),
  globalPaths: z.array(z.string()),
  disabledNames: z.array(z.string()),
}).strict();
const memorySettingsSchema = z.object({
  userMemoryEnabled: z.boolean(),
  projectMemoryEnabled: z.boolean(),
  automaticCandidates: z.boolean(),
  candidateConfirmationRequired: z.literal(true),
  userRecallLimit: z.number().int(),
  userCharacterBudget: z.number().int(),
  projectRecallLimit: z.number().int(),
  projectCharacterBudget: z.number().int(),
  sensitiveFilter: z.literal(true),
}).strict();
const privacySettingsSchema = z.object({
  telemetry: z.literal(false),
  logRetentionDays: z.number().int(),
  includeAuditDiffsInExport: z.literal(false),
}).strict();
const advancedSettingsSchema = z.object({
  logLevel: z.enum(["error", "warn", "info", "debug"]),
  proxyUrl: z.string(),
  customCaPath: z.string(),
  toolOutputLimitBytes: z.number().int(),
  experimentalFeatures: z.boolean(),
}).strict();
const updatesSettingsSchema = z.object({
  enabled: z.boolean(),
  channel: z.enum(["stable", "beta"]),
  sourceConfigured: z.literal(false),
}).strict();
export const settingsSchema = z.object({
  general: generalSchema,
  appearance: appearanceSchema,
  models: modelDefaultsSchema,
  agent: agentSettingsSchema,
  workspace: workspaceSettingsSchema,
  permissions: permissionsSettingsSchema,
  mcp: mcpSettingsSchema,
  skills: skillsSettingsSchema,
  memory: memorySettingsSchema,
  privacy: privacySettingsSchema,
  advanced: advancedSettingsSchema,
  updates: updatesSettingsSchema,
}).strict();
export type DekiSettings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = z.object({
  general: generalSchema.partial().optional(),
  appearance: appearanceSchema.partial().optional(),
  models: modelDefaultsSchema.partial().optional(),
  agent: agentSettingsSchema.partial().optional(),
  workspace: workspaceSettingsSchema.partial().optional(),
  permissions: permissionsSettingsSchema.partial().optional(),
  mcp: mcpSettingsSchema.partial().optional(),
  skills: skillsSettingsSchema.partial().optional(),
  memory: memorySettingsSchema.partial().optional(),
  privacy: privacySettingsSchema.partial().optional(),
  advanced: advancedSettingsSchema.partial().optional(),
  updates: updatesSettingsSchema.partial().optional(),
}).strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export const settingsScopeSchema = z.enum(["global", "projectShared", "projectLocal", "session"]);
export type SettingsScope = z.infer<typeof settingsScopeSchema>;
export const settingsSnapshotSchema = z.object({
  revision: z.string(),
  effective: settingsSchema,
  global: settingsPatchSchema,
  projectShared: settingsPatchSchema,
  projectLocal: settingsPatchSchema,
  session: settingsPatchSchema,
  sources: z.record(z.string(), z.enum(["default", "global", "projectShared", "projectLocal", "session"])),
  diagnostics: z.array(z.string()),
});
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;

export const modelDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  api: z.string().trim().min(1).optional(),
  baseUrl: z.string().url().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const modelProviderInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).optional(),
  baseUrl: z.string().url().optional(),
  api: z.string().trim().min(1).optional(),
  apiKey: z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep") }),
    z.object({ action: z.literal("clear") }),
    z.object({ action: z.literal("set"), value: z.string().min(1) }),
  ]),
  authHeader: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(modelDefinitionSchema).min(1),
}).strict();
export type ModelProviderInput = z.infer<typeof modelProviderInputSchema>;
export const redactedModelProviderSchema = modelProviderInputSchema
  .omit({ apiKey: true })
  .extend({ hasApiKey: z.boolean() });
export type RedactedModelProvider = z.infer<typeof redactedModelProviderSchema>;

export const DEKI_VERSION = "0.0.0";

export const modelSummarySchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
});

export type ModelSummary = z.infer<typeof modelSummarySchema>;

export const sessionSummarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  firstMessage: z.string(),
  current: z.boolean(),
}).strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
}).strict();
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const memorySourceSchema = z.object({
  kind: z.enum(["user_command", "agent_candidate", "migration"]),
  sessionId: z.string().optional(),
  detail: z.string().optional(),
});

export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryRecordSchema = z.object({
  id: z.string(),
  scope: z.enum(["user", "workspace", "project", "branch", "task"]),
  scopeId: z.string(),
  type: z.enum(["preference", "fact", "decision", "experience", "task-state"]),
  content: z.string(),
  source: memorySourceSchema,
  confidence: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  pinned: z.boolean(),
  sensitive: z.boolean(),
  status: z.enum(["active", "pending", "superseded", "archived"]),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const serverStatusSchema = z.object({
  id: z.string(),
  state: z.enum(["stopped", "starting", "ready", "error"]),
  toolCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const bootstrapStateSchema = z.object({
  workspace: z.string().optional(),
  trusted: z.boolean(),
  ready: z.boolean(),
  streaming: z.boolean(),
  sessionId: z.string().optional(),
  models: z.array(modelSummarySchema),
  selectedModel: modelSummarySchema.optional(),
  memories: z.array(memoryRecordSchema),
  recalledMemories: z.array(memoryRecordSchema),
  mcpServers: z.array(serverStatusSchema),
  skills: z.array(z.string()),
  diagnostics: z.array(z.string()),
  recentWorkspaces: z.array(z.string()).default([]),
});

export type BootstrapState = z.infer<typeof bootstrapStateSchema>;

const eventBase = {
  eventId: z.string(),
  timestamp: z.string(),
  sessionId: z.string().optional(),
} as const;

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("session.ready"),
    model: modelSummarySchema.optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("message.delta"),
    delta: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("message.completed"),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.started"),
    callId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.updated"),
    callId: z.string(),
    toolName: z.string(),
    update: z.unknown(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.completed"),
    callId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    result: z.unknown(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("memory.saved"),
    memory: memoryRecordSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal("memory.used"),
    memories: z.array(memoryRecordSchema),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.completed"),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.failed"),
    error: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("diagnostic"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("approval.requested"),
    requestId: z.string(),
    category: permissionCategorySchema,
    title: z.string(),
    description: z.string(),
    details: z.unknown(),
    diff: z.string().optional(),
    expiresAt: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("approval.resolved"),
    requestId: z.string(),
    decision: z.enum(["allow_once", "allow_session", "allow_project", "deny"]),
  }),
  z.object({
    ...eventBase,
    type: z.literal("diff.available"),
    callId: z.string(),
    diff: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("audit.recorded"),
    recordId: z.string(),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export const trustWorkspaceInputSchema = z.object({
  workspace: z.string().min(1),
});

export const sendPromptInputSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
});

export const rememberInputSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
});

export const selectModelInputSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export const sessionIdInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
}).strict();
export const renameSessionInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120),
}).strict();
export const openWorkspaceInputSchema = z.object({
  workspace: z.string().min(1).max(10_000),
}).strict();

export const updateSettingsInputSchema = z.object({
  scope: settingsScopeSchema,
  patch: settingsPatchSchema,
  expectedRevision: z.string(),
}).strict();

export const resetSettingsInputSchema = z.object({
  scope: settingsScopeSchema,
  keys: z.array(z.string()).optional(),
  expectedRevision: z.string(),
}).strict();

export const removeModelProviderInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const approvalDecisionInputSchema = z.object({
  requestId: z.string(),
  decision: z.enum(["allow_once", "allow_session", "allow_project", "deny"]),
}).strict();

export const updatePermissionInputSchema = z.object({
  category: permissionCategorySchema,
  policy: permissionPolicySchema,
  scope: z.enum(["global", "projectLocal"]),
  expectedRevision: z.string(),
}).strict();

export const mcpServerEditorSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  enabled: z.boolean(),
  environment: z.record(z.string(), z.string()).optional(),
  tools: z.record(z.string(), z.object({
    enabled: z.boolean(),
    permission: permissionPolicySchema.optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }).strict()).default({}),
  state: z.enum(["stopped", "starting", "ready", "error"]).optional(),
  toolCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}).strict();
export type McpServerEditor = z.infer<typeof mcpServerEditorSchema>;
export const mcpToolSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  readOnlyHint: z.boolean().optional(),
  enabled: z.boolean(),
  permission: permissionPolicySchema.optional(),
  timeoutMs: z.number().int().optional(),
}).strict();
export type McpToolSummary = z.infer<typeof mcpToolSummarySchema>;
export const skillStatusSchema = z.object({
  name: z.string(),
  path: z.string(),
  source: z.enum(["project", "global"]),
  enabled: z.boolean(),
  valid: z.boolean(),
  trusted: z.boolean(),
  diagnostics: z.array(z.string()),
}).strict();
export type SkillStatus = z.infer<typeof skillStatusSchema>;

export const memoryMutationSchema = z.object({
  id: z.string(),
  scope: z.enum(["user", "project"]).optional(),
  content: z.string().trim().min(1).max(10_000).optional(),
  pinned: z.boolean().optional(),
  status: z.enum(["active", "pending", "superseded", "archived"]).optional(),
}).strict();
export const memoryListInputSchema = z.object({
  scope: z.enum(["user", "project"]).optional(),
}).strict();
export const memoryMoveInputSchema = z.object({
  id: z.string(),
  from: z.enum(["user", "project"]),
  to: z.enum(["user", "project"]),
}).strict();

export const dataUsageSchema = z.object({
  totalBytes: z.number().nonnegative(),
  sessionsBytes: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  logsBytes: z.number().nonnegative(),
  configBytes: z.number().nonnegative(),
}).strict();
export type DataUsage = z.infer<typeof dataUsageSchema>;
export const auditRecordSummarySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  category: z.string(),
  policy: z.string(),
  decision: z.string(),
  status: z.string(),
  details: z.unknown().optional(),
  diff: z.string().optional(),
}).strict();
export type AuditRecordSummary = z.infer<typeof auditRecordSummarySchema>;
export const gitCheckpointSchema = z.object({
  id: z.string(),
  ref: z.string(),
  commit: z.string(),
  createdAt: z.string(),
  message: z.string(),
}).strict();
export type GitCheckpoint = z.infer<typeof gitCheckpointSchema>;
export const gitCheckpointCreateInputSchema = z.object({
  message: z.string().trim().min(1).max(200).optional(),
}).strict();
export const gitCheckpointIdInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
}).strict();
export const clearDataInputSchema = z.object({
  category: z.enum(["sessions", "memories", "logs"]),
}).strict();

export const commandResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type CommandResult = z.infer<typeof commandResultSchema>;

export const IPC_CHANNELS = {
  getBootstrapState: "deki:get-bootstrap-state",
  chooseWorkspace: "deki:choose-workspace",
  openWorkspace: "deki:open-workspace",
  trustWorkspace: "deki:trust-workspace",
  sendPrompt: "deki:send-prompt",
  abortRun: "deki:abort-run",
  newSession: "deki:new-session",
  listSessions: "deki:list-sessions",
  getSessionHistory: "deki:get-session-history",
  switchSession: "deki:switch-session",
  renameSession: "deki:rename-session",
  deleteSession: "deki:delete-session",
  remember: "deki:remember",
  listMemories: "deki:list-memories",
  selectModel: "deki:select-model",
  getSettings: "deki:get-settings",
  updateSettings: "deki:update-settings",
  resetSettings: "deki:reset-settings",
  listModelProviders: "deki:list-model-providers",
  upsertModelProvider: "deki:upsert-model-provider",
  removeModelProvider: "deki:remove-model-provider",
  testModelProvider: "deki:test-model-provider",
  respondToApproval: "deki:respond-to-approval",
  revokeWorkspaceTrust: "deki:revoke-workspace-trust",
  exportDiagnostics: "deki:export-diagnostics",
  openDataDirectory: "deki:open-data-directory",
  openThirdPartyLicenses: "deki:open-third-party-licenses",
  listMcpServers: "deki:list-mcp-servers",
  upsertMcpServer: "deki:upsert-mcp-server",
  removeMcpServer: "deki:remove-mcp-server",
  reloadMcpServers: "deki:reload-mcp-servers",
  startMcpServer: "deki:start-mcp-server",
  stopMcpServer: "deki:stop-mcp-server",
  restartMcpServer: "deki:restart-mcp-server",
  testMcpServer: "deki:test-mcp-server",
  listMcpServerTools: "deki:list-mcp-server-tools",
  listSkills: "deki:list-skills",
  reloadSkills: "deki:reload-skills",
  updateMemory: "deki:update-memory",
  deleteMemory: "deki:delete-memory",
  clearMemoryScope: "deki:clear-memory-scope",
  moveMemory: "deki:move-memory",
  getDataUsage: "deki:get-data-usage",
  listAuditRecords: "deki:list-audit-records",
  listGitCheckpoints: "deki:list-git-checkpoints",
  createGitCheckpoint: "deki:create-git-checkpoint",
  previewGitCheckpoint: "deki:preview-git-checkpoint",
  restoreGitCheckpoint: "deki:restore-git-checkpoint",
  factoryReset: "deki:factory-reset",
  exportData: "deki:export-data",
  importData: "deki:import-data",
  clearData: "deki:clear-data",
  settingsChanged: "deki:settings-changed",
  agentEvent: "deki:agent-event",
} as const;

export interface DekiDesktopApi {
  getBootstrapState(): Promise<BootstrapState>;
  chooseWorkspace(): Promise<CommandResult>;
  openWorkspace(workspace: string): Promise<CommandResult>;
  trustWorkspace(): Promise<CommandResult>;
  sendPrompt(prompt: string): Promise<CommandResult>;
  abortRun(): Promise<CommandResult>;
  newSession(): Promise<CommandResult>;
  listSessions(): Promise<SessionSummary[]>;
  getSessionHistory(): Promise<ConversationMessage[]>;
  switchSession(id: string): Promise<CommandResult>;
  renameSession(id: string, name: string): Promise<CommandResult>;
  deleteSession(id: string): Promise<CommandResult>;
  remember(content: string): Promise<CommandResult>;
  listMemories(scope?: "user" | "project"): Promise<MemoryRecord[]>;
  selectModel(provider: string, id: string): Promise<CommandResult>;
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(
    scope: SettingsScope,
    patch: SettingsPatch,
    expectedRevision: string,
  ): Promise<SettingsSnapshot>;
  resetSettings(
    scope: SettingsScope,
    keys: string[] | undefined,
    expectedRevision: string,
  ): Promise<SettingsSnapshot>;
  listModelProviders(): Promise<RedactedModelProvider[]>;
  upsertModelProvider(provider: ModelProviderInput): Promise<CommandResult>;
  removeModelProvider(id: string): Promise<CommandResult>;
  testModelProvider(provider: ModelProviderInput): Promise<CommandResult>;
  respondToApproval(
    requestId: string,
    decision: "allow_once" | "allow_session" | "allow_project" | "deny",
  ): Promise<CommandResult>;
  revokeWorkspaceTrust(): Promise<CommandResult>;
  exportDiagnostics(): Promise<CommandResult>;
  openDataDirectory(): Promise<CommandResult>;
  openThirdPartyLicenses(): Promise<CommandResult>;
  listMcpServers(): Promise<McpServerEditor[]>;
  upsertMcpServer(server: McpServerEditor): Promise<CommandResult>;
  removeMcpServer(id: string): Promise<CommandResult>;
  reloadMcpServers(): Promise<CommandResult>;
  startMcpServer(id: string): Promise<CommandResult>;
  stopMcpServer(id: string): Promise<CommandResult>;
  restartMcpServer(id: string): Promise<CommandResult>;
  testMcpServer(id: string): Promise<CommandResult>;
  listMcpServerTools(id: string): Promise<McpToolSummary[]>;
  listSkills(): Promise<SkillStatus[]>;
  reloadSkills(): Promise<CommandResult>;
  updateMemory(input: z.infer<typeof memoryMutationSchema>): Promise<MemoryRecord>;
  deleteMemory(id: string, scope?: "user" | "project"): Promise<CommandResult>;
  clearMemoryScope(scope: "user" | "project"): Promise<CommandResult>;
  moveMemory(
    id: string,
    from: "user" | "project",
    to: "user" | "project",
  ): Promise<MemoryRecord>;
  getDataUsage(): Promise<DataUsage>;
  listAuditRecords(): Promise<AuditRecordSummary[]>;
  listGitCheckpoints(): Promise<GitCheckpoint[]>;
  createGitCheckpoint(message?: string): Promise<CommandResult>;
  previewGitCheckpoint(id: string): Promise<string>;
  restoreGitCheckpoint(id: string): Promise<CommandResult>;
  factoryReset(): Promise<CommandResult>;
  exportData(): Promise<CommandResult>;
  importData(): Promise<CommandResult>;
  clearData(category: "sessions" | "memories" | "logs"): Promise<CommandResult>;
  subscribeSettings(listener: (settings: SettingsSnapshot) => void): () => void;
  subscribeAgentEvents(listener: (event: AgentEvent) => void): () => void;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
  enabled?: boolean;
  permission?: PermissionPolicy;
  timeoutMs?: number;
}

export interface ToolCallContext {
  callId: string;
  workspace: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
  isError?: boolean;
}

export interface HealthStatus {
  state: "ready" | "degraded" | "error";
  message?: string;
}

export interface CapabilityProvider {
  id: string;
  listTools(): Promise<ToolDefinition[]>;
  callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult>;
  healthCheck(): Promise<HealthStatus>;
  dispose(): Promise<void>;
}
