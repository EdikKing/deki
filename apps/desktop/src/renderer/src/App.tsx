import { useEffect, useMemo, useState } from "react";
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
    root.style.setProperty("--ui-font-size", `${appearance.fontSize}px`);
    root.style.setProperty("--code-font", appearance.codeFont);
    root.style.setProperty("--sidebar-width", `${appearance.sidebarWidth}px`);
    root.classList.toggle("reduce-motion", appearance.reduceMotion);
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings]);

  const toolEvents = useMemo(
    () => events.filter((event) => event.type.startsWith("tool.")),
    [events],
  );
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
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  if (showSettings && settings) {
    return (
      <SettingsView
        snapshot={settings}
        hasWorkspace={Boolean(state.workspace && state.trusted)}
        locale={locale}
        onChanged={setSettings}
        onClose={() => {
          setShowSettings(false);
          void refresh();
        }}
        onRefreshState={refresh}
      />
    );
  }

  async function submit() {
    const value = prompt.trim();
    if (!value || busy) return;
    setPrompt("");
    setError(undefined);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: value },
    ]);
    setBusy(true);
    const result = await window.deki.sendPrompt(value);
    if (!result.ok) {
      setBusy(false);
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

        <nav className="sidebar-navigation" aria-label="项目和会话">
          <section className="navigation-section">
            <header className="navigation-heading">
              <span>{zh ? "项目" : "Projects"}</span>
              <button
                className="icon-button"
                disabled={busy}
                title="添加或切换项目"
                aria-label="添加项目"
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
              <div className="navigation-empty">
                <span className="navigation-icon folder-icon" aria-hidden="true" />
                <p>{zh ? "未关联项目" : "No project"}</p>
              </div>
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
                title="新建会话"
                aria-label="新建会话"
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
            title="设置 (⌘,)"
            aria-label="设置"
            data-testid="open-settings"
            onClick={() => setShowSettings(true)}
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
            <select
              aria-label="选择模型"
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
              {state.models.length === 0 && <option value="">{zh ? "未配置云模型" : "No cloud model"}</option>}
              {state.models.map((model) => (
                <option
                  key={`${model.provider}/${model.id}`}
                  value={`${model.provider}/${model.id}`}
                >
                  {model.name} · {model.provider}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="content-grid">
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
                      ? <>试试“概览当前项目”，或输入 <code>/remember 项目使用 Electron</code>。</>
                      : (zh ? "普通会话无需选择项目，也不会读取本地项目内容。" : "General chat needs no project and cannot read local project content.")}
                  </p>
                </div>
              )}
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span>{message.role === "user" ? "你" : "Deki"}</span>
                  <div>{message.content || "…"}</div>
                </article>
              ))}
            </div>
            <div className="composer">
              <textarea
                value={prompt}
                disabled={busy}
                placeholder={state.ready
                  ? (zh ? "输入任务，Enter 发送，Shift+Enter 换行" : "Enter a task; Enter sends, Shift+Enter adds a line")
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
              {busy ? (
                <button
                  className="danger"
                  onClick={() => void runCommand(window.deki.abortRun(), setError, refresh)}
                >
                  {zh ? "停止" : "Stop"}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={!state.ready && !isRememberCommand}
                  onClick={() => void submit()}
                >
                  {zh ? "发送" : "Send"}
                </button>
              )}
            </div>
            {error && <p className="error inline-error">{error}</p>}
          </section>

          <aside className="side-panel">
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
            <Panel title="Tool Timeline" count={toolEvents.length}>
              {toolEvents.length === 0
                ? <EmptyLine text="等待工具调用" />
                : toolEvents.slice(-8).reverse().map((event) => (
                    <div className="timeline-item" key={event.eventId}>
                      <span className={`dot ${event.type.endsWith("completed") ? "done" : ""}`} />
                      <div>
                        <strong>{"toolName" in event ? event.toolName : "tool"}</strong>
                        <small>{formatEventType(event.type)}</small>
                      </div>
                    </div>
                  ))}
            </Panel>

            {state.workspace && (
              <>
                <Panel title="项目记忆" count={state.memories.length}>
                  {state.memories.length === 0
                    ? <EmptyLine text="使用 /remember 保存第一条记忆" />
                    : state.memories.slice(0, 5).map((memory) => (
                        <MemoryLine key={memory.id} memory={memory} />
                      ))}
                </Panel>

                <Panel title="本轮使用的记忆" count={state.recalledMemories.length}>
                  {state.recalledMemories.length === 0
                    ? <EmptyLine text="本轮尚未注入项目记忆" />
                    : state.recalledMemories.map((memory) => (
                        <MemoryLine key={memory.id} memory={memory} />
                      ))}
                </Panel>
              </>
            )}

            <Panel title="运行状态" count={state.skills.length + state.mcpServers.length}>
              <StatusLine label="Skills" value={state.skills.join(", ") || "未加载"} />
              <StatusLine
                label="MCP"
                value={state.mcpServers.length
                  ? state.mcpServers.map((server) => `${server.id}:${server.state}`).join(", ")
                  : "未配置"}
              />
              {state.diagnostics.slice(-3).map((message) => (
                <p className="diagnostic" key={message}>{message}</p>
              ))}
            </Panel>
          </aside>
        </div>
      </section>
      {approval && (
        <div className="approval-overlay" role="dialog" aria-modal="true" aria-label="操作审批">
          <section className="approval-dialog">
            <p className="eyebrow">PERMISSION REQUEST · {approval.category}</p>
            <h2>{approval.title}</h2>
            <p className="muted">{approval.description}</p>
            <pre className="approval-details">{JSON.stringify(approval.details, null, 2)}</pre>
            {approval.diff && <pre className="approval-diff">{approval.diff}</pre>}
            <small>请求将在 {new Date(approval.expiresAt).toLocaleTimeString()} 超时，超时视为拒绝。</small>
            <div className="approval-actions">
              <button className="danger" onClick={() => void answerApproval("deny")}>拒绝</button>
              <button className="ghost" onClick={() => void answerApproval("allow_once")}>允许一次</button>
              <button className="ghost" onClick={() => void answerApproval("allow_session")}>当前会话允许</button>
              <button className="primary" onClick={() => void answerApproval("allow_project")}>当前项目允许</button>
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

function formatEventType(type: AgentEvent["type"]): string {
  if (type === "tool.started") return "正在执行";
  if (type === "tool.updated") return "输出更新";
  if (type === "tool.completed") return "执行完成";
  return type;
}

function getWorkspaceName(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || workspace;
}
