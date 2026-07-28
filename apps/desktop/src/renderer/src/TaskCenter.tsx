import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  TaskDetail,
  TaskStatus,
  TaskSummary,
} from "@deki-ai/shared";

interface TaskCenterProps {
  zh: boolean;
  initialTaskId?: string;
  onOpenSession(taskId: string): Promise<void>;
}

const statusCopy: Record<TaskStatus, { zh: string; en: string }> = {
  queued: { zh: "排队中", en: "Queued" },
  running: { zh: "运行中", en: "Running" },
  waiting_approval: { zh: "等待审批", en: "Needs approval" },
  waiting_user: { zh: "等待输入", en: "Needs input" },
  paused: { zh: "已暂停", en: "Paused" },
  succeeded: { zh: "已完成", en: "Completed" },
  failed: { zh: "失败", en: "Failed" },
  cancelled: { zh: "已取消", en: "Cancelled" },
  interrupted: { zh: "已中断", en: "Interrupted" },
};

export function TaskCenter(props: TaskCenterProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState(props.initialTaskId);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [error, setError] = useState<string>();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  async function refreshTasks() {
    const rows = await window.deki.listTasks({
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(workspaceId ? { workspaceIds: [workspaceId] } : {}),
      ...(status ? { statuses: [status] } : {}),
      limit: 500,
    });
    setTasks(rows);
    setSelectedId((current) => current ?? rows[0]?.task.id);
  }

  async function refreshDetail(id = selectedId) {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetail(await window.deki.getTask(id));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshTasks().catch((reason) => setError(String(reason)));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [query, workspaceId, status]);

  useEffect(() => {
    if (props.initialTaskId) setSelectedId(props.initialTaskId);
  }, [props.initialTaskId]);

  useEffect(() => {
    void refreshDetail();
  }, [selectedId]);

  useEffect(() => window.deki.subscribeTaskEvents((event) => {
    void refreshTasks();
    if (event.taskId === selectedId) void refreshDetail(event.taskId);
  }), [selectedId, query, workspaceId, status]);

  const workspaces = useMemo(() => {
    const entries = new Map<string, string>();
    for (const summary of tasks) {
      entries.set(
        summary.task.workspaceId,
        workspaceName(summary.task.workspacePath, props.zh),
      );
    }
    return [...entries.entries()];
  }, [tasks, props.zh]);

  const grouped = useMemo(() => {
    const groups = [
      {
        key: "running",
        title: props.zh ? "运行中" : "Running",
        rows: tasks.filter((item) => item.task.status === "running"),
      },
      {
        key: "attention",
        title: props.zh ? "需要处理" : "Needs attention",
        rows: tasks.filter((item) =>
          item.task.status === "waiting_approval"
          || item.task.status === "waiting_user"),
      },
      {
        key: "queued",
        title: props.zh ? "排队与暂停" : "Queued & paused",
        rows: tasks.filter((item) =>
          item.task.status === "queued" || item.task.status === "paused"),
      },
      {
        key: "completed",
        title: props.zh ? "已完成" : "Completed",
        rows: tasks.filter((item) =>
          item.task.status === "succeeded" || item.task.status === "cancelled"),
      },
      {
        key: "failed",
        title: props.zh ? "失败与中断" : "Failed & interrupted",
        rows: tasks.filter((item) =>
          item.task.status === "failed" || item.task.status === "interrupted"),
      },
    ];
    return groups.filter((group) => group.rows.length > 0);
  }, [tasks, props.zh]);

  async function command(operation: Promise<{ ok: boolean; error?: string | undefined }>) {
    const result = await operation;
    if (!result.ok) setError(result.error ?? (props.zh ? "操作失败" : "Action failed"));
    else setError(undefined);
    await refreshTasks();
    await refreshDetail();
  }

  return (
    <section className="task-center" data-testid="task-center">
      <header className="task-center-header">
        <div>
          <p className="eyebrow">TASK CENTER</p>
          <h1>{props.zh ? "后台任务" : "Background tasks"}</h1>
        </div>
        <span>{props.zh ? `${tasks.length} 个任务` : `${tasks.length} tasks`}</span>
      </header>

      <div className="task-center-filters">
        <input
          type="search"
          value={query}
          placeholder={props.zh ? "搜索任务、结果或错误" : "Search tasks, results, or errors"}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
          <option value="">{props.zh ? "全部项目" : "All projects"}</option>
          {workspaces.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskStatus | "")}
        >
          <option value="">{props.zh ? "全部状态" : "All statuses"}</option>
          {Object.entries(statusCopy).map(([value, copy]) => (
            <option key={value} value={value}>{props.zh ? copy.zh : copy.en}</option>
          ))}
        </select>
      </div>

      <div className="task-center-grid">
        <div className="task-list">
          {grouped.map((group) => (
            <section className="task-group" key={group.key}>
              <h2>{group.title}<span>{group.rows.length}</span></h2>
              {group.rows.map((summary) => {
                const task = summary.task;
                return (
                  <button
                    className={`task-row${selectedId === task.id ? " active" : ""}`}
                    key={task.id}
                    onClick={() => setSelectedId(task.id)}
                  >
                    <span className={`task-status-dot ${task.status}`} />
                    <span className="task-row-copy">
                      <strong>{task.title}</strong>
                      <small>
                        {workspaceName(task.workspacePath, props.zh)}
                        {" · "}
                        {props.zh ? statusCopy[task.status].zh : statusCopy[task.status].en}
                      </small>
                      {(summary.resultSummary || summary.error) && (
                        <span>{summary.error ?? summary.resultSummary}</span>
                      )}
                    </span>
                    <time>{relativeTime(task.updatedAt, props.zh)}</time>
                  </button>
                );
              })}
            </section>
          ))}
          {tasks.length === 0 && (
            <div className="task-empty">
              {props.zh ? "没有符合条件的任务" : "No matching tasks"}
            </div>
          )}
        </div>

        <div className="task-detail">
          {detail ? (
            <>
              <header className="task-detail-header">
                <div>
                  <button
                    className="task-detail-back"
                    onClick={() => setSelectedId(undefined)}
                  >← {props.zh ? "任务列表" : "Tasks"}</button>
                  <span className={`task-status-pill ${detail.task.status}`}>
                    {props.zh
                      ? statusCopy[detail.task.status].zh
                      : statusCopy[detail.task.status].en}
                  </span>
                  <h2>{detail.task.title}</h2>
                  <p>{workspaceName(detail.task.workspacePath, props.zh)}</p>
                </div>
                <TaskActions
                  detail={detail}
                  zh={props.zh}
                  onCommand={command}
                  onOpen={() => props.onOpenSession(detail.task.id)}
                />
              </header>

              <section className="task-detail-section">
                <h3>{props.zh ? "目标" : "Goal"}</h3>
                <p className="task-goal">{detail.task.goal}</p>
              </section>

              {detail.requests.filter((request) => request.status === "pending").map((request) => (
                <section className="task-request" key={request.id}>
                  <span>{request.kind === "approval"
                    ? (props.zh ? "需要审批" : "Approval required")
                    : (props.zh ? "需要输入" : "Input required")}</span>
                  <h3>{request.title}</h3>
                  {request.description && <p>{request.description}</p>}
                  {request.kind === "approval" ? (
                    <>
                      <pre className="task-request-details">
                        {JSON.stringify(request.payload, null, 2)}
                      </pre>
                      <div className="task-request-actions">
                        <button onClick={() => void command(window.deki.respondToApproval(
                          request.id,
                          "deny",
                          detail.task.id,
                        ))}>{props.zh ? "拒绝" : "Deny"}</button>
                        <button onClick={() => void command(window.deki.respondToApproval(
                          request.id,
                          "allow_once",
                          detail.task.id,
                        ))}>{props.zh ? "允许一次" : "Allow once"}</button>
                        <button onClick={() => void command(window.deki.respondToApproval(
                          request.id,
                          "allow_session",
                          detail.task.id,
                        ))}>{props.zh ? "当前会话允许" : "Allow for session"}</button>
                        <button className="primary" onClick={() => void command(
                          window.deki.respondToApproval(
                            request.id,
                            "allow_project",
                            detail.task.id,
                          ),
                        )}>{props.zh ? "当前项目允许" : "Allow for project"}</button>
                      </div>
                    </>
                  ) : (
                    <>
                      {Array.isArray(request.payload.options) && (
                        <div className="task-input-options">
                          {(request.payload.options as string[]).map((option) => (
                            <button
                              key={option}
                              onClick={() => setInputValues((current) => ({
                                ...current,
                                [request.id]: option,
                              }))}
                            >{option}</button>
                          ))}
                        </div>
                      )}
                      <textarea
                        value={inputValues[request.id] ?? ""}
                        onChange={(event) => setInputValues((current) => ({
                          ...current,
                          [request.id]: event.target.value,
                        }))}
                        placeholder={props.zh ? "输入回答" : "Type your answer"}
                      />
                      <button
                        className="primary"
                        disabled={!inputValues[request.id]?.trim()}
                        onClick={() => void command(window.deki.respondToTaskInput(
                          detail.task.id,
                          request.id,
                          inputValues[request.id] ?? "",
                        ))}
                      >{props.zh ? "提交回答" : "Submit answer"}</button>
                    </>
                  )}
                </section>
              ))}

              {detail.runs.length > 0 && (
                <section className="task-detail-section">
                  <h3>{props.zh ? "运行记录" : "Runs"}</h3>
                  <div className="task-run-list">
                    {[...detail.runs].reverse().map((run) => (
                      <article key={run.id}>
                        <strong>Attempt {run.attempt}</strong>
                        <span>{run.status}</span>
                        <time>{formatDuration(run.startedAt, run.finishedAt, props.zh)}</time>
                        {run.error && <p className="error">{run.error}</p>}
                        {run.resultSummary && (
                          <div className="task-result markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {run.resultSummary}
                            </ReactMarkdown>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {detail.artifacts.length > 0 && (
                <section className="task-detail-section">
                  <h3>{props.zh ? "产物" : "Artifacts"}</h3>
                  {detail.artifacts.map((artifact) => (
                    <details className="task-artifact" key={artifact.id}>
                      <summary>{artifact.title} · {artifact.kind}</summary>
                      {artifact.content && <pre>{artifact.content}</pre>}
                    </details>
                  ))}
                </section>
              )}

              <section className="task-detail-section">
                <h3>{props.zh ? "事件" : "Events"}</h3>
                <div className="task-event-list">
                  {[...detail.events].reverse().slice(0, 30).map((event) => (
                    <div key={event.eventId}>
                      <span>{event.type}</span>
                      <time>{new Date(event.timestamp).toLocaleString()}</time>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="task-empty">
              {props.zh ? "选择一个任务查看详情" : "Select a task to view details"}
            </div>
          )}
        </div>
      </div>
      {error && <p className="error task-center-error">{error}</p>}
    </section>
  );
}

function TaskActions(props: {
  detail: TaskDetail;
  zh: boolean;
  onCommand(operation: Promise<{ ok: boolean; error?: string | undefined }>): Promise<void>;
  onOpen(): Promise<void>;
}) {
  const { task } = props.detail;
  return (
    <div className="task-detail-actions">
      {task.sessionId && (
        <button onClick={() => void props.onOpen()}>
          {props.zh ? "打开会话" : "Open chat"}
        </button>
      )}
      {task.status === "queued" && (
        <button onClick={() => void props.onCommand(window.deki.pauseTask(task.id))}>
          {props.zh ? "暂停" : "Pause"}
        </button>
      )}
      {["running", "waiting_approval", "waiting_user"].includes(task.status) && (
        <button onClick={() => void props.onCommand(window.deki.pauseTask(task.id))}>
          {props.zh ? "暂停" : "Pause"}
        </button>
      )}
      {task.status === "paused" && (
        <button className="primary" onClick={() => void props.onCommand(
          window.deki.resumeTask(task.id),
        )}>{props.zh ? "恢复" : "Resume"}</button>
      )}
      {task.status === "interrupted" && (
        <button className="primary" onClick={() => void props.onCommand(
          window.deki.resumeTask(task.id),
        )}>{props.zh ? "恢复" : "Resume"}</button>
      )}
      {task.status === "failed" && (
        <button className="primary" onClick={() => void props.onCommand(
          window.deki.retryTask(task.id),
        )}>{props.zh ? "重试" : "Retry"}</button>
      )}
      {["queued", "running", "waiting_approval", "waiting_user", "paused"].includes(
        task.status,
      ) && (
        <button className="danger-text" onClick={() => void props.onCommand(
          window.deki.cancelTask(task.id),
        )}>{props.zh ? "取消" : "Cancel"}</button>
      )}
    </div>
  );
}

function workspaceName(path: string | undefined, zh: boolean): string {
  if (!path) return zh ? "默认工作区" : "General";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

function relativeTime(value: string, zh: boolean): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return zh ? "刚刚" : "now";
  if (seconds < 3600) return zh ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return zh ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 3600)}h`;
  return new Date(value).toLocaleDateString();
}

function formatDuration(
  start: string | undefined,
  end: string | undefined,
  zh: boolean,
): string {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor(
    ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000,
  ));
  if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return zh ? `${minutes} 分钟` : `${minutes}m`;
}
