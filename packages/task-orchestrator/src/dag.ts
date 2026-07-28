import { randomUUID } from "node:crypto";
import {
  planExecutionGraphSchema,
  type PlanExecutionBudget,
  type PlanExecutionGraph,
  type PlanExecutionNode,
  type PlanBudgetReservation,
  type PlanRevisionRecord,
  type PlanStep,
  type TaskBudgetUsage,
} from "@deki-ai/shared";

export type RoutedProfile =
  | "coordinator"
  | "explorer"
  | "implementer"
  | "tester"
  | "reviewer"
  | "integrator";

export interface ModelRouteDecision {
  model?: string;
  candidateIndex: number;
  budgetTier: "normal" | "soft" | "critical";
  reason: string;
  outputScale: 1 | 0.75 | 0.5;
  lowerThinking: boolean;
}

export type ExecutionFailureClass =
  | "provider_transient"
  | "provider_unavailable"
  | "context_overflow"
  | "permission"
  | "tool"
  | "validation"
  | "scope"
  | "review"
  | "budget"
  | "integration"
  | "unknown";

export interface ExecutionFailureDetail {
  failureClass: ExecutionFailureClass;
  source: "provider" | "runtime" | "permission" | "tool" | "validation" | "review" | "budget" | "integration" | "unknown";
  code?: string;
  status?: number;
  errorName?: string;
  retriable: boolean;
}

/**
 * Compile an approved immutable Plan revision to an execution graph. Synthetic
 * nodes live only in this graph, so approval never mutates the reviewed Plan.
 */
export function compilePlanExecutionGraph(input: {
  planId: string;
  rootTaskId: string;
  revision: PlanRevisionRecord;
  budget: PlanExecutionBudget;
  now?: string;
}): PlanExecutionGraph {
  assertDagExecutable(input.revision.steps);
  const now = input.now ?? new Date().toISOString();
  const primaryByStep = new Map<string, PlanExecutionNode>();
  const nodes: PlanExecutionNode[] = [];

  for (const step of input.revision.steps) {
    const profile = effectiveStepProfile(step);
    const node = makeNode({
      planId: input.planId,
      revision: input.revision.revision,
      sourceStepId: step.id,
      profile,
      title: step.title,
      parallelizable: step.parallelizable,
      risk: step.risk,
      writeSet: step.writeSet ?? [],
      validationTargets: step.validationTargets ?? [],
      now,
    });
    primaryByStep.set(step.id, node);
    nodes.push(node);
  }

  const reviewByStep = new Map<string, PlanExecutionNode>();
  for (const step of input.revision.steps) {
    if (effectiveStepProfile(step) !== "implementer") continue;
    const primary = primaryByStep.get(step.id)!;
    const reviewer = makeNode({
      planId: input.planId,
      revision: input.revision.revision,
      sourceStepId: step.id,
      syntheticKind: "reviewer",
      profile: "reviewer",
      title: `Review: ${step.title}`,
      dependencies: [primary.id],
      parallelizable: true,
      risk: step.risk,
      writeSet: step.writeSet ?? [],
      validationTargets: step.validationTargets ?? [],
      now,
    });
    reviewByStep.set(step.id, reviewer);
    nodes.push(reviewer);
  }

  // Only sibling implementers with the same dependency frontier form a write
  // batch. This prevents a global Integrator from creating cycles in staged
  // implementation plans.
  const writeGroups = new Map<string, PlanStep[]>();
  for (const step of input.revision.steps) {
    if (effectiveStepProfile(step) !== "implementer" || !step.parallelizable) continue;
    const key = [...step.dependencies].sort().join("\u0000");
    const group = writeGroups.get(key) ?? [];
    group.push(step);
    writeGroups.set(key, group);
  }
  const integrationTailByStep = new Map<string, PlanExecutionNode>();
  for (const group of writeGroups.values()) {
    if (group.length < 2) continue;
    const integrator = makeNode({
      planId: input.planId,
      revision: input.revision.revision,
      syntheticKind: "integrator",
      profile: "integrator",
      title: `Integrate: ${group.map((step) => step.title).join(", ")}`,
      dependencies: group.map((step) => reviewByStep.get(step.id)!.id),
      parallelizable: false,
      risk: group.some((step) => step.risk === "high")
        ? "high"
        : group.some((step) => step.risk === "medium") ? "medium" : "low",
      writeSet: dedupeWriteSet(group.flatMap((step) => step.writeSet ?? [])),
      validationTargets: dedupeValidationTargets(
        group.flatMap((step) => step.validationTargets ?? []),
      ),
      now,
    });
    nodes.push(integrator);
    for (const step of group) integrationTailByStep.set(step.id, integrator);
  }

  const tailForStep = (stepId: string): PlanExecutionNode =>
    integrationTailByStep.get(stepId)
      ?? reviewByStep.get(stepId)
      ?? primaryByStep.get(stepId)!;
  for (const step of input.revision.steps) {
    const primary = primaryByStep.get(step.id)!;
    primary.dependencies = [...new Set(step.dependencies.map((id) => tailForStep(id).id))];
  }
  for (const group of writeGroups.values()) {
    for (let right = 1; right < group.length; right += 1) {
      const current = group[right]!;
      const currentNode = primaryByStep.get(current.id)!;
      for (let left = 0; left < right; left += 1) {
        const previous = group[left]!;
        if (!writeSetsOverlap(previous.writeSet ?? [], current.writeSet ?? [])) continue;
        currentNode.dependencies = [
          ...new Set([...currentNode.dependencies, primaryByStep.get(previous.id)!.id]),
        ];
      }
    }
  }

  return planExecutionGraphSchema.parse({
    id: randomUUID(),
    planId: input.planId,
    revision: input.revision.revision,
    rootTaskId: input.rootTaskId,
    status: "pending",
    budget: input.budget,
    usage: emptyBudgetUsage(),
    reserved: emptyBudgetReservation(),
    nodes,
    createdAt: now,
    updatedAt: now,
  });
}

