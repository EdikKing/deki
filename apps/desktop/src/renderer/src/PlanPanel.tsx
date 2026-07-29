import { useEffect, useMemo, useState } from "react";
import type {
  PlanDetail,
  PlanRevisionRecord,
  PlanStep,
  PlanStepState,
  TaskSummary,
  WorkerResult,
} from "@deki-ai/shared";

interface PlanPanelProps {
  detail: PlanDetail;
  zh: boolean;
  onChanged(): Promise<void>;
  onOpenTask(taskId: string): void;
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
  }>>([]);
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
        if (!cancelled) setStepWorkers([]);
        return;
      }
      const execution = await window.deki.getTask(detail.plan.executionTaskId);
      const workers = await Promise.all((execution?.children ?? []).map(async (summary) => {
        const worker = await window.deki.getTask(summary.task.id);
        return {
          summary,
          ...(worker?.workerResult ? { result: worker.workerResult } : {}),
        };
      }));
      if (!cancelled) setStepWorkers(workers);
    };
    void refreshWorkers();
    const unsubscribe = window.deki.subscribeTaskEvents(() => {
      void refreshWorkers();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [detail.plan.executionTaskId]);
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

  function requestRevision() {
    const feedback = window.prompt(
      zh ? "说明需要调整的内容" : "Describe the changes you need",
    );
    if (feedback?.trim()) {
      void run(window.deki.requestPlanRevision(
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
    void run(window.deki.requestPlanReplan(detail.plan.id, reason.trim(), affected));
  }

  return (
    <section className="plan-panel" data-testid="plan-panel">
      <header className="plan-panel-heading">
        <div>
          <span className={`plan-status ${detail.plan.status}`}>
            {planStatusLabel(detail.plan.status, zh)}
          </span>
          <strong>{zh ? `计划 v${detail.plan.currentRevision}` : `Plan v${detail.plan.currentRevision}`}</strong>
        </div>
        <span className="plan-progress">
          {[...states.values()].filter((state) =>
            state.status === "completed" || state.status === "skipped"
          ).length}/{revision?.steps.length ?? 0}
        </span>
      </header>

      <p className="plan-goal">{detail.plan.goal}</p>
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
              onClick={() => void run(window.deki.approvePlan(
                detail.plan.id,
                detail.plan.currentRevision,
              ))}
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
        {detail.plan.executionTaskId && (
          <button onClick={() => props.onOpenTask(detail.plan.executionTaskId!)}>
            {zh ? "打开任务" : "Open task"}
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
        <button
          disabled={busy}
          onClick={() => void run(window.deki.openPlanSession(detail.plan.id))}
        >
          {zh ? "打开会话" : "Open chat"}
        </button>
        {detail.executionTask
          && ["running", "waiting_approval", "waiting_user"].includes(
            detail.executionTask.status,
          ) && (
          <button
            disabled={busy}
            onClick={() => void run(window.deki.pauseTask(detail.executionTask!.id))}
          >
            {zh ? "暂停执行" : "Pause"}
          </button>
        )}
        {detail.plan.status === "approved"
          && detail.executionTask
          && ["paused", "interrupted"].includes(detail.executionTask.status) && (
          <button
            disabled={busy}
            onClick={() => void run(window.deki.resumeTask(detail.executionTask!.id))}
          >
            {zh ? "恢复执行" : "Resume"}
          </button>
        )}
        {detail.plan.status === "approved" && detail.executionTask?.status === "failed" && (
          <button
            disabled={busy}
            onClick={() => void run(window.deki.retryTask(detail.executionTask!.id))}
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
  workers: Array<{ summary: TaskSummary; result?: WorkerResult }>;
  executionFailed: boolean;
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
          {props.workers.map(({ summary, result }) => (
            <p key={summary.task.id}>
              {summary.task.assignedProfile ?? "Worker"}
              {" · "}
              {summary.task.status}
              {result?.summary ? ` · ${result.summary}` : ""}
            </p>
          ))}
        </div>
      )}
    </details>
  );
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
