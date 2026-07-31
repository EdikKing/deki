import type {
  AgentSessionEvent,
  AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionEventSubscription,
  isSessionVisibleInSidebar,
  parseLayeredMemoryCapture,
  promptPresentationHash,
  readConversationHistory,
  renderBuiltInGitCommitInstructions,
  shouldAutoAcceptMemory,
  toolDefinitionSignature,
  translatePiAgentEvent,
} from "./index.js";

describe("layered memory capture", () => {
  it("parses bounded structured memories and handoff state", () => {
    const parsed = parseLayeredMemoryCapture(JSON.stringify({
      memories: [{
        key: "package-manager",
        content: "项目使用 pnpm",
        type: "decision",
        confidence: 0.92,
        evidenceRefs: ["user:run-1"],
      }],
      handoff: {
        goal: "实现跨会话记忆",
        completed: ["数据库迁移"],
        currentState: "正在接入运行时",
        blockers: [],
        nextSteps: ["补测试"],
      },
    }));
    expect(parsed.memories[0]).toMatchObject({
      key: "package-manager",
      confidence: 0.92,
      evidenceRefs: ["user:run-1"],
    });
    expect(parsed.handoff?.nextSteps).toEqual(["补测试"]);
  });

  it("auto-accepts only project memories with validated evidence above threshold", () => {
    expect(shouldAutoAcceptMemory({
      project: true,
      enabled: true,
      confidence: 0.9,
      threshold: 0.85,
      citedEvidenceCount: 1,
    })).toBe(true);
    expect(shouldAutoAcceptMemory({
      project: true,
      enabled: true,
      confidence: 0.99,
      threshold: 0.85,
      citedEvidenceCount: 0,
    })).toBe(false);
    expect(shouldAutoAcceptMemory({
      project: false,
      enabled: true,
      confidence: 0.99,
      threshold: 0.85,
      citedEvidenceCount: 1,
    })).toBe(false);
  });
});

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

describe("prompt presentation history", () => {
  it("shows the user-authored Plan prompt while preserving attachments", () => {
    const displayPrompt = "检查目标：图片预览\n\n保留特殊字符 <>&";
    const modelPrompt = [
      "你处于 Plan 模式。只允许读取和分析。",
      `目标：${displayPrompt}`,
      "",
      "<attached_files>",
      '<deki_attachment_metadata>[{"name":"preview.png","mimeType":"image/png","size":3}]</deki_attachment_metadata>',
      "- preview.png (image/png, image included)",
      "</attached_files>",
    ].join("\n");
    const history = readConversationHistory(fakeSessionManager([{
      type: "custom",
      customType: "deki.prompt-presentation",
      data: {
        version: 1,
        runId: "run-plan",
        promptHash: promptPresentationHash(modelPrompt),
        displayPrompt,
      },
    }, {
      type: "message",
      id: "message-plan",
      message: {
        role: "user",
        timestamp: Date.now(),
        content: [{
          type: "text",
          text: modelPrompt,
        }, {
          type: "image",
          data: "YWJj",
          mimeType: "image/png",
        }],
      },
    }]), "session-plan");

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      role: "user",
      content: displayPrompt,
      attachments: [{
        name: "preview.png",
        mimeType: "image/png",
        size: 3,
        dataUrl: "data:image/png;base64,YWJj",
      }],
    });
  });

  it("ignores orphaned or mismatched presentation metadata", () => {
    const history = readConversationHistory(fakeSessionManager([{
      type: "custom",
      customType: "deki.prompt-presentation",
      data: {
        version: 1,
        runId: "failed-run",
        promptHash: promptPresentationHash("重复请求"),
        displayPrompt: "不应泄漏到后续消息",
      },
    }, {
      type: "message",
      id: "different-message",
      message: {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: "另一条请求" }],
      },
    }, {
      type: "message",
      id: "later-message",
      message: {
        role: "user",
        timestamp: Date.now() + 1,
        content: [{ type: "text", text: "重复请求" }],
      },
    }]), "session-orphan");

    expect(history.map((message) => message.content))
      .toEqual(["另一条请求", "重复请求"]);
  });

  it("uses the latest matching metadata for retried identical prompts", () => {
    const prompt = "内部 Plan Prompt";
    const presentation = (runId: string, displayPrompt: string) => ({
      type: "custom",
      customType: "deki.prompt-presentation",
      data: {
        version: 1,
        runId,
        promptHash: promptPresentationHash(prompt),
        displayPrompt,
      },
    });
    const history = readConversationHistory(fakeSessionManager([
      presentation("failed-run", "旧输入"),
      presentation("retry-run", "重试后的输入"),
      {
        type: "message",
        id: "retry-message",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: prompt }],
        },
      },
    ]), "session-retry");

    expect(history.map((message) => message.content)).toEqual(["重试后的输入"]);
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
