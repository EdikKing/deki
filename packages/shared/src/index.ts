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
export const permissionPoliciesSchema = z.record(
  permissionCategorySchema,
  permissionPolicySchema,
);
export type PermissionPolicies = z.infer<typeof permissionPoliciesSchema>;
export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

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
  thinkingLevel: thinkingLevelSchema,
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
  policies: permissionPoliciesSchema,
  approvalTimeoutMs: z.number().int(),
  auditRetentionDays: z.number().int(),
  showDiffAfterWrite: z.boolean(),
}).strict();
const mcpSettingsSchema = z.object({
  startEnabledServers: z.boolean(),
  startupTimeoutMs: z.number().int(),
  callTimeoutMs: z.number().int(),
  healthCheckIntervalMs: z.number().int(),
  autoRestart: z.boolean(),
  maxReconnectAttempts: z.number().int(),
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
  workspaceMemoryEnabled: z.boolean(),
  branchMemoryEnabled: z.boolean(),
  taskMemoryEnabled: z.boolean(),
  automaticCandidates: z.boolean(),
  candidateConfirmationRequired: z.literal(true),
  userRecallLimit: z.number().int(),
  userCharacterBudget: z.number().int(),
  userTokenBudget: z.number().int(),
  projectRecallLimit: z.number().int(),
  projectCharacterBudget: z.number().int(),
  projectTokenBudget: z.number().int(),
  workspaceRecallLimit: z.number().int(),
  workspaceTokenBudget: z.number().int(),
  branchRecallLimit: z.number().int(),
  branchTokenBudget: z.number().int(),
  taskRecallLimit: z.number().int(),
  taskCharacterBudget: z.number().int(),
  taskTokenBudget: z.number().int(),
  lowConfidenceArchiveThreshold: z.number(),
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
  sourceConfigured: z.boolean(),
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
  enabled: z.boolean().optional(),
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
export const modelProviderCatalogResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(modelDefinitionSchema).optional(),
  error: z.string().optional(),
}).strict();
export type ModelProviderCatalogResult = z.infer<typeof modelProviderCatalogResultSchema>;

export const DEKI_VERSION = "0.0.0";

export const modelSummarySchema = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().positive().optional(),
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
  parentSessionId: z.string().optional(),
  runState: z.enum(["idle", "running", "interrupted", "failed"]).default("idle"),
}).strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  entryId: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  reasoning: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
}).strict();
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const memorySourceSchema = z.object({
  kind: z.enum(["user_command", "agent_candidate", "migration"]),
  sessionId: z.string().optional(),
  detail: z.string().optional(),
});

export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryScopeSchema = z.enum(["user", "project", "workspace", "branch", "task"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryRecordSchema = z.object({
  id: z.string(),
  scope: memoryScopeSchema,
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
  state: z.enum(["stopped", "starting", "ready", "degraded", "reconnecting", "error"]),
  toolCount: z.number().int().nonnegative(),
  error: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  reconnectAttempt: z.number().int().nonnegative().optional(),
});

export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskKindSchema = z.enum([
  "interactive",
  "background",
  "worker",
  "plan-execution",
]);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const taskRecordSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  rootTaskId: z.string().uuid(),
  parentTaskId: z.string().uuid().optional(),
  kind: taskKindSchema,
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(100_000),
  status: taskStatusSchema,
  priority: z.number().int(),
  sessionId: z.string().optional(),
  planId: z.string().uuid().optional(),
  currentRunId: z.string().uuid().optional(),
  assignedProfile: z.string().min(1).max(100).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
}).strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "waiting_user",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  attempt: z.number().int().positive(),
  status: runStatusSchema,
  sessionId: z.string().optional(),
  runnerId: z.string().min(1),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  resultSummary: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
}).strict();
export type RunRecord = z.infer<typeof runRecordSchema>;

export const artifactKindSchema = z.enum([
  "report",
  "evidence",
  "patch",
  "commit",
  "test-result",
  "diff",
  "log",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  kind: artifactKindSchema,
  title: z.string().min(1).max(200),
  uri: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
}).strict();
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export const taskEventTypeSchema = z.enum([
  "task.created",
  "task.queued",
  "task.started",
  "task.progress",
  "task.waiting_approval",
  "task.waiting_user",
  "task.paused",
  "task.resumed",
  "task.succeeded",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
  "run.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "artifact.created",
]);
export type TaskEventType = z.infer<typeof taskEventTypeSchema>;

