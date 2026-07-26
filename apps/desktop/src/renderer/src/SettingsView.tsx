import { useEffect, useMemo, useState } from "react";
import type {
  DekiSettings,
  DataUsage,
  ModelProviderInput,
  McpServerEditor,
  PermissionCategory,
  PermissionPolicy,
  RedactedModelProvider,
  SettingsPatch,
  SettingsScope,
  SettingsSnapshot,
} from "@deki-ai/shared";
import {
  builtinModelProviders,
  builtinProviderInput,
  isBuiltinModelProvider,
  type BuiltinModelProvider,
} from "./builtinModelProviders";

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
  { id: "general", zh: "通用", en: "General", keywords: "language startup restore close update 语言 启动 恢复" },
  { id: "appearance", zh: "外观", en: "Appearance", keywords: "theme accent font density sidebar motion contrast 主题 字体 密度" },
  { id: "models", zh: "模型与提供方", en: "Models & Providers", keywords: "api key base url provider retry timeout model 模型 密钥" },
  { id: "agent", zh: "Agent 与会话", en: "Agent & Sessions", keywords: "session compaction concurrency retention 会话 压缩 并发" },
  { id: "workspace", zh: "项目与工作区", en: "Projects & Workspaces", keywords: "project trust git context ignore 项目 信任 上下文" },
  { id: "permissions", zh: "权限", en: "Permissions", keywords: "allow ask deny shell file network audit 权限 审批 文件" },
  { id: "mcp", zh: "MCP", en: "MCP", keywords: "stdio server tool timeout restart server 工具 超时" },
  { id: "skills", zh: "Skills", en: "Skills", keywords: "skill reload conflict trust validate 技能 重载 冲突" },
  { id: "memory", zh: "记忆", en: "Memory", keywords: "memory recall candidate sensitive budget 记忆 召回 候选" },
  { id: "privacy", zh: "数据与隐私", en: "Data & Privacy", keywords: "data privacy export import clear reset telemetry 数据 隐私 导出" },
  { id: "advanced", zh: "高级与诊断", en: "Advanced & Diagnostics", keywords: "logs proxy certificate diagnostics experimental 日志 代理 诊断" },
  { id: "about", zh: "关于", en: "About", keywords: "version license agpl update 版本 许可证" },
];

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
  locale: Locale;
  onChanged: (snapshot: SettingsSnapshot) => void;
  onClose: () => void;
  onRefreshState: () => Promise<void>;
}) {
  const [scope, setScope] = useState<SettingsScope>("global");
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<RedactedModelProvider[]>([]);
  const [editingProvider, setEditingProvider] = useState<ModelProviderInput>();
  const zh = props.locale === "zh-CN";

  useEffect(() => {
    void window.deki.listModelProviders().then(setProviders).catch((reason) => {
      setError(String(reason));
    });
  }, []);

  useEffect(() => {
    if (!props.hasWorkspace && scope !== "global") setScope("global");
  }, [props.hasWorkspace, scope]);

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sectionMeta;
    return sectionMeta.filter((item) =>
      `${item.zh} ${item.en} ${item.keywords}`.toLocaleLowerCase().includes(needle));
  }, [query]);

  async function update(patch: SettingsPatch) {
    setSaving(true);
    setError(undefined);
    try {
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

  const value = props.snapshot.effective;
  const source = (path: string) => props.snapshot.sources[path] ?? "default";

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
            <select value={scope} onChange={(event) => setScope(event.target.value as SettingsScope)}>
              <option value="global">{zh ? "全局" : "Global"}</option>
              <option value="projectShared" disabled={!props.hasWorkspace}>{zh ? "当前项目（共享）" : "Current project (shared)"}</option>
              <option value="projectLocal" disabled={!props.hasWorkspace}>{zh ? "当前项目（本机）" : "Current project (local)"}</option>
            </select>
            <button className="ghost small-action" disabled={saving} onClick={() => void reset([section])}>
              {zh ? "恢复本分类" : "Reset section"}
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
          {section === "agent" && <AgentSettings value={value} source={source} zh={zh} update={update} />}
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
          {section === "skills" && <SkillSettings value={value} source={source} zh={zh} update={update} />}
          {section === "memory" && <MemorySettings value={value} source={source} zh={zh} update={update} hasWorkspace={props.hasWorkspace} />}
          {section === "privacy" && <PrivacySettings value={value} source={source} zh={zh} update={update} />}
          {section === "advanced" && <AdvancedSettings value={value} source={source} zh={zh} update={update} />}
          {section === "about" && <AboutSettings value={value} zh={zh} update={update} />}
        </div>

        <footer className="settings-footer">
          <span>{saving ? (zh ? "正在保存…" : "Saving…") : (zh ? "所有更改已保存" : "All changes saved")}</span>
          <button className="ghost" disabled={saving} onClick={() => void reset()}>
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
    <Toggle title={zh ? "检查更新" : "Check for updates"} description={zh ? "当前尚未配置发布源。" : "No release source is configured yet."} path="general.checkUpdates" checked={value.general.checkUpdates} source={source} onChange={(checkUpdates) => update({ general: { checkUpdates } })} />
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
  const customProviders = props.providers.filter((provider) => !isBuiltinModelProvider(provider.id));
  const modelOptions = props.providers.flatMap((provider) => provider.models.map((model) => ({
    value: `${provider.id}/${model.id}`,
    label: `${model.name ?? model.id} · ${provider.name ?? provider.id}`,
  })));
  return <>
    <Setting title={zh ? "普通会话默认模型" : "Default general model"} source={source("models.generalModel")}><select value={value.models.generalModel} onChange={(e) => void update({ models: { generalModel: e.target.value } })}><option value="">{zh ? "自动选择" : "Auto-select"}</option>{modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Setting>
    <Setting title={zh ? "项目会话默认模型" : "Default project model"} source={source("models.projectModel")}><select value={value.models.projectModel} onChange={(e) => void update({ models: { projectModel: e.target.value } })}><option value="">{zh ? "自动选择" : "Auto-select"}</option>{modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Setting>
    <Setting title={zh ? "思考强度" : "Thinking level"} source={source("models.thinkingLevel")}><select value={value.models.thinkingLevel} onChange={(e) => void update({ models: { thinkingLevel: e.target.value as DekiSettings["models"]["thinkingLevel"] } })}>{["off", "minimal", "low", "medium", "high", "xhigh"].map((item) => <option value={item} key={item}>{item}</option>)}</select></Setting>
    <Range title={zh ? "请求超时（秒）" : "Request timeout (seconds)"} path="models.timeoutMs" value={Math.round(value.models.timeoutMs / 1000)} min={1} max={600} source={source} onChange={(seconds) => update({ models: { timeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "重试次数" : "Retries"} path="models.maxRetries" value={value.models.maxRetries} min={0} max={10} source={source} onChange={(maxRetries) => update({ models: { maxRetries } })} />
    <div className="settings-subsection">
      <div className="subsection-heading"><div><h2>{zh ? "内置模型服务商" : "Built-in model providers"}</h2><p>{zh ? "地址、协议和模型列表已经配置好，只需填写对应的 API Key。" : "Endpoints, protocols, and model catalogs are configured. Only an API key is required."}</p></div></div>
      <div className="builtin-provider-list">
        {builtinModelProviders.map((definition) => (
          <BuiltinProviderCard
            key={definition.id}
            definition={definition}
            provider={props.providers.find((provider) => provider.id === definition.id)}
            zh={zh}
            onChanged={props.refreshProviders}
            setError={props.setError}
          />
        ))}
      </div>
      <p className="provider-security-note">
        {zh
          ? "API Key 明文保存在本机权限为 0600 的配置文件中；界面、日志和导出只显示配置状态，不会回显密钥。"
          : "API keys are stored in a local 0600 file. The UI, logs, and exports only expose configuration status, never the key."}
      </p>
    </div>
    <div className="settings-subsection custom-provider-section">
      <div className="subsection-heading">
        <div>
          <h2>{zh ? "自定义模型" : "Custom model"}</h2>
          <p>{zh ? "用于其他 OpenAI、Anthropic 或兼容 API；可配置一个自定义服务商。" : "For another OpenAI, Anthropic, or compatible API. One custom provider can be configured."}</p>
        </div>
        {customProviders.length === 0 && !props.editing && <button className="primary small-action" onClick={() => props.setEditing(emptyProvider())}>{zh ? "添加自定义模型" : "Add custom model"}</button>}
      </div>
      {customProviders.length === 0 && !props.editing && <div className="custom-provider-empty">{zh ? "未配置自定义模型" : "No custom model configured"}</div>}
      {customProviders.map((provider) => (
        <div className="provider-card" key={provider.id}>
          <div><strong>{provider.name ?? provider.id}</strong><small>{provider.baseUrl ?? "Default API"} · {provider.models.length} models · {provider.hasApiKey ? "Key ••••••••" : "No key"}</small></div>
          <div><button className="ghost small-action" onClick={() => props.setEditing(toProviderInput(provider))}>{zh ? "编辑" : "Edit"}</button><button className="danger small-action" onClick={async () => { const result = await window.deki.removeModelProvider(provider.id); if (!result.ok) props.setError(result.error); else await props.refreshProviders(); }}>{zh ? "删除" : "Delete"}</button></div>
        </div>
      ))}
      {props.editing && <ProviderEditor provider={props.editing} zh={zh} onChange={props.setEditing} onCancel={() => props.setEditing(undefined)} onDone={async () => { await props.refreshProviders(); props.setEditing(undefined); }} setError={props.setError} />}
    </div>
  </>;
}

function BuiltinProviderCard(props: {
  definition: BuiltinModelProvider;
  provider: RedactedModelProvider | undefined;
  zh: boolean;
  onChanged: () => Promise<void>;
  setError: (value: string | undefined) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const configured = props.provider?.hasApiKey ?? false;
  const modelNames = props.definition.config.models.map((model) => model.name ?? model.id).join(" · ");

  const updateKey = async (action: ModelProviderInput["apiKey"]) => {
    setBusy(true);
    setSaved(false);
    props.setError(undefined);
    try {
      const result = await window.deki.upsertModelProvider(
        builtinProviderInput(props.definition, action),
      );
      if (!result.ok) {
        props.setError(result.error);
        return;
      }
      setApiKey("");
      setSaved(action.action === "set");
      await props.onChanged();
    } catch (reason) {
      props.setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return <article className={`builtin-provider-card${configured ? " configured" : ""}`} data-provider-id={props.definition.id}>
    <div className="provider-identity">
      <span className="provider-logo" aria-hidden="true">{props.definition.shortName}</span>
      <div>
        <div className="provider-title">
          <strong>{props.definition.name}</strong>
          <span className={`provider-status ${configured ? "configured" : ""}`}>
            {configured ? (props.zh ? "已配置" : "Configured") : (props.zh ? "未配置" : "Not configured")}
          </span>
        </div>
        <p>{props.zh ? props.definition.description.zh : props.definition.description.en}</p>
        <small title={modelNames}>{modelNames}</small>
      </div>
    </div>
    <div className="provider-key-control">
      <input
        type="password"
        value={apiKey}
        autoComplete="new-password"
        placeholder={configured
          ? (props.zh ? "输入新 Key 以替换" : "Enter a new key to replace")
          : (props.zh ? "填写 API Key" : "Enter API key")}
        aria-label={`${props.definition.name} API Key`}
        onChange={(event) => {
          setApiKey(event.target.value);
          setSaved(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && apiKey.trim() && !busy) {
            void updateKey({ action: "set", value: apiKey.trim() });
          }
        }}
      />
      <button
        className="primary small-action"
        disabled={!apiKey.trim() || busy}
        onClick={() => void updateKey({ action: "set", value: apiKey.trim() })}
      >
        {busy ? (props.zh ? "保存中…" : "Saving…") : (props.zh ? "保存" : "Save")}
      </button>
      {configured && <button className="ghost small-action" disabled={busy} onClick={() => void updateKey({ action: "clear" })}>{props.zh ? "清除" : "Clear"}</button>}
      {saved && <span className="key-saved">{props.zh ? "已保存" : "Saved"}</span>}
    </div>
  </article>;
}

function ProviderEditor(props: { provider: ModelProviderInput; zh: boolean; onChange: (value: ModelProviderInput) => void; onCancel: () => void; onDone: () => Promise<void>; setError: (value: string | undefined) => void }) {
  const provider = props.provider;
  const firstModel = provider.models[0]!;
  const set = (patch: Partial<ModelProviderInput>) => props.onChange({ ...provider, ...patch });
  const run = async (kind: "save" | "test") => {
    if (isBuiltinModelProvider(provider.id)) {
      props.setError(props.zh ? "自定义模型 ID 不能与内置服务商重复" : "The custom model ID cannot match a built-in provider");
      return;
    }
    const result = kind === "save" ? await window.deki.upsertModelProvider(provider) : await window.deki.testModelProvider(provider);
    if (!result.ok) props.setError(result.error ?? "Operation failed");
    else if (kind === "save") await props.onDone();
    else props.setError(props.zh ? "连接测试成功" : "Connection test succeeded");
  };
  return <div className="provider-editor">
    <div className="field-grid">
      <label><span>ID</span><input value={provider.id} onChange={(e) => set({ id: e.target.value })} /></label>
      <label><span>{props.zh ? "名称" : "Name"}</span><input value={provider.name ?? ""} onChange={(e) => set({ name: e.target.value || undefined })} /></label>
      <label className="wide"><span>Base URL</span><input placeholder="https://api.example.com/v1" value={provider.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value || undefined })} /></label>
      <label><span>API type</span><input value={provider.api ?? "openai-completions"} onChange={(e) => set({ api: e.target.value || undefined })} /></label>
      <label><span>API Key</span><input type="password" placeholder={provider.apiKey.action === "keep" ? "•••••••• (keep)" : ""} onChange={(e) => set({ apiKey: e.target.value ? { action: "set", value: e.target.value } : { action: "keep" } })} /></label>
      <label><span>Model ID</span><input value={firstModel.id} onChange={(e) => set({ models: [{ ...firstModel, id: e.target.value }] })} /></label>
      <label><span>{props.zh ? "模型名称" : "Model name"}</span><input value={firstModel.name ?? ""} onChange={(e) => set({ models: [{ ...firstModel, name: e.target.value || undefined }] })} /></label>
    </div>
    <div className="editor-actions"><button className="ghost" onClick={props.onCancel}>{props.zh ? "取消" : "Cancel"}</button><button className="ghost" onClick={() => void run("test")}>{props.zh ? "测试连接" : "Test"}</button><button className="primary" onClick={() => void run("save")}>{props.zh ? "保存" : "Save"}</button></div>
  </div>;
}

function AgentSettings({ value, source, zh, update }: SettingsComponentProps) {
  return <>
    <Toggle title={zh ? "自动命名会话" : "Auto-name sessions"} path="agent.autoNameSessions" checked={value.agent.autoNameSessions} source={source} onChange={(autoNameSessions) => update({ agent: { autoNameSessions } })} />
    <Toggle title={zh ? "上下文压缩" : "Context compaction"} path="agent.compactionEnabled" checked={value.agent.compactionEnabled} source={source} onChange={(compactionEnabled) => update({ agent: { compactionEnabled } })} />
    <Range title={zh ? "最大并发运行" : "Concurrent runs"} path="agent.maxConcurrentRuns" value={value.agent.maxConcurrentRuns} min={1} max={8} source={source} onChange={(maxConcurrentRuns) => update({ agent: { maxConcurrentRuns } })} />
    <Toggle title={zh ? "显示思考摘要" : "Show thinking summary"} path="agent.showThinkingSummary" checked={value.agent.showThinkingSummary} source={source} onChange={(showThinkingSummary) => update({ agent: { showThinkingSummary } })} />
    <Range title={zh ? "会话保留天数" : "Session retention days"} path="agent.sessionRetentionDays" value={value.agent.sessionRetentionDays} min={1} max={3650} source={source} onChange={(sessionRetentionDays) => update({ agent: { sessionRetentionDays } })} />
  </>;
}

function WorkspaceSettings(props: SettingsComponentProps & { hasWorkspace: boolean; onRevoked: () => Promise<void> }) {
  const { value, source, zh, update } = props;
  return <>
    {!props.hasWorkspace && <p className="settings-warning">{zh ? "普通会话未关联项目；项目设置需要先选择并信任工作区。" : "General chat has no project. Select and trust a workspace for project settings."}</p>}
    <Toggle title={zh ? "检测 Git 仓库" : "Detect Git repositories"} path="workspace.detectGit" checked={value.workspace.detectGit} source={source} onChange={(detectGit) => update({ workspace: { detectGit } })} />
    <Toggle title={zh ? "加载项目记忆" : "Load project memory"} path="workspace.loadProjectMemory" checked={value.workspace.loadProjectMemory} source={source} onChange={(loadProjectMemory) => update({ workspace: { loadProjectMemory } })} />
    <Setting title={zh ? "上下文忽略规则" : "Context ignore rules"} description={zh ? "每行一个路径或模式" : "One path or pattern per line"} source={source("workspace.contextIgnore")}><textarea value={value.workspace.contextIgnore.join("\n")} onChange={(e) => void update({ workspace: { contextIgnore: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    <Setting title={zh ? "项目说明文件" : "Project context files"} source={source("workspace.contextFiles")}><textarea value={value.workspace.contextFiles.join("\n")} onChange={(e) => void update({ workspace: { contextFiles: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    {props.hasWorkspace && <Setting title={zh ? "撤销当前工作区信任" : "Revoke workspace trust"} description={zh ? "会立即停止 MCP、卸载项目 Skill 并关闭项目 Runtime。" : "Immediately stops MCP, unloads project skills, and closes the project runtime."} source="local"><button className="danger" onClick={() => void props.onRevoked()}>{zh ? "撤销信任" : "Revoke trust"}</button></Setting>}
  </>;
}

function PermissionSettings({ value, source, zh, update }: SettingsComponentProps) {
  const setPolicy = (category: PermissionCategory, policy: PermissionPolicy) => {
    void update({ permissions: { policies: { ...value.permissions.policies, [category]: policy } } });
  };
  return <>
    <p className="settings-warning">{zh ? "没有 sandbox 选项。敏感文件、提权和工作区外访问默认拒绝；其他高风险操作需要审批。" : "There is no sandbox option. Sensitive, privileged, and outside-workspace access is denied by default; other risky operations require approval."}</p>
    {(Object.keys(permissionLabels) as PermissionCategory[]).map((category) => (
      <Setting key={category} title={permissionLabels[category][zh ? 0 : 1]} source={source(`permissions.policies.${category}`)}>
        <select value={value.permissions.policies[category]} onChange={(e) => setPolicy(category, e.target.value as PermissionPolicy)}>
          <option value="allow">allow</option><option value="ask">ask</option><option value="deny">deny</option>
        </select>
      </Setting>
    ))}
    <Range title={zh ? "审批超时（秒）" : "Approval timeout (seconds)"} path="permissions.approvalTimeoutMs" value={value.permissions.approvalTimeoutMs / 1000} min={5} max={600} source={source} onChange={(seconds) => update({ permissions: { approvalTimeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "审计保留天数" : "Audit retention days"} path="permissions.auditRetentionDays" value={value.permissions.auditRetentionDays} min={1} max={365} source={source} onChange={(auditRetentionDays) => update({ permissions: { auditRetentionDays } })} />
    <Toggle title={zh ? "修改后始终显示完整 Diff" : "Always show full diff after changes"} path="permissions.showDiffAfterWrite" checked={value.permissions.showDiffAfterWrite} source={source} onChange={(showDiffAfterWrite) => update({ permissions: { showDiffAfterWrite } })} />
  </>;
}

function McpSettings({ value, source, zh, update, hasWorkspace }: SettingsComponentProps & { hasWorkspace: boolean }) {
  const [servers, setServers] = useState<McpServerEditor[]>([]);
  const [editing, setEditing] = useState<McpServerEditor>();
  const [message, setMessage] = useState<string>();
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
  return <>
    <p className="settings-warning">{zh ? "仅支持项目 .deki/mcp.json 中的 stdio Server；不内置示例，不支持 HTTP 或 OAuth。" : "Only stdio servers in project .deki/mcp.json are supported. No built-in examples, HTTP, or OAuth."}</p>
    <Toggle title={zh ? "启动已启用的 Server" : "Start enabled servers"} path="mcp.startEnabledServers" checked={value.mcp.startEnabledServers} source={source} onChange={(startEnabledServers) => update({ mcp: { startEnabledServers } })} />
    <Range title={zh ? "启动超时（秒）" : "Startup timeout (seconds)"} path="mcp.startupTimeoutMs" value={value.mcp.startupTimeoutMs / 1000} min={1} max={120} source={source} onChange={(seconds) => update({ mcp: { startupTimeoutMs: seconds * 1000 } })} />
    <Range title={zh ? "Tool 调用超时（秒）" : "Tool timeout (seconds)"} path="mcp.callTimeoutMs" value={value.mcp.callTimeoutMs / 1000} min={1} max={600} source={source} onChange={(seconds) => update({ mcp: { callTimeoutMs: seconds * 1000 } })} />
    <div className="settings-subsection">
      <div className="subsection-heading"><div><h2>stdio Servers</h2><p>{hasWorkspace ? ".deki/mcp.json" : (zh ? "普通会话不可用" : "Unavailable in general chat")}</p></div><div><button className="ghost small-action" disabled={!hasWorkspace} onClick={() => void window.deki.reloadMcpServers()}>{zh ? "重载" : "Reload"}</button> <button className="primary small-action" disabled={!hasWorkspace} onClick={() => setEditing({ id: "server", command: "", args: [], enabled: true })}>{zh ? "添加" : "Add"}</button></div></div>
      {message && <p className="muted">{message}</p>}
      {servers.map((server) => <div className="provider-card" key={server.id}><div><strong>{server.id}</strong><small>{server.command} {server.args.join(" ")} · {server.enabled ? "enabled" : "disabled"}</small></div><div><button className="ghost small-action" onClick={() => setEditing(server)}>{zh ? "编辑" : "Edit"}</button><button className="danger small-action" onClick={async () => { const result = await window.deki.removeMcpServer(server.id); setMessage(result.error); await refresh(); }}>{zh ? "删除" : "Remove"}</button></div></div>)}
      {editing && <div className="provider-editor"><div className="field-grid"><label><span>ID</span><input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} /></label><label><span>{zh ? "命令" : "Command"}</span><input value={editing.command} onChange={(e) => setEditing({ ...editing, command: e.target.value })} /></label><label className="wide"><span>{zh ? "参数（每行一个）" : "Arguments (one per line)"}</span><textarea value={editing.args.join("\n")} onChange={(e) => setEditing({ ...editing, args: e.target.value.split("\n") })} /></label><label><span>cwd</span><input value={editing.cwd ?? ""} onChange={(e) => { const { cwd: _cwd, ...rest } = editing; setEditing(e.target.value ? { ...rest, cwd: e.target.value } : rest); }} /></label><label><span>enabled</span><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /></label></div><div className="editor-actions"><button className="ghost" onClick={() => setEditing(undefined)}>{zh ? "取消" : "Cancel"}</button><button className="primary" onClick={() => void save()}>{zh ? "保存" : "Save"}</button></div></div>}
    </div>
  </>;
}

function SkillSettings({ value, source, zh, update }: SettingsComponentProps) {
  return <>
    <Toggle title={zh ? "启用 Skills" : "Enable skills"} path="skills.enabled" checked={value.skills.enabled} source={source} onChange={(enabled) => update({ skills: { enabled } })} />
    <Setting title={zh ? "额外全局来源" : "Additional global paths"} description={zh ? "每行一个本机绝对路径" : "One local absolute path per line"} source={source("skills.globalPaths")}><textarea value={value.skills.globalPaths.join("\n")} onChange={(e) => void update({ skills: { globalPaths: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    <Setting title={zh ? "禁用的 Skill 名称" : "Disabled skill names"} source={source("skills.disabledNames")}><textarea value={value.skills.disabledNames.join("\n")} onChange={(e) => void update({ skills: { disabledNames: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } })} /></Setting>
    <p className="muted">{zh ? "保存后会校验并重新加载资源；冲突与缺失依赖会显示在运行诊断中。" : "Resources are validated and reloaded after saving; conflicts and missing dependencies appear in diagnostics."}</p>
  </>;
}

function MemorySettings({ value, source, zh, update, hasWorkspace }: SettingsComponentProps & { hasWorkspace: boolean }) {
  const [memories, setMemories] = useState<import("@deki-ai/shared").MemoryRecord[]>([]);
  const refresh = async () => setMemories(await window.deki.listMemories());
  useEffect(() => {
    void refresh();
  }, [hasWorkspace, value.memory.userMemoryEnabled, value.memory.projectMemoryEnabled]);
  return <>
    <Toggle title={zh ? "普通会话用户记忆" : "User memory in general chats"} path="memory.userMemoryEnabled" checked={value.memory.userMemoryEnabled} source={source} onChange={(userMemoryEnabled) => update({ memory: { userMemoryEnabled } })} />
    <Toggle title={zh ? "项目记忆" : "Project memory"} path="memory.projectMemoryEnabled" checked={value.memory.projectMemoryEnabled} source={source} onChange={(projectMemoryEnabled) => update({ memory: { projectMemoryEnabled } })} />
    <Toggle title={zh ? "自动生成记忆候选" : "Automatic memory candidates"} description={zh ? "默认关闭；候选必须确认后才进入召回。" : "Off by default; candidates must be accepted before recall."} path="memory.automaticCandidates" checked={value.memory.automaticCandidates} source={source} onChange={(automaticCandidates) => update({ memory: { automaticCandidates } })} />
    <Range title={zh ? "用户记忆召回数量" : "User recall count"} path="memory.userRecallLimit" value={value.memory.userRecallLimit} min={0} max={10} source={source} onChange={(userRecallLimit) => update({ memory: { userRecallLimit } })} />
    <Range title={zh ? "用户记忆字符预算" : "User memory character budget"} path="memory.userCharacterBudget" value={value.memory.userCharacterBudget} min={0} max={10000} step={100} source={source} onChange={(userCharacterBudget) => update({ memory: { userCharacterBudget } })} />
    <Range title={zh ? "项目记忆召回数量" : "Project recall count"} path="memory.projectRecallLimit" value={value.memory.projectRecallLimit} min={0} max={10} source={source} onChange={(projectRecallLimit) => update({ memory: { projectRecallLimit } })} />
    <Range title={zh ? "项目记忆字符预算" : "Project memory character budget"} path="memory.projectCharacterBudget" value={value.memory.projectCharacterBudget} min={0} max={10000} step={100} source={source} onChange={(projectCharacterBudget) => update({ memory: { projectCharacterBudget } })} />
    <div className="settings-subsection">
      <div className="subsection-heading"><div><h2>{zh ? "记忆中心" : "Memory center"}</h2><p>{hasWorkspace ? (zh ? "当前项目作用域" : "Current project scope") : (zh ? "用户作用域" : "User scope")}</p></div><button className="ghost small-action" onClick={() => void refresh()}>{zh ? "刷新" : "Refresh"}</button></div>
      {memories.length === 0 && <p className="muted">{zh ? "没有可管理的记忆。" : "No memories to manage."}</p>}
      {memories.map((memory) => <div className="provider-card" key={memory.id}><div><strong>{memory.content}</strong><small>{memory.scope} · {memory.status} · {new Date(memory.updatedAt).toLocaleString()}</small></div><div>{memory.status === "pending" ? <><button className="primary small-action" onClick={async () => { await window.deki.updateMemory({ id: memory.id, status: "active" }); await refresh(); }}>{zh ? "确认" : "Accept"}</button><button className="danger small-action" onClick={async () => { await window.deki.deleteMemory(memory.id); await refresh(); }}>{zh ? "拒绝" : "Reject"}</button></> : <><button className="ghost small-action" onClick={async () => { await window.deki.updateMemory({ id: memory.id, pinned: !memory.pinned }); await refresh(); }}>{memory.pinned ? (zh ? "取消置顶" : "Unpin") : (zh ? "置顶" : "Pin")}</button><button className="ghost small-action" onClick={async () => { await window.deki.updateMemory({ id: memory.id, status: "archived" }); await refresh(); }}>{zh ? "归档" : "Archive"}</button><button className="danger small-action" onClick={async () => { await window.deki.deleteMemory(memory.id); await refresh(); }}>{zh ? "彻底删除" : "Delete"}</button></>}</div></div>)}
    </div>
  </>;
}

function PrivacySettings({ value, source, zh, update }: SettingsComponentProps) {
  const [usage, setUsage] = useState<DataUsage>();
  useEffect(() => {
    void window.deki.getDataUsage().then(setUsage);
  }, []);
  return <>
    <Setting title={zh ? "本地数据占用" : "Local data usage"} description={usage ? `${formatBytes(usage.totalBytes)} · sessions ${formatBytes(usage.sessionsBytes)} · memory ${formatBytes(usage.memoryBytes)} · logs ${formatBytes(usage.logsBytes)}` : (zh ? "正在统计…" : "Calculating…")} source="local"><button className="ghost" onClick={() => void window.deki.getDataUsage().then(setUsage)}>{zh ? "刷新" : "Refresh"}</button></Setting>
    <Toggle title={zh ? "遥测" : "Telemetry"} description={zh ? "固定关闭，不会发送使用数据。" : "Always off; no usage data is sent."} path="privacy.telemetry" checked={false} disabled source={source} onChange={() => Promise.resolve()} />
    <Range title={zh ? "日志保留天数" : "Log retention days"} path="privacy.logRetentionDays" value={value.privacy.logRetentionDays} min={1} max={365} source={source} onChange={(logRetentionDays) => update({ privacy: { logRetentionDays } })} />
    <Setting title={zh ? "数据目录" : "Data directory"} description="~/.deki/" source="local"><button className="ghost" onClick={() => void window.deki.openDataDirectory()}>{zh ? "在文件管理器中打开" : "Open in file manager"}</button></Setting>
    <Setting title={zh ? "脱敏诊断导出" : "Redacted diagnostics export"} description={zh ? "不包含 API Key、项目源码或完整审计 Diff。" : "Excludes API keys, project source, and full audit diffs."} source="local"><button className="ghost" onClick={() => void window.deki.exportDiagnostics()}>{zh ? "导出诊断包" : "Export diagnostics"}</button></Setting>
    <Setting title={zh ? "数据导出 / 导入" : "Data export / import"} description={zh ? "导出设置、脱敏 Provider 元数据和当前作用域记忆；不包含 API Key、源码、审计 Diff 或机器路径。导入前会预览数量。" : "Exports settings, redacted provider metadata, and current-scope memories. API keys, source, audit diffs, and machine paths are excluded. Import shows a preview."} source="local"><div className="button-group"><button className="ghost" onClick={() => void window.deki.exportData()}>{zh ? "导出" : "Export"}</button><button className="ghost" onClick={() => void window.deki.importData()}>{zh ? "导入" : "Import"}</button></div></Setting>
    <Setting title={zh ? "分类清理" : "Category cleanup"} description={zh ? "先关闭相关资源，再移到系统废纸篓；失败时保留时间戳备份。" : "Closes related resources before moving data to trash; falls back to a timestamped backup."} source="local"><div className="button-group"><button className="ghost" onClick={() => void window.deki.clearData("sessions")}>{zh ? "清理会话" : "Sessions"}</button><button className="ghost" onClick={() => void window.deki.clearData("memories")}>{zh ? "清理记忆" : "Memories"}</button><button className="ghost" onClick={() => void window.deki.clearData("logs")}>{zh ? "清理日志" : "Logs"}</button></div></Setting>
    <Setting title={zh ? "恢复出厂设置" : "Factory reset"} description={zh ? "关闭 Runtime、MCP 和数据库后，将 ~/.deki 移入系统废纸篓；失败时保留时间戳备份。" : "Closes runtime, MCP, and databases, then moves ~/.deki to trash; falls back to a timestamped backup."} source="local"><button className="danger" onClick={() => void window.deki.factoryReset()}>{zh ? "可恢复地重置" : "Recoverable reset"}</button></Setting>
  </>;
}

function AdvancedSettings({ value, source, zh, update }: SettingsComponentProps) {
  return <>
    <Setting title={zh ? "日志级别" : "Log level"} source={source("advanced.logLevel")}><select value={value.advanced.logLevel} onChange={(e) => void update({ advanced: { logLevel: e.target.value as DekiSettings["advanced"]["logLevel"] } })}>{["error", "warn", "info", "debug"].map((level) => <option key={level}>{level}</option>)}</select></Setting>
    <Setting title={zh ? "代理 URL" : "Proxy URL"} source={source("advanced.proxyUrl")}><input placeholder="http://127.0.0.1:7890" value={value.advanced.proxyUrl} onChange={(e) => void update({ advanced: { proxyUrl: e.target.value } })} /></Setting>
    <Setting title={zh ? "自定义 CA 证书路径" : "Custom CA certificate path"} source={source("advanced.customCaPath")}><input value={value.advanced.customCaPath} onChange={(e) => void update({ advanced: { customCaPath: e.target.value } })} /></Setting>
    <Range title={zh ? "Tool 输出上限（KB）" : "Tool output limit (KB)"} path="advanced.toolOutputLimitBytes" value={Math.round(value.advanced.toolOutputLimitBytes / 1024)} min={1} max={97656} source={source} onChange={(kb) => update({ advanced: { toolOutputLimitBytes: kb * 1024 } })} />
    <Toggle title={zh ? "实验功能" : "Experimental features"} path="advanced.experimentalFeatures" checked={value.advanced.experimentalFeatures} source={source} onChange={(experimentalFeatures) => update({ advanced: { experimentalFeatures } })} />
  </>;
}

function AboutSettings({ value, zh, update }: Pick<SettingsComponentProps, "value" | "zh" | "update">) {
  return <>
    <div className="about-card"><div className="brand-mark">D</div><div><h2>Deki 0.0.0</h2><p>Electron 43.2.0 · Pi SDK 0.82.1 · MCP SDK 1.29.0</p></div></div>
    <Setting title={zh ? "开源许可证" : "Open-source license"} description="AGPL-3.0-or-later" source="product"><span className="value-text">GNU Affero General Public License v3.0 or later</span></Setting>
    <Setting title={zh ? "更新通道" : "Update channel"} description={zh ? "尚未配置发布源；不会自动下载更新。" : "No release source configured; updates are not downloaded."} source="global"><select value={value.updates.channel} onChange={(e) => void update({ updates: { channel: e.target.value as "stable" | "beta" } })}><option value="stable">Stable</option><option value="beta">Beta</option></select></Setting>
  </>;
}

function Setting(props: { title: string; description?: string | undefined; source: string; children: React.ReactNode }) {
  return <div className="setting-row"><div className="setting-copy"><div><strong>{props.title}</strong><span className="source-badge">{formatSource(props.source)}</span></div>{props.description && <p>{props.description}</p>}</div><div className="setting-control">{props.children}</div></div>;
}

function Toggle(props: { title: string; description?: string; path: string; checked: boolean; disabled?: boolean; source: (path: string) => string; onChange: (value: boolean) => Promise<void> }) {
  return <Setting title={props.title} description={props.description} source={props.source(props.path)}><label className="toggle"><input type="checkbox" disabled={props.disabled} checked={props.checked} onChange={(e) => void props.onChange(e.target.checked)} /><span /></label></Setting>;
}

function Range(props: { title: string; path: string; value: number; min: number; max: number; step?: number; source: (path: string) => string; onChange: (value: number) => Promise<void> }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) void props.onChange(draft);
  };
  return <Setting title={props.title} source={props.source(props.path)}><div className="range-control"><input type="range" value={draft} min={props.min} max={props.max} step={props.step ?? 1} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} /><output>{draft}</output></div></Setting>;
}

function formatSource(source: string) {
  return ({ default: "默认", global: "全局", projectShared: "项目共享", projectLocal: "项目本机", session: "会话", local: "本机", product: "产品" } as Record<string, string>)[source] ?? source;
}

function emptyProvider(): ModelProviderInput {
  return {
    id: "custom",
    name: "Custom provider",
    api: "openai-completions",
    apiKey: { action: "keep" },
    models: [{ id: "model-id", name: "Model" }],
  };
}

function toProviderInput(provider: RedactedModelProvider): ModelProviderInput {
  return {
    id: provider.id,
    ...(provider.name ? { name: provider.name } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.api ? { api: provider.api } : {}),
    apiKey: { action: "keep" },
    ...(provider.authHeader === undefined ? {} : { authHeader: provider.authHeader }),
    ...(provider.headers ? { headers: provider.headers } : {}),
    models: provider.models,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}
