import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpManager } from "./index";

const managers: McpManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

describe("McpManager", () => {
  it("starts a stdio server, lists tools, and normalizes success and error results", async () => {
    const manager = new McpManager();
    managers.push(manager);
    const fixture = resolve(process.cwd(), "tests/fixtures/mcp-server.mjs");
    const providers = await manager.start({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          cwd: process.cwd(),
          enabled: true,
        },
      },
    });

    expect(manager.getStatuses()).toEqual([
      { id: "fixture", state: "ready", toolCount: 4 },
    ]);
    const provider = providers[0];
    expect(provider).toBeDefined();
    await expect(provider!.listTools()).resolves.toHaveLength(4);
    const result = await provider!.callTool(
      "echo",
      { text: "DEKI_MCP_OK" },
      { callId: "call-1", workspace: process.cwd() },
    );
    expect(result.content).toContainEqual({
      type: "text",
      text: "DEKI_MCP_OK",
    });
    const controlledError = await provider!.callTool(
      "fail",
      {},
      { callId: "call-2", workspace: process.cwd() },
    );
    expect(controlledError.isError).toBe(true);
    expect(controlledError.content).toContainEqual({
      type: "text",
      text: "controlled failure",
    });
    await expect(provider!.healthCheck()).resolves.toEqual({ state: "ready" });
  });

  it("cancels a slow call and releases the transport", async () => {
    const manager = new McpManager();
    managers.push(manager);
    const fixture = resolve(process.cwd(), "tests/fixtures/mcp-server.mjs");
    const [provider] = await manager.start({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          cwd: process.cwd(),
          enabled: true,
        },
      },
    });

    await expect(provider!.callTool(
      "slow",
      { milliseconds: 2_000 },
      {
        callId: "call-timeout",
        workspace: process.cwd(),
        signal: AbortSignal.timeout(25),
      },
    )).rejects.toThrow();

    await manager.dispose();
    await expect(provider!.healthCheck()).resolves.toEqual({
      state: "error",
      message: "MCP Server 未连接",
    });
  });

  it("reports a server that exits during startup", async () => {
    const manager = new McpManager();
    managers.push(manager);
    await manager.start({
      mcpServers: {
        broken: {
          command: process.execPath,
          args: ["--eval", "process.exit(17)"],
          cwd: process.cwd(),
          enabled: true,
        },
      },
    });

    expect(manager.getStatuses()[0]).toMatchObject({
      id: "broken",
      state: "error",
      toolCount: 0,
    });
    expect(manager.getProviders()).toHaveLength(0);
  });

  it("marks a running server as failed after an abnormal exit", async () => {
    const manager = new McpManager();
    managers.push(manager);
    const fixture = resolve(process.cwd(), "tests/fixtures/mcp-server.mjs");
    const [provider] = await manager.start({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          cwd: process.cwd(),
          enabled: true,
        },
      },
    });

    await expect(provider!.callTool(
      "crash",
      {},
      { callId: "call-crash", workspace: process.cwd() },
    )).rejects.toThrow();
    await vi.waitFor(() => {
      expect(manager.getStatuses()[0]).toMatchObject({
        id: "fixture",
        state: "error",
      });
    });
    expect(manager.getProviders()).toHaveLength(0);
  });
});