export function assertDagExecutable(steps: PlanStep[]): void {
  for (const step of steps) {
    const profile = effectiveStepProfile(step);
    if (!step.executionProfile && !isLegacyExecutionProfile(step.assignedProfile)) {
      throw new Error(`DAG 步骤缺少 executionProfile: ${step.id}`);
    }
    if (profile === "implementer") {
      if (!step.writeSet?.length) throw new Error(`Implementer 缺少 writeSet: ${step.id}`);
      if (!step.validationTargets?.length) {
        throw new Error(`Implementer 缺少 validationTargets: ${step.id}`);
      }
    }
  }
}

export function computeRunnableNodes(
  graph: PlanExecutionGraph,
  capacity: number,
): PlanExecutionNode[] {
  if (capacity <= 0 || graph.status === "blocked" || graph.status === "cancelled") return [];
  const active = graph.nodes.filter((node) => node.status === "running");
  if (active.some((node) => !node.parallelizable)) return [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ready = graph.nodes.filter((node) =>
    (node.status === "pending" || node.status === "ready")
    && node.dependencies.every((id) => byId.get(id)?.status === "succeeded")
  );
  if (ready.length === 0) return [];
  const firstBarrier = ready.find((node) => !node.parallelizable);
  if (firstBarrier) return active.length === 0 ? [firstBarrier] : [];
  return ready.slice(0, capacity);
}

export function blockedByFailedDependencies(
  graph: PlanExecutionGraph,
): PlanExecutionNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.nodes.filter((node) =>
    (node.status === "pending" || node.status === "ready")
    && node.dependencies.some((id) => {
      const status = byId.get(id)?.status;
      return status === "failed" || status === "blocked" || status === "cancelled";
    })
  );
}

