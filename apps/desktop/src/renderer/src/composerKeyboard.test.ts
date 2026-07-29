import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composerKeyboard";

describe("shouldSubmitComposer", () => {
  it("submits on Enter outside IME composition", () => {
    expect(shouldSubmitComposer({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    })).toBe(true);
  });

  it("does not submit when Enter confirms an IME composition", () => {
    expect(shouldSubmitComposer({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 13,
    })).toBe(false);
  });

  it("handles browsers that report an IME keyCode after compositionend", () => {
    expect(shouldSubmitComposer({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 229,
    })).toBe(false);
  });

  it("keeps Shift+Enter available for new lines", () => {
    expect(shouldSubmitComposer({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      keyCode: 13,
    })).toBe(false);
  });
});
