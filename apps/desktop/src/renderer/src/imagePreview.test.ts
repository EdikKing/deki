import { describe, expect, it } from "vitest";
import { clampIndex, findStartIndex, nextIndex } from "./imagePreview";

describe("clampIndex", () => {
  it("returns 0 for empty arrays", () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
    expect(clampIndex(-2, 0)).toBe(0);
  });

  it("clamps negative and overflowing values to the valid range", () => {
    expect(clampIndex(-3, 4)).toBe(0);
    expect(clampIndex(99, 4)).toBe(3);
  });

  it("returns the original index when within range", () => {
    expect(clampIndex(2, 5)).toBe(2);
  });

  it("normalises non-integer and non-finite values", () => {
    expect(clampIndex(1.7, 3)).toBe(1);
    expect(clampIndex(Number.NaN, 3)).toBe(0);
    expect(clampIndex(Number.POSITIVE_INFINITY, 3)).toBe(2);
  });
});

describe("nextIndex", () => {
  it("returns the same index when there is at most one image", () => {
    expect(nextIndex(0, 0, "next")).toBe(0);
    expect(nextIndex(0, 1, "prev")).toBe(0);
    expect(nextIndex(0, 1, "next")).toBe(0);
  });

  it("advances and wraps with direction next", () => {
    expect(nextIndex(0, 3, "next")).toBe(1);
    expect(nextIndex(2, 3, "next")).toBe(0);
  });

  it("regresses and wraps with direction prev", () => {
    expect(nextIndex(2, 3, "prev")).toBe(1);
    expect(nextIndex(0, 3, "prev")).toBe(2);
  });

  it("ignores out-of-range inputs", () => {
    expect(nextIndex(-3, 4, "next")).toBe(1);
    expect(nextIndex(99, 4, "prev")).toBe(2);
  });
});

describe("findStartIndex", () => {
  it("returns the matching index when predicate succeeds", () => {
    expect(findStartIndex([{ id: "a" }, { id: "b" }, { id: "c" }], (item) => item?.id === "b"))
      .toBe(1);
  });

  it("falls back to a clamped value when nothing matches", () => {
    expect(findStartIndex([{ id: "a" }], () => false, 0)).toBe(0);
    expect(findStartIndex([{ id: "a" }, { id: "b" }], () => false, 9)).toBe(1);
  });

  it("returns 0 for empty arrays regardless of fallback", () => {
    expect(findStartIndex([], () => false, 0)).toBe(0);
  });
});
