import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import type { DekiDesktopApi } from "@deki-ai/shared";
import { TaskStore } from "@deki-ai/task-orchestrator";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const execFileAsync = promisify(execFile);

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("starts a general chat without a workspace", async ({}, testInfo) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-empty-"));
  await seedChineseSettings(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    expect(await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki
        .listTasks({ limit: 10 }),
    )).toEqual([]);
    expect(await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki
        .getTask("9d0cb2ad-fbeb-4307-b24b-dd4d6ea16eaf"),
    )).toBeNull();
    expect((await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getDataUsage(),
    )).tasksBytes).toBeGreaterThanOrEqual(0);
    await expect(window.getByRole("heading", { name: /开始一个普通会话|Start a general chat/ })).toBeVisible();
    const navigation = window.getByRole("navigation", { name: "项目和会话" });
    const defaultWorkspace = navigation.getByRole("button", { name: /默认工作区|Default workspace/ }).first();
    await expect(defaultWorkspace).toHaveAttribute("aria-expanded", "true");
    await expect(navigation.getByText(/新会话|New chat/)).toBeVisible();
    const sessionListFontSizes = await navigation.locator(".session-tree-item").evaluate((element) => ({
      metadata: getComputedStyle(element.querySelector("span")!).fontSize,
      title: getComputedStyle(element.querySelector("strong")!).fontSize,
    }));
    expect(sessionListFontSizes).toEqual({ metadata: "9px", title: "11px" });
    await expect(navigation.getByRole("button", { name: "添加项目" })).toBeVisible();
    await defaultWorkspace.click();
    await expect(defaultWorkspace).toHaveAttribute("aria-expanded", "false");
    await expect(navigation.getByText(/新会话|New chat/)).toHaveCount(0);
    await defaultWorkspace.click();
    await expect(defaultWorkspace).toHaveAttribute("aria-expanded", "true");
    await expect(window.getByText(/普通会话无需选择项目|General chat needs no project/)).toBeVisible();
    const composer = window.locator(".composer-card");
    await expect(composer).toBeVisible();
    const composerInput = composer.locator(".composer-input");
    await expect(composerInput).toBeVisible();
    await composerInput.focus();
    const composerFocusStyle = await composerInput.evaluate((element) => {
      const style = element.ownerDocument.defaultView!.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(composerFocusStyle).toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "0px",
      boxShadow: "none",
      outlineStyle: "none",
      outlineWidth: "0px",
    });
    await expect(composer.getByRole("button", { name: "选择模型" })).toBeVisible();
    const generalPermissionMode = composer.getByRole("button", { name: "权限模式，需要先关联项目" });
    await expect(generalPermissionMode).toBeVisible();
    await expect(generalPermissionMode).toContainText("无本地访问");
    await expect(generalPermissionMode).toBeDisabled();
    await expect(composer.getByRole("button", { name: "保存记忆" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "选择项目" })).toHaveCount(0);
    await expect(composer.getByRole("button", { name: "后台运行" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "后台运行" })).toBeDisabled();
    await expect(composer.getByRole("button", { name: "发送" })).toBeVisible();
    await expect(window.locator(".topbar").getByRole("combobox")).toHaveCount(0);
    const composerLayout = await window.evaluate(() => {
      const input = document.querySelector<HTMLElement>(".composer-input")!.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>(".composer-toolbar")!.getBoundingClientRect();
      return { inputTop: input.top, inputBottom: input.bottom, toolbarTop: toolbar.top };
    });
    expect(composerLayout.inputTop).toBeLessThan(composerLayout.toolbarTop);
    expect(composerLayout.inputBottom).toBeLessThanOrEqual(composerLayout.toolbarTop);
    const footerLayout = await window.evaluate(() => {
      const status = document.querySelector<HTMLElement>(".sidebar-status")!.getBoundingClientRect();
      const settingsButton = document.querySelector<HTMLElement>(".settings-button")!.getBoundingClientRect();
      return {
        statusLeft: status.left,
        statusCenterY: status.top + status.height / 2,
        settingsLeft: settingsButton.left,
        settingsCenterY: settingsButton.top + settingsButton.height / 2,
      };
    });
    expect(footerLayout.statusLeft).toBeLessThan(footerLayout.settingsLeft);
    expect(Math.abs(footerLayout.statusCenterY - footerLayout.settingsCenterY)).toBeLessThanOrEqual(1);
    await window.getByTestId("open-task-center").click();
    await expect(window.getByTestId("task-center")).toBeVisible();
    await expect(window.getByRole("heading", { name: "后台任务" })).toBeVisible();
    await expect(window.getByText("没有符合条件的任务")).toBeVisible();
    await window.screenshot({
      path: testInfo.outputPath("deki-task-center-empty.png"),
      fullPage: true,
    });
    await defaultWorkspace.click();
    await expect(window.getByTestId("task-center")).toHaveCount(0);
    await window.getByTestId("open-settings").click();
    await expect(window.getByTestId("settings-page")).toBeVisible();
    await expect(window.getByRole("heading", { name: /通用|General/ })).toBeVisible();
    const scope = window.locator(".scope-picker select");
    await expect(scope.locator("option[value=session]")).toHaveCount(1);
    await expect(scope.locator("option[value=projectShared]")).toBeDisabled();
    await window.getByTestId("settings-section-appearance").click();
    await window.locator(".setting-row").filter({ has: window.locator("select option[value=light]") }).getByRole("combobox").selectOption("light");
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(window.locator(".settings-page")).toHaveCSS("color", "rgb(32, 36, 42)");
    await expect(window.locator(".settings-nav")).toHaveCSS("background-color", "rgb(243, 244, 246)");
    await expect(window.getByRole("button", { name: "恢复本分类" })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await window.locator(".settings-search").fill("证书");
    await expect(window.getByRole("heading", { name: "高级与诊断" })).toBeVisible();
    await expect(window.getByText("自定义 CA 证书")).toBeVisible();
    await expect(window.locator(".setting-control select:not([aria-label])")).toHaveCount(0);
    await window.locator(".settings-search").fill("");
    await window.getByTestId("settings-section-models").click();
    await expect(window.getByRole("heading", { name: "模型供应商" })).toBeVisible();
    await expect(window.locator(".builtin-provider-card")).toHaveCount(0);
    await expect(window.getByText("尚未添加模型供应商")).toBeVisible();
    await window.getByRole("button", { name: "添加模型供应商" }).click();
    const providerFlow = window.getByTestId("provider-add-flow");
    await expect(providerFlow).toBeVisible();
    const providerType = providerFlow.getByRole("combobox", { name: "供应商类型" });
    await expect(providerType.locator("option")).toHaveCount(10);
    await providerType.selectOption("openai");
    await expect(providerFlow.locator(".provider-manager")).toHaveCount(1);
    await expect(providerFlow.locator(".provider-manager")).toHaveAttribute("data-provider-id", "openai");
    await expect(providerFlow.locator("input[type=password]")).toHaveCount(1);
    await expect(providerFlow.getByRole("heading", { name: "基本信息" })).toBeVisible();
    await expect(providerFlow.getByRole("heading", { name: "已启用模型" })).toBeVisible();
    await expect(providerFlow.getByRole("heading", { name: "可用模型" })).toBeVisible();
    await expect(providerFlow.getByRole("button", { name: "从供应商获取" })).toBeVisible();
    await expect(providerFlow.getByRole("checkbox", { name: "启用此渠道" })).toBeChecked();
    await providerFlow.getByRole("button", { name: "返回供应商列表" }).click();
    await expect(window.locator(".builtin-provider-card")).toHaveCount(0);
    await window.screenshot({
      path: testInfo.outputPath("deki-empty-workspace.png"),
      fullPage: true,
    });
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("shows Plan progress and previews persisted artifacts inside Task Center", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-task-plan-"));
  await seedChineseSettings(temporaryHome);
  await seedTaskPlanFixture(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByTestId("open-task-center").click();
    await expect(window.getByRole("heading", { name: "后台任务" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "需要处理" })).toBeVisible();
    const row = window.locator(".task-row").filter({ hasText: "审阅计划 Fixture" });
    await expect(row).toContainText("规划");
    await expect(row).toContainText("Plan v1");
    await row.click();
    await expect(window.getByText("计划进度")).toBeVisible();
    await expect(window.locator(".task-plan-context")).toContainText("0/1");
    await window.getByRole("button", { name: /Fixture Diff/ }).click();
    const preview = window.getByRole("dialog", { name: "Fixture Diff" });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("+fixture");
    await preview.getByRole("button", { name: "关闭预览" }).click();
    await expect(preview).toHaveCount(0);

    const queuedRow = window.locator(".task-row").filter({ hasText: "后台暂停 Fixture" });
    await queuedRow.click();
    await window.locator(".task-detail-actions").getByRole("button", { name: "暂停" }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("已暂停");
    await window.locator(".task-detail-actions").getByRole("button", { name: "恢复" }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("排队中");
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("runs a real Plan revision and replan flow through an OpenAI-compatible fixture", async ({}) => {
  test.setTimeout(60_000);
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-plan-flow-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-plan-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome);
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "README.md"), "fixture workspace\n");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "README.md"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const beforeStatus = await gitWorkspaceSnapshot(workspace);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(
      temporaryHome,
      "--workspace",
      workspace,
    ),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    const composer = window.locator(".composer-card");
    await expect(composer.getByRole("button", { name: "选择模型" })).toContainText(
      "Fixture Model",
    );
    await composer.getByRole("group", { name: "交互模式" })
      .getByRole("button", { name: "规划" }).click();
    await composer.locator(".composer-input").fill("创建一个会触发重新规划的单步骤计划");
    await composer.getByRole("button", { name: "生成计划", exact: true }).click();

    const panel = window.getByTestId("plan-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "批准并执行" }))
      .toBeEnabled({ timeout: 15_000 });
    await panel.getByRole("button", { name: "批准并执行" }).click();

    await expect(panel).toContainText("计划 v2", { timeout: 15_000 });
    expect(modelServer.userPrompts.some((prompt) =>
      prompt.includes("Fixture assumption changed")
      && prompt.includes("fixture-evidence")
      && prompt.includes("inspect"))).toBe(true);
    await expect(panel.getByRole("button", { name: "批准并执行" }))
      .toBeEnabled({ timeout: 15_000 });

    await panel.getByRole("button", { name: "批准并执行" }).click();
    await expect(panel).toContainText("已完成", { timeout: 15_000 });
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(beforeStatus);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("runs a budgeted DAG with mandatory Reviewer and Integrator gates", async ({}) => {
  test.setTimeout(90_000);
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-dag-home-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-dag-workspace-"));
  const modelServer = await startFixtureModelServer();
  const route = ["fixture/fixture-model"];
  await seedChineseSettings(temporaryHome, {
    agent: {
      maxConcurrentRuns: 3,
      dagExecutionEnabled: true,
      planMaxConcurrentSteps: 2,
      planMaxDurationMs: 300_000,
      planMaxInputTokens: 100_000,
      planMaxOutputTokens: 20_000,
      planMaxToolCalls: 100,
      planModelRoutes: {
        coordinator: route,
        explorer: route,
        implementer: route,
        tester: route,
        reviewer: route,
        integrator: route,
      },
    },
  });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "dag-fixture",
    private: true,
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    const composer = window.locator(".composer-card");
    await composer.getByRole("group", { name: "交互模式" })
      .getByRole("button", { name: "规划" }).click();
    await composer.locator(".composer-input").fill("DAG 发布收尾验收");
    await composer.getByRole("button", { name: "生成计划", exact: true }).click();
    const panel = window.getByTestId("plan-panel");
    await expect(panel.getByRole("button", { name: "批准并执行" }))
      .toBeEnabled({ timeout: 20_000 });
    await panel.getByRole("button", { name: "批准并执行" }).click();
    await expect(panel.getByText("DAG 执行图")).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText("5/5", { timeout: 45_000 });
    await expect(readFile(join(workspace, "alpha.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "beta.txt"), "utf8")).rejects.toThrow();

    const result = await window.evaluate(async () => {
      const api = (globalThis as unknown as { deki: DekiDesktopApi }).deki;
      const root = (await api.listTasks({ limit: 100 }))
        .find((summary) => summary.task.kind === "plan-execution");
      const detail = root ? await api.getTask(root.task.id) : null;
      const plan = (await api.listPlans({ limit: 20 }))[0];
      const planDetail = plan ? await api.getPlan(plan.plan.id) : null;
      const request = detail?.requests.find((candidate) => candidate.status === "pending");
      if (!root || !detail || !request) return { ok: false, detail, planDetail };
      const decision = await api.respondToIntegration(root.task.id, request.id, "apply");
      return { ok: decision.ok, detail, planDetail };
    });
    expect(result.ok).toBe(true);
    expect(result.detail?.children.filter((child) =>
      child.task.assignedProfile === "reviewer")).toHaveLength(2);
    expect(result.detail?.children.filter((child) =>
      child.task.assignedProfile === "integrator")).toHaveLength(1);
    expect(result.planDetail?.executionGraph?.usage.inputTokens ?? 0)
      .toBeLessThanOrEqual(100_000);
    expect(modelServer.maxWorkerConcurrency).toBeGreaterThanOrEqual(2);
    await expect.poll(() => readFile(join(workspace, "alpha.txt"), "utf8"))
      .toContain("alpha implemented");
    expect(await readFile(join(workspace, "beta.txt"), "utf8"))
      .toContain("beta implemented");
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("runs two real read-only Workers and renders their Agent Tree", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-worker-flow-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-worker-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "README.md"), "worker fixture\n");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "README.md"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const beforeStatus = await gitWorkspaceSnapshot(workspace);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试多 Agent 只读调查",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row").filter({ hasText: "测试多 Agent 只读调查" });
    await expect(row).toContainText("2/2", { timeout: 20_000 });
    await row.click();
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 20_000,
    });
    const tree = window.getByRole("heading", { name: "Agent Tree" }).locator("..");
    await expect(tree).toContainText("explorer");
    await expect(tree).toContainText("reviewer");
    await tree.getByRole("button", { name: /explorer/ }).click();
    await expect(window.getByText("Fixture Explorer finding").first()).toBeVisible();
    await row.click();
    await tree.getByRole("button", { name: /reviewer/ }).click();
    await expect(window.getByText("Fixture Reviewer finding").first()).toBeVisible();

    const detail = await window.evaluate(async () => {
      const api = (globalThis as unknown as { deki: DekiDesktopApi }).deki;
      const summary = (await api.listTasks({
        query: "测试多 Agent 只读调查",
        limit: 10,
      })).find((candidate) => candidate.task.kind === "background");
      return summary ? api.getTask(summary.task.id) : null;
    });
    expect(detail?.children).toHaveLength(2);
    expect(detail?.children.every((child) => child.task.kind === "worker")).toBe(true);
    expect(modelServer.maxWorkerConcurrency).toBeGreaterThanOrEqual(2);
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(beforeStatus);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("keeps M4 read-only Worker behavior in a non-Git workspace", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-nongit-home-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-nongit-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "README.md"), "non-git worker fixture\n");
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试多 Agent 只读调查",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row").filter({ hasText: "测试多 Agent 只读调查" });
    await expect(row).toContainText("2/2", { timeout: 20_000 });
    await row.click();
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 20_000,
    });
    const detail = await window.evaluate(async () => {
      const api = (globalThis as unknown as { deki: DekiDesktopApi }).deki;
      const summary = (await api.listTasks({
        query: "测试多 Agent 只读调查",
        limit: 10,
      })).find((candidate) => candidate.task.kind === "background");
      return summary ? api.getTask(summary.task.id) : null;
    });
    expect(detail?.children).toHaveLength(2);
    expect(detail?.children.every((child) => child.task.kind === "worker")).toBe(true);
    expect(await readFile(join(workspace, "README.md"), "utf8"))
      .toBe("non-git worker fixture\n");
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("runs two isolated Implementers and applies only after final approval", async ({}) => {
  test.setTimeout(60_000);
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-implementer-flow-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-implementer-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "implementer-fixture",
    private: true,
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  await writeFile(join(workspace, "base.txt"), "base\n");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  await writeFile(join(workspace, "dirty.txt"), "user dirty baseline\n");
  await execFileAsync("git", ["add", "dirty.txt"], { cwd: workspace });
  const before = await gitWorkspaceSnapshot(workspace);
  const beforeHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout;
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试隔离 Implementer 最终审批",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row").filter({ hasText: "测试隔离 Implementer 最终审批" });
    await expect(row).toContainText("等待应用", { timeout: 30_000 });
    await expect(readFile(join(workspace, "alpha.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(workspace, "beta.txt"), "utf8")).rejects.toThrow();
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(before);
    await row.click();
    await expect(window.getByText("集成状态")).toBeVisible();
    await expect(window.getByText("awaiting_apply", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "应用到工作区" }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 20_000,
    });
    expect(await readFile(join(workspace, "alpha.txt"), "utf8").then((value) => value.trim()))
      .toBe("alpha implemented");
    expect(await readFile(join(workspace, "beta.txt"), "utf8").then((value) => value.trim()))
      .toBe("beta implemented");
    const after = await gitWorkspaceSnapshot(workspace);
    expect(after.staged).toBe(before.staged);
    expect((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout)
      .toBe(beforeHead);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("keeps failed integration artifacts and retries validation from its commit", async ({}) => {
  test.setTimeout(60_000);
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-retry-home-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-retry-workspace-"));
  const validationMarker = join(temporaryHome, "allow-integration-validation");
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "validate.cjs"), [
    "const fs = require('node:fs');",
    "const both = fs.existsSync('alpha.txt') && fs.existsSync('beta.txt');",
    `process.exit(both && !fs.existsSync(${JSON.stringify(validationMarker)}) ? 1 : 0);`,
    "",
  ].join("\n"));
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "integration-retry-fixture",
    private: true,
    scripts: { test: "node validate.cjs" },
  }));
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const before = await gitWorkspaceSnapshot(workspace);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试集成验证失败重试",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row").filter({ hasText: "测试集成验证失败重试" });
    await expect(row).toContainText("失败", { timeout: 30_000 });
    await row.click();
    await expect(window.getByText("failed", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "应用到工作区" })).toHaveCount(0);
    const detail = await window.evaluate(async () => {
      const api = (globalThis as unknown as { deki: DekiDesktopApi }).deki;
      const summary = (await api.listTasks({
        query: "测试集成验证失败重试",
        limit: 10,
      })).find((candidate) => candidate.task.kind === "background");
      return summary ? api.getTask(summary.task.id) : null;
    });
    expect(detail?.integration).toMatchObject({
      status: "failed",
      integrationCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      patchArtifactId: expect.any(String),
      diffArtifactId: expect.any(String),
      commitArtifactId: expect.any(String),
    });
    expect(detail?.children.some((child) =>
      child.task.kind === "integration"
      && child.task.assignedProfile === "integration-runner")).toBe(true);
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(before);

    await writeFile(validationMarker, "allow\n");
    await window.getByRole("button", { name: "重试", exact: true }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("等待应用", {
      timeout: 20_000,
    });
    await expect(window.getByText("awaiting_apply", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "应用到工作区" })).toBeVisible();
    await window.getByRole("button", { name: "仅保留产物" }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 20_000,
    });
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(before);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("serializes predicted overlap and runs a read-only Integrator review", async ({}) => {
  test.setTimeout(60_000);
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-overlap-flow-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-overlap-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "overlap-fixture",
    private: true,
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  await writeFile(join(workspace, "overlap.txt"), "base\n");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const before = await gitWorkspaceSnapshot(workspace);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试预测重叠和 Integrator 审查",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row")
      .filter({ hasText: "测试预测重叠和 Integrator 审查" });
    await expect(row).toContainText("等待应用", { timeout: 30_000 });
    expect(await readFile(join(workspace, "overlap.txt"), "utf8")).toBe("base\n");
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(before);
    await row.click();
    await expect(window.getByText(/1 Integrator/)).toBeVisible();
    await expect(window.getByText(/overlap\.txt/).first()).toBeVisible();
    await window.getByRole("button", { name: "仅保留产物" }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 20_000,
    });
    expect(await readFile(join(workspace, "overlap.txt"), "utf8")).toBe("base\n");
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("pauses exclusive real overlap without silently choosing a result", async ({}) => {
  test.setTimeout(60_000);
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-conflict-home-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-conflict-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "exclusive-conflict-fixture",
    private: true,
    scripts: { test: "node -e \"process.exit(0)\"" },
  }));
  await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const before = await gitWorkspaceSnapshot(workspace);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试 exclusive 重叠安全暂停",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row").filter({ hasText: "测试 exclusive 重叠安全暂停" });
    await expect(row).toContainText("已暂停", { timeout: 30_000 });
    await row.click();
    await expect(window.getByText(/paused ·/)).toBeVisible();
    await expect(window.getByText(/exclusive 写入范围存在真实文件重叠/)).toBeVisible();
    await expect(window.getByRole("button", { name: "应用到工作区" })).toHaveCount(0);
    const detail = await window.evaluate(async () => {
      const api = (globalThis as unknown as { deki: DekiDesktopApi }).deki;
      const summary = (await api.listTasks({
        query: "测试 exclusive 重叠安全暂停",
        limit: 10,
      })).find((candidate) => candidate.task.kind === "background");
      return summary ? api.getTask(summary.task.id) : null;
    });
    expect(detail?.integration).toMatchObject({
      status: "paused",
      conflictFiles: ["pnpm-lock.yaml"],
      commitArtifactId: expect.any(String),
    });
    expect(detail?.integration?.conflictArtifactIds.length).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(workspace, "pnpm-lock.yaml"), "utf8"))
      .toBe("lockfileVersion: '9.0'\n");
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(before);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("runs Tester only in a temporary snapshot and persists its log Artifact", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-tester-flow-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-tester-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome, { agent: { maxConcurrentRuns: 2 } });
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "tester-fixture",
    private: true,
    scripts: {
      test: "node -e \"require('fs').writeFileSync('tester-output.txt','copy only'); console.log('tester ok')\"",
    },
  }));
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["add", "package.json"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=deki@example.com",
    "commit", "-m", "fixture",
  ], { cwd: workspace });
  const beforeStatus = await gitWorkspaceSnapshot(workspace);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(
      window.locator(".composer-card").getByRole("button", { name: "选择模型" }),
    ).toContainText("Fixture Model");
    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试 Tester Worker 临时副本",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok, JSON.stringify(submission)).toBe(true);
    await window.getByTestId("open-task-center").click();
    const row = window.locator(".task-row").filter({ hasText: "测试 Tester Worker 临时副本" });
    await expect(row).toContainText("1/1", { timeout: 20_000 });
    await row.click();
    await window.getByRole("heading", { name: "Agent Tree" }).locator("..")
      .getByRole("button", { name: /tester/ }).click();
    await expect(window.getByText("Fixture Tester finding").first()).toBeVisible();
    await window.getByRole("button", { name: /Tester: test/ }).click();
    const preview = window.getByRole("dialog", { name: "Tester: test" });
    await expect(preview).toContainText("tester ok");
    await expect(readFile(join(workspace, "tester-output.txt"), "utf8")).rejects.toThrow();
    expect(await gitWorkspaceSnapshot(workspace)).toEqual(beforeStatus);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("resumes real background approval and user-input tasks", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-waiting-flow-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-waiting-workspace-"));
  const modelServer = await startFixtureModelServer();
  await seedChineseSettings(temporaryHome);
  await seedFixtureModel(temporaryHome, modelServer.baseUrl);
  await writeFile(join(workspace, "approval-target.txt"), "delete after approval\n");
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    const composer = window.locator(".composer-card");
    await composer.locator(".composer-input").fill("测试后台审批");
    await composer.getByRole("button", { name: "后台运行" }).click();
    await window.getByTestId("open-task-center").click();
    const approvalRow = window.locator(".task-row").filter({ hasText: "测试后台审批" });
    await expect(approvalRow).toContainText("等待审批", { timeout: 15_000 });
    await approvalRow.click();
    const approvalResult = await window.evaluate(async () => {
      const api = (globalThis as unknown as { deki: DekiDesktopApi }).deki;
      const summary = (await api.listTasks({ query: "测试后台审批", limit: 10 }))[0];
      const detail = summary ? await api.getTask(summary.task.id) : null;
      const request = detail?.requests.find((candidate) =>
        candidate.kind === "approval" && candidate.status === "pending");
      return request
        ? api.respondToApproval(request.id, "allow_once", detail!.task.id)
        : { ok: false, error: "missing approval request" };
    });
    expect(approvalResult).toEqual({ ok: true });
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 15_000,
    });
    await expect(readFile(join(workspace, "approval-target.txt"), "utf8")).rejects.toThrow();

    const submission = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.sendPrompt(
        "测试后台输入",
        { mode: "background", interactionMode: "act" },
      ),
    );
    expect(submission.ok).toBe(true);
    const inputRow = window.locator(".task-row").filter({ hasText: "测试后台输入" });
    await expect(inputRow).toContainText("等待输入", { timeout: 15_000 });
    await inputRow.click();
    await window.getByPlaceholder("输入回答").fill("fixture-answer");
    await window.getByRole("button", { name: "提交回答" }).click();
    await expect(window.locator(".task-status-pill")).toHaveText("已完成", {
      timeout: 15_000,
    });
    expect(modelServer.userPrompts.some((prompt) =>
      prompt.includes("测试后台输入"))).toBe(true);
  } finally {
    await electronApp.close();
    await modelServer.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("groups and searches models in the composer picker", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-model-picker-"));
  await seedChineseSettings(temporaryHome);
  await seedComposerModels(temporaryHome);
  const firstSessionId = "00000000-0000-4000-8000-000000000001";
  const secondSessionId = "00000000-0000-4000-8000-000000000002";
  await seedPersistedSession(temporaryHome, undefined, firstSessionId, "2026-07-27T10:00:00.000Z");
  await seedPersistedSession(temporaryHome, undefined, secondSessionId, "2026-07-27T10:01:00.000Z");
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    expect(await window.evaluate(
      (sessionId) => (globalThis as unknown as { deki: DekiDesktopApi }).deki.switchSession(sessionId),
      firstSessionId,
    ))
      .toEqual({ ok: true });
    const trigger = window.locator(".composer-model-trigger");
    await expect(trigger.locator(".composer-model-name")).toHaveText("Alpha Chat");
    await trigger.click();
    const picker = window.getByRole("dialog", { name: "选择模型" });
    await expect(picker).toBeVisible();
    await expect(picker.getByText("alpha", { exact: true })).toBeVisible();
    await expect(picker.getByText("beta", { exact: true })).toBeVisible();
    await picker.getByRole("textbox", { name: "搜索模型" }).fill("Beta Code");
    await expect(picker.getByRole("option")).toHaveCount(1);
    await picker.getByRole("option", { name: "Beta Code" }).click();
    await expect(trigger.locator(".composer-model-name")).toHaveText("Beta Code");
    await expect(picker).not.toBeVisible();

    expect(await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki
        .updateSessionConfiguration({ thinkingLevel: "high" }),
    )).toEqual({ ok: true });
    const firstSession = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(firstSession.selectedModel?.name).toBe("Beta Code");
    expect(firstSession.sessionConfiguration?.thinkingLevel).toBe("high");

    expect(await window.evaluate(
      (sessionId) => (globalThis as unknown as { deki: DekiDesktopApi }).deki.switchSession(sessionId),
      secondSessionId,
    ))
      .toEqual({ ok: true });
    const secondSession = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(secondSession.sessionId).not.toBe(firstSession.sessionId);
    expect(secondSession.selectedModel?.name).toBe("Alpha Chat");
    expect(secondSession.sessionConfiguration?.thinkingLevel).toBe("medium");

    expect(await window.evaluate(
      (sessionId) => (globalThis as unknown as { deki: DekiDesktopApi }).deki.switchSession(sessionId),
      firstSession.sessionId!,
    ))
      .toEqual({ ok: true });
    const restoredSession = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(restoredSession.selectedModel?.name).toBe("Beta Code");
    expect(restoredSession.sessionConfiguration?.thinkingLevel).toBe("high");
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("keeps permission mode on the chat where it was selected", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-session-permissions-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-session-workspace-"));
  await seedChineseSettings(temporaryHome);
  await seedComposerModels(temporaryHome);
  const firstSessionId = "00000000-0000-4000-8000-000000000011";
  const secondSessionId = "00000000-0000-4000-8000-000000000012";
  await seedPersistedSession(temporaryHome, workspace, firstSessionId, "2026-07-27T11:00:00.000Z");
  await seedPersistedSession(temporaryHome, workspace, secondSessionId, "2026-07-27T11:01:00.000Z");
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: "信任并继续" }).click();
    const permissionTrigger = window.getByRole("button", { name: "选择权限模式" });
    await expect(permissionTrigger).toBeEnabled();
    expect(await window.evaluate(
      (sessionId) => (globalThis as unknown as { deki: DekiDesktopApi }).deki.switchSession(sessionId),
      firstSessionId,
    ))
      .toEqual({ ok: true });
    await permissionTrigger.click();
    await window.getByRole("listbox", { name: "权限模式" })
      .getByRole("option", { name: /完全访问权限/ })
      .click();
    await expect(permissionTrigger).toContainText("完全访问权限");

    const firstSession = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(Object.values(
      firstSession.sessionConfiguration!.permissionPolicies,
    ).every((policy) => policy === "allow")).toBe(true);

    expect(await window.evaluate(
      (sessionId) => (globalThis as unknown as { deki: DekiDesktopApi }).deki.switchSession(sessionId),
      secondSessionId,
    ))
      .toEqual({ ok: true });
    const secondSession = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(secondSession.sessionId).not.toBe(firstSession.sessionId);
    expect(secondSession.sessionConfiguration?.permissionPolicies["workspace.delete"]).toBe("ask");

    expect(await window.evaluate(
      (sessionId) => (globalThis as unknown as { deki: DekiDesktopApi }).deki.switchSession(sessionId),
      firstSession.sessionId!,
    ))
      .toEqual({ ok: true });
    const restoredSession = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(Object.values(
      restoredSession.sessionConfiguration!.permissionPolicies,
    ).every((policy) => policy === "allow")).toBe(true);
    await expect(window.locator(".inline-error")).toHaveCount(0);
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("keeps the composer visible when a conversation exceeds the viewport", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-overflow-"));
  await seedChineseSettings(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    const messages = window.locator(".messages");
    await messages.evaluate((element) => {
      for (let index = 0; index < 24; index += 1) {
        const message = document.createElement("article");
        message.className = "message assistant";
        message.innerHTML = `<span>Deki</span><div>Long response line ${index}</div>`;
        element.append(message);
      }
    });

    const layout = await window.evaluate(() => {
      const messageList = document.querySelector<HTMLElement>(".messages")!;
      const composer = document.querySelector<HTMLElement>(".composer")!;
      const chatPanel = document.querySelector<HTMLElement>(".chat-panel")!;
      const composerRect = composer.getBoundingClientRect();
      const chatRect = chatPanel.getBoundingClientRect();
      return {
        messageClientHeight: messageList.clientHeight,
        messageScrollHeight: messageList.scrollHeight,
        composerTop: composerRect.top,
        composerBottom: composerRect.bottom,
        chatBottom: chatRect.bottom,
        viewportHeight: globalThis.innerHeight,
      };
    });

    expect(layout.messageScrollHeight).toBeGreaterThan(layout.messageClientHeight);
    expect(layout.composerTop).toBeGreaterThan(0);
    expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.chatBottom).toBeLessThanOrEqual(layout.viewportHeight);
    await expect(window.locator(".composer textarea")).toBeInViewport();
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("stores and manages memory for the current task", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-task-memory-"));
  await seedChineseSettings(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome),
    env: {
      ...createTestEnvironment(temporaryHome),
      OPENAI_API_KEY: "sk-test-only-not-persisted",
    },
  });

  try {
    const window = await electronApp.firstWindow();
    const taskMemoryText = "仅用于当前 Electron 冒烟任务";
    await expect(window.locator("textarea")).toBeEnabled();
    await window.locator("textarea").fill(`/remember --task ${taskMemoryText}`);
    await window.getByRole("button", { name: "发送" }).click();
    await window.getByTestId("open-settings").click();
    await window.getByTestId("settings-section-memory").click();
    const memoryScope = window.locator(".settings-subsection select");
    await expect(memoryScope.locator("option[value=task]")).toHaveText("当前任务");
    await memoryScope.selectOption("task");
    await expect(window.locator(".provider-card", { hasText: taskMemoryText })).toBeVisible();
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("can leave an untrusted workspace for a general chat", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-untrusted-"));
  await seedChineseSettings(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(
      temporaryHome,
      "--workspace",
      resolve("tests/fixtures/workspace"),
    ),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: "返回普通会话" }).click();
    await expect(window.getByRole("heading", { name: "开始一个普通会话" })).toBeVisible();
    await expect(window.getByRole("button", { name: "默认工作区" }).first()).toHaveAttribute("aria-expanded", "true");
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("automatically trusts a workspace selected from Add project", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-auto-trust-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-selected-workspace-"));
  await seedChineseSettings(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    await electronApp.evaluate(({ dialog }, selectedWorkspace) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedWorkspace],
      });
    }, workspace);
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: "添加项目" }).click();
    await expect(window.getByRole("heading", { name: "从理解项目开始" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "信任这个工作区？" })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "选择权限模式" })).toBeDisabled();
    const selectedWorkspace = await window.evaluate(
      () => (globalThis as unknown as { deki: DekiDesktopApi }).deki.getBootstrapState(),
    );
    expect(selectedWorkspace.workspace).toBe(await realpath(workspace));

    const config = JSON.parse(
      await readFile(join(temporaryHome, ".deki", "config.json"), "utf8"),
    ) as { trustedWorkspaces: Record<string, unknown> };
    expect(config.trustedWorkspaces[await realpath(workspace)]).toBeDefined();
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("trusts a workspace, streams fixture events, and recalls memory", async ({}, testInfo) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-home-"));
  await seedChineseSettings(temporaryHome);

  const launch = (fixtureEvents = false) => electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(
      temporaryHome,
      "--workspace",
      resolve("tests/fixtures/workspace"),
      ...(fixtureEvents ? ["--e2e-fixture-events"] : []),
    ),
    env: createTestEnvironment(temporaryHome),
  });

  let electronApp: ElectronApplication | undefined;
  try {
    electronApp = await launch(true);
    const window = await electronApp.firstWindow();
    await expect(window.getByRole("heading", { name: /信任这个工作区|Trust this workspace/ })).toBeVisible();
    await expect(window.locator(".workspace-path")).toContainText("tests/fixtures/workspace");
    const longMessageStyle = await window.addStyleTag({
      content: ".message-turn { min-height: 1200px; }",
    });

    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(window.getByText(/需要云模型凭据|Cloud credentials required/)).toBeVisible();
    await expect(window.getByText(/本地 AI 开发工作台|Local AI development workspace/)).toBeVisible();
    const navigation = window.getByRole("navigation", { name: "项目和会话" });
    await expect(navigation.getByText("项目", { exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "workspace" }).first()).toHaveAttribute("aria-expanded", "true");
    await expect(navigation.getByRole("button", { name: "在workspace中新建会话" })).toBeVisible();
    await expect(window.locator(".status-line", { hasText: "Skills" })).toContainText(
      "test-skill",
    );
    const inspectorDivider = await window.evaluate(() => {
      const chat = getComputedStyle(document.querySelector<HTMLElement>(".chat-panel")!);
      const inspector = getComputedStyle(document.querySelector<HTMLElement>(".side-panel")!);
      return {
        chatBorder: chat.borderRightWidth,
        inspectorBorder: inspector.borderLeftWidth,
      };
    });
    expect(inspectorDivider).toEqual({
      chatBorder: "0px",
      inspectorBorder: "1px",
    });
    await expect(window.getByText("这是模拟的流式响应。")).toBeVisible();
    const conversationFontSizes = await window.locator(".message-turn").evaluate((element) => ({
      body: getComputedStyle(element.querySelector(".message-body")!).fontSize,
      reasoning: getComputedStyle(element.querySelector(".reasoning-content")!).fontSize,
      reasoningSummary: getComputedStyle(element.querySelector(".message-reasoning > summary")!).fontSize,
      sender: getComputedStyle(element.querySelector(".message-sender strong")!).fontSize,
    }));
    expect(conversationFontSizes).toEqual({
      body: "13px",
      reasoning: "11px",
      reasoningSummary: "11px",
      sender: "13px",
    });
    await expect.poll(() => window.locator(".messages").evaluate((element) => ({
      atBottom: Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
      scrollable: element.scrollHeight > element.clientHeight,
    }))).toEqual({ atBottom: true, scrollable: true });
    await longMessageStyle.evaluate((element) => {
      element.parentNode?.removeChild(element);
    });
    const messageLayout = await window.evaluate(() => {
      const region = document.querySelector<HTMLElement>(".messages")!.getBoundingClientRect();
      const turn = document.querySelector<HTMLElement>(".message-turn")!.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>(".composer-card")!.getBoundingClientRect();
      return {
        leftGap: turn.left - region.left,
        rightGap: region.right - turn.right,
        composerLeft: composer.left,
        composerRight: composer.right,
        turnLeft: turn.left,
        turnRight: turn.right,
      };
    });
    expect(Math.abs(messageLayout.leftGap - messageLayout.rightGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(messageLayout.turnLeft - messageLayout.composerLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(messageLayout.turnRight - messageLayout.composerRight)).toBeLessThanOrEqual(1);
    const copyMessage = window.getByRole("button", { name: "复制消息" }).first();
    await expect(copyMessage.locator(".copy-message-icon")).toHaveCount(1);
    await expect(copyMessage).toHaveText("");
    const reasoning = window.locator(".message-reasoning");
    await expect(reasoning).not.toHaveAttribute("open", "");
    await expect(reasoning.locator(".reasoning-content")).not.toBeVisible();
    await reasoning.locator("summary").click();
    await expect(reasoning.locator(".reasoning-content")).toContainText(
      "先检查用户目标，再确认当前运行状态。",
    );
    await expect(window.locator(".message-sender strong", { hasText: "deepseek-v4-flash" })).toBeVisible();
    await expect(window.locator(".messages .tool-card")).toHaveCount(0);
    const inspectorTool = window.locator(".side-panel .tool-card").first();
    await expect(inspectorTool.locator("summary strong")).toHaveText(
      "deki__project_info",
    );
    await inspectorTool.getByText("完成").click();
    await expect(inspectorTool.locator(".tool-payload", { hasText: "结果" })).toContainText("fixture");
    await expect(window.locator(".code-block code")).toContainText("const ready = true;");
    await expect(window.getByRole("button", { name: "复制代码" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "变更 Diff" })).toBeVisible();
    await expect(window.locator(".diff-entry pre")).toContainText("+++ b/example.txt");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 720));
    await window.waitForTimeout(200);
    await expect(window.getByTestId("toggle-inspector")).toBeVisible();
    await expect(window.locator(".side-panel")).not.toHaveClass(/open/);
    await window.getByTestId("toggle-inspector").click();
    await expect(window.locator(".side-panel")).toHaveClass(/open/);
    await window.getByTestId("toggle-inspector").click();
    await expect(window.locator(".side-panel")).not.toHaveClass(/open/);

    const permissionTrigger = window.getByRole("button", { name: "选择权限模式" });
    await expect(permissionTrigger).toContainText("请求批准");
    await expect(permissionTrigger).toBeDisabled();

    await window.getByTestId("open-settings").click();
    await window.getByTestId("settings-section-mcp").click();
    const mcpCard = window.locator(".mcp-server-card", { hasText: "fixture" });
    await expect(mcpCard).toContainText("ready");
    await mcpCard.getByRole("button", { name: "Tools" }).click();
    await expect(mcpCard.getByText("echo", { exact: true })).toBeVisible();
    await expect(mcpCard.locator(".mcp-tool-rule", { hasText: "echo" })).toContainText("read-only");
    await window.getByTestId("settings-section-skills").click();
    const skillCard = window.locator(".skill-card", { hasText: "test-skill" });
    await expect(skillCard).toContainText("valid");
    await window.getByRole("button", { name: "返回" }).click();

    const memoryText = "Electron 冒烟测试记忆";
    await window.locator("textarea").fill(`/remember ${memoryText}`);
    await window.getByRole("button", { name: "发送" }).click();
    await expect(window.getByText(memoryText).first()).toBeVisible();

    await electronApp.close();
    electronApp = await launch();
    const recalledWindow = await electronApp.firstWindow();
    await expect(recalledWindow.getByText(/需要云模型凭据|Cloud credentials required/)).toBeVisible();
    const recalledPanel = recalledWindow.locator(".panel-section", {
      has: recalledWindow.getByRole("heading", { name: "本轮使用的记忆" }),
    });
    await expect(recalledPanel.getByText(memoryText)).toBeVisible();
    await recalledWindow.screenshot({
      path: testInfo.outputPath("deki-recalled-memory.png"),
      fullPage: true,
    });
  } finally {
    await electronApp?.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("creates and previews a branch-neutral Git checkpoint", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-checkpoint-home-"));
  const workspace = await mkdtemp(resolve(tmpdir(), "deki-electron-checkpoint-workspace-"));
  await seedChineseSettings(temporaryHome);
  await execFileAsync("git", ["init"], { cwd: workspace });
  await writeFile(join(workspace, "example.txt"), "before\n", "utf8");
  await execFileAsync("git", ["add", "example.txt"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Deki Test",
    "-c", "user.email=test@deki.local",
    "commit", "-m", "initial",
  ], { cwd: workspace });
  const initialHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout;
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: createElectronArguments(temporaryHome, "--workspace", workspace),
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await window.getByTestId("open-settings").click();
    await window.getByTestId("settings-section-workspace").click();
    await window.getByRole("button", { name: "立即创建" }).click();
    await expect(window.getByText("Checkpoint 已创建")).toBeVisible();
    await expect(window.locator(".provider-card", { hasText: "手动 Checkpoint" })).toHaveCount(1);

    await writeFile(join(workspace, "example.txt"), "after\n", "utf8");
    await window.getByRole("button", { name: "查看差异" }).click();
    await expect(window.locator(".checkpoint-diff")).toContainText("+after");
    expect((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout)
      .toBe(initialHead);
    expect((await execFileAsync("git", ["diff", "--cached"], { cwd: workspace })).stdout)
      .toBe("");
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

function createElectronArguments(
  temporaryHome: string,
  ...extraArguments: string[]
) {
  return [
    `--user-data-dir=${join(temporaryHome, "electron-user-data")}`,
    resolve("apps/desktop"),
    "--lang=zh-CN",
    ...extraArguments,
  ];
}

function createTestEnvironment(temporaryHome: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name, value]) => (
        value !== undefined
        && !name.endsWith("_API_KEY")
        && !name.endsWith("_TOKEN")
      )),
    ),
    DEKI_HOME: join(temporaryHome, ".deki"),
    ...(process.platform === "win32" ? {} : { HOME: temporaryHome }),
    LANG: "zh_CN.UTF-8",
  };
}

