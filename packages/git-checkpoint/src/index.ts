import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface GitCheckpoint {
  id: string;
  ref: string;
  commit: string;
  createdAt: string;
  message: string;
}

export interface GitCheckpointResult extends GitCheckpoint {
  repositoryRoot: string;
  changedFiles: number;
}

export interface GitRestoreResult {
  restored: GitCheckpoint;
  safetyCheckpoint: GitCheckpointResult;
}

const CHECKPOINT_NAMESPACE = "refs/deki/checkpoints/";
const checkpointIdPattern = /^[A-Za-z0-9._-]{1,160}$/u;

export class GitCheckpointManager {
  readonly #workspace: string;

  constructor(workspace: string) {
    this.#workspace = resolve(workspace);
  }

  async repositoryRoot(): Promise<string | undefined> {
    const result = await runGit(
      ["rev-parse", "--show-toplevel"],
      this.#workspace,
      { allowFailure: true },
    );
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async create(message = "Deki workspace checkpoint"): Promise<GitCheckpointResult> {
    const repositoryRoot = await this.#requireRepository();
    const temporary = await mkdtemp(join(tmpdir(), "deki-git-checkpoint-"));
    const indexFile = join(temporary, "index");
    const environment = {
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: "Deki",
      GIT_AUTHOR_EMAIL: "checkpoint@deki.local",
      GIT_COMMITTER_NAME: "Deki",
      GIT_COMMITTER_EMAIL: "checkpoint@deki.local",
    };
    try {
      const headResult = await runGit(
        ["rev-parse", "--verify", "HEAD"],
        repositoryRoot,
        { allowFailure: true },
      );
      const head = headResult.code === 0 ? headResult.stdout.trim() : undefined;
      await runGit(head ? ["read-tree", head] : ["read-tree", "--empty"], repositoryRoot, {
        environment,
      });
      await runGit(["add", "-A", "--", "."], repositoryRoot, { environment });
      const tree = (await runGit(["write-tree"], repositoryRoot, { environment })).stdout.trim();
      const createdAt = new Date().toISOString();
      const id = `${createdAt.replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
      const ref = `${CHECKPOINT_NAMESPACE}${id}`;
      const commitArgs = [
        "commit-tree",
        tree,
        ...(head ? ["-p", head] : []),
        "-m",
        `${message.trim() || "Deki workspace checkpoint"}\n\nDeki-Checkpoint-Id: ${id}`,
      ];
      const commit = (await runGit(commitArgs, repositoryRoot, { environment })).stdout.trim();
      await runGit(["update-ref", ref, commit], repositoryRoot);
      const status = await runGit(["status", "--short"], repositoryRoot);
      return {
        id,
        ref,
        commit,
        createdAt,
        message: message.trim() || "Deki workspace checkpoint",
        repositoryRoot,
        changedFiles: status.stdout.split("\n").filter(Boolean).length,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async list(limit = 50): Promise<GitCheckpoint[]> {
    const repositoryRoot = await this.#requireRepository();
    const output = await runGit([
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)",
      CHECKPOINT_NAMESPACE,
    ], repositoryRoot);
    return output.stdout.split("\n").filter(Boolean).slice(0, Math.max(0, limit))
      .map((line) => {
        const [ref = "", commit = "", createdAt = "", message = ""] = line.split("\t");
        return {
          id: ref.slice(CHECKPOINT_NAMESPACE.length),
          ref,
          commit,
          createdAt,
          message,
        };
      });
  }

  async get(id: string): Promise<GitCheckpoint> {
    validateCheckpointId(id);
    const checkpoints = await this.list(10_000);
    const exact = checkpoints.find((checkpoint) =>
      checkpoint.id === id || checkpoint.commit === id);
    if (exact) return exact;
    const matches = checkpoints.filter((checkpoint) =>
      checkpoint.id.startsWith(id) || checkpoint.commit.startsWith(id));
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1) throw new Error(`Checkpoint 标识不唯一: ${id}`);
    throw new Error(`未找到 Git Checkpoint: ${id}`);
  }

  async diff(id: string): Promise<string> {
    const repositoryRoot = await this.#requireRepository();
    const checkpoint = await this.get(id);
    return (await runGit(
      ["diff", "--binary", "--no-ext-diff", checkpoint.commit],
      repositoryRoot,
    )).stdout;
  }

  async restore(id: string): Promise<GitRestoreResult> {
    const repositoryRoot = await this.#requireRepository();
    const checkpoint = await this.get(id);
    const safetyCheckpoint = await this.create(`Safety checkpoint before restoring ${checkpoint.id}`);
    await runGit(
      ["restore", "--source", checkpoint.commit, "--worktree", "--", "."],
      repositoryRoot,
    );
    return { restored: checkpoint, safetyCheckpoint };
  }

  async remove(id: string): Promise<GitCheckpoint> {
    const repositoryRoot = await this.#requireRepository();
    const checkpoint = await this.get(id);
    await runGit(["update-ref", "-d", checkpoint.ref, checkpoint.commit], repositoryRoot);
    return checkpoint;
  }

  async #requireRepository(): Promise<string> {
    const root = await this.repositoryRoot();
    if (!root) throw new Error(`${this.#workspace} 不是 Git 工作区`);
    return root;
  }
}

export async function isGitAvailable(): Promise<boolean> {
  const result = await runProcess("git", ["--version"], process.cwd(), {
    allowFailure: true,
  });
  return result.code === 0;
}

function validateCheckpointId(id: string): void {
  if (!checkpointIdPattern.test(id)) {
    throw new Error("Checkpoint 标识格式无效");
  }
}

interface RunOptions {
  allowFailure?: boolean;
  environment?: Record<string, string>;
}

async function runGit(
  args: string[],
  cwd: string,
  options: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess("git", args, cwd, options);
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code === 0 || options.allowFailure) {
        resolvePromise(result);
      } else {
        reject(new Error(
          `git ${args[0] ?? basename(command)} 失败: ${stderr.trim() || stdout.trim() || `exit ${result.code}`}`,
        ));
      }
    });
  });
}
