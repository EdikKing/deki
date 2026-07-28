import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  artifactRecordSchema,
  planDetailSchema,
  planEventSchema,
  planRecordSchema,
  planRevisionRecordSchema,
  planStepStateSchema,
  planSummarySchema,
  runRecordSchema,
  taskDetailSchema,
  taskEventSchema,
  taskRecordSchema,
  taskRequestRecordSchema,
  taskSummarySchema,
  taskBudgetSchema,
  taskBudgetUsageSchema,
  workerContextPackageSchema,
  workerProfileIdSchema,
  workerRequestSchema,
  workerResultSchema,
  type AgentEvent,
  type ArtifactKind,
  type ArtifactRecord,
  type PlanDetail,
  type PlanEvent,
  type PlanEventType,
  type PlanRecord,
  type PlanRevisionRecord,
  type PlanStatus,
  type PlanStep,
  type PlanStepState,
  type PlanSummary,
  type RunRecord,
  type RunStatus,
  type TaskDetail,
  type TaskEvent,
  type TaskEventType,
  type TaskKind,
  type TaskPlanContext,
  type TaskRecord,
  type TaskRequestKind,
  type TaskRequestRecord,
  type TaskStatus,
  type TaskSummary,
  type TaskBudget,
  type TaskBudgetUsage,
  type WorkerContextPackage,
  type WorkerProfileId,
  type WorkerRequest,
  type WorkerResult,
  type WorkerResultEnvelope,
} from "@deki-ai/shared";
import { z } from "zod";

export const promptExecutionInputSchema = z.object({
  type: z.literal("agent-prompt"),
  sourceSessionId: z.string().min(1),
  sourceSessionFile: z.string().min(1).optional(),
  sourceEntryId: z.string().min(1).optional(),
  preferFork: z.boolean(),
  continuation: z.boolean().optional(),
  interactionMode: z.enum(["act", "plan", "plan-execution", "worker"]).optional(),
  planId: z.string().uuid().optional(),
  planRevision: z.number().int().positive().optional(),
  deliveryMode: z.enum(["foreground", "background"]).optional(),
  workerProfile: workerProfileIdSchema.optional(),
  workerContext: workerContextPackageSchema.optional(),
}).strict();
export type PromptExecutionInput = z.infer<typeof promptExecutionInputSchema>;
export type TaskExecutionInput = PromptExecutionInput;

export interface ReplanInput {
  planId: string;
  reason: string;
  affectedStepIds: string[];
  evidence?: string[];
  title?: string;
  deliveryMode?: "foreground" | "background";
  mode?: "replan" | "revision";
}

export interface PlanRevisionTaskInput {
  feedback: string;
  affectedStepIds: string[];
  evidence?: string[];
  title: string;
  execution: PromptExecutionInput;
}

export interface WorkerDelegationInput {
  parentTaskId: string;
  parentRunId: string;
  toolCallId: string;
  requests: WorkerRequest[];
  budget: TaskBudget;
  sourceSessionId: string;
  deliveryMode?: "foreground" | "background";
}

export interface WorkerDelegation {
  id: string;
  parentTaskId: string;
  parentRunId: string;
  toolCallId: string;
  status: "running" | "completed" | "cancelled" | "interrupted";
  workerTasks: TaskRecord[];
  createdAt: string;
  completedAt?: string;
}

interface ValidatedReplan {
  plan: PlanRecord;
  revision: PlanRevisionRecord;
  affectedStepIds: string[];
  blockSteps: boolean;
}

export interface TaskExecutionHandle {
  sessionId: string;
  modelProvider?: string;
  modelId?: string;
  completion: Promise<void>;
  cancel(): Promise<void>;
  captureContext?(): PromptExecutionInput;
  captureUsage?(): {
    inputTokens: number;
    outputTokens: number;
    toolCallCount: number;
  };
}

export type TaskExecutor = (input: {
  task: TaskRecord;
  run: RunRecord;
  execution: TaskExecutionInput;
  signal: AbortSignal;
}) => Promise<TaskExecutionHandle>;

interface TaskRow {
  id: string;
  workspace_id: string;
  workspace_path: string | null;
  root_task_id: string;
  parent_task_id: string | null;
  kind: string;
  title: string;
  goal: string;
  status: string;
  priority: number;
  session_id: string | null;
  plan_id: string | null;
  current_run_id: string | null;
  assigned_profile: string | null;
  execution_json: string;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  attempt: number;
  status: string;
  session_id: string | null;
  runner_id: string;
  model_provider: string | null;
  model_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result_summary: string | null;
  input_tokens: number;
  output_tokens: number;
  tool_call_count: number;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  run_id: string;
  kind: string;
  title: string;
  uri: string | null;
  content: string | null;
  metadata_json: string;
  created_at: string;
}

interface WorkerResultRow {
  task_id: string;
  run_id: string;
  result_json: string;
  created_at: string;
}

interface TaskBudgetRow {
  task_id: string;
  budget_json: string;
  workers: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  warning_emitted: number;
  exceeded: number;
}

interface WorkerDelegationRow {
  id: string;
  parent_task_id: string;
  parent_run_id: string;
  tool_call_id: string;
  status: string;
  context_json: string;
  created_at: string;
  completed_at: string | null;
}

interface EventRow {
  event_id: string;
  task_id: string;
  run_id: string | null;
  session_id: string | null;
  timestamp: string;
  sequence: number;
  type: string;
  payload_json: string;
}