export function selectModelRoute(input: {
  candidates: string[];
  usage: TaskBudgetUsage;
  budget: PlanExecutionBudget;
  risk: "low" | "medium" | "high";
  profile: RoutedProfile;
  previousCandidateIndex?: number;
  fallback?: boolean;
  reserved?: PlanBudgetReservation;
}): ModelRouteDecision {
  const reserved = input.reserved ?? emptyBudgetReservation();
  const ratio = Math.max(
    (input.usage.durationMs + reserved.durationMs) / input.budget.maxDurationMs,
    (input.usage.inputTokens + reserved.inputTokens) / input.budget.maxInputTokens,
    (input.usage.outputTokens + reserved.outputTokens) / input.budget.maxOutputTokens,
    (input.usage.toolCalls + reserved.toolCalls) / input.budget.maxToolCalls,
  );
  const budgetTier = ratio >= 0.9 ? "critical" : ratio >= 0.7 ? "soft" : "normal";
  let candidateIndex = input.previousCandidateIndex ?? 0;
  if (input.fallback) candidateIndex += 1;
  else if (budgetTier === "soft") candidateIndex = Math.max(candidateIndex, 1);
  else if (budgetTier === "critical") candidateIndex = Math.max(0, input.candidates.length - 1);

  const qualityGate = input.risk === "high"
    && ["implementer", "reviewer", "integrator"].includes(input.profile);
  if (qualityGate && input.candidates.length > 1) {
    candidateIndex = Math.min(candidateIndex, 1);
  }
  candidateIndex = Math.min(candidateIndex, Math.max(0, input.candidates.length - 1));
  return {
    ...(input.candidates[candidateIndex] ? { model: input.candidates[candidateIndex] } : {}),
    candidateIndex,
    budgetTier,
    reason: input.fallback
      ? `failure-fallback:${candidateIndex}`
      : `budget-${budgetTier}:${Math.round(ratio * 100)}%`,
    outputScale: budgetTier === "critical" ? 0.5 : budgetTier === "soft" ? 0.75 : 1,
    lowerThinking: budgetTier === "critical" && !qualityGate,
  };
}

export function classifyExecutionFailure(error: unknown): ExecutionFailureClass {
  return classifyExecutionFailureDetail(error).failureClass;
}

export function classifyExecutionFailureDetail(error: unknown): ExecutionFailureDetail {
  const record = asErrorRecord(error);
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const errorName = error instanceof Error ? error.name : stringField(record, "name");
  const code = stringField(record, "code")
    ?? stringField(asErrorRecord(record?.cause), "code")
    ?? stringField(asErrorRecord(record?.error), "code");
  const status = numberField(record, "status")
    ?? numberField(record, "statusCode")
    ?? numberField(asErrorRecord(record?.cause), "status")
    ?? numberField(asErrorRecord(record?.response), "status");
  const normalizedName = errorName?.toLowerCase() ?? "";
  const normalizedCode = code?.toLowerCase() ?? "";
  const detail = (
    failureClass: ExecutionFailureClass,
    source: ExecutionFailureDetail["source"],
  ): ExecutionFailureDetail => ({
    failureClass,
    source,
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    ...(errorName ? { errorName } : {}),
    retriable: canFallbackFailure(failureClass),
  });
  if (/permission|approval|denied|forbidden/.test(normalizedName)
    || ["eacces", "eperm"].includes(normalizedCode)) return detail("permission", "permission");
  if (/scope|workspace.?drift/.test(normalizedName)) return detail("scope", "runtime");
  if (/validation|test/.test(normalizedName)) return detail("validation", "validation");
  if (/tool/.test(normalizedName)) return detail("tool", "tool");
  if (/review/.test(normalizedName)) return detail("review", "review");
  if (/budget/.test(normalizedName)) return detail("budget", "budget");
  if (/integration|conflict/.test(normalizedName)) return detail("integration", "integration");
  if (status === 429 || status === 408 || (status !== undefined && status >= 500)) {
    return detail("provider_transient", "provider");
  }
  if (status === 401 || status === 403) return detail("permission", "permission");
  if (["etimedout", "econnreset", "econnrefused", "enotfound", "eai_again"].includes(normalizedCode)) {
    return detail("provider_transient", "provider");
  }
  if (/model_not_found|model_unavailable|unsupported_model|capability/.test(normalizedCode)) {
    return detail("provider_unavailable", "provider");
  }
  if (/context|token limit|too many tokens|maximum context/.test(message)) {
    return detail("context_overflow", "provider");
  }
  if (/429|rate.?limit|timeout|timed out|econn|socket|502|503|504|5\d\d/.test(message)) {
    return detail("provider_transient", "provider");
  }
  if (
    /model.*(?:not found|unavailable|unsupported)|provider.*unavailable|capability|does not support (?:tools|images|reasoning)|401|403.*provider/
      .test(message)
  ) {
    return detail("provider_unavailable", "provider");
  }
  if (/permission|approval|denied|forbidden/.test(message)) return detail("permission", "permission");
  if (/scope|out.of.scope|越界/.test(message)) return detail("scope", "runtime");
  if (/review|changes_requested|审查/.test(message)) return detail("review", "review");
  if (/budget|预算/.test(message)) return detail("budget", "budget");
  if (/integration|conflict|集成|冲突/.test(message)) return detail("integration", "integration");
  if (/test|lint|typecheck|validation|验证/.test(message)) return detail("validation", "validation");
  if (/tool|工具/.test(message)) return detail("tool", "tool");
  return detail("unknown", "unknown");
}

