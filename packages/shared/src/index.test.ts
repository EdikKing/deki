import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  bootstrapStateSchema,
  sendPromptInputSchema,
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
  });

  it("rejects empty prompts", () => {
    expect(() => sendPromptInputSchema.parse({ prompt: "   " })).toThrow();
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
});
