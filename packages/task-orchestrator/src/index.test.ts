import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskOrchestrator,
  TaskStore,
  type TaskExecutionHandle,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("TaskStore", () => {
  it("migrates a v3 database to v4 idempotently", async () => {
    const databasePath = await createDatabasePath();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT,
        root_task_id TEXT NOT NULL, parent_task_id TEXT, kind TEXT NOT NULL,
        title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
        priority INTEGER NOT NULL, session_id TEXT, plan_id TEXT,
        current_run_id TEXT, assigned_profile TEXT, execution_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE plans (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT,
        session_id TEXT NOT NULL, planning_task_id TEXT, execution_task_id TEXT,
        goal TEXT NOT NULL, status TEXT NOT NULL, current_revision INTEGER NOT NULL,
        approved_revision INTEGER, executing_revision INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES (
        'task-1', 'workspace-a', NULL, 'task-1', NULL, 'background',
        'legacy', 'legacy', 'queued', 0, NULL, NULL, NULL, NULL,
        '{"type":"agent-prompt","sourceSessionId":"s","preferFork":true}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      );
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new TaskStore(databasePath);
    expect(migrated.getDeliveryMode("task-1")).toBe("background");
    migrated.close();
    const reopened = new TaskStore(databasePath);
    reopened.close();

    const verified = new DatabaseSync(databasePath);
    expect((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(4);
    const taskColumns = verified.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const planColumns = verified.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>;
    expect(taskColumns.map((column) => column.name)).toContain("delivery_mode");
    expect(planColumns.map((column) => column.name)).toContain("replan_reason");
    verified.close();
  });

  it("migrates a v1 task database through every schema version", async () => {
    const databasePath = await createDatabasePath();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        root_task_id TEXT NOT NULL, parent_task_id TEXT, kind TEXT NOT NULL,
        title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
        priority INTEGER NOT NULL, session_id TEXT, plan_id TEXT,
        current_run_id TEXT, assigned_profile TEXT, execution_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT);
      INSERT INTO tasks VALUES (
        '00000000-0000-4000-8000-000000000011', 'workspace-a',
        '00000000-0000-4000-8000-000000000011', NULL, 'interactive',
        'legacy v1', 'legacy v1', 'queued', 0, NULL, NULL, NULL, NULL,
        '{"type":"agent-prompt","sourceSessionId":"s","preferFork":false}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new TaskStore(databasePath);
    expect(migrated.getTask("00000000-0000-4000-8000-000000000011")).toMatchObject({
      title: "legacy v1",
      status: "queued",
    });
    expect(migrated.getDeliveryMode("00000000-0000-4000-8000-000000000011"))
      .toBe("foreground");
    migrated.close();

    const verified = new DatabaseSync(databasePath);
    expect((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(4);
    expect(verified.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'",
    ).get()).toBeTruthy();
    verified.close();
  });

  it("persists tasks, runs, artifacts, and monotonic events", async () => {
    const store = await createStore();
    const task = store.createTask({
      workspaceId: "workspace-a",
      kind: "interactive",
      title: "修复测试",
      goal: "修复测试",
      execution: promptExecution(),
    });
    const run = store.createRun(task.id);
    store.bindRun(task.id, run.id, {
      sessionId: "session-a",
      modelProvider: "openai",
      modelId: "gpt-test",
    });
    const artifact = store.createArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "report",
      title: "结果",
      content: "完成",
    });
    store.finishRun(task.id, run.id, "succeeded");

    const detail = store.getTaskDetail(task.id);
    expect(detail?.task.status).toBe("succeeded");
    expect(detail?.runs).toHaveLength(1);
    expect(detail?.runs[0]).toMatchObject({
      sessionId: "session-a",
      status: "succeeded",
      modelProvider: "openai",
    });
    expect(detail?.artifacts).toEqual([artifact]);
    expect(detail?.events.map((event) => event.sequence))
      .toEqual(detail?.events.map((_, index) => index + 1));
    expect(detail?.events.map((event) => event.type)).toEqual([
      "task.created",
      "task.queued",
      "run.created",
      "task.started",
      "run.started",
      "artifact.created",
      "run.completed",
      "task.succeeded",
    ]);
    store.close();
  });

  it("rejects illegal transitions without appending an event", async () => {
    const store = await createStore();
    const task = store.createTask({
      workspaceId: "workspace-a",
      kind: "interactive",
      title: "任务",
      goal: "任务",
      execution: promptExecution(),
    });
    const run = store.createRun(task.id);
    store.bindRun(task.id, run.id, { sessionId: "session-a" });
    const before = store.getTaskDetail(task.id)!.events.length;

    expect(() => store.bindRun(task.id, run.id, { sessionId: "session-a" }))
      .toThrow("非法运行状态转换");
    expect(store.getTaskDetail(task.id)!.events).toHaveLength(before);
    store.close();
  });

  it("persists immutable Plan revisions and executes dependency-ordered steps", async () => {
    const store = await createStore();
    const planningTask = store.createTask({
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      kind: "planning",
      title: "规划功能",
      goal: "规划并实施功能",
      execution: { ...promptExecution(), interactionMode: "plan" },
    });
    const plan = store.createPlan({
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      sessionId: "session-plan",
      planningTaskId: planningTask.id,
      goal: "规划并实施功能",
      assumptions: ["现有测试可运行"],
      constraints: ["保持兼容"],
      steps: planSteps(),
    });
    expect(plan.status).toBe("ready");
    expect(store.getPlan(plan.id)?.events.map((event) => event.sequence)).toEqual([1, 2]);

    store.requestPlanRevision(plan.id, "补充回归测试");
    store.revisePlan(plan.id, {
      planningTaskId: planningTask.id,
      feedback: "补充回归测试",
      assumptions: ["现有测试可运行"],
      constraints: ["保持兼容"],
      steps: [
        ...planSteps(),
        {
          id: "verify",
          title: "回归验证",
          description: "运行完整测试",
          dependencies: ["implement"],
          candidateFiles: [],
          validation: ["全部测试通过"],
          risk: "low",
          parallelizable: false,
        },
      ],
    });
    const revised = store.getPlan(plan.id)!;
    expect(revised.revisions).toHaveLength(2);
    expect(revised.revisions[0]?.steps).toHaveLength(2);
    expect(revised.revisions[1]?.steps).toHaveLength(3);

    const executionTask = store.approvePlan(plan.id, 2, {
      title: "执行计划",
      execution: {
        ...promptExecution(true),
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 2,
      },
    });
    const run = store.createRun(executionTask.id);
    store.bindRun(executionTask.id, run.id, { sessionId: "session-execution" });
    expect(() => store.updatePlanStep(plan.id, {
      revision: 2,
      stepId: "implement",
      status: "running",
    })).toThrow("依赖尚未完成");

    for (const stepId of ["inspect", "implement", "verify"]) {
      store.updatePlanStep(plan.id, {
        revision: 2,
        stepId,
        status: "running",
        taskId: executionTask.id,
        runId: run.id,
      });
      store.updatePlanStep(plan.id, {
        revision: 2,
        stepId,
        status: "completed",
        summary: `${stepId} done`,
        taskId: executionTask.id,
        runId: run.id,
      });
    }
    store.finishRun(executionTask.id, run.id, "succeeded");
    expect(store.getPlan(plan.id)?.plan.status).toBe("completed");
    store.close();
  });

  it("rejects cyclic Plan dependencies and unsafe candidate paths", async () => {
    const store = await createStore();
    expect(() => store.createPlan({
      workspaceId: "workspace-a",
      sessionId: "session-plan",
      goal: "非法计划",
      assumptions: [],
      constraints: [],
      steps: [
        {
          ...planSteps()[0]!,
          dependencies: ["implement"],
          candidateFiles: ["../secret"],
        },
        planSteps()[1]!,
      ],
    })).toThrow(/相对路径|存在环/);
    expect(store.listPlans()).toHaveLength(0);
    store.close();
  });

  it("returns an incomplete Plan execution to approved when its Task fails", async () => {
    const store = await createStore();
    const planning = store.createTask({
      workspaceId: "workspace-a",
      kind: "planning",
      title: "plan",
      goal: "plan",
      execution: { ...promptExecution(), interactionMode: "plan" },
    });
    const plan = store.createPlan({
      workspaceId: "workspace-a",
      sessionId: "session-plan",
      planningTaskId: planning.id,
      goal: "plan",
      assumptions: [],
      constraints: [],
      steps: planSteps(),
    });
    store.cancelInactiveTask(planning.id);
    const execution = store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...promptExecution(true),
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    });
    const run = store.createRun(execution.id);
    store.bindRun(execution.id, run.id, { sessionId: "session-execution" });

    expect(() => store.finishRun(execution.id, run.id, "succeeded"))
      .toThrow("计划仍有未完成步骤");
    expect(store.getPlan(plan.id)?.plan.status).toBe("executing");
    store.finishRun(execution.id, run.id, "failed", "Agent 提前结束");
    expect(store.getTask(execution.id)?.status).toBe("failed");
    expect(store.getPlan(plan.id)?.plan.status).toBe("approved");
    store.close();
  });

  it("interrupts active rows on recovery and leaves queued tasks intact", async () => {
    const database = await createDatabasePath();
    const first = new TaskStore(database);
    const active = first.createTask({
      workspaceId: "workspace-a",
      kind: "interactive",
      title: "运行中",
      goal: "运行中",
      execution: promptExecution(),
    });
    const run = first.createRun(active.id);
    first.bindRun(active.id, run.id, { sessionId: "session-a" });
    const queued = first.createTask({
      workspaceId: "workspace-a",
      kind: "background",
      title: "排队中",
      goal: "排队中",
      execution: promptExecution(true),
    });
    first.close();

    const second = new TaskStore(database);
    expect(second.recoverInterrupted()).toBe(1);
    expect(second.getTask(active.id)?.status).toBe("interrupted");
    expect(second.getTaskDetail(active.id)?.runs[0]?.status).toBe("interrupted");
    expect(second.getTask(queued.id)?.status).toBe("queued");
    second.close();
  });

  it("isolates workspace queries", async () => {
    const store = await createStore();
    store.createTask({
      workspaceId: "workspace-a",
      kind: "interactive",
      title: "A",
      goal: "A",
      execution: promptExecution(),
    });
    store.createTask({
      workspaceId: "workspace-b",
      kind: "interactive",
      title: "B",
      goal: "B",
      execution: promptExecution(),
    });
    expect(store.listTasks("workspace-a").map((task) => task.title)).toEqual(["A"]);
    expect(store.listTasks("workspace-b").map((task) => task.title)).toEqual(["B"]);
    store.close();
  });

  it("searches globally and persists workspace paths, requests, and summaries", async () => {
    const store = await createStore();
    const task = store.createTask({
      workspaceId: "workspace-a",
      workspacePath: "/projects/alpha",
      kind: "background",
      title: "修复登录回归",
      goal: "检查认证流程",
      execution: promptExecution(true),
    });
    const run = store.createRun(task.id);
    store.bindRun(task.id, run.id, { sessionId: "session-a" });
    store.createRequest({
      id: "input-1",
      taskId: task.id,
      runId: run.id,
      kind: "user_input",
      title: "选择兼容策略",
      payload: { options: ["保持旧行为", "启用新行为"] },
    });

    expect(store.listTaskSummaries({ query: "登录" })[0]).toMatchObject({
      task: { workspacePath: "/projects/alpha" },
      pendingRequestCount: 1,
    });
    store.resolveRequest("input-1", { value: "保持旧行为" });
    store.finishRun(task.id, run.id, "succeeded", undefined, "登录回归已修复");
    const detail = store.getTaskDetail(task.id)!;
    expect(detail.requests[0]).toMatchObject({ status: "resolved" });
    expect(detail.events.map((event) => event.type)).toContain("user_input.requested");
    expect(detail.events.map((event) => event.type)).toContain("user_input.resolved");
    expect(store.listTaskSummaries({ query: "回归已修复" })[0]?.resultSummary)
      .toBe("登录回归已修复");
    store.close();
  });

  it("pauses queued tasks and requeues paused, failed, and interrupted tasks", async () => {
    const store = await createStore();
    const paused = store.createTask({
      workspaceId: "workspace-a",
      kind: "background",
      title: "暂停",
      goal: "暂停",
      execution: promptExecution(true),
    });
    store.pauseQueuedTask(paused.id);
    expect(store.getTask(paused.id)?.status).toBe("paused");
    store.requeueTask(paused.id, "paused");
    expect(store.getTask(paused.id)?.status).toBe("queued");

    const run = store.createRun(paused.id);
    store.bindRun(paused.id, run.id, { sessionId: "session-paused" });
    store.finishRun(paused.id, run.id, "failed", "失败");
    store.requeueTask(paused.id, "failed");
    expect(store.getTask(paused.id)?.status).toBe("queued");
    store.close();
  });
});

describe("TaskOrchestrator", () => {
  it("keeps unavailable workspace tasks queued and exposes an attention reason", async () => {
    const store = await createStore();
    const executor = vi.fn(async () => deferredHandle("unused"));
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      executor,
      workspaceAvailability: () => ({
        runnable: false,
        attentionReason: "workspace_missing",
      }),
    });
    const task = orchestrator.submitPrompt({
      workspaceId: "workspace-missing",
      workspacePath: "/missing/project",
      title: "missing",
      prompt: "missing",
      kind: "background",
      execution: promptExecution(true),
    });
    orchestrator.start();
    await settle();
    expect(executor).not.toHaveBeenCalled();
    expect(orchestrator.listTaskSummaries()[0]).toMatchObject({
      task: { id: task.id, status: "queued" },
      runnable: false,
      attentionReason: "workspace_missing",
    });
    await orchestrator.dispose();
  });

  it("queues over the concurrency limit and starts in FIFO order", async () => {
    const store = await createStore();
    const handles: Array<ReturnType<typeof deferredHandle>> = [];
    const starts: string[] = [];
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async ({ task }) => {
        starts.push(task.title);
        const handle = deferredHandle(`session-${task.title}`);
        handles.push(handle);
        return handle;
      },
    });
    orchestrator.start();
    const first = orchestrator.submitPrompt({
      title: "first",
      prompt: "first",
      kind: "interactive",
      execution: promptExecution(),
    });
    const second = orchestrator.submitPrompt({
      title: "second",
      prompt: "second",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();

    expect(starts).toEqual(["first"]);
    expect(orchestrator.getTask(first.id)?.task.status).toBe("running");
    expect(orchestrator.getTask(second.id)?.task.status).toBe("queued");

    handles[0]!.resolve();
    await settle();
    expect(starts).toEqual(["first", "second"]);
    handles[1]!.resolve();
    await settle();
    expect(orchestrator.getTask(second.id)?.task.status).toBe("succeeded");
    await orchestrator.dispose();
  });

  it("honors priority before creation time when starting a paused queue", async () => {
    const store = await createStore();
    const starts: string[] = [];
    const handles: Array<ReturnType<typeof deferredHandle>> = [];
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async ({ task }) => {
        starts.push(task.title);
        const handle = deferredHandle(`session-${task.title}`);
        handles.push(handle);
        return handle;
      },
    });
    orchestrator.submitPrompt({
      title: "low",
      prompt: "low",
      kind: "interactive",
      priority: 0,
      execution: promptExecution(),
    });
    orchestrator.submitPrompt({
      title: "high",
      prompt: "high",
      kind: "background",
      priority: 10,
      execution: promptExecution(true),
    });
    orchestrator.start();
    await settle();
    expect(starts).toEqual(["high"]);
    handles[0]!.resolve();
    await settle();
    handles[1]!.resolve();
    await settle();
    await orchestrator.dispose();
  });

  it("starts queued work when the concurrency limit increases", async () => {
    const store = await createStore();
    const handles: Array<ReturnType<typeof deferredHandle>> = [];
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async ({ task }) => {
        const handle = deferredHandle(`session-${task.title}`);
        handles.push(handle);
        return handle;
      },
    });
    orchestrator.start();
    orchestrator.submitPrompt({
      title: "one",
      prompt: "one",
      kind: "interactive",
      execution: promptExecution(),
    });
    orchestrator.submitPrompt({
      title: "two",
      prompt: "two",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();
    expect(handles).toHaveLength(1);
    orchestrator.setConcurrency(2);
    await settle();
    expect(handles).toHaveLength(2);
    handles.forEach((handle) => handle.resolve());
    await settle();
    await orchestrator.dispose();
  });

  it("cancels queued and active tasks independently", async () => {
    const store = await createStore();
    const handle = deferredHandle("session-active");
    const cancel = vi.spyOn(handle, "cancel");
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async () => handle,
    });
    orchestrator.start();
    const active = orchestrator.submitPrompt({
      title: "active",
      prompt: "active",
      kind: "interactive",
      execution: promptExecution(),
    });
    const queued = orchestrator.submitPrompt({
      title: "queued",
      prompt: "queued",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();

    expect(await orchestrator.cancelTask(queued.id)).toBe(true);
    expect(orchestrator.getTask(queued.id)?.task.status).toBe("cancelled");
    expect(await orchestrator.cancelTask(active.id)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    handle.reject(abortError());
    await settle();
    expect(orchestrator.getTask(active.id)?.task.status).toBe("cancelled");
    await orchestrator.dispose();
  });

  it("waits for all approval requests before returning to running", async () => {
    const store = await createStore();
    const handle = deferredHandle("session-approval");
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async () => handle,
    });
    orchestrator.start();
    const task = orchestrator.submitPrompt({
      title: "approval",
      prompt: "approval",
      kind: "interactive",
      execution: promptExecution(),
    });
    await settle();
    const runId = orchestrator.getTask(task.id)?.task.currentRunId;
    expect(runId).toBeTruthy();
    const base = {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: "session-approval",
      taskId: task.id,
      runId: runId!,
    };
    orchestrator.handleAgentEvent({
      ...base,
      type: "approval.requested",
      requestId: "approval-1",
      category: "workspace.write",
      title: "写入",
      description: "写入",
      details: {},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    orchestrator.handleAgentEvent({
      ...base,
      type: "approval.requested",
      requestId: "approval-2",
      category: "network",
      title: "网络",
      description: "网络",
      details: {},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(orchestrator.getTask(task.id)?.task.status).toBe("waiting_approval");
    orchestrator.handleAgentEvent({
      ...base,
      type: "approval.resolved",
      requestId: "approval-1",
      decision: "allow_once",
    });
    expect(orchestrator.getTask(task.id)?.task.status).toBe("waiting_approval");
    orchestrator.handleAgentEvent({
      ...base,
      type: "approval.resolved",
      requestId: "approval-2",
      decision: "allow_once",
    });
    expect(orchestrator.getTask(task.id)?.task.status).toBe("running");
    handle.resolve();
    await settle();
    await orchestrator.dispose();
  });

  it("marks active work interrupted when disposed and preserves queued work", async () => {
    const store = await createStore();
    const handle = deferredHandle("session-dispose");
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async () => handle,
    });
    orchestrator.start();
    const active = orchestrator.submitPrompt({
      title: "active",
      prompt: "active",
      kind: "interactive",
      execution: promptExecution(),
    });
    const queued = orchestrator.submitPrompt({
      title: "queued",
      prompt: "queued",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();
    const dispose = orchestrator.dispose();
    handle.reject(abortError());
    await dispose;

    const reopened = new TaskStore(
      join(temporaryDirectories.at(-1)!, "tasks.db"),
    );
    expect(reopened.getTask(active.id)?.status).toBe("interrupted");
    expect(reopened.getTask(queued.id)?.status).toBe("queued");
    reopened.close();
  });

  it("shares one concurrency limit across workspaces", async () => {
    const store = await createStore();
    const handles: Array<ReturnType<typeof deferredHandle>> = [];
    const starts: string[] = [];
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      executor: async ({ task }) => {
        starts.push(`${task.workspaceId}:${task.title}`);
        const handle = deferredHandle(`session-${task.title}`);
        handles.push(handle);
        return handle;
      },
    });
    orchestrator.start();
    orchestrator.submitPrompt({
      workspaceId: "workspace-a",
      title: "A",
      prompt: "A",
      kind: "background",
      execution: promptExecution(true),
    });
    orchestrator.submitPrompt({
      workspaceId: "workspace-b",
      title: "B",
      prompt: "B",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();
    expect(starts).toEqual(["workspace-a:A"]);
    handles[0]!.resolve();
    await settle();
    expect(starts).toEqual(["workspace-a:A", "workspace-b:B"]);
    handles[1]!.resolve();
    await settle();
    await orchestrator.dispose();
  });

  it("pauses an active run and resumes it as a new attempt", async () => {
    const store = await createStore();
    const handles: Array<ReturnType<typeof deferredHandle>> = [];
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async () => {
        const handle = deferredHandle(`session-${handles.length + 1}`);
        handles.push(handle);
        return handle;
      },
    });
    orchestrator.start();
    const task = orchestrator.submitPrompt({
      title: "pause-resume",
      prompt: "pause-resume",
      kind: "interactive",
      execution: promptExecution(),
    });
    await settle();
    await orchestrator.pauseTask(task.id);
    handles[0]!.reject(abortError());
    await settle();
    expect(orchestrator.getTask(task.id)?.task.status).toBe("paused");
    expect(orchestrator.resumeTask(task.id)).toBe(true);
    await settle();
    expect(handles).toHaveLength(2);
    handles[1]!.resolve();
    await settle();
    expect(orchestrator.getTask(task.id)?.runs).toHaveLength(2);
    expect(orchestrator.getTask(task.id)?.task.status).toBe("succeeded");
    await orchestrator.dispose();
  });

  it("reacquires a global slot before resolving a waiting request", async () => {
    const store = await createStore();
    const handles: Array<ReturnType<typeof deferredHandle>> = [];
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async ({ task }) => {
        const handle = deferredHandle(`session-${task.title}`);
        handles.push(handle);
        return handle;
      },
    });
    orchestrator.start();
    const waiting = orchestrator.submitPrompt({
      title: "waiting",
      prompt: "waiting",
      kind: "interactive",
      execution: promptExecution(),
    });
    orchestrator.submitPrompt({
      title: "other",
      prompt: "other",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();
    const runId = orchestrator.getTask(waiting.id)!.task.currentRunId!;
    orchestrator.handleAgentEvent({
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: "session-waiting",
      taskId: waiting.id,
      runId,
      type: "approval.requested",
      requestId: "approval-resume",
      category: "workspace.write",
      title: "写入",
      description: "写入",
      details: {},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await settle();
    expect(handles).toHaveLength(2);

    const leasePromise = orchestrator.acquireResumeLease(waiting.id, "approval-resume");
    await expect(orchestrator.acquireResumeLease(waiting.id, "approval-resume"))
      .resolves.toBeNull();
    handles[1]!.resolve();
    const lease = await leasePromise;
    expect(lease).not.toBeNull();
    expect(orchestrator.activeRunCount).toBe(1);
    lease!.commit();
    orchestrator.handleAgentEvent({
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: "session-waiting",
      taskId: waiting.id,
      runId,
      type: "approval.resolved",
      requestId: "approval-resume",
      decision: "allow_once",
    });
    expect(orchestrator.getTask(waiting.id)?.task.status).toBe("running");
    handles[0]!.resolve();
    await settle();
    await orchestrator.dispose();
  });

  it("keeps Plan execution consistent on failure and atomically prepares replan", async () => {
    const store = await createStore();
    const planning = store.createTask({
      workspaceId: "workspace-a",
      kind: "planning",
      title: "plan",
      goal: "plan",
      execution: { ...promptExecution(), interactionMode: "plan" },
    });
    const plan = store.createPlan({
      workspaceId: "workspace-a",
      sessionId: "session-plan",
      planningTaskId: planning.id,
      goal: "plan",
      assumptions: [],
      constraints: [],
      steps: planSteps(),
    });
    store.cancelInactiveTask(planning.id);
    const execution = store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...promptExecution(true),
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    });
    const handle = deferredHandle("session-execution");
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      executor: async () => handle,
    });
    orchestrator.start();
    await settle();
    expect(store.getPlan(plan.id)?.plan.status).toBe("executing");
    const runId = store.getTask(execution.id)!.currentRunId!;
    store.updatePlanStep(plan.id, {
      revision: 1,
      stepId: "inspect",
      status: "running",
      taskId: execution.id,
      runId,
    });

    await orchestrator.requestReplan(execution.id, {
      planId: plan.id,
      reason: "假设失效",
      affectedStepIds: ["inspect"],
      evidence: ["API 已变化"],
    });
    handle.reject(abortError());
    await settle();
    const detail = store.getPlan(plan.id)!;
    expect(detail.plan).toMatchObject({
      status: "draft",
      replanReason: "假设失效",
      affectedStepIds: ["inspect"],
      replanEvidence: ["API 已变化"],
    });
    expect(detail.stepStates.find((state) => state.stepId === "inspect"))
      .toMatchObject({ status: "blocked", reason: "假设失效" });
    expect(store.getTask(execution.id)?.status).toBe("paused");
    await orchestrator.dispose();
  });
});

async function createStore(): Promise<TaskStore> {
  return new TaskStore(await createDatabasePath());
}

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "deki-task-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "tasks.db");
}

function promptExecution(preferFork = false) {
  return {
    type: "agent-prompt" as const,
    sourceSessionId: "source-session",
    sourceSessionFile: "/tmp/source.jsonl",
    sourceEntryId: "entry-1",
    preferFork,
  };
}

function planSteps() {
  return [
    {
      id: "inspect",
      title: "检查现状",
      description: "读取现有实现",
      dependencies: [],
      candidateFiles: ["src/index.ts"],
      validation: ["确认接入点"],
      risk: "low" as const,
      parallelizable: false,
    },
    {
      id: "implement",
      title: "实现功能",
      description: "完成代码修改",
      dependencies: ["inspect"],
      candidateFiles: ["src/index.ts"],
      validation: ["单元测试通过"],
      risk: "medium" as const,
      parallelizable: false,
    },
  ];
}

function deferredHandle(sessionId: string): TaskExecutionHandle & {
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    sessionId,
    completion,
    cancel: vi.fn(async () => undefined),
    resolve,
    reject,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
