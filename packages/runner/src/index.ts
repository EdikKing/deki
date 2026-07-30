import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { GitCheckpointManager } from "@deki-ai/git-checkpoint";
import {
  resolveSystemLocale,
  type DekiLocale,
  type ValidationTarget,
  type WorkerWriteSetEntry,
} from "@deki-ai/shared";

export interface RepositoryDescriptor {
  repositoryRoot: string;
  commonDirectory: string;
  workspaceRelativePath: string;
}

export interface WorktreeResource {
  id: string;
  kind: "worker" | "integration";
  path: string;
  cwd: string;
  branch: string;
  branchRef: string;
  baseCommit: string;
  repository: RepositoryDescriptor;
}

export interface ValidationResult {
  target: ValidationTarget;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  output: string;
}

export interface FinalizedWorktree {
  resource: WorktreeResource;
  commit?: string;
  patch: string;
  changedFiles: string[];
  outOfScopeFiles: string[];
  validations: ValidationResult[];
}

export interface CherryPickResult {
  ok: boolean;
  conflictFiles: string[];
  conflictKinds: Record<string, string>;
}

export interface ConflictStage {
  stage: "base" | "ours" | "theirs";
  mode: string;
  objectId: string;
}

export interface ConflictFileInspection {
  path: string;
  workspacePath: string;
  kind: string;
  safeForIntegrator: boolean;
  reasons: string[];
  size?: number;
  stages: ConflictStage[];
}

export interface ConflictInspection {
  safeForIntegrator: boolean;
  files: ConflictFileInspection[];
}

export interface IntegratorGuard {
  allowedFiles: string[];
  protectedStateSha256: string;
}

export interface ArtifactFile {
  uri: string;
  sha256: string;
  size: number;
}

const safeId = /^[A-Za-z0-9._-]{1,160}$/u;
const gitHash = /^[0-9a-f]{40,64}$/iu;
const temporaryBranchPrefix = "deki/";
const defaultTimeoutMs = 120_000;

export function createImplementerCommitMessage(
  locale = resolveSystemLocale(),
): string {
  return locale === "zh-CN"
    ? "chore(deki): 保存实施任务变更"
    : "chore(deki): save implementer changes";
}

