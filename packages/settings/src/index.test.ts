import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  ModelConfigStore,
  SettingsConflictError,
  SettingsStore,
} from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("SettingsStore", () => {
  it("restores the last session by default", () => {
    expect(defaultSettings.general).toMatchObject({
      startupMode: "last-session",
      restoreSession: true,
    });
  });

  it("enables bounded current-task recall by default", () => {
    expect(defaultSettings.memory).toMatchObject({
      taskMemoryEnabled: true,
      taskRecallLimit: 3,
      taskCharacterBudget: 1_200,
    });
  });

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

  it("updates and resets current-session overrides without writing a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-settings-session-"));
    directories.push(root);
    const globalFile = join(root, "settings.json");
    const store = new SettingsStore({ globalFile });
    let snapshot = await store.initialize();
    snapshot = await store.update(
      "session",
      { appearance: { fontSize: 19 }, models: { maxRetries: 0 } },
      snapshot.revision,
    );
    expect(snapshot.effective.appearance.fontSize).toBe(19);
    expect(snapshot.sources["appearance.fontSize"]).toBe("session");
    snapshot = await store.reset("session", ["appearance.fontSize"], snapshot.revision);
    expect(snapshot.effective.appearance.fontSize).toBe(defaultSettings.appearance.fontSize);
    await expect(readFile(globalFile, "utf8")).rejects.toThrow();
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
      enabled: false,
      apiKey: { action: "set", value: "super-secret-key" },
      headers: { "x-private-token": "header-secret" },
      models: [{ id: "model-1", name: "Model 1" }],
    });

    expect(await store.list()).toEqual([expect.objectContaining({
      id: "custom",
      hasApiKey: true,
      enabled: false,
    })]);
    expect(JSON.stringify(await store.list())).not.toContain("super-secret-key");
    expect(JSON.stringify(await store.list())).not.toContain("header-secret");
    expect((await store.list())[0]?.headers).toEqual({
      "x-private-token": "[REDACTED]",
    });
    expect(await readFile(file, "utf8")).toContain("super-secret-key");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    await store.upsert({
      id: "custom",
      name: "Updated",
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: { action: "keep" },
      headers: { "x-private-token": "[REDACTED]" },
      models: [{ id: "model-1", name: "Model 1" }],
    });
    expect(await readFile(file, "utf8")).toContain("header-secret");
  });

  it("fetches and normalizes a provider model catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-model-catalog-"));
    directories.push(root);
    const store = new ModelConfigStore(join(root, "models.json"));
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      data: [
        { id: "model-a", name: "Model A" },
        { id: "model-b" },
        { id: "model-a" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await store.fetchModels({
      id: "custom",
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      apiKey: { action: "set", value: "catalog-key" },
      models: [{ id: "fallback" }],
    });

    expect(models).toEqual([
      { id: "model-a", name: "Model A", input: ["text"] },
      { id: "model-b", input: ["text"] },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/v1/models");
  });

  it("preserves a corrupt models file and falls back to the last valid backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "deki-models-corrupt-"));
    directories.push(root);
    const file = join(root, "models.json");
    const store = new ModelConfigStore(file);
    await store.upsert({
      id: "first",
      apiKey: { action: "set", value: "first-key" },
      models: [{ id: "model-1" }],
    });
    await store.upsert({
      id: "second",
      apiKey: { action: "set", value: "second-key" },
      models: [{ id: "model-2" }],
    });
    await writeFile(file, "{broken", "utf8");
    const recovered = await store.list();
    expect(recovered.map((provider) => provider.id)).toEqual(["first"]);
    expect((await readdir(root)).some((entry) =>
      entry.startsWith("models.json.corrupt-"))).toBe(true);
  });
});