export function canFallbackFailure(failure: ExecutionFailureClass): boolean {
  return failure === "provider_transient"
    || failure === "provider_unavailable"
    || failure === "context_overflow";
}

export function emptyBudgetUsage(): TaskBudgetUsage {
  return {
    workers: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    warningEmitted: false,
    exceeded: false,
  };
}

export function emptyBudgetReservation(): PlanBudgetReservation {
  return {
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
  };
}

function asErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function effectiveStepProfile(step: PlanStep): "explorer" | "implementer" | "tester" {
  if (step.executionProfile) return step.executionProfile;
  if (isLegacyExecutionProfile(step.assignedProfile)) return step.assignedProfile;
  return "explorer";
}

function isLegacyExecutionProfile(
  value: string | undefined,
): value is "explorer" | "implementer" | "tester" {
  return value === "explorer" || value === "implementer" || value === "tester";
}

function makeNode(input: {
  planId: string;
  revision: number;
  sourceStepId?: string;
  syntheticKind?: "reviewer" | "integrator";
  profile: PlanExecutionNode["profile"];
  title: string;
  dependencies?: string[];
  parallelizable: boolean;
  risk: PlanExecutionNode["risk"];
  writeSet: PlanExecutionNode["writeSet"];
  validationTargets: PlanExecutionNode["validationTargets"];
  now: string;
}): PlanExecutionNode {
  return {
    id: randomUUID(),
    planId: input.planId,
    revision: input.revision,
    ...(input.sourceStepId ? { sourceStepId: input.sourceStepId } : {}),
    ...(input.syntheticKind ? { syntheticKind: input.syntheticKind } : {}),
    profile: input.profile,
    title: input.title,
    dependencies: input.dependencies ?? [],
    status: "pending",
    parallelizable: input.parallelizable,
    risk: input.risk,
    writeSet: input.writeSet,
    validationTargets: input.validationTargets,
    attempt: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function dedupeWriteSet(entries: PlanExecutionNode["writeSet"]): PlanExecutionNode["writeSet"] {
  return [...new Map(entries.map((entry) => [
    `${entry.kind}:${entry.path}`,
    entry,
  ])).values()];
}

function dedupeValidationTargets(
  targets: PlanExecutionNode["validationTargets"],
): PlanExecutionNode["validationTargets"] {
  return [...new Map(targets.map((target) => [
    `${target.cwd ?? ""}:${target.script}`,
    target,
  ])).values()];
}

function writeSetsOverlap(
  left: PlanExecutionNode["writeSet"],
  right: PlanExecutionNode["writeSet"],
): boolean {
  return left.some((a) => right.some((b) => {
    const aPath = a.path.replaceAll("\\", "/").replace(/\/+$/u, "");
    const bPath = b.path.replaceAll("\\", "/").replace(/\/+$/u, "");
    return aPath === bPath
      || (a.kind === "directory" && bPath.startsWith(`${aPath}/`))
      || (b.kind === "directory" && aPath.startsWith(`${bPath}/`));
  }));
}
