import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it.each([1, 2, 3, 4, 5, 6])(
    "opens and migrates the real v%s database fixture repeatedly",
    async (version) => {
      const databasePath = await createDatabasePath();
      await copyFile(
        join(
          process.cwd(),
          "packages",
          "task-orchestrator",
          "test",
          "fixtures",
          `tasks-v${version}.db`,
        ),
        databasePath,
      );
      const migrated = new TaskStore(databasePath);
      expect(migrated.getTask("00000000-0000-4000-8000-000000000101"))
        .toMatchObject({ status: "succeeded", title: `fixture v${version}` });
      expect(migrated.getDeliveryMode("00000000-0000-4000-8000-000000000101"))
        .toBe("background");
      if (version >= 2) {
        expect(migrated.getTaskDetail("00000000-0000-4000-8000-000000000101")
          ?.requests).toHaveLength(1);
      }
      if (version >= 3) {
        expect(migrated.getPlan("00000000-0000-4000-8000-000000000103"))
          .toMatchObject({
            plan: { status: "ready", currentRevision: 1 },
            planningTask: { status: "succeeded" },
          });
      }
      migrated.close();
      const reopened = new TaskStore(databasePath);
      expect(reopened.getTask("00000000-0000-4000-8000-000000000101"))
        .toBeTruthy();
      reopened.close();
    },
  );

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
      .toBe(6);
    const taskColumns = verified.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const planColumns = verified.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>;
    const tables = verified.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>;
    expect(taskColumns.map((column) => column.name)).toContain("delivery_mode");
    expect(planColumns.map((column) => column.name)).toContain("replan_reason");
    expect(tables.map((table) => table.name)).toContain("artifact_files");
    expect(tables.map((table) => table.name)).toContain("write_batches");
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
      .toBe(6);
    expect(verified.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plans'",
    ).get()).toBeTruthy();
    verified.close();
  });

  it("migrates a v2 task database through Plan and delivery schemas", async () => {
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
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, task_id TEXT, attempt INTEGER, status TEXT,
        session_id TEXT, runner_id TEXT, model_provider TEXT, model_id TEXT,
        started_at TEXT, finished_at TEXT, error TEXT, result_summary TEXT,
        input_tokens INTEGER, output_tokens INTEGER, tool_call_count INTEGER
      );
      CREATE TABLE task_requests (
        id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, kind TEXT, status TEXT,
        title TEXT, description TEXT, payload_json TEXT, response_json TEXT,
        created_at TEXT, resolved_at TEXT
      );
      INSERT INTO tasks VALUES (
        '00000000-0000-4000-8000-000000000012', 'workspace-v2', '/tmp/v2',
        '00000000-0000-4000-8000-000000000012', NULL, 'background',
        'legacy v2', 'legacy v2', 'queued', 0, NULL, NULL, NULL, NULL,
        '{"type":"agent-prompt","sourceSessionId":"s","preferFork":true}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      );
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new TaskStore(databasePath);
    expect(migrated.getTask("00000000-0000-4000-8000-000000000012"))
      .toMatchObject({ workspacePath: "/tmp/v2", status: "queued" });
    expect(migrated.getDeliveryMode("00000000-0000-4000-8000-000000000012"))
      .toBe("background");
    migrated.close();
    const reopened = new TaskStore(databasePath);
    reopened.close();
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

  it("persists integration approval across recovery without a live Agent process", async () => {
    const databasePath = await createDatabasePath();
    const store = new TaskStore(databasePath);
    const task = store.createTask({
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      kind: "background",
      title: "isolated integration",
      goal: "integrate",
      execution: promptExecution(),
    });
    const run = store.createRun(task.id);
    store.bindRun(task.id, run.id, { sessionId: "session-a" });
    const integration = store.createIntegration({
      rootTaskId: task.id,
      taskId: task.id,
      baselineCommit: "a".repeat(40),
      workerTaskIds: [],
    });
    store.updateIntegration(integration.id, {
      status: "awaiting_apply",
      integrationCommit: "b".repeat(40),
      cleanupStatus: "cleaned",
    });
    store.setIntegrationAwaitingApply(task.id, run.id, "integration-request", {
      patchArtifactId: "25874e8e-00b8-4e39-9843-6ebda59f6ca7",
    });
    expect(store.getTask(task.id)?.status).toBe("awaiting_apply");
    expect(store.recoverInterrupted()).toBe(0);
    store.close();

    const reopened = new TaskStore(databasePath);
    expect(reopened.getTaskDetail(task.id)).toMatchObject({
      task: { status: "awaiting_apply" },
      integration: { status: "awaiting_apply", cleanupStatus: "cleaned" },
      requests: [{ id: "integration-request", status: "pending" }],
    });
    reopened.finishIntegrationDecision(
      task.id,
      run.id,
      "artifact_only",
      "integration-request",
    );
    expect(reopened.getTask(task.id)?.status).toBe("succeeded");
    reopened.close();
  });

  it("indexes file-backed Artifacts by URI, digest and size", async () => {
    const store = await createStore();
    const task = store.createTask({
      workspaceId: "workspace-a",
      kind: "background",
      title: "artifact index",
      goal: "index",
      execution: promptExecution(),
    });
    const run = store.createRun(task.id);
    store.bindRun(task.id, run.id, { sessionId: "session-a" });
    const artifact = store.createArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "patch",
      title: "patch",
      uri: "/tmp/deki-artifacts/patch.bin",
      metadata: { sha256: "a".repeat(64), size: 42 },
    });
    expect(store.getArtifactFile(artifact.id)).toEqual({
      uri: "/tmp/deki-artifacts/patch.bin",
      sha256: "a".repeat(64),
      size: 42,
    });
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

    succeedPlanningTask(store, planningTask.id);
    const revisionTask = store.createPlanRevisionTask(plan.id, {
      feedback: "补充回归测试",
      affectedStepIds: [],
      title: "修订计划",
      execution: { ...promptExecution(true), interactionMode: "plan", planId: plan.id },
    });
    expect(store.getLatestPlanningTask(plan.id)?.id).toBe(revisionTask.id);
    expect(() => store.createPlanRevisionTask(plan.id, {
      feedback: "重复修订",
      affectedStepIds: [],
      title: "重复修订",
      execution: { ...promptExecution(true), interactionMode: "plan", planId: plan.id },
    })).toThrow("已有正在进行的修订任务");
    store.revisePlan(plan.id, {
      planningTaskId: revisionTask.id,
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
    succeedPlanningTask(store, revisionTask.id);

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

  it("requires the current Planning Task to succeed before approval", async () => {
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
    expect(store.getPlan(plan.id)?.planningTask?.status).toBe("queued");
    expect(() => store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...promptExecution(true),
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    })).toThrow("规划任务尚未成功完成");
    succeedPlanningTask(store, planning.id);
    expect(store.getPlan(plan.id)?.planningTask?.status).toBe("succeeded");
    expect(store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...promptExecution(true),
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    }).kind).toBe("plan-execution");
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
    succeedPlanningTask(store, planning.id);
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

  it("creates a Worker batch atomically and persists its tree, budgets, and result", async () => {
    const store = await createStore();
    const parent = store.createTask({
      workspaceId: "workspace-a",
      workspacePath: "/projects/alpha",
      kind: "background",
      title: "父任务",
      goal: "检查实现",
      execution: promptExecution(true),
    });
    const parentRun = store.createRun(parent.id);
    store.bindRun(parent.id, parentRun.id, { sessionId: "parent-session" });

    const delegation = store.delegateWorkers({
      parentTaskId: parent.id,
      parentRunId: parentRun.id,
      toolCallId: "delegate-1",
      sourceSessionId: "parent-session",
      budget: workerBudget(),
      requests: [{
        profile: "explorer",
        objective: "定位调度入口",
        successCriteria: ["列出入口文件"],
        constraints: ["只读"],
        knownFacts: [],
        fileHints: ["src"],
        symbolHints: ["TaskOrchestrator"],
      }, {
        profile: "reviewer",
        objective: "审查并发风险",
        successCriteria: ["给出风险清单"],
        constraints: ["只读"],
        knownFacts: [],
        fileHints: [],
        symbolHints: [],
      }],
    });

    expect(store.getTask(parent.id)?.status).toBe("waiting_workers");
    expect(store.getTaskDetail(parent.id)?.runs[0]?.status).toBe("waiting_workers");
    expect(delegation.workerTasks).toHaveLength(2);
    expect(delegation.workerTasks.every((task) =>
      task.parentTaskId === parent.id && task.rootTaskId === parent.id)).toBe(true);
    expect(store.getTaskDetail(parent.id)).toMatchObject({
      budget: workerBudget(),
      budgetUsage: { workers: 2 },
    });

    const worker = delegation.workerTasks[0]!;
    const run = store.createRun(worker.id);
    store.bindRun(worker.id, run.id, { sessionId: "worker-session" });
    expect(() => store.saveWorkerResult(worker.id, run.id, {
      ...workerResult("越界证据"),
      findings: [{
        claim: "越界证据",
        confidence: 0.5,
        evidence: [{ kind: "file", path: "../secret.txt" }],
      }],
    })).toThrow("工作区相对路径");
    store.saveWorkerResult(worker.id, run.id, workerResult("找到调度入口"));
    expect(store.updateRunUsage(worker.id, run.id, {
      durationMs: 1_000,
      inputTokens: 51_200,
      outputTokens: 10,
      toolCalls: 1,
    })).toMatchObject({ warningEmitted: true, exceeded: false });
    store.updateRunUsage(worker.id, run.id, {
      durationMs: 2_000,
      inputTokens: 51_201,
      outputTokens: 10,
      toolCalls: 1,
    });
    expect(store.getTaskDetail(worker.id)?.events.filter(
      (event) => event.type === "budget.warning",
    )).toHaveLength(1);
    expect(store.updateRunUsage(worker.id, run.id, {
      durationMs: 3_000,
      inputTokens: 64_000,
      outputTokens: 10,
      toolCalls: 1,
    })).toMatchObject({ exceeded: true });
    expect(store.getTaskBudget(parent.id)?.usage.exceeded).toBe(true);
    expect(() => store.saveWorkerResult(worker.id, run.id, workerResult("重复")))
      .toThrow();
    store.finishRun(worker.id, run.id, "succeeded");
    expect(store.getTaskDetail(worker.id)?.workerResult?.summary).toBe("找到调度入口");
    expect(store.getTaskDetail(parent.id)?.children).toHaveLength(2);
    expect(store.listTaskSummaries({ query: "找到调度入口" }).map(
      (summary) => summary.task.id,
    )).toContain(parent.id);
    store.close();
  });

  it("rejects recursive and over-budget Worker delegation without partial writes", async () => {
    const store = await createStore();
    const parent = store.createTask({
      workspaceId: "workspace-a",
      kind: "background",
      title: "父任务",
      goal: "检查",
      execution: promptExecution(true),
    });
    const parentRun = store.createRun(parent.id);
    store.bindRun(parent.id, parentRun.id, { sessionId: "parent-session" });
    expect(() => store.delegateWorkers({
      parentTaskId: parent.id,
      parentRunId: parentRun.id,
      toolCallId: "too-many",
      sourceSessionId: "parent-session",
      budget: { ...workerBudget(), maxWorkers: 1 },
      requests: [
        workerRequest("explorer", "一"),
        workerRequest("reviewer", "二"),
      ],
    })).toThrow("最多允许 1 个 Worker");
    expect(store.getTask(parent.id)?.status).toBe("running");
    expect(store.getTaskDetail(parent.id)?.children).toHaveLength(0);
    store.close();
  });
});

