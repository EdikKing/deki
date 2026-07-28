import { describe, expect, it } from "vitest";
import type { PlanRevisionRecord } from "@deki-ai/shared";
import { diffPlanRevisions } from "./PlanPanel";

describe("diffPlanRevisions", () => {
  it("reports context, field, ordering, addition, and removal changes", () => {
    const before = revision(1, {
      assumptions: ["old assumption"],
      constraints: ["keep API"],
      steps: [
        step("inspect", "Inspect"),
        step("remove", "Remove"),
        step("implement", "Implement"),
      ],
    });
    const after = revision(2, {
      assumptions: ["new assumption"],
      constraints: ["keep API", "no daemon"],
      steps: [
        { ...step("implement", "Implement safely"), validation: ["unit", "e2e"] },
        step("inspect", "Inspect"),
        step("verify", "Verify"),
      ],
    });

    const diff = diffPlanRevisions(before, after);
    expect(diff.assumptions).toEqual({
      added: ["new assumption"],
      removed: ["old assumption"],
    });
    expect(diff.constraints.added).toEqual(["no daemon"]);
    expect(diff.added.map((item) => item.id)).toEqual(["verify"]);
    expect(diff.removed.map((item) => item.id)).toEqual(["remove"]);
    expect(diff.reordered.map((item) => item.step.id)).toEqual(["implement", "inspect"]);
    expect(diff.changed).toEqual([{
      before: before.steps[2],
      after: after.steps[0],
      fields: ["title", "description", "validation"],
    }]);
  });
});

function revision(
  number: number,
  input: Pick<PlanRevisionRecord, "assumptions" | "constraints" | "steps">,
): PlanRevisionRecord {
  return {
    planId: "00000000-0000-4000-8000-000000000001",
    revision: number,
    ...input,
    createdAt: new Date(number * 1_000).toISOString(),
  };
}

function step(id: string, title: string): PlanRevisionRecord["steps"][number] {
  return {
    id,
    title,
    description: `${title} description`,
    dependencies: [],
    candidateFiles: [],
    validation: ["unit"],
    risk: "low",
    parallelizable: false,
  };
}
