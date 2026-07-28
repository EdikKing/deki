import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityProvider,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@deki-ai/shared";
import { ToolGateway, type ToolGatewayEvent } from "./index";

class FixtureProvider implements CapabilityProvider {
  readonly id = "fixture";
  readOnly = false;
  readonly call = vi.fn(async (
    _name: string,
    input: unknown,
    _context: ToolCallContext,
  ): Promise<ToolResult> => ({
    content: [{ type: "text", text: JSON.stringify(input) }],
  }));

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "echo",
      description: "Echo input",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      ...(this.readOnly ? { readOnlyHint: true, effect: "read" as const } : {}),
    }];
  }

  callTool = this.call;

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose() {}
}

describe("ToolGateway", () => {
  it("namespaces, validates and dispatches tools", async () => {
    const gateway = new ToolGateway();
    const provider = new FixtureProvider();
    const tools = await gateway.register(provider);
    expect(tools[0]?.internalName).toBe("fixture.echo");
    expect(tools[0]?.modelName).toBe("fixture__echo");

    const result = await gateway.call(
      "fixture__echo",
      { text: "hello" },
      { callId: "call-1", workspace: "/tmp" },
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: '{"text":"hello"}',
    });
    expect(provider.call).toHaveBeenCalledOnce();
    await gateway.dispose();
  });

  it("rejects arguments that do not match JSON Schema", async () => {
    const gateway = new ToolGateway();
    await gateway.register(new FixtureProvider());
    await expect(
      gateway.call(
        "fixture__echo",
        { text: 42 },
        { callId: "call-2", workspace: "/tmp" },
      ),
    ).rejects.toThrow("Tool 参数无效");
    await gateway.dispose();
  });

  it("enforces Plan mode read-only policy before provider dispatch", async () => {
    const gateway = new ToolGateway();
    const provider = new FixtureProvider();
    await gateway.register(provider);

    await expect(gateway.call(
      "fixture__echo",
      { text: "write something" },
      {
        callId: "plan-write",
        workspace: "/tmp",
        interactionMode: "plan",
      },
    )).rejects.toMatchObject({
      code: "PLAN_MODE_READ_ONLY",
      toolName: "fixture__echo",
    });
    expect(provider.call).not.toHaveBeenCalled();
    await gateway.dispose();
  });

  it("allows explicitly read-only tools in Plan mode", async () => {
    const gateway = new ToolGateway();
    const provider = new FixtureProvider();
    provider.readOnly = true;
    await gateway.register(provider);

    await expect(gateway.call(
      "fixture__echo",
      { text: "inspect" },
      {
        callId: "plan-read",
        workspace: "/tmp",
        interactionMode: "plan",
      },
    )).resolves.toMatchObject({
      content: [{ type: "text", text: "{\"text\":\"inspect\"}" }],
    });
    expect(provider.call).toHaveBeenCalledOnce();
    await gateway.dispose();
  });

  it("enforces the Worker hard policy before dispatch or gateway events", async () => {
    const gateway = new ToolGateway();
    const provider = new FixtureProvider();
    const events: ToolGatewayEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    await gateway.register(provider);

    await expect(gateway.call(
      "fixture__echo",
      { text: "attempt unknown side effect" },
      {
        callId: "worker-unknown",
        workspace: "/tmp",
        interactionMode: "worker",
        workerProfile: "explorer",
      },
    )).rejects.toMatchObject({
      code: "WORKER_MODE_READ_ONLY",
      toolName: "fixture__echo",
    });
    expect(provider.call).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await gateway.dispose();
  });

  it("allows explicitly read-only tools for Workers", async () => {
    const gateway = new ToolGateway();
    const provider = new FixtureProvider();
    provider.readOnly = true;
    await gateway.register(provider);

    await expect(gateway.call(
      "fixture__echo",
      { text: "inspect" },
      {
        callId: "worker-read",
        workspace: "/tmp",
        interactionMode: "worker",
        workerProfile: "reviewer",
      },
    )).resolves.toMatchObject({
      content: [{ type: "text", text: "{\"text\":\"inspect\"}" }],
    });
    expect(provider.call).toHaveBeenCalledOnce();
    await gateway.dispose();
  });

  it.each([
    "find . -delete",
    "rg token . | tee leaked.txt",
    "git --no-pager diff",
    "git status",
    "python -c 'open(\"owned\", \"w\").write(\"x\")'",
    "npm install left-pad",
  ])("rejects all free-form shell in Plan mode before dispatch: %s", async (command) => {
    const gateway = new ToolGateway();
    const provider = new ShellProvider();
    await gateway.register(provider);

    await expect(gateway.call(
      "workspace__bash",
      { command },
      {
        callId: "plan-shell",
        workspace: "/tmp",
        interactionMode: "plan",
      },
    )).rejects.toMatchObject({ code: "PLAN_MODE_READ_ONLY" });
    expect(provider.call).not.toHaveBeenCalled();
    await gateway.dispose();
  });

  it("rejects free-form shell for every Worker profile before dispatch", async () => {
    for (const workerProfile of ["explorer", "tester", "reviewer"] as const) {
      const gateway = new ToolGateway();
      const provider = new ShellProvider();
      await gateway.register(provider);
      await expect(gateway.call(
        "workspace__bash",
        { command: "git status" },
        {
          callId: `worker-shell-${workerProfile}`,
          workspace: "/tmp",
          interactionMode: "worker",
          workerProfile,
        },
      )).rejects.toMatchObject({ code: "WORKER_MODE_READ_ONLY" });
      expect(provider.call).not.toHaveBeenCalled();
      await gateway.dispose();
    }
  });

  it("allows isolated Implementer shell but hard-denies Git mutations", async () => {
    const gateway = new ToolGateway();
    const provider = new ShellProvider();
    await gateway.register(provider);
    await expect(gateway.call(
      "workspace__bash",
      { command: "pnpm test" },
      {
        callId: "implementer-test",
        workspace: "/tmp/worktree",
        interactionMode: "worker",
        workerProfile: "implementer",
      },
    )).resolves.toBeTruthy();
    await expect(gateway.call(
      "workspace__bash",
      { command: "git add -A && git commit -m owned" },
      {
        callId: "implementer-git",
        workspace: "/tmp/worktree",
        interactionMode: "worker",
        workerProfile: "implementer",
      },
    )).rejects.toMatchObject({ code: "WORKER_MODE_READ_ONLY" });
    expect(provider.call).toHaveBeenCalledTimes(1);
    await gateway.dispose();
  });

  it("redacts secrets from results, structured details, events and errors", async () => {
    const secret = "sk-abcdefghijklmnop";
    const provider = new ResultProvider({
      content: [{ type: "text", text: `token=${secret}` }],
      details: {
        password: "do-not-log",
        nested: `Bearer ${secret}`,
      },
    });
    const gateway = new ToolGateway();
    const events: ToolGatewayEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    await gateway.register(provider);

    const result = await gateway.call(
      "result__get",
      { apiKey: secret },
      { callId: "redact-1", workspace: "/tmp" },
    );

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("do-not-log");
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "token=[REDACTED]",
    });
    expect(result.details).toEqual({
      password: "[REDACTED]",
      nested: "Bearer [REDACTED]",
    });

    provider.error = new Error(`request failed: token=${secret}`);
    await expect(gateway.call(
      "result__get",
      {},
      { callId: "redact-2", workspace: "/tmp" },
    )).rejects.toThrow("request failed: token=[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(secret);
    await gateway.dispose();
  });

  it("applies one byte budget to text, images and structured details", async () => {
    const provider = new ResultProvider({
      content: [
        { type: "text", text: "a".repeat(2_000) },
        { type: "image", data: "b".repeat(2_000), mimeType: "image/png" },
      ],
      details: { payload: "c".repeat(2_000) },
    });
    const gateway = new ToolGateway({ outputLimitBytes: 128 });
    await gateway.register(provider);

    const result = await gateway.call(
      "result__get",
      {},
      { callId: "large-result", workspace: "/tmp" },
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Tool 输出已截断");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128);
    expect(result.details).toBeUndefined();
    await gateway.dispose();
  });

  it("replaces oversized images and structured details instead of forwarding them", async () => {
    const imageGateway = new ToolGateway({ outputLimitBytes: 128 });
    await imageGateway.register(new ResultProvider({
      content: [{ type: "image", data: "a".repeat(2_000), mimeType: "image/png" }],
    }));
    const imageResult = await imageGateway.call(
      "result__get",
      {},
      { callId: "large-image", workspace: "/tmp" },
    );
    expect(imageResult.content[0]?.type).toBe("text");
    expect(JSON.stringify(imageResult)).not.toContain("a".repeat(100));
    await imageGateway.dispose();

    const detailsGateway = new ToolGateway({ outputLimitBytes: 128 });
    await detailsGateway.register(new ResultProvider({
      content: [],
      details: { payload: "b".repeat(2_000) },
    }));
    const detailsResult = await detailsGateway.call(
      "result__get",
      {},
      { callId: "large-details", workspace: "/tmp" },
    );
    expect(detailsResult.details).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
    });
    expect(JSON.stringify(detailsResult)).not.toContain("b".repeat(100));
    await detailsGateway.dispose();
  });

  it("queues provider calls at the configured concurrency limit", async () => {
    const provider = new ConcurrentProvider();
    const gateway = new ToolGateway({ maxConcurrentCalls: 2 });
    await gateway.register(provider);

    const calls = [1, 2, 3, 4].map((index) => gateway.call(
      "concurrent__wait",
      { index },
      { callId: `concurrent-${index}`, workspace: "/tmp" },
    ));
    await vi.waitFor(() => expect(provider.started).toBe(2));
    expect(provider.maxActive).toBe(2);

    provider.releaseNext();
    await vi.waitFor(() => expect(provider.started).toBe(3));
    provider.releaseNext();
    await vi.waitFor(() => expect(provider.started).toBe(4));
    provider.releaseNext();
    provider.releaseNext();
    await Promise.all(calls);

    expect(provider.maxActive).toBe(2);
    await gateway.dispose();
  });
});