async function seedChineseSettings(
  temporaryHome: string,
  extraSettings: Record<string, unknown> = {},
) {
  const root = join(temporaryHome, ".deki");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "settings.json"), JSON.stringify({
    version: 1,
    revision: 1,
    settings: {
      general: { locale: "zh-CN" },
      ...extraSettings,
    },
  }));
}

async function seedComposerModels(temporaryHome: string) {
  await writeFile(join(temporaryHome, ".deki", "models.json"), JSON.stringify({
    providers: {
      alpha: {
        name: "Alpha Provider",
        baseUrl: "https://alpha.invalid/v1",
        api: "openai-completions",
        apiKey: "alpha-test-key",
        models: [
          { id: "alpha-chat", name: "Alpha Chat", reasoning: true },
          { id: "alpha-reasoner", name: "Alpha Reasoner", reasoning: true },
        ],
      },
      beta: {
        name: "Beta Provider",
        baseUrl: "https://beta.invalid/v1",
        api: "openai-completions",
        apiKey: "beta-test-key",
        models: [
          { id: "beta-code", name: "Beta Code", reasoning: true },
        ],
      },
    },
  }));
}

async function seedFixtureModel(temporaryHome: string, baseUrl: string) {
  await writeFile(join(temporaryHome, ".deki", "models.json"), JSON.stringify({
    providers: {
      fixture: {
        name: "Fixture Provider",
        baseUrl,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [{
          id: "fixture-model",
          name: "Fixture Model",
          reasoning: false,
          contextWindow: 32_000,
          maxTokens: 4_096,
        }],
      },
    },
  }));
}

