import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  WorktreeRunner,
  scheduleWriteWaves,
  validateWriteSet,
  WorkspaceDriftError,
} from "./index.js";

const exec = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorktreeRunner", () => {
  it("captures a dirty baseline without changing HEAD or the index", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.repo, "tracked.txt"), "dirty\n");
    await writeFile(join(fixture.repo, "staged.txt"), "staged\n");
    await git(fixture.repo, "add", "staged.txt");
    await writeFile(join(fixture.repo, "untracked.txt"), "untracked\n");
    const before = await snapshot(fixture.repo);
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("test baseline");
    const after = await snapshot(fixture.repo);
    expect(after).toEqual(before);
    expect((await git(fixture.repo, "show", `${baseline.commit}:tracked.txt`)).stdout)
      .toBe("dirty\n");
    expect((await git(fixture.repo, "show", `${baseline.commit}:untracked.txt`)).stdout)
      .toBe("untracked\n");
  });

  it("finalizes scoped changes and preserves a commit after worktree cleanup", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("test baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "worker-task",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(resource.cwd, "tracked.txt"), "implemented\n");
    const result = await runner.finalizeImplementer({
      resource,
      writeSet: [{ path: "tracked.txt", kind: "file", exclusive: false }],
      validationTargets: [{ script: "test" }],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changedFiles).toEqual(["tracked.txt"]);
    expect(result.validations[0]?.exitCode).toBe(0);
    const ref = await runner.createArtifactRef("commit-artifact", result.commit!);
    await runner.cleanup(resource);
    expect((await git(fixture.repo, "rev-parse", ref)).stdout.trim()).toBe(result.commit);
    expect(await readFile(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
  });

  it("rejects out-of-scope changes", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("test baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "scope-worker",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(resource.cwd, "tracked.txt"), "outside\n");
    const result = await runner.finalizeImplementer({
      resource,
      writeSet: [{ path: "allowed.txt", kind: "file", exclusive: false }],
      validationTargets: [{ script: "test" }],
    });
    expect(result.commit).toBeUndefined();
    expect(result.outOfScopeFiles).toEqual(["tracked.txt"]);
    await runner.cleanup(resource);
  });

  it("detects live workspace drift before applying an integration patch", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("test baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "integration-task",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(resource.cwd, "tracked.txt"), "integrated\n");
    await git(resource.path, "add", "-A");
    await git(resource.path, "-c", "user.name=Deki", "-c", "user.email=test@deki.local",
      "commit", "-m", "integration");
    const integrated = await runner.integrationPatch(resource, baseline.commit);
    await writeFile(join(fixture.repo, "tracked.txt"), "user edit\n");
    await expect(runner.applyPatch({
      baselineCommit: baseline.commit,
      integrationCommit: integrated.commit,
      patch: integrated.patch,
    })).rejects.toBeInstanceOf(WorkspaceDriftError);
    expect(await readFile(join(fixture.repo, "tracked.txt"), "utf8")).toBe("user edit\n");
    await runner.cleanup(resource);
  });

  it("applies an approved patch without changing HEAD or the staged snapshot", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.repo, "staged.txt"), "user staged\n");
    await git(fixture.repo, "add", "staged.txt");
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("dirty baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "approved-integration",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(resource.cwd, "tracked.txt"), "approved\n");
    await git(resource.path, "add", "-A");
    await git(resource.path, "-c", "user.name=Deki", "-c", "user.email=test@deki.local",
      "commit", "-m", "integration");
    const integrated = await runner.integrationPatch(resource, baseline.commit);
    const beforeHead = (await git(fixture.repo, "rev-parse", "HEAD")).stdout;
    const beforeIndex = (await git(fixture.repo, "diff", "--cached")).stdout;
    await runner.applyPatch({
      baselineCommit: baseline.commit,
      integrationCommit: integrated.commit,
      patch: integrated.patch,
    });
    expect(await readFile(join(fixture.repo, "tracked.txt"), "utf8")).toBe("approved\n");
    expect((await git(fixture.repo, "rev-parse", "HEAD")).stdout).toBe(beforeHead);
    expect((await git(fixture.repo, "diff", "--cached")).stdout).toBe(beforeIndex);
    await runner.cleanup(resource);
  });
});

describe("write scheduling", () => {
  it("serializes overlaps and keeps disjoint requests in the same wave", () => {
    const requests = [
      { id: "a", writeSet: validateWriteSet([{ path: "a.ts", kind: "file", exclusive: false }]) },
      { id: "b", writeSet: validateWriteSet([{ path: "b.ts", kind: "file", exclusive: false }]) },
      { id: "c", writeSet: validateWriteSet([{ path: "a.ts", kind: "file", exclusive: false }]) },
    ];
    expect(scheduleWriteWaves(requests).map((wave) => wave.map((item) => item.id)))
      .toEqual([["a", "b"], ["c"]]);
  });
});

describe("ArtifactStore", () => {
  it("writes and reads bounded chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-artifacts-test-"));
    cleanup.push(root);
    const store = new ArtifactStore(root);
    const file = await store.write("workspace", "root-task", "artifact", "patch", "abcdef");
    expect(await store.readChunk(file.uri, 1, 3)).toEqual({
      content: "bcd",
      nextOffset: 4,
      totalBytes: 6,
      done: false,
    });
  });
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "deki-runner-test-"));
  cleanup.push(root);
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  await Promise.all([mkdir(repo), mkdir(worktrees)]);
  await git(repo, "init");
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "commit", "-m", "base");
  return { repo, worktrees };
}

async function git(cwd: string, ...args: string[]) {
  return exec("git", args, { cwd });
}

async function snapshot(cwd: string) {
  const [head, status, staged] = await Promise.all([
    git(cwd, "rev-parse", "HEAD"),
    git(cwd, "status", "--short"),
    git(cwd, "diff", "--cached"),
  ]);
  return { head: head.stdout, status: status.stdout, staged: staged.stdout };
}