export class ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  async write(
    workspaceId: string,
    rootTaskId: string,
    artifactId: string,
    extension: string,
    content: string | Uint8Array,
  ): Promise<ArtifactFile> {
    for (const value of [workspaceId, rootTaskId, artifactId]) validateId(value);
    if (!/^[A-Za-z0-9]{1,12}$/u.test(extension)) throw new Error("Artifact 扩展名无效");
    const directory = join(this.#root, workspaceId, rootTaskId);
    await mkdir(directory, { recursive: true });
    const uri = join(directory, `${artifactId}.${extension}`);
    const temporary = `${uri}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, uri);
    const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    return {
      uri,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: bytes,
    };
  }

  async readChunk(
    uri: string,
    offset: number,
    limit: number,
  ): Promise<{ content: string; nextOffset: number; totalBytes: number; done: boolean }> {
    const path = resolve(uri);
    assertInside(this.#root, path);
    const info = await stat(path);
    const start = Math.min(info.size, Math.max(0, Math.trunc(offset)));
    const requested = Math.max(1, Math.min(256 * 1024, limit));
    const end = Math.min(info.size, start + requested + 3);
    const handle = await import("node:fs/promises").then(({ open }) => open(path, "r"));
    try {
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const consumed = safeUtf8ChunkLength(
        buffer,
        Math.min(requested, buffer.length),
        end >= info.size,
      );
      return {
        content: buffer.subarray(0, consumed).toString("utf8"),
        nextOffset: start + consumed,
        totalBytes: info.size,
        done: start + consumed >= info.size,
      };
    } finally {
      await handle.close();
    }
  }

  async removeTask(workspaceId: string, rootTaskId: string): Promise<void> {
    validateId(workspaceId);
    validateId(rootTaskId);
    const target = join(this.#root, workspaceId, rootTaskId);
    assertInside(this.#root, target);
    await rm(target, { recursive: true, force: true });
  }
}

export class WorktreeRunner {
  readonly #workspace: string;
  readonly #worktreesRoot: string;
  readonly #timeoutMs: number;
  readonly #beforePatchApply: (() => void | Promise<void>) | undefined;

  constructor(
    workspace: string,
    options: {
      worktreesRoot: string;
      timeoutMs?: number;
      beforePatchApply?: () => void | Promise<void>;
    },
  ) {
    this.#workspace = resolve(workspace);
    this.#worktreesRoot = resolve(options.worktreesRoot);
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#beforePatchApply = options.beforePatchApply;
  }

  async inspectRepository(): Promise<RepositoryDescriptor> {
    const rootResult = await git(
      this.#workspace,
      ["rev-parse", "--show-toplevel"],
      this.#timeoutMs,
      undefined,
      true,
    );
    const repositoryRoot = rootResult.stdout.trim();
    if (!repositoryRoot) throw new Error("隔离写入只支持 Git 工作区");
    const resolvedRoot = await realpath(repositoryRoot);
    const resolvedWorkspace = await realpath(this.#workspace);
    assertInside(resolvedRoot, resolvedWorkspace);
    const commonRaw = (await git(
      resolvedRoot,
      ["rev-parse", "--git-common-dir"],
      this.#timeoutMs,
    )).stdout.trim();
    const commonDirectory = resolve(resolvedRoot, commonRaw);
    return {
      repositoryRoot: resolvedRoot,
      commonDirectory,
      workspaceRelativePath: relative(resolvedRoot, resolvedWorkspace).replaceAll("\\", "/"),
    };
  }

  async createBaseline(
    message: string,
    onCreated?: (baseline: {
      artifactId: string;
      commit: string;
      ref: string;
      repository: RepositoryDescriptor;
    }) => void | Promise<void>,
  ): Promise<{
    artifactId: string;
    commit: string;
    ref: string;
    repository: RepositoryDescriptor;
  }> {
    const repository = await this.inspectRepository();
    await assertRepositoryIdle(repository.commonDirectory);
    const workspaceGitDirectory = resolve(
      repository.repositoryRoot,
      (await git(
        this.#workspace,
        ["rev-parse", "--git-dir"],
        this.#timeoutMs,
      )).stdout.trim(),
    );
    if (workspaceGitDirectory !== repository.commonDirectory) {
      await assertRepositoryIdle(workspaceGitDirectory);
    }
    const checkpoint = await new GitCheckpointManager(this.#workspace).create(message);
    const artifactId = randomUUID();
    const ref = `refs/deki/artifacts/${artifactId}`;
    await git(
      repository.repositoryRoot,
      ["update-ref", ref, checkpoint.commit],
      this.#timeoutMs,
    );
    const baseline = {
      artifactId,
      commit: checkpoint.commit,
      ref,
      repository,
    };
    try {
      await onCreated?.(baseline);
      await git(
        repository.repositoryRoot,
        ["update-ref", "-d", checkpoint.ref, checkpoint.commit],
        this.#timeoutMs,
      );
      return baseline;
    } catch (error) {
      await git(
        repository.repositoryRoot,
        ["update-ref", "-d", ref, checkpoint.commit],
        this.#timeoutMs,
        undefined,
        true,
      );
      throw error;
    }
  }

  async createWorktree(input: {
    rootTaskId: string;
    resourceId: string;
    kind: "worker" | "integration";
    baseCommit: string;
    repository?: RepositoryDescriptor;
    onAllocated?: (resource: WorktreeResource) => void | Promise<void>;
  }): Promise<WorktreeResource> {
    validateId(input.rootTaskId);
    validateId(input.resourceId);
    if (!gitHash.test(input.baseCommit)) throw new Error("Worktree 基线提交无效");
    const repository = input.repository ?? await this.inspectRepository();
    const short = input.resourceId.replaceAll("-", "").slice(0, 20);
    const branch = `deki/${input.kind}/${short}`;
    const branchRef = `refs/heads/${branch}`;
    const path = join(this.#worktreesRoot, input.rootTaskId, input.resourceId);
    assertInside(this.#worktreesRoot, path);
    const resource: WorktreeResource = {
      id: input.resourceId,
      kind: input.kind,
      path,
      cwd: repository.workspaceRelativePath
        ? join(path, repository.workspaceRelativePath)
        : path,
      branch,
      branchRef,
      baseCommit: input.baseCommit,
      repository,
    };
    await input.onAllocated?.(resource);
    await mkdir(dirname(path), { recursive: true });
    await git(repository.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      path,
      input.baseCommit,
    ], this.#timeoutMs);
    await git(repository.repositoryRoot, [
      "branch",
      "-f",
      branch,
      input.baseCommit,
    ], this.#timeoutMs);
    await git(path, ["switch", branch], this.#timeoutMs);
    return resource;
  }

  async finalizeImplementer(input: {
    resource: WorktreeResource;
    writeSet: WorkerWriteSetEntry[];
    validationTargets: ValidationTarget[];
    locale?: DekiLocale;
    signal?: AbortSignal;
  }): Promise<FinalizedWorktree> {
    await assertWriteSetOutsideSubmodules(
      input.resource.path,
      input.writeSet,
      this.#timeoutMs,
      input.signal,
    );
    // Intent-to-add makes non-ignored untracked files visible to diff without
    // staging their content or creating a commit.
    await git(
      input.resource.path,
      ["add", "-N", "--", "."],
      this.#timeoutMs,
      input.signal,
    );
    const patch = (await git(input.resource.path, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      input.resource.baseCommit,
      "--",
      ".",
    ], this.#timeoutMs, input.signal)).stdout;
    const changed = await listChangedFiles(
      input.resource.path,
      input.resource.baseCommit,
      this.#timeoutMs,
      input.signal,
    );
    const workspaceChanges = changed.map((path) =>
      toWorkspacePath(path, input.resource.repository.workspaceRelativePath));
    const outOfScopeFiles = workspaceChanges.filter((path) =>
      !input.writeSet.some((entry) => pathMatchesWriteSet(path, entry)));
    if (changed.length === 0) {
      return {
        resource: input.resource,
        patch,
        changedFiles: [],
        outOfScopeFiles: [],
        validations: [],
      };
    }
    if (outOfScopeFiles.length > 0) {
      return {
        resource: input.resource,
        patch,
        changedFiles: workspaceChanges,
        outOfScopeFiles,
        validations: [],
      };
    }
    const validations: ValidationResult[] = [];
    for (const target of dedupeValidationTargets(input.validationTargets)) {
      validations.push(await runValidation(
        input.resource.cwd,
        target,
        this.#timeoutMs,
        input.signal,
      ));
    }
    if (validations.some((result) => result.exitCode !== 0)) {
      return {
        resource: input.resource,
        patch,
        changedFiles: workspaceChanges,
        outOfScopeFiles: [],
        validations,
      };
    }
    await git(input.resource.path, ["add", "-A", "--", "."], this.#timeoutMs, input.signal);
    await git(input.resource.path, [
      "-c", "user.name=Deki",
      "-c", "user.email=agent@deki.local",
      "commit",
      "-m",
      createImplementerCommitMessage(input.locale),
    ], this.#timeoutMs, input.signal);
    const commit = (await git(
      input.resource.path,
      ["rev-parse", "HEAD"],
      this.#timeoutMs,
      input.signal,
    )).stdout.trim();
    return {
      resource: input.resource,
      commit,
      patch: (await git(input.resource.path, [
        "diff", "--binary", "--full-index", input.resource.baseCommit, commit,
      ], this.#timeoutMs, input.signal)).stdout,
      changedFiles: workspaceChanges,
      outOfScopeFiles: [],
      validations,
    };
  }

  async cherryPick(
    integration: WorktreeResource,
    commit: string,
    signal?: AbortSignal,
  ): Promise<CherryPickResult> {
    if (!gitHash.test(commit)) throw new Error("Worker commit 无效");
    const result = await git(
      integration.path,
      [
        "-c", "user.name=Deki",
        "-c", "user.email=agent@deki.local",
        "cherry-pick", commit,
      ],
      this.#timeoutMs,
      signal,
      true,
    );
    if (result.code === 0) return { ok: true, conflictFiles: [], conflictKinds: {} };
    const conflicts = await git(
      integration.path,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.#timeoutMs,
      signal,
      true,
    );
    const conflictFiles = splitZero(conflicts.stdout);
    const porcelain = await git(
      integration.path,
      ["status", "--porcelain=v1", "-z"],
      this.#timeoutMs,
      signal,
      true,
    );
    const conflictKinds: Record<string, string> = {};
    for (const record of splitZero(porcelain.stdout)) {
      const kind = record.slice(0, 2);
      const path = record.slice(3);
      if (path) conflictKinds[path] = kind;
    }
    return { ok: false, conflictFiles, conflictKinds };
  }

  async inspectConflicts(
    integration: WorktreeResource,
    picked: CherryPickResult,
    writeSet: WorkerWriteSetEntry[],
    signal?: AbortSignal,
  ): Promise<ConflictInspection> {
    const normalizedWriteSet = validateWriteSet(writeSet);
    const files: ConflictFileInspection[] = [];
    for (const path of picked.conflictFiles) {
      const workspacePath = toWorkspacePath(
        path,
        integration.repository.workspaceRelativePath,
      );
      const stages = await conflictStages(
        integration.path,
        path,
        this.#timeoutMs,
        signal,
      );
      const reasons: string[] = [];
      const kind = picked.conflictKinds[path] ?? "unknown";
      if (kind !== "UU") reasons.push(`不支持的冲突类型：${kind}`);
      if (workspacePath.startsWith("../") || workspacePath === ".") {
        reasons.push("冲突路径位于声明工作区之外");
      }
      if (normalizedWriteSet.some((entry) =>
        (entry.exclusive || isImplicitExclusive(entry.path))
        && pathMatchesWriteSet(workspacePath, entry))) {
        reasons.push("冲突路径属于 exclusive 写入范围");
      }
      if (stages.some((stage) => stage.mode === "160000")) {
        reasons.push("冲突包含 Git submodule");
      }
      let size: number | undefined;
      try {
        const info = await lstat(join(integration.path, path));
        size = info.size;
        if (!info.isFile() || info.isSymbolicLink()) {
          reasons.push("冲突路径不是普通文件");
        } else if (info.size > 1024 * 1024) {
          reasons.push("冲突文件超过 1 MiB");
        } else {
          const content = await readFile(join(integration.path, path));
          if (!isUtf8(content)) reasons.push("冲突文件不是 UTF-8 文本");
        }
      } catch {
        reasons.push("冲突路径无法作为普通文件读取");
      }
      files.push({
        path,
        workspacePath,
        kind,
        safeForIntegrator: reasons.length === 0,
        reasons,
        ...(size === undefined ? {} : { size }),
        stages,
      });
    }
    return {
      safeForIntegrator: files.length > 0
        && files.every((file) => file.safeForIntegrator),
      files,
    };
  }

  async readConflictStage(
    integration: WorktreeResource,
    stage: ConflictStage,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (!gitHash.test(stage.objectId)) throw new Error("冲突 Git 对象无效");
    return gitObject(
      integration.path,
      stage.objectId,
      this.#timeoutMs,
      signal,
    );
  }

  async captureIntegratorGuard(
    integration: WorktreeResource,
    allowedFiles: string[],
    signal?: AbortSignal,
  ): Promise<IntegratorGuard> {
    const normalized = [...new Set(allowedFiles.map(normalizeRelativePath))];
    return {
      allowedFiles: normalized,
      protectedStateSha256: await protectedStateSha256(
        integration.path,
        normalized,
        this.#timeoutMs,
        signal,
      ),
    };
  }

  async continueCherryPick(
    integration: WorktreeResource,
    guard: IntegratorGuard,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.assertIntegratorGuard(integration, guard, signal);
    for (const path of guard.allowedFiles) {
      try {
        const content = await readFile(join(integration.path, path), "utf8");
        if (/^(?:<<<<<<<|=======|>>>>>>>)(?: .*)?$/mu.test(content)) {
          throw new Error(`Integrator 未清理冲突标记：${path}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("冲突标记")) throw error;
        // A deletion can be an explicit conflict resolution.
      }
    }
    await git(
      integration.path,
      ["add", "-A", "--", ...guard.allowedFiles],
      this.#timeoutMs,
      signal,
    );
    const unresolved = splitZero((await git(
      integration.path,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      this.#timeoutMs,
      signal,
      true,
    )).stdout);
    if (unresolved.length > 0) throw new Error(`仍有未解决冲突：${unresolved.join(", ")}`);
    await git(
      integration.path,
      ["diff", "--cached", "--check"],
      this.#timeoutMs,
      signal,
    );
    await git(
      integration.path,
      [
        "-c", "user.name=Deki",
        "-c", "user.email=agent@deki.local",
        "-c", "core.editor=true",
        "cherry-pick", "--continue",
      ],
      this.#timeoutMs,
      signal,
    );
    return (await git(integration.path, ["rev-parse", "HEAD"], this.#timeoutMs)).stdout.trim();
  }

  async assertIntegratorGuard(
    integration: WorktreeResource,
    guard: IntegratorGuard,
    signal?: AbortSignal,
  ): Promise<void> {
    const currentGuard = await protectedStateSha256(
      integration.path,
      guard.allowedFiles,
      this.#timeoutMs,
      signal,
    );
    if (currentGuard !== guard.protectedStateSha256) {
      throw new Error("Integrator 修改了冲突范围外文件");
    }
  }

  async validateIntegration(
    resource: WorktreeResource,
    targets: ValidationTarget[],
    signal?: AbortSignal,
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    for (const target of dedupeValidationTargets(targets)) {
      results.push(await runValidation(resource.cwd, target, this.#timeoutMs, signal));
    }
    return results;
  }

  async integrationPatch(
    resource: WorktreeResource,
    baselineCommit: string,
  ): Promise<{ commit: string; patch: string; changedFiles: string[] }> {
    const commit = (await git(
      resource.path,
      ["rev-parse", "HEAD"],
      this.#timeoutMs,
    )).stdout.trim();
    return {
      commit,
      patch: (await git(resource.path, [
        "diff", "--binary", "--full-index", baselineCommit, commit,
      ], this.#timeoutMs)).stdout,
      changedFiles: await listChangedFiles(resource.path, baselineCommit, this.#timeoutMs),
    };
  }

  async rescuePatch(
    resource: WorktreeResource,
  ): Promise<{ patch: string; changedFiles: string[] } | undefined> {
    try {
      await access(resource.path);
      await git(
        resource.path,
        ["add", "-N", "--", "."],
        this.#timeoutMs,
        undefined,
        true,
      );
      const patch = (await git(
        resource.path,
        [
          "diff", "--binary", "--full-index", "--no-ext-diff",
          resource.baseCommit, "--", ".",
        ],
        this.#timeoutMs,
        undefined,
        true,
      )).stdout;
      if (!patch.trim()) return undefined;
      return {
        patch,
        changedFiles: await listChangedFiles(
          resource.path,
          resource.baseCommit,
          this.#timeoutMs,
        ),
      };
    } catch {
      return undefined;
    }
  }

  async createArtifactRef(artifactId: string, commit: string): Promise<string> {
    validateId(artifactId);
    if (!gitHash.test(commit)) throw new Error("Artifact commit 无效");
    const repository = await this.inspectRepository();
    const ref = `refs/deki/artifacts/${artifactId}`;
    await git(repository.repositoryRoot, ["update-ref", ref, commit], this.#timeoutMs);
    return ref;
  }

  async removeArtifactRef(ref: string): Promise<void> {
    if (!/^refs\/deki\/artifacts\/[A-Za-z0-9._-]{1,160}$/u.test(ref)) {
      throw new Error("拒绝删除非 Deki Artifact Ref");
    }
    const repository = await this.inspectRepository();
    await git(repository.repositoryRoot, ["update-ref", "-d", ref], this.#timeoutMs, undefined, true);
  }

  async cleanup(resource: WorktreeResource): Promise<void> {
    assertInside(this.#worktreesRoot, resource.path);
    if (!resource.branch.startsWith(temporaryBranchPrefix)) {
      throw new Error("拒绝删除非 Deki 临时分支");
    }
    await git(resource.repository.repositoryRoot, [
      "worktree", "remove", "--force", resource.path,
    ], this.#timeoutMs, undefined, true);
    await git(resource.repository.repositoryRoot, [
      "update-ref", "-d", resource.branchRef,
    ], this.#timeoutMs, undefined, true);
    await git(resource.repository.repositoryRoot, ["worktree", "prune"], this.#timeoutMs);
    await rm(resource.path, { recursive: true, force: true });
  }

  async applyPatch(input: {
    baselineCommit: string;
    integrationCommit: string;
    patch: string;
  }): Promise<{ changedFiles: string[] }> {
    if (!gitHash.test(input.baselineCommit) || !gitHash.test(input.integrationCommit)) {
      throw new Error("集成提交无效");
    }
    const repository = await this.inspectRepository();
    const changes = await nameStatus(
      repository.repositoryRoot,
      input.baselineCommit,
      input.integrationCommit,
      this.#timeoutMs,
    );
    const drifted: string[] = [];
    for (const change of changes) {
      const paths = change.paths;
      for (const path of paths) {
        if (change.status.startsWith("A")) {
          try {
            await lstat(join(repository.repositoryRoot, path));
            drifted.push(path);
          } catch {
            // Expected: a newly integrated path must not already exist.
          }
          continue;
        }
        const result = await git(repository.repositoryRoot, [
          "diff", "--quiet", input.baselineCommit, "--", path,
        ], this.#timeoutMs, undefined, true);
        if (result.code !== 0) drifted.push(path);
      }
    }
    if (drifted.length > 0) {
      throw new WorkspaceDriftError([...new Set(drifted)]);
    }
    const temporary = await mkdtemp(join(tmpdir(), "deki-integration-apply-"));
    const patchFile = join(temporary, "integration.patch");
    try {
      await writeFile(patchFile, input.patch, "utf8");
      const backups = join(temporary, "backup");
      await mkdir(backups, { recursive: true });
      const existing = new Set<string>();
      for (const path of changes.flatMap((change) => change.paths)) {
        const source = join(repository.repositoryRoot, path);
        try {
          const info = await lstat(source);
          if (info.isFile() || info.isSymbolicLink()) {
            existing.add(path);
            const destination = join(backups, path);
            await mkdir(dirname(destination), { recursive: true });
            await cp(source, destination, {
              recursive: true,
              force: true,
              dereference: false,
              preserveTimestamps: true,
            });
          }
        } catch {
          // Missing paths need no backup.
        }
      }
      await new GitCheckpointManager(this.#workspace).create(
        `Safety checkpoint before applying integration ${input.integrationCommit.slice(0, 12)}`,
      );
      await git(
        repository.repositoryRoot,
        ["apply", "--check", "--binary", patchFile],
        this.#timeoutMs,
      );
      try {
        await this.#beforePatchApply?.();
        await git(repository.repositoryRoot, ["apply", "--binary", patchFile], this.#timeoutMs);
      } catch (error) {
        for (const path of changes.flatMap((change) => change.paths)) {
          const destination = join(repository.repositoryRoot, path);
          if (!existing.has(path)) {
            await rm(destination, { recursive: true, force: true });
            continue;
          }
          await mkdir(dirname(destination), { recursive: true });
          await rm(destination, { recursive: true, force: true });
          await cp(join(backups, path), destination, {
            recursive: true,
            force: true,
            dereference: false,
            preserveTimestamps: true,
          });
        }
        throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return { changedFiles: [...new Set(changes.flatMap((change) => change.paths))] };
  }
}

export class WorkspaceDriftError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`当前工作区已偏离集成基线：${paths.join(", ")}`);
    this.name = "WorkspaceDriftError";
    this.paths = paths;
  }
}

export function writeSetsOverlap(
  left: WorkerWriteSetEntry[],
  right: WorkerWriteSetEntry[],
): string[] {
  const overlaps: string[] = [];
  for (const a of left) {
    for (const b of right) {
      const aPath = normalizeRelativePath(a.path);
      const bPath = normalizeRelativePath(b.path);
      if (
        a.exclusive
        || b.exclusive
        || isImplicitExclusive(aPath)
        || isImplicitExclusive(bPath)
        || aPath === bPath
        || (a.kind === "directory" && isPathPrefix(aPath, bPath))
        || (b.kind === "directory" && isPathPrefix(bPath, aPath))
      ) {
        overlaps.push(aPath === bPath ? aPath : `${aPath} ↔ ${bPath}`);
      }
    }
  }
  return [...new Set(overlaps)];
}

export function scheduleWriteWaves<T extends { writeSet: WorkerWriteSetEntry[] }>(
  requests: T[],
): T[][] {
  const waves: T[][] = [];
  for (const request of requests) {
    const wave = waves.find((candidate) =>
      candidate.every((other) => writeSetsOverlap(request.writeSet, other.writeSet).length === 0));
    if (wave) wave.push(request);
    else waves.push([request]);
  }
  return waves;
}

export function validateWriteSet(entries: WorkerWriteSetEntry[]): WorkerWriteSetEntry[] {
  return entries.map((entry) => ({
    ...entry,
    path: normalizeRelativePath(entry.path),
    exclusive: entry.exclusive || isImplicitExclusive(entry.path),
  }));
}

function pathMatchesWriteSet(path: string, entry: WorkerWriteSetEntry): boolean {
  const normalizedPath = normalizeRelativePath(path);
  const scope = normalizeRelativePath(entry.path);
  return normalizedPath === scope
    || (entry.kind === "directory" && isPathPrefix(scope, normalizedPath));
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (
    !normalized
    || normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split("/").includes("..")
  ) throw new Error(`路径必须是安全的工作区相对路径：${value}`);
  return normalized;
}

function isImplicitExclusive(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const base = normalized.split("/").at(-1) ?? normalized;
  return [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ].includes(base)
    || normalized.endsWith(".sql")
    || normalized.endsWith(".d.ts")
    || normalized.split("/").includes("migrations");
}

function isPathPrefix(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function toWorkspacePath(path: string, workspaceRelativePath: string): string {
  const normalized = path.replaceAll("\\", "/");
  const prefix = workspaceRelativePath.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!prefix) return normalized;
  if (!normalized.startsWith(`${prefix}/`) && normalized !== prefix) {
    return `../${normalized}`;
  }
  return normalized === prefix ? "." : normalized.slice(prefix.length + 1);
}

async function assertRepositoryIdle(commonDirectory: string): Promise<void> {
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
  ];
  for (const marker of markers) {
    try {
      await access(join(commonDirectory, marker));
      throw new Error(`仓库正在进行 ${marker}，不能创建隔离写入基线`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("不能创建")) throw error;
    }
  }
}

async function assertWriteSetOutsideSubmodules(
  cwd: string,
  writeSet: WorkerWriteSetEntry[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const result = await git(
    cwd,
    ["config", "--file", ".gitmodules", "--get-regexp", "path"],
    timeoutMs,
    signal,
    true,
  );
  if (result.code !== 0) return;
  const submodules = result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^\S+\s+(.+)$/u);
    return match?.[1] ? [normalizeRelativePath(match[1])] : [];
  });
  for (const entry of writeSet) {
    const path = normalizeRelativePath(entry.path);
    const submodule = submodules.find((candidate) =>
      isPathPrefix(candidate, path) || isPathPrefix(path, candidate));
    if (submodule) throw new Error(`M5 不允许修改 Git submodule 路径：${submodule}`);
  }
}

async function listChangedFiles(
  cwd: string,
  base: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const output = await git(cwd, [
    "diff", "--name-only", "-z", base, "--", ".",
  ], timeoutMs, signal);
  return splitZero(output.stdout);
}

async function nameStatus(
  cwd: string,
  base: string,
  head: string,
  timeoutMs: number,
): Promise<Array<{ status: string; paths: string[] }>> {
  const records = splitZero((await git(cwd, [
    "diff", "--name-status", "-z", base, head,
  ], timeoutMs)).stdout);
  const result: Array<{ status: string; paths: string[] }> = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++] ?? "";
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    result.push({ status, paths: records.slice(index, index += count) });
  }
  return result;
}

async function conflictStages(
  cwd: string,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ConflictStage[]> {
  const output = (await git(
    cwd,
    ["ls-files", "-u", "-z", "--", path],
    timeoutMs,
    signal,
    true,
  )).stdout;
  const names = { 1: "base", 2: "ours", 3: "theirs" } as const;
  return splitZero(output).flatMap((record) => {
    const match = record.match(/^(\d{6}) ([0-9a-f]{40,64}) ([123])\t/u);
    if (!match?.[1] || !match[2] || !match[3]) return [];
    const stageNumber = Number(match[3]) as 1 | 2 | 3;
    return [{
      stage: names[stageNumber],
      mode: match[1],
      objectId: match[2],
    }];
  });
}

async function protectedStateSha256(
  cwd: string,
  allowedFiles: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const exclusions = allowedFiles.map((path) => `:(exclude,literal)${path}`);
  const [diff, untracked] = await Promise.all([
    git(
      cwd,
      ["diff", "--binary", "--full-index", "HEAD", "--", ".", ...exclusions],
      timeoutMs,
      signal,
      true,
    ),
    git(
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclusions],
      timeoutMs,
      signal,
      true,
    ),
  ]);
  return createHash("sha256")
    .update(diff.stdout)
    .update("\0")
    .update(untracked.stdout)
    .digest("hex");
}

async function runValidation(
  workspace: string,
  target: ValidationTarget,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  const cwdRelative = target.cwd ? normalizeRelativePath(target.cwd) : "";
  const cwd = cwdRelative ? resolve(workspace, cwdRelative) : workspace;
  assertInside(workspace, cwd);
  const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (typeof manifest.scripts?.[target.script] !== "string") {
    throw new Error(`验证脚本未在 package.json 声明：${target.script}`);
  }
  const executable = await packageManagerExecutable(cwd);
  const started = Date.now();
  const result = await processRun(
    executable,
    ["run", target.script],
    cwd,
    timeoutMs,
    signal,
    true,
    validationEnvironment(),
  );
  return {
    target,
    exitCode: result.code,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
    output: `${result.stdout}${result.stderr}`.slice(-1_000_000),
  };
}

async function packageManagerExecutable(cwd: string): Promise<string> {
  const candidates: Array<[string, string]> = [
    ["pnpm-lock.yaml", process.platform === "win32" ? "pnpm.cmd" : "pnpm"],
    ["yarn.lock", process.platform === "win32" ? "yarn.cmd" : "yarn"],
    ["bun.lock", process.platform === "win32" ? "bun.exe" : "bun"],
    ["bun.lockb", process.platform === "win32" ? "bun.exe" : "bun"],
  ];
  let current = cwd;
  for (;;) {
    for (const [marker, executable] of candidates) {
      try {
        await access(join(current, marker));
        return executable;
      } catch {
        // Continue searching ancestors.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function validationEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of [
    "PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "HOME",
    "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM",
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function dedupeValidationTargets(targets: ValidationTarget[]): ValidationTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.cwd ?? ""}\0${target.script}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  allowFailure = false,
): Promise<ProcessResult> {
  const result = await processRun("git", args, cwd, timeoutMs, signal, allowFailure);
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args[0] ?? ""} 失败：${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

async function gitObject(
  cwd: string,
  objectId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["cat-file", "blob", objectId], {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    let size = 0;
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 64 * 1024 * 1024) {
        child.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-100_000);
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (size > 64 * 1024 * 1024) {
        reject(new Error("冲突 Artifact 单个 Git 对象超过 64 MiB"));
      } else if (!timedOut && code === 0) {
        resolvePromise(Buffer.concat(stdout));
      } else {
        reject(new Error(`读取冲突 Git 对象失败：${stderr.trim() || `exit ${code ?? -1}`}`));
      }
    });
  });
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function processRun(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  allowFailure = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const requiresWindowsShell = process.platform === "win32"
      && /\.(?:cmd|bat)$/iu.test(command);
    const child = spawn(command, args, {
      cwd,
      env,
      // Windows cannot execute package-manager .cmd shims directly with
      // shell:false. The executable and validation script names are both
      // selected from constrained allowlists before reaching this helper.
      shell: requiresWindowsShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(-4_000_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const result = { code: timedOut ? -1 : code ?? -1, stdout, stderr, timedOut };
      if (result.code === 0 || allowFailure) resolvePromise(result);
      else reject(new Error(`${command} 失败：${stderr.trim() || stdout.trim()}`));
    });
  });
}

function splitZero(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function safeUtf8ChunkLength(
  buffer: Buffer,
  requested: number,
  endOfFile: boolean,
): number {
  if (endOfFile && buffer.length <= requested) return buffer.length;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const valid = (length: number) => {
    try {
      decoder.decode(buffer.subarray(0, length));
      return true;
    } catch {
      return false;
    }
  };
  for (let length = requested; length > Math.max(0, requested - 4); length -= 1) {
    if (length > 0 && valid(length)) return length;
  }
  for (
    let length = requested + 1;
    length <= Math.min(buffer.length, requested + 3);
    length += 1
  ) {
    if (valid(length)) return length;
  }
  return Math.min(requested, buffer.length);
}

function validateId(value: string): void {
  if (!safeId.test(value)) throw new Error(`资源标识无效：${value}`);
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const relation = relative(normalizedRoot, normalizedCandidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return;
  throw new Error(`路径超出允许范围：${candidate}`);
}
