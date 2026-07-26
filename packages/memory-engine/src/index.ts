import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  memoryRecordSchema,
  type MemoryRecord,
  type MemoryScope,
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
  rank?: number;
}

export class SensitiveMemoryError extends Error {
  constructor() {
    super("内容疑似包含密钥、令牌或私钥，未写入长期记忆");
    this.name = "SensitiveMemoryError";
  }
}

export class MemoryEngine {
  readonly #database: DatabaseSync;
  readonly #ftsAvailable: boolean;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.function(
      "deki_memory_terms",
      { deterministic: true },
      (content) => [...extractTerms(String(content ?? ""))].join(" "),
    );
    this.#migrate();
    this.#ftsAvailable = this.#initializeFullTextSearch();
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
    scope: MemoryScope;
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
    this.#indexMemory(memory.id, memory.content);

    return memory;
  }

  listProjectMemories(scopeId: string, limit = 100): MemoryRecord[] {
    return this.listMemories("project", scopeId, { limit, status: "active" });
  }

  listMemories(
    scope: MemoryScope,
    scopeId: string,
    options: { limit?: number; status?: MemoryRecord["status"]; query?: string } = {},
  ): MemoryRecord[] {
    const limit = options.limit ?? 100;
    const status = options.status ?? "active";
    const query = options.query?.trim();
    if (query) {
      const indexed = this.#searchIndex(scope, scopeId, query, limit, status);
      if (indexed.length > 0) return indexed;
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
    this.#indexMemory(id, normalized);
    return this.getProjectMemory(scopeId, id)!;
  }

  updateMemory(
    scope: MemoryScope,
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
    this.#indexMemory(id, content);
    return this.#getMemory(scope, scopeId, id)!;
  }

  moveMemory(
    fromScope: MemoryScope,
    fromScopeId: string,
    id: string,
    toScope: MemoryScope,
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

  deleteMemory(scope: MemoryScope, scopeId: string, id: string): boolean {
    return this.#database.prepare(
      "DELETE FROM memories WHERE id = ? AND scope = ? AND scope_id = ?",
    ).run(id, scope, scopeId).changes > 0;
  }

  clearScope(scope: MemoryScope, scopeId: string): number {
    return Number(this.#database.prepare(
      "DELETE FROM memories WHERE scope = ? AND scope_id = ?",
    ).run(scope, scopeId).changes);
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
    scope: MemoryScope,
    scopeId: string,
    query: string,
    options: { limit?: number; characterBudget?: number } = {},
  ): MemoryRecord[] {
    const limit = options.limit ?? 3;
    const characterBudget = options.characterBudget ?? 1_200;
    const queryTerms = extractTerms(query);
    const indexedRows = queryTerms.size > 0
      ? this.#searchIndex(scope, scopeId, query, Math.max(100, limit * 25), "active")
      : [];
    const fallbackRows = this.listMemories(scope, scopeId, {
      limit: Math.max(100, limit * 25),
    });
    const candidates = new Map<string, MemoryRecord>();
    for (const memory of [...indexedRows, ...fallbackRows]) candidates.set(memory.id, memory);
    const indexOrder = new Map(indexedRows.map((memory, index) => [memory.id, index]));

    const ranked = [...candidates.values()]
      .map((memory) => ({
        memory,
        score: scoreMemory(memory, queryTerms)
          + (indexOrder.has(memory.id) ? 8 / ((indexOrder.get(memory.id) ?? 0) + 1) : 0)
          + recencyScore(memory.updatedAt),
      }))
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));

    const selected: MemoryRecord[] = [];
    let usedCharacters = 0;
    for (const { memory, score } of ranked) {
      if (selected.length >= limit) break;
      if (queryTerms.size > 0 && score <= 0.5) continue;
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
    scope: MemoryScope,
    scopeId: string,
    id: string,
  ): MemoryRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM memories WHERE id = ? AND scope = ? AND scope_id = ?
    `).get(id, scope, scopeId) as unknown as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  #searchIndex(
    scope: MemoryScope,
    scopeId: string,
    query: string,
    limit: number,
    status: MemoryRecord["status"],
  ): MemoryRecord[] {
    if (this.#ftsAvailable) {
      const rows = this.#searchFts(scope, scopeId, query, limit, status);
      if (rows.length > 0) return rows;
    }
    const terms = [...extractTerms(query)].slice(0, 64);
    if (terms.length === 0) return [];
    const placeholders = terms.map(() => "?").join(", ");
    const rows = this.#database.prepare(`
      SELECT memories.*, SUM(memory_terms.frequency) AS rank
      FROM memory_terms
      JOIN memories ON memories.id = memory_terms.memory_id
      WHERE memory_terms.term IN (${placeholders})
        AND memories.scope = ? AND memories.scope_id = ? AND memories.status = ?
      GROUP BY memories.id
      ORDER BY memories.pinned DESC, rank DESC, memories.updated_at DESC
      LIMIT ?
    `).all(...terms, scope, scopeId, status, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  }

  #searchFts(
    scope: MemoryScope,
    scopeId: string,
    query: string,
    limit: number,
    status: MemoryRecord["status"],
  ): MemoryRecord[] {
    const ftsQuery = createFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.#database.prepare(`
      SELECT memories.*, bm25(memories_fts, 0.0, 1.0, 3.0) AS rank
      FROM memories_fts
      JOIN memories ON memories.id = memories_fts.memory_id
      WHERE memories_fts MATCH ?
        AND memories.scope = ? AND memories.scope_id = ? AND memories.status = ?
      ORDER BY rank, memories.pinned DESC, memories.updated_at DESC
      LIMIT ?
    `).all(ftsQuery, scope, scopeId, status, limit) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  }

  #indexMemory(id: string, content: string): void {
    const deleteStatement = this.#database.prepare(
      "DELETE FROM memory_terms WHERE memory_id = ?",
    );
    const insertStatement = this.#database.prepare(`
      INSERT INTO memory_terms(memory_id, term, frequency) VALUES (?, ?, ?)
    `);
    deleteStatement.run(id);
    for (const [term, frequency] of countTerms(content)) {
      insertStatement.run(id, term, frequency);
    }
  }

  #initializeFullTextSearch(): boolean {
    try {
      this.#database.exec(`
        BEGIN;
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          memory_id UNINDEXED,
          content,
          terms,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        DELETE FROM memories_fts;
        INSERT INTO memories_fts(memory_id, content, terms)
          SELECT id, content, deki_memory_terms(content) FROM memories;
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(memory_id, content, terms)
            VALUES (new.id, new.content, deki_memory_terms(new.content));
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
          UPDATE memories_fts
            SET content = new.content, terms = deki_memory_terms(new.content)
            WHERE memory_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
          DELETE FROM memories_fts WHERE memory_id = old.id;
        END;
        COMMIT;
      `);
      return true;
    } catch {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back the failed virtual-table transaction.
      }
      return false;
    }
  }

  #migrate(): void {
    const version = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version < 1) {
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
    if (version.user_version < 2) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE memory_terms (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          term TEXT NOT NULL,
          frequency INTEGER NOT NULL,
          PRIMARY KEY(memory_id, term)
        ) WITHOUT ROWID;
        CREATE INDEX memory_terms_term_idx ON memory_terms(term, memory_id);
        PRAGMA user_version = 2;
        COMMIT;
      `);
      const rows = this.#database.prepare(
        "SELECT id, content FROM memories",
      ).all() as unknown as Array<{ id: string; content: string }>;
      for (const row of rows) this.#indexMemory(row.id, row.content);
    }
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

function recencyScore(updatedAt: string): number {
  const ageDays = Math.max(0, Date.now() - Date.parse(updatedAt)) / 86_400_000;
  return 0.5 / (1 + ageDays / 30);
}

function createFtsQuery(value: string): string {
  const terms = [...extractTerms(value)]
    .filter((term) => term.length >= 2)
    .slice(0, 64);
  return terms.map((term) =>
    `terms:"${term.replaceAll("\"", "\"\"")}"`).join(" OR ");
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

function countTerms(value: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of extractTerms(value)) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}
