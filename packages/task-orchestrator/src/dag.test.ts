import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PlanRevisionRecord } from "@deki-ai/shared";
import {
  canFallbackFailure,
  classifyExecutionFailure,
  classifyExecutionFailureDetail,
  compilePlanExecutionGraph,
  computeRunnableNodes,
  selectModelRoute,
} from "./dag.js";

const budget = {
  maxConcurrentSteps: 2,
  maxDurationMs: 60_000,
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxToolCalls: 20,
};

describe("Plan DAG compiler", () => {
  it("inserts Reviewer and one Integrator for parallel sibling implementers", () => {
    const revision = planRevision([
      implementer("a", []),
      implementer("b", []),
      explorer("verify", ["a", "b"]),
    ]);
    const graph = compilePlanExecutionGraph({
      planId: revision.planId,
      rootTaskId: randomUUID(),
      revision,
      budget,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(graph.nodes.filter((node) => node.syntheticKind === "reviewer")).toHaveLength(2);
    const integrator = graph.nodes.find((node) => node.syntheticKind === "integrator");
    expect(integrator?.dependencies).toHaveLength(2);
    const verify = graph.nodes.find((node) => node.sourceStepId === "verify");
    expect(verify?.dependencies).toEqual([integrator?.id]);
  });

  it("treats a non-parallel node as a scheduling barrier", () => {
    const revision = planRevision([
      { ...explorer("barrier", []), parallelizable: false },
      explorer("parallel", []),
    ]);
    const graph = compilePlanExecutionGraph({
      planId: revision.planId,
      rootTaskId: randomUUID(),
      revision,
      budget,
    });
    expect(computeRunnableNodes(graph, 2).map((node) => node.sourceStepId))
      .toEqual(["barrier"]);
    graph.nodes.find((node) => node.sourceStepId === "parallel")!.status = "running";
    expect(computeRunnableNodes(graph, 2)).toEqual([]);
  });

  it("requires write and validation declarations for Implementers", () => {
    const { writeSet: _writeSet, ...invalid } = implementer("write", []);
    const revision = planRevision([invalid]);
    expect(() => compilePlanExecutionGraph({
      planId: revision.planId,
      rootTaskId: randomUUID(),
      revision,
      budget,
    })).toThrow("writeSet");
  });
});

describe("model routing", () => {
  it("downgrades at soft and critical thresholds while preserving high-risk gates", () => {
    const candidates = ["quality/model", "balanced/model", "economy/model"];
    const baseUsage = {
      workers: 0,
      durationMs: 0,
      inputTokens: 7_100,
      outputTokens: 0,
      toolCalls: 0,
      warningEmitted: false,
      exceeded: false,
    };
    expect(selectModelRoute({
      candidates,
      usage: baseUsage,
      budget,
      risk: "low",
      profile: "explorer",
    })).toMatchObject({ candidateIndex: 1, budgetTier: "soft", outputScale: 0.75 });
    expect(selectModelRoute({
      candidates,
      usage: { ...baseUsage, inputTokens: 9_100 },
      budget,
      risk: "low",
      profile: "explorer",
    })).toMatchObject({ candidateIndex: 2, budgetTier: "critical", outputScale: 0.5 });
    expect(selectModelRoute({
      candidates,
      usage: { ...baseUsage, inputTokens: 9_100 },
      budget,
      risk: "high",
      profile: "reviewer",
    })).toMatchObject({ candidateIndex: 1, lowerThinking: false });
  });

  it("only falls back for provider and context failures", () => {
    expect(classifyExecutionFailure(new Error("429 rate limit"))).toBe("provider_transient");
    expect(classifyExecutionFailure(new Error("permission denied"))).toBe("permission");
    expect(canFallbackFailure("provider_transient")).toBe(true);
    expect(canFallbackFailure("permission")).toBe(false);
  });

  it.each([
    [{ status: 429, code: "rate_limit" }, "provider_transient", true],
    [{ statusCode: 503 }, "provider_transient", true],
    [{ code: "ECONNRESET" }, "provider_transient", true],
    [{ code: "model_not_found" }, "provider_unavailable", true],
    [Object.assign(new Error("denied"), { name: "PermissionDeniedError" }), "permission", false],
    [Object.assign(new Error("failed"), { name: "ValidationError" }), "validation", false],
    [Object.assign(new Error("limit"), { name: "BudgetExceededError" }), "budget", false],
    [Object.assign(new Error("unsafe"), { name: "IntegrationConflictError" }), "integration", false],
  ] as const)("classifies structured failures without unsafe fallback", (error, expected, retriable) => {
    expect(classifyExecutionFailureDetail(error)).toMatchObject({
      failureClass: expected,
      retriable,
    });
  });

  it("includes active reservations in budget-aware routing", () => {
    expect(selectModelRoute({
      candidates: ["quality/model", "balanced/model", "economy/model"],
      usage: {
        workers: 1,
        durationMs: 0,
        inputTokens: 5_000,
        outputTokens: 0,
        toolCalls: 0,
        warningEmitted: false,
        exceeded: false,
      },
      reserved: {
        durationMs: 0,
        inputTokens: 2_100,
        outputTokens: 0,
        toolCalls: 0,
      },
      budget,
      risk: "low",
      profile: "explorer",
    })).toMatchObject({ candidateIndex: 1, budgetTier: "soft" });
  });
});

function planRevision(steps: PlanRevisionRecord["steps"]): PlanRevisionRecord {
  return {
    planId: randomUUID(),
    revision: 1,
    assumptions: [],
    constraints: [],
    steps,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function explorer(
  id: string,
  dependencies: string[],
): PlanRevisionRecord["steps"][number] {
  return {
    id,
    title: id,
    description: id,
    dependencies,
    candidateFiles: [],
    validation: ["result submitted"],
    risk: "low",
    parallelizable: true,
    executionProfile: "explorer",
  };
}

function implementer(
  id: string,
  dependencies: string[],
): PlanRevisionRecord["steps"][number] {
  return {
    ...explorer(id, dependencies),
    executionProfile: "implementer",
    writeSet: [{ path: `src/${id}.ts`, kind: "file", exclusive: true }],
    validationTargets: [{ script: "test" }],
  };
}
