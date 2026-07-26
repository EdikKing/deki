import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityProvider,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@deki-ai/shared";
import { ToolGateway } from "./index";

class FixtureProvider implements CapabilityProvider {
  readonly id = "fixture";
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
});
