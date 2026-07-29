import type {
  AgentSessionEvent,
  AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionEventSubscription,
  renderBuiltInGitCommitInstructions,
  toolDefinitionSignature,
  translatePiAgentEvent,
} from "./index.js";

describe("built-in Git commit instructions", () => {
  it("requires Conventional Commits in the system language", () => {
    const chinese = renderBuiltInGitCommitInstructions("zh-CN");
    const english = renderBuiltInGitCommitInstructions("en-US");

    expect(chinese).toContain("`type(scope): description`");
    expect(chinese).toContain("简体中文（zh-CN）");
    expect(chinese).toContain("BREAKING CHANGE:");
    expect(english).toContain("English (en-US)");
  });
});

describe("Pi runtime event bridge", () => {
  it("translates streaming text and tool lifecycle events", () => {
    const delta = {
      type: "message_update",
      message: {
        provider: "deepseek",
        model: "deepseek-reasoner",
      },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "你好",
        partial: {
          provider: "deepseek",
          model: "deepseek-reasoner",
        },
      },
    } as unknown as AgentSessionEvent;
    const thinking = {
      type: "message_update",
      message: {
        provider: "deepseek",
        model: "deepseek-reasoner",
      },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "先理解问题",
        partial: {
          provider: "deepseek",
          model: "deepseek-reasoner",
        },
      },
    } as unknown as AgentSessionEvent;
    const tool = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "deki__project_info",
      args: {},
    } as unknown as AgentSessionEvent;

    expect(translatePiAgentEvent(delta)).toEqual({
      type: "message.delta",
      delta: "你好",
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
    });
    expect(translatePiAgentEvent(thinking)).toEqual({
      type: "message.reasoning.delta",
      delta: "先理解问题",
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
    });
    expect(translatePiAgentEvent(tool)).toEqual({
      type: "tool.started",
      callId: "call-1",
      toolName: "deki__project_info",
      input: {},
    });
  });

  it("unsubscribes the previous session when rebinding", () => {
    const bridge = new AgentSessionEventSubscription();
    const listener = vi.fn();
    const first = createFakeSession();
    const second = createFakeSession();

    bridge.bind(first.session, listener);
    bridge.bind(second.session, listener);
    first.emit({ type: "agent_end" } as AgentSessionEvent);
    second.emit({ type: "agent_end" } as AgentSessionEvent);

    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    bridge.dispose();
    expect(second.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("MCP tool definition refresh", () => {
  const echoTool = {
    modelName: "fixture__echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  };

  it("is stable when tool order changes", () => {
    const infoTool = {
      modelName: "deki__project_info",
      description: "Project info",
      inputSchema: { type: "object", properties: {} },
    };

    expect(toolDefinitionSignature([echoTool, infoTool]))
      .toBe(toolDefinitionSignature([infoTool, echoTool]));
  });

  it("changes when a tool is added or its schema changes", () => {
    const empty = toolDefinitionSignature([]);
    const withEcho = toolDefinitionSignature([echoTool]);
    const changedSchema = toolDefinitionSignature([{
      ...echoTool,
      inputSchema: {
        ...echoTool.inputSchema,
        properties: { value: { type: "number" } },
      },
    }]);

    expect(withEcho).not.toBe(empty);
    expect(changedSchema).not.toBe(withEcho);
  });
});

function createFakeSession() {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const session = {
    subscribe(next: (event: AgentSessionEvent) => void) {
      listener = next;
      return unsubscribe;
    },
  } as Pick<AgentSessionRuntime["session"], "subscribe">;

  return {
    session,
    unsubscribe,
    emit(event: AgentSessionEvent) {
      listener?.(event);
    },
  };
}
