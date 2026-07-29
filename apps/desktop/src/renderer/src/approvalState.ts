import type { AgentEvent } from "@deki-ai/shared";

type ApprovalRequest = Extract<AgentEvent, { type: "approval.requested" }>;

export function findPendingApproval(
  events: readonly AgentEvent[],
  now = Date.now(),
): ApprovalRequest | undefined {
  const resolvedRequestIds = new Set(events.flatMap((event) =>
    event.type === "approval.resolved" ? [event.requestId] : []));
  return [...events].reverse().find(
    (event): event is ApprovalRequest =>
      event.type === "approval.requested"
      && !resolvedRequestIds.has(event.requestId)
      && Date.parse(event.expiresAt) > now,
  );
}