interface RequestRow {
  id: string;
  task_id: string;
  run_id: string;
  kind: string;
  status: string;
  title: string;
  description: string | null;
  payload_json: string;
  response_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface PlanRow {
  id: string;
  workspace_id: string;
  workspace_path: string | null;
  session_id: string;
  planning_task_id: string | null;
  execution_task_id: string | null;
  goal: string;
  status: string;
  current_revision: number;
  approved_revision: number | null;
  executing_revision: number | null;
  replan_reason: string | null;
  affected_step_ids_json: string;
  replan_evidence_json: string;
  created_at: string;
  updated_at: string;
}

interface PlanRevisionRow {
  plan_id: string;
  revision: number;
  feedback: string | null;
  assumptions_json: string;
  constraints_json: string;
  steps_json: string;
  created_at: string;
}

interface PlanStepStateRow {
  plan_id: string;
  revision: number;
  step_id: string;
  status: string;
  summary: string | null;
  evidence_json: string;
  reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface PlanEventRow {
  event_id: string;
  plan_id: string;
  task_id: string | null;
  run_id: string | null;
  timestamp: string;
  sequence: number;
  type: string;
  payload_json: string;
}

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["running", "paused", "cancelled"]),
  running: new Set([
    "waiting_approval", "waiting_user", "waiting_workers", "paused", "succeeded",
    "failed", "cancelled", "interrupted",
  ]),
  waiting_workers: new Set(["running", "paused", "cancelled", "interrupted"]),
  waiting_approval: new Set(["running", "paused", "cancelled", "interrupted"]),
  waiting_user: new Set(["running", "paused", "cancelled", "interrupted"]),
  paused: new Set(["queued", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(["queued"]),
  cancelled: new Set(),
  interrupted: new Set(["queued"]),
};

const runTransitions: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["starting", "cancelled"]),
  starting: new Set(["running", "failed", "cancelled", "interrupted"]),
  running: new Set([
    "waiting_approval", "waiting_user", "waiting_workers", "succeeded",
    "failed", "cancelled", "interrupted",
  ]),
  waiting_workers: new Set(["running", "cancelled", "interrupted"]),
  waiting_approval: new Set(["running", "cancelled", "interrupted"]),
  waiting_user: new Set(["running", "cancelled", "interrupted"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

export class TaskStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<(event: TaskEvent) => void>();
  readonly #planListeners = new Set<(event: PlanEvent) => void>();

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribePlans(listener: (event: PlanEvent) => void): () => void {
    this.#planListeners.add(listener);
    return () => this.#planListeners.delete(listener);
  }

  createTask(input: {
    workspaceId: string;
    workspacePath?: string;
    kind: TaskKind;
    title: string;
    goal: string;
    execution: TaskExecutionInput;
    priority?: number;
    parentTaskId?: string;
    planId?: string;
    assignedProfile?: string;
  }): TaskRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const task = taskRecordSchema.parse({
      id,
      workspaceId: input.workspaceId,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      rootTaskId: input.parentTaskId
        ? this.getTask(input.parentTaskId)?.rootTaskId ?? input.parentTaskId
        : id,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      kind: input.kind,
      title: input.title.trim(),
      goal: input.goal.trim(),
      status: "queued",
      priority: input.priority ?? 0,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.assignedProfile ? { assignedProfile: input.assignedProfile } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const execution = promptExecutionInputSchema.parse(input.execution);
    this.#transaction((events) => {
      this.#database.prepare(`
        INSERT INTO tasks (
          id, workspace_id, workspace_path, root_task_id, parent_task_id, kind,
          title, goal, status, priority, session_id, plan_id, current_run_id,
          assigned_profile, execution_json, delivery_mode, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL)
      `).run(
        task.id,
        task.workspaceId,
        task.workspacePath ?? null,
        task.rootTaskId,
        task.parentTaskId ?? null,
        task.kind,
        task.title,
        task.goal,
        task.status,
        task.priority,
        task.planId ?? null,
        task.assignedProfile ?? null,
        JSON.stringify(execution),
        execution.deliveryMode ?? "foreground",
        task.createdAt,
        task.updatedAt,
      );
      events.push(this.#appendEvent(task.id, "task.created", {
        kind: task.kind,
        title: task.title,
      }));
      events.push(this.#appendEvent(task.id, "task.queued", {}));
    });
    return task;
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM tasks WHERE id = ?",
    ).get(id) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getTaskDetail(id: string): TaskDetail | undefined {
    const task = this.getTask(id);
    if (!task) return undefined;
    const runs = this.#database.prepare(
      "SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC",
    ).all(id) as unknown as RunRow[];
    const artifacts = this.#database.prepare(
      "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC",
    ).all(id) as unknown as ArtifactRow[];
    const events = this.#database.prepare(
      "SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence ASC",
    ).all(id) as unknown as EventRow[];
    const requests = this.#database.prepare(
      "SELECT * FROM task_requests WHERE task_id = ? ORDER BY created_at ASC",
    ).all(id) as unknown as RequestRow[];
    const childRows = this.#database.prepare(`
      SELECT * FROM tasks WHERE parent_task_id = ?
      ORDER BY created_at ASC
    `).all(id) as unknown as TaskRow[];
    const budget = this.getTaskBudget(id);
    return taskDetailSchema.parse({
      task,
      runs: runs.map(rowToRun),
      artifacts: artifacts.map(rowToArtifact),
      events: events.map(rowToEvent),
      requests: requests.map(rowToRequest),
      children: childRows.map((row) => this.#summaryFor(rowToTask(row))),
      ...(task.kind === "worker"
        ? { workerResult: this.getWorkerResult(task.id) }
        : {}),
      ...(budget ? { budget: budget.budget, budgetUsage: budget.usage } : {}),
      ...(task.planId ? { planContext: this.#planContextFor(task.planId) } : {}),
    });
  }

  listTaskSummaries(options: {
    statuses?: TaskStatus[];
    workspaceIds?: string[];
    query?: string;
    limit?: number;
  } = {}): TaskSummary[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    if (options.statuses?.length === 0 || options.workspaceIds?.length === 0) return [];
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.statuses?.length) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      values.push(...options.statuses);
    }
    if (options.workspaceIds?.length) {
      clauses.push(`workspace_id IN (${options.workspaceIds.map(() => "?").join(", ")})`);
      values.push(...options.workspaceIds);
    }
    if (options.query?.trim()) {
      const query = `%${options.query.trim()}%`;
      clauses.push(`(
        title LIKE ? OR goal LIKE ? OR EXISTS (
          SELECT 1 FROM runs
          WHERE runs.task_id = tasks.id
            AND (runs.result_summary LIKE ? OR runs.error LIKE ?)
        ) OR EXISTS (
          SELECT 1 FROM worker_results
          WHERE worker_results.task_id = tasks.id
            AND worker_results.result_json LIKE ?
        ) OR EXISTS (
          SELECT 1 FROM tasks child
          LEFT JOIN worker_results child_result ON child_result.task_id = child.id
          WHERE child.parent_task_id = tasks.id
            AND (
              child.title LIKE ? OR child.goal LIKE ?
              OR child_result.result_json LIKE ?
            )
        )
      )`);
      values.push(query, query, query, query, query, query, query, query);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM tasks
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(...values, limit) as unknown as TaskRow[];
    return rows.map((row) => this.#summaryFor(rowToTask(row)));
  }

  listTasks(
    workspaceId: string,
    options: { statuses?: TaskStatus[]; limit?: number } = {},
  ): TaskRecord[] {
    return this.listTaskSummaries({
      workspaceIds: [workspaceId],
      ...(options.statuses ? { statuses: options.statuses } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    }).map((summary) => summary.task);
  }

  listQueuedTasks(limit = 500): TaskRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM tasks
      WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(Math.min(500, Math.max(1, limit))) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  getExecution(id: string): TaskExecutionInput {
    const row = this.#database.prepare(
      "SELECT execution_json, delivery_mode FROM tasks WHERE id = ?",
    ).get(id) as { execution_json: string; delivery_mode: string } | undefined;
    if (!row) throw new Error("未找到任务");
    return promptExecutionInputSchema.parse({
      ...JSON.parse(row.execution_json) as Record<string, unknown>,
      deliveryMode: row.delivery_mode === "background" ? "background" : "foreground",
    });
  }

  getDeliveryMode(id: string): "foreground" | "background" {
    const row = this.#database.prepare(
      "SELECT delivery_mode FROM tasks WHERE id = ?",
    ).get(id) as { delivery_mode: string } | undefined;
    return row?.delivery_mode === "background" ? "background" : "foreground";
  }

  delegateWorkers(input: WorkerDelegationInput): WorkerDelegation {
    const parent = this.#requireTask(input.parentTaskId);
    const parentRun = this.#requireRun(input.parentRunId);
    if (parent.kind === "worker") throw new Error("Worker 不能继续创建 Worker");
    if (
      parent.currentRunId !== parentRun.id
      || parent.status !== "running"
      || parentRun.status !== "running"
    ) {
      throw new Error("只能从当前运行中的父任务派发 Worker");
    }
    if (input.requests.length < 1 || input.requests.length > 2) {
      throw new Error("每次必须派发 1～2 个 Worker");
    }
    const requests = input.requests.map((request) => workerRequestSchema.parse(request));
    const budget = taskBudgetSchema.parse(input.budget);
    const existing = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE root_task_id = ? AND kind = 'worker'
    `).get(parent.rootTaskId) as { count: number };
    if (existing.count + requests.length > budget.maxWorkers) {
      throw new Error(`根任务最多允许 ${budget.maxWorkers} 个 Worker`);
    }
    const duplicate = this.#database.prepare(`
      SELECT id FROM worker_delegations
      WHERE parent_run_id = ? AND tool_call_id = ?
    `).get(parentRun.id, input.toolCallId) as { id: string } | undefined;
    if (duplicate) throw new Error("该 Worker 派发请求已经存在");

    const delegationId = randomUUID();
    const now = new Date().toISOString();
    const workerTasks: TaskRecord[] = [];
    this.#transaction((events) => {
      this.#database.prepare(`
        INSERT INTO worker_delegations (
          id, parent_task_id, parent_run_id, tool_call_id, status,
          context_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, NULL)
      `).run(
        delegationId,
        parent.id,
        parentRun.id,
        input.toolCallId,
        JSON.stringify({ requests }),
        now,
      );
      this.#database.prepare(`
        INSERT INTO task_budgets (
          task_id, budget_json, workers, duration_ms, input_tokens,
          output_tokens, tool_calls, warning_emitted, exceeded
        ) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0)
        ON CONFLICT(task_id) DO NOTHING
      `).run(parent.rootTaskId, JSON.stringify(budget));

      for (const request of requests) {
        const workerTaskId = randomUUID();
        const workerPlanId = request.plan?.planId ?? parent.planId;
        const context: WorkerContextPackage = workerContextPackageSchema.parse({
          rootTaskId: parent.rootTaskId,
          parentTaskId: parent.id,
          workerTaskId,
          objective: request.objective,
          successCriteria: request.successCriteria,
          constraints: request.constraints,
          knownFacts: request.knownFacts,
          fileHints: request.fileHints,
          symbolHints: request.symbolHints,
          ...(request.plan ? { plan: request.plan } : {}),
          budget,
        });
        const task = this.#insertTask({
          id: workerTaskId,
          workspaceId: parent.workspaceId,
          ...(parent.workspacePath ? { workspacePath: parent.workspacePath } : {}),
          kind: "worker",
          title: `${workerProfileLabel(request.profile)}：${request.objective.slice(0, 120)}`,
          goal: request.objective,
          parentTaskId: parent.id,
          rootTaskId: parent.rootTaskId,
          assignedProfile: request.profile,
          priority: parent.priority,
          ...(workerPlanId ? { planId: workerPlanId } : {}),
          execution: {
            type: "agent-prompt",
            sourceSessionId: input.sourceSessionId,
            preferFork: true,
            interactionMode: "worker",
            workerProfile: request.profile,
            workerContext: context,
            deliveryMode: input.deliveryMode ?? "background",
          },
        }, events);
        this.#database.prepare(`
          INSERT INTO task_budgets (
            task_id, budget_json, workers, duration_ms, input_tokens,
            output_tokens, tool_calls, warning_emitted, exceeded
          ) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0)
        `).run(task.id, JSON.stringify(budget));
        this.#database.prepare(`
          INSERT INTO worker_delegation_tasks (delegation_id, task_id)
          VALUES (?, ?)
        `).run(delegationId, task.id);
        workerTasks.push(task);
      }
      this.#database.prepare(`
        UPDATE task_budgets SET workers = workers + ?
        WHERE task_id = ?
      `).run(workerTasks.length, parent.rootTaskId);
      this.#database.prepare(
        "UPDATE tasks SET status = 'waiting_workers', updated_at = ? WHERE id = ?",
      ).run(now, parent.id);
      this.#database.prepare(
        "UPDATE runs SET status = 'waiting_workers' WHERE id = ? AND task_id = ?",
      ).run(parentRun.id, parent.id);
      events.push(this.#appendEvent(
        parent.id,
        "worker.delegated",
        {
          delegationId,
          workerTaskIds: workerTasks.map((task) => task.id),
          profiles: workerTasks.map((task) => task.assignedProfile),
        },
        parentRun.id,
        parent.sessionId,
      ));
      events.push(this.#appendEvent(
        parent.id,
        "task.waiting_workers",
        { delegationId, workerTaskIds: workerTasks.map((task) => task.id) },
        parentRun.id,
        parent.sessionId,
      ));
    });
    return {
      id: delegationId,
      parentTaskId: parent.id,
      parentRunId: parentRun.id,
      toolCallId: input.toolCallId,
      status: "running",
      workerTasks,
      createdAt: now,
    };
  }

  getWorkerResult(taskId: string, runId?: string): WorkerResult | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM worker_results
      WHERE task_id = ? ${runId ? "AND run_id = ?" : ""}
      ORDER BY created_at DESC LIMIT 1
    `).get(...(runId ? [taskId, runId] : [taskId])) as unknown as
      | WorkerResultRow
      | undefined;
    return row ? workerResultSchema.parse(JSON.parse(row.result_json)) : undefined;
  }

  saveWorkerResult(taskId: string, runId: string, result: WorkerResult): WorkerResult {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    if (task.kind !== "worker" || run.taskId !== task.id || task.currentRunId !== run.id) {
      throw new Error("Worker Result 与当前 Worker Run 不匹配");
    }
    const parsed = workerResultSchema.parse(result);
    const artifactIds = new Set(parsed.artifacts);
    for (const finding of parsed.findings) {
      for (const evidence of finding.evidence) {
        if (evidence.kind === "file" && !isSafeWorkspaceRelativePath(evidence.path)) {
          throw new Error(`Worker 文件证据必须是工作区相对路径: ${evidence.path}`);
        }
        if (evidence.kind === "artifact") artifactIds.add(evidence.artifactId);
        if (evidence.kind === "command" && evidence.outputArtifactId) {
          artifactIds.add(evidence.outputArtifactId);
        }
      }
    }
    for (const artifactId of artifactIds) {
      const artifact = this.#database.prepare(
        "SELECT task_id FROM artifacts WHERE id = ?",
      ).get(artifactId) as { task_id: string } | undefined;
      if (!artifact || artifact.task_id !== task.id) {
        throw new Error(`Worker Result 引用了不属于当前 Worker 的 Artifact: ${artifactId}`);
      }
    }
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(`
        INSERT INTO worker_results (task_id, run_id, result_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(task.id, run.id, JSON.stringify(parsed), now);
      events.push(this.#appendEvent(
        task.id,
        "worker.result_received",
        { findingCount: parsed.findings.length },
        run.id,
        task.sessionId,
      ));
    });
    return parsed;
  }

  updateRunUsage(
    taskId: string,
    runId: string,
    usage: Pick<TaskBudgetUsage, "inputTokens" | "outputTokens" | "toolCalls" | "durationMs">,
  ): TaskBudgetUsage | undefined {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    if (run.taskId !== task.id) throw new Error("Run 不属于该 Task");
    const budgetRow = this.#database.prepare(
      "SELECT * FROM task_budgets WHERE task_id = ?",
    ).get(task.id) as unknown as TaskBudgetRow | undefined;
    this.#database.prepare(`
      UPDATE runs SET input_tokens = ?, output_tokens = ?, tool_call_count = ?
      WHERE id = ? AND task_id = ?
    `).run(
      usage.inputTokens,
      usage.outputTokens,
      usage.toolCalls,
      run.id,
      task.id,
    );
    if (!budgetRow || task.kind !== "worker") return undefined;
    const budget = taskBudgetSchema.parse(JSON.parse(budgetRow.budget_json));
    const aggregate = this.#database.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(tool_call_count), 0) AS tool_calls
      FROM runs WHERE task_id = ?
    `).get(task.id) as {
      input_tokens: number;
      output_tokens: number;
      tool_calls: number;
    };
    const previousDurationMs = (
      this.#database.prepare(`
        SELECT started_at, finished_at FROM runs
        WHERE task_id = ? AND id <> ? AND started_at IS NOT NULL AND finished_at IS NOT NULL
      `).all(task.id, run.id) as Array<{
        started_at: string;
        finished_at: string;
      }>
    ).reduce((total, previous) => total + Math.max(
      0,
      Date.parse(previous.finished_at) - Date.parse(previous.started_at),
    ), 0);
    const next = taskBudgetUsageSchema.parse({
      workers: budgetRow.workers,
      durationMs: previousDurationMs + usage.durationMs,
      inputTokens: aggregate.input_tokens,
      outputTokens: aggregate.output_tokens,
      toolCalls: aggregate.tool_calls,
      warningEmitted: Boolean(budgetRow.warning_emitted),
      exceeded: Boolean(budgetRow.exceeded),
    });
    const ratio = Math.max(
      next.durationMs / budget.maxDurationMs,
      next.inputTokens / budget.maxInputTokens,
      next.outputTokens / budget.maxOutputTokens,
      next.toolCalls / budget.maxToolCalls,
    );
    const warning = ratio >= 0.8;
    const exceeded = ratio >= 1;
    const shouldWarn = warning && !next.warningEmitted;
    const shouldExceed = exceeded && !next.exceeded;
    let rootWarning = false;
    let rootExceeded = false;
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE task_budgets
        SET duration_ms = ?, input_tokens = ?, output_tokens = ?, tool_calls = ?,
            warning_emitted = MAX(warning_emitted, ?), exceeded = MAX(exceeded, ?)
        WHERE task_id = ?
      `).run(
        next.durationMs,
        next.inputTokens,
        next.outputTokens,
        next.toolCalls,
        warning ? 1 : 0,
        exceeded ? 1 : 0,
        task.id,
      );
      if (shouldWarn) {
        events.push(this.#appendEvent(
          task.id,
          "budget.warning",
          { ratio },
          run.id,
          task.sessionId,
        ));
      }
      if (shouldExceed) {
        events.push(this.#appendEvent(
          task.id,
          "budget.exceeded",
          { ratio },
          run.id,
          task.sessionId,
        ));
      }
      this.#database.prepare(`
        UPDATE task_budgets
        SET duration_ms = (
              SELECT COALESCE(SUM(duration_ms), 0) FROM task_budgets child
              JOIN tasks ON tasks.id = child.task_id
              WHERE tasks.root_task_id = ? AND tasks.kind = 'worker'
            ),
            input_tokens = (
              SELECT COALESCE(SUM(input_tokens), 0) FROM runs
              JOIN tasks ON tasks.id = runs.task_id
              WHERE tasks.root_task_id = ? AND tasks.kind = 'worker'
            ),
            output_tokens = (
              SELECT COALESCE(SUM(output_tokens), 0) FROM runs
              JOIN tasks ON tasks.id = runs.task_id
              WHERE tasks.root_task_id = ? AND tasks.kind = 'worker'
            ),
            tool_calls = (
              SELECT COALESCE(SUM(tool_call_count), 0) FROM runs
              JOIN tasks ON tasks.id = runs.task_id
              WHERE tasks.root_task_id = ? AND tasks.kind = 'worker'
            )
        WHERE task_id = ?
      `).run(
        task.rootTaskId,
        task.rootTaskId,
        task.rootTaskId,
        task.rootTaskId,
        task.rootTaskId,
      );
      if (task.rootTaskId !== task.id) {
        const rootRow = this.#database.prepare(
          "SELECT * FROM task_budgets WHERE task_id = ?",
        ).get(task.rootTaskId) as unknown as TaskBudgetRow | undefined;
        if (rootRow) {
          const rootRatio = Math.max(
            rootRow.duration_ms / budget.maxDurationMs,
            rootRow.input_tokens / budget.maxInputTokens,
            rootRow.output_tokens / budget.maxOutputTokens,
            rootRow.tool_calls / budget.maxToolCalls,
          );
          rootWarning = rootRatio >= 0.8;
          rootExceeded = rootRatio >= 1;
          this.#database.prepare(`
            UPDATE task_budgets
            SET warning_emitted = MAX(warning_emitted, ?),
                exceeded = MAX(exceeded, ?)
            WHERE task_id = ?
          `).run(rootWarning ? 1 : 0, rootExceeded ? 1 : 0, task.rootTaskId);
          if (rootWarning && !rootRow.warning_emitted) {
            events.push(this.#appendEvent(
              task.rootTaskId,
              "budget.warning",
              { ratio: rootRatio, workerTaskId: task.id },
              run.id,
              task.sessionId,
            ));
          }
          if (rootExceeded && !rootRow.exceeded) {
            events.push(this.#appendEvent(
              task.rootTaskId,
              "budget.exceeded",
              { ratio: rootRatio, workerTaskId: task.id },
              run.id,
              task.sessionId,
            ));
          }
        }
      }
    });
    return {
      ...next,
      warningEmitted: warning || rootWarning,
      exceeded: exceeded || rootExceeded,
    };
  }

  getTaskBudget(taskId: string): {
    budget: TaskBudget;
    usage: TaskBudgetUsage;
  } | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM task_budgets WHERE task_id = ?",
    ).get(taskId) as unknown as TaskBudgetRow | undefined;
    if (!row) return undefined;
    return {
      budget: taskBudgetSchema.parse(JSON.parse(row.budget_json)),
      usage: taskBudgetUsageSchema.parse({
        workers: row.workers,
        durationMs: row.duration_ms,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        toolCalls: row.tool_calls,
        warningEmitted: Boolean(row.warning_emitted),
        exceeded: Boolean(row.exceeded),
      }),
    };
  }

  tryCompleteWorkerDelegation(workerTaskId: string): {
    parentTaskId: string;
    parentRunId: string;
    delegationId: string;
    results: WorkerResultEnvelope[];
  } | undefined {
    const delegation = this.#database.prepare(`
      SELECT d.* FROM worker_delegations d
      JOIN worker_delegation_tasks dt ON dt.delegation_id = d.id
      WHERE dt.task_id = ? AND d.status = 'running'
    `).get(workerTaskId) as unknown as WorkerDelegationRow | undefined;
    if (!delegation) return undefined;
    const rows = this.#database.prepare(`
      SELECT t.* FROM tasks t
      JOIN worker_delegation_tasks dt ON dt.task_id = t.id
      WHERE dt.delegation_id = ?
      ORDER BY t.created_at ASC
    `).all(delegation.id) as unknown as TaskRow[];
    const tasks = rows.map(rowToTask);
    if (tasks.some((task) => !isTerminalTaskStatus(task.status))) return undefined;
    const results: WorkerResultEnvelope[] = tasks.map((task) => {
      const latestRun = this.#database.prepare(`
        SELECT * FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1
      `).get(task.id) as unknown as RunRow | undefined;
      const result = this.getWorkerResult(task.id, latestRun?.id);
      return {
        task,
        status: task.status,
        ...(result ? { result } : {}),
        ...(latestRun?.error ? { error: latestRun.error } : {}),
      };
    });
    const parent = this.#requireTask(delegation.parent_task_id);
    const parentRun = this.#requireRun(delegation.parent_run_id);
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE worker_delegations
        SET status = 'completed', completed_at = ?
        WHERE id = ? AND status = 'running'
      `).run(now, delegation.id);
      events.push(this.#appendEvent(
        parent.id,
        "worker.result_received",
        {
          delegationId: delegation.id,
          workers: results.map((entry) => ({
            taskId: entry.task.id,
            status: entry.status,
          })),
        },
        parentRun.id,
        parent.sessionId,
      ));
    });
    return {
      parentTaskId: parent.id,
      parentRunId: parentRun.id,
      delegationId: delegation.id,
      results,
    };
  }

  resumeAfterWorkers(
    parentTaskId: string,
    parentRunId: string,
    delegationId: string,
  ): void {
    const parent = this.#requireTask(parentTaskId);
    const run = this.#requireRun(parentRunId);
    if (parent.status !== "waiting_workers" || run.status !== "waiting_workers") {
      throw new Error("父任务已不再等待 Worker");
    }
    const delegation = this.#database.prepare(`
      SELECT id FROM worker_delegations
      WHERE id = ? AND parent_task_id = ? AND parent_run_id = ? AND status = 'completed'
    `).get(
      delegationId,
      parent.id,
      run.id,
    ) as { id: string } | undefined;
    if (!delegation) throw new Error("Worker 派发尚未完成");
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(
        "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?",
      ).run(now, parent.id);
      this.#database.prepare(
        "UPDATE runs SET status = 'running' WHERE id = ? AND task_id = ?",
      ).run(run.id, parent.id);
      events.push(this.#appendEvent(
        parent.id,
        "task.resumed",
        { from: "waiting_workers", delegationId },
        run.id,
        parent.sessionId,
      ));
    });
  }

  listDescendantTasks(taskId: string): TaskRecord[] {
    const rows = this.#database.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM tasks WHERE parent_task_id = ?
        UNION ALL
        SELECT tasks.id FROM tasks
        JOIN descendants ON tasks.parent_task_id = descendants.id
      )
      SELECT tasks.* FROM tasks JOIN descendants ON tasks.id = descendants.id
      ORDER BY tasks.created_at DESC
    `).all(taskId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  getLatestPlanningTask(planId: string): TaskRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM tasks
      WHERE plan_id = ? AND kind = 'planning'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(planId) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  isPlanExecutionApproved(task: TaskRecord): boolean {
    if (task.kind !== "plan-execution" || !task.planId) return true;
    const plan = this.#getPlanRecord(task.planId);
    return plan?.status === "approved" && plan.approvedRevision !== undefined;
  }

  updateExecution(taskId: string, execution: TaskExecutionInput): void {
    this.#requireTask(taskId);
    const current = this.getExecution(taskId);
    const next = promptExecutionInputSchema.parse({
      ...execution,
      deliveryMode: current.deliveryMode,
    });
    this.#database.prepare(
      `UPDATE tasks
       SET execution_json = ?, delivery_mode = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(next),
      next.deliveryMode ?? current.deliveryMode ?? "foreground",
      new Date().toISOString(),
      taskId,
    );
  }

  backfillWorkspacePath(workspaceId: string, workspacePath: string): number {
    const result = this.#database.prepare(`
      UPDATE tasks SET workspace_path = ?
      WHERE workspace_id = ? AND workspace_path IS NULL
    `).run(workspacePath, workspaceId);
    return Number(result.changes);
  }

  createPlan(input: {
    workspaceId: string;
    workspacePath?: string;
    sessionId: string;
    planningTaskId?: string;
    goal: string;
    assumptions: string[];
    constraints: string[];
    steps: PlanStep[];
  }): PlanRecord {
    validatePlanSteps(input.steps);
    const id = randomUUID();
    const now = new Date().toISOString();
    const plan = planRecordSchema.parse({
      id,
      workspaceId: input.workspaceId,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      sessionId: input.sessionId,
      ...(input.planningTaskId ? { planningTaskId: input.planningTaskId } : {}),
      goal: input.goal,
      status: "ready",
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const revision = planRevisionRecordSchema.parse({
      planId: id,
      revision: 1,
      assumptions: input.assumptions,
      constraints: input.constraints,
      steps: input.steps,
      createdAt: now,
    });
    this.#transaction((_events, planEvents) => {
      this.#database.prepare(`
        INSERT INTO plans (
          id, workspace_id, workspace_path, session_id, planning_task_id,
          execution_task_id, goal, status, current_revision, approved_revision,
          executing_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'ready', 1, NULL, NULL, ?, ?)
      `).run(
        plan.id,
        plan.workspaceId,
        plan.workspacePath ?? null,
        plan.sessionId,
        plan.planningTaskId ?? null,
        plan.goal,
        now,
        now,
      );
      this.#insertPlanRevision(revision);
      this.#initializePlanStepStates(revision);
      if (plan.planningTaskId) {
        this.#database.prepare(
          "UPDATE tasks SET plan_id = ?, updated_at = ? WHERE id = ?",
        ).run(plan.id, now, plan.planningTaskId);
      }
      planEvents.push(this.#appendPlanEvent(
        plan.id,
        "plan.created",
        { revision: 1, goal: plan.goal },
        plan.planningTaskId,
      ));
      planEvents.push(this.#appendPlanEvent(
        plan.id,
        "plan.submitted",
        { revision: 1, stepCount: revision.steps.length },
        plan.planningTaskId,
      ));
    });
    return plan;
  }

  revisePlan(planId: string, input: {
    planningTaskId?: string;
    feedback?: string;
    assumptions: string[];
    constraints: string[];
    steps: PlanStep[];
  }): PlanRecord {
    const plan = this.#requirePlan(planId);
    if (!["draft", "ready"].includes(plan.status)) {
      throw new Error(`计划当前状态为 ${plan.status}，不能修订`);
    }
    validatePlanSteps(input.steps);
    const revisionNumber = plan.currentRevision + 1;
    const now = new Date().toISOString();
    const revision = planRevisionRecordSchema.parse({
      planId,
      revision: revisionNumber,
      ...(input.feedback ? { feedback: input.feedback } : {}),
      assumptions: input.assumptions,
      constraints: input.constraints,
      steps: input.steps,
      createdAt: now,
    });
    const previous = this.#requirePlanRevision(planId, plan.currentRevision);
    const previousStates = this.#listPlanStepStates(planId, plan.currentRevision);
    this.#transaction((_events, planEvents) => {
      this.#insertPlanRevision(revision);
      this.#initializePlanStepStates(revision, previous, previousStates);
      this.#database.prepare(`
        UPDATE plans
        SET status = 'ready', current_revision = ?, planning_task_id = ?,
            replan_reason = NULL, affected_step_ids_json = '[]',
            replan_evidence_json = '[]', updated_at = ?
        WHERE id = ?
      `).run(revisionNumber, input.planningTaskId ?? null, now, planId);
      planEvents.push(this.#appendPlanEvent(
        planId,
        "plan.revised",
        { revision: revisionNumber, basedOnRevision: plan.currentRevision },
        input.planningTaskId,
      ));
    });
    return this.#requirePlan(planId);
  }

  createPlanRevisionTask(
    planId: string,
    input: PlanRevisionTaskInput,
  ): TaskRecord {
    const plan = this.#requirePlan(planId);
    if (!["draft", "ready", "approved"].includes(plan.status)) {
      throw new Error(`计划当前状态为 ${plan.status}，不能请求修订`);
    }
    const pending = this.#findNonTerminalPlanningTask(planId);
    if (pending) throw new Error("该计划已有正在进行的修订任务");
    const revision = this.#requirePlanRevision(planId, plan.currentRevision);
    const knownIds = new Set(revision.steps.map((step) => step.id));
    if (input.affectedStepIds.some((id) => !knownIds.has(id))) {
      throw new Error("受影响步骤包含未知 Step ID");
    }
    const executionTask = plan.executionTaskId
      ? this.#requireTask(plan.executionTaskId)
      : undefined;
    if (
      executionTask
      && ["running", "waiting_approval", "waiting_user", "waiting_workers"].includes(
        executionTask.status,
      )
    ) {
      throw new Error("计划执行任务仍在运行，必须先精确暂停");
    }
    if (
      executionTask
      && !["queued", "paused", "failed", "interrupted", "cancelled"].includes(
        executionTask.status,
      )
    ) {
      throw new Error(`执行任务当前状态为 ${executionTask.status}，不能修订`);
    }
    const execution = promptExecutionInputSchema.parse(input.execution);
    const affectedStepIds = input.affectedStepIds.length > 0
      ? input.affectedStepIds
      : plan.affectedStepIds;
    const now = new Date().toISOString();
    let planningTask: TaskRecord;
    this.#transaction((events, planEvents) => {
      if (executionTask?.status === "queued") {
        this.#database.prepare(`
          UPDATE tasks SET status = 'paused', updated_at = ?, completed_at = NULL
          WHERE id = ?
        `).run(now, executionTask.id);
        events.push(this.#appendEvent(
          executionTask.id,
          "task.paused",
          { reason: "plan_revision" },
          executionTask.currentRunId,
          executionTask.sessionId,
        ));
      }
      this.#database.prepare(`
        UPDATE plans
        SET status = 'draft', executing_revision = NULL, replan_reason = ?,
            affected_step_ids_json = ?, replan_evidence_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.feedback,
        JSON.stringify(affectedStepIds),
        JSON.stringify(input.evidence ?? []),
        now,
        planId,
      );
      planEvents.push(this.#appendPlanEvent(
        planId,
        "plan.replan_requested",
        {
          feedback: input.feedback,
          reason: input.feedback,
          affectedStepIds,
          evidence: input.evidence ?? [],
        },
        executionTask?.id,
        executionTask?.currentRunId,
      ));
      planningTask = this.#insertTask({
        workspaceId: plan.workspaceId,
        ...(plan.workspacePath ? { workspacePath: plan.workspacePath } : {}),
        kind: "planning",
        title: input.title,
        goal: plan.goal,
        planId,
        execution,
      }, events);
    });
    return planningTask!;
  }

  getPlan(planId: string): PlanDetail | undefined {
    const plan = this.#getPlanRecord(planId);
    if (!plan) return undefined;
    const revisions = this.#database.prepare(`
      SELECT * FROM plan_revisions
      WHERE plan_id = ? ORDER BY revision ASC
    `).all(planId) as unknown as PlanRevisionRow[];
    const states = this.#database.prepare(`
      SELECT * FROM plan_step_states
      WHERE plan_id = ? ORDER BY revision ASC, step_id ASC
    `).all(planId) as unknown as PlanStepStateRow[];
    const events = this.#database.prepare(`
      SELECT * FROM plan_events
      WHERE plan_id = ? ORDER BY sequence ASC
    `).all(planId) as unknown as PlanEventRow[];
    return planDetailSchema.parse({
      plan,
      revisions: revisions.map(rowToPlanRevision),
      stepStates: states.map(rowToPlanStepState),
      events: events.map(rowToPlanEvent),
      ...(plan.planningTaskId
        ? { planningTask: this.getTask(plan.planningTaskId) }
        : {}),
      ...(plan.executionTaskId
        ? { executionTask: this.getTask(plan.executionTaskId) }
        : {}),
    });
  }

  getPlanForPlanningTask(taskId: string): PlanRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM plans WHERE planning_task_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(taskId) as unknown as PlanRow | undefined;
    return row ? rowToPlan(row) : undefined;
  }

  listPlans(options: {
    statuses?: PlanStatus[];
    workspaceIds?: string[];
    query?: string;
    limit?: number;
  } = {}): PlanSummary[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    if (options.statuses?.length === 0 || options.workspaceIds?.length === 0) return [];
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.statuses?.length) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      values.push(...options.statuses);
    }
    if (options.workspaceIds?.length) {
      clauses.push(`workspace_id IN (${options.workspaceIds.map(() => "?").join(", ")})`);
      values.push(...options.workspaceIds);
    }
    if (options.query?.trim()) {
      clauses.push("goal LIKE ?");
      values.push(`%${options.query.trim()}%`);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM plans
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY updated_at DESC LIMIT ?
    `).all(...values, limit) as unknown as PlanRow[];
    return rows.map((row) => {
      const plan = rowToPlan(row);
      const revision = this.#requirePlanRevision(plan.id, plan.currentRevision);
      const states = this.#listPlanStepStates(plan.id, plan.currentRevision);
      const stateById = new Map(states.map((state) => [state.stepId, state]));
      return planSummarySchema.parse({
        plan,
        revision,
        completedSteps: states.filter((state) =>
          state.status === "completed" || state.status === "skipped"
        ).length,
        totalSteps: revision.steps.length,
        currentStep: revision.steps.find((step) =>
          stateById.get(step.id)?.status === "running"
          || stateById.get(step.id)?.status === "blocked"
        ),
      });
    });
  }

  approvePlan(planId: string, revisionNumber: number, input: {
    title: string;
    execution: PromptExecutionInput;
  }): TaskRecord {
    const plan = this.#requirePlan(planId);
    if (plan.status !== "ready") throw new Error("只有待审阅计划可以批准");
    if (revisionNumber !== plan.currentRevision) throw new Error("只能批准最新计划版本");
    if (!plan.planningTaskId) throw new Error("计划缺少有效的规划任务");
    const planningTask = this.#requireTask(plan.planningTaskId);
    if (planningTask.status !== "succeeded") {
      throw new Error("规划任务尚未成功完成，不能批准计划");
    }
    this.#requirePlanRevision(planId, revisionNumber);
    const now = new Date().toISOString();
    let task: TaskRecord;
    this.#transaction((events, planEvents) => {
      if (plan.executionTaskId) {
        const existing = this.#requireTask(plan.executionTaskId);
        if (!["paused", "interrupted", "failed"].includes(existing.status)) {
          throw new Error(`执行任务当前状态为 ${existing.status}，不能恢复`);
        }
        this.#database.prepare(`
          UPDATE tasks
          SET status = 'queued', execution_json = ?, updated_at = ?, completed_at = NULL
          WHERE id = ?
        `).run(JSON.stringify(promptExecutionInputSchema.parse(input.execution)), now, existing.id);
        events.push(this.#appendEvent(existing.id, "task.resumed", { planId, revision: revisionNumber }));
        events.push(this.#appendEvent(existing.id, "task.queued", { planId, revision: revisionNumber }));
        task = { ...existing, status: "queued", updatedAt: now, completedAt: undefined };
      } else {
        task = this.#insertTask({
          workspaceId: plan.workspaceId,
          ...(plan.workspacePath ? { workspacePath: plan.workspacePath } : {}),
          kind: "plan-execution",
          title: input.title,
          goal: plan.goal,
          planId,
          execution: input.execution,
        }, events);
      }
      this.#database.prepare(`
        UPDATE plans
        SET status = 'approved', approved_revision = ?, execution_task_id = ?,
            replan_reason = NULL, affected_step_ids_json = '[]',
            replan_evidence_json = '[]', updated_at = ?
        WHERE id = ?
      `).run(revisionNumber, task.id, now, planId);
      planEvents.push(this.#appendPlanEvent(
        planId,
        "plan.approved",
        { revision: revisionNumber },
        task.id,
      ));
    });
    return task!;
  }

  updatePlanStep(planId: string, input: {
    revision: number;
    stepId: string;
    status: "running" | "completed" | "blocked";
    summary?: string;
    evidence?: string[];
    reason?: string;
    taskId?: string;
    runId?: string;
  }): PlanStepState {
    const plan = this.#requirePlan(planId);
    if (plan.status !== "executing") throw new Error("计划当前未在执行");
    if (plan.executingRevision !== input.revision) throw new Error("不能更新非执行版本");
    const revision = this.#requirePlanRevision(planId, input.revision);
    const step = revision.steps.find((candidate) => candidate.id === input.stepId);
    if (!step) throw new Error("未找到计划步骤");
    const states = this.#listPlanStepStates(planId, input.revision);
    const current = states.find((state) => state.stepId === input.stepId);
    if (!current) throw new Error("未找到步骤状态");
    if (input.status === "running") {
      if (current.status !== "pending" && current.status !== "blocked") {
        throw new Error(`步骤当前状态为 ${current.status}，不能开始`);
      }
      if (states.some((state) => state.status === "running" && state.stepId !== input.stepId)) {
        throw new Error("当前已有正在执行的计划步骤");
      }
      const completed = new Set(states
        .filter((state) => state.status === "completed" || state.status === "skipped")
        .map((state) => state.stepId));
      if (step.dependencies.some((dependency) => !completed.has(dependency))) {
        throw new Error("步骤依赖尚未完成");
      }
    } else if (current.status !== "running") {
      throw new Error("只有正在执行的步骤可以完成或阻塞");
    }
    const now = new Date().toISOString();
    const next = planStepStateSchema.parse({
      ...current,
      status: input.status,
      ...(input.summary ? { summary: input.summary } : {}),
      evidence: input.evidence ?? current.evidence,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.status === "running" ? { startedAt: now } : {}),
      ...(input.status === "completed" ? { completedAt: now } : {}),
      updatedAt: now,
    });
    this.#transaction((_events, planEvents) => {
      this.#database.prepare(`
        UPDATE plan_step_states
        SET status = ?, summary = ?, evidence_json = ?, reason = ?,
          started_at = ?, completed_at = ?, updated_at = ?
        WHERE plan_id = ? AND revision = ? AND step_id = ?
      `).run(
        next.status,
        next.summary ?? null,
        JSON.stringify(next.evidence),
        next.reason ?? null,
        next.startedAt ?? null,
        next.completedAt ?? null,
        next.updatedAt,
        planId,
        input.revision,
        input.stepId,
      );
      const type: PlanEventType = input.status === "running"
        ? "plan.step_started"
        : input.status === "completed"
          ? "plan.step_completed"
          : "plan.step_blocked";
      planEvents.push(this.#appendPlanEvent(
        planId,
        type,
        { revision: input.revision, stepId: input.stepId, ...(input.reason ? { reason: input.reason } : {}) },
        input.taskId,
        input.runId,
      ));
    });
    return next;
  }

  abandonPlan(planId: string): PlanRecord {
    const plan = this.#requirePlan(planId);
    if (plan.status === "completed" || plan.status === "abandoned") {
      throw new Error("计划已经结束");
    }
    const now = new Date().toISOString();
    this.#transaction((_events, planEvents) => {
      this.#database.prepare(
        "UPDATE plans SET status = 'abandoned', updated_at = ? WHERE id = ?",
      ).run(now, planId);
      planEvents.push(this.#appendPlanEvent(
        planId,
        "plan.abandoned",
        {},
        plan.executionTaskId,
      ));
    });
    return this.#requirePlan(planId);
  }

  createRun(taskId: string, runnerId = "local"): RunRecord {
    const task = this.#requireTask(taskId);
    if (task.status !== "queued") {
      throw new Error(`任务 ${taskId} 当前状态为 ${task.status}，不能启动`);
    }
    this.#assertPlanExecutionApproved(task);
    const attemptRow = this.#database.prepare(
      "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM runs WHERE task_id = ?",
    ).get(taskId) as { attempt: number };
    const run = runRecordSchema.parse({
      id: randomUUID(),
      taskId,
      attempt: attemptRow.attempt,
      status: "starting",
      runnerId,
      inputTokens: 0,
      outputTokens: 0,
      toolCallCount: 0,
    });
    this.#transaction((events) => {
      this.#database.prepare(`
        INSERT INTO runs (
          id, task_id, attempt, status, session_id, runner_id,
          model_provider, model_id, started_at, finished_at, error,
          result_summary, input_tokens, output_tokens, tool_call_count
        ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0)
      `).run(run.id, run.taskId, run.attempt, run.status, run.runnerId);
      const now = new Date().toISOString();
      this.#database.prepare(`
        UPDATE tasks
        SET status = 'running', current_run_id = ?, updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(run.id, now, taskId);
      events.push(this.#appendEvent(taskId, "run.created", {
        attempt: run.attempt,
        runnerId,
      }, run.id));
      events.push(this.#appendEvent(taskId, "task.started", {}, run.id));
    });
    return run;
  }

  bindRun(
    taskId: string,
    runId: string,
    input: { sessionId: string; modelProvider?: string; modelId?: string },
  ): RunRecord {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    this.#assertRunTransition(run.status, "running");
    const now = new Date().toISOString();
    this.#transaction((events, planEvents) => {
      this.#database.prepare(`
        UPDATE runs
        SET status = 'running', session_id = ?, model_provider = ?,
            model_id = ?, started_at = ?
        WHERE id = ? AND task_id = ?
      `).run(
        input.sessionId,
        input.modelProvider ?? null,
        input.modelId ?? null,
        now,
        runId,
        taskId,
      );
      this.#database.prepare(
        "UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?",
      ).run(input.sessionId, now, taskId);
      events.push(this.#appendEvent(taskId, "run.started", {}, runId, input.sessionId));
      if (task.kind === "plan-execution" && task.planId) {
        const plan = this.#requirePlan(task.planId);
        if (plan.status !== "approved") throw new Error("计划尚未批准");
        this.#database.prepare(`
          UPDATE plans
          SET status = 'executing', executing_revision = approved_revision, updated_at = ?
          WHERE id = ?
        `).run(now, plan.id);
        planEvents.push(this.#appendPlanEvent(
          plan.id,
          "plan.execution_started",
          { revision: plan.approvedRevision },
          taskId,
          runId,
        ));
      }
    });
    return this.#requireRun(runId);
  }

  setWaiting(
    taskId: string,
    runId: string,
    kind: "approval" | "user_input",
    waiting: boolean,
  ): void {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    const waitingTask: TaskStatus = kind === "approval" ? "waiting_approval" : "waiting_user";
    const waitingRun: RunStatus = kind === "approval" ? "waiting_approval" : "waiting_user";
    const nextTask: TaskStatus = waiting ? waitingTask : "running";
    const nextRun: RunStatus = waiting ? waitingRun : "running";
    if (task.status === nextTask && run.status === nextRun) return;
    this.#assertTaskTransition(task.status, nextTask);
    this.#assertRunTransition(run.status, nextRun);
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
      ).run(nextTask, now, taskId);
      this.#database.prepare(
        "UPDATE runs SET status = ? WHERE id = ? AND task_id = ?",
      ).run(nextRun, runId, taskId);
      events.push(this.#appendEvent(
        taskId,
        waiting
          ? kind === "approval" ? "task.waiting_approval" : "task.waiting_user"
          : "task.resumed",
        {},
        runId,
        task.sessionId,
      ));
    });
  }

  finishRun(
    taskId: string,
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "interrupted",
    error?: string,
    resultSummary?: string,
  ): void {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    if (isTerminalTaskStatus(task.status) || isTerminalRunStatus(run.status)) return;
    this.#assertTaskTransition(task.status, status);
    this.#assertRunTransition(run.status, status);
    const plan = task.kind === "plan-execution" && task.planId
      ? this.#requirePlan(task.planId)
      : undefined;
    if (plan && status === "succeeded") {
      const revision = plan.executingRevision ?? plan.approvedRevision;
      if (!revision) throw new Error("计划没有可完成的执行版本");
      const states = this.#listPlanStepStates(plan.id, revision);
      if (states.some((state) => state.status !== "completed" && state.status !== "skipped")) {
        throw new Error("计划仍有未完成步骤");
      }
    }
    const now = new Date().toISOString();
    const runEvent: TaskEventType = status === "succeeded"
      ? "run.completed"
      : status === "failed"
        ? "run.failed"
        : status === "cancelled"
          ? "run.cancelled"
          : "run.interrupted";
    this.#transaction((events, planEvents) => {
      this.#database.prepare(`
        UPDATE runs
        SET status = ?, finished_at = ?, error = ?, result_summary = ?
        WHERE id = ? AND task_id = ?
      `).run(status, now, error ?? null, resultSummary ?? null, runId, taskId);
      this.#database.prepare(`
        UPDATE tasks
        SET status = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(status, now, now, taskId);
      this.#cancelPendingRequests(taskId, now);
      const payload = {
        ...(error ? { error } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      };
      events.push(this.#appendEvent(taskId, runEvent, payload, runId, task.sessionId));
      events.push(this.#appendEvent(
        taskId,
        `task.${status}` as TaskEventType,
        payload,
        runId,
        task.sessionId,
      ));
      if (plan && (plan.status === "executing" || plan.status === "approved")) {
        const planStatus: PlanStatus = status === "succeeded"
          ? "completed"
          : status === "cancelled"
            ? "abandoned"
            : "approved";
        this.#database.prepare(`
          UPDATE plans
          SET status = ?, executing_revision = NULL, updated_at = ?
          WHERE id = ?
        `).run(planStatus, now, plan.id);
        const planEventType: PlanEventType = status === "succeeded"
          ? "plan.completed"
          : status === "cancelled"
            ? "plan.abandoned"
            : "plan.execution_failed";
        planEvents.push(this.#appendPlanEvent(
          plan.id,
          planEventType,
          { taskStatus: status, ...(error ? { error } : {}) },
          taskId,
          runId,
        ));
      }
    });
  }

  pauseQueuedTask(taskId: string): void {
    const task = this.#requireTask(taskId);
    if (task.status === "paused") return;
    if (task.status !== "queued") throw new Error("只有排队任务可以直接暂停");
    this.#assertTaskTransition(task.status, "paused");
    this.#transitionTaskOnly(task, "paused", "task.paused");
  }

  requestPause(taskId: string): void {
    const task = this.#requireTask(taskId);
    if (!["running", "waiting_approval", "waiting_user", "waiting_workers"].includes(
      task.status,
    )) {
      throw new Error("任务当前不能暂停");
    }
    this.#transaction((events) => {
      events.push(this.#appendEvent(
        task.id,
        "task.pause_requested",
        {},
        task.currentRunId,
        task.sessionId,
      ));
    });
  }

  finishPausedRun(taskId: string, runId: string): void {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    if (task.status === "paused") return;
    this.#assertTaskTransition(task.status, "paused");
    this.#assertRunTransition(run.status, "interrupted");
    const now = new Date().toISOString();
    this.#transaction((events, planEvents) => {
      this.#database.prepare(`
        UPDATE runs SET status = 'interrupted', finished_at = ?, error = ?
        WHERE id = ? AND task_id = ?
      `).run(now, "任务由用户暂停", runId, taskId);
      this.#database.prepare(`
        UPDATE tasks SET status = 'paused', updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(now, taskId);
      this.#cancelPendingRequests(taskId, now);
      events.push(this.#appendEvent(
        taskId,
        "run.interrupted",
        { reason: "paused" },
        runId,
        task.sessionId,
      ));
      events.push(this.#appendEvent(
        taskId,
        "task.paused",
        {},
        runId,
        task.sessionId,
      ));
      if (task.kind === "plan-execution" && task.planId) {
        const plan = this.#requirePlan(task.planId);
        if (plan.status === "abandoned") return;
        this.#database.prepare(`
          UPDATE plans
          SET status = ?, executing_revision = NULL, updated_at = ?
          WHERE id = ?
        `).run("approved", now, plan.id);
        planEvents.push(this.#appendPlanEvent(
          plan.id,
          "plan.execution_paused",
          { replan: false },
          taskId,
          runId,
        ));
      }
    });
  }

  finishReplanPausedRun(
    taskId: string,
    runId: string,
    input: ReplanInput,
    checkpoint: PromptExecutionInput,
  ): TaskRecord {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    const validated = this.validateReplan(taskId, runId, input);
    this.#assertTaskTransition(task.status, "paused");
    this.#assertRunTransition(run.status, "interrupted");
    const now = new Date().toISOString();
    let planningTask: TaskRecord;
    this.#transaction((events, planEvents) => {
      this.#database.prepare(`
        UPDATE runs SET status = 'interrupted', finished_at = ?, error = ?
        WHERE id = ? AND task_id = ?
      `).run(now, "计划需要重新规划", runId, taskId);
      this.#database.prepare(`
        UPDATE tasks SET status = 'paused', updated_at = ?, completed_at = NULL
        WHERE id = ?
      `).run(now, taskId);
      this.#cancelPendingRequests(taskId, now);
      events.push(this.#appendEvent(
        taskId,
        "task.pause_requested",
        { reason: "replan" },
        runId,
        task.sessionId,
      ));
      events.push(this.#appendEvent(
        taskId,
        "run.interrupted",
        { reason: "replan" },
        runId,
        task.sessionId,
      ));
      events.push(this.#appendEvent(
        taskId,
        "task.paused",
        { reason: "replan" },
        runId,
        task.sessionId,
      ));
      const states = this.#listPlanStepStates(
        validated.plan.id,
        validated.revision.revision,
      );
      for (const state of states.filter(
        (candidate) =>
          (candidate.status === "running" || candidate.status === "blocked")
          && validated.affectedStepIds.includes(candidate.stepId),
      )) {
        this.#database.prepare(`
          UPDATE plan_step_states
          SET status = 'blocked', reason = ?, evidence_json = ?, updated_at = ?
          WHERE plan_id = ? AND revision = ? AND step_id = ?
        `).run(
          input.reason,
          JSON.stringify(input.evidence ?? state.evidence),
          now,
          validated.plan.id,
          validated.revision.revision,
          state.stepId,
        );
        planEvents.push(this.#appendPlanEvent(
          validated.plan.id,
          "plan.step_blocked",
          {
            revision: validated.revision.revision,
            stepId: state.stepId,
            reason: input.reason,
          },
          taskId,
          runId,
        ));
      }
      this.#database.prepare(`
        UPDATE plans
        SET status = 'draft', executing_revision = NULL, replan_reason = ?,
            affected_step_ids_json = ?, replan_evidence_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.reason,
        JSON.stringify(validated.affectedStepIds),
        JSON.stringify(input.evidence ?? []),
        now,
        validated.plan.id,
      );
      planEvents.push(this.#appendPlanEvent(
        validated.plan.id,
        "plan.replan_requested",
        {
          feedback: input.reason,
          reason: input.reason,
          affectedStepIds: validated.affectedStepIds,
          evidence: input.evidence ?? [],
        },
        taskId,
        runId,
      ));
      planEvents.push(this.#appendPlanEvent(
        validated.plan.id,
        "plan.execution_paused",
        { replan: true },
        taskId,
        runId,
      ));
      planningTask = this.#insertTask({
        workspaceId: task.workspaceId,
        ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}),
        kind: "planning",
        title: input.title ?? `修订计划：${validated.plan.goal.slice(0, 42)}`,
        goal: validated.plan.goal,
        planId: validated.plan.id,
        execution: {
          ...checkpoint,
          preferFork: true,
          interactionMode: "plan",
          planId: validated.plan.id,
          planRevision: validated.plan.currentRevision,
          deliveryMode: input.deliveryMode ?? "foreground",
        },
      }, events);
    });
    return planningTask!;
  }

  requeueTask(taskId: string, expected: "paused" | "failed" | "interrupted"): void {
    const task = this.#requireTask(taskId);
    if (task.status !== expected) throw new Error(`任务当前状态不是 ${expected}`);
    this.#assertPlanExecutionApproved(task);
    this.#assertTaskTransition(task.status, "queued");
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE tasks
        SET status = 'queued', updated_at = ?, completed_at = NULL, current_run_id = NULL
        WHERE id = ?
      `).run(now, taskId);
      events.push(this.#appendEvent(taskId, "task.resumed", { from: expected }));
      events.push(this.#appendEvent(taskId, "task.queued", { from: expected }));
    });
  }

  promoteTask(taskId: string): void {
    const task = this.#requireTask(taskId);
    if (task.kind === "background") return;
    if (isTerminalTaskStatus(task.status)) throw new Error("终态任务不能转到后台");
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(
        `UPDATE tasks
         SET kind = 'background', delivery_mode = 'background', updated_at = ?
         WHERE id = ?`,
      ).run(now, taskId);
      events.push(this.#appendEvent(
        taskId,
        "task.promoted",
        {},
        task.currentRunId,
        task.sessionId,
      ));
    });
  }

  cancelInactiveTask(taskId: string): void {
    const task = this.#requireTask(taskId);
    if (task.status === "cancelled") return;
    if (task.status !== "queued" && task.status !== "paused") {
      throw new Error(`任务 ${taskId} 当前状态不能直接取消`);
    }
    this.#assertTaskTransition(task.status, "cancelled");
    if (task.kind === "plan-execution" && task.planId) {
      const plan = this.#requirePlan(task.planId);
      const now = new Date().toISOString();
      this.#transaction((events, planEvents) => {
        this.#database.prepare(`
          UPDATE tasks SET status = 'cancelled', updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(now, now, task.id);
        this.#cancelPendingRequests(task.id, now);
        events.push(this.#appendEvent(
          task.id,
          "task.cancelled",
          {},
          task.currentRunId,
          task.sessionId,
        ));
        this.#database.prepare(`
          UPDATE plans
          SET status = 'abandoned', executing_revision = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, plan.id);
        planEvents.push(this.#appendPlanEvent(
          plan.id,
          "plan.abandoned",
          {},
          task.id,
          task.currentRunId,
        ));
      });
      return;
    }
    this.#transitionTaskOnly(task, "cancelled", "task.cancelled", true);
  }

  validateReplan(taskId: string, runId: string, input: ReplanInput): ValidatedReplan {
    const task = this.#requireTask(taskId);
    const plan = this.#requirePlan(input.planId);
    const revisionNumber = plan.executingRevision ?? plan.approvedRevision;
    if (
      task.kind !== "plan-execution"
      || task.planId !== plan.id
      || task.currentRunId !== runId
      || !revisionNumber
      || (
        plan.status !== "executing"
        && !(input.mode === "revision" && plan.status === "approved")
      )
    ) {
      throw new Error("只能为当前执行中的计划请求重新规划");
    }
    const revision = this.#requirePlanRevision(plan.id, revisionNumber);
    const states = this.#listPlanStepStates(plan.id, revisionNumber);
    const knownIds = new Set(revision.steps.map((step) => step.id));
    if (input.affectedStepIds.some((id) => !knownIds.has(id))) {
      throw new Error("受影响步骤包含未知 Step ID");
    }
    const activeSteps = states.filter(
      (state) => state.status === "running" || state.status === "blocked",
    );
    if (
      activeSteps.length === 0
      && !(input.mode === "revision" && plan.status === "approved")
    ) {
      throw new Error("当前没有正在执行或阻塞的步骤");
    }
    const affected = input.affectedStepIds.length > 0
      ? new Set(input.affectedStepIds)
      : new Set(activeSteps.map((state) => state.stepId));
    if (
      activeSteps.length > 0
      && !activeSteps.some((state) => affected.has(state.stepId))
    ) {
      throw new Error("受影响步骤必须包含当前执行或阻塞的步骤");
    }
    return {
      plan,
      revision,
      affectedStepIds: [...affected],
      blockSteps: activeSteps.length > 0,
    };
  }

  createRequest(input: {
    id: string;
    taskId: string;
    runId: string;
    kind: TaskRequestKind;
    title: string;
    description?: string;
    payload?: Record<string, unknown>;
  }): TaskRequestRecord {
    const existing = this.getRequest(input.id);
    if (existing) return existing;
    const request = taskRequestRecordSchema.parse({
      id: input.id,
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      status: "pending",
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    });
    this.#transaction((events) => {
      this.#database.prepare(`
        INSERT INTO task_requests (
          id, task_id, run_id, kind, status, title, description,
          payload_json, response_json, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        request.id,
        request.taskId,
        request.runId,
        request.kind,
        request.status,
        request.title,
        request.description ?? null,
        JSON.stringify(request.payload),
        request.createdAt,
      );
      if (request.kind === "user_input") {
        events.push(this.#appendEvent(
          request.taskId,
          "user_input.requested",
          { requestId: request.id, title: request.title },
          request.runId,
        ));
      }
    });
    return request;
  }

  getRequest(id: string): TaskRequestRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM task_requests WHERE id = ?",
    ).get(id) as unknown as RequestRow | undefined;
    return row ? rowToRequest(row) : undefined;
  }

  resolveRequest(
    id: string,
    response: unknown,
    status: "resolved" | "cancelled" | "expired" = "resolved",
  ): TaskRequestRecord | undefined {
    const request = this.getRequest(id);
    if (!request || request.status !== "pending") return request;
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE task_requests
        SET status = ?, response_json = ?, resolved_at = ?
        WHERE id = ?
      `).run(status, JSON.stringify(response), now, id);
      if (request.kind === "user_input" && status === "resolved") {
        events.push(this.#appendEvent(
          request.taskId,
          "user_input.resolved",
          { requestId: request.id },
          request.runId,
        ));
      }
    });
    return this.getRequest(id);
  }

  pendingRequestCount(taskId: string, kind?: TaskRequestKind): number {
    const row = kind
      ? this.#database.prepare(`
          SELECT COUNT(*) AS count FROM task_requests
          WHERE task_id = ? AND kind = ? AND status = 'pending'
        `).get(taskId, kind)
      : this.#database.prepare(`
          SELECT COUNT(*) AS count FROM task_requests
          WHERE task_id = ? AND status = 'pending'
        `).get(taskId);
    return (row as { count: number }).count;
  }

  createArtifact(input: {
    taskId: string;
    runId: string;
    kind: ArtifactKind;
    title: string;
    uri?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): ArtifactRecord {
    this.#requireTask(input.taskId);
    this.#requireRun(input.runId);
    const artifact = artifactRecordSchema.parse({
      id: randomUUID(),
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      title: input.title,
      ...(input.uri ? { uri: input.uri } : {}),
      ...(input.content ? { content: input.content } : {}),
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    });
    this.#transaction((events) => {
      this.#database.prepare(`
        INSERT INTO artifacts (
          id, task_id, run_id, kind, title, uri, content, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.taskId,
        artifact.runId,
        artifact.kind,
        artifact.title,
        artifact.uri ?? null,
        artifact.content ?? null,
        JSON.stringify(artifact.metadata),
        artifact.createdAt,
      );
      events.push(this.#appendEvent(
        artifact.taskId,
        "artifact.created",
        { artifactId: artifact.id, kind: artifact.kind, title: artifact.title },
        artifact.runId,
      ));
    });
    return artifact;
  }

  recoverInterrupted(): number {
    const tasks = this.#database.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('running', 'waiting_approval', 'waiting_user', 'waiting_workers')
      ORDER BY created_at ASC
    `).all() as unknown as TaskRow[];
    for (const row of tasks) {
      const task = rowToTask(row);
      const runId = task.currentRunId;
      const now = new Date().toISOString();
      this.#transaction((events, planEvents) => {
        if (runId) {
          this.#database.prepare(`
            UPDATE runs
            SET status = 'interrupted', finished_at = ?,
                error = COALESCE(error, '应用在任务运行期间退出')
            WHERE id = ? AND status IN (
              'queued', 'starting', 'running', 'waiting_approval', 'waiting_user',
              'waiting_workers'
            )
          `).run(now, runId);
          events.push(this.#appendEvent(
            task.id,
            "run.interrupted",
            { error: "应用在任务运行期间退出" },
            runId,
            task.sessionId,
          ));
        }
        this.#database.prepare(`
          UPDATE tasks
          SET status = 'interrupted', updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(now, now, task.id);
        this.#cancelPendingRequests(task.id, now);
        events.push(this.#appendEvent(
          task.id,
          "task.interrupted",
          { error: "应用在任务运行期间退出" },
          runId,
          task.sessionId,
        ));
        if (task.kind === "plan-execution" && task.planId) {
          const plan = this.#getPlanRecord(task.planId);
          if (plan?.status === "executing") {
            this.#database.prepare(`
              UPDATE plans
              SET status = 'approved', executing_revision = NULL, updated_at = ?
              WHERE id = ?
            `).run(now, plan.id);
            planEvents.push(this.#appendPlanEvent(
              plan.id,
              "plan.execution_failed",
              { taskStatus: "interrupted", error: "应用在任务运行期间退出" },
              task.id,
              runId,
            ));
          }
        }
      });
    }
    return tasks.length;
  }

  countActive(): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE status IN ('running', 'waiting_approval', 'waiting_user', 'waiting_workers')
    `).get() as { count: number };
    return row.count;
  }

  hasNonTerminalForSession(workspaceId: string, sessionId: string): boolean {
    const row = this.#database.prepare(`
      SELECT 1 AS found FROM tasks
      WHERE workspace_id = ? AND session_id = ?
        AND status IN (
          'queued', 'running', 'waiting_approval', 'waiting_user',
          'waiting_workers', 'paused'
        )
      LIMIT 1
    `).get(workspaceId, sessionId) as { found: number } | undefined;
    return row !== undefined;
  }

  close(): void {
    this.#database.close();
  }

  #summaryFor(task: TaskRecord): TaskSummary {
    const currentRun = task.currentRunId
      ? this.#database.prepare("SELECT * FROM runs WHERE id = ?")
          .get(task.currentRunId) as unknown as RunRow | undefined
      : undefined;
    const latestRun = currentRun ?? this.#database.prepare(`
      SELECT * FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1
    `).get(task.id) as unknown as RunRow | undefined;
    const workers = this.#database.prepare(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status IN (
          'succeeded', 'failed', 'cancelled', 'interrupted'
        ) THEN 1 ELSE 0 END), 0) AS completed
      FROM tasks WHERE parent_task_id = ? AND kind = 'worker'
    `).get(task.id) as { count: number; completed: number };
    const budget = this.getTaskBudget(task.id);
    const workerPlanStepId = task.kind === "worker"
      ? this.getExecution(task.id).workerContext?.plan?.stepId
      : undefined;
    return taskSummarySchema.parse({
      task,
      ...(currentRun ? { currentRun: rowToRun(currentRun) } : {}),
      pendingRequestCount: this.pendingRequestCount(task.id),
      ...(latestRun?.result_summary ? { resultSummary: latestRun.result_summary } : {}),
      ...(latestRun?.error ? { error: latestRun.error } : {}),
      workerCount: workers.count,
      completedWorkerCount: workers.completed,
      ...(workerPlanStepId ? { workerPlanStepId } : {}),
      ...(budget ? { budgetUsage: budget.usage } : {}),
      ...(task.planId ? { planContext: this.#planContextFor(task.planId) } : {}),
    });
  }

  #planContextFor(planId: string): TaskPlanContext {
    const plan = this.#requirePlan(planId);
    const revision = this.#requirePlanRevision(plan.id, plan.currentRevision);
    const states = this.#listPlanStepStates(plan.id, plan.currentRevision);
    const stateById = new Map(states.map((state) => [state.stepId, state]));
    const currentStep = revision.steps.find((step) => {
      const status = stateById.get(step.id)?.status;
      return status === "running" || status === "blocked";
    });
    return {
      planId: plan.id,
      status: plan.status,
      currentRevision: plan.currentRevision,
      ...(plan.approvedRevision ? { approvedRevision: plan.approvedRevision } : {}),
      completedSteps: states.filter(
        (state) => state.status === "completed" || state.status === "skipped",
      ).length,
      totalSteps: revision.steps.length,
      ...(currentStep ? { currentStep } : {}),
      ...(plan.replanReason ? { replanReason: plan.replanReason } : {}),
    };
  }

  #transitionTaskOnly(
    task: TaskRecord,
    status: TaskStatus,
    eventType: TaskEventType,
    terminal = false,
  ): void {
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(status, now, terminal ? now : null, task.id);
      if (terminal) this.#cancelPendingRequests(task.id, now);
      events.push(this.#appendEvent(
        task.id,
        eventType,
        {},
        task.currentRunId,
        task.sessionId,
      ));
    });
  }

  #cancelPendingRequests(taskId: string, now: string): void {
    this.#database.prepare(`
      UPDATE task_requests
      SET status = 'cancelled', resolved_at = ?
      WHERE task_id = ? AND status = 'pending'
    `).run(now, taskId);
  }

  #requireTask(id: string): TaskRecord {
    const task = this.getTask(id);
    if (!task) throw new Error(`未找到任务: ${id}`);
    return task;
  }

  #findNonTerminalPlanningTask(planId: string): TaskRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM tasks
      WHERE plan_id = ? AND kind = 'planning'
        AND status IN (
          'queued', 'running', 'waiting_approval', 'waiting_user',
          'waiting_workers', 'paused'
        )
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(planId) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  #assertPlanExecutionApproved(task: TaskRecord): void {
    if (task.kind !== "plan-execution" || !task.planId) return;
    const plan = this.#requirePlan(task.planId);
    if (plan.status !== "approved" || !plan.approvedRevision) {
      throw new Error("计划必须完成修订并重新批准后才能恢复执行");
    }
  }

  #requireRun(id: string): RunRecord {
    const row = this.#database.prepare(
      "SELECT * FROM runs WHERE id = ?",
    ).get(id) as unknown as RunRow | undefined;
    if (!row) throw new Error(`未找到运行: ${id}`);
    return rowToRun(row);
  }

  #assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
    if (!taskTransitions[from].has(to)) {
      throw new Error(`非法任务状态转换: ${from} -> ${to}`);
    }
  }

  #assertRunTransition(from: RunStatus, to: RunStatus): void {
    if (!runTransitions[from].has(to)) {
      throw new Error(`非法运行状态转换: ${from} -> ${to}`);
    }
  }

  #getPlanRecord(id: string): PlanRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM plans WHERE id = ?",
    ).get(id) as unknown as PlanRow | undefined;
    return row ? rowToPlan(row) : undefined;
  }

  #requirePlan(id: string): PlanRecord {
    const plan = this.#getPlanRecord(id);
    if (!plan) throw new Error(`未找到计划: ${id}`);
    return plan;
  }

  #requirePlanRevision(planId: string, revision: number): PlanRevisionRecord {
    const row = this.#database.prepare(`
      SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?
    `).get(planId, revision) as unknown as PlanRevisionRow | undefined;
    if (!row) throw new Error(`未找到计划版本: ${planId}@${revision}`);
    return rowToPlanRevision(row);
  }

  #listPlanStepStates(planId: string, revision: number): PlanStepState[] {
    const rows = this.#database.prepare(`
      SELECT * FROM plan_step_states
      WHERE plan_id = ? AND revision = ? ORDER BY step_id ASC
    `).all(planId, revision) as unknown as PlanStepStateRow[];
    return rows.map(rowToPlanStepState);
  }

  #insertPlanRevision(revision: PlanRevisionRecord): void {
    this.#database.prepare(`
      INSERT INTO plan_revisions (
        plan_id, revision, feedback, assumptions_json, constraints_json,
        steps_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.planId,
      revision.revision,
      revision.feedback ?? null,
      JSON.stringify(revision.assumptions),
      JSON.stringify(revision.constraints),
      JSON.stringify(revision.steps),
      revision.createdAt,
    );
  }

  #initializePlanStepStates(
    revision: PlanRevisionRecord,
    previous?: PlanRevisionRecord,
    previousStates: PlanStepState[] = [],
  ): void {
    const now = new Date().toISOString();
    const previousSteps = new Map(previous?.steps.map((step) => [step.id, step]) ?? []);
    const previousStateById = new Map(previousStates.map((state) => [state.stepId, state]));
    const insert = this.#database.prepare(`
      INSERT INTO plan_step_states (
        plan_id, revision, step_id, status, summary, evidence_json, reason,
        started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const step of revision.steps) {
      const oldStep = previousSteps.get(step.id);
      const oldState = previousStateById.get(step.id);
      const preserved = oldStep
        && oldState?.status === "completed"
        && JSON.stringify(oldStep) === JSON.stringify(step);
      insert.run(
        revision.planId,
        revision.revision,
        step.id,
        preserved ? "completed" : "pending",
        preserved ? oldState.summary ?? null : null,
        JSON.stringify(preserved ? oldState.evidence : []),
        null,
        preserved ? oldState.startedAt ?? null : null,
        preserved ? oldState.completedAt ?? null : null,
        now,
      );
    }
  }

  #insertTask(input: {
    id?: string;
    workspaceId: string;
    workspacePath?: string;
    kind: TaskKind;
    title: string;
    goal: string;
    execution: TaskExecutionInput;
    priority?: number;
    planId?: string;
    parentTaskId?: string;
    rootTaskId?: string;
    assignedProfile?: string;
  }, events: TaskEvent[]): TaskRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const task = taskRecordSchema.parse({
      id,
      workspaceId: input.workspaceId,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      rootTaskId: input.rootTaskId ?? id,
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      kind: input.kind,
      title: input.title.trim(),
      goal: input.goal.trim(),
      status: "queued",
      priority: input.priority ?? 0,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.assignedProfile ? { assignedProfile: input.assignedProfile } : {}),
      createdAt: now,
      updatedAt: now,
    });
    this.#database.prepare(`
      INSERT INTO tasks (
        id, workspace_id, workspace_path, root_task_id, parent_task_id, kind,
        title, goal, status, priority, session_id, plan_id, current_run_id,
        assigned_profile, execution_json, delivery_mode, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL)
    `).run(
      task.id,
      task.workspaceId,
      task.workspacePath ?? null,
      task.rootTaskId,
      task.parentTaskId ?? null,
      task.kind,
      task.title,
      task.goal,
      task.priority,
      task.planId ?? null,
      task.assignedProfile ?? null,
      JSON.stringify(promptExecutionInputSchema.parse(input.execution)),
      promptExecutionInputSchema.parse(input.execution).deliveryMode ?? "foreground",
      task.createdAt,
      task.updatedAt,
    );
    events.push(this.#appendEvent(task.id, "task.created", {
      kind: task.kind,
      title: task.title,
      ...(task.planId ? { planId: task.planId } : {}),
    }));
    events.push(this.#appendEvent(task.id, "task.queued", {
      ...(task.planId ? { planId: task.planId } : {}),
    }));
    return task;
  }

  #transaction<T>(
    operation: (events: TaskEvent[], planEvents: PlanEvent[]) => T,
  ): T {
    const events: TaskEvent[] = [];
    const planEvents: PlanEvent[] = [];
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(events, planEvents);
      this.#database.exec("COMMIT");
      for (const event of events) {
        for (const listener of this.#listeners) listener(event);
      }
      for (const event of planEvents) {
        for (const listener of this.#planListeners) listener(event);
      }
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #appendPlanEvent(
    planId: string,
    type: PlanEventType,
    payload: Record<string, unknown>,
    taskId?: string,
    runId?: string,
  ): PlanEvent {
    const sequenceRow = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM plan_events WHERE plan_id = ?
    `).get(planId) as { sequence: number };
    const event = planEventSchema.parse({
      eventId: randomUUID(),
      planId,
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
      timestamp: new Date().toISOString(),
      sequence: sequenceRow.sequence,
      type,
      payload,
    });
    this.#database.prepare(`
      INSERT INTO plan_events (
        event_id, plan_id, task_id, run_id, timestamp, sequence, type, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.planId,
      event.taskId ?? null,
      event.runId ?? null,
      event.timestamp,
      event.sequence,
      event.type,
      JSON.stringify(event.payload),
    );
    return event;
  }

  #appendEvent(
    taskId: string,
    type: TaskEventType,
    payload: Record<string, unknown>,
    runId?: string,
    sessionId?: string,
  ): TaskEvent {
    const sequenceRow = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM task_events WHERE task_id = ?
    `).get(taskId) as { sequence: number };
    const event = taskEventSchema.parse({
      eventId: randomUUID(),
      taskId,
      ...(runId ? { runId } : {}),
      ...(sessionId ? { sessionId } : {}),
      timestamp: new Date().toISOString(),
      sequence: sequenceRow.sequence,
      type,
      payload,
    });
    this.#database.prepare(`
      INSERT INTO task_events (
        event_id, task_id, run_id, session_id, timestamp, sequence, type, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.taskId,
      event.runId ?? null,
      event.sessionId ?? null,
      event.timestamp,
      event.sequence,
      event.type,
      JSON.stringify(event.payload),
    );
    return event;
  }

  #migrate(): void {
    const { user_version: version } = this.#database.prepare(
      "PRAGMA user_version",
    ).get() as { user_version: number };
    if (version === 0) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          workspace_path TEXT,
          root_task_id TEXT NOT NULL,
          parent_task_id TEXT REFERENCES tasks(id),
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          plan_id TEXT,
          current_run_id TEXT,
          assigned_profile TEXT,
          execution_json TEXT NOT NULL,
          delivery_mode TEXT NOT NULL DEFAULT 'foreground',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX tasks_workspace_schedule_idx
          ON tasks(workspace_id, status, priority DESC, created_at ASC);
        CREATE INDEX tasks_workspace_updated_idx
          ON tasks(workspace_id, updated_at DESC);
        CREATE INDEX tasks_global_schedule_idx
          ON tasks(status, priority DESC, created_at ASC);
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          runner_id TEXT NOT NULL,
          model_provider TEXT,
          model_id TEXT,
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          result_summary TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          UNIQUE(task_id, attempt)
        );
        CREATE INDEX runs_task_attempt_idx ON runs(task_id, attempt);
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          uri TEXT,
          content TEXT,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX artifacts_task_created_idx ON artifacts(task_id, created_at);
        CREATE TABLE task_events (
          event_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          session_id TEXT,
          timestamp TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(task_id, sequence)
        );
        CREATE INDEX task_events_task_sequence_idx
          ON task_events(task_id, sequence);
        CREATE TABLE task_requests (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          payload_json TEXT NOT NULL,
          response_json TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX task_requests_pending_idx
          ON task_requests(task_id, status, created_at);
        CREATE TABLE plans (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          workspace_path TEXT,
          session_id TEXT NOT NULL,
          planning_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          execution_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          current_revision INTEGER NOT NULL,
          approved_revision INTEGER,
          executing_revision INTEGER,
          replan_reason TEXT,
          affected_step_ids_json TEXT NOT NULL DEFAULT '[]',
          replan_evidence_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX plans_workspace_updated_idx
          ON plans(workspace_id, updated_at DESC);
        CREATE INDEX plans_status_updated_idx
          ON plans(status, updated_at DESC);
        CREATE TABLE plan_revisions (
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          feedback TEXT,
          assumptions_json TEXT NOT NULL,
          constraints_json TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(plan_id, revision)
        );
        CREATE TABLE plan_step_states (
          plan_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          step_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          evidence_json TEXT NOT NULL,
          reason TEXT,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(plan_id, revision, step_id),
          FOREIGN KEY(plan_id, revision)
            REFERENCES plan_revisions(plan_id, revision) ON DELETE CASCADE
        );
        CREATE TABLE plan_events (
          event_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          timestamp TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(plan_id, sequence)
        );
        CREATE INDEX plan_events_plan_sequence_idx
          ON plan_events(plan_id, sequence);
        CREATE TABLE worker_delegations (
          id TEXT PRIMARY KEY,
          parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          tool_call_id TEXT NOT NULL,
          status TEXT NOT NULL,
          context_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(parent_run_id, tool_call_id)
        );
        CREATE INDEX worker_delegations_parent_idx
          ON worker_delegations(parent_task_id, created_at);
        CREATE TABLE worker_delegation_tasks (
          delegation_id TEXT NOT NULL REFERENCES worker_delegations(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY(delegation_id, task_id),
          UNIQUE(task_id)
        );
        CREATE TABLE worker_results (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(task_id, run_id)
        );
        CREATE TABLE task_budgets (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          budget_json TEXT NOT NULL,
          workers INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          tool_calls INTEGER NOT NULL DEFAULT 0,
          warning_emitted INTEGER NOT NULL DEFAULT 0,
          exceeded INTEGER NOT NULL DEFAULT 0
        );
        PRAGMA user_version = 5;
        COMMIT;
      `);
      return;
    }
    if (version === 1) {
      this.#database.exec(`
        BEGIN;
        ALTER TABLE tasks ADD COLUMN workspace_path TEXT;
        CREATE INDEX tasks_global_schedule_idx
          ON tasks(status, priority DESC, created_at ASC);
        CREATE TABLE task_requests (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          payload_json TEXT NOT NULL,
          response_json TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX task_requests_pending_idx
          ON task_requests(task_id, status, created_at);
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    if (version === 1 || version === 2) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE plans (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          workspace_path TEXT,
          session_id TEXT NOT NULL,
          planning_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          execution_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL,
          current_revision INTEGER NOT NULL,
          approved_revision INTEGER,
          executing_revision INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX plans_workspace_updated_idx
          ON plans(workspace_id, updated_at DESC);
        CREATE INDEX plans_status_updated_idx
          ON plans(status, updated_at DESC);
        CREATE TABLE plan_revisions (
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          feedback TEXT,
          assumptions_json TEXT NOT NULL,
          constraints_json TEXT NOT NULL,
          steps_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(plan_id, revision)
        );
        CREATE TABLE plan_step_states (
          plan_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          step_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          evidence_json TEXT NOT NULL,
          reason TEXT,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(plan_id, revision, step_id),
          FOREIGN KEY(plan_id, revision)
            REFERENCES plan_revisions(plan_id, revision) ON DELETE CASCADE
        );
        CREATE TABLE plan_events (
          event_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          timestamp TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(plan_id, sequence)
        );
        CREATE INDEX plan_events_plan_sequence_idx
          ON plan_events(plan_id, sequence);
        PRAGMA user_version = 3;
        COMMIT;
      `);
    }
    if (version <= 3) {
      this.#database.exec(`
        BEGIN;
        ALTER TABLE tasks ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'foreground';
        ALTER TABLE plans ADD COLUMN replan_reason TEXT;
        ALTER TABLE plans ADD COLUMN affected_step_ids_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE plans ADD COLUMN replan_evidence_json TEXT NOT NULL DEFAULT '[]';
        UPDATE tasks
        SET delivery_mode = CASE
          WHEN kind IN ('background', 'plan-execution') THEN 'background'
          WHEN kind = 'planning' AND execution_json LIKE '%"preferFork":true%'
            THEN 'background'
          ELSE 'foreground'
        END;
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }
    if (version <= 4) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE worker_delegations (
          id TEXT PRIMARY KEY,
          parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          tool_call_id TEXT NOT NULL,
          status TEXT NOT NULL,
          context_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(parent_run_id, tool_call_id)
        );
        CREATE INDEX worker_delegations_parent_idx
          ON worker_delegations(parent_task_id, created_at);
        CREATE TABLE worker_delegation_tasks (
          delegation_id TEXT NOT NULL REFERENCES worker_delegations(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          PRIMARY KEY(delegation_id, task_id),
          UNIQUE(task_id)
        );
        CREATE TABLE worker_results (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(task_id, run_id)
        );
        CREATE TABLE task_budgets (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          budget_json TEXT NOT NULL,
          workers INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          tool_calls INTEGER NOT NULL DEFAULT 0,
          warning_emitted INTEGER NOT NULL DEFAULT 0,
          exceeded INTEGER NOT NULL DEFAULT 0
        );
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }
  }
}

interface ActiveExecution {
  taskId: string;
  runId: string;
  controller: AbortController;
  handle?: TaskExecutionHandle;
  cancelRequested: boolean;
  interruptRequested: boolean;
  pauseRequested: boolean;
  replanIntent: ReplanInput | undefined;
  replanCheckpoint: PromptExecutionInput | undefined;
  resolveReplan: ((task: TaskRecord) => void) | undefined;
  rejectReplan: ((error: Error) => void) | undefined;
  slotHeld: boolean;
  summary: string;
  startedAt: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  budgetExceeded: string | undefined;
  budgetTimer: ReturnType<typeof setTimeout> | undefined;
  completion: Promise<void>;
}

interface ResumeWaiter {
  taskId: string;
  requestId: string;
  resolve: (lease: ResumeLease | null) => void;
}

interface WorkerCompletionWaiter {
  delegationId: string;
  parentTaskId: string;
  parentRunId: string;
  results: WorkerResultEnvelope[];
  resolve: (results: WorkerResultEnvelope[]) => void;
  reject: (error: Error) => void;
}

export interface ResumeLease {
  commit(): void;
  release(): void;
}

export interface ReplanRequest {
  planningTask: Promise<TaskRecord>;
}

export interface WorkspaceAvailability {
  runnable: boolean;
  attentionReason?: "workspace_missing" | "workspace_untrusted" | "runtime_unavailable";
}

export class TaskOrchestrator {
  readonly #store: TaskStore;
  readonly #executor: TaskExecutor;
  readonly #defaultWorkspaceId: string | undefined;
  readonly #isWorkspaceAvailable: (task: TaskRecord) => boolean;
  readonly #workspaceAvailability: (task: TaskRecord) => WorkspaceAvailability;
  readonly #onEvent: ((event: TaskEvent) => void) | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #resumeWaiters: ResumeWaiter[] = [];
  readonly #workerWaiters = new Map<string, WorkerCompletionWaiter>();
  readonly #workerReady: WorkerCompletionWaiter[] = [];
  #concurrency: number;
  #started = false;
  #paused = false;
  #disposed = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: {
    store: TaskStore;
    workspaceId?: string;
    concurrency: number;
    executor: TaskExecutor;
    isWorkspaceAvailable?: (task: TaskRecord) => boolean;
    workspaceAvailability?: (task: TaskRecord) => WorkspaceAvailability;
    onEvent?: (event: TaskEvent) => void;
    recoverOnStart?: boolean;
  }) {
    this.#store = options.store;
    this.#defaultWorkspaceId = options.workspaceId;
    this.#concurrency = normalizeConcurrency(options.concurrency);
    this.#executor = options.executor;
    this.#workspaceAvailability = options.workspaceAvailability
      ?? ((task) => {
        const runnable = options.isWorkspaceAvailable?.(task) ?? true;
        return {
          runnable,
          ...(runnable ? {} : { attentionReason: "runtime_unavailable" as const }),
        };
      });
    this.#isWorkspaceAvailable = (task) => this.#workspaceAvailability(task).runnable;
    this.#onEvent = options.onEvent;
    this.#unsubscribe = this.#store.subscribe((event) => {
      this.#onEvent?.(event);
      this.#handleWorkerTaskEvent(event);
    });
    if (options.recoverOnStart !== false) this.#store.recoverInterrupted();
  }

  start(): void {
    if (this.#disposed) throw new Error("Task Orchestrator 已释放");
    this.#started = true;
    this.#paused = false;
    this.#drain();
  }

  pause(): void {
    this.#paused = true;
  }

  setConcurrency(value: number): void {
    this.#concurrency = normalizeConcurrency(value);
    this.#drain();
  }

  submitPrompt(input: {
    workspaceId?: string;
    workspacePath?: string;
    title: string;
    prompt: string;
    kind: "interactive" | "background" | "planning";
    execution: PromptExecutionInput;
    priority?: number;
    planId?: string;
  }): TaskRecord {
    if (this.#disposed) throw new Error("Task Orchestrator 已释放");
    const workspaceId = input.workspaceId ?? this.#defaultWorkspaceId;
    if (!workspaceId) throw new Error("提交任务时必须指定工作区");
    const task = this.#store.createTask({
      workspaceId,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      title: input.title,
      goal: input.prompt,
      kind: input.kind,
      execution: input.execution,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
    this.#drain();
    return task;
  }

  delegateWorkers(input: WorkerDelegationInput): Promise<WorkerResultEnvelope[]> {
    if (this.#disposed) throw new Error("Task Orchestrator 已释放");
    const active = this.#active.get(input.parentTaskId);
    if (!active || active.runId !== input.parentRunId) {
      throw new Error("父任务当前没有活动 Run");
    }
    const delegation = this.#store.delegateWorkers(input);
    const promise = new Promise<WorkerResultEnvelope[]>((resolve, reject) => {
      this.#workerWaiters.set(delegation.id, {
        delegationId: delegation.id,
        parentTaskId: delegation.parentTaskId,
        parentRunId: delegation.parentRunId,
        results: [],
        resolve,
        reject,
      });
    });
    this.#releaseSlot(active);
    this.#drain();
    return promise;
  }

  saveWorkerResult(
    taskId: string,
    runId: string,
    result: WorkerResult,
  ): WorkerResult {
    return this.#store.saveWorkerResult(taskId, runId, result);
  }

  listTaskSummaries(options: {
    statuses?: TaskStatus[];
    workspaceIds?: string[];
    query?: string;
    limit?: number;
  } = {}): TaskSummary[] {
    return this.#store.listTaskSummaries(options).map((summary) =>
      taskSummarySchema.parse({
        ...summary,
        ...this.#workspaceAvailability(summary.task),
      }));
  }

  listTasks(options: {
    statuses?: TaskStatus[];
    workspaceIds?: string[];
    query?: string;
    limit?: number;
  } = {}): TaskRecord[] {
    const scoped = options.workspaceIds
      ?? (this.#defaultWorkspaceId ? [this.#defaultWorkspaceId] : undefined);
    return this.#store.listTaskSummaries({
      ...options,
      ...(scoped ? { workspaceIds: scoped } : {}),
    }).map((summary) => summary.task);
  }

  getTask(taskId: string): TaskDetail | undefined {
    return this.#store.getTaskDetail(taskId);
  }

  hasNonTerminalForSession(workspaceId: string, sessionId: string): boolean {
    return this.#store.hasNonTerminalForSession(workspaceId, sessionId);
  }

  currentTaskForSession(
    workspaceIdOrSessionId: string,
    maybeSessionId?: string,
  ): TaskRecord | undefined {
    const workspaceId = maybeSessionId ? workspaceIdOrSessionId : this.#defaultWorkspaceId;
    const sessionId = maybeSessionId ?? workspaceIdOrSessionId;
    if (!workspaceId) return undefined;
    return this.#store.listTasks(workspaceId, {
      statuses: ["running", "waiting_approval", "waiting_user", "waiting_workers"],
      limit: 500,
    }).find((task) => task.sessionId === sessionId);
  }

  get activeRunCount(): number {
    return [...this.#active.values()].filter((active) => active.slotHeld).length;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.#store.getTask(taskId);
    if (!task) return false;
    if (isTerminalTaskStatus(task.status)) return true;
    const descendants = this.#store.listDescendantTasks(taskId)
      .filter((candidate) => !isTerminalTaskStatus(candidate.status));
    await Promise.allSettled(descendants.map((candidate) =>
      this.#cancelSingleTask(candidate.id)));
    return this.#cancelSingleTask(taskId);
  }

  async #cancelSingleTask(taskId: string): Promise<boolean> {
    const task = this.#store.getTask(taskId);
    if (!task) return false;
    if (isTerminalTaskStatus(task.status)) return true;
    if (task.status === "queued" || task.status === "paused") {
      this.#store.cancelInactiveTask(taskId);
      this.#drain();
      return true;
    }
    const active = this.#active.get(taskId);
    if (!active) return false;
    active.cancelRequested = true;
    active.controller.abort();
    await active.handle?.cancel().catch(() => undefined);
    return true;
  }

  async pauseTask(taskId: string): Promise<boolean> {
    const task = this.#store.getTask(taskId);
    if (!task) return false;
    if (task.status === "paused") return true;
    const descendants = this.#store.listDescendantTasks(taskId)
      .filter((candidate) => !isTerminalTaskStatus(candidate.status));
    await Promise.allSettled(descendants.map((candidate) =>
      this.#pauseSingleTask(candidate.id)));
    return this.#pauseSingleTask(taskId);
  }

  async #pauseSingleTask(taskId: string): Promise<boolean> {
    const task = this.#store.getTask(taskId);
    if (!task) return false;
    if (task.status === "paused") return true;
    if (task.status === "queued") {
      this.#store.pauseQueuedTask(taskId);
      return true;
    }
    const active = this.#active.get(taskId);
    if (!active) return false;
    this.#store.requestPause(taskId);
    active.pauseRequested = true;
    active.controller.abort();
    await active.handle?.cancel().catch(() => undefined);
    return true;
  }

  requestPlanRevision(
    planId: string,
    input: PlanRevisionTaskInput,
  ): ReplanRequest {
    const detail = this.#store.getPlan(planId);
    if (!detail) throw new Error("未找到计划");
    const executionTask = detail.executionTask;
    if (
      executionTask
      && ["running", "waiting_approval", "waiting_user", "waiting_workers"].includes(
        executionTask.status,
      )
    ) {
      return this.#requestActivePlanPause(executionTask.id, {
        planId,
        reason: input.feedback,
        affectedStepIds: input.affectedStepIds,
        ...(input.evidence ? { evidence: input.evidence } : {}),
        title: input.title,
        deliveryMode: input.execution.deliveryMode ?? "foreground",
        mode: "revision",
      });
    }
    return {
      planningTask: Promise.resolve(
        this.#store.createPlanRevisionTask(planId, input),
      ),
    };
  }

  requestReplan(taskId: string, input: ReplanInput): ReplanRequest | null {
    return this.#requestActivePlanPause(taskId, {
      ...input,
      mode: input.mode ?? "replan",
    });
  }

  #requestActivePlanPause(
    taskId: string,
    input: ReplanInput,
  ): ReplanRequest {
    const active = this.#active.get(taskId);
    if (!active) throw new Error("计划执行任务当前不在运行");
    if (active.replanIntent) throw new Error("计划已有正在处理的修订请求");
    this.#store.validateReplan(taskId, active.runId, input);
    const checkpoint = active.handle?.captureContext?.() ?? this.#store.getExecution(taskId);
    if (
      !checkpoint.sourceSessionFile
      || !checkpoint.sourceEntryId
      || !existsSync(checkpoint.sourceSessionFile)
    ) {
      throw new Error("计划最新 checkpoint 不可用，无法安全地重新规划");
    }
    let resolveReplan!: (task: TaskRecord) => void;
    let rejectReplan!: (error: Error) => void;
    const planningTask = new Promise<TaskRecord>((resolve, reject) => {
      resolveReplan = resolve;
      rejectReplan = reject;
    });
    void planningTask.catch(() => undefined);
    active.replanIntent = input;
    active.replanCheckpoint = checkpoint;
    active.resolveReplan = resolveReplan;
    active.rejectReplan = rejectReplan;
    active.pauseRequested = true;
    setImmediate(() => {
      void (async () => {
        try {
          await active.handle?.cancel();
          active.controller.abort();
        } catch (error) {
          active.pauseRequested = false;
          active.replanIntent = undefined;
          active.replanCheckpoint = undefined;
          const normalized = error instanceof Error ? error : new Error(String(error));
          active.rejectReplan?.(normalized);
          active.resolveReplan = undefined;
          active.rejectReplan = undefined;
        }
      })();
    });
    return { planningTask };
  }

  resumeTask(taskId: string): boolean {
    const task = this.#store.getTask(taskId);
    if (!task || (task.status !== "paused" && task.status !== "interrupted")) return false;
    this.#store.requeueTask(taskId, task.status);
    this.#markContinuation(taskId);
    this.#drain();
    return true;
  }

  retryTask(taskId: string): boolean {
    const task = this.#store.getTask(taskId);
    if (!task || task.status !== "failed") return false;
    this.#store.requeueTask(taskId, "failed");
    this.#markContinuation(taskId);
    this.#drain();
    return true;
  }

  promoteTask(taskId: string): boolean {
    if (!this.#store.getTask(taskId)) return false;
    this.#store.promoteTask(taskId);
    return true;
  }

  async acquireResumeLease(
    taskId: string,
    requestId: string,
  ): Promise<ResumeLease | null> {
    const active = this.#active.get(taskId);
    const request = this.#store.getTaskDetail(taskId)?.requests.find(
      (candidate) => candidate.id === requestId && candidate.status === "pending",
    );
    const task = this.#store.getTask(taskId);
    if (
      !active
      || !request
      || !task
      || (task.status !== "waiting_approval" && task.status !== "waiting_user")
    ) return null;
    if (active.slotHeld) return this.#createResumeLease(active, false);
    if (this.#resumeWaiters.some((waiter) => waiter.requestId === requestId)) return null;
    if (this.#heldSlots() < this.#concurrency) {
      active.slotHeld = true;
      return this.#createResumeLease(active, true);
    }
    return new Promise<ResumeLease | null>((resolve) => {
      this.#resumeWaiters.push({ taskId, requestId, resolve });
    });
  }

  handleAgentEvent(event: AgentEvent): void {
    const taskId = event.taskId;
    const runId = event.runId;
    if (!taskId || !runId) return;
    const active = this.#active.get(taskId);
    const task = this.#store.getTask(taskId);
    if (!active || !task || isTerminalTaskStatus(task.status)) return;

    if (event.type === "message.delta") {
      active.summary = `${active.summary}${event.delta}`.slice(-20_000);
      return;
    }
    if (event.type === "usage.updated") {
      this.#updateActiveUsage(
        active,
        event.inputTokens,
        event.outputTokens,
        event.toolCallCount,
      );
      return;
    }
    if (
      (event.type === "message.completed" || event.type === "tool.completed")
      && active.handle?.captureContext
    ) {
      this.#store.updateExecution(taskId, active.handle.captureContext());
      if (event.type === "message.completed") return;
    }
    if (event.type === "diff.available") {
      this.#store.createArtifact({
        taskId,
        runId,
        kind: "diff",
        title: "Workspace Diff",
        content: event.diff,
        metadata: { callId: event.callId },
      });
      return;
    }
    if (event.type === "tool.completed") {
      active.toolCallCount += 1;
      this.#updateActiveUsage(
        active,
        active.inputTokens,
        active.outputTokens,
        active.toolCallCount,
      );
    }
    if (event.type === "approval.requested") {
      this.#store.createRequest({
        id: event.requestId,
        taskId,
        runId,
        kind: "approval",
        title: event.title,
        description: event.description,
        payload: {
          category: event.category,
          details: event.details,
          ...(event.diff ? { diff: event.diff } : {}),
          expiresAt: event.expiresAt,
        },
      });
      this.#store.setWaiting(taskId, runId, "approval", true);
      this.#releaseSlot(active);
      return;
    }
    if (event.type === "approval.resolved") {
      this.#store.resolveRequest(event.requestId, { decision: event.decision });
      if (
        this.#store.pendingRequestCount(taskId, "approval") === 0
        && this.#store.getTask(taskId)?.status === "waiting_approval"
      ) {
        this.#store.setWaiting(taskId, runId, "approval", false);
      }
      return;
    }
    if (event.type === "user_input.requested") {
      this.#store.createRequest({
        id: event.requestId,
        taskId,
        runId,
        kind: "user_input",
        title: event.title,
        ...(event.description ? { description: event.description } : {}),
        payload: { ...(event.options ? { options: event.options } : {}) },
      });
      this.#store.setWaiting(taskId, runId, "user_input", true);
      this.#releaseSlot(active);
      return;
    }
    if (event.type === "user_input.resolved") {
      this.#store.resolveRequest(event.requestId, { value: event.value });
      if (
        this.#store.pendingRequestCount(taskId, "user_input") === 0
        && this.#store.getTask(taskId)?.status === "waiting_user"
      ) {
        this.#store.setWaiting(taskId, runId, "user_input", false);
      }
    }
  }

  async dispose(options: { closeStore?: boolean } = {}): Promise<void> {
    if (this.#disposed) return;
    this.#paused = true;
    this.#disposed = true;
    const completions = [...this.#active.values()].map(async (active) => {
      active.interruptRequested = true;
      active.controller.abort();
      await active.handle?.cancel().catch(() => undefined);
      await active.completion.catch(() => undefined);
    });
    await Promise.allSettled(completions);
    for (const waiter of this.#resumeWaiters.splice(0)) waiter.resolve(null);
    const workerError = new Error("Task Orchestrator 已释放");
    for (const waiter of this.#workerWaiters.values()) waiter.reject(workerError);
    for (const waiter of this.#workerReady.splice(0)) waiter.reject(workerError);
    this.#workerWaiters.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (options.closeStore !== false) this.#store.close();
  }

  #markContinuation(taskId: string): void {
    const execution = this.#store.getExecution(taskId);
    this.#store.updateExecution(taskId, { ...execution, preferFork: true, continuation: true });
  }

  #releaseSlot(active: ActiveExecution): void {
    active.slotHeld = false;
    this.#drain();
  }

  #createResumeLease(active: ActiveExecution, ownsSlot: boolean): ResumeLease {
    let settled = false;
    return {
      commit: () => {
        settled = true;
      },
      release: () => {
        if (settled || !ownsSlot) return;
        settled = true;
        if (this.#active.get(active.taskId) === active) this.#releaseSlot(active);
      },
    };
  }

  #updateActiveUsage(
    active: ActiveExecution,
    inputTokens: number,
    outputTokens: number,
    toolCallCount: number,
  ): void {
    active.inputTokens = Math.max(active.inputTokens, inputTokens);
    active.outputTokens = Math.max(active.outputTokens, outputTokens);
    active.toolCallCount = Math.max(active.toolCallCount, toolCallCount);
    const usage = this.#store.updateRunUsage(active.taskId, active.runId, {
      inputTokens: active.inputTokens,
      outputTokens: active.outputTokens,
      toolCalls: active.toolCallCount,
      durationMs: Math.max(0, Date.now() - active.startedAt),
    });
    if (!usage?.exceeded || active.budgetExceeded) return;
    active.budgetExceeded = "Worker 已达到硬预算上限";
    active.controller.abort();
    void active.handle?.cancel().catch(() => undefined);
  }

  #heldSlots(): number {
    return [...this.#active.values()].filter((active) => active.slotHeld).length;
  }

  #handleWorkerTaskEvent(event: TaskEvent): void {
    if (![
      "task.succeeded",
      "task.failed",
      "task.cancelled",
      "task.interrupted",
    ].includes(event.type)) return;
    const task = this.#store.getTask(event.taskId);
    if (task?.kind !== "worker") return;
    const completed = this.#store.tryCompleteWorkerDelegation(task.id);
    if (!completed) return;
    const waiter = this.#workerWaiters.get(completed.delegationId);
    if (!waiter) return;
    this.#workerWaiters.delete(completed.delegationId);
    waiter.results = completed.results;
    this.#workerReady.push(waiter);
    this.#drain();
  }

  #drain(): void {
    if (!this.#started || this.#paused || this.#disposed) return;
    while (this.#heldSlots() < this.#concurrency && this.#workerReady.length) {
      const waiter = this.#workerReady.shift()!;
      const active = this.#active.get(waiter.parentTaskId);
      if (!active || active.runId !== waiter.parentRunId) {
        waiter.reject(new Error("父任务已停止，无法恢复 Worker 结果"));
        continue;
      }
      try {
        active.slotHeld = true;
        this.#store.resumeAfterWorkers(
          waiter.parentTaskId,
          waiter.parentRunId,
          waiter.delegationId,
        );
        waiter.resolve(waiter.results);
      } catch (error) {
        active.slotHeld = false;
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    while (this.#heldSlots() < this.#concurrency && this.#resumeWaiters.length) {
      const waiter = this.#resumeWaiters.shift()!;
      const active = this.#active.get(waiter.taskId);
      const request = this.#store.getTaskDetail(waiter.taskId)?.requests.find(
        (candidate) => candidate.id === waiter.requestId && candidate.status === "pending",
      );
      if (!active || !request) {
        waiter.resolve(null);
        continue;
      }
      active.slotHeld = true;
      waiter.resolve(this.#createResumeLease(active, true));
    }
    let available = this.#concurrency - this.#heldSlots();
    if (available <= 0) return;
    const queued = this.#store.listQueuedTasks();
    for (const task of queued) {
      if (available <= 0) break;
      if (
        this.#active.has(task.id)
        || !this.#isWorkspaceAvailable(task)
        || !this.#store.isPlanExecutionApproved(task)
      ) continue;
      const run = this.#store.createRun(task.id);
      const controller = new AbortController();
      const active: ActiveExecution = {
        taskId: task.id,
        runId: run.id,
        controller,
        cancelRequested: false,
        interruptRequested: false,
        pauseRequested: false,
        replanIntent: undefined,
        replanCheckpoint: undefined,
        resolveReplan: undefined,
        rejectReplan: undefined,
        slotHeld: true,
        summary: "",
        startedAt: Date.now(),
        toolCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        budgetExceeded: undefined,
        budgetTimer: undefined,
        completion: Promise.resolve(),
      };
      this.#active.set(task.id, active);
      active.completion = this.#execute(active, task, run);
      available -= 1;
    }
  }

  async #execute(
    active: ActiveExecution,
    task: TaskRecord,
    run: RunRecord,
  ): Promise<void> {
    try {
      const handle = await this.#executor({
        task,
        run,
        execution: this.#store.getExecution(task.id),
        signal: active.controller.signal,
      });
      active.handle = handle;
      this.#store.bindRun(task.id, run.id, {
        sessionId: handle.sessionId,
        ...(handle.modelProvider ? { modelProvider: handle.modelProvider } : {}),
        ...(handle.modelId ? { modelId: handle.modelId } : {}),
      });
      const workerBudget = task.kind === "worker"
        ? this.#store.getTaskBudget(task.id)?.budget
        : undefined;
      if (workerBudget) {
        active.budgetTimer = setTimeout(() => {
          active.budgetExceeded = "Worker 已达到运行时间上限";
          this.#updateActiveUsage(
            active,
            active.inputTokens,
            active.outputTokens,
            active.toolCallCount,
          );
          active.controller.abort();
          void active.handle?.cancel().catch(() => undefined);
        }, workerBudget.maxDurationMs);
      }
      if (active.cancelRequested || active.interruptRequested || active.pauseRequested) {
        await handle.cancel().catch(() => undefined);
      }
      await handle.completion;
      if (handle.captureContext) {
        this.#store.updateExecution(task.id, handle.captureContext());
      }
      if (handle.captureUsage) {
        const usage = handle.captureUsage();
        this.#updateActiveUsage(
          active,
          usage.inputTokens,
          usage.outputTokens,
          usage.toolCallCount,
        );
      }
      if (active.pauseRequested && !active.cancelRequested && !active.interruptRequested) {
        this.#finishPausedExecution(active, task, run);
      } else {
        if (task.kind === "planning" && !this.#store.getPlanForPlanningTask(task.id)) {
          throw new Error("Planning Task 未提交结构化计划");
        }
        if (task.kind === "worker" && !this.#store.getWorkerResult(task.id, run.id)) {
          throw new Error("Worker 未提交结构化结果");
        }
        if (active.budgetExceeded) throw new Error(active.budgetExceeded);
        this.#store.finishRun(
          task.id,
          run.id,
          active.interruptRequested
            ? "interrupted"
            : active.cancelRequested
              ? "cancelled"
              : "succeeded",
          undefined,
          summarize(active.summary),
        );
      }
    } catch (error) {
      if (active.pauseRequested && !active.cancelRequested && !active.interruptRequested) {
        this.#finishPausedExecution(active, task, run);
      } else {
        if (
          active.handle?.captureContext
          && !active.cancelRequested
          && !active.interruptRequested
        ) {
          this.#store.updateExecution(task.id, active.handle.captureContext());
        }
        this.#store.finishRun(
          task.id,
          run.id,
          active.interruptRequested
            ? "interrupted"
            : active.cancelRequested
              ? "cancelled"
              : "failed",
          active.cancelRequested || active.interruptRequested
            ? undefined
            : active.budgetExceeded ?? formatError(error),
          summarize(active.summary),
        );
      }
    } finally {
      if (active.budgetTimer) clearTimeout(active.budgetTimer);
      if (active.rejectReplan) {
        active.rejectReplan(new Error("重新规划请求未能完成"));
        active.rejectReplan = undefined;
        active.resolveReplan = undefined;
      }
      this.#active.delete(task.id);
      for (const [delegationId, waiter] of this.#workerWaiters) {
        if (waiter.parentTaskId !== task.id) continue;
        this.#workerWaiters.delete(delegationId);
        waiter.reject(new Error(
          active.pauseRequested
            ? "父任务已暂停；恢复时将从已持久化的 Worker 结果继续"
            : "父任务已停止",
        ));
      }
      for (let index = this.#workerReady.length - 1; index >= 0; index -= 1) {
        const waiter = this.#workerReady[index]!;
        if (waiter.parentTaskId !== task.id) continue;
        this.#workerReady.splice(index, 1);
        waiter.reject(new Error("父任务已停止"));
      }
      for (const waiter of this.#resumeWaiters.filter((item) => item.taskId === task.id)) {
        waiter.resolve(null);
      }
      this.#resumeWaiters.splice(
        0,
        this.#resumeWaiters.length,
        ...this.#resumeWaiters.filter((waiter) => waiter.taskId !== task.id),
      );
      this.#drain();
    }
  }

  #finishPausedExecution(
    active: ActiveExecution,
    task: TaskRecord,
    run: RunRecord,
  ): void {
    const checkpoint = active.handle?.captureContext?.()
      ?? active.replanCheckpoint
      ?? this.#store.getExecution(task.id);
    this.#store.updateExecution(task.id, checkpoint);
    if (!active.replanIntent) {
      this.#store.finishPausedRun(task.id, run.id);
      return;
    }
    try {
      const planningTask = this.#store.finishReplanPausedRun(
        task.id,
        run.id,
        active.replanIntent,
        checkpoint,
      );
      active.resolveReplan?.(planningTask);
      active.resolveReplan = undefined;
      active.rejectReplan = undefined;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      active.rejectReplan?.(normalized);
      active.resolveReplan = undefined;
      active.rejectReplan = undefined;
      this.#store.finishPausedRun(task.id, run.id);
    }
  }
}

