import type {
  RunRecord,
  TaskRecord,
  WorkerProfileId,
} from "@deki-ai/shared";

export interface SupervisedAgentHandle {
  sessionId: string;
  modelProvider?: string;
  modelId?: string;
  completion: Promise<void>;
  cancel(): Promise<void>;
}

export interface SupervisedAgent {
  taskId: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  role: "main" | "worker";
  profile?: WorkerProfileId;
  startedAt: string;
}

export class AgentSupervisor {
  readonly #agents = new Map<string, {
    record: SupervisedAgent;
    handle: SupervisedAgentHandle;
  }>();
  readonly #workspaces = new Set<string>();
  #disposed = false;

  registerWorkspace(workspaceId: string): () => void {
    if (this.#disposed) throw new Error("Agent Supervisor 已释放");
    this.#workspaces.add(workspaceId);
    return () => {
      if (![...this.#agents.values()].some(
        ({ record }) => record.workspaceId === workspaceId,
      )) {
        this.#workspaces.delete(workspaceId);
      }
    };
  }

  listWorkspaces(): string[] {
    return [...this.#workspaces];
  }

  track<T extends SupervisedAgentHandle>(
    task: TaskRecord,
    run: RunRecord,
    handle: T,
  ): T {
    if (this.#disposed) throw new Error("Agent Supervisor 已释放");
    const record: SupervisedAgent = {
      taskId: task.id,
      runId: run.id,
      sessionId: handle.sessionId,
      workspaceId: task.workspaceId,
      role: task.kind === "worker" || task.kind === "integration" ? "worker" : "main",
      ...((task.kind === "worker" || task.kind === "integration")
        && isWorkerProfile(task.assignedProfile)
        ? { profile: task.assignedProfile }
        : {}),
      startedAt: new Date().toISOString(),
    };
    this.#workspaces.add(task.workspaceId);
    this.#agents.set(task.id, { record, handle });
    void handle.completion.finally(() => {
      if (this.#agents.get(task.id)?.handle === handle) this.#agents.delete(task.id);
    }).catch(() => undefined);
    return handle;
  }

  get(taskId: string): SupervisedAgent | undefined {
    return this.#agents.get(taskId)?.record;
  }

  list(): SupervisedAgent[] {
    return [...this.#agents.values()].map(({ record }) => ({ ...record }));
  }

  async cancel(taskId: string): Promise<boolean> {
    const agent = this.#agents.get(taskId);
    if (!agent) return false;
    await agent.handle.cancel();
    return true;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const agents = [...this.#agents.values()];
    this.#agents.clear();
    this.#workspaces.clear();
    await Promise.allSettled(agents.map(({ handle }) => handle.cancel()));
    await Promise.allSettled(agents.map(({ handle }) => handle.completion));
  }
}

function isWorkerProfile(value: string | undefined): value is WorkerProfileId {
  return value === "explorer"
    || value === "tester"
    || value === "reviewer"
    || value === "implementer"
    || value === "integrator";
}
