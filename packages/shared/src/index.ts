import { z } from "zod";

export type DekiLocale = "zh-CN" | "en-US";

export function resolveSystemLocale(
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
): DekiLocale {
  return locale.toLocaleLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

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
  workerMaxPerRoot: z.number().int(),
  workerTimeoutMs: z.number().int(),
  workerMaxInputTokens: z.number().int(),
  workerMaxOutputTokens: z.number().int(),
  workerMaxToolCalls: z.number().int(),
  workerModel: z.string(),
  dagExecutionEnabled: z.boolean(),
  planMaxConcurrentSteps: z.number().int(),
  planMaxDurationMs: z.number().int(),
  planMaxInputTokens: z.number().int(),
  planMaxOutputTokens: z.number().int(),
  planMaxToolCalls: z.number().int(),
  planModelRoutes: z.record(
    z.enum(["coordinator", "explorer", "implementer", "tester", "reviewer", "integrator"]),
    z.array(z.string()),
  ),
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

export const DEKI_VERSION = "0.0.2";

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
  attachments: z.array(z.object({
    name: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
    dataUrl: z.string().optional(),
  }).strict()).max(10).optional(),
}).strict();
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const promptAttachmentInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative().max(20 * 1024 * 1024),
  data: z.string().max(28 * 1024 * 1024),
}).strict();
export type PromptAttachmentInput = z.infer<typeof promptAttachmentInputSchema>;

export const promptAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(20 * 1024 * 1024),
  path: z.string().min(1),
}).strict();
export type PromptAttachment = z.infer<typeof promptAttachmentSchema>;

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
  "waiting_workers",
  "awaiting_apply",
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
  "planning",
  "worker",
  "plan-execution",
  "plan-step",
  "integration",
]);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const interactionModeSchema = z.enum(["act", "plan"]);
export type InteractionMode = z.infer<typeof interactionModeSchema>;

export const planStatusSchema = z.enum([
  "draft",
  "ready",
  "approved",
  "executing",
  "blocked",
  "completed",
  "abandoned",
]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "blocked",
  "skipped",
]);
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

export const planExecutionProfileSchema = z.enum([
  "explorer",
  "implementer",
  "tester",
]);
export type PlanExecutionProfile = z.infer<typeof planExecutionProfileSchema>;

export const planStepSchema = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  dependencies: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  candidateFiles: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  validation: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  risk: z.enum(["low", "medium", "high"]),
  parallelizable: z.boolean().default(false),
  assignedProfile: z.string().trim().min(1).max(100).optional(),
  executionProfile: planExecutionProfileSchema.optional(),
  writeSet: z.array(z.object({
    path: z.string().trim().min(1).max(2_000),
    kind: z.enum(["file", "directory"]),
    exclusive: z.boolean().default(false),
  }).strict()).max(100).optional(),
  validationTargets: z.array(z.object({
    cwd: z.string().trim().min(1).max(2_000).optional(),
    script: z.string().regex(/^(?:test(?::[A-Za-z0-9_.-]+)?|lint|typecheck)$/),
  }).strict()).max(30).optional(),
}).strict();
export type PlanStep = z.infer<typeof planStepSchema>;

export const planRecordSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  planningTaskId: z.string().uuid().optional(),
  executionTaskId: z.string().uuid().optional(),
  goal: z.string().trim().min(1).max(100_000),
  status: planStatusSchema,
  currentRevision: z.number().int().positive(),
  approvedRevision: z.number().int().positive().optional(),
  executingRevision: z.number().int().positive().optional(),
  replanReason: z.string().max(10_000).optional(),
  affectedStepIds: z.array(z.string().min(1).max(100)).max(30).default([]),
  replanEvidence: z.array(z.string().max(10_000)).max(100).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type PlanRecord = z.infer<typeof planRecordSchema>;

export const planRevisionRecordSchema = z.object({
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  feedback: z.string().trim().max(10_000).optional(),
  assumptions: z.array(z.string().trim().min(1).max(2_000)).max(100),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100),
  steps: z.array(planStepSchema).min(1).max(30),
  createdAt: z.string().datetime(),
}).strict();
export type PlanRevisionRecord = z.infer<typeof planRevisionRecordSchema>;

