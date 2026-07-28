import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  artifactRecordSchema,
  runRecordSchema,
  taskDetailSchema,
  taskEventSchema,
  taskRecordSchema,
  taskRequestRecordSchema,
  taskSummarySchema,
  type AgentEvent,
  type ArtifactKind,
  type ArtifactRecord,
  type RunRecord,
  type RunStatus,
  type TaskDetail,
  type TaskEvent,
  type TaskEventType,
  type TaskKind,
  type TaskRecord,
  type TaskRequestKind,
  type TaskRequestRecord,
  type TaskStatus,
  type TaskSummary,
} from "@deki-ai/shared";
import { z } from "zod";

export const promptExecutionInputSchema = z.object({
  type: z.literal("agent-prompt"),
  sourceSessionId: z.string().min(1),
  sourceSessionFile: z.string().min(1).optional(),
  sourceEntryId: z.string().min(1).optional(),
  preferFork: z.boolean(),
  continuation: z.boolean().optional(),
}).strict();
export type PromptExecutionInput = z.infer<typeof promptExecutionInputSchema>;
export type TaskExecutionInput = PromptExecutionInput;

export interface TaskExecutionHandle {
  sessionId: string;
  modelProvider?: string;
  modelId?: string;
  completion: Promise<void>;
  cancel(): Promise<void>;
  captureContext?(): PromptExecutionInput;
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

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["running", "paused", "cancelled"]),
  running: new Set([
    "waiting_approval", "waiting_user", "paused", "succeeded",
    "failed", "cancelled", "interrupted",
  ]),
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
    "waiting_approval", "waiting_user", "succeeded",
    "failed", "cancelled", "interrupted",
  ]),
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
          assigned_profile, execution_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, NULL)
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
    return taskDetailSchema.parse({
      task,
      runs: runs.map(rowToRun),
      artifacts: artifacts.map(rowToArtifact),
      events: events.map(rowToEvent),
      requests: requests.map(rowToRequest),
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
        )
      )`);
      values.push(query, query, query, query);
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
      "SELECT execution_json FROM tasks WHERE id = ?",
    ).get(id) as { execution_json: string } | undefined;
    if (!row) throw new Error("未找到任务");
    return promptExecutionInputSchema.parse(JSON.parse(row.execution_json));
  }

  updateExecution(taskId: string, execution: TaskExecutionInput): void {
    this.#requireTask(taskId);
    this.#database.prepare(
      "UPDATE tasks SET execution_json = ?, updated_at = ? WHERE id = ?",
    ).run(
      JSON.stringify(promptExecutionInputSchema.parse(execution)),
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

  createRun(taskId: string, runnerId = "local"): RunRecord {
    const task = this.#requireTask(taskId);
    if (task.status !== "queued") {
      throw new Error(`任务 ${taskId} 当前状态为 ${task.status}，不能启动`);
    }
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
    const run = this.#requireRun(runId);
    this.#assertRunTransition(run.status, "running");
    const now = new Date().toISOString();
    this.#transaction((events) => {
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
    const now = new Date().toISOString();
    const runEvent: TaskEventType = status === "succeeded"
      ? "run.completed"
      : status === "failed"
        ? "run.failed"
        : status === "cancelled"
          ? "run.cancelled"
          : "run.interrupted";
    this.#transaction((events) => {
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
    if (!["running", "waiting_approval", "waiting_user"].includes(task.status)) {
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
    this.#transaction((events) => {
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
    });
  }

  requeueTask(taskId: string, expected: "paused" | "failed" | "interrupted"): void {
    const task = this.#requireTask(taskId);
    if (task.status !== expected) throw new Error(`任务当前状态不是 ${expected}`);
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
        "UPDATE tasks SET kind = 'background', updated_at = ? WHERE id = ?",
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
    this.#transitionTaskOnly(task, "cancelled", "task.cancelled", true);
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
      WHERE status IN ('running', 'waiting_approval', 'waiting_user')
      ORDER BY created_at ASC
    `).all() as unknown as TaskRow[];
    for (const row of tasks) {
      const task = rowToTask(row);
      const runId = task.currentRunId;
      const now = new Date().toISOString();
      this.#transaction((events) => {
        if (runId) {
          this.#database.prepare(`
            UPDATE runs
            SET status = 'interrupted', finished_at = ?,
                error = COALESCE(error, '应用在任务运行期间退出')
            WHERE id = ? AND status IN (
              'queued', 'starting', 'running', 'waiting_approval', 'waiting_user'
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
      });
    }
    return tasks.length;
  }

  countActive(): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE status IN ('running', 'waiting_approval', 'waiting_user')
    `).get() as { count: number };
    return row.count;
  }

  hasNonTerminalForSession(workspaceId: string, sessionId: string): boolean {
    const row = this.#database.prepare(`
      SELECT 1 AS found FROM tasks
      WHERE workspace_id = ? AND session_id = ?
        AND status IN ('queued', 'running', 'waiting_approval', 'waiting_user', 'paused')
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
    return taskSummarySchema.parse({
      task,
      ...(currentRun ? { currentRun: rowToRun(currentRun) } : {}),
      pendingRequestCount: this.pendingRequestCount(task.id),
      ...(latestRun?.result_summary ? { resultSummary: latestRun.result_summary } : {}),
      ...(latestRun?.error ? { error: latestRun.error } : {}),
    });
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

  #transaction<T>(operation: (events: TaskEvent[]) => T): T {
    const events: TaskEvent[] = [];
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(events);
      this.#database.exec("COMMIT");
      for (const event of events) {
        for (const listener of this.#listeners) listener(event);
      }
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
        PRAGMA user_version = 2;
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
  slotHeld: boolean;
  summary: string;
  completion: Promise<void>;
}