export const taskEventSchema = z.object({
  eventId: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().datetime(),
  sequence: z.number().int().positive(),
  type: taskEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const taskDetailSchema = z.object({
  task: taskRecordSchema,
  runs: z.array(runRecordSchema),
  artifacts: z.array(artifactRecordSchema),
  events: z.array(taskEventSchema),
}).strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const bootstrapStateSchema = z.object({
  workspace: z.string().optional(),
  trusted: z.boolean(),
  ready: z.boolean(),
  streaming: z.boolean(),
  sessionId: z.string().optional(),
  models: z.array(modelSummarySchema),
  selectedModel: modelSummarySchema.optional(),
  sessionConfiguration: z.object({
    permissionPolicies: permissionPoliciesSchema,
    thinkingLevel: thinkingLevelSchema,
  }).strict().optional(),
  memories: z.array(memoryRecordSchema),
  recalledMemories: z.array(memoryRecordSchema),
  mcpServers: z.array(serverStatusSchema),
  skills: z.array(z.string()),
  diagnostics: z.array(z.string()),
  modelUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    contextTokens: z.number().int().nonnegative().nullable(),
    contextWindow: z.number().int().positive(),
    remainingTokens: z.number().int().nonnegative().nullable(),
    percent: z.number().nonnegative().nullable(),
  }).optional(),
  activeRunCount: z.number().int().nonnegative().default(0),
  recentWorkspaces: z.array(z.string()).default([]),
});

export type BootstrapState = z.infer<typeof bootstrapStateSchema>;

const eventBase = {
  eventId: z.string(),
  timestamp: z.string(),
  sessionId: z.string().optional(),
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
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
    providerId: z.string().optional(),
    modelId: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("message.reasoning.delta"),
    delta: z.string(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
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
    type: z.literal("run.started"),
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
  z.object({
    ...eventBase,
    type: z.literal("command.result"),
    command: z.string(),
    input: z.string().optional(),
    output: z.string(),
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
  scope: memoryScopeSchema.optional(),
});

export const selectModelInputSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export const updateSessionConfigurationInputSchema = z.object({
  permissionPolicies: permissionPoliciesSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
}).strict().refine(
  (input) => input.permissionPolicies !== undefined || input.thinkingLevel !== undefined,
  { message: "至少需要提供一项会话配置" },
);
export type UpdateSessionConfigurationInput = z.infer<
  typeof updateSessionConfigurationInputSchema
>;
export const sessionIdInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
}).strict();
export const sessionSearchInputSchema = z.object({
  query: z.string().trim().max(1_000).default(""),
}).strict();
export const forkSessionInputSchema = z.object({
  entryId: z.string().trim().min(1).max(200),
}).strict();
export const sessionHistoryStateSchema = z.object({
  messages: z.array(conversationMessageSchema),
  events: z.array(agentEventSchema),
  runState: z.enum(["idle", "running", "interrupted", "failed"]),
}).strict();
export type SessionHistoryState = z.infer<typeof sessionHistoryStateSchema>;
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
  state: z.enum(["stopped", "starting", "ready", "degraded", "reconnecting", "error"]).optional(),
  toolCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  lastCheckedAt: z.string().optional(),
  reconnectAttempt: z.number().int().nonnegative().optional(),
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
  version: z.string().optional(),
  pinnedVersion: z.string().optional(),
  sourceUrl: z.string().optional(),
  updateAvailable: z.boolean().optional(),
}).strict();
export type SkillStatus = z.infer<typeof skillStatusSchema>;
export const skillActionInputSchema = z.object({
  path: z.string().trim().min(1).max(10_000),
  pinnedVersion: z.string().trim().min(1).max(100).nullable().optional(),
}).strict();

export const memoryMutationSchema = z.object({
  id: z.string(),
  scope: memoryScopeSchema.optional(),
  content: z.string().trim().min(1).max(10_000).optional(),
  pinned: z.boolean().optional(),
  status: z.enum(["active", "pending", "superseded", "archived"]).optional(),
}).strict();
export const memoryListInputSchema = z.object({
  scope: memoryScopeSchema.optional(),
  query: z.string().trim().max(1_000).optional(),
}).strict();
export const memoryMoveInputSchema = z.object({
  id: z.string(),
  from: memoryScopeSchema,
  to: memoryScopeSchema,
}).strict();

export const dataUsageSchema = z.object({
  totalBytes: z.number().nonnegative(),
  sessionsBytes: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  tasksBytes: z.number().nonnegative(),
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
  category: z.enum(["sessions", "memories", "tasks", "logs"]),
}).strict();

export const commandResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type CommandResult = z.infer<typeof commandResultSchema>;

export const taskSubmissionResultSchema = commandResultSchema.extend({
  task: taskRecordSchema.optional(),
}).strict();
export type TaskSubmissionResult = z.infer<typeof taskSubmissionResultSchema>;

