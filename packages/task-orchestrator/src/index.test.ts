import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
