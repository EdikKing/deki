import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorkspaceTrusted,
  loadMcpConfig,
  resolveWorkspace,
  trustWorkspace,
  workspaceId,
} from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("config", () => {
  it("canonicalizes a workspace and creates a stable scope id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deki-config-"));
    temporaryDirectories.push(directory);
    const workspace = await resolveWorkspace(["--workspace", directory], process.cwd());
    expect(workspace).toBe(await realpath(directory));
    expect(workspaceId(workspace)).toMatch(/^[a-f0-9]{24}$/);
    expect(workspaceId(workspace)).toBe(workspaceId(workspace));
  });

  it("persists trust with restricted config content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deki-trust-"));
    temporaryDirectories.push(directory);
    const configFile = join(directory, "config.json");
    expect(await isWorkspaceTrusted(configFile, "/project")).toBe(false);
    await trustWorkspace(configFile, "/project");
    expect(await isWorkspaceTrusted(configFile, "/project")).toBe(true);
    expect(JSON.parse(await readFile(configFile, "utf8")).version).toBe(1);
  });

  it("resolves MCP cwd relative to the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "deki-mcp-config-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".deki"), { recursive: true });
    await writeFile(join(workspace, ".deki", "mcp.json"), JSON.stringify({
      mcpServers: {
        fixture: {
          command: "node",
          args: ["server.mjs"],
          cwd: "tools",
        },
      },
    }));
    const config = await loadMcpConfig(workspace);
    expect(config.mcpServers.fixture?.cwd).toBe(join(workspace, "tools"));
  });

  it("rejects unsupported MCP transport and secret fields", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "deki-mcp-invalid-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, ".deki"), { recursive: true });
    await writeFile(join(workspace, ".deki", "mcp.json"), JSON.stringify({
      mcpServers: {
        remote: {
          command: "node",
          env: { API_KEY: "not-supported" },
          url: "https://example.invalid/mcp",
        },
      },
    }));

    await expect(loadMcpConfig(workspace)).rejects.toThrow("无法读取");
  });
});
