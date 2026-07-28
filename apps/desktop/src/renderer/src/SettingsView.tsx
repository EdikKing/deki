import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  DekiSettings,
  DataUsage,
  AuditRecordSummary,
  GitCheckpoint,
  ModelProviderInput,
  McpServerEditor,
  McpToolSummary,
  MemoryRecord,
  MemoryScope,
  PermissionCategory,
  PermissionPolicies,
  PermissionPolicy,
  RedactedModelProvider,
  SettingsPatch,
  SettingsScope,
  SettingsSnapshot,
  SkillStatus,
} from "@deki-ai/shared";
import { DEKI_VERSION } from "@deki-ai/shared";
import {
  builtinModelProviders,
  builtinProviderInput,
  isBuiltinModelProvider,
  type BuiltinModelProvider,
} from "./builtinModelProviders";
import { PermissionModeIcon } from "./PermissionModeIcon";
import {
  detectPermissionMode,
  permissionModeCopy,
  permissionModes,
  policiesForPermissionMode,
  type PermissionMode,
} from "./permissionModes";

type Locale = "zh-CN" | "en-US";
type SectionId =
  | "general"
  | "appearance"
  | "models"
  | "agent"
  | "workspace"
  | "permissions"
  | "mcp"
  | "skills"
  | "memory"
  | "privacy"
  | "advanced"
  | "about";

const sectionMeta: Array<{ id: SectionId; zh: string; en: string; keywords: string }> = [
  { id: "general", zh: "通用", en: "General", keywords: "language locale startup restore close update launch window 语言 界面 启动 开机 恢复 窗口 关闭 更新 检查" },
  { id: "appearance", zh: "外观", en: "Appearance", keywords: "theme accent font code density sidebar width motion animation contrast dark light 主题 强调色 字体 代码 密度 侧栏 宽度 动画 高对比 浅色 深色" },
  { id: "models", zh: "模型与提供方", en: "Models & Providers", keywords: "api key base url provider headers retry timeout model reasoning context output image 模型 密钥 提供方 请求头 重试 超时 思考 上下文 输出 图像" },
  { id: "agent", zh: "Agent 与会话", en: "Agent & Sessions", keywords: "session naming compaction concurrency retention summary restore history 会话 命名 压缩 并发 保留 摘要 恢复 历史" },
  { id: "workspace", zh: "项目与工作区", en: "Projects & Workspaces", keywords: "project trust git checkpoint context ignore instruction recent 项目 信任 git 检查点 上下文 忽略 说明 最近" },
  { id: "permissions", zh: "权限", en: "Permissions", keywords: "allow ask deny shell file network audit diff timeout install commit push sensitive 权限 审批 文件 网络 审计 差异 超时 安装 提交 推送 敏感" },
  { id: "mcp", zh: "MCP", en: "MCP", keywords: "stdio server tool timeout restart environment command args cwd server 工具 超时 重启 环境变量 命令 参数" },
  { id: "skills", zh: "Skills", en: "Skills", keywords: "skill reload conflict trust validate dependency source enable 技能 重载 冲突 信任 校验 依赖 来源 启用" },
  { id: "memory", zh: "记忆", en: "Memory", keywords: "memory recall candidate sensitive budget user project task pin archive search 记忆 召回 候选 敏感 预算 用户 项目 任务 置顶 归档 搜索" },
  { id: "privacy", zh: "数据与隐私", en: "Data & Privacy", keywords: "data privacy export import clear reset telemetry usage audit trash 数据 隐私 导出 导入 清理 重置 遥测 占用 审计 废纸篓" },
  { id: "advanced", zh: "高级与诊断", en: "Advanced & Diagnostics", keywords: "logs log level proxy certificate ca diagnostics experimental output limit 日志 级别 代理 证书 诊断 实验 输出 上限" },
  { id: "about", zh: "关于", en: "About", keywords: "version license agpl third party update channel release 版本 许可证 第三方 更新 通道 发布源" },
];
const projectScopedSections = new Set<SectionId>([
  "models",
  "agent",
  "workspace",
  "permissions",
  "mcp",
  "skills",
  "memory",
]);

const permissionLabels: Record<PermissionCategory, [string, string]> = {
  "workspace.read": ["工作区读取", "Workspace read"],
  "workspace.write": ["工作区创建与编辑", "Workspace create & edit"],
  "workspace.delete": ["删除、移动与批量覆盖", "Delete, move & bulk overwrite"],
  "shell.safe": ["已知安全 Shell", "Known-safe shell"],
  "shell.unknown": ["未知复杂 Shell", "Unknown shell"],
  "dependencies.install": ["依赖安装", "Dependency installation"],
  "git.commit": ["Git commit", "Git commit"],
  "git.push": ["Git push", "Git push"],
  outsideWorkspace: ["工作区外路径", "Paths outside workspace"],
  sensitiveFiles: ["敏感文件", "Sensitive files"],
  privileged: ["提权操作", "Privileged operations"],
  network: ["网络访问", "Network access"],
  "mcp.read": ["MCP 只读 Tool", "Read-only MCP tools"],
  "mcp.write": ["MCP 有副作用 Tool", "Mutating MCP tools"],
};

