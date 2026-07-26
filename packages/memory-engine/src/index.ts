import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  memoryRecordSchema,
  type MemoryRecord,
  type MemorySource,
} from "@deki-ai/shared";

interface MemoryRow {
  id: string;
  scope: string;
  scope_id: string;
  type: string;
  content: string;
  source_json: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  pinned: number;
  sensitive: number;
  status: string;
}

export class SensitiveMemoryError extends Error {
  constructor() {
    super("内容疑似包含密钥、令牌或私钥，未写入长期记忆");
    this.name = "SensitiveMemoryError";
  }
}

export class MemoryEngine {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  createProjectMemory(input: {
    scopeId: string;
    content: string;
    source: MemorySource;
    type?: MemoryRecord["type"];
  }): MemoryRecord {
    return this.createMemory({
      scope: "project",
      scopeId: input.scopeId,
      content: input.content,
      source: input.source,
      ...(input.type ? { type: input.type } : {}),
    });
  }

  createMemory(input: {
    scope: "user" | "project";
    scopeId: string;
    content: string;
    source: MemorySource;
    type?: MemoryRecord["type"];
    status?: MemoryRecord["status"];
  }): MemoryRecord {
    const content = input.content.trim();
    if (!content) {
      throw new Error("记忆内容不能为空");
    }
    if (containsSensitiveData(content)) {
      throw new SensitiveMemoryError();
    }

    const now = new Date().toISOString();
    const memory = memoryRecordSchema.parse({
      id: randomUUID(),
      scope: input.scope,
      scopeId: input.scopeId,
      type: input.type ?? "fact",
      content,
      source: input.source,
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      sensitive: false,
      status: input.status ?? "active",
    });

    this.#database.prepare(`
      INSERT INTO memories (
        id, scope, scope_id, type, content, source_json, confidence,
        created_at, updated_at, last_used_at, expires_at, pinned, sensitive, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      memory.id,
      memory.scope,
      memory.scopeId,
      memory.type,
      memory.content,
      JSON.stringify(memory.source),
      memory.confidence,
      memory.createdAt,
      memory.updatedAt,
      Number(memory.pinned),
      Number(memory.sensitive),
      memory.status,
    );

    return memory;
  }

  listProjectMemories(scopeId: string, limit = 100): MemoryRecord[] {
    return this.listMemories("project", scopeId, { limit, status: "active" });
  }

  listMemories(
    scope: "user" | "project",
    scopeId: string,
    options: { limit?: number; status?: MemoryRecord["status"]; query?: string } = {},
  ): MemoryRecord[] {
    const limit = options.limit ?? 100;
    const status = options.status ?? "active";
    const query = options.query?.trim();
    if (query) {
      const rows = this.#database.prepare(`
        SELECT *
        FROM memories
        WHERE scope = ? AND scope_id = ? AND status = ? AND content LIKE ?
        ORDER BY pinned DESC, updated_at DESC
        LIMIT ?
      `).all(scope, scopeId, status, `%${query}%`, limit) as unknown as MemoryRow[];
      return rows.map(rowToMemory);
    }
    const rows = this.#database.prepare(`
      SELECT *
      FROM memories
      WHERE scope = ? AND scope_id = ? AND status = ?
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ?
    `).all(scope, scopeId, status, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  }

  getProjectMemory(scopeId: string, id: string): MemoryRecord | undefined {
    const row = this.#database.prepare(`
      SELECT *
      FROM memories
      WHERE id = ? AND scope = 'project' AND scope_id = ? AND status = 'active'
    `).get(id, scopeId) as unknown as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  updateProjectMemory(
    scopeId: string,
    id: string,
    content: string,
  ): MemoryRecord {
    const normalized = content.trim();
    if (!normalized) {
      throw new Error("记忆内容不能为空");
    }
    if (containsSensitiveData(normalized)) {
      throw new SensitiveMemoryError();
    }
    const updatedAt = new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE memories
      SET content = ?, updated_at = ?
      WHERE id = ? AND scope = 'project' AND scope_id = ? AND status = 'active'
    `).run(normalized, updatedAt, id, scopeId);
    if (result.changes === 0) {
      throw new Error("未找到项目记忆");
    }
    return this.getProjectMemory(scopeId, id)!;
  }