export const planStepStateSchema = z.object({
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  stepId: z.string().min(1).max(100),
  status: planStepStatusSchema,
  summary: z.string().max(10_000).optional(),
  evidence: z.array(z.string().max(10_000)).max(100).default([]),
  reason: z.string().max(10_000).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
}).strict();
export type PlanStepState = z.infer<typeof planStepStateSchema>;

export const planEventTypeSchema = z.enum([
  "plan.created",
  "plan.submitted",
  "plan.revised",
  "plan.approved",
  "plan.execution_started",
  "plan.execution_paused",
  "plan.execution_failed",
  "plan.execution_blocked",
  "plan.node_ready",
  "plan.node_started",
  "plan.node_completed",
  "plan.node_failed",
  "plan.node_blocked",
  "plan.route_selected",
  "plan.step_started",
  "plan.step_completed",
  "plan.step_blocked",
  "plan.replan_requested",
  "plan.completed",
  "plan.abandoned",
]);
export type PlanEventType = z.infer<typeof planEventTypeSchema>;

export const planEventSchema = z.object({
  eventId: z.string().uuid(),
  planId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  timestamp: z.string().datetime(),
  sequence: z.number().int().positive(),
  type: planEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type PlanEvent = z.infer<typeof planEventSchema>;

export const taskRecordSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
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

export const taskRequestKindSchema = z.enum([
  "approval",
  "user_input",
  "integration_approval",
]);
export type TaskRequestKind = z.infer<typeof taskRequestKindSchema>;

export const taskRequestStatusSchema = z.enum([
  "pending",
  "resolved",
  "cancelled",
  "expired",
]);
export type TaskRequestStatus = z.infer<typeof taskRequestStatusSchema>;

export const taskRequestRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  kind: taskRequestKindSchema,
  status: taskRequestStatusSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  payload: z.record(z.string(), z.unknown()),
  response: z.unknown().optional(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
}).strict();
export type TaskRequestRecord = z.infer<typeof taskRequestRecordSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_approval",
  "waiting_user",
  "waiting_workers",
  "awaiting_apply",
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
  routeCandidateIndex: z.number().int().nonnegative().optional(),
  routeReason: z.string().optional(),
  budgetTier: z.enum(["normal", "soft", "critical"]).optional(),
  failureClass: z.enum([
    "provider_transient",
    "provider_unavailable",
    "context_overflow",
    "permission",
    "tool",
    "validation",
    "scope",
    "review",
    "budget",
    "integration",
    "unknown",
  ]).optional(),
  failureDetail: z.object({
    source: z.enum(["provider", "runtime", "permission", "tool", "validation", "review", "budget", "integration", "unknown"]),
    code: z.string().max(200).optional(),
    status: z.number().int().min(100).max(599).optional(),
    errorName: z.string().max(200).optional(),
    retriable: z.boolean(),
  }).strict().optional(),
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

export const workerProfileIdSchema = z.enum([
  "explorer",
  "tester",
  "reviewer",
  "implementer",
  "integrator",
]);
export type WorkerProfileId = z.infer<typeof workerProfileIdSchema>;

export const workerWriteSetEntrySchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  kind: z.enum(["file", "directory"]),
  exclusive: z.boolean().default(false),
}).strict();
export type WorkerWriteSetEntry = z.infer<typeof workerWriteSetEntrySchema>;

export const validationTargetSchema = z.object({
  cwd: z.string().trim().min(1).max(2_000).optional(),
  script: z.string().regex(/^(?:test(?::[A-Za-z0-9_.-]+)?|lint|typecheck)$/),
}).strict();
export type ValidationTarget = z.infer<typeof validationTargetSchema>;

