import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  bootstrapStateSchema,
  memoryListInputSchema,
  optimizePromptInputSchema,
  optimizePromptResultSchema,
  rememberInputSchema,
  sendPromptInputSchema,
  taskEventSchema,
  taskListInputSchema,
  taskRecordSchema,
  taskRequestRecordSchema,
  taskSummarySchema,
  taskInputResponseSchema,
  taskSubmissionResultSchema,
  updateSessionConfigurationInputSchema,
  workerRequestSchema,
} from "./index";

describe("shared IPC schemas", () => {
  it("accepts a normalized streaming event", () => {
    const event = agentEventSchema.parse({
      type: "message.delta",
      eventId: "event-1",
      timestamp: "2026-07-26T00:00:00.000Z",
      sessionId: "session-1",
      delta: "hello",
    });
    expect(event.type).toBe("message.delta");
    const reasoning = agentEventSchema.parse({
      type: "message.reasoning.delta",
      eventId: "event-2",
      timestamp: "2026-07-26T00:00:00.000Z",
      sessionId: "session-1",
      delta: "Inspect the project structure first.",
      providerId: "deepseek",
      modelId: "deepseek-reasoner",
    });
    expect(reasoning.type).toBe("message.reasoning.delta");
  });

  it("rejects empty prompts", () => {
    expect(() => sendPromptInputSchema.parse({ prompt: "   " })).toThrow();
    expect(sendPromptInputSchema.parse({ prompt: "分析项目" })).toMatchObject({
      mode: "foreground",
    });
    expect(sendPromptInputSchema.parse({
      prompt: "分析项目",
      mode: "background",
    }).mode).toBe("background");
  });

  it("validates prompt optimization requests and results", () => {
    expect(optimizePromptInputSchema.parse({ prompt: "  做一个登录页  " }))
      .toEqual({ prompt: "做一个登录页" });
    expect(() => optimizePromptInputSchema.parse({ prompt: "   " })).toThrow();
    expect(optimizePromptResultSchema.parse({
      ok: true,
      prompt: "目标：实现登录页",
    })).toEqual({
      ok: true,
      prompt: "目标：实现登录页",
    });
  });

  it("validates task records, events, and submission results", () => {
    const task = taskRecordSchema.parse({
      id: "9d0cb2ad-fbeb-4307-b24b-dd4d6ea16eaf",
      workspaceId: "workspace-a",
      rootTaskId: "9d0cb2ad-fbeb-4307-b24b-dd4d6ea16eaf",
      kind: "interactive",
      title: "修复测试",
      goal: "修复测试",
      status: "queued",
      priority: 0,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    });
    expect(taskSubmissionResultSchema.parse({ ok: true, task }).task?.id)
      .toBe(task.id);
    expect(taskEventSchema.parse({
      eventId: "25874e8e-00b8-4e39-9843-6ebda59f6ca7",
      taskId: task.id,
      timestamp: "2026-07-28T00:00:00.000Z",
      sequence: 1,
      type: "task.created",
      payload: {},
    }).sequence).toBe(1);
    expect(taskListInputSchema.parse({})).toEqual({ limit: 100 });
    expect(taskSummarySchema.parse({
      task,
      pendingRequestCount: 0,
    }).task.id).toBe(task.id);
    expect(taskRequestRecordSchema.parse({
      id: "request-1",
      taskId: task.id,
      runId: "25874e8e-00b8-4e39-9843-6ebda59f6ca7",
      kind: "user_input",
      status: "pending",
      title: "选择方案",
      payload: { options: ["A", "B"] },
      createdAt: "2026-07-28T00:00:00.000Z",
    }).status).toBe("pending");
    expect(taskInputResponseSchema.parse({
      taskId: task.id,
      requestId: "request-1",
      value: "A",
    }).value).toBe("A");
    expect(() => taskListInputSchema.parse({ limit: 501 })).toThrow();
  });

  it("requires an explicit write scope and validation targets for Implementers", () => {
    expect(workerRequestSchema.parse({
      profile: "implementer",
      objective: "修改模块",
      successCriteria: ["测试通过"],
      writeSet: [{ path: "src/module.ts", kind: "file" }],
      validationTargets: [{ script: "test" }],
    })).toMatchObject({ profile: "implementer" });
    expect(() => workerRequestSchema.parse({
      profile: "implementer",
      objective: "修改模块",
      successCriteria: ["测试通过"],
    })).toThrow();
    expect(() => workerRequestSchema.parse({
      profile: "integrator",
      objective: "直接派发 Integrator",
      successCriteria: ["完成"],
    })).toThrow();
  });

  it("validates task-scoped memory commands and indexed queries", () => {
    expect(rememberInputSchema.parse({
      content: "保留当前迁移进度",
      scope: "task",
    })).toEqual({
      content: "保留当前迁移进度",
      scope: "task",
    });
    expect(memoryListInputSchema.parse({
      scope: "task",
      query: "迁移进度",
    })).toEqual({
      scope: "task",
      query: "迁移进度",
    });
  });

  it("keeps bootstrap state explicit when runtime is unavailable", () => {
    const state = bootstrapStateSchema.parse({
      workspace: "/tmp/project",
      trusted: true,
      ready: false,
      streaming: false,
      models: [],
      memories: [],
      recalledMemories: [],
      mcpServers: [],
      skills: [],
      diagnostics: ["missing auth"],
    });
    expect(state.ready).toBe(false);
    expect(state.diagnostics).toEqual(["missing auth"]);
  });

  it("validates current-session configuration updates", () => {
    expect(updateSessionConfigurationInputSchema.parse({
      thinkingLevel: "high",
    })).toEqual({ thinkingLevel: "high" });
    const permissionUpdate = updateSessionConfigurationInputSchema.parse({
      permissionPolicies: {
        "workspace.read": "allow",
        "workspace.write": "allow",
        "workspace.delete": "ask",
        "shell.safe": "allow",
        "shell.unknown": "ask",
        "dependencies.install": "ask",
        "git.commit": "ask",
        "git.push": "ask",
        outsideWorkspace: "ask",
        sensitiveFiles: "ask",
        privileged: "ask",
        network: "ask",
        "mcp.read": "allow",
        "mcp.write": "ask",
      },
    });
    expect(permissionUpdate.permissionPolicies?.["workspace.delete"]).toBe("ask");
    expect(() => updateSessionConfigurationInputSchema.parse({})).toThrow();
  });
});
