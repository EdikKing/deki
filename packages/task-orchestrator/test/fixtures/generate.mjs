import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = dirname(fileURLToPath(import.meta.url));
const taskId = "00000000-0000-4000-8000-000000000101";
const runId = "00000000-0000-4000-8000-000000000102";
const planId = "00000000-0000-4000-8000-000000000103";
const createdAt = "2026-01-01T00:00:00.000Z";

mkdirSync(root, { recursive: true });

for (const version of [1, 2, 3, 4, 5, 6]) {
  const path = join(root, `tasks-v${version}.db`);
  rmSync(path, { force: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  createV1(database);
  if (version >= 2) migrateToV2(database);
  if (version >= 3) migrateToV3(database);
  if (version >= 4) migrateToV4(database);
  if (version >= 5) migrateToV5(database);
  if (version >= 6) migrateToV6(database);
  seedVersionData(database, version);
  database.exec(`PRAGMA user_version = ${version}`);
  database.close();
}

function createV1(database) {
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      root_task_id TEXT NOT NULL, parent_task_id TEXT REFERENCES tasks(id),
      kind TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      session_id TEXT, plan_id TEXT, current_run_id TEXT,
      assigned_profile TEXT, execution_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX tasks_workspace_schedule_idx
      ON tasks(workspace_id, status, priority DESC, created_at ASC);
    CREATE INDEX tasks_workspace_updated_idx
      ON tasks(workspace_id, updated_at DESC);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL, status TEXT NOT NULL, session_id TEXT,
      runner_id TEXT NOT NULL, model_provider TEXT, model_id TEXT,
      started_at TEXT, finished_at TEXT, error TEXT, result_summary TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id, attempt)
    );
    CREATE INDEX runs_task_attempt_idx ON runs(task_id, attempt);
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, uri TEXT, content TEXT,
      metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX artifacts_task_created_idx ON artifacts(task_id, created_at);
    CREATE TABLE task_events (
      event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, session_id TEXT,
      timestamp TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, UNIQUE(task_id, sequence)
    );
    CREATE INDEX task_events_task_sequence_idx ON task_events(task_id, sequence);
  `);
}

function migrateToV2(database) {
  database.exec(`
    ALTER TABLE tasks ADD COLUMN workspace_path TEXT;
    CREATE INDEX tasks_global_schedule_idx
      ON tasks(status, priority DESC, created_at ASC);
    CREATE TABLE task_requests (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, payload_json TEXT NOT NULL, response_json TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE INDEX task_requests_pending_idx
      ON task_requests(task_id, status, created_at);
  `);
}

function migrateToV3(database) {
  database.exec(`
    CREATE TABLE plans (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT,
      session_id TEXT NOT NULL, planning_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      execution_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      goal TEXT NOT NULL, status TEXT NOT NULL, current_revision INTEGER NOT NULL,
      approved_revision INTEGER, executing_revision INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX plans_workspace_updated_idx ON plans(workspace_id, updated_at DESC);
    CREATE INDEX plans_status_updated_idx ON plans(status, updated_at DESC);
    CREATE TABLE plan_revisions (
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, feedback TEXT, assumptions_json TEXT NOT NULL,
      constraints_json TEXT NOT NULL, steps_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(plan_id, revision)
    );
    CREATE TABLE plan_step_states (
      plan_id TEXT NOT NULL, revision INTEGER NOT NULL, step_id TEXT NOT NULL,
      status TEXT NOT NULL, summary TEXT, evidence_json TEXT NOT NULL,
      reason TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, revision, step_id),
      FOREIGN KEY(plan_id, revision)
        REFERENCES plan_revisions(plan_id, revision) ON DELETE CASCADE
    );
    CREATE TABLE plan_events (
      event_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      timestamp TEXT NOT NULL, sequence INTEGER NOT NULL,
      type TEXT NOT NULL, payload_json TEXT NOT NULL,
      UNIQUE(plan_id, sequence)
    );
    CREATE INDEX plan_events_plan_sequence_idx ON plan_events(plan_id, sequence);
  `);
}

function migrateToV4(database) {
  database.exec(`
    ALTER TABLE tasks ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'foreground';
    ALTER TABLE plans ADD COLUMN replan_reason TEXT;
    ALTER TABLE plans ADD COLUMN affected_step_ids_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE plans ADD COLUMN replan_evidence_json TEXT NOT NULL DEFAULT '[]';
  `);
}

function migrateToV5(database) {
  database.exec(`
    CREATE TABLE worker_delegations (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL,
      status TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(parent_run_id, tool_call_id)
    );
    CREATE TABLE worker_delegation_tasks (
      delegation_id TEXT NOT NULL REFERENCES worker_delegations(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY(delegation_id, task_id)
    );
    CREATE TABLE worker_results (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, run_id)
    );
    CREATE TABLE task_budgets (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      budget_json TEXT NOT NULL,
      workers INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      warning_emitted INTEGER NOT NULL DEFAULT 0,
      exceeded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX worker_delegations_parent_idx
      ON worker_delegations(parent_task_id, status, created_at);
  `);
}

function migrateToV6(database) {
  database.exec(`
    CREATE TABLE implementation_results (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, run_id)
    );
    CREATE TABLE write_batches (
      id TEXT PRIMARY KEY,
      root_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      baseline_commit TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX write_batches_root_idx
      ON write_batches(root_task_id, created_at);
    CREATE TABLE integrations (
      id TEXT PRIMARY KEY,
      root_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      record_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX integrations_root_idx ON integrations(root_task_id, created_at);
    CREATE INDEX integrations_task_idx ON integrations(task_id, created_at);
    CREATE TABLE runner_resources (
      id TEXT PRIMARY KEY,
      root_task_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL,
      cleanup_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX runner_resources_cleanup_idx
      ON runner_resources(status, updated_at);
    CREATE TABLE artifact_files (
      artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
      uri TEXT NOT NULL,
      sha256 TEXT,
      size_bytes INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX artifact_files_uri_idx ON artifact_files(uri);
    CREATE INDEX artifact_files_sha_idx ON artifact_files(sha256);
    INSERT INTO artifact_files (artifact_id, uri, created_at)
    SELECT id, uri, created_at FROM artifacts WHERE uri IS NOT NULL;
  `);
}

function seedVersionData(database, version) {
  const taskColumns = version >= 4
    ? `id, workspace_id, workspace_path, root_task_id, kind, title, goal, status,
       priority, execution_json, delivery_mode, created_at, updated_at`
    : version >= 2
      ? `id, workspace_id, workspace_path, root_task_id, kind, title, goal, status,
         priority, execution_json, created_at, updated_at`
      : `id, workspace_id, root_task_id, kind, title, goal, status,
         priority, execution_json, created_at, updated_at`;
  const taskValues = version >= 4
    ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
    : version >= 2
      ? "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
      : "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  const values = [
    taskId,
    "fixture-workspace",
    ...(version >= 2 ? ["/tmp/deki-fixture"] : []),
    taskId,
    version >= 3 ? "planning" : "background",
    `fixture v${version}`,
    `fixture v${version}`,
    "succeeded",
    0,
    JSON.stringify({
      type: "agent-prompt",
      sourceSessionId: "fixture-session",
      sourceSessionFile: "/tmp/fixture-session.jsonl",
      sourceEntryId: "fixture-entry",
      preferFork: true,
      interactionMode: version >= 3 ? "plan" : "act",
    }),
    ...(version >= 4 ? ["background"] : []),
    createdAt,
    createdAt,
  ];
  database.prepare(`INSERT INTO tasks (${taskColumns}) VALUES (${taskValues})`).run(...values);
  database.prepare(`
    INSERT INTO runs (
      id, task_id, attempt, status, session_id, runner_id,
      started_at, finished_at, input_tokens, output_tokens, tool_call_count
    ) VALUES (?, ?, 1, 'succeeded', 'fixture-session', 'local', ?, ?, 1, 2, 3)
  `).run(runId, taskId, createdAt, createdAt);
  if (version >= 2) {
    database.prepare(`
      INSERT INTO task_requests (
        id, task_id, run_id, kind, status, title, payload_json,
        response_json, created_at, resolved_at
      ) VALUES (?, ?, ?, 'approval', 'resolved', 'fixture request', '{}', '{}', ?, ?)
    `).run("00000000-0000-4000-8000-000000000104", taskId, runId, createdAt, createdAt);
  }
  if (version >= 3) {
    const planColumns = version >= 4
      ? `id, workspace_id, workspace_path, session_id, planning_task_id, goal,
         status, current_revision, replan_reason, affected_step_ids_json,
         replan_evidence_json, created_at, updated_at`
      : `id, workspace_id, workspace_path, session_id, planning_task_id, goal,
         status, current_revision, created_at, updated_at`;
    const planValues = version >= 4
      ? "?, ?, ?, ?, ?, ?, 'ready', 1, NULL, '[]', '[]', ?, ?"
      : "?, ?, ?, ?, ?, ?, 'ready', 1, ?, ?";
    database.prepare(`INSERT INTO plans (${planColumns}) VALUES (${planValues})`).run(
      planId,
      "fixture-workspace",
      "/tmp/deki-fixture",
      "fixture-session",
      taskId,
      "fixture plan",
      createdAt,
      createdAt,
    );
    const steps = [{
      id: "inspect",
      title: "Inspect",
      description: "Inspect",
      dependencies: [],
      candidateFiles: ["src/index.ts"],
      validation: ["test"],
      risk: "low",
      parallelizable: false,
    }];
    database.prepare(`
      INSERT INTO plan_revisions (
        plan_id, revision, assumptions_json, constraints_json, steps_json, created_at
      ) VALUES (?, 1, '[]', '[]', ?, ?)
    `).run(planId, JSON.stringify(steps), createdAt);
    database.prepare(`
      INSERT INTO plan_step_states (
        plan_id, revision, step_id, status, evidence_json, updated_at
      ) VALUES (?, 1, 'inspect', 'pending', '[]', ?)
    `).run(planId, createdAt);
  }
}