export const taskBudgetSchema = z.object({
  maxWorkers: z.number().int().min(1).max(4),
  maxDurationMs: z.number().int().min(10_000).max(3_600_000),
  maxInputTokens: z.number().int().min(1_000).max(10_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  maxToolCalls: z.number().int().min(1).max(1_000),
}).strict();
export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const taskBudgetUsageSchema = z.object({
  workers: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  warningEmitted: z.boolean().default(false),
  exceeded: z.boolean().default(false),
}).strict();
export type TaskBudgetUsage = z.infer<typeof taskBudgetUsageSchema>;

export const planExecutionBudgetSchema = z.object({
  maxConcurrentSteps: z.number().int().min(1).max(8),
  maxDurationMs: z.number().int().min(10_000).max(86_400_000),
  maxInputTokens: z.number().int().min(1_000).max(100_000_000),
  maxOutputTokens: z.number().int().min(256).max(10_000_000),
  maxToolCalls: z.number().int().min(1).max(100_000),
}).strict();
export type PlanExecutionBudget = z.infer<typeof planExecutionBudgetSchema>;

export const planBudgetReservationSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
}).strict();
export type PlanBudgetReservation = z.infer<typeof planBudgetReservationSchema>;

export const planExecutionNodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
]);
export type PlanExecutionNodeStatus = z.infer<typeof planExecutionNodeStatusSchema>;

export const planExecutionNodeSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  sourceStepId: z.string().min(1).max(100).optional(),
  syntheticKind: z.enum(["reviewer", "integrator"]).optional(),
  profile: z.enum(["explorer", "implementer", "tester", "reviewer", "integrator"]),
  title: z.string().min(1).max(300),
  dependencies: z.array(z.string().uuid()).max(100),
  status: planExecutionNodeStatusSchema,
  parallelizable: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  writeSet: z.array(workerWriteSetEntrySchema).max(100).default([]),
  validationTargets: z.array(validationTargetSchema).max(30).default([]),
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  attempt: z.number().int().nonnegative().default(0),
  modelProvider: z.string().optional(),
  modelId: z.string().optional(),
  routeCandidateIndex: z.number().int().nonnegative().optional(),
  routeReason: z.string().optional(),
  budgetTier: z.enum(["normal", "soft", "critical"]).optional(),
  failureClass: runRecordSchema.shape.failureClass,
  reservation: planBudgetReservationSchema.optional(),
  summary: z.string().max(20_000).optional(),
  reason: z.string().max(20_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type PlanExecutionNode = z.infer<typeof planExecutionNodeSchema>;

export const planExecutionGraphSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
  rootTaskId: z.string().uuid(),
  status: z.enum(["pending", "running", "blocked", "completed", "cancelled"]),
  budget: planExecutionBudgetSchema,
  usage: taskBudgetUsageSchema,
  reserved: planBudgetReservationSchema.default({
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
  }),
  blockedReason: z.enum(["budget", "dependency", "review", "integration"]).optional(),
  nodes: z.array(planExecutionNodeSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type PlanExecutionGraph = z.infer<typeof planExecutionGraphSchema>;

export const workerEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string().min(1).max(2_000),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    excerpt: z.string().max(10_000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("command"),
    target: z.string().min(1).max(500),
    exitCode: z.number().int(),
    outputArtifactId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    artifactId: z.string().uuid(),
    description: z.string().max(2_000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("url"),
    url: z.string().url().max(4_000),
    description: z.string().max(2_000).optional(),
  }).strict(),
]);
export type WorkerEvidence = z.infer<typeof workerEvidenceSchema>;

export const workerFindingSchema = z.object({
  claim: z.string().min(1).max(10_000),
  confidence: z.number().min(0).max(1),
  evidence: z.array(workerEvidenceSchema).max(100),
}).strict();
export type WorkerFinding = z.infer<typeof workerFindingSchema>;

