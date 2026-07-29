import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  createImplementerCommitMessage,
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
  it("uses a localized Conventional Commit message for internal commits", () => {
    expect(createImplementerCommitMessage("zh-CN"))
      .toBe("chore(deki): 保存实施任务变更");
    expect(createImplementerCommitMessage("en-US"))
      .toBe("chore(deki): save implementer changes");
  });

  it("rejects path injection and marks lockfiles, SQL and migrations exclusive", () => {
    for (const path of ["../escape", "/absolute", ".git/config", "C:/windows"]) {
      expect(() => validateWriteSet([{ path, kind: "file", exclusive: false }]))
        .toThrow("工作区相对路径");
    }
    expect(validateWriteSet([
      { path: "pnpm-lock.yaml", kind: "file", exclusive: false },
      { path: "db/schema.sql", kind: "file", exclusive: false },
      { path: "db/migrations", kind: "directory", exclusive: false },
    ])).toEqual([
      { path: "pnpm-lock.yaml", kind: "file", exclusive: true },
      { path: "db/schema.sql", kind: "file", exclusive: true },
      { path: "db/migrations", kind: "directory", exclusive: true },
    ]);
  });

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
    expect(baseline.ref).toBe(`refs/deki/artifacts/${baseline.artifactId}`);
    expect((await git(fixture.repo, "for-each-ref", "--format=%(refname)",
      "refs/deki/checkpoints/")).stdout).toBe("");
    expect((await git(fixture.repo, "show", `${baseline.commit}:tracked.txt`)).stdout)
      .toBe("dirty\n");
    expect((await git(fixture.repo, "show", `${baseline.commit}:untracked.txt`)).stdout)
      .toBe("untracked\n");
  });

  it("maps a repository subdirectory workspace into every isolated worktree", async () => {
    const fixture = await repository();
    const workspace = join(fixture.repo, "packages", "app");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.exit(0)\"" },
    }));
    await writeFile(join(workspace, "module.txt"), "workspace base\n");
    await git(fixture.repo, "add", "-A");
    await git(fixture.repo, "-c", "user.name=Fixture", "-c",
      "user.email=fixture@example.com", "commit", "-m", "workspace");
    await writeFile(join(workspace, "dirty.txt"), "dirty baseline\n");
    const before = await snapshot(fixture.repo);
    const runner = new WorktreeRunner(workspace, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("subdirectory baseline");
    expect(baseline.repository.workspaceRelativePath).toBe("packages/app");
    expect(await snapshot(fixture.repo)).toEqual(before);
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "subdirectory-worker",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    expect(resource.cwd).toBe(join(resource.path, "packages", "app"));
    await writeFile(join(resource.cwd, "module.txt"), "implemented\n");
    const result = await runner.finalizeImplementer({
      resource,
      writeSet: [{ path: "module.txt", kind: "file", exclusive: false }],
      validationTargets: [{ script: "test" }],
    });
    expect(result.changedFiles).toEqual(["module.txt"]);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    await runner.cleanup(resource);
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
    expect((await git(fixture.repo, "show", "-s", "--format=%s", result.commit!)).stdout.trim())
      .toBe(createImplementerCommitMessage());
    const ref = await runner.createArtifactRef("commit-artifact", result.commit!);
    await runner.cleanup(resource);
    expect((await git(fixture.repo, "rev-parse", ref)).stdout.trim()).toBe(result.commit);
    expect(await readFile(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
  });

  it("persists allocation intent before creating a worktree", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("test baseline");
    let callbackObservedMissingPath = false;
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "allocation-task",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
      onAllocated: async (allocated) => {
        callbackObservedMissingPath = await access(allocated.path).then(
          () => false,
          () => true,
        );
      },
    });
    expect(callbackObservedMissingPath).toBe(true);
    await runner.cleanup(resource);
  });

  it("rescues an uncommitted patch and cleans a recorded resource idempotently", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("recovery baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "recovery-worker",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(resource.cwd, "tracked.txt"), "recover me\n");
    expect(await runner.rescuePatch(resource)).toMatchObject({
      changedFiles: ["tracked.txt"],
      patch: expect.stringContaining("+recover me"),
    });
    await runner.cleanup(resource);
    await runner.cleanup(resource);
    await expect(access(resource.path)).rejects.toThrow();
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

  it("rolls back every affected path when apply fails after preflight", async () => {
    const fixture = await repository();
    const baselineRunner = new WorktreeRunner(fixture.repo, {
      worktreesRoot: fixture.worktrees,
    });
    const baseline = await baselineRunner.createBaseline("rollback baseline");
    const resource = await baselineRunner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "rollback-integration",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(resource.cwd, "tracked.txt"), "integrated\n");
    await writeFile(join(resource.cwd, "created.txt"), "created\n");
    await git(resource.path, "add", "-A");
    await git(resource.path, "-c", "user.name=Deki", "-c", "user.email=test@deki.local",
      "commit", "-m", "integration");
    const integrated = await baselineRunner.integrationPatch(resource, baseline.commit);
    const runner = new WorktreeRunner(fixture.repo, {
      worktreesRoot: fixture.worktrees,
      beforePatchApply: async () => {
        await writeFile(join(fixture.repo, "tracked.txt"), "raced edit\n");
      },
    });
    await expect(runner.applyPatch({
      baselineCommit: baseline.commit,
      integrationCommit: integrated.commit,
      patch: integrated.patch,
    })).rejects.toThrow();
    expect(await readFile(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
    await expect(access(join(fixture.repo, "created.txt"))).rejects.toThrow();
    await baselineRunner.cleanup(resource);
  });

  it("applies deletes, renames and symlinks without touching the index", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.repo, "delete-me.txt"), "delete\n");
    await writeFile(join(fixture.repo, "rename-me.txt"), "rename\n");
    await git(fixture.repo, "add", "-A");
    await git(fixture.repo, "-c", "user.name=Fixture", "-c",
      "user.email=fixture@example.com", "commit", "-m", "paths");
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("path baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "path-integration",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await rm(join(resource.cwd, "delete-me.txt"));
    await git(resource.path, "mv", "rename-me.txt", "renamed.txt");
    await symlink("tracked.txt", join(resource.cwd, "tracked-link"));
    await git(resource.path, "add", "-A");
    await git(resource.path, "-c", "user.name=Deki", "-c", "user.email=test@deki.local",
      "commit", "-m", "path integration");
    const integrated = await runner.integrationPatch(resource, baseline.commit);
    const beforeIndex = (await git(fixture.repo, "diff", "--cached")).stdout;
    await runner.applyPatch({
      baselineCommit: baseline.commit,
      integrationCommit: integrated.commit,
      patch: integrated.patch,
    });
    await expect(access(join(fixture.repo, "delete-me.txt"))).rejects.toThrow();
    await expect(access(join(fixture.repo, "rename-me.txt"))).rejects.toThrow();
    expect(await readFile(join(fixture.repo, "renamed.txt"), "utf8")).toBe("rename\n");
    expect((await lstat(join(fixture.repo, "tracked-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(fixture.repo, "tracked-link"))).toBe("tracked.txt");
    expect((await git(fixture.repo, "diff", "--cached")).stdout).toBe(beforeIndex);
    await runner.cleanup(resource);
  });

  it("rejects baselines during an in-progress merge and write sets inside submodules", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    await writeFile(join(fixture.repo, ".git", "MERGE_HEAD"), "a".repeat(40));
    await expect(runner.createBaseline("merge baseline")).rejects.toThrow("MERGE_HEAD");
    await rm(join(fixture.repo, ".git", "MERGE_HEAD"));
    await writeFile(join(fixture.repo, ".gitmodules"), [
      "[submodule \"vendor/lib\"]",
      "\tpath = vendor/lib",
      "\turl = ../lib",
      "",
    ].join("\n"));
    await git(fixture.repo, "add", ".gitmodules");
    await git(fixture.repo, "-c", "user.name=Fixture", "-c",
      "user.email=fixture@example.com", "commit", "-m", "submodule declaration");
    const baseline = await runner.createBaseline("submodule baseline");
    const resource = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "submodule-worker",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await expect(runner.finalizeImplementer({
      resource,
      writeSet: [{ path: "vendor/lib/file.txt", kind: "file", exclusive: false }],
      validationTargets: [{ script: "test" }],
    })).rejects.toThrow("submodule");
    await runner.cleanup(resource);
  });

  it("allows a restricted Integrator to resolve a small UTF-8 both-modified conflict", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("conflict baseline");
    const first = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "first-worker",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    const second = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "second-worker",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    const integration = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "conflict-integration",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(first.cwd, "tracked.txt"), "first\n");
    await writeFile(join(second.cwd, "tracked.txt"), "second\n");
    const writeSet = [{ path: "tracked.txt", kind: "file" as const, exclusive: false }];
    const firstResult = await runner.finalizeImplementer({
      resource: first,
      writeSet,
      validationTargets: [{ script: "test" }],
    });
    const secondResult = await runner.finalizeImplementer({
      resource: second,
      writeSet,
      validationTargets: [{ script: "test" }],
    });
    expect((await runner.cherryPick(integration, firstResult.commit!)).ok).toBe(true);
    const picked = await runner.cherryPick(integration, secondResult.commit!);
    expect(picked.ok).toBe(false);
    const inspection = await runner.inspectConflicts(integration, picked, writeSet);
    expect(inspection).toMatchObject({
      safeForIntegrator: true,
      files: [{ path: "tracked.txt", kind: "UU", safeForIntegrator: true }],
    });
    expect(inspection.files[0]?.stages.map((stage) => stage.stage))
      .toEqual(["base", "ours", "theirs"]);
    expect((await runner.inspectConflicts(integration, picked, [{
      ...writeSet[0]!,
      exclusive: true,
    }])).safeForIntegrator).toBe(false);
    const guard = await runner.captureIntegratorGuard(integration, ["tracked.txt"]);
    await writeFile(join(integration.cwd, "tracked.txt"), "first\nsecond\n");
    await runner.continueCherryPick(integration, guard);
    expect(await readFile(join(integration.cwd, "tracked.txt"), "utf8"))
      .toBe("first\nsecond\n");
    await runner.cleanup(first);
    await runner.cleanup(second);
    await runner.cleanup(integration);
  });

  it("rejects Integrator edits outside the conflict paths", async () => {
    const fixture = await repository();
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("guard baseline");
    const integration = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "guard-integration",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    const guard = await runner.captureIntegratorGuard(integration, ["tracked.txt"]);
    await writeFile(join(integration.cwd, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.exit(1)\"" },
    }));
    await expect(runner.assertIntegratorGuard(integration, guard))
      .rejects.toThrow("冲突范围外");
    await runner.cleanup(integration);
  });

  it("forces binary conflicts to pause instead of invoking Integrator", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.repo, "binary.dat"), Buffer.from([0xff, 0x00, 0x01]));
    await git(fixture.repo, "add", "binary.dat");
    await git(fixture.repo, "-c", "user.name=Fixture", "-c",
      "user.email=fixture@example.com", "commit", "-m", "binary base");
    const runner = new WorktreeRunner(fixture.repo, { worktreesRoot: fixture.worktrees });
    const baseline = await runner.createBaseline("binary conflict baseline");
    const first = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "binary-first",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    const second = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "binary-second",
      kind: "worker",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    const integration = await runner.createWorktree({
      rootTaskId: "root-task",
      resourceId: "binary-integration",
      kind: "integration",
      baseCommit: baseline.commit,
      repository: baseline.repository,
    });
    await writeFile(join(first.cwd, "binary.dat"), Buffer.from([0xff, 0x10, 0x01]));
    await writeFile(join(second.cwd, "binary.dat"), Buffer.from([0xff, 0x20, 0x01]));
    const writeSet = [{ path: "binary.dat", kind: "file" as const, exclusive: false }];
    const firstResult = await runner.finalizeImplementer({
      resource: first,
      writeSet,
      validationTargets: [{ script: "test" }],
    });
    const secondResult = await runner.finalizeImplementer({
      resource: second,
      writeSet,
      validationTargets: [{ script: "test" }],
    });
    await runner.cherryPick(integration, firstResult.commit!);
    const picked = await runner.cherryPick(integration, secondResult.commit!);
    const inspection = await runner.inspectConflicts(integration, picked, writeSet);
    expect(inspection.safeForIntegrator).toBe(false);
    expect(inspection.files[0]?.reasons).toContain("冲突文件不是 UTF-8 文本");
    await runner.cleanup(first);
    await runner.cleanup(second);
    await runner.cleanup(integration);
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
    const unicode = await store.write(
      "workspace",
      "root-task",
      "unicode-artifact",
      "diff",
      "你a",
    );
    const first = await store.readChunk(unicode.uri, 0, 2);
    expect(first).toMatchObject({ content: "你", nextOffset: 3, done: false });
    expect(await store.readChunk(unicode.uri, first.nextOffset, 2))
      .toMatchObject({ content: "a", nextOffset: 4, done: true });
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