function rowToTask(row: TaskRow): TaskRecord {
  return taskRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    rootTaskId: row.root_task_id,
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    kind: row.kind,
    title: row.title,
    goal: row.goal,
    status: row.status,
    priority: row.priority,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.plan_id ? { planId: row.plan_id } : {}),
    ...(row.current_run_id ? { currentRunId: row.current_run_id } : {}),
    ...(row.assigned_profile ? { assignedProfile: row.assigned_profile } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  });
}

function rowToRun(row: RunRow): RunRecord {
  return runRecordSchema.parse({
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    status: row.status,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    runnerId: row.runner_id,
    ...(row.model_provider ? { modelProvider: row.model_provider } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    toolCallCount: row.tool_call_count,
  });
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return artifactRecordSchema.parse({
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.content ? { content: row.content } : {}),
    metadata: JSON.parse(row.metadata_json),
    createdAt: row.created_at,
  });
}

function rowToEvent(row: EventRow): TaskEvent {
  return taskEventSchema.parse({
    eventId: row.event_id,
    taskId: row.task_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    timestamp: row.timestamp,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}

function rowToRequest(row: RequestRow): TaskRequestRecord {
  return taskRequestRecordSchema.parse({
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    payload: JSON.parse(row.payload_json),
    ...(row.response_json ? { response: JSON.parse(row.response_json) } : {}),
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  });
}

function rowToPlan(row: PlanRow): PlanRecord {
  return planRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    sessionId: row.session_id,
    ...(row.planning_task_id ? { planningTaskId: row.planning_task_id } : {}),
    ...(row.execution_task_id ? { executionTaskId: row.execution_task_id } : {}),
    goal: row.goal,
    status: row.status,
    currentRevision: row.current_revision,
    ...(row.approved_revision ? { approvedRevision: row.approved_revision } : {}),
    ...(row.executing_revision ? { executingRevision: row.executing_revision } : {}),
    ...(row.replan_reason ? { replanReason: row.replan_reason } : {}),
    affectedStepIds: JSON.parse(row.affected_step_ids_json),
    replanEvidence: JSON.parse(row.replan_evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToPlanRevision(row: PlanRevisionRow): PlanRevisionRecord {
  return planRevisionRecordSchema.parse({
    planId: row.plan_id,
    revision: row.revision,
    ...(row.feedback ? { feedback: row.feedback } : {}),
    assumptions: JSON.parse(row.assumptions_json),
    constraints: JSON.parse(row.constraints_json),
    steps: JSON.parse(row.steps_json),
    createdAt: row.created_at,
  });
}

function rowToPlanStepState(row: PlanStepStateRow): PlanStepState {
  return planStepStateSchema.parse({
    planId: row.plan_id,
    revision: row.revision,
    stepId: row.step_id,
    status: row.status,
    ...(row.summary ? { summary: row.summary } : {}),
    evidence: JSON.parse(row.evidence_json),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    updatedAt: row.updated_at,
  });
}

function rowToPlanEvent(row: PlanEventRow): PlanEvent {
  return planEventSchema.parse({
    eventId: row.event_id,
    planId: row.plan_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    timestamp: row.timestamp,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json),
  });
}

export function validatePlanSteps(steps: PlanStep[]): void {
  if (steps.length < 1 || steps.length > 30) {
    throw new Error("计划步骤数量必须为 1 到 30");
  }
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`计划步骤 ID 重复: ${step.id}`);
    ids.add(step.id);
    for (const candidate of step.candidateFiles) {
      const normalized = candidate.replaceAll("\\", "/");
      if (
        normalized.startsWith("/")
        || /^[a-z]:\//i.test(normalized)
        || normalized.split("/").includes("..")
      ) {
        throw new Error(`候选文件必须是工作区相对路径: ${candidate}`);
      }
    }
    if (step.risk === "high" && step.validation.length === 0) {
      throw new Error(`高风险步骤必须提供验证方式: ${step.id}`);
    }
  }
  for (const step of steps) {
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) throw new Error(`步骤依赖不存在: ${dependency}`);
      if (dependency === step.id) throw new Error(`步骤不能依赖自身: ${step.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("计划步骤依赖存在环");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function isSafeWorkspaceRelativePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[a-z]:\//i.test(normalized)
    && !normalized.split("/").includes("..");
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

function normalizeConcurrency(value: number): number {
  return Math.max(1, Math.min(32, Math.trunc(value)));
}

function summarize(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(-4_000) : undefined;
}

function workerProfileLabel(profile: WorkerProfileId): string {
  if (profile === "explorer") return "Explorer";
  if (profile === "tester") return "Tester";
  return "Reviewer";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTaskRecordFixture(
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const id = overrides.id ?? randomUUID();
  const now = new Date().toISOString();
  return taskRecordSchema.parse({
    id,
    workspaceId: "workspace-test",
    rootTaskId: id,
    kind: "background",
    title: "Test task",
    goal: "Complete the test task",
    status: "queued",
    priority: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}
