import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "@deki-ai/settings";
import {
  classifyShell,
  createUnifiedDiff,
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
    const provider = new WorkspaceToolsProvider(engine);
    const result = await provider.callTool(
      "write",
      { path: "hello.txt", content: "hello\n" },
      { callId: "write-1", workspace: root },
    );
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hello\n");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(events).toContain("diff.available");
    expect(events).toContain("audit.recorded");
  });

  it("generates a complete diff", () => {
    expect(createUnifiedDiff("a.txt", "old", "new")).toContain(
      "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new",
    );
  });
});
