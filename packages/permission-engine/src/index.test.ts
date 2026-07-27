import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "@deki-ai/settings";
import {
  classifyShell,
  createUnifiedDiff,
  inspectShellBoundary,
  isSensitivePath,
  PermissionEngine,
  WorkspaceToolsProvider,
} from "./index";

describe("PermissionEngine", () => {
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

  it("denies sensitive paths regardless of workspace write defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-permissions-"));
    const engine = new PermissionEngine({
      workspace: root,
      logsRoot: join(root, "logs"),
      settings: defaultSettings,
      sessionId: () => "session",
      model: () => "provider/model",
      emit: () => {},
    });
    await expect(engine.authorizePath("call", "write", ".env")).rejects.toThrow(
      "权限策略拒绝",
    );
    expect(isSensitivePath(join(root, ".ssh", "id_ed25519"))).toBe(true);
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
          ? "echo partial> partial.txt & exit /b 2"
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
