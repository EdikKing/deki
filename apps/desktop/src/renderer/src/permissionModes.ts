import type {
  PermissionCategory,
  PermissionPolicy,
} from "@deki-ai/shared";

export type PermissionMode = "request" | "agent" | "full";

export const permissionModes: PermissionMode[] = ["request", "agent", "full"];

const permissionCategories: PermissionCategory[] = [
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "shell.safe",
  "shell.unknown",
  "dependencies.install",
  "git.commit",
  "git.push",
  "outsideWorkspace",
  "sensitiveFiles",
  "privileged",
  "network",
  "mcp.read",
  "mcp.write",
];

const requestAllowed = new Set<PermissionCategory>([
  "workspace.read",
  "workspace.write",
  "shell.safe",
  "mcp.read",
]);

const agentApprovalRequired = new Set<PermissionCategory>([
  "git.push",
  "outsideWorkspace",
  "sensitiveFiles",
  "privileged",
  "network",
]);

export function policiesForPermissionMode(
  mode: PermissionMode,
): Record<PermissionCategory, PermissionPolicy> {
  return Object.fromEntries(permissionCategories.map((category) => {
    if (mode === "full") return [category, "allow"];
    if (mode === "request") {
      return [category, requestAllowed.has(category) ? "allow" : "ask"];
    }
    return [category, agentApprovalRequired.has(category) ? "ask" : "allow"];
  })) as Record<PermissionCategory, PermissionPolicy>;
}

export function detectPermissionMode(
  policies: Record<PermissionCategory, PermissionPolicy>,
): PermissionMode | "custom" {
  for (const mode of permissionModes) {
    const expected = policiesForPermissionMode(mode);
    if (permissionCategories.every((category) => (
      policies[category] === expected[category]
    ))) return mode;
  }
  return "custom";
}

export function permissionModeCopy(mode: PermissionMode, zh: boolean): {
  title: string;
  description: string;
} {
  if (mode === "request") return {
    title: zh ? "请求批准" : "Request approval",
    description: zh
      ? "编辑外部文件、使用互联网及其他有副作用的操作会先询问"
      : "Ask before external edits, internet access, and other mutating operations",
  };
  if (mode === "agent") return {
    title: zh ? "替我审批" : "Agent decides",
    description: zh
      ? "仅对检测到的风险操作请求批准"
      : "Only request approval for detected risky operations",
  };
  return {
    title: zh ? "完全访问权限" : "Full access",
    description: zh
      ? "可不受限制地访问互联网和电脑上的任何文件"
      : "Unrestricted access to the internet and any file on this computer",
  };
}