export const workerResultSchema = z.object({
  summary: z.string().min(1).max(20_000),
  findings: z.array(workerFindingSchema).max(100),
  artifacts: z.array(z.string().uuid()).max(100),
  risks: z.array(z.string().max(5_000)).max(100),
  unresolved: z.array(z.string().max(5_000)).max(100),
  recommendedNextActions: z.array(z.string().max(5_000)).max(100),
  review: z.object({
    verdict: z.enum(["approved", "changes_requested", "blocked"]),
    findings: z.array(z.object({
      severity: z.enum(["low", "medium", "high", "critical"]),
      summary: z.string().min(1).max(5_000),
      evidence: z.array(workerEvidenceSchema).max(30).default([]),
    }).strict()).max(100),
  }).strict().optional(),
}).strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const workerContextPackageSchema = z.object({
  rootTaskId: z.string().uuid(),
  parentTaskId: z.string().uuid(),
  workerTaskId: z.string().uuid(),
  objective: z.string().min(1).max(100_000),
  successCriteria: z.array(z.string().min(1).max(5_000)).min(1).max(30),
  constraints: z.array(z.string().max(5_000)).max(100),
  knownFacts: z.array(z.string().max(5_000)).max(100),
  fileHints: z.array(z.string().max(2_000)).max(100),
  symbolHints: z.array(z.string().max(500)).max(100),
  plan: z.object({
    planId: z.string().uuid(),
    revision: z.number().int().positive(),
    stepId: z.string().min(1).max(100).optional(),
  }).strict().optional(),
  budget: taskBudgetSchema,
}).strict();
export type WorkerContextPackage = z.infer<typeof workerContextPackageSchema>;

const workerRequestBaseShape = {
  objective: z.string().min(1).max(100_000),
  successCriteria: z.array(z.string().min(1).max(5_000)).min(1).max(30),
  constraints: z.array(z.string().max(5_000)).max(100).default([]),
  knownFacts: z.array(z.string().max(5_000)).max(100).default([]),
  fileHints: z.array(z.string().max(2_000)).max(100).default([]),
  symbolHints: z.array(z.string().max(500)).max(100).default([]),
  plan: z.object({
    planId: z.string().uuid(),
    revision: z.number().int().positive(),
    stepId: z.string().min(1).max(100).optional(),
  }).strict().optional(),
};

export const workerRequestSchema = z.discriminatedUnion("profile", [
  z.object({
    profile: z.enum(["explorer", "tester", "reviewer"]),
    ...workerRequestBaseShape,
  }).strict(),
  z.object({
    profile: z.literal("implementer"),
    ...workerRequestBaseShape,
    writeSet: z.array(workerWriteSetEntrySchema).min(1).max(100),
    validationTargets: z.array(validationTargetSchema).min(1).max(30),
  }).strict(),
]);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const implementationResultSchema = z.object({
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  baselineCommit: z.string().regex(/^[0-9a-f]{40,64}$/i),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
  changedFiles: z.array(z.string().min(1).max(2_000)).max(2_000),
  patchArtifactId: z.string().uuid().optional(),
  commitArtifactId: z.string().uuid().optional(),
  validationArtifactIds: z.array(z.string().uuid()).max(100),
  scopeViolation: z.boolean().default(false),
  createdAt: z.string().datetime(),
}).strict();
export type ImplementationResult = z.infer<typeof implementationResultSchema>;

