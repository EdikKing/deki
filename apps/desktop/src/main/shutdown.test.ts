import { describe, expect, it, vi } from "vitest";
import { waitForShutdown } from "./shutdown.js";

describe("waitForShutdown", () => {
  it("reports a completed graceful shutdown", async () => {
    await expect(waitForShutdown(Promise.resolve(), 1_000))
      .resolves.toBe("completed");
  });

  it("stops waiting when a cleanup operation hangs", async () => {
    vi.useFakeTimers();
    try {
      const result = waitForShutdown(new Promise<void>(() => undefined), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });
});
