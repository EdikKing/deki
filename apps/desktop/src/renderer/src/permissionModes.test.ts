import { describe, expect, it } from "vitest";
import { defaultSettings } from "@deki-ai/settings";
import {
  detectPermissionMode,
  permissionModes,
  policiesForPermissionMode,
} from "./permissionModes";

describe("permission modes", () => {
  it("recognizes the product default as request-approval mode", () => {
    expect(detectPermissionMode(defaultSettings.permissions.policies)).toBe("request");
  });

  it("round-trips every built-in mode", () => {
    for (const mode of permissionModes) {
      expect(detectPermissionMode(policiesForPermissionMode(mode))).toBe(mode);
    }
  });

  it("asks before mutations in request mode", () => {
    const policies = policiesForPermissionMode("request");
    expect(policies["workspace.read"]).toBe("allow");
    expect(policies["workspace.write"]).toBe("allow");
    expect(policies["workspace.delete"]).toBe("ask");
    expect(policies.network).toBe("ask");
    expect(policies.outsideWorkspace).toBe("ask");
  });

  it("only asks for detected high-risk operations in agent mode", () => {
    const policies = policiesForPermissionMode("agent");
    expect(policies["workspace.delete"]).toBe("allow");
    expect(policies["dependencies.install"]).toBe("allow");
    expect(policies["git.commit"]).toBe("allow");
    expect(policies["git.push"]).toBe("ask");
    expect(policies.sensitiveFiles).toBe("ask");
  });

  it("allows every permission category in full-access mode", () => {
    expect(new Set(Object.values(policiesForPermissionMode("full")))).toEqual(
      new Set(["allow"]),
    );
  });

  it("reports per-category overrides as custom", () => {
    const policies = policiesForPermissionMode("agent");
    policies.network = "deny";
    expect(detectPermissionMode(policies)).toBe("custom");
  });
});
