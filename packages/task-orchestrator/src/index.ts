import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  artifactRecordSchema,
  runRecordSchema,
  taskDetailSchema,
  taskEventSchema,
  taskRecordSchema,
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
  type TaskStatus,
} from "@deki-ai/shared";
import { z } from "zod";

export const promptExecutionInputSchema = z.object({
  type: z.literal("agent-prompt"),
  sourceSessionId: z.string().min(1),
  sourceSessionFile: z.string().min(1).optional(),
  sourceEntryId: z.string().min(1).optional(),
  preferFork: z.boolean(),
}).strict();
export type PromptExecutionInput = z.infer<typeof promptExecutionInputSchema>;
export type TaskExecutionInput = PromptExecutionInput;

export interface TaskExecutionHandle {
  sessionId: string;
  modelProvider?: string;
  modelId?: string;
  completion: Promise<void>;
  cancel(): Promise<void>;
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

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set([
    "waiting_approval", "waiting_user", "paused", "succeeded",
    "failed", "cancelled", "interrupted",
  ]),
  waiting_approval: new Set(["running", "cancelled", "interrupted"]),
  waiting_user: new Set(["running", "cancelled", "interrupted"]),
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
          id, workspace_id, root_task_id, parent_task_id, kind, title, goal,
          status, priority, session_id, plan_id, current_run_id,
          assigned_profile, execution_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, NULL)
      `).run(
        task.id,
        task.workspaceId,
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
    const runs = this.#database.prepare(`
      SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC
    `).all(id) as unknown as RunRow[];
    const artifacts = this.#database.prepare(`
      SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC
    `).all(id) as unknown as ArtifactRow[];
    const events = this.#database.prepare(`
      SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence ASC
    `).all(id) as unknown as EventRow[];
    return taskDetailSchema.parse({
      task,
      runs: runs.map(rowToRun),
      artifacts: artifacts.map(rowToArtifact),
      events: events.map(rowToEvent),
    });
  }

  listTasks(
    workspaceId: string,
    options: { statuses?: TaskStatus[]; limit?: number } = {},
  ): TaskRecord[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    if (options.statuses && options.statuses.length === 0) return [];
    if (options.statuses?.length) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      const rows = this.#database.prepare(`
        SELECT * FROM tasks
        WHERE workspace_id = ? AND status IN (${placeholders})
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
      `).all(workspaceId, ...options.statuses, limit) as unknown as TaskRow[];
      return rows.map(rowToTask);
    }
    const rows = this.#database.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(workspaceId, limit) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  listQueuedTasks(workspaceId: string, limit: number): TaskRecord[] {
    const rows = this.#database.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND status = 'queued'
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(workspaceId, limit) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  getExecution(id: string): TaskExecutionInput {
    const row = this.#database.prepare(
      "SELECT execution_json FROM tasks WHERE id = ?",
    ).get(id) as { execution_json: string } | undefined;
    if (!row) throw new Error("未找到任务");
    return promptExecutionInputSchema.parse(JSON.parse(row.execution_json));
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
        SET status = 'running', current_run_id = ?, updated_at = ?
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
    input: {
      sessionId: string;
      modelProvider?: string;
      modelId?: string;
    },
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
      this.#database.prepare(`
        UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?
      `).run(input.sessionId, now, taskId);
      events.push(this.#appendEvent(taskId, "run.started", {}, runId, input.sessionId));
    });
    return this.#requireRun(runId);
  }

  setApprovalWaiting(taskId: string, runId: string, waiting: boolean): void {
    const task = this.#requireTask(taskId);
    const run = this.#requireRun(runId);
    const nextTask: TaskStatus = waiting ? "waiting_approval" : "running";
    const nextRun: RunStatus = waiting ? "waiting_approval" : "running";
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
        waiting ? "task.waiting_approval" : "task.resumed",
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
    const taskEvent = `task.${status}` as TaskEventType;
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE runs
        SET status = ?, finished_at = ?, error = ?
        WHERE id = ? AND task_id = ?
      `).run(status, now, error ?? null, runId, taskId);
      this.#database.prepare(`
        UPDATE tasks
        SET status = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(status, now, now, taskId);
      const payload = error ? { error } : {};
      events.push(this.#appendEvent(
        taskId,
        runEvent,
        payload,
        runId,
        task.sessionId,
      ));
      events.push(this.#appendEvent(
        taskId,
        taskEvent,
        payload,
        runId,
        task.sessionId,
      ));
    });
  }

  cancelQueuedTask(taskId: string): void {
    const task = this.#requireTask(taskId);
    if (task.status === "cancelled") return;
    if (task.status !== "queued") {
      throw new Error(`任务 ${taskId} 当前状态为 ${task.status}，不能直接取消队列`);
    }
    this.#assertTaskTransition(task.status, "cancelled");
    const now = new Date().toISOString();
    this.#transaction((events) => {
      this.#database.prepare(`
        UPDATE tasks
        SET status = 'cancelled', updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(now, now, taskId);
      events.push(this.#appendEvent(taskId, "task.cancelled", {}));
    });
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

  countActive(workspaceId: string): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE workspace_id = ?
        AND status IN ('running', 'waiting_approval', 'waiting_user')
    `).get(workspaceId) as { count: number };
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
    const version = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version >= 1) return;
    this.#database.exec(`
      BEGIN;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
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
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
}

interface ActiveExecution {
  taskId: string;
  runId: string;
  controller: AbortController;
  handle?: TaskExecutionHandle;
  cancelRequested: boolean;
  interruptRequested: boolean;
  completion: Promise<void>;
}

