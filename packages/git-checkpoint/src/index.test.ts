import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitCheckpointManager } from "./index";

const execFileAsync = promisify(execFile);

describe("GitCheckpointManager", () => {
  it("captures tracked and untracked files without changing the branch or index", async () => {
    const workspace = await createRepository();
    await writeFile(join(workspace, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(workspace, "new.txt"), "new\n", "utf8");
    const beforeHead = (await git(workspace, ["rev-parse", "HEAD"])).trim();
    const beforeIndex = await git(workspace, ["diff", "--cached"]);

    const manager = new GitCheckpointManager(workspace);
    const checkpoint = await manager.create("Before agent change");

    expect(checkpoint.changedFiles).toBe(2);
    expect((await manager.list())[0]?.id).toBe(checkpoint.id);
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(`${beforeHead}\n`);
    expect(await git(workspace, ["diff", "--cached"])).toBe(beforeIndex);
    expect(await git(workspace, ["show", `${checkpoint.commit}:tracked.txt`])).toBe("changed\n");
    expect(await git(workspace, ["show", `${checkpoint.commit}:new.txt`])).toBe("new\n");
  });

  it("restores checkpoint content and creates a safety checkpoint", async () => {
    const workspace = await createRepository();
    const manager = new GitCheckpointManager(workspace);
    await writeFile(join(workspace, "tracked.txt"), "checkpoint\n", "utf8");
    const checkpoint = await manager.create("Restore target");
    await writeFile(join(workspace, "tracked.txt"), "later\n", "utf8");

    const result = await manager.restore(checkpoint.id);

    expect((await readFile(join(workspace, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("checkpoint\n");
    expect(result.safetyCheckpoint.message).toContain("Safety checkpoint");
    expect(await git(workspace, ["show", `${result.safetyCheckpoint.commit}:tracked.txt`]))
      .toBe("later\n");
  });
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "deki-checkpoint-test-"));
  await git(directory, ["init"]);
  await writeFile(join(directory, "tracked.txt"), "initial\n", "utf8");
  await git(directory, ["add", "tracked.txt"]);
  await git(directory, [
    "-c", "user.name=Deki Test",
    "-c", "user.email=test@deki.local",
    "commit", "-m", "initial",
  ]);
  return directory;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}
