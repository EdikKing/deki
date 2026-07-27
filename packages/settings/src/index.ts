import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const permissionPolicySchema = z.enum(["allow", "ask", "deny"]);
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;

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
  codeFont: z.string().trim().min(1).max(120),
  density: z.enum(["compact", "comfortable"]),
  sidebarWidth: z.number().int().min(200).max(420),
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
}).strict();

const modelDefaultsSchema = z.object({
  generalModel: z.string(),
  projectModel: z.string(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  maxOutputTokens: z.number().int().min(256).max(262_144),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  maxRetries: z.number().int().min(0).max(10),
}).strict();

const agentSchema = z.object({
  autoNameSessions: z.boolean(),
  compactionEnabled: z.boolean(),
  compactionThreshold: z.number().int().min(1_000).max(1_000_000),
  maxConcurrentRuns: z.number().int().min(1).max(8),
  showThinkingSummary: z.boolean(),
  sessionRetentionDays: z.number().int().min(1).max(3_650),
}).strict();

const workspaceSchema = z.object({
  contextIgnore: z.array(z.string().max(500)).max(500),
  contextFiles: z.array(z.string().max(500)).max(50),
  detectGit: z.boolean(),
  gitCheckpointBeforeWrite: z.boolean(),
  loadProjectMemory: z.boolean(),
}).strict();

export const permissionCategorySchema = z.enum([
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "shell.safe",
  "shell.unknown",
  "dependencies.install",
  "git.commit",
  "git.push",
  "outsideWorkspace",
  "sensitiveFiles",
  "privileged",
  "network",
  "mcp.read",
  "mcp.write",
]);
export type PermissionCategory = z.infer<typeof permissionCategorySchema>;

const permissionsSchema = z.object({
  policies: z.record(permissionCategorySchema, permissionPolicySchema),
  approvalTimeoutMs: z.number().int().min(5_000).max(600_000),
  auditRetentionDays: z.number().int().min(1).max(365),
  showDiffAfterWrite: z.boolean(),
}).strict();

const mcpSchema = z.object({
  startEnabledServers: z.boolean(),
  startupTimeoutMs: z.number().int().min(1_000).max(120_000),
  callTimeoutMs: z.number().int().min(1_000).max(600_000),
  healthCheckIntervalMs: z.number().int().min(5_000).max(3_600_000),
  autoRestart: z.boolean(),
  maxReconnectAttempts: z.number().int().min(0).max(20),
  toolPolicies: z.record(z.string(), permissionPolicySchema),
}).strict();

const skillsSchema = z.object({
  enabled: z.boolean(),
  globalPaths: z.array(z.string().max(1_000)).max(100),
  disabledNames: z.array(z.string().max(200)).max(500),
}).strict();

const memorySchema = z.object({
  userMemoryEnabled: z.boolean(),
  projectMemoryEnabled: z.boolean(),
  workspaceMemoryEnabled: z.boolean(),
  branchMemoryEnabled: z.boolean(),
  taskMemoryEnabled: z.boolean(),
  automaticCandidates: z.boolean(),
  candidateConfirmationRequired: z.literal(true),
  userRecallLimit: z.number().int().min(0).max(10),
  userCharacterBudget: z.number().int().min(0).max(10_000),
  userTokenBudget: z.number().int().min(0).max(10_000),
  projectRecallLimit: z.number().int().min(0).max(10),
  projectCharacterBudget: z.number().int().min(0).max(10_000),
  projectTokenBudget: z.number().int().min(0).max(10_000),
  workspaceRecallLimit: z.number().int().min(0).max(10),
  workspaceTokenBudget: z.number().int().min(0).max(10_000),
  branchRecallLimit: z.number().int().min(0).max(10),
  branchTokenBudget: z.number().int().min(0).max(10_000),
  taskRecallLimit: z.number().int().min(0).max(10),
  taskCharacterBudget: z.number().int().min(0).max(10_000),
  taskTokenBudget: z.number().int().min(0).max(10_000),
  lowConfidenceArchiveThreshold: z.number().min(0).max(1),
  sensitiveFilter: z.literal(true),
}).strict();

const privacySchema = z.object({
  telemetry: z.literal(false),
  logRetentionDays: z.number().int().min(1).max(365),
  includeAuditDiffsInExport: z.literal(false),
}).strict();

const advancedSchema = z.object({
  logLevel: z.enum(["error", "warn", "info", "debug"]),
  proxyUrl: z.string().max(2_000),
  customCaPath: z.string().max(2_000),
  toolOutputLimitBytes: z.number().int().min(1_024).max(100_000_000),
  experimentalFeatures: z.boolean(),
}).strict();

const updatesSchema = z.object({
  enabled: z.boolean(),
  channel: z.enum(["stable", "beta"]),
  sourceConfigured: z.boolean(),
}).strict();

export const settingsSchema = z.object({
  general: generalSchema,
  appearance: appearanceSchema,
  models: modelDefaultsSchema,
  agent: agentSchema,
  workspace: workspaceSchema,
  permissions: permissionsSchema,
  mcp: mcpSchema,
  skills: skillsSchema,
  memory: memorySchema,
  privacy: privacySchema,
  advanced: advancedSchema,
  updates: updatesSchema,
}).strict();

export type DekiSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: DekiSettings = settingsSchema.parse({
  general: {
    locale: "system",
    startupMode: "general",
    restoreSession: true,
    closeBehavior: "quit",
    launchAtLogin: false,
    checkUpdates: true,
  },
  appearance: {
    theme: "system",
    accent: "indigo",
    fontSize: 14,
    codeFont: "SFMono-Regular, Consolas, monospace",
    density: "comfortable",
    sidebarWidth: 248,
    reduceMotion: false,
    highContrast: false,
  },
  models: {
    generalModel: "",
    projectModel: "",
    thinkingLevel: "medium",
    maxOutputTokens: 16_384,
    timeoutMs: 120_000,
    maxRetries: 2,
  },
  agent: {
    autoNameSessions: true,
    compactionEnabled: true,
    compactionThreshold: 80_000,
    maxConcurrentRuns: 1,
    showThinkingSummary: true,
    sessionRetentionDays: 180,
  },
  workspace: {
    contextIgnore: ["node_modules", ".git", "dist", "out", "release"],
    contextFiles: ["AGENTS.md", "README.md"],
    detectGit: true,
    gitCheckpointBeforeWrite: true,
    loadProjectMemory: true,
  },
  permissions: {
    policies: {
      "workspace.read": "allow",
      "workspace.write": "allow",
      "workspace.delete": "ask",
      "shell.safe": "allow",
      "shell.unknown": "ask",
      "dependencies.install": "ask",
      "git.commit": "ask",
      "git.push": "ask",
      outsideWorkspace: "ask",
      sensitiveFiles: "ask",
      privileged: "ask",
      network: "ask",
      "mcp.read": "allow",
      "mcp.write": "ask",
    },
    approvalTimeoutMs: 120_000,
    auditRetentionDays: 30,
    showDiffAfterWrite: true,
  },
  mcp: {
    startEnabledServers: true,
    startupTimeoutMs: 20_000,
    callTimeoutMs: 30_000,
    healthCheckIntervalMs: 30_000,
    autoRestart: true,
    maxReconnectAttempts: 5,
    toolPolicies: {},
  },
  skills: {
    enabled: true,
    globalPaths: [],
    disabledNames: [],
  },
  memory: {
    userMemoryEnabled: false,
    projectMemoryEnabled: true,
    workspaceMemoryEnabled: true,
    branchMemoryEnabled: true,
    taskMemoryEnabled: true,
    automaticCandidates: false,
    candidateConfirmationRequired: true,
    userRecallLimit: 2,
    userCharacterBudget: 800,
    userTokenBudget: 200,
    projectRecallLimit: 3,
    projectCharacterBudget: 1_200,
    projectTokenBudget: 300,
    workspaceRecallLimit: 3,
    workspaceTokenBudget: 300,
    branchRecallLimit: 3,
    branchTokenBudget: 300,
    taskRecallLimit: 3,
    taskCharacterBudget: 1_200,
    taskTokenBudget: 300,
    lowConfidenceArchiveThreshold: 0.45,
    sensitiveFilter: true,
  },
  privacy: {
    telemetry: false,
    logRetentionDays: 30,
    includeAuditDiffsInExport: false,
  },
  advanced: {
    logLevel: "info",
    proxyUrl: "",
    customCaPath: "",
    toolOutputLimitBytes: 1_000_000,
    experimentalFeatures: false,
  },
  updates: {
    enabled: true,
    channel: "stable",
    sourceConfigured: true,
  },
});

export const settingsPatchSchema = z.object({
  general: generalSchema.partial().optional(),
  appearance: appearanceSchema.partial().optional(),
  models: modelDefaultsSchema.partial().optional(),
  agent: agentSchema.partial().optional(),
  workspace: workspaceSchema.partial().optional(),
  permissions: permissionsSchema.partial().optional(),
  mcp: mcpSchema.partial().optional(),
  skills: skillsSchema.partial().optional(),
  memory: memorySchema.partial().optional(),
  privacy: privacySchema.partial().optional(),
  advanced: advancedSchema.partial().optional(),
  updates: updatesSchema.partial().optional(),
}).strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export const settingsScopeSchema = z.enum(["global", "projectShared", "projectLocal", "session"]);
export type SettingsScope = z.infer<typeof settingsScopeSchema>;

const storedSettingsSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  settings: settingsPatchSchema,
}).strict();
type StoredSettings = z.infer<typeof storedSettingsSchema>;

