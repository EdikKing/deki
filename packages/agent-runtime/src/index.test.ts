import type {
  AgentSessionEvent,
  AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionEventSubscription,
  translatePiAgentEvent,
} from "./index.js";

describe("Pi runtime event bridge", () => {
  it("translates streaming text and tool lifecycle events", () => {
    const delta = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "你好",
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
