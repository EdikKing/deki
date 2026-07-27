import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentEvent,
  BootstrapState,
  CommandResult,
  ConversationMessage,
  MemoryRecord,
  SessionSummary,
  SettingsSnapshot,
} from "@deki-ai/shared";
import { SettingsView } from "./SettingsView";

type ChatMessage = ConversationMessage;
type ToolActivity = {
  callId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  input?: unknown;
  update?: unknown;
  result?: unknown;
};

export function App() {
  const [state, setState] = useState<BootstrapState>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [showSettings, setShowSettings] = useState(false);
  const [approval, setApproval] = useState<Extract<AgentEvent, { type: "approval.requested" }>>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [settingsSection, setSettingsSection] = useState<"models">();
  const [compactLayout, setCompactLayout] = useState(() => window.innerWidth <= 980);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 980);
  const [inspectorWidth, setInspectorWidth] = useState(330);

  async function refresh() {
    setState(await window.deki.getBootstrapState());
  }

  async function refreshSessions() {
    setSessions(await window.deki.listSessions());
  }

  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
    void window.deki.getSettings().then(setSettings).catch((reason) => setError(String(reason)));
    const unsubscribeAgent = window.deki.subscribeAgentEvents((event) => {
      setEvents((current) => [...current.slice(-199), event]);
      if (event.type === "message.delta") {
        setMessages((current) => appendAssistantDelta(current, event.delta));
      }
      if (event.type === "run.completed" || event.type === "run.failed") {
        setBusy(false);
        void refreshSessions();
      }
      if (event.type === "run.failed") {
        setError(event.error);
      }
      if (event.type === "approval.requested") setApproval(event);
      if (event.type === "approval.resolved") {
        setApproval((current) => current?.requestId === event.requestId ? undefined : current);
      }
      void refresh();
    });
    const unsubscribeSettings = window.deki.subscribeSettings(setSettings);
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsSection(undefined);
        setShowSettings((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unsubscribeAgent();
      unsubscribeSettings();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      const nextCompact = window.innerWidth <= 980;
      setCompactLayout((current) => {
        if (current !== nextCompact) setInspectorOpen(!nextCompact);
        return nextCompact;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!state) return;
    void refreshSessions().catch((reason) => setError(String(reason)));
    if (!state.sessionId) {
      setMessages([]);
      return;
    }
    void window.deki.getSessionHistory()
      .then(setMessages)
      .catch((reason) => setError(String(reason)));
  }, [state?.trusted, state?.workspace, state?.sessionId]);

  useEffect(() => {
    if (!settings) return;
    const appearance = settings.effective.appearance;
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      root.dataset.theme = appearance.theme === "system"
        ? (media.matches ? "light" : "dark")
        : appearance.theme;
    };
    applyTheme();
    root.dataset.accent = appearance.accent;
    root.dataset.density = appearance.density;
    root.dataset.highContrast = String(appearance.highContrast);
    root.lang = resolveLocale(settings);
    root.style.setProperty("--ui-font-size", `${appearance.fontSize}px`);
    root.style.setProperty("--code-font", appearance.codeFont);
    root.style.setProperty("--sidebar-width", `${appearance.sidebarWidth}px`);
    root.classList.toggle("reduce-motion", appearance.reduceMotion);
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings]);

  const toolEvents = useMemo(
    () => events.filter(
      (event): event is Extract<AgentEvent, { type: "tool.started" | "tool.updated" | "tool.completed" }> =>
        event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.completed",
    ),
    [events],
  );
  const toolActivities = useMemo(() => buildToolActivities(toolEvents), [toolEvents]);
  const diffs = useMemo(
    () => events.filter(
      (event): event is Extract<AgentEvent, { type: "diff.available" }> =>
        event.type === "diff.available",
    ),
    [events],
  );
  const locale = resolveLocale(settings);
  const zh = locale === "zh-CN";
  const isRememberCommand = Boolean(
    state?.workspace || settings?.effective.memory.userMemoryEnabled,
  ) && prompt.trimStart().startsWith("/remember ");
  const canRemember = Boolean(
    state?.workspace || settings?.effective.memory.userMemoryEnabled,
  );
  const thinkingLabel = formatThinkingLevel(
    settings?.effective.models.thinkingLevel ?? "medium",
    zh,
  );
  const projectName = state?.workspace
    ? getWorkspaceName(state.workspace)
    : (zh ? "普通会话" : "General chat");
  const visibleSessions = sessions.filter((session) => {
    const query = sessionQuery.trim().toLocaleLowerCase();
    return !query || `${session.name ?? ""} ${session.firstMessage}`.toLocaleLowerCase().includes(query);
  });

  if (!state) {
    return <main className="loading">正在启动 Deki…</main>;
  }

  if (state.workspace && !state.trusted) {
    return (
      <main className="trust-screen">
        <section className="trust-card">
          <div className="brand-mark">D</div>
          <p className="eyebrow">DEKI · LOCAL-FIRST</p>
          <h1>{zh ? "信任这个工作区？" : "Trust this workspace?"}</h1>
          <p className="muted">
            {zh
              ? "信任后 Deki 才会读取项目 Skill、启动项目 MCP Server，并创建受权限保护的 Agent。"
              : "After trust, Deki may load project skills, start project MCP servers, and create a permission-protected agent."}
          </p>
          <code className="workspace-path">{state.workspace}</code>
          <button
            className="primary"
            onClick={() => void runCommand(window.deki.trustWorkspace(), setError, refresh)}
          >
            {zh ? "信任并继续" : "Trust and continue"}
          </button>
          <button
            className="ghost trust-secondary"
            onClick={() => void runCommand(window.deki.openGeneralChat(), setError, refresh)}
          >
            {zh ? "返回普通会话" : "Return to general chat"}
          </button>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  if (showSettings && settings) {
    return (
      <SettingsView
        snapshot={settings}
        {...(settingsSection ? { initialSection: settingsSection } : {})}
        hasWorkspace={Boolean(state.workspace && state.trusted)}
        {...(state.sessionId ? { taskId: state.sessionId } : {})}
        locale={locale}
        onChanged={setSettings}
        onClose={() => {
          setShowSettings(false);
          setSettingsSection(undefined);
          void refresh();
        }}
        onRefreshState={refresh}
      />
    );
  }

  async function submit() {
    const value = prompt.trim();
    if (!value || busy) return;
    const rememberCommand = value.startsWith("/remember ");
    setPrompt("");
    setError(undefined);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: value },
    ]);
    setBusy(true);
    const result = await window.deki.sendPrompt(value);
    if (!result.ok || rememberCommand) {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error ?? "请求失败");
    }
    await refresh();
  }

  return (
    <main className="app-shell">
      <aside className="navigation-sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small">D</div>
          <div>
            <strong>Deki</strong>
            <span>{zh ? "本地 AI 开发工作台" : "Local AI development workspace"}</span>
          </div>
        </div>

        <nav className="sidebar-navigation" aria-label={zh ? "项目和会话" : "Projects and sessions"}>
          <section className="navigation-section">
            <header className="navigation-heading">
              <span>{zh ? "项目" : "Projects"}</span>
              <button
                className="icon-button"
                disabled={busy}
                title={zh ? "添加或切换项目" : "Add or switch project"}
                aria-label={zh ? "添加项目" : "Add project"}
                onClick={() => void runCommand(
                  window.deki.chooseWorkspace(),
                  setError,
                  refresh,
                )}
              >
                +
              </button>
            </header>
            {state.workspace ? (
              <button className="project-item active" title={state.workspace}>
                <span className="navigation-icon folder-icon" aria-hidden="true" />
                <span className="navigation-copy">
                  <strong>{projectName}</strong>
                  <small>{zh ? "当前工作区" : "Current workspace"}</small>
                </span>
                <span className={state.ready ? "project-dot ready" : "project-dot"} />
              </button>
            ) : (
              <button
                className="navigation-empty"
                disabled={busy}
                onClick={() => void runCommand(window.deki.chooseWorkspace(), setError, refresh)}
              >
                <span className="navigation-icon folder-icon" aria-hidden="true" />
                <span>{zh ? "关联一个项目" : "Connect a project"}</span>
              </button>
            )}
            {state.recentWorkspaces
              .filter((workspace) => workspace !== state.workspace)
              .slice(0, 6)
              .map((workspace) => (
                <button
                  className="project-item"
                  title={workspace}
                  key={workspace}
                  disabled={busy}
                  onClick={() => void runCommand(
                    window.deki.openWorkspace(workspace),
                    setError,
                    refresh,
                  )}
                >
                  <span className="navigation-icon folder-icon" aria-hidden="true" />
                  <span className="navigation-copy">
                    <strong>{getWorkspaceName(workspace)}</strong>
                    <small>{zh ? "最近项目" : "Recent project"}</small>
                  </span>
                </button>
              ))}
          </section>

          <section className="navigation-section sessions-section">
            <header className="navigation-heading">
              <span>{zh ? "会话" : "Sessions"}</span>
              <button
                className="icon-button"
                disabled={!state.ready || busy}
                title={zh ? "新建会话" : "New chat"}
                aria-label={zh ? "新建会话" : "New chat"}
                onClick={() => {
                  setMessages([]);
                  setEvents([]);
                  void runCommand(window.deki.newSession(), setError, refresh);
                }}
              >
                +
              </button>
            </header>
            {sessions.length > 4 && <input className="session-search" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder={zh ? "搜索会话…" : "Search sessions…"} />}
            <div className="session-list">
              {visibleSessions.map((session) => (
                <div className={`session-row${session.current ? " active" : ""}`} key={session.id}>
                  <button
                    className="session-item"
                    disabled={busy}
                    onClick={() => {
                      if (session.current) return;
                      setMessages([]);
                      setEvents([]);
                      void runCommand(window.deki.switchSession(session.id), setError, refresh);
                    }}
                  >
                    <span className="navigation-icon chat-icon" aria-hidden="true" />
                    <span className="navigation-copy">
                      <strong>{session.name || session.firstMessage || (zh ? "新会话" : "New chat")}</strong>
                      <small>{session.messageCount} {zh ? "条消息" : "messages"} · {new Date(session.updatedAt).toLocaleDateString()}</small>
                    </span>
                  </button>
                  <div className="session-actions">
                    <button
                      className="icon-button"
                      aria-label={zh ? "重命名会话" : "Rename session"}
                      onClick={() => {
                        const name = window.prompt(zh ? "输入会话名称" : "Session name", session.name ?? session.firstMessage);
                        if (name?.trim()) void runCommand(window.deki.renameSession(session.id, name.trim()), setError, refreshSessions);
                      }}
                    >✎</button>
                    {!session.current && <button
                      className="icon-button danger-text"
                      aria-label={zh ? "删除会话" : "Delete session"}
                      onClick={() => {
                        if (window.confirm(zh ? "将此会话移到废纸篓？" : "Move this session to the trash?")) {
                          void runCommand(window.deki.deleteSession(session.id), setError, refreshSessions);
                        }
                      }}
                    >×</button>}
                  </div>
                </div>
              ))}
              {visibleSessions.length === 0 && (
                <button className="session-item active" disabled>
                  <span className="navigation-icon chat-icon" aria-hidden="true" />
                  <span className="navigation-copy">
                    <strong>{zh ? "新会话" : "New chat"}</strong>
                    <small>{state.ready ? (zh ? "尚未保存消息" : "No saved messages") : (zh ? "等待模型就绪" : "Waiting for a model")}</small>
                  </span>
                </button>
              )}
            </div>
          </section>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={state.ready ? "status ready" : "status warning"} />
            <span>{state.ready ? (zh ? "Agent 已就绪" : "Agent ready") : (zh ? "需要云模型凭据" : "Cloud credentials required")}</span>
          </div>
          <button
            className="settings-button"
            title={zh ? "设置 (⌘,)" : "Settings (⌘,)"}
            aria-label={zh ? "设置" : "Settings"}
            data-testid="open-settings"
            onClick={() => {
              setSettingsSection(undefined);
              setShowSettings(true);
            }}
          >
            <span aria-hidden="true">⚙</span>
            {zh ? "设置" : "Settings"}
          </button>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <div className="project-heading">
            <strong>{projectName}</strong>
            <code>{state.workspace ?? (zh ? "未关联项目，可直接开始普通会话" : "No project; general chat is available")}</code>
          </div>
          <div className="top-actions">
            <button
              className={`inspector-toggle${inspectorOpen ? " active" : ""}`}
              aria-label={inspectorOpen ? (zh ? "关闭检查器" : "Close inspector") : (zh ? "打开检查器" : "Open inspector")}
              aria-expanded={inspectorOpen}
              data-testid="toggle-inspector"
              onClick={() => setInspectorOpen((current) => !current)}
            >
              <span aria-hidden="true">◫</span>
              <span className="inspector-toggle-label">{zh ? "检查器" : "Inspector"}</span>
              {(toolActivities.length + diffs.length) > 0 && <b>{toolActivities.length + diffs.length}</b>}
            </button>
          </div>
        </header>

        <div
          className={`content-grid${inspectorOpen ? " inspector-visible" : ""}`}
          style={{ "--inspector-width": `${inspectorWidth}px` } as React.CSSProperties}
        >
          <section className="chat-panel">
            <div className="messages">
              {messages.length === 0 && (
                <div className="empty-state">
                  <p className="eyebrow">
                    {state.workspace ? "PERMISSION-PROTECTED AGENT" : "GENERAL CHAT"}
                  </p>
                  <h2>{state.workspace ? (zh ? "从理解项目开始" : "Start by understanding the project") : (zh ? "开始一个普通会话" : "Start a general chat")}</h2>
                  <p>
                    {state.workspace
                      ? (zh
                          ? <>试试“概览当前项目”，或输入 <code>/remember 项目使用 Electron</code>。</>
                          : <>Try “summarize this project”, or enter <code>/remember This project uses Electron</code>.</>)
                      : (zh ? "普通会话无需选择项目，也不会读取本地项目内容。" : "General chat needs no project and cannot read local project content.")}
                  </p>
                  {!state.ready && (
                    <button
                      className="primary empty-state-action"
                      onClick={() => {
                        setSettingsSection("models");
                        setShowSettings(true);
                      }}
                    >
                      {zh ? "配置模型" : "Configure a model"}
                    </button>
                  )}
                  {!state.workspace && (
                    <button
                      className="ghost empty-state-action"
                      onClick={() => void runCommand(window.deki.chooseWorkspace(), setError, refresh)}
                    >
                      {zh ? "关联项目" : "Connect a project"}
                    </button>
                  )}
                </div>
              )}
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span>{message.role === "user" ? (zh ? "你" : "You") : "Deki"}</span>
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        pre: ({ children }) => (
                          <div className="code-block">
                            <button
                              aria-label={zh ? "复制代码" : "Copy code"}
                              onClick={() => void navigator.clipboard.writeText(extractText(children))}
                            >
                              {zh ? "复制" : "Copy"}
                            </button>
                            <pre>{children}</pre>
                          </div>
                        ),
                      }}
                    >
                      {message.content || "…"}
                    </ReactMarkdown>
                  </div>
                </article>
              ))}
              {toolActivities.length > 0 && (
                <section className="inline-tools" aria-label={zh ? "工具执行过程" : "Tool execution details"}>
                  {toolActivities.slice(-6).map((activity) => (
                    <ToolCard key={activity.callId} activity={activity} zh={zh} />
                  ))}
                </section>
              )}
            </div>
            <div className="composer">
              <div className="composer-card">
                <textarea
                  className="composer-input"
                  value={prompt}
                  disabled={busy}
                  placeholder={state.ready
                    ? (zh
                        ? "输入消息…（Enter 发送，Shift+Enter 换行，/remember 保存记忆）"
                        : "Type a message… (Enter to send, Shift+Enter for a new line, /remember to save memory)")
                    : state.workspace
                      ? "未配置模型；仍可输入 /remember 保存项目记忆"
                      : (zh ? "请在设置中添加模型 Provider 或配置环境变量" : "Add a model provider in Settings or configure environment credentials")}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <div className="composer-meta">
                    <span className="composer-model-mark" aria-hidden="true">
                      {state.selectedModel?.provider.slice(0, 1).toUpperCase() ?? "AI"}
                    </span>
                    <select
                      className="composer-model"
                      aria-label={zh ? "选择模型" : "Select model"}
                      value={state.selectedModel
                        ? `${state.selectedModel.provider}/${state.selectedModel.id}`
                        : ""}
                      disabled={state.models.length === 0 || busy}
                      onChange={(event) => {
                        const [provider, ...id] = event.target.value.split("/");
                        if (provider) {
                          void runCommand(
                            window.deki.selectModel(provider, id.join("/")),
                            setError,
                            refresh,
                          );
                        }
                      }}
                    >
                      {state.models.length === 0 && <option value="">{zh ? "未配置模型" : "No model"}</option>}
                      {state.models.map((model) => (
                        <option
                          key={`${model.provider}/${model.id}`}
                          value={`${model.provider}/${model.id}`}
                        >
                          {model.name} · {model.provider}
                        </option>
                      ))}
                    </select>
                    <span className="composer-mode" title={zh ? "思考强度" : "Thinking level"}>
                      {thinkingLabel}
                    </span>
                    <span className="composer-runtime" title="Pi Coding Agent Runtime">
                      <span aria-hidden="true">◇</span> Pi
                    </span>
                  </div>
                  <div className="composer-actions">
                    <button
                      className="composer-tool"
                      aria-label={zh ? "保存记忆" : "Save memory"}
                      title={zh ? "插入 /remember" : "Insert /remember"}
                      disabled={busy || !canRemember}
                      onClick={() => setPrompt((current) => (
                        current ? `${current}\n/remember ` : "/remember "
                      ))}
                    >
                      <span aria-hidden="true">✦</span>
                    </button>
                    <button
                      className="composer-tool"
                      aria-label={zh ? "选择项目" : "Choose project"}
                      title={zh ? "选择或切换项目" : "Choose or switch project"}
                      disabled={busy}
                      onClick={() => void runCommand(
                        window.deki.chooseWorkspace(),
                        setError,
                        refresh,
                      )}
                    >
                      <span className="navigation-icon folder-icon" aria-hidden="true" />
                    </button>
                    {busy ? (
                      <button
                        className="composer-submit danger"
                        aria-label={zh ? "停止" : "Stop"}
                        title={zh ? "停止" : "Stop"}
                        onClick={() => void runCommand(window.deki.abortRun(), setError, refresh)}
                      >
                        <span aria-hidden="true">■</span>
                      </button>
                    ) : (
                      <button
                        className="composer-submit primary"
                        aria-label={zh ? "发送" : "Send"}
                        title={zh ? "发送" : "Send"}
                        disabled={!state.ready && !isRememberCommand}
                        onClick={() => void submit()}
                      >
                        <span aria-hidden="true">↑</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {error && <p className="error inline-error">{error}</p>}
          </section>

          {compactLayout && inspectorOpen && (
            <button
              className="inspector-scrim"
              aria-label={zh ? "关闭检查器" : "Close inspector"}
              onClick={() => setInspectorOpen(false)}
            />
          )}
          <aside className={`side-panel${inspectorOpen ? " open" : ""}`} aria-hidden={!inspectorOpen}>
            {!compactLayout && (
              <div
                className="inspector-resizer"
                role="separator"
                aria-label={zh ? "调整检查器宽度" : "Resize inspector"}
                aria-orientation="vertical"
                tabIndex={0}
                onPointerDown={(event) => startInspectorResize(event.clientX, inspectorWidth, setInspectorWidth)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") setInspectorWidth((value) => Math.min(520, value + 20));
                  if (event.key === "ArrowRight") setInspectorWidth((value) => Math.max(280, value - 20));
                }}
              />
            )}
            <header className="inspector-header">
              <strong>{zh ? "运行检查器" : "Run inspector"}</strong>
              <button className="icon-button" aria-label={zh ? "关闭检查器" : "Close inspector"} onClick={() => setInspectorOpen(false)}>×</button>
            </header>
            {diffs.length > 0 && (
              <Panel title={zh ? "变更 Diff" : "Change diffs"} count={diffs.length}>
                {diffs.slice(-3).reverse().map((event, index) => (
                  <details className="diff-entry" key={event.eventId} open={index === 0}>
                    <summary>{zh ? "文件修改" : "File change"} · {event.callId.slice(0, 8)}</summary>
                    <pre>{event.diff}</pre>
                  </details>
                ))}
              </Panel>
            )}
            <Panel title={zh ? "工具执行" : "Tool activity"} count={toolActivities.length}>
              {toolActivities.length === 0
                ? <EmptyLine text={zh ? "等待工具调用" : "Waiting for tool calls"} />
                : toolActivities.slice(-8).reverse().map((activity) => (
                    <ToolCard compact key={activity.callId} activity={activity} zh={zh} />
                  ))}
            </Panel>

            {state.workspace && (
              <>
                <Panel title={zh ? "项目记忆" : "Project memory"} count={state.memories.length}>
                  {state.memories.length === 0
                    ? <EmptyLine text={zh ? "使用 /remember 保存第一条记忆" : "Use /remember to save the first memory"} />
                    : state.memories.slice(0, 5).map((memory) => (
                        <MemoryLine key={memory.id} memory={memory} />
                      ))}
                </Panel>

                <Panel title={zh ? "本轮使用的记忆" : "Memories used this turn"} count={state.recalledMemories.length}>
                  {state.recalledMemories.length === 0
                    ? <EmptyLine text={zh ? "本轮尚未注入项目记忆" : "No project memory used this turn"} />
                    : state.recalledMemories.map((memory) => (
                        <MemoryLine key={memory.id} memory={memory} />
                      ))}
                </Panel>
              </>
            )}

            <Panel title={zh ? "运行状态" : "Runtime status"} count={state.skills.length + state.mcpServers.length}>
              <StatusLine label="Skills" value={state.skills.join(", ") || (zh ? "未加载" : "Not loaded")} />
              <StatusLine
                label="MCP"
                value={state.mcpServers.length
                  ? state.mcpServers.map((server) => `${server.id}:${server.state}`).join(", ")
                  : (zh ? "未配置" : "Not configured")}
              />
              {state.diagnostics.slice(-3).map((message) => (
                <p className="diagnostic" key={message}>{message}</p>
              ))}
            </Panel>
          </aside>
        </div>
      </section>
      {approval && (
        <div className="approval-overlay" role="dialog" aria-modal="true" aria-label={zh ? "操作审批" : "Operation approval"}>
          <section className="approval-dialog">
            <p className="eyebrow">PERMISSION REQUEST · {approval.category}</p>
            <h2>{approval.title}</h2>
            <p className="muted">{approval.description}</p>
            <pre className="approval-details">{JSON.stringify(approval.details, null, 2)}</pre>
            {approval.diff && <pre className="approval-diff">{approval.diff}</pre>}
            <small>{zh ? `请求将在 ${new Date(approval.expiresAt).toLocaleTimeString()} 超时，超时视为拒绝。` : `This request expires at ${new Date(approval.expiresAt).toLocaleTimeString()} and will be denied.`}</small>
            <div className="approval-actions">
              <button className="danger" onClick={() => void answerApproval("deny")}>{zh ? "拒绝" : "Deny"}</button>
              <button className="ghost" onClick={() => void answerApproval("allow_once")}>{zh ? "允许一次" : "Allow once"}</button>
              <button className="ghost" onClick={() => void answerApproval("allow_session")}>{zh ? "当前会话允许" : "Allow for session"}</button>
              <button className="primary" onClick={() => void answerApproval("allow_project")}>{zh ? "当前项目允许" : "Allow for project"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );

  async function answerApproval(
    decision: "allow_once" | "allow_session" | "allow_project" | "deny",
  ) {
    if (!approval) return;
    const result = await window.deki.respondToApproval(approval.requestId, decision);
    if (!result.ok) setError(result.error);
    setApproval(undefined);
  }
}

function resolveLocale(settings: SettingsSnapshot | undefined): "zh-CN" | "en-US" {
  const configured = settings?.effective.general.locale ?? "system";
  if (configured === "zh-CN" || configured === "en-US") return configured;
  return navigator.language.toLocaleLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function formatThinkingLevel(
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  zh: boolean,
): string {
  if (!zh) {
    return {
      off: "Off",
      minimal: "Minimal",
      low: "Low",
      medium: "Standard",
      high: "High",
      xhigh: "Extra high",
    }[level];
  }
  return {
    off: "关闭",
    minimal: "最小",
    low: "较低",
    medium: "标准",
    high: "较高",
    xhigh: "最高",
  }[level];
}

function Panel(props: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-section">
      <header>
        <h3>{props.title}</h3>
        <span>{props.count}</span>
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="muted compact">{text}</p>;
}

function MemoryLine({ memory }: { memory: MemoryRecord }) {
  return (
    <div className="memory-line">
      <p>{memory.content}</p>
      <small>{memory.source.kind} · {new Date(memory.createdAt).toLocaleString()}</small>
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ToolCard(props: { activity: ToolActivity; zh: boolean; compact?: boolean }) {
  const { activity, zh } = props;
  const status = activity.status === "running"
    ? (zh ? "执行中" : "Running")
    : activity.status === "failed"
      ? (zh ? "失败" : "Failed")
      : (zh ? "完成" : "Completed");
  return (
    <details className={`tool-card ${activity.status}${props.compact ? " compact" : ""}`}>
      <summary>
        <span className={`dot ${activity.status === "completed" ? "done" : activity.status}`} />
        <strong>{activity.toolName}</strong>
        <small>{status}</small>
      </summary>
      <div className="tool-card-body">
        {activity.input !== undefined && <ToolPayload label={zh ? "输入" : "Input"} value={activity.input} />}
        {activity.update !== undefined && <ToolPayload label={zh ? "过程输出" : "Progress"} value={activity.update} />}
        {activity.result !== undefined && <ToolPayload label={zh ? "结果" : "Result"} value={activity.result} />}
      </div>
    </details>
  );
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  return <div className="tool-payload"><span>{label}</span><pre>{formatPayload(value)}</pre></div>;
}

function buildToolActivities(
  events: Array<Extract<AgentEvent, { type: "tool.started" | "tool.updated" | "tool.completed" }>>,
): ToolActivity[] {
  const activities = new Map<string, ToolActivity>();
  for (const event of events) {
    const current = activities.get(event.callId) ?? {
      callId: event.callId,
      toolName: event.toolName,
      status: "running" as const,
    };
    if (event.type === "tool.started") {
      current.input = event.input;
    } else if (event.type === "tool.updated") {
      current.update = event.update;
    } else {
      current.result = event.result;
      current.status = event.isError ? "failed" : "completed";
    }
    activities.set(event.callId, current);
  }
  return [...activities.values()];
}

function formatPayload(value: unknown): string {
  const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!formatted) return String(value);
  return formatted.length > 20_000 ? `${formatted.slice(0, 20_000)}\n…` : formatted;
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

function startInspectorResize(
  initialX: number,
  initialWidth: number,
  setWidth: (width: number) => void,
) {
  const onMove = (event: PointerEvent) => {
    setWidth(Math.min(520, Math.max(280, initialWidth + initialX - event.clientX)));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function appendAssistantDelta(
  messages: ChatMessage[],
  delta: string,
): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    return [
      ...messages.slice(0, -1),
      { ...last, content: last.content + delta },
    ];
  }
  return [
    ...messages,
    { id: crypto.randomUUID(), role: "assistant", content: delta },
  ];
}

async function runCommand(
  promise: Promise<CommandResult>,
  setError: (value: string | undefined) => void,
  refresh: () => Promise<void>,
) {
  const result = await promise;
  setError(result.ok ? undefined : result.error ?? "操作失败");
  await refresh();
}

function getWorkspaceName(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || workspace;
}