interface ResumeWaiter {
  taskId: string;
  resolve: () => void;
}

export class TaskOrchestrator {
  readonly #store: TaskStore;
  readonly #executor: TaskExecutor;
  readonly #defaultWorkspaceId: string | undefined;
  readonly #isWorkspaceAvailable: (task: TaskRecord) => boolean;
  readonly #onEvent: ((event: TaskEvent) => void) | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #resumeWaiters: ResumeWaiter[] = [];
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
    onEvent?: (event: TaskEvent) => void;
    recoverOnStart?: boolean;
  }) {
    this.#store = options.store;
    this.#defaultWorkspaceId = options.workspaceId;
    this.#concurrency = normalizeConcurrency(options.concurrency);
    this.#executor = options.executor;
    this.#isWorkspaceAvailable = options.isWorkspaceAvailable ?? (() => true);
    this.#onEvent = options.onEvent;
    this.#unsubscribe = this.#store.subscribe((event) => this.#onEvent?.(event));
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
    kind: "interactive" | "background";
    execution: PromptExecutionInput;
    priority?: number;
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
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
    this.#drain();
    return task;
  }

  listTaskSummaries(options: {
    statuses?: TaskStatus[];
    workspaceIds?: string[];
    query?: string;
    limit?: number;
  } = {}): TaskSummary[] {
    return this.#store.listTaskSummaries(options);
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
      statuses: ["running", "waiting_approval", "waiting_user"],
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

  async acquireResumeSlot(taskId: string): Promise<boolean> {
    const active = this.#active.get(taskId);
    if (!active) return false;
    if (active.slotHeld) return true;
    if (this.#resumeWaiters.some((waiter) => waiter.taskId === taskId)) return false;
    if (this.#heldSlots() < this.#concurrency) {
      active.slotHeld = true;
      return true;
    }
    await new Promise<void>((resolve) => {
      this.#resumeWaiters.push({ taskId, resolve });
    });
    return this.#active.has(taskId);
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
    for (const waiter of this.#resumeWaiters.splice(0)) waiter.resolve();
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

  #heldSlots(): number {
    return [...this.#active.values()].filter((active) => active.slotHeld).length;
  }

  #drain(): void {
    if (!this.#started || this.#paused || this.#disposed) return;
    while (this.#heldSlots() < this.#concurrency && this.#resumeWaiters.length) {
      const waiter = this.#resumeWaiters.shift()!;
      const active = this.#active.get(waiter.taskId);
      if (active) active.slotHeld = true;
      waiter.resolve();
    }
    let available = this.#concurrency - this.#heldSlots();
    if (available <= 0) return;
    const queued = this.#store.listQueuedTasks();
    for (const task of queued) {
      if (available <= 0) break;
      if (this.#active.has(task.id) || !this.#isWorkspaceAvailable(task)) continue;
      const run = this.#store.createRun(task.id);
      const controller = new AbortController();
      const active: ActiveExecution = {
        taskId: task.id,
        runId: run.id,
        controller,
        cancelRequested: false,
        interruptRequested: false,
        pauseRequested: false,
        slotHeld: true,
        summary: "",
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
      if (active.cancelRequested || active.interruptRequested || active.pauseRequested) {
        await handle.cancel().catch(() => undefined);
      }
      await handle.completion;
      if (active.pauseRequested) {
        if (handle.captureContext) this.#store.updateExecution(task.id, handle.captureContext());
        this.#store.finishPausedRun(task.id, run.id);
      } else {
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
      if (active.pauseRequested) {
        if (active.handle?.captureContext) {
          this.#store.updateExecution(task.id, active.handle.captureContext());
        }
        this.#store.finishPausedRun(task.id, run.id);
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
            : active.cancelRequested || isAbortError(error)
              ? "cancelled"
              : "failed",
          active.cancelRequested || active.interruptRequested
            ? undefined
            : formatError(error),
          summarize(active.summary),
        );
      }
    } finally {
      this.#active.delete(task.id);
      const index = this.#resumeWaiters.findIndex((waiter) => waiter.taskId === task.id);
      if (index >= 0) this.#resumeWaiters.splice(index, 1)[0]?.resolve();
      this.#drain();
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
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
