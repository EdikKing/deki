import { useMemo, useState } from "react";
import type { PlanDetail, PlanStepState } from "@deki-ai/shared";

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
  const revision = detail.revisions.find(
    (candidate) => candidate.revision === detail.plan.currentRevision,
  );
  const states = useMemo(() => new Map(
    detail.stepStates
      .filter((state) => state.revision === detail.plan.currentRevision)
      .map((state) => [state.stepId, state]),
  ), [detail]);
  const revisionDelta = useMemo(() => {
    if (!revision || revision.revision <= 1) return undefined;
    const previous = detail.revisions.find(
      (candidate) => candidate.revision === revision.revision - 1,
    );
    if (!previous) return undefined;
    const before = new Map(previous.steps.map((step) => [step.id, step]));
    const after = new Map(revision.steps.map((step) => [step.id, step]));
    return {
      added: revision.steps.filter((step) => !before.has(step.id)),
      changed: revision.steps.filter((step) => {
        const old = before.get(step.id);
        return old && JSON.stringify(old) !== JSON.stringify(step);
      }),
      removed: previous.steps.filter((step) => !after.has(step.id)),
    };
  }, [detail.revisions, revision]);

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
                zh={zh}
              />
            ))}
          </div>
        </>
      )}

      <div className="plan-panel-actions">
        {detail.plan.status === "ready" && (
          <>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(window.deki.approvePlan(
                detail.plan.id,
                detail.plan.currentRevision,
              ))}
            >{zh ? "批准并执行" : "Approve & run"}</button>
            <button disabled={busy} onClick={requestRevision}>
              {zh ? "要求修改" : "Request changes"}
            </button>
          </>
        )}
        {detail.plan.executionTaskId && (
          <button onClick={() => props.onOpenTask(detail.plan.executionTaskId!)}>
            {zh ? "打开任务" : "Open task"}
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
        {detail.executionTask
          && detail.plan.status === "executing"
          && ["paused", "interrupted"].includes(detail.executionTask.status) && (
          <button
            disabled={busy}
            onClick={() => void run(window.deki.resumeTask(detail.executionTask!.id))}
          >
            {zh ? "恢复执行" : "Resume"}
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
          {revisionDelta && (
            <p>
              +{revisionDelta.added.length} · ~{revisionDelta.changed.length}
              {" "}· -{revisionDelta.removed.length}
              {[...revisionDelta.added, ...revisionDelta.changed, ...revisionDelta.removed]
                .map((step) => step.title).length > 0
                ? ` · ${[...revisionDelta.added, ...revisionDelta.changed, ...revisionDelta.removed]
                    .map((step) => step.title).join("、")}`
                : ""}
            </p>
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

function PlanStepRow(props: {
  index: number;
  step: NonNullable<PlanDetail["revisions"][number]>["steps"][number];
  state?: PlanStepState;
  zh: boolean;
}) {
  const status = props.state?.status ?? "pending";
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
    </details>
  );
}

function planStatusLabel(status: PlanDetail["plan"]["status"], zh: boolean): string {
  const labels = {
    draft: ["草稿", "Draft"],
    ready: ["待审阅", "Ready"],
    approved: ["已批准", "Approved"],
    executing: ["执行中", "Executing"],
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
