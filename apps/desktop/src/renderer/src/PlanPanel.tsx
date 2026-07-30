import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  PlanDetail,
  PlanRevisionRecord,
  PlanStep,
  PlanStepState,
  SessionHistoryState,
  TaskDetail,
  TaskSummary,
  WorkerResult,
} from "@deki-ai/shared";

interface PlanPanelProps {
  detail: PlanDetail;
  zh: boolean;
  showReasoning: boolean;
  onChanged(): Promise<void>;
  onForegroundTask(taskId: string | undefined): void;
}

export function PlanPanel(props: PlanPanelProps) {
  const { detail, zh } = props;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [beforeRevision, setBeforeRevision] = useState(
    Math.max(1, detail.plan.currentRevision - 1),
  );
  const [afterRevision, setAfterRevision] = useState(detail.plan.currentRevision);
  const [stepWorkers, setStepWorkers] = useState<Array<{
    summary: TaskSummary;
    result?: WorkerResult;
    detail?: TaskDetail;
    history?: SessionHistoryState;
  }>>([]);
  const [executionDetail, setExecutionDetail] = useState<TaskDetail | null>(null);
  const [planningDetail, setPlanningDetail] = useState<TaskDetail | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const revision = detail.revisions.find(
    (candidate) => candidate.revision === detail.plan.currentRevision,
  );
  const planningComplete = detail.planningTask?.status === "succeeded";
  const planningBusy = detail.planningTask
    ? ["queued", "running", "waiting_approval", "waiting_user", "paused"].includes(
        detail.planningTask.status,
      )
    : false;
  const states = useMemo(() => new Map(
    detail.stepStates
      .filter((state) => state.revision === detail.plan.currentRevision)
      .map((state) => [state.stepId, state]),
  ), [detail]);
  useEffect(() => {
    setAfterRevision(detail.plan.currentRevision);
    setBeforeRevision(Math.max(1, detail.plan.currentRevision - 1));
  }, [detail.plan.id, detail.plan.currentRevision]);
  useEffect(() => {
    let cancelled = false;
    const refreshWorkers = async () => {
      if (!detail.plan.executionTaskId) {
        if (!cancelled) {
          setStepWorkers([]);
          setExecutionDetail(null);
        }
        return;
      }
      const execution = await window.deki.getTask(detail.plan.executionTaskId);
      const workers = await Promise.all((execution?.children ?? []).map(async (summary) => {
        const worker = await window.deki.getTask(summary.task.id);
        return {
          summary,
          ...(worker?.workerResult ? { result: worker.workerResult } : {}),
          ...(worker ? { detail: worker } : {}),
          ...(worker?.nodeSessionHistory ? { history: worker.nodeSessionHistory } : {}),
        };
      }));
      if (!cancelled) {
        setExecutionDetail(execution);
        setStepWorkers(workers);
      }
    };
    void refreshWorkers();
    const unsubscribe = window.deki.subscribeTaskEvents(() => {
      void refreshWorkers();
    });
    const unsubscribeAgent = window.deki.subscribeAgentEvents((event) => {
      if (
        event.taskId
        && workersForPlan(detail).has(event.taskId)
        && (
          event.type === "message.completed"
          || event.type === "tool.completed"
          || event.type === "run.completed"
          || event.type === "run.failed"
        )
      ) void refreshWorkers();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeAgent();
    };
  }, [detail.plan.executionTaskId, detail.executionGraph]);
  useEffect(() => {
    let cancelled = false;
    const refreshPlanning = async () => {
      if (!detail.planningTask) {
        if (!cancelled) setPlanningDetail(null);
        return;
      }
      const planning = await window.deki.getTask(detail.planningTask.id);
      if (!cancelled) setPlanningDetail(planning);
    };
    void refreshPlanning();
    const unsubscribe = window.deki.subscribeTaskEvents((event) => {
      if (event.taskId === detail.planningTask?.id) void refreshPlanning();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [detail.planningTask?.id]);
  const revisionDelta = useMemo(() => {
    const before = detail.revisions.find(
      (candidate) => candidate.revision === beforeRevision,
    );
    const after = detail.revisions.find(
      (candidate) => candidate.revision === afterRevision,
    );
    return before && after && before.revision !== after.revision
      ? diffPlanRevisions(before, after)
      : undefined;
  }, [afterRevision, beforeRevision, detail.revisions]);
  const pendingRequests = [
    ...(executionDetail ? [{ taskId: executionDetail.task.id, requests: executionDetail.requests }] : []),
    ...stepWorkers.flatMap((worker) => worker.detail
      ? [{ taskId: worker.detail.task.id, requests: worker.detail.requests }]
      : []),
  ].flatMap(({ taskId, requests }) => requests
    .filter((request) => request.status === "pending")
    .map((request) => ({ taskId, request })));

  async function run(operation: Promise<{ ok: boolean; error?: string | undefined }>) {
    setBusy(true);
    try {
      const result = await operation;
      if (!result.ok) throw new Error(result.error ?? (zh ? "操作失败" : "Action failed"));
      setError(undefined);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    try {
      const result = await window.deki.approvePlan(
        detail.plan.id,
        detail.plan.currentRevision,
      );
      if (!result.ok || !result.task) {
        throw new Error(result.error ?? (zh ? "无法执行计划" : "Unable to run plan"));
      }
      props.onForegroundTask(result.task.id);
      setError(undefined);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function continueExecution(
    operation: Promise<{ ok: boolean; error?: string | undefined }>,
  ) {
    setBusy(true);
    try {
      const result = await operation;
      if (!result.ok) {
        setError(result.error ?? (zh ? "操作失败" : "Action failed"));
        return;
      }
      if (detail.plan.executionTaskId) props.onForegroundTask(detail.plan.executionTaskId);
      setError(undefined);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function pauseExecution() {
    if (!detail.plan.executionTaskId) return;
    setBusy(true);
    try {
      const result = await window.deki.pauseTask(detail.plan.executionTaskId);
      if (!result.ok) {
        setError(result.error ?? (zh ? "无法暂停计划" : "Unable to pause plan"));
        return;
      }
      props.onForegroundTask(undefined);
      setError(undefined);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function requestRevision() {
    const feedback = window.prompt(
      zh ? "说明需要调整的内容" : "Describe the changes you need",
    );
    if (feedback?.trim()) {
      void submitPlanTask(window.deki.requestPlanRevision(
        detail.plan.id,
        feedback.trim(),
        { mode: "foreground" },
      ));
    }
  }

  function requestReplan() {
    const reason = window.prompt(
      zh ? "说明执行偏离或假设失效的原因" : "Describe why execution needs replanning",
      detail.plan.replanReason ?? "",
    );
    if (!reason?.trim()) return;
    const affected = [...states.values()]
      .filter((state) => state.status === "running" || state.status === "blocked")
      .map((state) => state.stepId);
    void submitPlanTask(
      window.deki.requestPlanReplan(detail.plan.id, reason.trim(), affected),
    );
  }

  async function submitPlanTask(
    operation: Promise<{
      ok: boolean;
      task?: TaskSummary["task"] | undefined;
      error?: string | undefined;
    }>,
  ) {
    setBusy(true);
    try {
      const result = await operation;
      if (!result.ok || !result.task) {
        throw new Error(result.error ?? (zh ? "无法启动规划任务" : "Unable to start planning"));
      }
      props.onForegroundTask(result.task.id);
      setError(undefined);
      await props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="plan-panel" data-testid="plan-panel">
      <header className="plan-panel-heading">
        <div>
          <span className={`plan-status ${detail.plan.status}`}>
            {planStatusLabel(detail.plan.status, zh)}
          </span>
          <strong title={detail.plan.title}>{detail.plan.title}</strong>
          <small className="plan-version">v{detail.plan.currentRevision}</small>
        </div>
        <span className="plan-progress">
          {[...states.values()].filter((state) =>
            state.status === "completed" || state.status === "skipped"
          ).length}/{revision?.steps.length ?? 0}
        </span>
      </header>

      <p className="plan-goal">{detail.plan.goal}</p>
      {planningDetail?.nodeSessionHistory && (
        <details className="plan-context plan-planning-history">
          <summary>{zh ? "规划节点输出" : "Planning node output"}</summary>
          <PlanSessionHistory
            history={planningDetail.nodeSessionHistory}
            showReasoning={props.showReasoning}
            zh={zh}
          />
        </details>
      )}
      {detail.executionTask?.status === "failed" && (
        <div className="plan-execution-alert" role="alert">
          <strong>{zh ? "计划执行失败" : "Plan execution failed"}</strong>
          <p>
            {zh
              ? "当前执行已停止。请打开任务查看错误详情，修复后可重试执行。"
              : "Execution has stopped. Open the task for error details, then retry after fixing the cause."}
          </p>
        </div>
      )}
      {detail.plan.replanReason && (
        <div className="plan-replan-reason">
          <strong>{zh ? "重新规划原因" : "Replan reason"}</strong>
          <p>{detail.plan.replanReason}</p>
          {detail.plan.affectedStepIds.length > 0 && (
            <small>
              {zh ? "受影响步骤" : "Affected steps"}: {detail.plan.affectedStepIds.join(", ")}
            </small>
          )}
          {detail.plan.replanEvidence.map((item) => <p key={item}>• {item}</p>)}
        </div>
      )}

      {revision && (
        <>
          {(revision.assumptions.length > 0 || revision.constraints.length > 0) && (
            <details className="plan-context">
              <summary>{zh ? "假设与约束" : "Assumptions & constraints"}</summary>
              {revision.assumptions.map((item) => <p key={`a-${item}`}>• {item}</p>)}
              {revision.constraints.map((item) => <p key={`c-${item}`}>◇ {item}</p>)}
            </details>
          )}
          <div className="plan-step-list">
            {revision.steps.map((step, index) => (
              <PlanStepRow
                key={step.id}
                index={index}
                step={step}
                {...(states.get(step.id) ? { state: states.get(step.id)! } : {})}
                workers={stepWorkers.filter((worker) =>
                  worker.summary.workerPlanStepId === step.id)}
                executionFailed={detail.executionTask?.status === "failed"}
                showReasoning={props.showReasoning}
                zh={zh}
              />
            ))}
          </div>
          {detail.executionGraph && (
            <details className="plan-context" open>
              <summary>
                {zh ? "DAG 执行图" : "DAG execution graph"}
                {" · "}{detail.executionGraph.nodes.filter((node) =>
                  node.status === "succeeded").length}/{detail.executionGraph.nodes.length}
              </summary>
              <p>
                {zh ? "预算" : "Budget"}:{" "}
                {detail.executionGraph.usage.inputTokens}
                +{detail.executionGraph.reserved.inputTokens}
                /{detail.executionGraph.budget.maxInputTokens} in ·{" "}
                {detail.executionGraph.usage.outputTokens}
                +{detail.executionGraph.reserved.outputTokens}
                /{detail.executionGraph.budget.maxOutputTokens} out ·{" "}
                {detail.executionGraph.usage.toolCalls}
                +{detail.executionGraph.reserved.toolCalls}
                /{detail.executionGraph.budget.maxToolCalls} tools
              </p>
              {detail.executionGraph.blockedReason && (
                <p className="error">
                  {zh ? "阻塞原因" : "Blocked by"}: {detail.executionGraph.blockedReason}
                </p>
              )}
              <div className="plan-step-list">
                {detail.executionGraph.nodes.map((node) => (
                  <div className={`plan-step-row ${node.status}`} key={node.id}>
                    <div className="plan-step-index">
                      {node.syntheticKind === "reviewer"
                        ? "R"
                        : node.syntheticKind === "integrator" ? "I" : "•"}
                    </div>
                    <div className="plan-step-content">
                      <strong>{node.title}</strong>
                      <small>
                        {node.profile} · {node.status} · {node.budgetTier ?? "normal"}
                        {node.attempt > 0 ? ` · #${node.attempt}` : ""}
                      </small>
                      {(node.modelProvider || node.modelId) && (
                        <small>{[node.modelProvider, node.modelId].filter(Boolean).join("/")}</small>
                      )}
                      {node.routeReason && <small>{node.routeReason}</small>}
                      {node.reservation && (
                        <small>
                          {zh ? "预留" : "Reserved"}: {node.reservation.inputTokens} in ·{" "}
                          {node.reservation.outputTokens} out · {node.reservation.toolCalls} tools
                        </small>
                      )}
                      {node.dependencies.length > 0 && (
                        <small>{zh ? "依赖" : "Depends on"}: {node.dependencies
                          .map((id) => detail.executionGraph!.nodes.find((item) =>
                            item.id === id)?.title ?? id.slice(0, 8)).join(", ")}</small>
                      )}
                      {node.reason && <small className="error">{node.reason}</small>}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      <div className="plan-panel-actions">
        {detail.plan.status === "ready" && (
          <>
            <button
              className="primary"
              disabled={busy || !planningComplete}
              onClick={() => void approve()}
            >
              {!planningComplete
                ? zh ? "正在完成规划" : "Finishing plan"
                : zh ? "批准并执行" : "Approve & run"}
            </button>
            <button disabled={busy || planningBusy} onClick={requestRevision}>
              {zh ? "要求修改" : "Request changes"}
            </button>
          </>
        )}
        {detail.plan.status === "draft" && (
          <button className="primary" disabled={busy} onClick={requestRevision}>
            {zh ? "生成修订" : "Generate revision"}
          </button>
        )}
        {(detail.plan.status === "executing"
          || detail.plan.status === "blocked"
          || (detail.plan.status === "approved"
            && detail.executionTask
            && ["paused", "interrupted", "failed"].includes(detail.executionTask.status))
          || [...states.values()].some((state) => state.status === "blocked")) && (
          <button disabled={busy} onClick={requestReplan}>
            {zh ? "重新规划" : "Replan"}
          </button>
        )}
        {detail.executionTask
          && ["running", "waiting_approval", "waiting_user"].includes(
            detail.executionTask.status,
          ) && (
          <button
            disabled={busy}
            onClick={() => void pauseExecution()}
          >
            {zh ? "暂停执行" : "Pause"}
          </button>
        )}
        {detail.plan.status === "approved"
          && detail.executionTask
          && ["paused", "interrupted"].includes(detail.executionTask.status) && (
          <button
            disabled={busy}
            onClick={() => void continueExecution(
              window.deki.resumeTask(detail.executionTask!.id),
            )}
          >
            {zh ? "恢复执行" : "Resume"}
          </button>
        )}
        {detail.plan.status === "approved" && detail.executionTask?.status === "failed" && (
          <button
            disabled={busy}
            onClick={() => void continueExecution(
              window.deki.retryTask(detail.executionTask!.id),
            )}
          >
            {zh ? "重试执行" : "Retry"}
          </button>
        )}
        {detail.plan.status !== "completed" && detail.plan.status !== "abandoned" && (
          <button
            className="danger-text"
            disabled={busy}
            onClick={() => {
              if (window.confirm(zh ? "确定放弃这个计划？" : "Abandon this plan?")) {
                void run(window.deki.abandonPlan(detail.plan.id));
              }
            }}
          >{zh ? "放弃" : "Abandon"}</button>
        )}
      </div>

      {pendingRequests.length > 0 && (
        <section className="plan-context plan-pending-requests">
          <strong>{zh ? "需要你的处理" : "Needs your attention"}</strong>
          {pendingRequests.map(({ taskId, request }) => (
              <div className="plan-request" key={request.id}>
                <strong>{request.title}</strong>
                {request.description && <p>{request.description}</p>}
                {request.kind === "integration_approval" ? (
                  <div className="plan-panel-actions">
                    <button onClick={() => void run(window.deki.respondToIntegration(
                      taskId,
                      request.id,
                      "cancel",
                    ))}>{zh ? "取消计划" : "Cancel"}</button>
                    <button onClick={() => void run(window.deki.respondToIntegration(
                      taskId,
                      request.id,
                      "artifact_only",
                    ))}>{zh ? "仅保留产物" : "Keep artifacts"}</button>
                    <button className="primary" onClick={() => void run(
                      window.deki.respondToIntegration(
                        taskId,
                        request.id,
                        "apply",
                      ),
                    )}>{zh ? "应用到工作区" : "Apply to workspace"}</button>
                  </div>
                ) : request.kind === "approval" ? (
                  <>
                    <pre>{formatCompactValue(request.payload)}</pre>
                    <div className="plan-panel-actions">
                      <button onClick={() => void run(window.deki.respondToApproval(
                        request.id,
                        "deny",
                        taskId,
                      ))}>{zh ? "拒绝" : "Deny"}</button>
                      <button onClick={() => void run(window.deki.respondToApproval(
                        request.id,
                        "allow_once",
                        taskId,
                      ))}>{zh ? "允许一次" : "Allow once"}</button>
                      <button onClick={() => void run(window.deki.respondToApproval(
                        request.id,
                        "allow_session",
                        taskId,
                      ))}>{zh ? "当前会话允许" : "Allow for session"}</button>
                      <button className="primary" onClick={() => void run(
                        window.deki.respondToApproval(
                          request.id,
                          "allow_project",
                          taskId,
                        ),
                      )}>{zh ? "当前项目允许" : "Allow for project"}</button>
                    </div>
                  </>
                ) : (
                  <>
                    {Array.isArray(request.payload.options) && (
                      <div className="plan-request-options">
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
                    <div className="plan-request-input">
                      <textarea
                      value={inputValues[request.id] ?? ""}
                      onChange={(event) => setInputValues((current) => ({
                        ...current,
                        [request.id]: event.target.value,
                      }))}
                      />
                      <button
                        className="primary"
                        disabled={!(inputValues[request.id] ?? "").trim()}
                        onClick={() => void run(window.deki.respondToTaskInput(
                          taskId,
                          request.id,
                          (inputValues[request.id] ?? "").trim(),
                        ))}
                      >{zh ? "提交" : "Submit"}</button>
                    </div>
                  </>
                )}
              </div>
            ))}
        </section>
      )}

      {detail.revisions.length > 1 && (
        <details className="plan-revisions">
          <summary>{zh ? "版本历史" : "Revision history"} · {detail.revisions.length}</summary>
          <div className="plan-revision-selectors">
            <label>
              {zh ? "基准版本" : "Base"}
              <select
                value={beforeRevision}
                onChange={(event) => setBeforeRevision(Number(event.target.value))}
              >
                {detail.revisions.map((item) => (
                  <option key={item.revision} value={item.revision}>v{item.revision}</option>
                ))}
              </select>
            </label>
            <span>→</span>
            <label>
              {zh ? "对比版本" : "Compare"}
              <select
                value={afterRevision}
                onChange={(event) => setAfterRevision(Number(event.target.value))}
              >
                {detail.revisions.map((item) => (
                  <option key={item.revision} value={item.revision}>v{item.revision}</option>
                ))}
              </select>
            </label>
          </div>
          {revisionDelta && (
            <div className="plan-revision-diff">
              <p>
                +{revisionDelta.added.length} · ~{revisionDelta.changed.length}
                {" "}· -{revisionDelta.removed.length}
                {revisionDelta.reordered.length > 0
                  ? ` · ${zh ? "重排" : "reordered"} ${revisionDelta.reordered.length}`
                  : ""}
              </p>
              {revisionDelta.assumptions.added.map((item) => (
                <small key={`aa-${item}`}>+ {zh ? "假设" : "assumption"}: {item}</small>
              ))}
              {revisionDelta.assumptions.removed.map((item) => (
                <small key={`ar-${item}`}>− {zh ? "假设" : "assumption"}: {item}</small>
              ))}
              {revisionDelta.constraints.added.map((item) => (
                <small key={`ca-${item}`}>+ {zh ? "约束" : "constraint"}: {item}</small>
              ))}
              {revisionDelta.constraints.removed.map((item) => (
                <small key={`cr-${item}`}>− {zh ? "约束" : "constraint"}: {item}</small>
              ))}
              {revisionDelta.added.map((step) => (
                <small key={`add-${step.id}`}>+ {zh ? "步骤" : "step"}: {step.title}</small>
              ))}
              {revisionDelta.removed.map((step) => (
                <small key={`remove-${step.id}`}>− {zh ? "步骤" : "step"}: {step.title}</small>
              ))}
              {revisionDelta.reordered.map(({ step, before, after }) => (
                <small key={`move-${step.id}`}>
                  ↕ {step.title}: {before + 1} → {after + 1}
                </small>
              ))}
              {revisionDelta.changed.map(({ before, after, fields }) => (
                <div className="plan-revision-field-diff" key={after.id}>
                  <strong>~ {after.title}</strong>
                  {fields.map((field) => (
                    <small key={field}>
                      {field}: {formatPlanField(before[field])} → {formatPlanField(after[field])}
                    </small>
                  ))}
                </div>
              ))}
            </div>
          )}
          {[...detail.revisions].reverse().map((item) => (
            <div key={item.revision}>
              <strong>v{item.revision}</strong>
              <span>{item.steps.length} {zh ? "步" : "steps"}</span>
              {item.feedback && <p>{item.feedback}</p>}
            </div>
          ))}
        </details>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function diffPlanRevisions(
  beforeRevision: PlanRevisionRecord,
  afterRevision: PlanRevisionRecord,
) {
  const before = new Map(beforeRevision.steps.map((step) => [step.id, step]));
  const after = new Map(afterRevision.steps.map((step) => [step.id, step]));
  const beforeOrder = new Map(beforeRevision.steps.map((step, index) => [step.id, index]));
  const changed = afterRevision.steps.flatMap((step) => {
    const old = before.get(step.id);
    if (!old) return [];
    const fields = changedStepFields(old, step);
    return fields.length > 0 ? [{ before: old, after: step, fields }] : [];
  });
  return {
    added: afterRevision.steps.filter((step) => !before.has(step.id)),
    removed: beforeRevision.steps.filter((step) => !after.has(step.id)),
    changed,
    reordered: afterRevision.steps.flatMap((step, index) => {
      const oldIndex = beforeOrder.get(step.id);
      return oldIndex !== undefined && oldIndex !== index
        ? [{ step, before: oldIndex, after: index }]
        : [];
    }),
    assumptions: setDiff(beforeRevision.assumptions, afterRevision.assumptions),
    constraints: setDiff(beforeRevision.constraints, afterRevision.constraints),
  };
}

function formatPlanField(value: PlanStep[keyof PlanStep]): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "—";
  if (value === undefined || value === "") return "—";
  return String(value);
}

function changedStepFields(before: PlanStep, after: PlanStep): Array<keyof PlanStep> {
  const fields: Array<keyof PlanStep> = [
    "title",
    "description",
    "dependencies",
    "candidateFiles",
    "validation",
    "risk",
    "parallelizable",
    "assignedProfile",
  ];
  return fields.filter((field) =>
    JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

function setDiff(before: string[], after: string[]) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((item) => !beforeSet.has(item)),
    removed: before.filter((item) => !afterSet.has(item)),
  };
}

function PlanStepRow(props: {
  index: number;
  step: NonNullable<PlanDetail["revisions"][number]>["steps"][number];
  state?: PlanStepState;
  workers: Array<{
    summary: TaskSummary;
    result?: WorkerResult;
    detail?: TaskDetail;
    history?: SessionHistoryState;
  }>;
  executionFailed: boolean;
  showReasoning: boolean;
  zh: boolean;
}) {
  const persistedStatus = props.state?.status ?? "pending";
  const status = effectivePlanStepStatus(persistedStatus, props.executionFailed);
  return (
    <details className={`plan-step ${status}`} open={status === "running" || status === "blocked"}>
      <summary>
        <span className="plan-step-index">{props.index + 1}</span>
        <span>
          <strong>{props.step.title}</strong>
          <small>{planStepStatusLabel(status, props.zh)} · {props.step.risk}</small>
        </span>
      </summary>
      <p>{props.step.description}</p>
      {props.step.dependencies.length > 0 && (
        <small>{props.zh ? "依赖" : "Depends on"}: {props.step.dependencies.join(", ")}</small>
      )}
      {props.step.candidateFiles.length > 0 && (
        <code>{props.step.candidateFiles.join("\n")}</code>
      )}
      {props.step.validation.map((item) => <p key={item}>✓ {item}</p>)}
      {props.state?.summary && <p>{props.state.summary}</p>}
      {props.state?.reason && <p className="error">{props.state.reason}</p>}
      {!props.state?.reason && persistedStatus === "running" && props.executionFailed && (
        <p className="error">
          {props.zh ? "计划执行任务已失败，此步骤已停止。" : "The plan execution failed; this step has stopped."}
        </p>
      )}
      {props.workers.length > 0 && (
        <div className="plan-step-workers">
          <strong>{props.zh ? "关联 Worker" : "Workers"}</strong>
          {props.workers.map(({ summary, result, detail, history }) => (
            <details className="plan-worker-detail" key={summary.task.id}>
              <summary>
                {summary.task.assignedProfile ?? "Worker"}
                {" · "}
                {summary.task.status}
                {result?.summary ? ` · ${result.summary}` : ""}
              </summary>
              {history && (
                <PlanSessionHistory
                  history={history}
                  showReasoning={props.showReasoning}
                  zh={props.zh}
                />
              )}
              {result?.findings.map((finding, index) => (
                <div className="plan-worker-finding" key={`${summary.task.id}-finding-${index}`}>
                  <strong>{finding.claim}</strong>
                  <small>{props.zh ? "置信度" : "Confidence"}: {finding.confidence}</small>
                  {finding.evidence.map((evidence, evidenceIndex) => (
                    <pre key={`${summary.task.id}-evidence-${evidenceIndex}`}>
                      {formatCompactValue(evidence)}
                    </pre>
                  ))}
                </div>
              ))}
              {result?.review && (
                <div className="plan-worker-result">
                  <strong>
                    {props.zh ? "审查结论" : "Review verdict"}: {result.review.verdict}
                  </strong>
                  {result.review.findings.map((finding, index) => (
                    <div key={`${summary.task.id}-review-${index}`}>
                      <p>{finding.severity} · {finding.summary}</p>
                      {finding.evidence.map((evidence, evidenceIndex) => (
                        <pre key={`${summary.task.id}-review-evidence-${evidenceIndex}`}>
                          {formatCompactValue(evidence)}
                        </pre>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {(result?.risks.length || result?.unresolved.length
                || result?.recommendedNextActions.length) ? (
                <details className="plan-worker-result">
                  <summary>{props.zh ? "风险与后续行动" : "Risks and next actions"}</summary>
                  {result.risks.map((item) => <p key={`risk-${item}`}>⚠ {item}</p>)}
                  {result.unresolved.map((item) => <p key={`open-${item}`}>? {item}</p>)}
                  {result.recommendedNextActions.map((item) => (
                    <p key={`next-${item}`}>→ {item}</p>
                  ))}
                </details>
              ) : null}
              {detail?.implementationResult && (
                <div className="plan-worker-result">
                  <strong>{props.zh ? "实现结果" : "Implementation result"}</strong>
                  <p>{detail.implementationResult.changedFiles.join(", ") || "—"}</p>
                  {detail.implementationResult.validationArtifactIds.map((id) => (
                    <small key={id}>{props.zh ? "验证产物" : "Validation artifact"}: {id}</small>
                  ))}
                </div>
              )}
              {detail?.artifacts.map((artifact) => (
                <details key={artifact.id}>
                  <summary>{artifact.title} · {artifact.kind}</summary>
                  {artifact.content && <pre>{artifact.content.slice(0, 100_000)}</pre>}
                  {!artifact.content && artifact.uri && <code>{artifact.uri}</code>}
                </details>
              ))}
              {detail?.runs.at(-1)?.error && (
                <p className="error">{detail.runs.at(-1)!.error}</p>
              )}
            </details>
          ))}
        </div>
      )}
    </details>
  );
}

function PlanSessionHistory(props: {
  history: SessionHistoryState;
  showReasoning: boolean;
  zh: boolean;
}) {
  return (
    <div className="plan-session-history">
      {props.history.messages.filter((message) => message.role === "assistant")
        .map((message) => (
          <div className="plan-worker-message" key={message.id}>
            {props.showReasoning && message.reasoning && (
              <details>
                <summary>{props.zh ? "推理摘要" : "Reasoning summary"}</summary>
                <pre>{message.reasoning}</pre>
              </details>
            )}
            {message.content && (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            )}
          </div>
        ))}
      {props.history.events.filter((event) =>
        event.type === "tool.started"
        || event.type === "tool.completed").map((event) => (
        <pre
          className={`plan-worker-event ${
            event.type === "tool.completed" && event.isError ? "error" : ""
          }`}
          key={event.eventId}
        >
          {event.type} · {"toolName" in event ? event.toolName : ""}
          {"result" in event && event.result !== undefined
            ? `\n${formatCompactValue(event.result)}`
            : ""}
        </pre>
      ))}
    </div>
  );
}

function workersForPlan(detail: PlanDetail): Set<string> {
  return new Set(detail.executionGraph?.nodes.flatMap((node) =>
    node.taskId ? [node.taskId] : []) ?? []);
}

function formatCompactValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 20_000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 20_000);
  } catch {
    return String(value).slice(0, 20_000);
  }
}

export function effectivePlanStepStatus(
  status: PlanStepState["status"],
  executionFailed: boolean,
): PlanStepState["status"] {
  return executionFailed && status === "running" ? "blocked" : status;
}

function planStatusLabel(status: PlanDetail["plan"]["status"], zh: boolean): string {
  const labels = {
    draft: ["草稿", "Draft"],
    ready: ["待审阅", "Ready"],
    approved: ["已批准", "Approved"],
    executing: ["执行中", "Executing"],
    blocked: ["已阻塞", "Blocked"],
    completed: ["已完成", "Completed"],
    abandoned: ["已放弃", "Abandoned"],
  } as const;
  return labels[status][zh ? 0 : 1];
}

function planStepStatusLabel(status: PlanStepState["status"], zh: boolean): string {
  const labels = {
    pending: ["待执行", "Pending"],
    running: ["执行中", "Running"],
    completed: ["已完成", "Completed"],
    blocked: ["受阻", "Blocked"],
    skipped: ["已跳过", "Skipped"],
  } as const;
  return labels[status][zh ? 0 : 1];
}
