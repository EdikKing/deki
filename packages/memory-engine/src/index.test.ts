import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  containsSensitiveData,
  estimateMemoryTokens,
  MemoryEngine,
  SensitiveMemoryError,
} from "./index";

const databases: Array<{ engine: MemoryEngine; directory: string }> = [];
const sqliteIntegrationTimeout = process.platform === "win32" ? 45_000 : 15_000;

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
  }, sqliteIntegrationTimeout);

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

  it("uses the search index to retrieve an older relevant memory", async () => {
    const engine = await createEngine();
    engine.createMemory({
      scope: "project",
      scopeId: "project-a",
      content: "桌面界面统一使用 Electron 与 React",
      source: { kind: "user_command" },
    });
    for (let index = 0; index < 130; index += 1) {
      engine.createMemory({
        scope: "project",
        scopeId: "project-a",
        content: `无关的构建记录 ${index}`,
        source: { kind: "migration" },
      });
    }

    const recalled = engine.recallMemories(
      "project",
      "project-a",
      "桌面项目采用什么界面框架",
      { limit: 3, characterBudget: 1_000 },
    );
    expect(recalled[0]?.content).toContain("Electron");
    expect(engine.listMemories("project", "project-a", { query: "桌面界面" })[0]?.content)
      .toContain("Electron");
  }, sqliteIntegrationTimeout);

  it("isolates task memories by session id and supports moving scopes", async () => {
    const engine = await createEngine();
    const taskMemory = engine.createMemory({
      scope: "task",
      scopeId: "session-a",
      content: "当前任务正在迁移支付接口",
      source: { kind: "user_command", sessionId: "session-a" },
      type: "task-state",
    });
    expect(engine.recallMemories("task", "session-a", "支付迁移")).toHaveLength(1);
    expect(engine.recallMemories("task", "session-b", "支付迁移")).toHaveLength(0);

    const moved = engine.moveMemory(
      "task",
      "session-a",
      taskMemory.id,
      "project",
      "project-a",
    );
    expect(moved).toMatchObject({ scope: "project", scopeId: "project-a" });
  });

  it("supports workspace and branch scopes with token budgets", async () => {
    const engine = await createEngine();
    engine.createMemory({
      scope: "workspace",
      scopeId: "workspace-a",
      content: "Use pnpm for dependency management",
      source: { kind: "user_command" },
    });
    engine.createMemory({
      scope: "branch",
      scopeId: "workspace-a:feature",
      content: "The feature branch is migrating checkout",
      source: { kind: "user_command" },
    });
    expect(engine.recallMemories("workspace", "workspace-a", "pnpm", {
      tokenBudget: 20,
    })).toHaveLength(1);
    expect(engine.recallMemories("branch", "workspace-a:feature", "checkout", {
      tokenBudget: 2,
    })).toHaveLength(0);
    expect(estimateMemoryTokens("你好 world")).toBeGreaterThanOrEqual(3);
  });

  it("archives expired and low-confidence memories and supersedes conflicts", async () => {
    const engine = await createEngine();
    const expired = engine.createMemory({
      scope: "user",
      scopeId: "user",
      content: "expired preference",
      type: "preference",
      source: { kind: "migration" },
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const low = engine.createMemory({
      scope: "user",
      scopeId: "user",
      content: "uncertain fact",
      source: { kind: "agent_candidate" },
      confidence: 0.2,
    });
    const previous = engine.createMemory({
      scope: "user",
      scopeId: "user",
      content: "Preferred package manager is npm for this project",
      type: "preference",
      source: { kind: "user_command" },
    });
    engine.createMemory({
      scope: "user",
      scopeId: "user",
      content: "Preferred package manager is pnpm for this project",
      type: "preference",
      source: { kind: "user_command" },
    });
    expect(expired.status).toBe("archived");
    expect(low.status).toBe("archived");
    expect(engine.listMemories("user", "user", { status: "superseded" })
      .map((memory) => memory.id)).toContain(previous.id);
  });

  it("migrates an existing v1 database and indexes its content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deki-memory-v1-"));
    const databasePath = join(directory, "memory.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
        type TEXT NOT NULL, content TEXT NOT NULL, source_json TEXT NOT NULL,
        confidence REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_used_at TEXT, expires_at TEXT, pinned INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
      );
      CREATE INDEX memories_scope_status_idx
        ON memories(scope, scope_id, status, updated_at DESC);
      INSERT INTO memories VALUES (
        'old', 'project', 'project-a', 'decision', '数据库使用 SQLite FTS',
        '{"kind":"migration"}', 1, '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', NULL, NULL, 0, 0, 'active'
      );
      PRAGMA user_version = 1;
    `);
    database.close();
    const engine = new MemoryEngine(databasePath);
    databases.push({ engine, directory });

    expect(engine.listMemories("project", "project-a", { query: "SQLite FTS" }))
      .toHaveLength(1);
  });
});
