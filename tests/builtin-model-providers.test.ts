import { describe, expect, it } from "vitest";
import { modelProviderInputSchema } from "../packages/shared/src/index";
import {
  builtinModelProviders,
  builtinProviderInput,
  isBuiltinModelProvider,
} from "../apps/desktop/src/renderer/src/builtinModelProviders";

describe("built-in model providers", () => {
  it("provides unique, key-only presets accepted by the IPC schema", () => {
    const ids = builtinModelProviders.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "moonshotai-cn",
      "minimax-cn",
      "zai",
      "openrouter",
    ]);

    for (const provider of builtinModelProviders) {
      expect(isBuiltinModelProvider(provider.id)).toBe(true);
      expect(provider.config.baseUrl).toMatch(/^https:\/\//);
      expect(provider.config.models.length).toBeGreaterThan(0);
      expect(() => modelProviderInputSchema.parse(
        builtinProviderInput(provider, { action: "set", value: "test-key" }),
      )).not.toThrow();
    }
  });

  it("does not classify the custom model slot as built in", () => {
    expect(isBuiltinModelProvider("custom")).toBe(false);
  });
});
