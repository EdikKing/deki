import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  containsSensitiveData,
  MemoryEngine,
  SensitiveMemoryError,
} from "./index";

const databases: Array<{ engine: MemoryEngine; directory: string }> = [];

afterEach(async () => {
  for (const { engine, directory } of databases.splice(0)) {
    engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createEngine() {
  const directory = await mkdtemp(join(tmpdir(), "deki-memory-"));
  const engine = new MemoryEngine(join(directory, "memory.db"));
  databases.push({ engine, directory });
  return engine;
}

describe("MemoryEngine", () => {
  it("stores and recalls project-scoped memory", async () => {
    const engine = await createEngine();
    engine.createProjectMemory({
      scopeId: "project-a",
      content: "Deki 使用 Electron 构建桌面界面",
      source: { kind: "user_command", sessionId: "session-a" },
    });
    engine.createProjectMemory({
      scopeId: "project-b",
      content: "另一个项目使用 Rust",
      source: { kind: "user_command" },
    });

    const recalled = engine.recallProjectMemories(
      "project-a",
      "桌面项目使用什么框架",
    );
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.content).toContain("Electron");

    const updated = engine.updateProjectMemory(
      "project-a",
      recalled[0]!.id,
      "Deki 使用 Electron 和 React",
    );
    expect(updated.content).toContain("React");
    expect(engine.getProjectMemory("project-b", updated.id)).toBeUndefined();
    expect(engine.archiveProjectMemory("project-a", updated.id)).toBe(true);
    expect(engine.getProjectMemory("project-a", updated.id)).toBeUndefined();
  });

  it("rejects likely secrets", async () => {
    const engine = await createEngine();
    expect(containsSensitiveData("api_key=super-secret-value")).toBe(true);
    expect(() => engine.createProjectMemory({
      scopeId: "project-a",
      content: "api_key=super-secret-value",
      source: { kind: "user_command" },
    })).toThrow(SensitiveMemoryError);
  });

  it("supports user memory candidates, pinning, acceptance, movement and deletion", async () => {
    const engine = await createEngine();
    const candidate = engine.createMemory({
      scope: "user",
      scopeId: "user",
      content: "用户偏好使用中文界面",
      source: { kind: "agent_candidate" },
      status: "pending",
    });
    expect(engine.listMemories("user", "user", { status: "pending" })).toHaveLength(1);

    const accepted = engine.updateMemory("user", "user", candidate.id, {
      status: "active",
      pinned: true,
    });
    expect(accepted).toMatchObject({ status: "active", pinned: true });

    const moved = engine.moveMemory("user", "user", candidate.id, "project", "project-a");
    expect(moved.scope).toBe("project");
    expect(engine.deleteMemory("project", "project-a", candidate.id)).toBe(true);
  });

  it("clears only the selected memory scope", async () => {
    const engine = await createEngine();
    engine.createMemory({
      scope: "user",
      scopeId: "user",
      content: "user memory",
      source: { kind: "user_command" },
    });
    engine.createMemory({
      scope: "project",
      scopeId: "project-a",
      content: "project memory",
      source: { kind: "user_command" },
    });
    expect(engine.clearScope("user", "user")).toBe(1);
    expect(engine.listMemories("user", "user")).toHaveLength(0);
    expect(engine.listMemories("project", "project-a")).toHaveLength(1);
  });
});