export const taskListInputSchema = z.object({
  statuses: z.array(taskStatusSchema).max(taskStatusSchema.options.length).optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
export type TaskListInput = z.infer<typeof taskListInputSchema>;

export const taskIdInputSchema = z.object({
  taskId: z.string().uuid(),
}).strict();

export const IPC_CHANNELS = {
  getBootstrapState: "deki:get-bootstrap-state",
  chooseWorkspace: "deki:choose-workspace",
  openWorkspace: "deki:open-workspace",
  openGeneralChat: "deki:open-general-chat",
  trustWorkspace: "deki:trust-workspace",
  sendPrompt: "deki:send-prompt",
  abortRun: "deki:abort-run",
  listTasks: "deki:list-tasks",
  getTask: "deki:get-task",
  cancelTask: "deki:cancel-task",
  newSession: "deki:new-session",
  listSessions: "deki:list-sessions",
  getSessionHistory: "deki:get-session-history",
  getSessionHistoryState: "deki:get-session-history-state",
  forkSession: "deki:fork-session",
  switchSession: "deki:switch-session",
  renameSession: "deki:rename-session",
  deleteSession: "deki:delete-session",
  remember: "deki:remember",
  listMemories: "deki:list-memories",
  selectModel: "deki:select-model",
  updateSessionConfiguration: "deki:update-session-configuration",
  getSettings: "deki:get-settings",
  updateSettings: "deki:update-settings",
  resetSettings: "deki:reset-settings",
  listModelProviders: "deki:list-model-providers",
  upsertModelProvider: "deki:upsert-model-provider",
  removeModelProvider: "deki:remove-model-provider",
  testModelProvider: "deki:test-model-provider",
  fetchModelProviderModels: "deki:fetch-model-provider-models",
  respondToApproval: "deki:respond-to-approval",
  revokeWorkspaceTrust: "deki:revoke-workspace-trust",
  exportDiagnostics: "deki:export-diagnostics",
  openDataDirectory: "deki:open-data-directory",
  openThirdPartyLicenses: "deki:open-third-party-licenses",
  checkForUpdates: "deki:check-for-updates",
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
  updateSkill: "deki:update-skill",
  pinSkillVersion: "deki:pin-skill-version",
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
  taskEvent: "deki:task-event",
} as const;

export interface DekiDesktopApi {
  getBootstrapState(): Promise<BootstrapState>;
  chooseWorkspace(): Promise<CommandResult>;
  openWorkspace(workspace: string): Promise<CommandResult>;
  openGeneralChat(): Promise<CommandResult>;
  trustWorkspace(): Promise<CommandResult>;
  sendPrompt(prompt: string): Promise<TaskSubmissionResult>;
  abortRun(): Promise<CommandResult>;
  listTasks(input?: Partial<TaskListInput>): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskDetail | null>;
  cancelTask(taskId: string): Promise<CommandResult>;
  newSession(): Promise<CommandResult>;
  listSessions(query?: string): Promise<SessionSummary[]>;
  getSessionHistory(): Promise<ConversationMessage[]>;
  getSessionHistoryState(): Promise<SessionHistoryState>;
  forkSession(entryId: string): Promise<CommandResult>;
  switchSession(id: string): Promise<CommandResult>;
  renameSession(id: string, name: string): Promise<CommandResult>;
  deleteSession(id: string): Promise<CommandResult>;
  remember(content: string, scope?: MemoryScope): Promise<CommandResult>;
  listMemories(scope?: MemoryScope, query?: string): Promise<MemoryRecord[]>;
  selectModel(provider: string, id: string): Promise<CommandResult>;
  updateSessionConfiguration(
    input: UpdateSessionConfigurationInput,
  ): Promise<CommandResult>;
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
  fetchModelProviderModels(provider: ModelProviderInput): Promise<ModelProviderCatalogResult>;
  respondToApproval(
    requestId: string,
    decision: "allow_once" | "allow_session" | "allow_project" | "deny",
  ): Promise<CommandResult>;
  revokeWorkspaceTrust(): Promise<CommandResult>;
  exportDiagnostics(): Promise<CommandResult>;
  openDataDirectory(): Promise<CommandResult>;
  openThirdPartyLicenses(): Promise<CommandResult>;
  checkForUpdates(): Promise<CommandResult>;
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
  updateSkill(path: string): Promise<CommandResult>;
  pinSkillVersion(path: string, version?: string): Promise<CommandResult>;
  updateMemory(input: z.infer<typeof memoryMutationSchema>): Promise<MemoryRecord>;
  deleteMemory(id: string, scope?: MemoryScope): Promise<CommandResult>;
  clearMemoryScope(scope: MemoryScope): Promise<CommandResult>;
  moveMemory(
    id: string,
    from: MemoryScope,
    to: MemoryScope,
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
  clearData(category: "sessions" | "memories" | "tasks" | "logs"): Promise<CommandResult>;
  subscribeSettings(listener: (settings: SettingsSnapshot) => void): () => void;
  subscribeAgentEvents(listener: (event: AgentEvent) => void): () => void;
  subscribeTaskEvents(listener: (event: TaskEvent) => void): () => void;
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
