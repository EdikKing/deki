import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelConfigStore,
  SettingsConflictError,
  SettingsStore,
} from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("SettingsStore", () => {
  it("merges global, shared, local, and session settings in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-settings-"));
    directories.push(root);
    const workspace = join(root, "project");
    const store = new SettingsStore({
      globalFile: join(root, "settings.json"),
      workspace,
      projectLocalFile: join(root, "local.json"),
    });
    let snapshot = await store.initialize();
    snapshot = await store.update("global", {
      appearance: { theme: "light" },
    }, snapshot.revision);
    snapshot = await store.update("projectShared", {
      appearance: { theme: "dark" },
    }, snapshot.revision);
    await store.update("projectLocal", {
      appearance: { fontSize: 17 },
    }, snapshot.revision);
    snapshot = store.setSessionOverrides({
      appearance: { theme: "system" },
    });

    expect(snapshot.effective.appearance).toMatchObject({
      theme: "system",
      fontSize: 17,
    });
    expect(snapshot.sources["appearance.theme"]).toBe("session");
    expect(snapshot.sources["appearance.fontSize"]).toBe("projectLocal");
  });

  it("rejects stale revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-settings-conflict-"));
    directories.push(root);
    const store = new SettingsStore({ globalFile: join(root, "settings.json") });
    const original = await store.initialize();
    await store.update("global", { general: { locale: "en-US" } }, original.revision);
    await expect(store.update(
      "global",
      { general: { locale: "zh-CN" } },
      original.revision,
    )).rejects.toBeInstanceOf(SettingsConflictError);
  });
});

describe("ModelConfigStore", () => {
  it("stores API keys but only returns a redacted state", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-models-"));
    directories.push(root);
    const file = join(root, "models.json");
    const store = new ModelConfigStore(file);
    await store.upsert({
      id: "custom",
      name: "Custom",
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: { action: "set", value: "super-secret-key" },
      models: [{ id: "model-1", name: "Model 1" }],
    });

    expect(await store.list()).toEqual([expect.objectContaining({
      id: "custom",
      hasApiKey: true,
    })]);
    expect(JSON.stringify(await store.list())).not.toContain("super-secret-key");
    expect(await readFile(file, "utf8")).toContain("super-secret-key");
  });
});
