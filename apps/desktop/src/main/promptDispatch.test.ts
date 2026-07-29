import { describe, expect, it } from "vitest";
import { decidePromptDispatch } from "./promptDispatch.js";

describe("decidePromptDispatch", () => {
  it("keeps a completed foreground continuation in the current session", () => {
    expect(decidePromptDispatch({
      mode: "foreground",
      sessionStreaming: false,
      hasPendingSessionTask: false,
    })).toEqual({ ok: true, preferFork: false });
  });

  it("does not silently fork while the previous foreground task is finalizing", () => {
    expect(decidePromptDispatch({
      mode: "foreground",
      sessionStreaming: false,
      hasPendingSessionTask: true,
    })).toEqual({
      ok: false,
      error: "当前会话仍在收尾，请稍后重试",
    });
  });

  it("continues to fork explicitly requested background work", () => {
    expect(decidePromptDispatch({
      mode: "background",
      sessionStreaming: true,
      hasPendingSessionTask: true,
    })).toEqual({ ok: true, preferFork: true });
  });
});
