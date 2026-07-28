import { describe, expect, it, vi } from "vitest";
import { AgentSupervisor } from "./index.js";

describe("AgentSupervisor", () => {
  it("tracks main and Worker runtimes and releases them on completion", async () => {
    const supervisor = new AgentSupervisor();
    supervisor.registerWorkspace("workspace-a");
    const mainCompletion = deferred();
    const workerCompletion = deferred();
    const integratorCompletion = deferred();
    supervisor.track(task("background"), run("run-main"), {
      sessionId: "session-main",
      completion: mainCompletion.promise,
      cancel: vi.fn(async () => undefined),
    });
    supervisor.track(task("worker", "reviewer"), run("run-worker"), {
      sessionId: "session-worker",
      completion: workerCompletion.promise,
      cancel: vi.fn(async () => undefined),
    });
    supervisor.track(task("integration", "integrator"), run("run-integration"), {
      sessionId: "session-integration",
      completion: integratorCompletion.promise,
      cancel: vi.fn(async () => undefined),
    });

    expect(supervisor.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "main", sessionId: "session-main" }),
      expect.objectContaining({
        role: "worker",
        profile: "reviewer",
        sessionId: "session-worker",
      }),
      expect.objectContaining({
        role: "worker",
        profile: "integrator",
        sessionId: "session-integration",
      }),
    ]));
    expect(supervisor.listWorkspaces()).toEqual(["workspace-a"]);
    workerCompletion.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(supervisor.list()).toHaveLength(2);
    integratorCompletion.resolve();
    mainCompletion.resolve();
    await supervisor.dispose();
    expect(supervisor.list()).toEqual([]);
  });

  it("cancels a supervised runtime precisely", async () => {
    const supervisor = new AgentSupervisor();
    const completion = deferred();
    const cancel = vi.fn(async () => completion.resolve());
    supervisor.track(task("worker", "tester"), run("run-worker"), {
      sessionId: "session-worker",
      completion: completion.promise,
      cancel,
    });
    await expect(supervisor.cancel("task-worker")).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    await supervisor.dispose();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function task(
  kind: "background" | "worker" | "integration",
  profile?: "explorer" | "tester" | "reviewer" | "integrator",
) {
  const now = new Date().toISOString();
  const child = kind === "worker" || kind === "integration";
  return {
    id: kind === "worker"
      ? "task-worker"
      : kind === "integration"
        ? "task-integration"
        : "task-main",
    workspaceId: "workspace-a",
    rootTaskId: "task-main",
    ...(child ? { parentTaskId: "task-main" } : {}),
    kind,
    title: kind,
    goal: kind,
    status: "running" as const,
    priority: 0,
    currentRunId: kind === "worker"
      ? "run-worker"
      : kind === "integration"
        ? "run-integration"
        : "run-main",
    ...(profile ? { assignedProfile: profile } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function run(id: string) {
  return {
    id,
    taskId: id === "run-worker"
      ? "task-worker"
      : id === "run-integration"
        ? "task-integration"
        : "task-main",
    attempt: 1,
    status: "running" as const,
    sessionId: id === "run-worker"
      ? "session-worker"
      : id === "run-integration"
        ? "session-integration"
        : "session-main",
    runnerId: "local",
    startedAt: new Date().toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    toolCallCount: 0,
  };
}
