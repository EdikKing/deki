import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDekiDirectories,
  getDekiPaths,
  isWorkspaceTrusted,
  loadMcpConfig,
  readLastActiveLocation,
  readMcpLocalConfig,
  resolveWorkspace,
  trustWorkspace,
  writeLastActiveLocation,
  writeMcpLocalConfig,
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
  it("creates the independent task database directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-paths-"));
    temporaryDirectories.push(root);
    const paths = getDekiPaths(root);
    await ensureDekiDirectories(paths);
    await expect(stat(join(root, "tasks"))).resolves.toBeTruthy();
    expect(paths.tasksDatabase).toBe(join(root, "tasks", "tasks.db"));
  });

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

  it("persists the last active workspace and session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deki-active-location-"));
    temporaryDirectories.push(directory);
    const configFile = join(directory, "config.json");

    await writeLastActiveLocation(configFile, {
      workspace: "/project",
      sessionId: "session-2",
    });

    await expect(readLastActiveLocation(configFile)).resolves.toEqual({
      workspace: "/project",
      sessionId: "session-2",
    });
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

  it("stores MCP environment only in the restricted local file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-mcp-local-"));
    temporaryDirectories.push(root);
    const file = join(root, "project", "mcp-local.json");
    await writeMcpLocalConfig(file, {
      servers: { fixture: { environment: { API_TOKEN: "secret" } } },
    });
    await expect(readMcpLocalConfig(file)).resolves.toEqual({
      servers: { fixture: { environment: { API_TOKEN: "secret" } } },
    });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });
});
