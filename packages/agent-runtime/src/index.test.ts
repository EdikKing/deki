import type {
  AgentSessionEvent,
  AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionEventSubscription,
  isSessionVisibleInSidebar,
  renderBuiltInGitCommitInstructions,
  toolDefinitionSignature,
  translatePiAgentEvent,
} from "./index.js";

describe("built-in Git commit instructions", () => {
  it("requires Conventional Commits in the configured application language", () => {
    const chinese = renderBuiltInGitCommitInstructions("zh-CN");
    const english = renderBuiltInGitCommitInstructions("en-US");

    expect(chinese).toContain("`type(scope): description`");
    expect(chinese).toContain("简体中文（zh-CN）");
    expect(chinese).toContain("BREAKING CHANGE:");
    expect(english).toContain("English (en-US)");
  });

  it("uses the operating-system language only when configured to follow it", () => {
    expect(renderBuiltInGitCommitInstructions("system", "zh-CN"))
      .toContain("简体中文（zh-CN）");
    expect(renderBuiltInGitCommitInstructions("system", "en-US"))
      .toContain("English (en-US)");
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

describe("session sidebar visibility", () => {
  it("hides task-only plan execution sessions", () => {
    expect(isSessionVisibleInSidebar(fakeSessionManager([{
      type: "custom",
      customType: "deki.session-visibility",
      data: { version: 1, visibility: "task-only", reason: "plan-execution" },
    }]))).toBe(false);
  });

  it("lets an explicit user fork override inherited task-only metadata", () => {
    expect(isSessionVisibleInSidebar(fakeSessionManager([{
      type: "custom",
      customType: "deki.session-visibility",
      data: { version: 1, visibility: "task-only", reason: "plan-execution" },
    }, {
      type: "custom",
      customType: "deki.session-visibility",
      data: { version: 1, visibility: "sidebar", reason: "user-fork" },
    }]))).toBe(true);
  });

  it("hides plan execution sessions created before visibility metadata existed", () => {
    expect(isSessionVisibleInSidebar(fakeSessionManager([{
      type: "message",
      message: {
        role: "user",
        content: [{
          type: "text",
          text: "执行下面已由用户批准的计划。严格按依赖顺序串行执行，一次只执行一个步骤。\n\nplanId=fixture",
        }],
      },
    }]))).toBe(false);
  });

  it("keeps ordinary user sessions visible", () => {
    expect(isSessionVisibleInSidebar(fakeSessionManager([{
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "检查当前项目的自动更新逻辑" }],
      },
    }]))).toBe(true);
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

function fakeSessionManager(
  entries: unknown[],
): Parameters<typeof isSessionVisibleInSidebar>[0] {
  return {
    getBranch: () => entries,
  } as unknown as Parameters<typeof isSessionVisibleInSidebar>[0];
}