export function SettingsView(props: {
  snapshot: SettingsSnapshot;
  hasWorkspace: boolean;
  taskId?: string;
  locale: Locale;
  initialSection?: SectionId;
  initialScope?: SettingsScope;
  sessionPermissionPolicies?: PermissionPolicies;
  onSessionPermissionPoliciesChanged?: (policies: PermissionPolicies) => Promise<void>;
  onChanged: (snapshot: SettingsSnapshot) => void;
  onClose: () => void;
  onRefreshState: () => Promise<void>;
}) {
  const [scope, setScope] = useState<SettingsScope>(props.initialScope ?? "global");
  const [resetKey, setResetKey] = useState("");
  const [section, setSection] = useState<SectionId>(props.initialSection ?? "general");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [sessionPermissionPolicies, setSessionPermissionPolicies] = useState(
    props.sessionPermissionPolicies,
  );
  const [providers, setProviders] = useState<RedactedModelProvider[]>([]);
  const [editingProvider, setEditingProvider] = useState<ModelProviderInput>();
  const zh = props.locale === "zh-CN";

  useEffect(() => {
    void window.deki.listModelProviders().then(setProviders).catch((reason) => {
      setError(String(reason));
    });
  }, []);

  useEffect(() => {
    setSessionPermissionPolicies(props.sessionPermissionPolicies);
  }, [props.sessionPermissionPolicies]);

  useEffect(() => {
    if (!props.hasWorkspace && scope !== "global" && scope !== "session") setScope("global");
  }, [props.hasWorkspace, scope]);

  useEffect(() => {
    if (
      (scope === "projectShared" || scope === "projectLocal")
      && !projectScopedSections.has(section)
    ) setScope("global");
  }, [scope, section]);

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sectionMeta;
    return sectionMeta.filter((item) =>
      `${item.zh} ${item.en} ${item.keywords}`.toLocaleLowerCase().includes(needle));
  }, [query]);

  useEffect(() => {
    if (query.trim() && visibleSections.length > 0 && !visibleSections.some((item) => item.id === section)) {
      setSection(visibleSections[0]!.id);
    }
  }, [query, section, visibleSections]);

  async function update(patch: SettingsPatch) {
    setSaving(true);
    setError(undefined);
    try {
      const policies = patch.permissions?.policies;
      if (
        scope === "session"
        && section === "permissions"
        && policies
        && props.onSessionPermissionPoliciesChanged
      ) {
        await props.onSessionPermissionPoliciesChanged(policies);
        setSessionPermissionPolicies(policies);
        return;
      }
      const next = await window.deki.updateSettings(scope, patch, props.snapshot.revision);
      props.onChanged(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function reset(keys?: string[]) {
    setSaving(true);
    setError(undefined);
    try {
      const next = await window.deki.resetSettings(scope, keys, props.snapshot.revision);
      props.onChanged(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const value = scope === "session"
    && section === "permissions"
    && sessionPermissionPolicies
    ? {
        ...props.snapshot.effective,
        permissions: {
          ...props.snapshot.effective.permissions,
          policies: sessionPermissionPolicies,
        },
      }
    : props.snapshot.effective;
  const source = (path: string) => (
    scope === "session"
    && path.startsWith("permissions.policies.")
    && sessionPermissionPolicies
      ? "session"
      : props.snapshot.sources[path] ?? "default"
  );
  const resettableKeys = listLeafPaths(value[section as keyof DekiSettings], section);

  return (
    <section className="settings-page" data-testid="settings-page">
      <aside className="settings-nav">
        <header>
          <button className="icon-button settings-back" onClick={props.onClose} aria-label={zh ? "返回" : "Back"}>‹</button>
          <strong>{zh ? "设置" : "Settings"}</strong>
        </header>
        <input
          className="settings-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={zh ? "搜索设置…" : "Search settings…"}
          autoFocus
        />
        <nav>
          {visibleSections.map((item) => (
            <button
              key={item.id}
              data-testid={`settings-section-${item.id}`}
              className={section === item.id ? "active" : ""}
              onClick={() => setSection(item.id)}
            >
              {zh ? item.zh : item.en}
            </button>
          ))}
          {visibleSections.length === 0 && <p className="muted compact">{zh ? "没有匹配项" : "No matches"}</p>}
        </nav>
      </aside>

      <div className="settings-content">
        <header className="settings-toolbar">
          <div>
            <h1>{zh ? sectionMeta.find((item) => item.id === section)?.zh : sectionMeta.find((item) => item.id === section)?.en}</h1>
            <p>{zh ? "修改会立即保存；运行时相关设置会在安全时机重载。" : "Changes save immediately; runtime settings reload at a safe point."}</p>
          </div>
          <div className="scope-picker">
            <label>{zh ? "作用域" : "Scope"}</label>
            <select aria-label={zh ? "设置作用域" : "Settings scope"} value={scope} onChange={(event) => setScope(event.target.value as SettingsScope)}>
              <option value="global">{zh ? "全局" : "Global"}</option>
              <option value="session">{zh ? "当前会话" : "Current session"}</option>
              <option value="projectShared" disabled={!props.hasWorkspace || !projectScopedSections.has(section)}>{zh ? "当前项目（共享）" : "Current project (shared)"}</option>
              <option value="projectLocal" disabled={!props.hasWorkspace || !projectScopedSections.has(section)}>{zh ? "当前项目（本机）" : "Current project (local)"}</option>
            </select>
            <button className="ghost small-action" disabled={saving} onClick={() => void reset([section])}>
              {zh ? "恢复本分类" : "Reset section"}
            </button>
            <select aria-label={zh ? "选择单项设置" : "Select one setting"} value={resetKey} onChange={(event) => setResetKey(event.target.value)}>
              <option value="">{zh ? "选择单项…" : "Select one…"}</option>
              {resettableKeys.map((key) => <option value={key} key={key}>{key}</option>)}
            </select>
            <button className="ghost small-action" disabled={saving || !resetKey} onClick={() => void reset([resetKey])}>
              {zh ? "恢复单项" : "Reset item"}
            </button>
          </div>
        </header>

        {error && <p className="settings-error">{error}</p>}
        {props.snapshot.diagnostics.map((message) => <p className="settings-warning" key={message}>{message}</p>)}

        <div className="settings-section">
          {section === "general" && <GeneralSettings value={value} source={source} zh={zh} update={update} />}
          {section === "appearance" && <AppearanceSettings value={value} source={source} zh={zh} update={update} />}
          {section === "models" && (
            <ModelSettings
              value={value}
              source={source}
              zh={zh}
              providers={providers}
              editing={editingProvider}
              setEditing={setEditingProvider}
              update={update}
              refreshProviders={async () => setProviders(await window.deki.listModelProviders())}
              setError={setError}
            />
          )}
          {section === "agent" && <AgentSettings value={value} source={source} zh={zh} update={update} providers={providers} />}
          {section === "workspace" && (
            <WorkspaceSettings
              value={value}
              source={source}
              zh={zh}
              hasWorkspace={props.hasWorkspace}
              update={update}
              onRevoked={async () => {
                const result = await window.deki.revokeWorkspaceTrust();
                if (!result.ok) throw new Error(result.error);
                await props.onRefreshState();
              }}
            />
          )}
          {section === "permissions" && <PermissionSettings value={value} source={source} zh={zh} update={update} />}
          {section === "mcp" && <McpSettings value={value} source={source} zh={zh} update={update} hasWorkspace={props.hasWorkspace} />}
          {section === "skills" && <SkillSettings value={value} source={source} zh={zh} update={update} scope={scope} />}
          {section === "memory" && <MemorySettings value={value} source={source} zh={zh} update={update} hasWorkspace={props.hasWorkspace} {...(props.taskId ? { taskId: props.taskId } : {})} />}
          {section === "privacy" && <PrivacySettings value={value} source={source} zh={zh} update={update} />}
          {section === "advanced" && <AdvancedSettings value={value} source={source} zh={zh} update={update} />}
          {section === "about" && <AboutSettings value={value} zh={zh} update={update} />}
        </div>

        <footer className="settings-footer">
          <span>{saving ? (zh ? "正在保存…" : "Saving…") : (zh ? "所有更改已保存" : "All changes saved")}</span>
          <button className="danger-outline" disabled={saving} onClick={() => {
            if (window.confirm(zh ? "恢复当前作用域的全部设置？此操作无法撤销。" : "Reset every setting in this scope? This cannot be undone.")) void reset();
          }}>
            {zh ? "恢复当前作用域全部设置" : "Reset entire scope"}
          </button>
        </footer>
      </div>
    </section>
  );
}

type SettingsComponentProps = {
  value: DekiSettings;
  source: (path: string) => string;
  zh: boolean;
  update: (patch: SettingsPatch) => Promise<void>;
};

function GeneralSettings({ value, source, zh, update }: SettingsComponentProps) {
  return <>
    <Setting title={zh ? "界面语言" : "Language"} source={source("general.locale")}>
      <select value={value.general.locale} onChange={(e) => void update({ general: { locale: e.target.value as DekiSettings["general"]["locale"] } })}>
        <option value="system">{zh ? "跟随系统" : "System"}</option><option value="zh-CN">简体中文</option><option value="en-US">English</option>
      </select>
    </Setting>
    <Setting title={zh ? "默认启动模式" : "Default start mode"} source={source("general.startupMode")}>
      <select value={value.general.startupMode} onChange={(e) => void update({ general: { startupMode: e.target.value as "general" | "last-session" } })}>
        <option value="general">{zh ? "普通会话" : "General chat"}</option><option value="last-session">{zh ? "上次会话" : "Last session"}</option>
      </select>
    </Setting>
    <Toggle title={zh ? "恢复上次会话" : "Restore last session"} path="general.restoreSession" checked={value.general.restoreSession} source={source} onChange={(restoreSession) => update({ general: { restoreSession } })} />
    <Setting title={zh ? "关闭窗口时" : "When closing the window"} source={source("general.closeBehavior")}><select value={value.general.closeBehavior} onChange={(e) => void update({ general: { closeBehavior: e.target.value as "quit" | "keep-running" } })}><option value="quit">{zh ? "退出应用" : "Quit app"}</option><option value="keep-running">{zh ? "保持后台运行" : "Keep running"}</option></select></Setting>
    <Toggle title={zh ? "开机启动" : "Launch at login"} path="general.launchAtLogin" checked={value.general.launchAtLogin} source={source} onChange={(launchAtLogin) => update({ general: { launchAtLogin } })} />
    <Toggle title={zh ? "检查更新" : "Check for updates"} description={zh ? "启动后从 GitHub Releases 检查签名更新；下载完成后将在退出时安装。" : "Checks GitHub Releases for signed updates after startup and installs downloaded updates on quit."} path="general.checkUpdates" checked={value.general.checkUpdates} source={source} onChange={(checkUpdates) => update({ general: { checkUpdates } })} />
  </>;
}

function AppearanceSettings({ value, source, zh, update }: SettingsComponentProps) {
  return <>
    <Setting title={zh ? "主题" : "Theme"} source={source("appearance.theme")}><select value={value.appearance.theme} onChange={(e) => void update({ appearance: { theme: e.target.value as "system" | "dark" | "light" } })}><option value="system">{zh ? "跟随系统" : "System"}</option><option value="dark">{zh ? "深色" : "Dark"}</option><option value="light">{zh ? "浅色" : "Light"}</option></select></Setting>
    <Setting title={zh ? "强调色" : "Accent"} source={source("appearance.accent")}><select value={value.appearance.accent} onChange={(e) => void update({ appearance: { accent: e.target.value as DekiSettings["appearance"]["accent"] } })}><option value="indigo">Indigo</option><option value="blue">Blue</option><option value="violet">Violet</option><option value="emerald">Emerald</option></select></Setting>
    <Range title={zh ? "字号" : "Font size"} path="appearance.fontSize" value={value.appearance.fontSize} min={11} max={22} source={source} onChange={(fontSize) => update({ appearance: { fontSize } })} />
    <Setting title={zh ? "代码字体" : "Code font"} source={source("appearance.codeFont")}><input value={value.appearance.codeFont} onChange={(e) => void update({ appearance: { codeFont: e.target.value || "monospace" } })} /></Setting>
    <Range title={zh ? "侧栏宽度" : "Sidebar width"} path="appearance.sidebarWidth" value={value.appearance.sidebarWidth} min={200} max={420} step={4} source={source} onChange={(sidebarWidth) => update({ appearance: { sidebarWidth } })} />
    <Setting title={zh ? "界面密度" : "Density"} source={source("appearance.density")}><select value={value.appearance.density} onChange={(e) => void update({ appearance: { density: e.target.value as "compact" | "comfortable" } })}><option value="comfortable">{zh ? "舒适" : "Comfortable"}</option><option value="compact">{zh ? "紧凑" : "Compact"}</option></select></Setting>
    <Toggle title={zh ? "减少动画" : "Reduce motion"} path="appearance.reduceMotion" checked={value.appearance.reduceMotion} source={source} onChange={(reduceMotion) => update({ appearance: { reduceMotion } })} />
    <Toggle title={zh ? "高对比度" : "High contrast"} path="appearance.highContrast" checked={value.appearance.highContrast} source={source} onChange={(highContrast) => update({ appearance: { highContrast } })} />
  </>;
}

function ModelSettings(props: SettingsComponentProps & {
  providers: RedactedModelProvider[];
  editing: ModelProviderInput | undefined;
  setEditing: (provider: ModelProviderInput | undefined) => void;
  refreshProviders: () => Promise<void>;
  setError: (error: string | undefined) => void;
}) {
  const { value, source, zh, update } = props;
  const [addingProvider, setAddingProvider] = useState(false);
  const [selectedProviderType, setSelectedProviderType] = useState("");
  const customProviders = props.providers.filter((provider) => !isBuiltinModelProvider(provider.id));
  const modelOptions = props.providers.filter((provider) => provider.enabled !== false).flatMap((provider) => provider.models.map((model) => ({
    value: `${provider.id}/${model.id}`,
    label: `${model.name ?? model.id} · ${provider.name ?? provider.id}`,
  })));
  const closeProviderFlow = () => {
    setAddingProvider(false);
    setSelectedProviderType("");
    props.setEditing(undefined);
  };
  const openProviderFlow = (
    providerType = "",
    customProvider?: ModelProviderInput,
  ) => {
    setAddingProvider(true);
    setSelectedProviderType(providerType);
    props.setEditing(customProvider);
  };
  const selectedBuiltin = builtinModelProviders.find(
    (provider) => provider.id === selectedProviderType,
  );

  if (addingProvider) {
    return <div className="provider-add-flow" data-testid="provider-add-flow">
      <div className="provider-add-header">
        <button className="ghost provider-back" onClick={closeProviderFlow}>
          <span aria-hidden="true">←</span> {zh ? "返回供应商列表" : "Back to providers"}
        </button>
        <div>
          <h2>{selectedProviderType ? (zh ? "模型供应商详情" : "Model provider details") : (zh ? "添加模型供应商" : "Add model provider")}</h2>
          <p>{zh ? "配置连接、渠道状态和会话中可用的模型。" : "Configure the connection, provider status, and models available to chats."}</p>
        </div>
      </div>
      <section className="provider-picker-panel">
        <label className="provider-type-picker">
          <span>{zh ? "供应商类型" : "Provider type"}</span>
          <select
            aria-label={zh ? "供应商类型" : "Provider type"}
            value={selectedProviderType}
            onChange={(event) => {
              const next = event.target.value;
              setSelectedProviderType(next);
              if (next === "custom") {
                props.setEditing(emptyProvider(props.providers));
              } else {
                props.setEditing(undefined);
              }
            }}
          >
            <option value="">{zh ? "选择模型供应商…" : "Choose a model provider…"}</option>
            {builtinModelProviders.map((definition) => {
              const configured = props.providers.some((provider) => provider.id === definition.id);
              return <option key={definition.id} value={definition.id}>
                {definition.name}{configured ? (zh ? "（已添加）" : " (added)") : ""}
              </option>;
            })}
            <option value="custom">
              {customProviders.length > 0
                ? (zh ? "自定义模型（已添加）" : "Custom model (added)")
                : (zh ? "自定义模型" : "Custom model")}
            </option>
          </select>
        </label>
        {!selectedProviderType && <div className="provider-picker-empty">
          <span aria-hidden="true">＋</span>
          <p>{zh ? "从上方选择一个供应商开始配置" : "Choose a provider above to start configuring it"}</p>
        </div>}
        {selectedBuiltin && <ProviderManager
          key={selectedBuiltin.id}
          definition={selectedBuiltin}
          provider={props.providers.find((provider) => provider.id === selectedBuiltin.id)}
          zh={zh}
          onCancel={closeProviderFlow}
          onDone={async () => {
            await props.refreshProviders();
            closeProviderFlow();
          }}
          setError={props.setError}
        />}
        {selectedProviderType === "custom" && props.editing && <ProviderManager
          key={props.editing.id}
          initial={props.editing}
          provider={props.providers.find((provider) => provider.id === props.editing?.id)}
          zh={zh}
          onCancel={closeProviderFlow}
          onDone={async () => {
            await props.refreshProviders();
            closeProviderFlow();
          }}
          setError={props.setError}
        />}
      </section>
      <p className="provider-security-note">
        {zh
          ? "API Key 明文保存在本机权限为 0600 的配置文件中；界面、日志和导出不会回显密钥。"
          : "API keys are stored in a local 0600 file. The UI, logs, and exports never reveal them."}
      </p>
    </div>;
  }

  return <>
    <Setting title={zh ? "普通会话默认模型" : "Default general model"} source={source("models.generalModel")}><select value={value.models.generalModel} onChange={(e) => void update({ models: { generalModel: e.target.value } })}><option value="">{zh ? "自动选择" : "Auto-select"}</option>{modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Setting>
    <Setting title={zh ? "项目会话默认模型" : "Default project model"} source={source("models.projectModel")}><select value={value.models.projectModel} onChange={(e) => void update({ models: { projectModel: e.target.value } })}><option value="">{zh ? "自动选择" : "Auto-select"}</option>{modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Setting>
    <Setting title={zh ? "思考强度" : "Thinking level"} source={source("models.thinkingLevel")}><select value={value.models.thinkingLevel} onChange={(e) => void update({ models: { thinkingLevel: e.target.value as DekiSettings["models"]["thinkingLevel"] } })}>{["off", "minimal", "low", "medium", "high", "xhigh"].map((item) => <option value={item} key={item}>{item}</option>)}</select></Setting>
    <Toggle title={zh ? "自动重试" : "Automatic retry"} description={zh ? "使用 Pi Runtime 的安全重试策略。" : "Uses the Pi Runtime safe retry policy."} path="models.maxRetries" checked={value.models.maxRetries > 0} source={source} onChange={(enabled) => update({ models: { maxRetries: enabled ? 2 : 0 } })} />
    <Range title={zh ? "请求超时（秒）" : "Request timeout (seconds)"} path="models.timeoutMs" value={value.models.timeoutMs / 1000} min={1} max={600} source={source} onChange={(seconds) => update({ models: { timeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "最大输出 Tokens" : "Maximum output tokens"} path="models.maxOutputTokens" value={value.models.maxOutputTokens} min={256} max={262144} step={256} source={source} onChange={(maxOutputTokens) => update({ models: { maxOutputTokens } })} />
    <div className="settings-subsection">
      <div className="subsection-heading">
        <div>
          <h2>{zh ? "模型供应商" : "Model providers"}</h2>
          <p>{zh ? "这里只显示已经添加的供应商；内置配置在添加时选择。" : "Only added providers appear here. Choose built-in configurations when adding one."}</p>
        </div>
        <button className="primary small-action" onClick={() => openProviderFlow()}>
          <span aria-hidden="true">＋</span> {zh ? "添加模型供应商" : "Add model provider"}
        </button>
      </div>
      {props.providers.length === 0 && <div className="custom-provider-empty">
        <span aria-hidden="true">＋</span>
        <p>{zh ? "尚未添加模型供应商" : "No model providers added yet"}</p>
      </div>}
      <div className="provider-channel-list">
        {props.providers.map((provider) => {
          const definition = builtinModelProviders.find((item) => item.id === provider.id);
          return <article className="provider-card provider-channel-card" data-provider-id={provider.id} key={provider.id}>
            <div className="provider-channel-identity">
              <span className="provider-logo" aria-hidden="true">{definition?.shortName ?? "AI"}</span>
              <div>
                <strong>{provider.name ?? definition?.name ?? provider.id}</strong>
                <small>
                  {definition
                    ? (zh ? definition.description.zh : definition.description.en)
                    : provider.baseUrl ?? (zh ? "自定义 API" : "Custom API")}
                </small>
                <small>{provider.models.length} {zh ? "个模型" : "models"} · {provider.hasApiKey ? "Key ••••••••" : (zh ? "未配置 Key" : "No key")} · {provider.enabled === false ? (zh ? "已停用" : "Disabled") : (zh ? "已启用" : "Enabled")}</small>
              </div>
            </div>
            <div>
              <button className="ghost small-action" onClick={() => openProviderFlow(
                definition ? definition.id : "custom",
                definition ? undefined : toProviderInput(provider),
              )}>{zh ? "管理" : "Manage"}</button>
              <button className="danger small-action" onClick={async () => {
                const confirmed = window.confirm(
                  zh ? `移除模型供应商“${provider.name ?? provider.id}”？` : `Remove model provider "${provider.name ?? provider.id}"?`,
                );
                if (!confirmed) return;
                const result = await window.deki.removeModelProvider(provider.id);
                if (!result.ok) props.setError(result.error);
                else await props.refreshProviders();
              }}>{zh ? "移除" : "Remove"}</button>
            </div>
          </article>;
        })}
      </div>
      <p className="provider-security-note">
        {zh
          ? "API Key 明文保存在本机权限为 0600 的配置文件中；界面、日志和导出只显示配置状态。"
          : "API keys are stored in a local 0600 file. The UI, logs, and exports only expose configuration status."}
      </p>
    </div>
  </>;
}

function ProviderManager(props: {
  definition?: BuiltinModelProvider;
  initial?: ModelProviderInput;
  provider: RedactedModelProvider | undefined;
  zh: boolean;
  onCancel: () => void;
  onDone: () => Promise<void>;
  setError: (value: string | undefined) => void;
}) {
  const startingValue = props.provider
    ? toProviderInput(props.provider)
    : props.initial
      ? { ...props.initial, enabled: props.initial.enabled !== false }
      : builtinProviderInput(props.definition!, { action: "keep" });
  const [draft, setDraft] = useState<ModelProviderInput>({
    ...startingValue,
    enabled: startingValue.enabled !== false,
  });
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "fetch">();
  const [connectionStatus, setConnectionStatus] = useState<"success" | "error">();
  const [connectionMessage, setConnectionMessage] = useState<string>();
  const [fetchedModels, setFetchedModels] = useState<ModelProviderInput["models"]>([]);
  const [fetchMessage, setFetchMessage] = useState<string>();
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const isCustom = !props.definition;
  const hasStoredKey = Boolean(props.provider?.hasApiKey) && draft.apiKey.action !== "clear";
  const set = (patch: Partial<ModelProviderInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setConnectionStatus(undefined);
    setConnectionMessage(undefined);
  };
  const requestValue = (): ModelProviderInput => ({
    ...draft,
    apiKey: apiKey.trim()
      ? { action: "set", value: apiKey.trim() }
      : draft.apiKey,
  });
  const catalog = useMemo(() => {
    const byId = new Map<string, ModelProviderInput["models"][number]>();
    for (const model of props.definition?.config.models ?? []) byId.set(model.id, model);
    for (const model of fetchedModels) {
      const existing = byId.get(model.id);
      byId.set(model.id, existing ? { ...model, ...existing } : model);
    }
    return [...byId.values()];
  }, [fetchedModels, props.definition]);
  const availableModels = catalog.filter(
    (model) => !draft.models.some((enabled) => enabled.id === model.id),
  );
  const addModel = (model: ModelProviderInput["models"][number]) => {
    if (draft.models.some((item) => item.id === model.id)) return;
    set({ models: [...draft.models, model] });
  };
  const removeModel = (id: string) => {
    if (draft.models.length <= 1) {
      props.setError(props.zh ? "至少需要启用一个模型" : "At least one model must remain enabled");
      return;
    }
    set({ models: draft.models.filter((model) => model.id !== id) });
  };
  const validateCustomId = () => {
    if (isCustom && isBuiltinModelProvider(draft.id)) {
      props.setError(props.zh ? "自定义模型 ID 不能与内置供应商重复" : "The custom provider ID cannot match a built-in provider");
      return false;
    }
    return true;
  };
  const save = async () => {
    if (!validateCustomId()) return;
    setBusy("save");
    props.setError(undefined);
    try {
      const result = await window.deki.upsertModelProvider(requestValue());
      if (!result.ok) props.setError(result.error);
      else await props.onDone();
    } catch (reason) {
      props.setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };
  const testConnection = async () => {
    if (!validateCustomId()) return;
    setBusy("test");
    props.setError(undefined);
    setConnectionStatus(undefined);
    try {
      const result = await window.deki.testModelProvider(requestValue());
      setConnectionStatus(result.ok ? "success" : "error");
      setConnectionMessage(result.ok
        ? (props.zh ? "连接成功" : "Connection succeeded")
        : result.error);
    } catch (reason) {
      setConnectionStatus("error");
      setConnectionMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };
  const fetchModels = async () => {
    if (!validateCustomId()) return;
    setBusy("fetch");
    props.setError(undefined);
    setFetchMessage(undefined);
    try {
      const result = await window.deki.fetchModelProviderModels(requestValue());
      if (!result.ok) {
        setFetchMessage(result.error);
        return;
      }
      setFetchedModels(result.models ?? []);
      setFetchMessage(props.zh
        ? `成功获取 ${result.models?.length ?? 0} 个模型`
        : `Fetched ${result.models?.length ?? 0} models`);
    } catch (reason) {
      setFetchMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };
  const addManualModel = () => {
    const id = manualId.trim();
    if (!id) {
      props.setError(props.zh ? "请填写模型 ID" : "Enter a model ID");
      return;
    }
    if (draft.models.some((model) => model.id === id)) {
      props.setError(props.zh ? "该模型已经启用" : "That model is already enabled");
      return;
    }
    addModel({
      id,
      ...(manualName.trim() ? { name: manualName.trim() } : {}),
      input: ["text"],
    });
    setManualId("");
    setManualName("");
  };

  return <div className="provider-manager" data-provider-id={draft.id}>
    <section className="provider-manager-section">
      <h3>{props.zh ? "基本信息" : "Basic information"}</h3>
      <div className="provider-detail-card">
        {isCustom && <label className="provider-detail-field">
          <span>{props.zh ? "供应商 ID" : "Provider ID"}</span>
          <input value={draft.id} onChange={(event) => set({ id: event.target.value })} />
        </label>}
        <label className="provider-detail-field">
          <span>{props.zh ? "供应商名称" : "Provider name"}</span>
          <input value={draft.name ?? ""} onChange={(event) => set({ name: event.target.value || undefined })} />
        </label>
        <label className="provider-detail-field">
          <span>Base URL</span>
          <small>{props.zh ? "预览：" : "Preview: "}{providerEndpointPreview(draft)}</small>
          <input placeholder="https://api.example.com/v1" value={draft.baseUrl ?? ""} onChange={(event) => set({ baseUrl: event.target.value || undefined })} />
        </label>
        <label className="provider-detail-field">
          <span>{props.zh ? "API 格式" : "API format"}</span>
          <select value={draft.api ?? "openai-completions"} onChange={(event) => set({ api: event.target.value })}>
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="google-generative-ai">Google Generative AI</option>
          </select>
        </label>
        <div className="provider-detail-field provider-key-field">
          <div className="provider-field-heading">
            <span>API Key</span>
            <button className="ghost small-action" disabled={Boolean(busy)} onClick={() => void testConnection()}>
              ⚡ {busy === "test" ? (props.zh ? "测试中…" : "Testing…") : (props.zh ? "测试连接" : "Test connection")}
            </button>
          </div>
          <div className="provider-secret-input">
            <input
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              autoComplete="new-password"
              placeholder={hasStoredKey ? "••••••••••••••••" : (props.zh ? "填写 API Key" : "Enter API key")}
              aria-label={`${draft.name ?? draft.id} API Key`}
              onChange={(event) => {
                setApiKey(event.target.value);
                setConnectionStatus(undefined);
                setConnectionMessage(undefined);
                setDraft((current) => ({
                  ...current,
                  apiKey: event.target.value
                    ? { action: "set", value: event.target.value }
                    : { action: "keep" },
                }));
              }}
            />
            <button className="secret-visibility" aria-label={showApiKey ? (props.zh ? "隐藏 API Key" : "Hide API key") : (props.zh ? "显示 API Key" : "Show API key")} onClick={() => setShowApiKey((shown) => !shown)}>◉</button>
          </div>
          <div className="provider-key-meta">
            {connectionMessage && <span className={`connection-state ${connectionStatus ?? "error"}`}>
              {connectionStatus === "success" ? "✓" : "!"} {connectionMessage}
            </span>}
            {hasStoredKey && <button className="link-button" onClick={() => {
              setApiKey("");
              set({ apiKey: { action: "clear" } });
            }}>{props.zh ? "清除已保存 Key" : "Clear saved key"}</button>}
          </div>
        </div>
        <details className="provider-advanced">
          <summary>{props.zh ? "高级连接设置" : "Advanced connection settings"}</summary>
          <label className="provider-detail-field">
            <span>{props.zh ? "额外 Headers（每行 Name: Value）" : "Extra headers (Name: Value per line)"}</span>
            <textarea value={Object.entries(draft.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n")} onChange={(event) => set({ headers: parseHeaders(event.target.value) })} />
          </label>
          <label className="provider-checkbox">
            <input type="checkbox" checked={draft.authHeader !== false} onChange={(event) => set({ authHeader: event.target.checked })} />
            <span>{props.zh ? "自动添加 Authorization Header" : "Add Authorization header automatically"}</span>
          </label>
        </details>
        <div className="provider-enabled-row">
          <div>
            <strong>{props.zh ? "启用此渠道" : "Enable this provider"}</strong>
            <small>{props.zh ? "关闭后该渠道不会在模型选择中出现" : "Disabled providers do not appear in the model selector"}</small>
          </div>
          <label className="toggle">
            <input aria-label={props.zh ? "启用此渠道" : "Enable this provider"} type="checkbox" checked={draft.enabled !== false} onChange={(event) => set({ enabled: event.target.checked })} />
            <span />
          </label>
        </div>
      </div>
    </section>

    <section className="provider-manager-section">
      <div className="provider-section-heading">
        <div><h3>{props.zh ? "已启用模型" : "Enabled models"}</h3><p>{draft.models.length} {props.zh ? "个模型" : "models"}</p></div>
      </div>
      <div className="provider-model-list">
        {draft.models.map((model) => <div className="provider-model-row" key={model.id}>
          <span className="model-enabled-mark">✓</span>
          <div><strong>{model.name ?? model.id}</strong>{model.name && <small>{model.id}</small>}</div>
          <button className="ghost small-action" disabled={draft.models.length <= 1} onClick={() => removeModel(model.id)}>{props.zh ? "停用" : "Disable"}</button>
        </div>)}
      </div>
    </section>

    <section className="provider-manager-section">
      <div className="provider-section-heading">
        <div>
          <h3>{props.zh ? "可用模型" : "Available models"}</h3>
          {fetchMessage && <p className={fetchMessage.startsWith(props.zh ? "成功" : "Fetched") ? "connection-state success" : "connection-state error"}>{fetchMessage}</p>}
        </div>
        <button className="ghost small-action" disabled={Boolean(busy)} onClick={() => void fetchModels()}>
          ↓ {busy === "fetch" ? (props.zh ? "获取中…" : "Fetching…") : (props.zh ? "从供应商获取" : "Fetch from provider")}
        </button>
      </div>
      <div className="provider-model-list available">
        {availableModels.length === 0
          ? <div className="provider-model-empty">{props.zh ? "所有已知模型已启用；也可以从供应商获取最新列表。" : "All known models are enabled. You can also fetch the latest catalog."}</div>
          : availableModels.map((model) => <div className="provider-model-row" key={model.id}>
            <span className="model-available-mark">＋</span>
            <div><strong>{model.name ?? model.id}</strong>{model.name && <small>{model.id}</small>}</div>
            <button className="ghost small-action" onClick={() => addModel(model)}>{props.zh ? "启用" : "Enable"}</button>
          </div>)}
        <div className="provider-manual-model">
          <input aria-label={props.zh ? "模型 ID" : "Model ID"} placeholder={props.zh ? "模型 ID（如 claude-opus-4-6）" : "Model ID (for example claude-opus-4-6)"} value={manualId} onChange={(event) => setManualId(event.target.value)} />
          <input aria-label={props.zh ? "显示名称" : "Display name"} placeholder={props.zh ? "显示名称（可选）" : "Display name (optional)"} value={manualName} onChange={(event) => setManualName(event.target.value)} />
          <button className="ghost" aria-label={props.zh ? "手动添加模型" : "Add model manually"} onClick={addManualModel}>＋</button>
        </div>
      </div>
    </section>

    <div className="editor-actions provider-manager-actions">
      <button className="ghost" onClick={props.onCancel}>{props.zh ? "取消" : "Cancel"}</button>
      <button className="primary" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? (props.zh ? "保存中…" : "Saving…") : (props.zh ? "保存渠道" : "Save provider")}</button>
    </div>
  </div>;
}

function AgentSettings({ value, source, zh, update, providers }: SettingsComponentProps & {
  providers: RedactedModelProvider[];
}) {
  const modelOptions = providers.filter((provider) => provider.enabled !== false).flatMap((provider) => provider.models.map((model) => ({
    value: `${provider.id}/${model.id}`,
    label: `${model.name ?? model.id} · ${provider.name ?? provider.id}`,
  })));
  const routeProfiles = [
    "coordinator", "explorer", "implementer", "tester", "reviewer", "integrator",
  ] as const;
  const updateRoute = (
    profile: typeof routeProfiles[number],
    index: number,
    model: string,
  ) => {
    const next = structuredClone(value.agent.planModelRoutes);
    const route = [...next[profile]];
    if (model) route[index] = model;
    else route.splice(index, 1);
    next[profile] = route.filter(Boolean).slice(0, 3);
    return update({ agent: { planModelRoutes: next } });
  };
  return <>
    <Toggle title={zh ? "自动命名会话" : "Auto-name sessions"} path="agent.autoNameSessions" checked={value.agent.autoNameSessions} source={source} onChange={(autoNameSessions) => update({ agent: { autoNameSessions } })} />
    <Toggle title={zh ? "上下文压缩" : "Context compaction"} path="agent.compactionEnabled" checked={value.agent.compactionEnabled} source={source} onChange={(compactionEnabled) => update({ agent: { compactionEnabled } })} />
    <Range title={zh ? "压缩触发阈值（Tokens）" : "Compaction threshold (tokens)"} path="agent.compactionThreshold" value={value.agent.compactionThreshold} min={1000} max={1000000} step={1000} source={source} onChange={(compactionThreshold) => update({ agent: { compactionThreshold } })} />
    <Range title={zh ? "最大并发运行数" : "Maximum concurrent runs"} path="agent.maxConcurrentRuns" value={value.agent.maxConcurrentRuns} min={1} max={8} source={source} onChange={(maxConcurrentRuns) => update({ agent: { maxConcurrentRuns } })} />
    <Range title={zh ? "每个任务最多 Worker" : "Maximum workers per task"} path="agent.workerMaxPerRoot" value={value.agent.workerMaxPerRoot} min={1} max={4} source={source} onChange={(workerMaxPerRoot) => update({ agent: { workerMaxPerRoot } })} />
    <Range title={zh ? "Worker 超时（秒）" : "Worker timeout (seconds)"} path="agent.workerTimeoutMs" value={Math.round(value.agent.workerTimeoutMs / 1000)} min={10} max={3600} step={10} source={source} onChange={(seconds) => update({ agent: { workerTimeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "Worker 输入 Token 上限" : "Worker input token limit"} path="agent.workerMaxInputTokens" value={value.agent.workerMaxInputTokens} min={1000} max={1000000} step={1000} source={source} onChange={(workerMaxInputTokens) => update({ agent: { workerMaxInputTokens } })} />
    <Range title={zh ? "Worker 输出 Token 上限" : "Worker output token limit"} path="agent.workerMaxOutputTokens" value={value.agent.workerMaxOutputTokens} min={256} max={262144} step={256} source={source} onChange={(workerMaxOutputTokens) => update({ agent: { workerMaxOutputTokens } })} />
    <Range title={zh ? "Worker Tool 调用上限" : "Worker tool-call limit"} path="agent.workerMaxToolCalls" value={value.agent.workerMaxToolCalls} min={1} max={1000} source={source} onChange={(workerMaxToolCalls) => update({ agent: { workerMaxToolCalls } })} />
    <Setting title={zh ? "Worker 模型" : "Worker model"} source={source("agent.workerModel")}><select value={value.agent.workerModel} onChange={(event) => void update({ agent: { workerModel: event.target.value } })}><option value="">{zh ? "继承主 Agent" : "Inherit main agent"}</option>{modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Setting>
    <Toggle title={zh ? "实验性 Plan DAG" : "Experimental Plan DAG"} description={zh ? "批准后由持久化 DAG 自动并行调度，并插入 Reviewer/Integrator。" : "Compile approved Plans into a persistent parallel DAG with Reviewer/Integrator gates."} path="agent.dagExecutionEnabled" checked={value.agent.dagExecutionEnabled} source={source} onChange={(dagExecutionEnabled) => update({ agent: { dagExecutionEnabled } })} />
    {value.agent.dagExecutionEnabled && <>
      <Range title={zh ? "Plan 最大并发步骤" : "Maximum parallel Plan steps"} path="agent.planMaxConcurrentSteps" value={value.agent.planMaxConcurrentSteps} min={1} max={8} source={source} onChange={(planMaxConcurrentSteps) => update({ agent: { planMaxConcurrentSteps } })} />
      <Range title={zh ? "Plan 时长预算（秒）" : "Plan duration budget (seconds)"} path="agent.planMaxDurationMs" value={Math.round(value.agent.planMaxDurationMs / 1000)} min={10} max={86400} step={10} source={source} onChange={(seconds) => update({ agent: { planMaxDurationMs: seconds * 1000 } })} />
      <Range title={zh ? "Plan 输入 Token 预算" : "Plan input token budget"} path="agent.planMaxInputTokens" value={value.agent.planMaxInputTokens} min={1000} max={100000000} step={1000} source={source} onChange={(planMaxInputTokens) => update({ agent: { planMaxInputTokens } })} />
      <Range title={zh ? "Plan 输出 Token 预算" : "Plan output token budget"} path="agent.planMaxOutputTokens" value={value.agent.planMaxOutputTokens} min={256} max={10000000} step={256} source={source} onChange={(planMaxOutputTokens) => update({ agent: { planMaxOutputTokens } })} />
      <Range title={zh ? "Plan Tool 调用预算" : "Plan tool-call budget"} path="agent.planMaxToolCalls" value={value.agent.planMaxToolCalls} min={1} max={100000} source={source} onChange={(planMaxToolCalls) => update({ agent: { planMaxToolCalls } })} />
      {routeProfiles.map((profile) => <Setting
        key={profile}
        title={`${profile[0]!.toUpperCase()}${profile.slice(1)} ${zh ? "模型链" : "model route"}`}
        description={zh ? "从高质量到经济型；空项继承 Worker/项目模型。" : "Quality to economy; empty entries inherit the worker/project model."}
        source={source(`agent.planModelRoutes.${profile}`)}
      ><div className="button-group">{[0, 1, 2].map((index) => <select
        key={index}
        value={value.agent.planModelRoutes[profile][index] ?? ""}
        onChange={(event) => void updateRoute(profile, index, event.target.value)}
      ><option value="">{index === 0 ? (zh ? "继承" : "Inherit") : "—"}</option>{modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>)}</div></Setting>)}
    </>}
    <Toggle title={zh ? "显示思考摘要" : "Show thinking summary"} path="agent.showThinkingSummary" checked={value.agent.showThinkingSummary} source={source} onChange={(showThinkingSummary) => update({ agent: { showThinkingSummary } })} />
    <Range title={zh ? "会话保留天数" : "Session retention days"} path="agent.sessionRetentionDays" value={value.agent.sessionRetentionDays} min={1} max={3650} source={source} onChange={(sessionRetentionDays) => update({ agent: { sessionRetentionDays } })} />
  </>;
}

function WorkspaceSettings(props: SettingsComponentProps & { hasWorkspace: boolean; onRevoked: () => Promise<void> }) {
  const { zh, value, source, update } = props;
  const [checkpoints, setCheckpoints] = useState<GitCheckpoint[]>([]);
  const [checkpointMessage, setCheckpointMessage] = useState<string>();
  const [checkpointDiff, setCheckpointDiff] = useState<string>();
  const refreshCheckpoints = async () => {
    if (props.hasWorkspace) setCheckpoints(await window.deki.listGitCheckpoints());
  };
  useEffect(() => {
    void refreshCheckpoints();
  }, [props.hasWorkspace]);
  return <>
    {!props.hasWorkspace && <p className="settings-warning">{zh ? "普通会话未关联项目；项目设置需要先选择并信任工作区。" : "General chat has no project. Select and trust a workspace for project settings."}</p>}
    <Setting title={zh ? "上下文忽略规则" : "Context ignore rules"} description={zh ? "每行一个目录或相对路径。" : "One directory or relative path per line."} source={source("workspace.contextIgnore")}><textarea value={value.workspace.contextIgnore.join("\n")} onChange={(event) => void update({ workspace: { contextIgnore: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    <Setting title={zh ? "项目说明文件" : "Project context files"} description={zh ? "每行一个工作区内相对路径。" : "One workspace-relative path per line."} source={source("workspace.contextFiles")}><textarea value={value.workspace.contextFiles.join("\n")} onChange={(event) => void update({ workspace: { contextFiles: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    <Toggle title={zh ? "检测 Git 工作区" : "Detect Git workspace"} path="workspace.detectGit" checked={value.workspace.detectGit} source={source} onChange={(detectGit) => update({ workspace: { detectGit } })} />
    <Toggle title={zh ? "修改前自动创建 Git Checkpoint" : "Create a Git Checkpoint before changes"} description={zh ? "使用独立临时 index 保存到 refs/deki/checkpoints，不改变当前分支、HEAD 或暂存区。" : "Uses an isolated temporary index and refs/deki/checkpoints without changing the current branch, HEAD, or staging area."} path="workspace.gitCheckpointBeforeWrite" checked={value.workspace.gitCheckpointBeforeWrite} source={source} onChange={(gitCheckpointBeforeWrite) => update({ workspace: { gitCheckpointBeforeWrite } })} />
    <Toggle title={zh ? "加载项目记忆" : "Load project memory"} path="workspace.loadProjectMemory" checked={value.workspace.loadProjectMemory} source={source} onChange={(loadProjectMemory) => update({ workspace: { loadProjectMemory } })} />
    {props.hasWorkspace && <div className="settings-subsection">
      <div className="subsection-heading">
        <div><h2>Git Checkpoints</h2><p>{zh ? "恢复前会再创建一个安全 Checkpoint，且不会删除现有未跟踪文件。" : "Restore creates a safety checkpoint first and never deletes existing untracked files."}</p></div>
        <div className="button-group">
          <button className="ghost small-action" onClick={() => void refreshCheckpoints()}>{zh ? "刷新" : "Refresh"}</button>
          <button className="primary small-action" onClick={async () => {
            const result = await window.deki.createGitCheckpoint(zh ? "手动 Checkpoint" : "Manual checkpoint");
            setCheckpointMessage(result.ok ? (zh ? "Checkpoint 已创建" : "Checkpoint created") : result.error);
            await refreshCheckpoints();
          }}>{zh ? "立即创建" : "Create now"}</button>
        </div>
      </div>
      {checkpointMessage && <p className="muted">{checkpointMessage}</p>}
      {checkpoints.length === 0 && <p className="muted">{zh ? "暂无 Checkpoint，或当前项目不是 Git 仓库。" : "No checkpoints, or this project is not a Git repository."}</p>}
      {checkpoints.slice(0, 20).map((checkpoint) => <div className="provider-card" key={checkpoint.id}>
        <div><strong>{checkpoint.message}</strong><small>{checkpoint.id} · {new Date(checkpoint.createdAt).toLocaleString()}</small></div>
        <div className="button-group">
          <button className="ghost small-action" onClick={async () => setCheckpointDiff(await window.deki.previewGitCheckpoint(checkpoint.id))}>{zh ? "查看差异" : "Preview diff"}</button>
          <button className="danger small-action" onClick={async () => {
            const result = await window.deki.restoreGitCheckpoint(checkpoint.id);
            setCheckpointMessage(result.ok ? (zh ? "已恢复；恢复前状态也已保存" : "Restored; the previous state was saved") : result.error);
            await refreshCheckpoints();
          }}>{zh ? "恢复" : "Restore"}</button>
        </div>
      </div>)}
      {checkpointDiff !== undefined && <><div className="editor-actions"><button className="ghost small-action" onClick={() => setCheckpointDiff(undefined)}>{zh ? "关闭差异" : "Close diff"}</button></div><pre className="checkpoint-diff">{checkpointDiff || (zh ? "没有差异" : "No differences")}</pre></>}
    </div>}
    {props.hasWorkspace && <Setting title={zh ? "撤销当前工作区信任" : "Revoke workspace trust"} description={zh ? "会立即停止 MCP、卸载项目 Skill 并关闭项目 Runtime。" : "Immediately stops MCP, unloads project skills, and closes the project runtime."} source="local"><button className="danger" onClick={() => void props.onRevoked()}>{zh ? "撤销信任" : "Revoke trust"}</button></Setting>}
  </>;
}

function PermissionSettings({ value, source, zh, update }: SettingsComponentProps) {
  const setPolicy = (category: PermissionCategory, policy: PermissionPolicy) => {
    void update({ permissions: { policies: { ...value.permissions.policies, [category]: policy } } });
  };
  const selectedMode = detectPermissionMode(value.permissions.policies);
  const groups: Array<{ title: string; categories: PermissionCategory[] }> = [
    {
      title: zh ? "文件与工作区" : "Files & workspace",
      categories: ["workspace.read", "workspace.write", "workspace.delete", "outsideWorkspace", "sensitiveFiles"],
    },
    {
      title: zh ? "Shell 与网络" : "Shell & network",
      categories: ["shell.safe", "shell.unknown", "dependencies.install", "network", "privileged"],
    },
    {
      title: "Git",
      categories: ["git.commit", "git.push"],
    },
    {
      title: "MCP",
      categories: ["mcp.read", "mcp.write"],
    },
  ];
  const applyMode = (mode: PermissionMode) => {
    void update({ permissions: { policies: policiesForPermissionMode(mode) } });
  };
  return <>
    <div className="permission-mode-cards" aria-label={zh ? "权限模式" : "Permission modes"}>
      {permissionModes.map((mode) => {
        const copy = permissionModeCopy(mode, zh);
        return <button
          className={`permission-mode-card${selectedMode === mode ? " selected" : ""}${mode === "full" ? " full-access" : ""}`}
          aria-pressed={selectedMode === mode}
          key={mode}
          onClick={() => applyMode(mode)}
        >
          <PermissionModeIcon mode={mode} />
          <span>
            <strong>{copy.title}</strong>
            <small>{copy.description}</small>
          </span>
          {selectedMode === mode && <span className="permission-mode-check" aria-hidden="true">✓</span>}
        </button>;
      })}
    </div>
    <p className={selectedMode === "full" ? "settings-danger" : "settings-warning"}>
      {selectedMode === "full"
        ? (zh ? "完全访问权限已开启：工具调用不会再请求批准，包括敏感文件、提权、工作区外路径和网络访问。" : "Full access is enabled: tool calls will not ask for approval, including sensitive files, privileged operations, outside paths, and network access.")
        : (zh ? "权限模式会设置整组策略；你仍可在下方逐项覆盖，覆盖后将显示为“自定义权限”。" : "A mode sets the complete policy set. Override individual items below to create custom permissions.")}
    </p>
    {groups.map((group) => (
      <section className="settings-group" key={group.title}>
        <h2>{group.title}</h2>
        {group.categories.map((category) => (
          <Setting key={category} title={permissionLabels[category][zh ? 0 : 1]} source={source(`permissions.policies.${category}`)}>
            <select value={value.permissions.policies[category]} onChange={(e) => setPolicy(category, e.target.value as PermissionPolicy)}>
              <option value="allow">{zh ? "自动允许" : "Allow"}</option>
              <option value="ask">{zh ? "每次确认" : "Ask"}</option>
              <option value="deny">{zh ? "拒绝" : "Deny"}</option>
            </select>
          </Setting>
        ))}
      </section>
    ))}
    <Range title={zh ? "审批超时（秒）" : "Approval timeout (seconds)"} path="permissions.approvalTimeoutMs" value={value.permissions.approvalTimeoutMs / 1000} min={5} max={600} source={source} onChange={(seconds) => update({ permissions: { approvalTimeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "审计保留天数" : "Audit retention days"} path="permissions.auditRetentionDays" value={value.permissions.auditRetentionDays} min={1} max={365} source={source} onChange={(auditRetentionDays) => update({ permissions: { auditRetentionDays } })} />
    <Toggle title={zh ? "修改后始终显示完整 Diff" : "Always show full diff after changes"} description={zh ? "安全要求，固定开启。" : "Required by the safety policy and always enabled."} path="permissions.showDiffAfterWrite" checked disabled source={source} onChange={() => Promise.resolve()} />
  </>;
}

function McpSettings({ value, source, zh, update, hasWorkspace }: SettingsComponentProps & { hasWorkspace: boolean }) {
  const [servers, setServers] = useState<McpServerEditor[]>([]);
  const [editing, setEditing] = useState<McpServerEditor>();
  const [message, setMessage] = useState<string>();
  const [tools, setTools] = useState<Record<string, McpToolSummary[]>>({});
  const refresh = async () => setServers(await window.deki.listMcpServers());
  useEffect(() => {
    if (hasWorkspace) void refresh();
  }, [hasWorkspace]);
  const save = async () => {
    if (!editing) return;
    const result = await window.deki.upsertMcpServer(editing);
    setMessage(result.ok ? (zh ? "已保存并重载 MCP" : "Saved and reloaded MCP") : result.error);
    if (result.ok) {
      setEditing(undefined);
      await refresh();
    }
  };
  const runServerAction = async (
    id: string,
    action: "start" | "stop" | "restart" | "test",
  ) => {
    const result = action === "start"
      ? await window.deki.startMcpServer(id)
      : action === "stop"
        ? await window.deki.stopMcpServer(id)
        : action === "restart"
          ? await window.deki.restartMcpServer(id)
          : await window.deki.testMcpServer(id);
    setMessage(result.ok
      ? (result.error ?? (zh ? "操作成功" : "Operation succeeded"))
      : result.error);
    await refresh();
  };
  const reload = async () => {
    const result = await window.deki.reloadMcpServers();
    setMessage(result.ok
      ? (zh ? "MCP 已重新加载" : "MCP reloaded")
      : result.error);
    await refresh();
  };
  return <>
    <p className="settings-warning">{zh ? "仅支持项目 .deki/mcp.json 中的 stdio Server；不内置示例，不支持 HTTP 或 OAuth。" : "Only stdio servers in project .deki/mcp.json are supported. No built-in examples, HTTP, or OAuth."}</p>
    <Toggle title={zh ? "启动已启用的 Server" : "Start enabled servers"} path="mcp.startEnabledServers" checked={value.mcp.startEnabledServers} source={source} onChange={(startEnabledServers) => update({ mcp: { startEnabledServers } })} />
    <Range title={zh ? "启动超时（秒）" : "Startup timeout (seconds)"} path="mcp.startupTimeoutMs" value={value.mcp.startupTimeoutMs / 1000} min={1} max={120} source={source} onChange={(seconds) => update({ mcp: { startupTimeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "Tool 调用超时（秒）" : "Tool timeout (seconds)"} path="mcp.callTimeoutMs" value={value.mcp.callTimeoutMs / 1000} min={1} max={600} source={source} onChange={(seconds) => update({ mcp: { callTimeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "健康检查间隔（秒）" : "Health check interval (seconds)"} path="mcp.healthCheckIntervalMs" value={value.mcp.healthCheckIntervalMs / 1000} min={5} max={3600} source={source} onChange={(seconds) => update({ mcp: { healthCheckIntervalMs: seconds * 1000 } })} />
    <Toggle title={zh ? "异常后自动重启与重连" : "Auto-restart and reconnect"} path="mcp.autoRestart" checked={value.mcp.autoRestart} source={source} onChange={(autoRestart) => update({ mcp: { autoRestart } })} />
    <Range title={zh ? "最大重连次数" : "Maximum reconnect attempts"} path="mcp.maxReconnectAttempts" value={value.mcp.maxReconnectAttempts} min={0} max={20} source={source} onChange={(maxReconnectAttempts) => update({ mcp: { maxReconnectAttempts } })} />
    <div className="settings-subsection">
      <div className="subsection-heading"><div><h2>stdio Servers</h2><p>{hasWorkspace ? ".deki/mcp.json" : (zh ? "普通会话不可用" : "Unavailable in general chat")}</p></div><div><button className="ghost small-action" disabled={!hasWorkspace} onClick={() => void reload()}>{zh ? "重载" : "Reload"}</button> <button className="primary small-action" disabled={!hasWorkspace} onClick={() => setEditing({ id: "server", command: "", args: [], enabled: true, tools: {}, environment: {} })}>{zh ? "添加" : "Add"}</button></div></div>
      {message && <p className="muted">{message}</p>}
      {servers.map((server) => <div className="mcp-server-card" key={server.id}>
        <div className="mcp-server-summary">
          <div>
            <strong>{server.id}</strong>
            <span className={`provider-status ${server.state === "ready" ? "configured" : ""}`}>{server.state ?? "stopped"}</span>
          </div>
          <small>{server.command} {server.args.join(" ")} · {server.toolCount ?? 0} tools · {server.enabled ? "enabled" : "disabled"}{server.lastCheckedAt ? ` · checked ${new Date(server.lastCheckedAt).toLocaleTimeString()}` : ""}{server.reconnectAttempt ? ` · retry ${server.reconnectAttempt}` : ""}</small>
          {server.error && <p className="error compact">{server.error}</p>}
        </div>
        <div className="mcp-server-actions">
          {server.state === "ready"
            ? <button className="ghost small-action" onClick={() => void runServerAction(server.id, "stop")}>{zh ? "停止" : "Stop"}</button>
            : <button className="ghost small-action" onClick={() => void runServerAction(server.id, "start")}>{zh ? "启动" : "Start"}</button>}
          <button className="ghost small-action" onClick={() => void runServerAction(server.id, "restart")}>{zh ? "重启" : "Restart"}</button>
          <button className="ghost small-action" onClick={() => void runServerAction(server.id, "test")}>{zh ? "测试" : "Test"}</button>
          <button className="ghost small-action" onClick={async () => {
            const listed = await window.deki.listMcpServerTools(server.id);
            setTools((current) => ({ ...current, [server.id]: current[server.id] ? [] : listed }));
          }}>{zh ? "Tools" : "Tools"}</button>
          <button className="ghost small-action" onClick={() => setEditing(server)}>{zh ? "编辑" : "Edit"}</button>
          <button className="danger small-action" onClick={async () => { const result = await window.deki.removeMcpServer(server.id); setMessage(result.error); await refresh(); }}>{zh ? "删除" : "Remove"}</button>
        </div>
        {(tools[server.id]?.length ?? 0) > 0 && <div className="mcp-tool-list">
          {tools[server.id]?.map((tool) => <div key={tool.name} className="mcp-tool-rule">
            <div><strong>{tool.name}</strong><span>{tool.description} · {tool.readOnlyHint ? "read-only" : "side effects possible"}</span></div>
            <label><input type="checkbox" checked={tool.enabled} onChange={async (event) => {
              const rule = server.tools[tool.name] ?? { enabled: true };
              await window.deki.upsertMcpServer({
                ...server,
                tools: { ...server.tools, [tool.name]: { ...rule, enabled: event.target.checked } },
              });
              await refresh();
            }} /> {zh ? "启用" : "Enabled"}</label>
            <select value={tool.permission ?? ""} onChange={async (event) => {
              const rule = server.tools[tool.name] ?? { enabled: true };
              const permission = event.target.value as PermissionPolicy | "";
              const { permission: _permission, ...withoutPermission } = rule;
              await window.deki.upsertMcpServer({
                ...server,
                tools: {
                  ...server.tools,
                  [tool.name]: permission ? { ...rule, permission } : withoutPermission,
                },
              });
              await refresh();
            }}><option value="">{zh ? "自动策略" : "Automatic"}</option><option value="allow">allow</option><option value="ask">ask</option><option value="deny">deny</option></select>
            <input type="number" min={1} max={600} value={(tool.timeoutMs ?? value.mcp.callTimeoutMs) / 1000} aria-label={`${tool.name} timeout`} onChange={async (event) => {
              const rule = server.tools[tool.name] ?? { enabled: true };
              await window.deki.upsertMcpServer({
                ...server,
                tools: { ...server.tools, [tool.name]: { ...rule, timeoutMs: Number(event.target.value) * 1000 } },
              });
              await refresh();
            }} />
          </div>)}
        </div>}
      </div>)}
      {editing && <div className="provider-editor"><div className="field-grid"><label><span>ID</span><input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} /></label><label><span>{zh ? "命令" : "Command"}</span><input value={editing.command} onChange={(e) => setEditing({ ...editing, command: e.target.value })} /></label><label className="wide"><span>{zh ? "参数（每行一个）" : "Arguments (one per line)"}</span><textarea value={editing.args.join("\n")} onChange={(e) => setEditing({ ...editing, args: e.target.value.split("\n") })} /></label><label><span>cwd</span><input value={editing.cwd ?? ""} onChange={(e) => { const { cwd: _cwd, ...rest } = editing; setEditing(e.target.value ? { ...rest, cwd: e.target.value } : rest); }} /></label><label><span>enabled</span><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /></label><label className="wide"><span>{zh ? "本机环境变量（每行 NAME=VALUE；Secret 可写 ${secret:NAME}）" : "Local environment (NAME=VALUE; use ${secret:NAME} for secrets)"}</span><textarea value={Object.entries(editing.environment ?? {}).map(([key, envValue]) => `${key}=${envValue}`).join("\n")} onChange={(event) => setEditing({ ...editing, environment: parseEnvironment(event.target.value) })} /></label></div><div className="editor-actions"><button className="ghost" onClick={() => setEditing(undefined)}>{zh ? "取消" : "Cancel"}</button><button className="primary" onClick={() => void save()}>{zh ? "保存" : "Save"}</button></div></div>}
    </div>
  </>;
}

function SkillSettings({ value, source, zh, update, scope }: SettingsComponentProps & { scope: SettingsScope }) {
  const [skills, setSkills] = useState<SkillStatus[]>([]);
  const [message, setMessage] = useState<string>();
  const refresh = async () => setSkills(await window.deki.listSkills());
  useEffect(() => {
    void refresh();
  }, [value.skills.enabled, value.skills.globalPaths, value.skills.disabledNames]);
  return <>
    <Toggle title={zh ? "启用 Skills" : "Enable skills"} path="skills.enabled" checked={value.skills.enabled} source={source} onChange={(enabled) => update({ skills: { enabled } })} />
    <Setting title={zh ? "额外全局来源" : "Additional global paths"} description={scope === "global" ? (zh ? "每行一个本机绝对路径" : "One local absolute path per line") : (zh ? "机器路径只能在全局作用域修改" : "Machine paths can only be changed in global scope")} source={source("skills.globalPaths")}><textarea disabled={scope !== "global"} value={value.skills.globalPaths.join("\n")} onChange={(e) => void update({ skills: { globalPaths: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    <div className="settings-subsection">
      <div className="subsection-heading">
        <div><h2>{zh ? "已发现的 Skills" : "Discovered skills"}</h2><p>{zh ? "展示来源、格式、冲突和可信状态。" : "Shows source, format, conflicts, and trust."}</p></div>
        <button className="ghost small-action" onClick={async () => {
          const result = await window.deki.reloadSkills();
          setMessage(result.ok ? (zh ? "Skills 已重新加载" : "Skills reloaded") : result.error);
          await refresh();
        }}>{zh ? "重新加载" : "Reload"}</button>
      </div>
      {message && <p className="muted">{message}</p>}
      {skills.length === 0 && <div className="custom-provider-empty">{zh ? "未发现 Skill" : "No skills found"}</div>}
      {skills.map((skill) => <div className="skill-card" key={`${skill.source}:${skill.path}`}>
        <div>
          <strong>{skill.name}</strong>
          <span className={`provider-status ${skill.valid && skill.trusted ? "configured" : ""}`}>{skill.valid ? (skill.trusted ? "valid" : "untrusted") : "invalid"}</span>
          <small>{skill.source} · version {skill.version ?? "unversioned"}{skill.pinnedVersion ? ` · pinned ${skill.pinnedVersion}` : ""} · {skill.path}</small>
          {skill.diagnostics.map((diagnostic) => <p className="error compact" key={diagnostic}>{diagnostic}</p>)}
        </div>
        <div className="button-group">
          {skill.sourceUrl && <button className="ghost small-action" disabled={Boolean(skill.pinnedVersion)} onClick={async () => { const result = await window.deki.updateSkill(skill.path); setMessage(result.ok ? (zh ? "Skill 已更新" : "Skill updated") : result.error); await refresh(); }}>{zh ? "更新" : "Update"}</button>}
          {skill.version && <button className="ghost small-action" onClick={async () => { const result = await window.deki.pinSkillVersion(skill.path, skill.pinnedVersion ? undefined : skill.version); setMessage(result.ok ? (skill.pinnedVersion ? (zh ? "已解除锁定" : "Version unpinned") : (zh ? "已锁定版本" : "Version pinned")) : result.error); await refresh(); }}>{skill.pinnedVersion ? (zh ? "解除锁定" : "Unpin") : (zh ? "锁定版本" : "Pin")}</button>}
        <label className="toggle">
          <input type="checkbox" checked={skill.enabled} onChange={async (event) => {
            const disabled = event.target.checked
              ? value.skills.disabledNames.filter((name) => name !== skill.name)
              : [...new Set([...value.skills.disabledNames, skill.name])];
            await update({ skills: { disabledNames: disabled } });
          }} />
          <span />
        </label>
        </div>
      </div>)}
    </div>
  </>;
}

function MemorySettings({ value, source, zh, update, hasWorkspace, taskId }: SettingsComponentProps & { hasWorkspace: boolean; taskId?: string }) {
  const [view, setView] = useState<"center" | "recall">("center");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [memoryScope, setMemoryScope] = useState<MemoryScope>(hasWorkspace ? "project" : "user");
  const [memoryQuery, setMemoryQuery] = useState("");
  const refresh = async (query = memoryQuery) =>
    setMemories(await window.deki.listMemories(memoryScope, query));
  useEffect(() => {
    if (
      !hasWorkspace
      && (memoryScope === "project" || memoryScope === "workspace" || memoryScope === "branch")
    ) {
      setMemoryScope("user");
      return;
    }
    if (!taskId && memoryScope === "task") {
      setMemoryScope(hasWorkspace ? "project" : "user");
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh(memoryQuery);
    }, memoryQuery ? 150 : 0);
    return () => window.clearTimeout(timer);
  }, [
    hasWorkspace,
    memoryQuery,
    memoryScope,
    taskId,
    value.memory.projectMemoryEnabled,
    value.memory.workspaceMemoryEnabled,
    value.memory.branchMemoryEnabled,
    value.memory.taskMemoryEnabled,
    value.memory.userMemoryEnabled,
  ]);
  const scopeChoices: Array<{ scope: MemoryScope; label: string }> = [
    { scope: "user", label: zh ? "用户" : "User" },
    ...(hasWorkspace ? [{ scope: "project" as const, label: zh ? "当前项目" : "Project" }] : []),
    ...(hasWorkspace ? [{ scope: "workspace" as const, label: zh ? "当前工作区" : "Workspace" }] : []),
    ...(hasWorkspace ? [{ scope: "branch" as const, label: zh ? "当前分支" : "Branch" }] : []),
    ...(taskId ? [{ scope: "task" as const, label: zh ? "当前任务" : "Current task" }] : []),
  ];
  const scopeDescription = memoryScope === "task"
    ? `${zh ? "当前任务作用域" : "Current task scope"} · ${taskId ?? ""}`
    : memoryScope === "branch"
      ? (zh ? "当前 Git 分支作用域" : "Current Git branch scope")
      : memoryScope === "workspace"
        ? (zh ? "当前工作区作用域" : "Current workspace scope")
    : memoryScope === "project"
      ? (zh ? "当前项目作用域" : "Current project scope")
      : (zh ? "用户作用域" : "User scope");
  return <>
    <div className="settings-tabs" role="tablist" aria-label={zh ? "记忆设置视图" : "Memory settings view"}>
      <button role="tab" aria-selected={view === "center"} className={view === "center" ? "active" : ""} onClick={() => setView("center")}>{zh ? "记忆中心" : "Memory center"}</button>
      <button role="tab" aria-selected={view === "recall"} className={view === "recall" ? "active" : ""} onClick={() => setView("recall")}>{zh ? "召回与候选" : "Recall & candidates"}</button>
    </div>
    {view === "recall" && <>
    <Toggle title={zh ? "普通会话用户记忆" : "User memory in general chats"} path="memory.userMemoryEnabled" checked={value.memory.userMemoryEnabled} source={source} onChange={(userMemoryEnabled) => update({ memory: { userMemoryEnabled } })} />
    <Toggle title={zh ? "项目记忆" : "Project memory"} path="memory.projectMemoryEnabled" checked={value.memory.projectMemoryEnabled} source={source} onChange={(projectMemoryEnabled) => update({ memory: { projectMemoryEnabled } })} />
    <Toggle title={zh ? "工作区记忆" : "Workspace memory"} path="memory.workspaceMemoryEnabled" checked={value.memory.workspaceMemoryEnabled} source={source} onChange={(workspaceMemoryEnabled) => update({ memory: { workspaceMemoryEnabled } })} />
    <Toggle title={zh ? "Git 分支记忆" : "Git branch memory"} path="memory.branchMemoryEnabled" checked={value.memory.branchMemoryEnabled} source={source} onChange={(branchMemoryEnabled) => update({ memory: { branchMemoryEnabled } })} />
    <Toggle title={zh ? "当前任务记忆" : "Current task memory"} description={zh ? "仅在当前任务内检索，适合保存临时目标、约束和进度。" : "Retrieved only in the current task for temporary goals, constraints, and progress."} path="memory.taskMemoryEnabled" checked={value.memory.taskMemoryEnabled} source={source} onChange={(taskMemoryEnabled) => update({ memory: { taskMemoryEnabled } })} />
    <Toggle title={zh ? "自动生成记忆候选" : "Automatic memory candidates"} description={zh ? "默认关闭；候选必须确认后才进入召回。" : "Off by default; candidates must be accepted before recall."} path="memory.automaticCandidates" checked={value.memory.automaticCandidates} source={source} onChange={(automaticCandidates) => update({ memory: { automaticCandidates } })} />
    <Range title={zh ? "用户记忆召回数量" : "User recall count"} path="memory.userRecallLimit" value={value.memory.userRecallLimit} min={0} max={10} source={source} onChange={(userRecallLimit) => update({ memory: { userRecallLimit } })} />
    <Range title={zh ? "用户记忆 Token 预算" : "User memory token budget"} path="memory.userTokenBudget" value={value.memory.userTokenBudget} min={0} max={10000} step={50} source={source} onChange={(userTokenBudget) => update({ memory: { userTokenBudget } })} />
    <Range title={zh ? "项目记忆召回数量" : "Project recall count"} path="memory.projectRecallLimit" value={value.memory.projectRecallLimit} min={0} max={10} source={source} onChange={(projectRecallLimit) => update({ memory: { projectRecallLimit } })} />
    <Range title={zh ? "项目记忆 Token 预算" : "Project memory token budget"} path="memory.projectTokenBudget" value={value.memory.projectTokenBudget} min={0} max={10000} step={50} source={source} onChange={(projectTokenBudget) => update({ memory: { projectTokenBudget } })} />
    <Range title={zh ? "工作区记忆 Token 预算" : "Workspace memory token budget"} path="memory.workspaceTokenBudget" value={value.memory.workspaceTokenBudget} min={0} max={10000} step={50} source={source} onChange={(workspaceTokenBudget) => update({ memory: { workspaceTokenBudget } })} />
    <Range title={zh ? "分支记忆 Token 预算" : "Branch memory token budget"} path="memory.branchTokenBudget" value={value.memory.branchTokenBudget} min={0} max={10000} step={50} source={source} onChange={(branchTokenBudget) => update({ memory: { branchTokenBudget } })} />
    <Range title={zh ? "任务记忆召回数量" : "Task recall count"} path="memory.taskRecallLimit" value={value.memory.taskRecallLimit} min={0} max={10} source={source} onChange={(taskRecallLimit) => update({ memory: { taskRecallLimit } })} />
    <Range title={zh ? "任务记忆 Token 预算" : "Task memory token budget"} path="memory.taskTokenBudget" value={value.memory.taskTokenBudget} min={0} max={10000} step={50} source={source} onChange={(taskTokenBudget) => update({ memory: { taskTokenBudget } })} />
    </>}
    {view === "center" && <div className="settings-subsection memory-center">
      <div className="subsection-heading"><div><h2>{zh ? "记忆中心" : "Memory center"}</h2><p>{scopeDescription}</p></div><div className="button-group"><select value={memoryScope} onChange={(event) => setMemoryScope(event.target.value as MemoryScope)}>{scopeChoices.map((choice) => <option value={choice.scope} key={choice.scope}>{choice.label}</option>)}</select><button className="ghost small-action" onClick={() => void refresh()}>{zh ? "刷新" : "Refresh"}</button><button className="danger small-action" onClick={async () => {
        if (!window.confirm(zh ? "彻底清理当前作用域全部记忆？" : "Permanently clear all memories in this scope?")) return;
        await window.deki.clearMemoryScope(memoryScope);
        await refresh();
      }}>{zh ? "清空此作用域" : "Clear scope"}</button></div></div>
      <input className="memory-search" value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder={zh ? "使用全文索引搜索记忆…" : "Search memories with full-text index…"} />
      <p className="muted">{zh ? "聊天时会按每轮问题进行混合检索；使用 /remember --task 内容 可保存当前任务记忆。" : "Each prompt uses hybrid retrieval. Use /remember --task content to save task-only memory."}</p>
      {memories.length === 0 && <p className="muted">{zh ? "没有可管理的记忆。" : "No memories to manage."}</p>}
      {memories.map((memory) => <div className="provider-card" key={memory.id}><div><strong>{memory.content}</strong><small>{memory.scope} · {memory.type} · {memory.status} · confidence {memory.confidence.toFixed(2)} · source {memory.source.kind}{memory.source.detail ? ` (${memory.source.detail})` : ""} · {zh ? "更新" : "updated"} {new Date(memory.updatedAt).toLocaleString()} · {zh ? "最后使用" : "last used"} {memory.lastUsedAt ? new Date(memory.lastUsedAt).toLocaleString() : "—"} · {zh ? "过期" : "expires"} {memory.expiresAt ? new Date(memory.expiresAt).toLocaleString() : "—"}</small></div><div>{memory.status === "pending" ? <><button className="primary small-action" onClick={async () => { await window.deki.updateMemory({ id: memory.id, scope: memoryScope, status: "active" }); await refresh(); }}>{zh ? "确认" : "Accept"}</button><button className="danger small-action" onClick={async () => { await window.deki.deleteMemory(memory.id, memoryScope); await refresh(); }}>{zh ? "拒绝" : "Reject"}</button></> : <><button className="ghost small-action" onClick={async () => {
        const content = window.prompt(zh ? "编辑记忆" : "Edit memory", memory.content);
        if (content?.trim()) {
          await window.deki.updateMemory({ id: memory.id, scope: memoryScope, content: content.trim() });
          await refresh();
        }
      }}>{zh ? "编辑" : "Edit"}</button><button className="ghost small-action" onClick={async () => { await window.deki.updateMemory({ id: memory.id, scope: memoryScope, pinned: !memory.pinned }); await refresh(); }}>{memory.pinned ? (zh ? "取消置顶" : "Unpin") : (zh ? "置顶" : "Pin")}</button><button className="ghost small-action" onClick={async () => { await window.deki.updateMemory({ id: memory.id, scope: memoryScope, status: "archived" }); await refresh(); }}>{zh ? "归档" : "Archive"}</button>{scopeChoices.filter((choice) => choice.scope !== memoryScope).map((choice) => <button className="ghost small-action" key={choice.scope} onClick={async () => {
        await window.deki.moveMemory(memory.id, memoryScope, choice.scope);
        await refresh();
      }}>{zh ? `移到${choice.label}` : `Move to ${choice.label}`}</button>)}<button className="danger small-action" onClick={async () => { await window.deki.deleteMemory(memory.id, memoryScope); await refresh(); }}>{zh ? "彻底删除" : "Delete"}</button></>}</div></div>)}
    </div>}
  </>;
}

function PrivacySettings({ source, zh, value, update }: SettingsComponentProps) {
  const [usage, setUsage] = useState<DataUsage>();
  const [audits, setAudits] = useState<AuditRecordSummary[]>([]);
  useEffect(() => {
    void window.deki.getDataUsage().then(setUsage);
    void window.deki.listAuditRecords().then(setAudits);
  }, []);
  return <>
    <Setting title={zh ? "本地数据占用" : "Local data usage"} description={usage ? `${formatBytes(usage.totalBytes)} · sessions ${formatBytes(usage.sessionsBytes)} · memory ${formatBytes(usage.memoryBytes)} · tasks ${formatBytes(usage.tasksBytes)} · logs ${formatBytes(usage.logsBytes)}` : (zh ? "正在统计…" : "Calculating…")} source="local"><button className="ghost" onClick={() => void window.deki.getDataUsage().then(setUsage)}>{zh ? "刷新" : "Refresh"}</button></Setting>
    <Toggle title={zh ? "遥测" : "Telemetry"} description={zh ? "固定关闭，不会发送使用数据。" : "Always off; no usage data is sent."} path="privacy.telemetry" checked={false} disabled source={source} onChange={() => Promise.resolve()} />
    <Range title={zh ? "普通日志保留天数" : "General log retention days"} path="privacy.logRetentionDays" value={value.privacy.logRetentionDays} min={1} max={365} source={source} onChange={(logRetentionDays) => update({ privacy: { logRetentionDays } })} />
    <Setting title={zh ? "数据目录" : "Data directory"} description="~/.deki/" source="local"><button className="ghost" onClick={() => void window.deki.openDataDirectory()}>{zh ? "在文件管理器中打开" : "Open in file manager"}</button></Setting>
    <Setting title={zh ? "脱敏诊断导出" : "Redacted diagnostics export"} description={zh ? "不包含 API Key、项目源码或完整审计 Diff。" : "Excludes API keys, project source, and full audit diffs."} source="local"><button className="ghost" onClick={() => void window.deki.exportDiagnostics()}>{zh ? "导出诊断包" : "Export diagnostics"}</button></Setting>
    <Setting title={zh ? "数据导出 / 导入" : "Data export / import"} description={zh ? "导出设置、脱敏 Provider 元数据和当前作用域记忆；不包含 API Key、源码、审计 Diff 或机器路径。导入前会预览数量。" : "Exports settings, redacted provider metadata, and current-scope memories. API keys, source, audit diffs, and machine paths are excluded. Import shows a preview."} source="local"><div className="button-group"><button className="ghost" onClick={() => void window.deki.exportData()}>{zh ? "导出" : "Export"}</button><button className="ghost" onClick={() => void window.deki.importData()}>{zh ? "导入" : "Import"}</button></div></Setting>
    <Setting title={zh ? "分类清理" : "Category cleanup"} description={zh ? "先关闭相关资源，再移到系统废纸篓；失败时保留时间戳备份。" : "Closes related resources before moving data to trash; falls back to a timestamped backup."} source="local"><div className="button-group">{(["sessions", "memories", "tasks", "logs"] as const).map((category) => <button className="danger-outline" key={category} onClick={() => {
      const label = category === "sessions" ? (zh ? "会话" : "sessions") : category === "memories" ? (zh ? "记忆" : "memories") : category === "tasks" ? (zh ? "任务" : "tasks") : (zh ? "日志" : "logs");
      if (window.confirm(zh ? `将全部${label}移到废纸篓？` : `Move all ${label} to the trash?`)) void window.deki.clearData(category);
    }}>{category === "sessions" ? (zh ? "清理会话" : "Sessions") : category === "memories" ? (zh ? "清理记忆" : "Memories") : category === "tasks" ? (zh ? "清理任务" : "Tasks") : (zh ? "清理日志" : "Logs")}</button>)}</div></Setting>
    <Setting title={zh ? "恢复出厂设置" : "Factory reset"} description={zh ? "关闭 Runtime、MCP 和数据库后，将 ~/.deki 移入系统废纸篓；失败时保留时间戳备份。" : "Closes runtime, MCP, and databases, then moves ~/.deki to trash; falls back to a timestamped backup."} source="local"><button className="danger" onClick={() => {
      if (window.confirm(zh ? "将全部 Deki 本地数据移到废纸篓并恢复出厂设置？" : "Move all local Deki data to the trash and reset the app?")) void window.deki.factoryReset();
    }}>{zh ? "可恢复地重置" : "Recoverable reset"}</button></Setting>
    <div className="settings-subsection">
      <div className="subsection-heading"><div><h2>{zh ? "历史审计" : "Audit history"}</h2><p>{zh ? "最近 7 天最多 100 条脱敏记录。" : "Up to 100 redacted records from the last 7 days."}</p></div><button className="ghost small-action" onClick={() => void window.deki.listAuditRecords().then(setAudits)}>{zh ? "刷新" : "Refresh"}</button></div>
      {audits.length === 0 && <p className="muted">{zh ? "暂无审计记录。" : "No audit records."}</p>}
      {audits.map((audit) => <details className="audit-entry" key={audit.id}>
        <summary>{new Date(audit.timestamp).toLocaleString()} · {audit.category} · {audit.status}</summary>
        <pre>{JSON.stringify(audit.details, null, 2)}</pre>
        {audit.diff && <pre>{audit.diff}</pre>}
      </details>)}
    </div>
  </>;
}

function AdvancedSettings({ value, source, zh, update }: SettingsComponentProps) {
  return <>
    <Setting title={zh ? "日志级别" : "Log level"} source={source("advanced.logLevel")}><select value={value.advanced.logLevel} onChange={(event) => void update({ advanced: { logLevel: event.target.value as DekiSettings["advanced"]["logLevel"] } })}><option value="error">error</option><option value="warn">warn</option><option value="info">info</option><option value="debug">debug</option></select></Setting>
    <Setting title={zh ? "网络代理" : "Network proxy"} description={zh ? "应用于 Electron 网络和子进程；模型运行时会在安全时机重建。" : "Applied to Electron networking and child processes; model runtime reloads safely."} source={source("advanced.proxyUrl")}><input placeholder="http://127.0.0.1:7890" value={value.advanced.proxyUrl} onChange={(event) => void update({ advanced: { proxyUrl: event.target.value.trim() } })} /></Setting>
    <Setting title={zh ? "自定义 CA 证书" : "Custom CA certificate"} description={zh ? "填写 PEM 文件绝对路径；某些 Node Provider 需要重启应用。" : "Absolute PEM path; some Node providers require an app restart."} source={source("advanced.customCaPath")}><input value={value.advanced.customCaPath} onChange={(event) => void update({ advanced: { customCaPath: event.target.value.trim() } })} /></Setting>
    <Range title={zh ? "Tool 输出上限（KB）" : "Tool output limit (KB)"} description={zh ? "统一限制工作区与 MCP Tool 的文本、图片和结构化返回值。" : "Applies to text, images, and structured results from workspace and MCP tools."} path="advanced.toolOutputLimitBytes" value={Math.round(value.advanced.toolOutputLimitBytes / 1024)} min={1} max={97656} source={source} onChange={(kb) => update({ advanced: { toolOutputLimitBytes: kb * 1024 } })} />
    <p className="muted">{zh ? "当前版本没有可启用的实验功能。" : "No experimental features are available in this version."}</p>
  </>;
}

function AboutSettings({ value, zh, update }: Pick<SettingsComponentProps, "value" | "zh" | "update">) {
  const [updateMessage, setUpdateMessage] = useState<string>();
  return <>
    <div className="about-card"><div className="brand-mark">D</div><div><h2>Deki {DEKI_VERSION}</h2><p>Electron 43.2.0 · Pi SDK 0.82.1 · MCP SDK 1.29.0</p></div></div>
    <Setting title={zh ? "开源许可证" : "Open-source license"} description="AGPL-3.0-or-later" source="product"><span className="value-text">GNU Affero General Public License v3.0 or later</span></Setting>
    <Setting title={zh ? "第三方许可证" : "Third-party licenses"} description={zh ? "根据锁文件自动生成完整依赖清单，并随应用打包。" : "A complete inventory is generated from the lockfile and packaged with the app."} source="product"><button className="ghost" onClick={() => void window.deki.openThirdPartyLicenses()}>{zh ? "打开完整清单" : "Open complete inventory"}</button></Setting>
    <Setting title={zh ? "更新通道" : "Update channel"} description={zh ? "Stable 仅接收正式版；Beta 可接收预发布版本。发布源为 GitHub Releases。" : "Stable receives final releases; Beta can receive prereleases. Updates are served by GitHub Releases."} source="global"><select value={value.updates.channel} onChange={(e) => void update({ updates: { channel: e.target.value as "stable" | "beta" } })}><option value="stable">Stable</option><option value="beta">Beta</option></select></Setting>
    <Setting title={zh ? "客户端更新" : "Client updates"} description={updateMessage ?? (zh ? "从 edik-labs/deki 的 GitHub Releases 检查、下载，并在退出后安装。" : "Checks and downloads from edik-labs/deki GitHub Releases, then installs on quit.")} source="product"><button className="primary" onClick={async () => { const result = await window.deki.checkForUpdates(); setUpdateMessage(result.error ?? (result.ok ? (zh ? "检查完成" : "Check complete") : (zh ? "检查失败" : "Check failed"))); }}>{zh ? "立即检查" : "Check now"}</button></Setting>
  </>;
}

function Setting(props: { title: string; description?: string | undefined; source: string; children: ReactNode }) {
  return <div className="setting-row"><div className="setting-copy"><div><strong>{props.title}</strong><span className="source-badge">{formatSource(props.source)}</span></div>{props.description && <p>{props.description}</p>}</div><div className="setting-control">{labelControls(props.children, props.title)}</div></div>;
}

function Toggle(props: { title: string; description?: string; path: string; checked: boolean; disabled?: boolean; source: (path: string) => string; onChange: (value: boolean) => Promise<void> }) {
  return <Setting title={props.title} description={props.description} source={props.source(props.path)}><label className="toggle"><input type="checkbox" disabled={props.disabled} checked={props.checked} onChange={(e) => void props.onChange(e.target.checked)} /><span /></label></Setting>;
}

function Range(props: { title: string; description?: string; path: string; value: number; min: number; max: number; step?: number; source: (path: string) => string; onChange: (value: number) => Promise<void> }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) void props.onChange(draft);
  };
  return <Setting title={props.title} description={props.description} source={props.source(props.path)}><div className="range-control"><input type="range" value={draft} min={props.min} max={props.max} step={props.step ?? 1} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /><output>{draft}</output></div></Setting>;
}

function formatSource(source: string) {
  const zh = document.documentElement.lang.startsWith("zh");
  const labels = zh
    ? { default: "默认", global: "全局", projectShared: "项目共享", projectLocal: "项目本机", session: "会话", local: "本机", product: "产品" }
    : { default: "Default", global: "Global", projectShared: "Project shared", projectLocal: "Project local", session: "Session", local: "Local", product: "Product" };
  return (labels as Record<string, string>)[source] ?? source;
}

function labelControls(node: ReactNode, label: string): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<{ children?: ReactNode; "aria-label"?: string }>;
    if (typeof element.type === "string" && ["input", "select", "textarea"].includes(element.type)) {
      return cloneElement(element, element.props["aria-label"] ? {} : { "aria-label": label });
    }
    if (element.props.children !== undefined) {
      return cloneElement(element, { children: labelControls(element.props.children, label) });
    }
    return child;
  });
}

function emptyProvider(providers: RedactedModelProvider[] = []): ModelProviderInput {
  const ids = new Set(providers.map((provider) => provider.id));
  let id = "custom";
  for (let index = 2; ids.has(id); index += 1) id = `custom-${index}`;
  return {
    id,
    name: "Custom provider",
    enabled: true,
    api: "openai-completions",
    apiKey: { action: "keep" },
    models: [{ id: "model-id", name: "Model" }],
  };
}

function toProviderInput(provider: RedactedModelProvider): ModelProviderInput {
  return {
    id: provider.id,
    ...(provider.name ? { name: provider.name } : {}),
    enabled: provider.enabled !== false,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.api ? { api: provider.api } : {}),
    apiKey: { action: "keep" },
    ...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
    ...(provider.headers ? { headers: provider.headers } : {}),
    models: provider.models,
  };
}

function providerEndpointPreview(provider: ModelProviderInput): string {
  if (!provider.baseUrl) return "—";
  const base = provider.baseUrl.replace(/\/+$/u, "");
  switch (provider.api) {
    case "anthropic-messages":
      return `${base}/v1/messages`;
    case "google-generative-ai":
      return `${base}/models/{model}:generateContent`;
    case "openai-responses":
      return `${base}/responses`;
    default:
      return `${base}/chat/completions`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function parseHeaders(value: string): Record<string, string> | undefined {
  const entries = value.split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return [];
    const key = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    return key && headerValue ? [[key, headerValue] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseEnvironment(value: string): Record<string, string> {
  return Object.fromEntries(value.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return [];
    const key = line.slice(0, separator).trim();
    const envValue = line.slice(separator + 1).trim();
    return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && envValue
      ? [[key, envValue] as const]
      : [];
  }));
}

function listLeafPaths(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value === undefined ? [] : [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    listLeafPaths(child, `${prefix}.${key}`));
}