export interface SettingsSnapshot {
  revision: string;
  effective: DekiSettings;
  global: SettingsPatch;
  projectShared: SettingsPatch;
  projectLocal: SettingsPatch;
  session: SettingsPatch;
  sources: Record<string, "default" | "global" | "projectShared" | "projectLocal" | "session">;
  diagnostics: string[];
}

export const settingsSnapshotSchema = z.object({
  revision: z.string(),
  effective: settingsSchema,
  global: settingsPatchSchema,
  projectShared: settingsPatchSchema,
  projectLocal: settingsPatchSchema,
  session: settingsPatchSchema,
  sources: z.record(
    z.string(),
    z.enum(["default", "global", "projectShared", "projectLocal", "session"]),
  ),
  diagnostics: z.array(z.string()),
});

export interface SettingsStoreOptions {
  globalFile: string;
  workspace?: string;
  projectLocalFile?: string;
}

export class SettingsConflictError extends Error {
  constructor() {
    super("设置已被其他操作修改，请刷新后重试");
    this.name = "SettingsConflictError";
  }
}

export class SettingsStore {
  readonly #options: SettingsStoreOptions;
  readonly #listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  #global: StoredSettings = emptyStoredSettings();
  #projectShared: StoredSettings = emptyStoredSettings();
  #projectLocal: StoredSettings = emptyStoredSettings();
  #session: SettingsPatch = {};
  #diagnostics: string[] = [];