describe("TaskOrchestrator", () => {
  it("cancels a persisted awaiting-apply task without a live Agent", async () => {
    const store = await createStore();
    const task = store.createTask({
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      kind: "background",
      title: "awaiting apply",
      goal: "deliver",
      execution: promptExecution(),
    });
    const run = store.createRun(task.id);
    store.bindRun(task.id, run.id, { sessionId: "session-a" });
    const integration = store.createIntegration({
      rootTaskId: task.id,
      taskId: task.id,
      baselineCommit: "a".repeat(40),
      workerTaskIds: [],
    });
    store.updateIntegration(integration.id, {
      status: "awaiting_apply",
      integrationCommit: "b".repeat(40),
      cleanupStatus: "cleaned",
    });
    store.setIntegrationAwaitingApply(task.id, run.id, "persisted-approval", {});
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      recoverOnStart: false,
      executor: async () => {
        throw new Error("executor must not run");
      },
    });
    await expect(orchestrator.cancelTask(task.id)).resolves.toBe(true);
    expect(store.getTaskDetail(task.id)).toMatchObject({
      task: { status: "cancelled" },
      integration: { status: "cancelled" },
      requests: [{ id: "persisted-approval", status: "cancelled" }],
    });
    await orchestrator.dispose();
  });

  it("creates and completes a system-only Integration Task with an Integrator profile", async () => {
    const store = await createStore();
    const parent = store.createTask({
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      kind: "background",
      title: "parent",
      goal: "integrate",
      execution: promptExecution(),
    });
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      recoverOnStart: false,
      executor: async ({ task, run }) => ({
        sessionId: "integrator-session",
        completion: new Promise<void>((resolve) => {
          setTimeout(() => {
            store.saveWorkerResult(task.id, run.id, workerResult("resolved safely"));
            resolve();
          }, 0);
        }),
        cancel: vi.fn(async () => undefined),
      }),
    });
    const result = await orchestrator.executeIntegrationTask({
      parentTaskId: parent.id,
      sourceSessionId: "source-session",
      objective: "resolve tracked.txt",
      conflictFiles: ["tracked.txt"],
      worktreeContext: {
        baselineCommit: "a".repeat(40),
        baseCommit: "b".repeat(40),
        baselineRef: "refs/deki/artifacts/baseline",
        repositoryRoot: "/tmp/repository",
        commonDirectory: "/tmp/repository/.git",
        workspaceRelativePath: "",
        writeSet: [{ path: "tracked.txt", kind: "file", exclusive: false }],
        validationTargets: [{ script: "test" }],
        wave: 0,
        integratorMode: "resolve",
        integrationResource: {
          id: "integration-resource",
          path: "/tmp/worktree",
          cwd: "/tmp/worktree",
          branch: "deki/integration/test",
          branchRef: "refs/heads/deki/integration/test",
          baseCommit: "a".repeat(40),
        },
      },
      budget: workerBudget(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "succeeded",
      task: {
        kind: "integration",
        assignedProfile: "integrator",
        parentTaskId: parent.id,
      },
      result: { summary: "resolved safely" },
    });
    expect(store.getTaskDetail(result.task.id)?.workerResult?.summary)
      .toBe("resolved safely");
    await orchestrator.dispose();
  });

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

  it("releases the parent slot while two Workers run and resumes with structured results", async () => {
    const store = await createStore();
    const parentHandle = deferredHandle("parent-session");
    const workerHandles = new Map<string, ReturnType<typeof deferredHandle>>();
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 2,
      executor: async ({ task }) => {
        if (task.kind !== "worker") return parentHandle;
        const handle = deferredHandle(`worker-${task.id}`);
        workerHandles.set(task.id, handle);
        return handle;
      },
    });
    orchestrator.start();
    const parent = orchestrator.submitPrompt({
      title: "并行调查",
      prompt: "并行调查",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();
    const parentRunId = store.getTask(parent.id)!.currentRunId!;
    const resultsPromise = orchestrator.delegateWorkers({
      parentTaskId: parent.id,
      parentRunId,
      toolCallId: "delegate-workers",
      sourceSessionId: "parent-session",
      budget: workerBudget(),
      requests: [
        workerRequest("explorer", "定位代码"),
        workerRequest("reviewer", "审查风险"),
      ],
    });
    await settle();

    expect(orchestrator.activeRunCount).toBe(2);
    expect(store.getTask(parent.id)?.status).toBe("waiting_workers");
    expect(workerHandles.size).toBe(2);
    for (const [taskId, handle] of workerHandles) {
      const runId = store.getTask(taskId)!.currentRunId!;
      orchestrator.saveWorkerResult(taskId, runId, workerResult(`完成 ${taskId}`));
      handle.resolve();
    }
    await settle();

    const results = await resultsPromise;
    expect(results).toHaveLength(2);
    expect(results.every((entry) => entry.status === "succeeded" && entry.result)).toBe(true);
    expect(store.getTask(parent.id)?.status).toBe("running");
    expect(orchestrator.activeRunCount).toBe(1);
    parentHandle.resolve();
    await settle();
    expect(store.getTask(parent.id)?.status).toBe("succeeded");
    await orchestrator.dispose();
  });

  it("fails a Worker that ends without a structured result", async () => {
    const store = await createStore();
    const parentHandle = deferredHandle("parent-session");
    let workerHandle: ReturnType<typeof deferredHandle> | undefined;
    const orchestrator = new TaskOrchestrator({
      store,
      workspaceId: "workspace-a",
      concurrency: 1,
      executor: async ({ task }) => {
        if (task.kind !== "worker") return parentHandle;
        workerHandle = deferredHandle("worker-session");
        return workerHandle;
      },
    });
    orchestrator.start();
    const parent = orchestrator.submitPrompt({
      title: "父任务",
      prompt: "父任务",
      kind: "background",
      execution: promptExecution(true),
    });
    await settle();
    const resultsPromise = orchestrator.delegateWorkers({
      parentTaskId: parent.id,
      parentRunId: store.getTask(parent.id)!.currentRunId!,
      toolCallId: "missing-result",
      sourceSessionId: "parent-session",
      budget: workerBudget(),
      requests: [workerRequest("explorer", "调查")],
    });
    await settle();
    workerHandle!.resolve();
    const results = await resultsPromise;
    expect(results[0]).toMatchObject({
      status: "failed",
      error: "Worker 未提交结构化结果",
    });
    parentHandle.resolve();
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
    const sourceDirectory = await mkdtemp(join(tmpdir(), "deki-replan-session-"));
    temporaryDirectories.push(sourceDirectory);
    const sourceSessionFile = join(sourceDirectory, "session.jsonl");
    await writeFile(sourceSessionFile, "{}\n");
    const executionCheckpoint = {
      ...promptExecution(),
      sourceSessionFile,
    };
    const planning = store.createTask({
      workspaceId: "workspace-a",
      kind: "planning",
      title: "plan",
      goal: "plan",
      execution: { ...executionCheckpoint, interactionMode: "plan" },
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
    succeedPlanningTask(store, planning.id);
    const execution = store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...executionCheckpoint,
        preferFork: true,
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    });
    const handle = deferredHandle("session-execution");
    const planningHandle = deferredHandle("session-revision");
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      executor: async ({ task }) => task.kind === "planning" ? planningHandle : handle,
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

    expect(() => orchestrator.requestReplan(execution.id, {
      planId: plan.id,
      reason: "无效请求",
      affectedStepIds: ["missing"],
    })).toThrow("受影响步骤包含未知 Step ID");
    expect(store.getPlan(plan.id)?.plan.status).toBe("executing");
    expect(store.getPlan(plan.id)?.plan.replanReason).toBeUndefined();
    await rm(sourceSessionFile);
    expect(() => orchestrator.requestReplan(execution.id, {
      planId: plan.id,
      reason: "checkpoint missing",
      affectedStepIds: ["inspect"],
    })).toThrow("计划最新 checkpoint 不可用");
    expect(store.getPlan(plan.id)?.plan.status).toBe("executing");
    expect(store.getTask(execution.id)?.status).toBe("running");
    await writeFile(sourceSessionFile, "{}\n");

    const request = orchestrator.requestReplan(execution.id, {
      planId: plan.id,
      reason: "假设失效",
      affectedStepIds: ["inspect"],
      evidence: ["API 已变化"],
    });
    expect(request).not.toBeNull();
    handle.reject(abortError());
    const revisionTask = await request!.planningTask;
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
    expect(revisionTask).toMatchObject({
      kind: "planning",
      planId: plan.id,
      status: "queued",
    });
    expect(store.getTaskDetail(execution.id)?.planContext).toMatchObject({
      planId: plan.id,
      status: "draft",
      currentRevision: 1,
      completedSteps: 0,
      totalSteps: 2,
      currentStep: { id: "inspect" },
    });
    expect(() => orchestrator.resumeTask(execution.id))
      .toThrow("计划必须完成修订并重新批准后才能恢复执行");
    planningHandle.reject(abortError());
    await settle();
    await orchestrator.dispose();
  });

  it("atomically pauses an active execution when the user requests a revision", async () => {
    const store = await createStore();
    const sourceDirectory = await mkdtemp(join(tmpdir(), "deki-active-revision-"));
    temporaryDirectories.push(sourceDirectory);
    const sourceSessionFile = join(sourceDirectory, "session.jsonl");
    await writeFile(sourceSessionFile, "{}\n");
    const checkpoint = { ...promptExecution(), sourceSessionFile };
    const planning = store.createTask({
      workspaceId: "workspace-a",
      kind: "planning",
      title: "plan",
      goal: "plan",
      execution: { ...checkpoint, interactionMode: "plan" },
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
    succeedPlanningTask(store, planning.id);
    const execution = store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...checkpoint,
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
    const runId = store.getTask(execution.id)!.currentRunId!;
    store.updatePlanStep(plan.id, {
      revision: 1,
      stepId: "inspect",
      status: "running",
      taskId: execution.id,
      runId,
    });
    const request = orchestrator.requestPlanRevision(plan.id, {
      feedback: "用户要求修改",
      affectedStepIds: ["inspect"],
      evidence: ["验收条件变化"],
      title: "revise",
      execution: {
        ...checkpoint,
        interactionMode: "plan",
        planId: plan.id,
        planRevision: 1,
      },
    });
    handle.reject(abortError());
    const revisionTask = await request.planningTask;
    await settle();
    expect(store.getTask(execution.id)?.status).toBe("paused");
    expect(store.getPlan(plan.id)?.plan).toMatchObject({
      status: "draft",
      replanReason: "用户要求修改",
      replanEvidence: ["验收条件变化"],
    });
    expect(revisionTask).toMatchObject({ kind: "planning", status: "queued" });
    await orchestrator.dispose();
  });

  it("does not start or resume an execution task while its Plan is draft", async () => {
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
    succeedPlanningTask(store, planning.id);
    const execution = store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...promptExecution(true),
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    });
    store.createPlanRevisionTask(plan.id, {
      feedback: "change it",
      affectedStepIds: [],
      title: "revise",
      execution: { ...promptExecution(true), interactionMode: "plan", planId: plan.id },
    });
    const startedKinds: string[] = [];
    const executor = vi.fn(async (input: { task: { kind: string } }) => {
      startedKinds.push(input.task.kind);
      return {
      sessionId: "revision-session",
      completion: Promise.resolve(),
      cancel: vi.fn(async () => undefined),
      };
    });
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      executor,
    });
    orchestrator.start();
    await settle();

    expect(executor).toHaveBeenCalledOnce();
    expect(startedKinds).toEqual(["planning"]);
    expect(store.getTask(execution.id)?.status).toBe("paused");
    expect(() => store.createRun(execution.id))
      .toThrow("当前状态为 paused");
    expect(() => orchestrator.resumeTask(execution.id))
      .toThrow("计划必须完成修订并重新批准后才能恢复执行");
    await orchestrator.dispose();
  });

  it("keeps the active Plan unchanged when precise replan cancellation fails", async () => {
    const store = await createStore();
    const sourceDirectory = await mkdtemp(join(tmpdir(), "deki-replan-cancel-"));
    temporaryDirectories.push(sourceDirectory);
    const sourceSessionFile = join(sourceDirectory, "session.jsonl");
    await writeFile(sourceSessionFile, "{}\n");
    const checkpoint = { ...promptExecution(), sourceSessionFile };
    const planning = store.createTask({
      workspaceId: "workspace-a",
      kind: "planning",
      title: "plan",
      goal: "plan",
      execution: { ...checkpoint, interactionMode: "plan" },
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
    succeedPlanningTask(store, planning.id);
    const execution = store.approvePlan(plan.id, 1, {
      title: "execute",
      execution: {
        ...checkpoint,
        preferFork: true,
        interactionMode: "plan-execution",
        planId: plan.id,
        planRevision: 1,
      },
    });
    const handle = deferredHandle("session-execution");
    handle.cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const orchestrator = new TaskOrchestrator({
      store,
      concurrency: 1,
      executor: async () => handle,
    });
    orchestrator.start();
    await settle();
    const runId = store.getTask(execution.id)!.currentRunId!;
    store.updatePlanStep(plan.id, {
      revision: 1,
      stepId: "inspect",
      status: "running",
      taskId: execution.id,
      runId,
    });

    const request = orchestrator.requestReplan(execution.id, {
      planId: plan.id,
      reason: "needs replan",
      affectedStepIds: ["inspect"],
    });
    await expect(request!.planningTask).rejects.toThrow("cancel failed");
    expect(store.getTask(execution.id)?.status).toBe("running");
    expect(store.getPlan(plan.id)?.plan.status).toBe("executing");
    expect(store.getPlan(plan.id)?.plan.replanReason).toBeUndefined();
    expect(store.getPlan(plan.id)?.stepStates.find((state) => state.stepId === "inspect"))
      .toMatchObject({ status: "running" });

    handle.reject(new Error("stop fixture"));
    await settle();
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

function workerBudget() {
  return {
    maxWorkers: 2,
    maxDurationMs: 300_000,
    maxInputTokens: 64_000,
    maxOutputTokens: 16_000,
    maxToolCalls: 50,
  };
}

function workerRequest(
  profile: "explorer" | "tester" | "reviewer",
  objective: string,
) {
  return {
    profile,
    objective,
    successCriteria: [`完成${objective}`],
    constraints: ["只读"],
    knownFacts: [],
    fileHints: [],
    symbolHints: [],
  };
}

function workerResult(summary: string) {
  return {
    summary,
    findings: [{
      claim: summary,
      confidence: 0.9,
      evidence: [{ kind: "file" as const, path: "src/index.ts", lineStart: 1 }],
    }],
    artifacts: [],
    risks: [],
    unresolved: [],
    recommendedNextActions: [],
  };
}

function succeedPlanningTask(store: TaskStore, taskId: string): void {
  const run = store.createRun(taskId);
  store.bindRun(taskId, run.id, { sessionId: "planning-session" });
  store.finishRun(taskId, run.id, "succeeded");
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
