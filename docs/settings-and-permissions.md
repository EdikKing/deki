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

Approved writes emit a complete unified diff and append a redacted record to
`~/.deki/logs/audit-YYYY-MM-DD.jsonl`. Approval choices are one-time, session,
project-local, or deny. Approval timeout is equivalent to deny. There is no
`sandbox` policy value; legacy values migrate to `ask`.

The Electron renderer stays sandboxed with context isolation enabled. All
renderer inputs are validated in the preload and again in the main process.
