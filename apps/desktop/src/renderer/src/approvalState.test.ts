import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@deki-ai/shared";
import { findPendingApproval } from "./approvalState";

function request(
  requestId: string,
  expiresAt = "2026-07-29T02:00:00.000Z",
): AgentEvent {
  return {
    type: "approval.requested",
    requestId,
    category: "shell.unknown",
    title: "Shell",
    description: "approval",
    details: {},
    expiresAt,
    eventId: `${requestId}-event`,
    timestamp: "2026-07-29T01:00:00.000Z",
    sessionId: "session-a",
  };
}

describe("findPendingApproval", () => {
  it("returns the latest unresolved active request", () => {
    expect(findPendingApproval(
      [request("older"), request("latest")],
      Date.parse("2026-07-29T01:30:00.000Z"),
    )?.requestId).toBe("latest");
  });

  it("ignores resolved requests", () => {
    const events: AgentEvent[] = [
      request("resolved"),
      {
        type: "approval.resolved",
        requestId: "resolved",
        decision: "allow_once",
        eventId: "resolved-event",
        timestamp: "2026-07-29T01:01:00.000Z",
        sessionId: "session-a",
      },
    ];
    expect(findPendingApproval(
      events,
      Date.parse("2026-07-29T01:30:00.000Z"),
    )).toBeUndefined();
  });

  it("ignores expired requests even when a historical resolution is missing", () => {
    expect(findPendingApproval(
      [request("expired", "2026-07-29T01:10:00.000Z")],
      Date.parse("2026-07-29T01:30:00.000Z"),
    )).toBeUndefined();
  });
});
