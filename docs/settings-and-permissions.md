# Settings and permissions

Deki resolves settings in this order:

1. session overrides
2. project-local settings (`~/.deki/projects/<workspace-hash>/settings.json`)
3. project-shared settings (`<project>/.deki/settings.json`)
4. global settings (`~/.deki/settings.json`)
5. product defaults

Each persisted document has a revision. Renderer updates include the expected
revision, so concurrent changes fail visibly instead of overwriting newer data.
Writes use a temporary file and rename, and the previous valid file is retained
as `.bak`. Invalid files are preserved with a `.corrupt-*` suffix.

Model providers are stored separately in `~/.deki/models.json` with mode `0600`.
Model IPC only returns `hasApiKey`; secrets are excluded from renderer
responses, audit logs and diagnostic exports.

General-only settings include appearance, privacy, diagnostics and application
startup behavior. Project scopes can override model policy, agent behavior,
workspace context, permissions, MCP, Skills and memory. Machine paths and
secrets never enter the project-shared document.

The current-session scope is in-memory only and sits above every persisted
layer. Individual fields, a section, or the entire selected scope can be reset.

## Tool security

General chats expose no project, file, shell, MCP, project skill or project
memory capabilities.

Trusted projects expose Deki-owned `workspace__*` tools. The Pi SDK's raw write
and shell tools are not enabled. Every controlled operation is classified as
`allow`, `ask` or `deny` before I/O:

- project reads and ordinary text edits default to `allow`;
- deletes, dependency changes, Git writes and complex shell default to `ask`;
- sensitive files, privilege escalation and paths outside the workspace default
  to `deny`;
- MCP tools are classified as read-only or potentially mutating.

Approved writes emit a complete unified diff in the conversation UI. The audit
record is finalized after real I/O and includes whether execution succeeded or
failed, together with redacted result/error details. Records are appended to
`~/.deki/logs/audit-YYYY-MM-DD.jsonl` and expired by the configured retention
period. Approval choices are one-time, session, project-local, or deny.
Approval timeout is equivalent to deny. There is no `sandbox` policy value;
legacy values migrate to `ask`.

Shell commands with explicit outside-workspace paths, sensitive paths, nested
shells, inline interpreters, command substitution, or dynamic evaluation are
denied before execution. Approved Shell commands snapshot workspace text files
and emit post-execution diffs. Destructive file and directory work uses the
dedicated `delete` and `move` tools so the approval includes a pre-execution
diff.

MCP lifecycle controls persist the enabled state and rebuild the affected agent
runtime so newly discovered tool schemas are available to the model. Tool
annotations are used instead of name guessing; each Tool supports an explicit
enable switch, permission and timeout. MCP environment variables are stored
only in the mode-`0600` project-local file and are masked in Renderer IPC.
Skills are reported with source, trust, validation, dependency and conflict
diagnostics.

Automatic memory is off by default. When enabled, the current conversation
model proposes at most three structured candidates after a successful task.
Candidates stay pending and are excluded from recall until the user accepts
them in the memory center.

The Electron renderer stays sandboxed with context isolation enabled. All
renderer inputs are validated in the preload and again in the main process.