  updateMemory(
    scope: "user" | "project",
    scopeId: string,
    id: string,
    patch: { content?: string; pinned?: boolean; status?: MemoryRecord["status"] },
  ): MemoryRecord {
    const current = this.#getMemory(scope, scopeId, id);
    if (!current) throw new Error("未找到记忆");
    const content = patch.content?.trim() ?? current.content;
    if (!content) throw new Error("记忆内容不能为空");
    if (containsSensitiveData(content)) throw new SensitiveMemoryError();
    const updatedAt = new Date().toISOString();
    this.#database.prepare(`
      UPDATE memories
      SET content = ?, pinned = ?, status = ?, updated_at = ?
      WHERE id = ? AND scope = ? AND scope_id = ?
    `).run(
      content,
      Number(patch.pinned ?? current.pinned),
      patch.status ?? current.status,
      updatedAt,
      id,
      scope,
      scopeId,
    );
    return this.#getMemory(scope, scopeId, id)!;
  }

  moveMemory(
    fromScope: "user" | "project",
    fromScopeId: string,
    id: string,
    toScope: "user" | "project",
    toScopeId: string,
  ): MemoryRecord {
    const current = this.#getMemory(fromScope, fromScopeId, id);
    if (!current) throw new Error("未找到记忆");
    this.#database.prepare(`
      UPDATE memories SET scope = ?, scope_id = ?, updated_at = ?
      WHERE id = ? AND scope = ? AND scope_id = ?
    `).run(toScope, toScopeId, new Date().toISOString(), id, fromScope, fromScopeId);
    return this.#getMemory(toScope, toScopeId, id)!;
  }

  deleteMemory(scope: "user" | "project", scopeId: string, id: string): boolean {
    return this.#database.prepare(
      "DELETE FROM memories WHERE id = ? AND scope = ? AND scope_id = ?",
    ).run(id, scope, scopeId).changes > 0;
  }

  archiveProjectMemory(scopeId: string, id: string): boolean {
    const result = this.#database.prepare(`
      UPDATE memories
      SET status = 'archived', updated_at = ?
      WHERE id = ? AND scope = 'project' AND scope_id = ? AND status = 'active'
    `).run(new Date().toISOString(), id, scopeId);
    return result.changes > 0;
  }

  recallProjectMemories(
    scopeId: string,
    query: string,
    options: { limit?: number; characterBudget?: number } = {},
  ): MemoryRecord[] {
    return this.recallMemories("project", scopeId, query, options);
  }

  recallMemories(
    scope: "user" | "project",
    scopeId: string,
    query: string,
    options: { limit?: number; characterBudget?: number } = {},
  ): MemoryRecord[] {
    const limit = options.limit ?? 3;
    const characterBudget = options.characterBudget ?? 1_200;
    const candidates = this.listMemories(scope, scopeId);
    const queryTerms = extractTerms(query);

    const ranked = candidates
      .map((memory) => ({
        memory,
        score: scoreMemory(memory, queryTerms),
      }))
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));

    const selected: MemoryRecord[] = [];
    let usedCharacters = 0;
    for (const { memory, score } of ranked) {
      if (selected.length >= limit) break;
      if (queryTerms.size > 0 && score <= 0 && selected.length > 0) continue;
      if (usedCharacters + memory.content.length > characterBudget) continue;
      selected.push(memory);
      usedCharacters += memory.content.length;
    }

    if (selected.length > 0) {
      const now = new Date().toISOString();
      const statement = this.#database.prepare(
        "UPDATE memories SET last_used_at = ? WHERE id = ?",
      );
      for (const memory of selected) {
        statement.run(now, memory.id);
      }
    }

    return selected;
  }

  close(): void {
    this.#database.close();
  }

  #getMemory(
    scope: "user" | "project",
    scopeId: string,
    id: string,
  ): MemoryRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM memories WHERE id = ? AND scope = ? AND scope_id = ?
    `).get(id, scope, scopeId) as unknown as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  #migrate(): void {
    const version = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version >= 1) return;

    this.#database.exec(`
      BEGIN;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        source_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL
      );
      CREATE INDEX memories_scope_status_idx
        ON memories(scope, scope_id, status, updated_at DESC);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
}

export function containsSensitiveData(content: string): boolean {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/,
    /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
    /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  return patterns.some((pattern) => pattern.test(content));
}

function rowToMemory(row: MemoryRow): MemoryRecord {
  return memoryRecordSchema.parse({
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    type: row.type,
    content: row.content,
    source: JSON.parse(row.source_json),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    pinned: row.pinned === 1,
    sensitive: row.sensitive === 1,
    status: row.status,
  });
}

function scoreMemory(memory: MemoryRecord, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return memory.pinned ? 2 : 1;
  const memoryTerms = extractTerms(memory.content);
  let overlap = 0;
  for (const term of queryTerms) {
    if (memoryTerms.has(term)) overlap += 1;
  }
  const normalized = memory.content.toLocaleLowerCase();
  const direct = [...queryTerms].some((term) => term.length >= 3 && normalized.includes(term))
    ? 2
    : 0;
  return overlap + direct + (memory.pinned ? 2 : 0);
}

function extractTerms(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set(
    normalized
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  );
  const cjkRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const run of cjkRuns) {
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return terms;
}