async function startFixtureModelServer(): Promise<{
  baseUrl: string;
  userPrompts: string[];
  readonly maxWorkerConcurrency: number;
  close(): Promise<void>;
}> {
  const userPrompts: string[] = [];
  let callSequence = 0;
  let activeWorkerCalls = 0;
  let maxWorkerConcurrency = 0;
  const server: Server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "fixture-model", object: "model", owned_by: "fixture" }],
      }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model?: string;
      messages?: Array<Record<string, unknown>>;
    };
    const messages = body.messages ?? [];
    const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
    const currentTurn = messages.slice(Math.max(0, lastUserIndex));
    const userPrompt = messageText(messages[lastUserIndex]);
    if (userPrompt) userPrompts.push(userPrompt);
    const workerCall = userPrompt.includes("你是只读")
      && userPrompt.includes("上下文包");
    if (workerCall) {
      activeWorkerCalls += 1;
      maxWorkerConcurrency = Math.max(maxWorkerConcurrency, activeWorkerCalls);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const calledTools = currentTurn.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
      return message.tool_calls.flatMap((call) => {
        if (!isRecord(call) || !isRecord(call.function)) return [];
        return typeof call.function.name === "string" ? [call.function.name] : [];
      });
    });
    const toolOutputs = currentTurn.flatMap((message) =>
      message.role === "tool" ? [messageText(message)] : []);
    const completion = fixtureCompletion(userPrompt, calledTools, toolOutputs);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const id = `fixture-${Date.now()}-${callSequence += 1}`;
    const created = Math.floor(Date.now() / 1000);
    const writeChunk = (delta: Record<string, unknown>, finishReason: string | null) => {
      response.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model ?? "fixture-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };
    if (completion.tool) {
      writeChunk({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-${callSequence}`,
          type: "function",
          function: {
            name: completion.tool.name,
            arguments: JSON.stringify(completion.tool.arguments),
          },
        }],
      }, null);
      writeChunk({}, "tool_calls");
    } else {
      writeChunk({ role: "assistant", content: completion.text }, null);
      writeChunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
    if (workerCall) activeWorkerCalls -= 1;
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    userPrompts,
    get maxWorkerConcurrency() {
      return maxWorkerConcurrency;
    },
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function fixtureCompletion(
  prompt: string,
  calledTools: string[],
  toolOutputs: string[] = [],
): {
  text: string;
  tool?: { name: string; arguments: Record<string, unknown> };
} {
  if (prompt.includes("测试 exclusive 重叠安全暂停")) {
    if (calledTools.includes("worker__delegate")) {
      return { text: "Exclusive overlap was paused for explicit replanning." };
    }
    return {
      text: "",
      tool: {
        name: "worker__delegate",
        arguments: {
          requests: [{
            profile: "implementer",
            objective: "第一阶段更新 pnpm-lock.yaml",
            successCriteria: ["lockfile 第一阶段更新完成"],
            constraints: ["只修改 pnpm-lock.yaml"],
            knownFacts: [],
            fileHints: ["pnpm-lock.yaml"],
            symbolHints: [],
            writeSet: [{ path: "pnpm-lock.yaml", kind: "file" }],
            validationTargets: [{ script: "test" }],
          }, {
            profile: "implementer",
            objective: "第二阶段更新 pnpm-lock.yaml",
            successCriteria: ["lockfile 第二阶段更新完成"],
            constraints: ["只修改 pnpm-lock.yaml"],
            knownFacts: [],
            fileHints: ["pnpm-lock.yaml"],
            symbolHints: [],
            writeSet: [{ path: "pnpm-lock.yaml", kind: "file" }],
            validationTargets: [{ script: "test" }],
          }],
        },
      },
    };
  }
  if (prompt.includes("测试预测重叠和 Integrator 审查")) {
    if (calledTools.includes("worker__delegate")) {
      return { text: "Overlapping implementations reviewed by Integrator." };
    }
    return {
      text: "",
      tool: {
        name: "worker__delegate",
        arguments: {
          requests: [{
            profile: "implementer",
            objective: "第一阶段修改 overlap.txt",
            successCriteria: ["overlap.txt 第一阶段修改完成"],
            constraints: ["只修改 overlap.txt"],
            knownFacts: [],
            fileHints: ["overlap.txt"],
            symbolHints: [],
            writeSet: [{ path: "overlap.txt", kind: "file" }],
            validationTargets: [{ script: "test" }],
          }, {
            profile: "implementer",
            objective: "第二阶段修改 overlap.txt",
            successCriteria: ["overlap.txt 第二阶段修改完成"],
            constraints: ["只修改 overlap.txt"],
            knownFacts: [],
            fileHints: ["overlap.txt"],
            symbolHints: [],
            writeSet: [{ path: "overlap.txt", kind: "file" }],
            validationTargets: [{ script: "test" }],
          }],
        },
      },
    };
  }
  if (
    prompt.includes("测试隔离 Implementer 最终审批")
    || prompt.includes("测试集成验证失败重试")
  ) {
    if (calledTools.includes("worker__delegate")) {
      return { text: "Isolated implementation integrated after user delivery decision." };
    }
    return {
      text: "",
      tool: {
        name: "worker__delegate",
        arguments: {
          requests: [{
            profile: "implementer",
            objective: "创建 alpha.txt",
            successCriteria: ["alpha.txt 内容正确且测试通过"],
            constraints: ["只修改 alpha.txt"],
            knownFacts: [],
            fileHints: ["alpha.txt"],
            symbolHints: [],
            writeSet: [{ path: "alpha.txt", kind: "file" }],
            validationTargets: [{ script: "test" }],
          }, {
            profile: "implementer",
            objective: "创建 beta.txt",
            successCriteria: ["beta.txt 内容正确且测试通过"],
            constraints: ["只修改 beta.txt"],
            knownFacts: [],
            fileHints: ["beta.txt"],
            symbolHints: [],
            writeSet: [{ path: "beta.txt", kind: "file" }],
            validationTargets: [{ script: "test" }],
          }],
        },
      },
    };
  }
  if (prompt.includes("你是 Implementer")) {
    const overlap = prompt.includes("\"path\":\"overlap.txt\"");
    const exclusive = prompt.includes("\"path\":\"pnpm-lock.yaml\"");
    const alpha = !overlap && !exclusive && prompt.includes("alpha.txt");
    const target = overlap
      ? "overlap.txt"
      : exclusive
        ? "pnpm-lock.yaml"
        : alpha ? "alpha.txt" : "beta.txt";
    const content = overlap || exclusive
      ? prompt.includes("第二阶段")
        ? exclusive ? "lockfileVersion: '9.0'\nsecond: true\n" : "second implementation\n"
        : exclusive ? "lockfileVersion: '9.0'\nfirst: true\n" : "first implementation\n"
      : `${alpha ? "alpha" : "beta"} implemented\n`;
    if (!calledTools.includes("workspace__write")) {
      return {
        text: "",
        tool: {
          name: "workspace__write",
          arguments: {
            path: target,
            content,
          },
        },
      };
    }
    if (!calledTools.includes("worker__submit_result")) {
      return {
        text: "",
        tool: {
          name: "worker__submit_result",
          arguments: fixtureWorkerResult(`Implemented ${target}`),
        },
      };
    }
    return { text: `Implemented ${target}.` };
  }
  if (prompt.includes("你是 Integrator")) {
    if (!calledTools.includes("worker__submit_result")) {
      return {
        text: "",
        tool: {
          name: "worker__submit_result",
          arguments: fixtureWorkerResult(
            prompt.includes("clean overlap")
              ? "Reviewed clean overlap without additional edits"
              : "Reviewed restricted conflict resolution",
          ),
        },
      };
    }
    return { text: "Integrator result submitted." };
  }
  if (prompt.includes("测试多 Agent 只读调查")) {
    if (calledTools.includes("worker__delegate")) {
      return { text: "Worker findings synthesized." };
    }
    return {
      text: "",
      tool: {
        name: "worker__delegate",
        arguments: {
          requests: [{
            profile: "explorer",
            objective: "定位 README 与任务入口",
            successCriteria: ["提供文件证据"],
            constraints: ["只读"],
            knownFacts: ["这是 Electron fixture"],
            fileHints: ["README.md"],
            symbolHints: [],
          }, {
            profile: "reviewer",
            objective: "审查只读边界",
            successCriteria: ["提供风险结论"],
            constraints: ["只读"],
            knownFacts: ["不得修改工作区"],
            fileHints: ["README.md"],
            symbolHints: [],
          }],
        },
      },
    };
  }
  if (prompt.includes("你是只读 Explorer")) {
    if (calledTools.includes("worker__submit_result")) {
      return { text: "Explorer result submitted." };
    }
    return {
      text: "",
      tool: {
        name: "worker__submit_result",
        arguments: fixtureWorkerResult("Fixture Explorer finding"),
      },
    };
  }
  if (
    prompt.includes("你是只读 Reviewer")
    || prompt.includes("review.verdict")
    || prompt.includes("Profile: reviewer")
    || prompt.includes("Review: Implement")
  ) {
    if (calledTools.includes("worker__submit_result")) {
      return { text: "Reviewer result submitted." };
    }
    return {
      text: "",
      tool: {
        name: "worker__submit_result",
        arguments: {
          ...fixtureWorkerResult("Fixture Reviewer finding"),
          review: {
            verdict: "approved",
            findings: [],
          },
        },
      },
    };
  }
  if (prompt.includes("测试 Tester Worker 临时副本")) {
    if (calledTools.includes("worker__delegate")) {
      return { text: "Tester finding synthesized." };
    }
    return {
      text: "",
      tool: {
        name: "worker__delegate",
        arguments: {
          requests: [{
            profile: "tester",
            objective: "在临时副本运行 test 脚本",
            successCriteria: ["保存测试日志 Artifact"],
            constraints: ["不得修改真实工作区"],
            knownFacts: ["package.json 声明 test"],
            fileHints: ["package.json"],
            symbolHints: [],
          }],
        },
      },
    };
  }
  if (prompt.includes("你是只读 Tester")) {
    if (!calledTools.includes("test__run")) {
      return {
        text: "",
        tool: { name: "test__run", arguments: { target: "test" } },
      };
    }
    if (!calledTools.includes("worker__submit_result")) {
      const artifactId = toolOutputs.join("\n")
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0]
        ?? "";
      return {
        text: "",
        tool: {
          name: "worker__submit_result",
          arguments: {
            ...fixtureWorkerResult("Fixture Tester finding"),
            artifacts: [artifactId],
            findings: [{
              claim: "Fixture Tester finding",
              confidence: 0.99,
              evidence: [{
                kind: "command",
                target: "test",
                exitCode: 0,
                outputArtifactId: artifactId,
              }],
            }],
          },
        },
      };
    }
    return { text: "Tester result submitted." };
  }
  if (prompt.includes("测试后台审批")) {
    if (calledTools.includes("workspace__delete")) return { text: "Approval completed." };
    return {
      text: "",
      tool: {
        name: "workspace__delete",
        arguments: { path: "approval-target.txt" },
      },
    };
  }
  if (prompt.includes("测试后台输入")) {
    if (calledTools.includes("interaction__request_user_input")) {
      return { text: "User input completed." };
    }
    return {
      text: "",
      tool: {
        name: "interaction__request_user_input",
        arguments: {
          question: "请输入测试回答",
          description: "Fixture user input",
          options: ["fixture-answer"],
        },
      },
    };
  }
  if (prompt.includes("plan__revise")) {
    if (calledTools.includes("plan__revise")) return { text: "Plan revision ready." };
    const planId = prompt.match(/planId=([0-9a-f-]{36})/i)?.[1] ?? "";
    const basedOnRevision = Number(prompt.match(/basedOnRevision=(\d+)/)?.[1] ?? "1");
    return {
      text: "",
      tool: {
        name: "plan__revise",
        arguments: {
          planId,
          basedOnRevision,
          feedback: "Fixture assumption changed",
          goal: "创建一个会触发重新规划的单步骤计划",
          assumptions: ["Fixture assumption changed"],
          constraints: ["Plan mode remains read-only"],
          steps: [fixturePlanStep()],
        },
      },
    };
  }
  if (prompt.includes("plan__submit")) {
    if (calledTools.includes("plan__submit")) return { text: "Plan ready for review." };
    const dag = prompt.includes("DAG 发布收尾验收");
    return {
      text: "",
      tool: {
        name: "plan__submit",
        arguments: {
          goal: dag ? "DAG 发布收尾验收" : "创建一个会触发重新规划的单步骤计划",
          assumptions: ["Initial fixture assumption"],
          constraints: ["Plan mode remains read-only"],
          steps: dag
            ? [fixtureDagImplementer("alpha"), fixtureDagImplementer("beta")]
            : [fixturePlanStep()],
        },
      },
    };
  }
  if (prompt.includes("执行下面已由用户批准的计划")) {
    const planId = prompt.match(/planId=([0-9a-f-]{36})/i)?.[1] ?? "";
    const revision = Number(prompt.match(/revision=(\d+)/)?.[1] ?? "1");
    const updateCount = calledTools.filter((name) => name === "plan__update_step").length;
    if (updateCount === 0) {
      return {
        text: "",
        tool: {
          name: "plan__update_step",
          arguments: { planId, revision, stepId: "inspect", status: "running" },
        },
      };
    }
    if (revision === 1 && !calledTools.includes("plan__request_replan")) {
      return {
        text: "",
        tool: {
          name: "plan__request_replan",
          arguments: {
            planId,
            reason: "Fixture assumption changed",
            affectedStepIds: ["inspect"],
            evidence: ["fixture-evidence"],
          },
        },
      };
    }
    if (revision > 1 && updateCount === 1) {
      return {
        text: "",
        tool: {
          name: "plan__update_step",
          arguments: {
            planId,
            revision,
            stepId: "inspect",
            status: "completed",
            summary: "Fixture completed",
            evidence: ["fixture-result"],
          },
        },
      };
    }
    return { text: "Plan execution completed." };
  }
  return { text: "Fixture response." };
}

function fixtureWorkerResult(claim: string) {
  return {
    summary: claim,
    findings: [{
      claim,
      confidence: 0.95,
      evidence: [{
        kind: "file",
        path: "README.md",
        lineStart: 1,
        excerpt: "worker fixture",
      }],
    }],
    artifacts: [],
    risks: [],
    unresolved: [],
    recommendedNextActions: ["由主 Agent 综合结论"],
  };
}

function fixturePlanStep() {
  return {
    id: "inspect",
    title: "Inspect fixture",
    description: "Inspect the fixture without changing files.",
    dependencies: [],
    candidateFiles: ["README.md"],
    validation: ["Workspace remains unchanged"],
    risk: "low",
    parallelizable: false,
    executionProfile: "explorer",
  };
}

function fixtureDagImplementer(name: "alpha" | "beta") {
  return {
    id: name,
    title: `Implement ${name}`,
    description: `Create ${name}.txt in an isolated worktree.`,
    dependencies: [],
    candidateFiles: [`${name}.txt`],
    validation: ["test passes"],
    risk: "low",
    parallelizable: true,
    executionProfile: "implementer",
    writeSet: [{ path: `${name}.txt`, kind: "file", exclusive: false }],
    validationTargets: [{ script: "test" }],
  };
}

function messageText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string"
      ? [item.text]
      : []).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function gitWorkspaceSnapshot(workspace: string) {
  const [status, diff, staged] = await Promise.all([
    execFileAsync("git", ["status", "--porcelain"], { cwd: workspace }),
    execFileAsync("git", ["diff", "--no-ext-diff"], { cwd: workspace }),
    execFileAsync("git", ["diff", "--cached", "--no-ext-diff"], { cwd: workspace }),
  ]);
  return { status: status.stdout, diff: diff.stdout, staged: staged.stdout };
}

async function seedTaskPlanFixture(temporaryHome: string) {
  const tasksDirectory = join(temporaryHome, ".deki", "tasks");
  await mkdir(tasksDirectory, { recursive: true });
  const store = new TaskStore(join(tasksDirectory, "tasks.db"));
  const missingWorkspace = join(temporaryHome, "missing-workspace");
  const task = store.createTask({
    workspaceId: "fixture-workspace",
    workspacePath: missingWorkspace,
    kind: "planning",
    title: "审阅计划 Fixture",
    goal: "验证 Task Center 的计划展示",
    execution: {
      type: "agent-prompt",
      sourceSessionId: "fixture-session",
      sourceSessionFile: join(temporaryHome, "missing-session.jsonl"),
      sourceEntryId: "fixture-entry",
      preferFork: true,
      interactionMode: "plan",
      deliveryMode: "background",
    },
  });
  const plan = store.createPlan({
    workspaceId: "fixture-workspace",
    workspacePath: missingWorkspace,
    sessionId: "fixture-session",
    planningTaskId: task.id,
    goal: "验证 Task Center 的计划展示",
    assumptions: ["fixture"],
    constraints: ["应用内预览"],
    steps: [{
      id: "inspect",
      title: "检查实现",
      description: "检查当前实现",
      dependencies: [],
      candidateFiles: ["src/index.ts"],
      validation: ["显示正确"],
      risk: "low",
      parallelizable: false,
    }],
  });
  const run = store.createRun(task.id);
  store.createArtifact({
    taskId: task.id,
    runId: run.id,
    kind: "diff",
    title: "Fixture Diff",
    content: "--- a/file\n+++ b/file\n+fixture",
    metadata: { planId: plan.id },
  });
  store.createTask({
    workspaceId: "fixture-workspace",
    workspacePath: missingWorkspace,
    kind: "background",
    title: "后台暂停 Fixture",
    goal: "验证排队任务暂停与恢复",
    execution: {
      type: "agent-prompt",
      sourceSessionId: "fixture-session",
      sourceSessionFile: join(temporaryHome, "missing-session.jsonl"),
      sourceEntryId: "fixture-entry",
      preferFork: true,
      interactionMode: "act",
      deliveryMode: "background",
    },
  });
  store.close();
}

async function seedPersistedSession(
  temporaryHome: string,
  workspace: string | undefined,
  sessionId: string,
  timestamp: string,
) {
  const normalizedWorkspace = workspace ? await realpath(workspace) : undefined;
  const cwd = normalizedWorkspace ?? join(temporaryHome, ".deki", "general");
  const scopeId = normalizedWorkspace
    ? createHash("sha256").update(normalizedWorkspace).digest("hex").slice(0, 24)
    : "general";
  const sessionDirectory = join(temporaryHome, ".deki", "sessions", scopeId);
  await mkdir(sessionDirectory, { recursive: true });
  const entries = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp,
      cwd,
    },
    {
      type: "model_change",
      id: `${sessionId}-model`,
      parentId: null,
      timestamp,
      provider: "alpha",
      modelId: "alpha-chat",
    },
    {
      type: "thinking_level_change",
      id: `${sessionId}-thinking`,
      parentId: `${sessionId}-model`,
      timestamp,
      thinkingLevel: "medium",
    },
    {
      type: "message",
      id: `${sessionId}-user`,
      parentId: `${sessionId}-thinking`,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: `seed ${sessionId}` }],
        timestamp: new Date(timestamp).getTime(),
      },
    },
    {
      type: "message",
      id: `${sessionId}-assistant`,
      parentId: `${sessionId}-user`,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        api: "openai-completions",
        provider: "alpha",
        model: "alpha-chat",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: new Date(timestamp).getTime(),
      },
    },
  ];
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  await writeFile(
    join(sessionDirectory, `${fileTimestamp}_${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}