class ResultProvider implements CapabilityProvider {
  readonly id = "result";
  error: Error | undefined;

  constructor(readonly result: ToolResult) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "get",
      description: "Get a result",
      inputSchema: { type: "object" },
    }];
  }

  async callTool(): Promise<ToolResult> {
    if (this.error) throw this.error;
    return this.result;
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose() {}
}

class ShellProvider implements CapabilityProvider {
  readonly id = "workspace";
  readonly call = vi.fn(async (
    _name: string,
    _input: unknown,
    _context: ToolCallContext,
  ): Promise<ToolResult> => ({
    content: [{ type: "text", text: "unexpected" }],
  }));

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "bash",
      description: "shell",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      effect: "unknown",
    }];
  }

  async callTool(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolResult> {
    return this.call(name, input, context);
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose() {}
}

class ConcurrentProvider implements CapabilityProvider {
  readonly id = "concurrent";
  active = 0;
  maxActive = 0;
  started = 0;
  readonly #releases: Array<() => void> = [];

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "wait",
      description: "Wait until released",
      inputSchema: { type: "object" },
    }];
  }

  async callTool(): Promise<ToolResult> {
    this.active += 1;
    this.started += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => this.#releases.push(resolve));
    this.active -= 1;
    return { content: [{ type: "text", text: "done" }] };
  }

  releaseNext(): void {
    this.#releases.shift()?.();
  }

  async healthCheck() {
    return { state: "ready" as const };
  }

  async dispose() {}
}