export const integrationStatusSchema = z.enum([
  "preparing",
  "merging",
  "conflicted",
  "paused",
  "retrying",
  "testing",
  "awaiting_apply",
  "applied",
  "artifact_only",
  "failed",
  "cancelled",
]);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const integrationRecordSchema = z.object({
  id: z.string().uuid(),
  rootTaskId: z.string().uuid(),
  taskId: z.string().uuid(),
  integrationTaskId: z.string().uuid().optional(),
  baselineCommit: z.string().regex(/^[0-9a-f]{40,64}$/i),
  integrationCommit: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
  commitArtifactId: z.string().uuid().optional(),
  status: integrationStatusSchema,
  predictedOverlaps: z.array(z.string().max(2_000)).max(2_000),
  actualOverlaps: z.array(z.string().max(2_000)).max(2_000),
  conflictFiles: z.array(z.string().max(2_000)).max(2_000),
  workerTaskIds: z.array(z.string().uuid()).max(100),
  integratorTaskIds: z.array(z.string().uuid()).max(100).default([]),
  conflictArtifactIds: z.array(z.string().uuid()).max(500).default([]),
  resolutionSummaries: z.array(z.string().max(20_000)).max(100).default([]),
  validationTargets: z.array(validationTargetSchema).max(30).default([]),
  validationArtifactIds: z.array(z.string().uuid()).max(100),
  diffArtifactId: z.string().uuid().optional(),
  patchArtifactId: z.string().uuid().optional(),
  cleanupStatus: z.enum(["pending", "cleaned", "failed"]),
  cleanupError: z.string().max(10_000).optional(),
  pausedReason: z.string().max(20_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type IntegrationRecord = z.infer<typeof integrationRecordSchema>;

export const workerResultEnvelopeSchema = z.object({
  task: taskRecordSchema,
  status: taskStatusSchema,
  result: workerResultSchema.optional(),
  error: z.string().optional(),
}).strict();
export type WorkerResultEnvelope = z.infer<typeof workerResultEnvelopeSchema>;

export const taskEventTypeSchema = z.enum([
  "task.created",
  "task.queued",
  "task.started",
  "task.progress",
  "task.waiting_approval",
  "task.waiting_user",
  "task.waiting_workers",
  "task.paused",
  "task.pause_requested",
  "task.promoted",
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
  "user_input.requested",
  "user_input.resolved",
  "worker.delegated",
  "worker.result_received",
  "worktree.created",
  "worktree.finalized",
  "worktree.cleanup_failed",
  "worker.scope_violation",
  "integration.created",
  "integration.overlap_detected",
  "integration.conflict_detected",
  "integration.paused",
  "integration.retrying",
  "integration.testing",
  "integration.awaiting_apply",
  "integration.application_conflict",
  "integration.applied",
  "integration.artifact_only",
  "integration.failed",
  "budget.warning",
  "budget.exceeded",
  "route.selected",
  "route.fallback",
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

export const taskPlanContextSchema = z.object({
  planId: z.string().uuid(),
  status: planStatusSchema,
  currentRevision: z.number().int().positive(),
  approvedRevision: z.number().int().positive().optional(),
  completedSteps: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  currentStep: planStepSchema.optional(),
  currentSteps: z.array(planStepSchema).default([]),
  replanReason: z.string().max(10_000).optional(),
}).strict();
export type TaskPlanContext = z.infer<typeof taskPlanContextSchema>;

export const taskSummarySchema = z.object({
  task: taskRecordSchema,
  currentRun: runRecordSchema.optional(),
  pendingRequestCount: z.number().int().nonnegative(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  runnable: z.boolean().default(true),
  attentionReason: z.enum([
    "workspace_missing",
    "workspace_untrusted",
    "runtime_unavailable",
  ]).optional(),
  planContext: taskPlanContextSchema.optional(),
  workerCount: z.number().int().nonnegative().default(0),
  completedWorkerCount: z.number().int().nonnegative().default(0),
  workerPlanStepId: z.string().min(1).max(100).optional(),
  budgetUsage: taskBudgetUsageSchema.optional(),
}).strict();
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskDetailSchema = z.object({
  task: taskRecordSchema,
  runs: z.array(runRecordSchema),
  artifacts: z.array(artifactRecordSchema),
  events: z.array(taskEventSchema),
  requests: z.array(taskRequestRecordSchema).default([]),
  planContext: taskPlanContextSchema.optional(),
  children: z.array(taskSummarySchema).default([]),
  workerResult: workerResultSchema.optional(),
  implementationResult: implementationResultSchema.optional(),
  integration: integrationRecordSchema.optional(),
  budget: taskBudgetSchema.optional(),
  budgetUsage: taskBudgetUsageSchema.optional(),
}).strict();
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const planDetailSchema = z.object({
  plan: planRecordSchema,
  revisions: z.array(planRevisionRecordSchema),
  stepStates: z.array(planStepStateSchema),
  events: z.array(planEventSchema),
  planningTask: taskRecordSchema.optional(),
  executionTask: taskRecordSchema.optional(),
  executionGraph: planExecutionGraphSchema.optional(),
}).strict();
export type PlanDetail = z.infer<typeof planDetailSchema>;

export const planSummarySchema = z.object({
  plan: planRecordSchema,
  revision: planRevisionRecordSchema,
  completedSteps: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  currentStep: planStepSchema.optional(),
  currentSteps: z.array(planStepSchema).default([]),
  executionGraph: planExecutionGraphSchema.optional(),
}).strict();
export type PlanSummary = z.infer<typeof planSummarySchema>;

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
    interactionMode: interactionModeSchema.default("act"),
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
    type: z.literal("usage.updated"),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
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
    type: z.literal("user_input.requested"),
    requestId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    options: z.array(z.string()).max(20).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("user_input.resolved"),
    requestId: z.string(),
    value: z.string(),
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
  prompt: z.string().trim().max(100_000),
  attachments: z.array(promptAttachmentInputSchema).max(10).default([]),
  mode: z.enum(["foreground", "background"]).default("foreground"),
  interactionMode: interactionModeSchema.default("act"),
}).strict().refine(
  (input) => input.prompt.length > 0 || input.attachments.length > 0,
  { message: "消息或附件不能为空" },
).refine(
  (input) => input.attachments.reduce((total, item) => total + item.size, 0) <= 50 * 1024 * 1024,
  { message: "附件总大小不能超过 50 MB" },
);

export const optimizePromptInputSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
}).strict();

export const optimizePromptResultSchema = z.object({
  ok: z.boolean(),
  prompt: z.string().trim().min(1).max(100_000).optional(),
  error: z.string().optional(),
}).strict();
export type OptimizePromptResult = z.infer<typeof optimizePromptResultSchema>;

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
  interactionMode: interactionModeSchema.optional(),
}).strict().refine(
  (input) => input.permissionPolicies !== undefined
    || input.thinkingLevel !== undefined
    || input.interactionMode !== undefined,
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
  workspaceIds: z.array(z.string().min(1)).max(100).optional(),
  kinds: z.array(taskKindSchema).max(taskKindSchema.options.length).optional(),
  query: z.string().trim().max(500).optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
export type TaskListInput = z.infer<typeof taskListInputSchema>;

export const taskIdInputSchema = z.object({
  taskId: z.string().uuid(),
}).strict();

export const promptSubmissionOptionsSchema = z.object({
  mode: z.enum(["foreground", "background"]).default("foreground"),
  interactionMode: interactionModeSchema.default("act"),
  attachments: z.array(promptAttachmentInputSchema).max(10).default([]),
}).strict();
export type PromptSubmissionOptions = z.infer<typeof promptSubmissionOptionsSchema>;

export const planListInputSchema = z.object({
  statuses: z.array(planStatusSchema).max(planStatusSchema.options.length).optional(),
  workspaceIds: z.array(z.string().min(1)).max(100).optional(),
  query: z.string().trim().max(500).optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
export type PlanListInput = z.infer<typeof planListInputSchema>;

export const planIdInputSchema = z.object({
  planId: z.string().uuid(),
}).strict();

export const approvePlanInputSchema = planIdInputSchema.extend({
  revision: z.number().int().positive(),
}).strict();

export const revisePlanInputSchema = planIdInputSchema.extend({
  feedback: z.string().trim().min(1).max(10_000),
  mode: z.enum(["foreground", "background"]).default("foreground"),
}).strict();

export const replanInputSchema = planIdInputSchema.extend({
  reason: z.string().trim().min(1).max(10_000),
  affectedStepIds: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
}).strict();

export const taskInputResponseSchema = taskIdInputSchema.extend({
  requestId: z.string().min(1),
  value: z.string().trim().min(1).max(100_000),
}).strict();

export const taskApprovalDecisionInputSchema = approvalDecisionInputSchema.extend({
  taskId: z.string().uuid().optional(),
}).strict();

export const integrationDecisionSchema = z.enum(["apply", "artifact_only", "cancel"]);
export type IntegrationDecision = z.infer<typeof integrationDecisionSchema>;
export const integrationDecisionInputSchema = z.object({
  taskId: z.string().uuid(),
  requestId: z.string().min(1),
  decision: integrationDecisionSchema,
}).strict();

export const artifactChunkInputSchema = z.object({
  artifactId: z.string().uuid(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(256 * 1024).default(64 * 1024),
}).strict();
export const artifactChunkSchema = z.object({
  artifactId: z.string().uuid(),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  done: z.boolean(),
}).strict();
export type ArtifactChunk = z.infer<typeof artifactChunkSchema>;

export const IPC_CHANNELS = {
  getBootstrapState: "deki:get-bootstrap-state",
  chooseWorkspace: "deki:choose-workspace",
  openWorkspace: "deki:open-workspace",
  openGeneralChat: "deki:open-general-chat",
  trustWorkspace: "deki:trust-workspace",
  sendPrompt: "deki:send-prompt",
  optimizePrompt: "deki:optimize-prompt",
  abortRun: "deki:abort-run",
  listTasks: "deki:list-tasks",
  getTask: "deki:get-task",
  cancelTask: "deki:cancel-task",
  pauseTask: "deki:pause-task",
  resumeTask: "deki:resume-task",
  retryTask: "deki:retry-task",
  promoteTask: "deki:promote-task",
  openTaskSession: "deki:open-task-session",
  respondToTaskInput: "deki:respond-to-task-input",
  respondToIntegration: "deki:respond-to-integration",
  readArtifactChunk: "deki:read-artifact-chunk",
  listPlans: "deki:list-plans",
  getPlan: "deki:get-plan",
  approvePlan: "deki:approve-plan",
  revisePlan: "deki:revise-plan",
  replan: "deki:request-plan-replan",
  abandonPlan: "deki:abandon-plan",
  openPlanSession: "deki:open-plan-session",
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
  planEvent: "deki:plan-event",
  openTask: "deki:open-task",
  openPlan: "deki:open-plan",
} as const;

export interface DekiDesktopApi {
  getBootstrapState(): Promise<BootstrapState>;
  chooseWorkspace(): Promise<CommandResult>;
  openWorkspace(workspace: string): Promise<CommandResult>;
  openGeneralChat(): Promise<CommandResult>;
  trustWorkspace(): Promise<CommandResult>;
  sendPrompt(
    prompt: string,
    options?: Partial<PromptSubmissionOptions>,
  ): Promise<TaskSubmissionResult>;
  optimizePrompt(prompt: string): Promise<OptimizePromptResult>;
  abortRun(): Promise<CommandResult>;
  listTasks(input?: Partial<TaskListInput>): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail | null>;
  cancelTask(taskId: string): Promise<CommandResult>;
  pauseTask(taskId: string): Promise<CommandResult>;
  resumeTask(taskId: string): Promise<CommandResult>;
  retryTask(taskId: string): Promise<CommandResult>;
  promoteTask(taskId: string): Promise<CommandResult>;
  openTaskSession(taskId: string): Promise<CommandResult>;
  respondToTaskInput(
    taskId: string,
    requestId: string,
    value: string,
  ): Promise<CommandResult>;
  respondToIntegration(
    taskId: string,
    requestId: string,
    decision: IntegrationDecision,
  ): Promise<CommandResult>;
  readArtifactChunk(
    artifactId: string,
    offset?: number,
    limit?: number,
  ): Promise<ArtifactChunk>;
  listPlans(input?: Partial<PlanListInput>): Promise<PlanSummary[]>;
  getPlan(planId: string): Promise<PlanDetail | null>;
  approvePlan(planId: string, revision: number): Promise<CommandResult>;
  requestPlanRevision(
    planId: string,
    feedback: string,
    options?: { mode?: "foreground" | "background" },
  ): Promise<TaskSubmissionResult>;
  requestPlanReplan(
    planId: string,
    reason: string,
    affectedStepIds?: string[],
  ): Promise<TaskSubmissionResult>;
  abandonPlan(planId: string): Promise<CommandResult>;
  openPlanSession(planId: string): Promise<CommandResult>;
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
    taskId?: string,
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
  subscribePlanEvents(listener: (event: PlanEvent) => void): () => void;
  subscribeOpenTask(listener: (taskId: string) => void): () => void;
  subscribeOpenPlan(listener: (planId: string) => void): () => void;
}

export type ToolEffect =
  | "read"
  | "write"
  | "network-read"
  | "interaction"
  | "plan-control"
  | "unknown";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
  effect?: ToolEffect;
  enabled?: boolean;
  permission?: PermissionPolicy;
  timeoutMs?: number;
}

export interface ToolCallContext {
  callId: string;
  workspace: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  planId?: string;
  interactionMode?: "act" | "plan" | "plan-execution" | "worker";
  workerProfile?: WorkerProfileId;
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