  constructor(options: SettingsStoreOptions) {
    this.#options = options;
  }

  async initialize(): Promise<SettingsSnapshot> {
    this.#diagnostics = [];
    this.#global = await this.#readLayer(this.#options.globalFile, "全局设置");
    this.#projectShared = this.#options.workspace
      ? await this.#readLayer(join(this.#options.workspace, ".deki", "settings.json"), "项目共享设置")
      : emptyStoredSettings();
    this.#projectLocal = this.#options.projectLocalFile
      ? await this.#readLayer(this.#options.projectLocalFile, "项目本机设置")
      : emptyStoredSettings();
    return this.snapshot();
  }

  snapshot(): SettingsSnapshot {
    const layers = [
      ["global", this.#global.settings],
      ["projectShared", this.#projectShared.settings],
      ["projectLocal", this.#projectLocal.settings],
      ["session", this.#session],
    ] as const;
    let effective: unknown = structuredClone(defaultSettings);
    for (const [, patch] of layers) effective = deepMerge(effective, patch);
    const parsed = settingsSchema.parse(effective);
    return {
      revision: this.#revision(),
      effective: parsed,
      global: structuredClone(this.#global.settings),
      projectShared: structuredClone(this.#projectShared.settings),
      projectLocal: structuredClone(this.#projectLocal.settings),
      session: structuredClone(this.#session),
      sources: collectSources(defaultSettings, layers),
      diagnostics: [...this.#diagnostics],
    };
  }

  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setSessionOverrides(patch: SettingsPatch): SettingsSnapshot {
    this.#session = settingsPatchSchema.parse(patch);
    return this.#emit();
  }

  async update(
    scope: SettingsScope,
    patch: SettingsPatch,
    expectedRevision: string,
  ): Promise<SettingsSnapshot> {
    if (expectedRevision !== this.#revision()) throw new SettingsConflictError();
    const parsedPatch = settingsPatchSchema.parse(patch);
    if (scope === "session") {
      this.#session = settingsPatchSchema.parse(deepMerge(this.#session, parsedPatch));
      settingsSchema.parse(deepMerge(this.snapshot().effective, parsedPatch));
      return this.#emit();
    }
    const target = this.#layer(scope);
    const nextSettings = settingsPatchSchema.parse(deepMerge(target.settings, parsedPatch));
    settingsSchema.parse(deepMerge(this.snapshot().effective, parsedPatch));
    const next: StoredSettings = {
      version: 1,
      revision: target.revision + 1,
      settings: nextSettings,
    };
    await writeAtomicJson(this.#file(scope), next);
    this.#setLayer(scope, next);
    return this.#emit();
  }

  async reset(
    scope: SettingsScope,
    keys: string[] | undefined,
    expectedRevision: string,
  ): Promise<SettingsSnapshot> {
    if (expectedRevision !== this.#revision()) throw new SettingsConflictError();
    if (scope === "session") {
      const mutable = structuredClone(this.#session) as Record<string, unknown>;
      if (!keys || keys.length === 0) this.#session = {};
      else {
        for (const key of keys) deletePath(mutable, key);
        this.#session = settingsPatchSchema.parse(mutable);
      }
      return this.#emit();
    }
    const target = this.#layer(scope);
    const settings = structuredClone(target.settings) as Record<string, unknown>;
    if (!keys || keys.length === 0) {
      for (const key of Object.keys(settings)) delete settings[key];
    } else {
      for (const key of keys) deletePath(settings, key);
    }
    const next: StoredSettings = {
      version: 1,
      revision: target.revision + 1,
      settings: settingsPatchSchema.parse(settings),
    };
    await writeAtomicJson(this.#file(scope), next);
    this.#setLayer(scope, next);
    return this.#emit();
  }

  #revision(): string {
    return [
      this.#global.revision,
      this.#projectShared.revision,
      this.#projectLocal.revision,
      JSON.stringify(this.#session),
    ].join(":");
  }

  #layer(scope: SettingsScope): StoredSettings {
    if (scope === "global") return this.#global;
    if (scope === "projectShared") return this.#projectShared;
    return this.#projectLocal;
  }

  #setLayer(scope: SettingsScope, value: StoredSettings): void {
    if (scope === "global") this.#global = value;
    else if (scope === "projectShared") this.#projectShared = value;
    else this.#projectLocal = value;
  }

  #file(scope: SettingsScope): string {
    if (scope === "global") return this.#options.globalFile;
    if (scope === "projectShared" && this.#options.workspace) {
      return join(this.#options.workspace, ".deki", "settings.json");
    }
    if (scope === "projectLocal" && this.#options.projectLocalFile) {
      return this.#options.projectLocalFile;
    }
    throw new Error("当前会话没有可用的项目设置作用域");
  }

  async #readLayer(file: string, label: string): Promise<StoredSettings> {
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      const migrated = migrateStoredSettings(raw);
      if (migrated.migratedSandbox) {
        this.#diagnostics.push(`${label}中的 sandbox 权限已迁移为 ask`);
      }
      return storedSettingsSchema.parse(migrated.value);
    } catch (error) {
      if (isNotFound(error)) return emptyStoredSettings();
      this.#diagnostics.push(`${label}损坏，已尝试读取备份: ${formatError(error)}`);
      await preserveCorruptFile(file);
      try {
        return storedSettingsSchema.parse(JSON.parse(await readFile(`${file}.bak`, "utf8")));
      } catch {
        return emptyStoredSettings();
      }
    }
  }

  #emit(): SettingsSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
    return snapshot;
  }
}

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

export const redactedModelProviderSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  api: z.string().optional(),
  hasApiKey: z.boolean(),
  authHeader: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(modelDefinitionSchema),
});
export type RedactedModelProvider = z.infer<typeof redactedModelProviderSchema>;

const providerStoredSchema = modelProviderInputSchema
  .omit({ id: true, apiKey: true })
  .extend({ apiKey: z.string().optional() });
const modelsFileSchema = z.object({
  providers: z.record(z.string(), providerStoredSchema),
}).strict();
type ModelsFile = z.infer<typeof modelsFileSchema>;

export class ModelConfigStore {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<RedactedModelProvider[]> {
    const file = await this.#read();
    return Object.entries(file.providers).map(([id, provider]) => ({
      id,
      ...(provider.name ? { name: provider.name } : {}),
      enabled: provider.enabled !== false,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.api ? { api: provider.api } : {}),
      hasApiKey: Boolean(provider.apiKey),
      ...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
      ...(provider.headers
        ? { headers: Object.fromEntries(Object.keys(provider.headers).map((key) => [key, "[REDACTED]"])) }
        : {}),
      models: provider.models,
    }));
  }

  async upsert(raw: ModelProviderInput): Promise<void> {
    const input = modelProviderInputSchema.parse(raw);
    const file = await this.#read();
    const previous = file.providers[input.id];
    const apiKey = input.apiKey.action === "set"
      ? input.apiKey.value
      : input.apiKey.action === "keep"
        ? previous?.apiKey
        : undefined;
    const headers = input.headers
      ? Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [
          key,
          value === "[REDACTED]" ? previous?.headers?.[key] ?? "" : value,
        ]).filter(([, value]) => value !== ""))
      : undefined;
    file.providers[input.id] = providerStoredSchema.parse({
      ...(input.name ? { name: input.name } : {}),
      enabled: input.enabled !== false,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.api ? { api: input.api } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(input.authHeader === undefined ? {} : { authHeader: input.authHeader }),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      models: input.models,
    });
    await writeAtomicJson(this.#file, file);
  }

  async remove(id: string): Promise<void> {
    const file = await this.#read();
    delete file.providers[id];
    await writeAtomicJson(this.#file, file);
  }

  async test(raw: ModelProviderInput): Promise<{ ok: true; modelCount: number }> {
    const models = await this.fetchModels(raw);
    return { ok: true, modelCount: models.length || modelProviderInputSchema.parse(raw).models.length };
  }

  async fetchModels(raw: ModelProviderInput): Promise<Array<z.infer<typeof modelDefinitionSchema>>> {
    const input = modelProviderInputSchema.parse(raw);
    const file = await this.#read();
    const previous = file.providers[input.id];
    const apiKey = input.apiKey.action === "set"
      ? input.apiKey.value
      : input.apiKey.action === "keep"
        ? previous?.apiKey
        : undefined;
    const baseUrl = input.baseUrl ?? previous?.baseUrl;
    const api = input.api ?? previous?.api ?? "openai-completions";
    if (!baseUrl) {
      throw new Error("测试连接需要 Base URL");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const headers = new Headers({
        accept: "application/json",
        ...(previous?.headers ?? {}),
        ...Object.fromEntries(Object.entries(input.headers ?? {})
          .filter(([, value]) => value !== "[REDACTED]")),
      });
      if (apiKey && api === "anthropic-messages") {
        headers.set("x-api-key", apiKey);
        headers.set("anthropic-version", "2023-06-01");
      } else if (apiKey && input.authHeader !== false && api !== "google-generative-ai") {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
      const normalizedBase = baseUrl.replace(/\/+$/, "");
      const endpoint = api === "google-generative-ai"
        ? `${normalizedBase}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`
        : api === "anthropic-messages"
          ? `${normalizedBase}/v1/models`
          : `${normalizedBase}/models`;
      const response = await fetch(endpoint, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`连接失败：HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      const entries = isRecord(body) && Array.isArray(body.data)
        ? body.data
        : isRecord(body) && Array.isArray(body.models)
          ? body.models
          : [];
      const seen = new Set<string>();
      return entries.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const rawId = typeof entry.id === "string"
          ? entry.id
          : typeof entry.name === "string"
            ? entry.name
            : undefined;
        if (!rawId) return [];
        const id = api === "google-generative-ai"
          ? rawId.replace(/^models\//, "")
          : rawId;
        if (!id || seen.has(id)) return [];
        seen.add(id);
        const name = typeof entry.displayName === "string"
          ? entry.displayName
          : typeof entry.name === "string" && entry.name !== rawId
            ? entry.name
            : undefined;
        return [{
          id,
          ...(name ? { name } : {}),
          input: ["text"] as Array<"text" | "image">,
        }];
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #read(): Promise<ModelsFile> {
    try {
      return modelsFileSchema.parse(JSON.parse(await readFile(this.#file, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return { providers: {} };
      await preserveCorruptFile(this.#file);
      try {
        const backup = await readFile(`${this.#file}.bak`, "utf8");
        const recovered = modelsFileSchema.parse(JSON.parse(backup));
        await writeFile(this.#file, backup, { encoding: "utf8", mode: 0o600 });
        return recovered;
      } catch {
        throw new Error(`模型配置无效且没有可用备份: ${formatError(error)}`, { cause: error });
      }
    }
  }
}

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(file, `${file}.bak`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file);
}

async function preserveCorruptFile(file: string): Promise<void> {
  try {
    await copyFile(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // A concurrent cleanup may already have removed it.
  }
}

function emptyStoredSettings(): StoredSettings {
  return { version: 1, revision: 0, settings: {} };
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key])
      ? deepMerge(result[key], value)
      : structuredClone(value);
  }
  return result;
}

function collectSources(
  defaults: DekiSettings,
  layers: readonly (readonly [string, SettingsPatch])[],
): Record<string, "default" | "global" | "projectShared" | "projectLocal" | "session"> {
  const sources: Record<string, "default" | "global" | "projectShared" | "projectLocal" | "session"> = {};
  walkLeaves(defaults, "", (path) => {
    sources[path] = "default";
  });
  for (const [source, layer] of layers) {
    walkLeaves(layer, "", (path) => {
      sources[path] = source as typeof sources[string];
    });
  }
  return sources;
}

function walkLeaves(
  value: unknown,
  prefix: string,
  visitor: (path: string) => void,
): void {
  if (!isRecord(value)) {
    if (prefix) visitor(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(child)) walkLeaves(child, path, visitor);
    else visitor(path);
  }
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  const leaf = parts.pop();
  if (!leaf) return;
  let current = target;
  for (const part of parts) {
    const next = current[part];
    if (!isRecord(next)) return;
    current = next;
  }
  delete current[leaf];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrateStoredSettings(value: unknown): {
  value: unknown;
  migratedSandbox: boolean;
} {
  let migratedSandbox = false;
  const visit = (current: unknown): unknown => {
    if (current === "sandbox") {
      migratedSandbox = true;
      return "ask";
    }
    if (Array.isArray(current)) return current.map(visit);
    if (isRecord(current)) {
      return Object.fromEntries(
        Object.entries(current).map(([key, child]) => [key, visit(child)]),
      );
    }
    return current;
  };
  return { value: visit(value), migratedSandbox };
}
