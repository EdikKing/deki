import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "@deki-ai/settings";
import type { AgentEvent } from "@deki-ai/shared";
import {
  classifyShell,
  createUnifiedDiff,
  inspectShellBoundary,
  isSensitivePath,
  PermissionEngine,
  WorkspaceToolsProvider,
} from "./index";

describe("PermissionEngine", () => {
  it("provides structured Git inspection without accepting option injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-git-inspect-"));
    await promisify(execFile)("git", ["init"], { cwd: root });
    await writeFile(join(root, "untracked.txt"), "test", "utf8");
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings: defaultSettings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: () => {},
    });
    const provider = new WorkspaceToolsProvider(engine);
    const status = await provider.callTool(
      "git_inspect",
      { action: "status" },
      { callId: "git-status", workspace: root, interactionMode: "plan" },
    );
    expect(status.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("untracked.txt"),
    });
    await expect(provider.callTool(
      "git_inspect",
      { action: "show", revision: "--output=owned" },
      { callId: "git-injection", workspace: root, interactionMode: "plan" },
    )).rejects.toThrow("revision 包含不允许的字符");
  });

  it("acquires and commits a task resume lease before resolving approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-permissions-resume-"));
    const settings = structuredClone(defaultSettings);
    settings.permissions.policies["workspace.write"] = "ask";
    let requestId = "";
    let acquired = "";
    let committed = false;
    let resolvedContext = "";
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => "session",
      model: () => "provider/model",
      taskId: () => "task-1",
      runId: () => "run-1",
      acquireResumeLease: async (taskId, pendingRequestId) => {
        acquired = `${taskId}:${pendingRequestId}`;
        return {
          commit: () => {
            committed = true;
          },
          release: () => {},
        };
      },
      emit: (event) => {
        if (event.type === "approval.requested") requestId = event.requestId;
        if (event.type === "approval.resolved") {
          resolvedContext = `${event.taskId}:${event.runId}`;
        }
      },
    });
    const authorization = engine.authorize({
      callId: "write-approval",
      category: "workspace.write",
      title: "write",
      description: "write",
      details: {},
    });
    await Promise.resolve();
    expect(requestId).not.toBe("");
    expect(await engine.respond(requestId, "allow_once")).toBe(true);
    await authorization;
    expect(acquired).toBe(`task-1:${requestId}`);
    expect(committed).toBe(true);
    expect(resolvedContext).toBe("task-1:run-1");
  });

  it("resolves an approval in the session where it was requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-permissions-session-"));
    const settings = structuredClone(defaultSettings);
    settings.permissions.policies["shell.unknown"] = "ask";
    const events: AgentEvent[] = [];
    let currentSessionId = "session-a";
    let requestId = "";
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => currentSessionId,
      model: () => "provider/model",
      emit: (event) => {
        events.push(event);
        if (event.type === "approval.requested") requestId = event.requestId;
      },
    });
    const authorization = engine.authorize({
      callId: "session-approval",
      category: "shell.unknown",
      title: "shell",
      description: "shell",
      details: {},
    });
    await Promise.resolve();
    currentSessionId = "session-b";
    expect(await engine.respond(requestId, "allow_once")).toBe(true);
    await authorization;
    expect(events.find(
      (event) => event.type === "approval.resolved",
    )?.sessionId).toBe("session-a");
  });

  it("classifies privileged, git, install and safe shell commands", () => {
    expect(classifyShell("sudo rm -rf build")).toBe("privileged");
    expect(classifyShell("git push origin main")).toBe("git.push");
    expect(classifyShell("pnpm install")).toBe("dependencies.install");
    expect(classifyShell("git status")).toBe("shell.safe");
    expect(classifyShell("pnpm test")).toBe("shell.unknown");
    expect(inspectShellBoundary("cat /etc/passwd")?.category).toBe("outsideWorkspace");
    expect(inspectShellBoundary("cat ../secret")?.category).toBe("outsideWorkspace");
    expect(inspectShellBoundary("cat .env")?.category).toBe("sensitiveFiles");
    expect(inspectShellBoundary("python -c 'open(\"/tmp/x\")'")?.category).toBe("outsideWorkspace");
  });

  it("honors an explicit deny policy for sensitive paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-permissions-"));
    const settings = structuredClone(defaultSettings);
    settings.permissions.policies.sensitiveFiles = "deny";
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: () => {},
    });
    await expect(engine.authorizePath("call", "write", ".env")).rejects.toThrow(
      "权限策略拒绝",
    );
    expect(isSensitivePath(join(root, ".ssh", "id_ed25519"))).toBe(true);
  });

  it("lets full access override a per-tool policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-permissions-full-"));
    const settings = structuredClone(defaultSettings);
    for (const category of Object.keys(settings.permissions.policies) as Array<
      keyof typeof settings.permissions.policies
    >) {
      settings.permissions.policies[category] = "allow";
    }
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: () => {},
    });

    await expect(engine.authorize({
      callId: "full-access",
      category: "mcp.write",
      title: "MCP mutating tool",
      description: "Explicit tool policy",
      details: {},
      policy: "deny",
    })).resolves.toBeUndefined();
  });

  it("resolves policies independently for the active chat session", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-permissions-session-"));
    const settings = structuredClone(defaultSettings);
    let sessionId = "chat-a";
    const fullAccess = structuredClone(settings.permissions.policies);
    for (const category of Object.keys(fullAccess) as Array<keyof typeof fullAccess>) {
      fullAccess[category] = "allow";
    }
    const policies = new Map([
      ["chat-a", fullAccess],
      ["chat-b", {
        ...settings.permissions.policies,
        "workspace.write": "deny" as const,
      }],
    ]);
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => sessionId,
      model: () => "provider/model",
      resolvePolicies: () => policies.get(sessionId) ?? settings.permissions.policies,
      emit: () => {},
    });

    await expect(engine.authorize({
      callId: "chat-a-write",
      category: "workspace.write",
      title: "write",
      description: "write",
      details: {},
    })).resolves.toBeUndefined();

    sessionId = "chat-b";
    await expect(engine.authorize({
      callId: "chat-b-write",
      category: "workspace.write",
      title: "write",
      description: "write",
      details: {},
    })).rejects.toThrow("权限策略拒绝");
  });

  it("writes workspace files and returns a unified diff through the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-tools-"));
    const events: string[] = [];
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings: defaultSettings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: (event) => events.push(event.type),
    });
    const mutations: string[] = [];
    const provider = new WorkspaceToolsProvider(
      engine,
      undefined,
      undefined,
      async (operation) => {
        mutations.push(operation);
      },
    );
    const result = await provider.callTool(
      "write",
      { path: "hello.txt", content: "hello\n" },
      { callId: "write-1", workspace: root },
    );
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hello\n");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(events).toContain("diff.available");
    expect(events).toContain("audit.recorded");
    expect(mutations).toEqual(["write"]);
    const auditFile = join(root, "logs", `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const record = JSON.parse((await readFile(auditFile, "utf8")).trim()) as {
      execution: { status: string; result: { contentItems: number } };
      diff: string;
    };
    expect(record.execution).toEqual({
      status: "succeeded",
      result: { isError: false, contentItems: 1 },
    });
    expect(record.diff).toContain("+++ b/hello.txt");
  });

  it("does not checkpoint a known read-only shell command", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-shell-readonly-"));
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings: defaultSettings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: () => {},
    });
    const mutations: string[] = [];
    const provider = new WorkspaceToolsProvider(
      engine,
      undefined,
      undefined,
      async (operation) => {
        mutations.push(operation);
      },
    );
    await provider.callTool(
      "bash",
      { command: "pwd" },
      { callId: "bash-readonly", workspace: root },
    );
    expect(mutations).toEqual([]);
  });

  it("audits an execution failure after permission was granted", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-tools-failure-"));
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings: defaultSettings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: () => {},
    });
    const provider = new WorkspaceToolsProvider(engine);
    await expect(provider.callTool(
      "bash",
      { command: "ls path-that-does-not-exist" },
      { callId: "bash-failure", workspace: root },
    )).rejects.toThrow("命令退出");
    const auditFile = join(root, "logs", `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const record = JSON.parse((await readFile(auditFile, "utf8")).trim()) as {
      execution: { status: string; error: string };
    };
    expect(record.execution.status).toBe("failed");
    expect(record.execution.error).toContain("path-that-does-not-exist");
  });

  it("generates a complete diff", () => {
    expect(createUnifiedDiff("a.txt", "old", "new")).toContain(
      "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
    );
  });

  it("connects delete operations to workspace.delete and emits a pre-execution diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-delete-"));
    const events: Array<{ type: string; diff?: string | undefined }> = [];
    const settings = structuredClone(defaultSettings);
    settings.permissions.policies["workspace.delete"] = "allow";
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: (event) => events.push(event),
    });
    await writeFile(join(root, "remove.txt"), "remove me", "utf8");
    const provider = new WorkspaceToolsProvider(engine);
    await provider.callTool(
      "delete",
      { path: "remove.txt" },
      { callId: "delete-1", workspace: root },
    );
    await expect(access(join(root, "remove.txt"))).rejects.toThrow();
    expect(events.find((event) => event.type === "diff.available")?.diff).toContain(
      "+++ b/remove.txt",
    );
  });

  it("records workspace changes made by an approved shell command", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-shell-diff-"));
    const events: Array<{ type: string; diff?: string | undefined }> = [];
    const settings = structuredClone(defaultSettings);
    settings.permissions.policies["shell.unknown"] = "allow";
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: (event) => events.push(event),
    });
    await writeFile(join(root, "shell.txt"), "before\n", "utf8");
    const provider = new WorkspaceToolsProvider(engine);
    await provider.callTool(
      "bash",
      {
        command: process.platform === "win32"
          ? "echo after> shell.txt"
          : "printf 'after\\n' > shell.txt",
      },
      { callId: "shell-diff", workspace: root },
    );
    expect(events.find((event) => event.type === "diff.available")?.diff).toContain(
      "-before",
    );
  });

  it("captures file changes even when an approved shell command fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-shell-failed-diff-"));
    const events: Array<{ type: string; diff?: string | undefined }> = [];
    const settings = structuredClone(defaultSettings);
    settings.permissions.policies["shell.unknown"] = "allow";
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: (event) => events.push(event),
    });
    const provider = new WorkspaceToolsProvider(engine);
    await expect(provider.callTool(
      "bash",
      {
        command: process.platform === "win32"
          ? "echo partial> partial.txt & exit 2"
          : "printf 'partial\\n' > partial.txt; exit 2",
      },
      { callId: "shell-failed-diff", workspace: root },
    )).rejects.toThrow("命令退出");
    expect(events.find((event) => event.type === "diff.available")?.diff).toContain(
      "+++ b/partial.txt",
    );
    const auditFile = join(root, "logs", `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect((await readFile(auditFile, "utf8"))).toContain("partial.txt");
  });
});
