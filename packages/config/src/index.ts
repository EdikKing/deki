import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const trustConfigSchema = z.object({
  version: z.literal(1),
  trustedWorkspaces: z.record(z.string(), z.object({
    trustedAt: z.string(),
  }).strict()),
  recentWorkspaces: z.array(z.string()).default([]),
}).strict();

export const mcpServerConfigSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  enabled: z.boolean().default(true),
  tools: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    permission: z.enum(["allow", "ask", "deny"]).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }).strict()).default({}),
}).strict();

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema).default({}),
}).strict();

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
const mcpLocalConfigSchema = z.object({
  servers: z.record(z.string(), z.object({
    environment: z.record(z.string(), z.string()).default({}),
  }).strict()).default({}),
}).strict();
export type McpLocalConfig = z.infer<typeof mcpLocalConfigSchema>;

export interface DekiPaths {
  root: string;
  configFile: string;
  settingsFile: string;
  modelsFile: string;
  projectsRoot: string;
  sessionsRoot: string;
  memoryDatabase: string;
  tasksDatabase: string;
  logsRoot: string;
}

export function getDekiPaths(
  root = process.env.DEKI_HOME ?? join(homedir(), ".deki"),
): DekiPaths {
  return {
    root,
    configFile: join(root, "config.json"),
    settingsFile: join(root, "settings.json"),
    modelsFile: join(root, "models.json"),
    projectsRoot: join(root, "projects"),
    sessionsRoot: join(root, "sessions"),
    memoryDatabase: join(root, "memory", "memory.db"),
    tasksDatabase: join(root, "tasks", "tasks.db"),
    logsRoot: join(root, "logs"),
  };
}

export async function ensureDekiDirectories(paths: DekiPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.sessionsRoot, { recursive: true }),
    mkdir(paths.projectsRoot, { recursive: true }),
    mkdir(resolve(paths.memoryDatabase, ".."), { recursive: true }),
    mkdir(resolve(paths.tasksDatabase, ".."), { recursive: true }),
    mkdir(paths.logsRoot, { recursive: true }),
  ]);
}

export async function resolveWorkspace(
  argv: readonly string[],
  fallbackCwd: string,
): Promise<string> {
  const index = argv.indexOf("--workspace");
  const requested = index >= 0 ? argv[index + 1] : fallbackCwd;
  if (!requested) {
    throw new Error("--workspace 需要一个路径");
  }

  const absolute = isAbsolute(requested) ? requested : resolve(fallbackCwd, requested);
  await access(absolute);
  return realpath(absolute);
}

export function workspaceId(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 24);
}

async function readTrustConfig(configFile: string): Promise<z.infer<typeof trustConfigSchema>> {
  try {
    const raw = await readFile(configFile, "utf8");
    return trustConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isFileNotFound(error)) {
      return { version: 1, trustedWorkspaces: {}, recentWorkspaces: [] };
    }
    throw error;
  }
}

export async function isWorkspaceTrusted(
  configFile: string,
  workspace: string,
): Promise<boolean> {
  const config = await readTrustConfig(configFile);
  return config.trustedWorkspaces[workspace] !== undefined;
}

export async function trustWorkspace(
  configFile: string,
  workspace: string,
): Promise<void> {
  const config = await readTrustConfig(configFile);
  config.trustedWorkspaces[workspace] = {
    trustedAt: new Date().toISOString(),
  };
  config.recentWorkspaces = [
    workspace,
    ...config.recentWorkspaces.filter((candidate) => candidate !== workspace),
  ].slice(0, 20);
  await mkdir(resolve(configFile, ".."), { recursive: true });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function revokeWorkspaceTrust(
  configFile: string,
  workspace: string,
): Promise<void> {
  const config = await readTrustConfig(configFile);
  delete config.trustedWorkspaces[workspace];
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function listRecentWorkspaces(configFile: string): Promise<string[]> {
  return (await readTrustConfig(configFile)).recentWorkspaces;
}

export async function loadMcpConfig(workspace: string): Promise<McpConfig> {
  const parsed = await readMcpConfig(workspace);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(parsed.mcpServers).map(([id, server]) => [
        id,
        {
          ...server,
          cwd: server.cwd
            ? resolve(workspace, server.cwd)
            : workspace,
        },
      ]),
    ),
  };
}

export async function readMcpConfig(workspace: string): Promise<McpConfig> {
  const file = join(workspace, ".deki", "mcp.json");
  try {
    const raw = await readFile(file, "utf8");
    return mcpConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isFileNotFound(error)) {
      return { mcpServers: {} };
    }
    throw new Error(`无法读取 ${file}: ${formatError(error)}`, { cause: error });
  }
}

export async function writeMcpConfig(
  workspace: string,
  config: McpConfig,
): Promise<void> {
  const parsed = mcpConfigSchema.parse(config);
  const file = join(workspace, ".deki", "mcp.json");
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await rename(temporary, file);
}

export async function readMcpLocalConfig(file: string): Promise<McpLocalConfig> {
  try {
    return mcpLocalConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isFileNotFound(error)) return { servers: {} };
    throw new Error(`无法读取本机 MCP 配置 ${file}: ${formatError(error)}`, { cause: error });
  }
}

export async function writeMcpLocalConfig(
  file: string,
  config: McpLocalConfig,
): Promise<void> {
  const parsed = mcpLocalConfigSchema.parse(config);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file);
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}
