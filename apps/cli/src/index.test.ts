import { describe, expect, it } from "vitest";
import { parseArguments } from "./index";

describe("Deki CLI argument parser", () => {
  it("parses positional, repeated and inline options", () => {
    const parsed = parseArguments([
      "mcp", "add", "fixture",
      "--command", "node",
      "--arg=server.mjs",
      "--arg", "--stdio",
      "--disabled",
    ]);
    expect(parsed.positionals).toEqual(["mcp", "add", "fixture"]);
    expect(parsed.options.get("command")).toBe("node");
    expect(parsed.options.get("arg")).toEqual(["server.mjs", "--stdio"]);
    expect(parsed.options.get("disabled")).toBe(true);
  });

  it("rejects a missing option value", () => {
    expect(() => parseArguments(["doctor", "--workspace"])).toThrow("--workspace");
  });
});