export class TaskOrchestrator {
  readonly #store: TaskStore;
  readonly #workspaceId: string;
  readonly #executor: TaskExecutor;
  readonly #onEvent: ((event: TaskEvent) => void) | undefined;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #pendingApprovals = new Map<string, number>();
  #concurrency: number;
  #started = false;
  #paused = false;
  #disposed = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: {
    store: TaskStore;
    workspaceId: string;
    concurrency: number;
    executor: TaskExecutor;
    onEvent?: (event: TaskEvent) => void;
  }) {
    this.#store = options.store;
    this.#workspaceId = options.workspaceId;
    this.#concurrency = normalizeConcurrency(options.concurrency);
    this.#executor = options.executor;
    this.#onEvent = options.onEvent;
    this.#unsubscribe = this.#store.subscribe((event) => this.#onEvent?.(event));
    this.#store.recoverInterrupted();
  }

  start(): void {
    if (this.#disposed) throw new Error("Task Orchestrator 已释放");
    if (this.#started) {
      this.#paused = false;
      this.#pump();
      return;
    }
    this.#started = true;
    this.#paused = false;
    this.#pump();
  }

  pause(): void {
    this.#paused = true;
  }

  setConcurrency(value: number): void {
    this.#concurrency = normalizeConcurrency(value);
    this.#pump();
  }

  submitPrompt(input: {
    title: string;
    prompt: string;
    kind: "interactive" | "background";
    execution: PromptExecutionInput;
    priority?: number;
  }): TaskRecord {
    if (this.#disposed) throw new Error("Task Orchestrator 已释放");
    const task = this.#store.createTask({
      workspaceId: this.#workspaceId,
      kind: input.kind,
      title: input.title,
      goal: input.prompt,
      execution: input.execution,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
    this.#pump();
    return task;
  }

  listTasks(options: { statuses?: TaskStatus[]; limit?: number } = {}): TaskRecord[] {
    return this.#store.listTasks(this.#workspaceId, options);
  }

  getTask(taskId: string): TaskDetail | undefined {
    const detail = this.#store.getTaskDetail(taskId);
    return detail?.task.workspaceId === this.#workspaceId ? detail : undefined;
  }

  hasNonTerminalForSession(sessionId: string): boolean {
    return this.#store.hasNonTerminalForSession(this.#workspaceId, sessionId);
  }

  currentTaskForSession(sessionId: string): TaskRecord | undefined {
    return this.#store.listTasks(this.#workspaceId, {
      statuses: ["running", "waiting_approval", "waiting_user"],
      limit: 500,
    }).find((task) => task.sessionId === sessionId);
  }

  get activeRunCount(): number {
    return this.#active.size;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.#store.getTask(taskId);
    if (!task || task.workspaceId !== this.#workspaceId) return false;
    if (isTerminalTaskStatus(task.status)) return true;
    if (task.status === "queued") {
      this.#store.cancelQueuedTask(taskId);
      this.#pump();
      return true;
    }
    const active = this.#active.get(taskId);
    if (!active) return false;
    active.cancelRequested = true;
    active.controller.abort();
    await active.handle?.cancel().catch(() => undefined);
    return true;
  }

  handleAgentEvent(event: AgentEvent): void {
    const taskId = event.taskId;
    const runId = event.runId;
    if (!taskId || !runId || !this.#active.has(taskId)) return;
    const task = this.#store.getTask(taskId);
    if (!task || isTerminalTaskStatus(task.status)) return;
    if (event.type === "approval.requested") {
      const count = (this.#pendingApprovals.get(taskId) ?? 0) + 1;
      this.#pendingApprovals.set(taskId, count);
      if (count === 1) this.#store.setApprovalWaiting(taskId, runId, true);
      return;
    }
    if (event.type === "approval.resolved") {
      const count = Math.max(0, (this.#pendingApprovals.get(taskId) ?? 0) - 1);
      if (count === 0) {
        this.#pendingApprovals.delete(taskId);
        const current = this.#store.getTask(taskId);
        if (current?.status === "waiting_approval") {
          this.#store.setApprovalWaiting(taskId, runId, false);
        }
      } else {
        this.#pendingApprovals.set(taskId, count);
      }
    }
  }

  async dispose(): Promise<void> {
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
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#store.close();
  }

  #pump(): void {
    if (!this.#started || this.#paused || this.#disposed) return;
    const available = this.#concurrency - this.#active.size;
    if (available <= 0) return;
    const queued = this.#store.listQueuedTasks(this.#workspaceId, available);
    for (const task of queued) {
      if (this.#active.has(task.id)) continue;
      const run = this.#store.createRun(task.id);
      const controller = new AbortController();
      const active = {
        taskId: task.id,
        runId: run.id,
        controller,
        cancelRequested: false,
        interruptRequested: false,
        completion: Promise.resolve(),
      } satisfies ActiveExecution;
      this.#active.set(task.id, active);
      active.completion = this.#execute(active, task, run);
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
      if (active.cancelRequested || active.interruptRequested) {
        await handle.cancel().catch(() => undefined);
      }
      await handle.completion;
      this.#store.finishRun(
        task.id,
        run.id,
        active.interruptRequested
          ? "interrupted"
          : active.cancelRequested
            ? "cancelled"
            : "succeeded",
      );
    } catch (error) {
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
      );
    } finally {
      this.#pendingApprovals.delete(task.id);
      this.#active.delete(task.id);
      this.#pump();
    }
  }
}

function rowToTask(row: TaskRow): TaskRecord {
  return taskRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
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
  return Math.min(8, Math.max(1, Math.trunc(value)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /abort|cancel/iu.test(error.message));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
