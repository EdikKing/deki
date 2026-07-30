export async function waitForShutdown(
  cleanup: Promise<void>,
  timeoutMs: number,
): Promise<"completed" | "timed-out"> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timed-out">((resolve) => {
    timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  try {
    return await Promise.race([
      cleanup.then(() => "completed" as const),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
