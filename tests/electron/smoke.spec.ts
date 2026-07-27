import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";

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
    args: [resolve("apps/desktop"), "--lang=zh-CN"],
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await expect(window.getByRole("heading", { name: /开始一个普通会话|Start a general chat/ })).toBeVisible();
    const navigation = window.getByRole("navigation", { name: "项目和会话" });
    await expect(navigation.getByText(/关联一个项目|Connect a project/)).toBeVisible();
    await expect(navigation.getByText(/新会话|New chat/)).toBeVisible();
    await expect(navigation.getByRole("button", { name: "添加项目" })).toBeVisible();
    await expect(window.getByText(/普通会话无需选择项目|General chat needs no project/)).toBeVisible();
    const composer = window.locator(".composer-card");
    await expect(composer).toBeVisible();
    await expect(composer.locator(".composer-input")).toBeVisible();
    await expect(composer.getByRole("combobox", { name: "选择模型" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "保存记忆" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "选择项目" })).toBeVisible();
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
    await expect(window.locator(".builtin-provider-card")).toHaveCount(8);
    await expect(window.locator(".builtin-provider-card").first()).toHaveAttribute("data-provider-id", "openai");
    await expect(window.locator(".builtin-provider-card").last()).toHaveAttribute("data-provider-id", "openrouter");
    await expect(window.getByRole("heading", { name: "自定义模型" })).toBeVisible();
    await expect(window.locator(".builtin-provider-card input[type=password]")).toHaveCount(8);
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
test("keeps the composer visible when a conversation exceeds the viewport", async ({}) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-overflow-"));
  await seedChineseSettings(temporaryHome);
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [resolve("apps/desktop"), "--lang=zh-CN"],
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
    args: [resolve("apps/desktop"), "--lang=zh-CN"],
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
    args: [
      resolve("apps/desktop"),
      "--lang=zh-CN",
      "--workspace",
      resolve("tests/fixtures/workspace"),
    ],
    env: createTestEnvironment(temporaryHome),
  });

  try {
    const window = await electronApp.firstWindow();
    await window.getByRole("button", { name: "返回普通会话" }).click();
    await expect(window.getByRole("heading", { name: "开始一个普通会话" })).toBeVisible();
    await expect(window.getByRole("button", { name: "关联一个项目" })).toBeVisible();
  } finally {
    await electronApp.close();
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

// Playwright requires an object-destructured fixtures parameter.
// eslint-disable-next-line no-empty-pattern
test("trusts a workspace, streams fixture events, and recalls memory", async ({}, testInfo) => {
  const temporaryHome = await mkdtemp(resolve(tmpdir(), "deki-electron-home-"));
  await seedChineseSettings(temporaryHome);

  const launch = (fixtureEvents = false) => electron.launch({
    executablePath: electronPath,
    args: [
      resolve("apps/desktop"),
      "--lang=zh-CN",
      "--workspace",
      resolve("tests/fixtures/workspace"),
      ...(fixtureEvents ? ["--e2e-fixture-events"] : []),
    ],
    env: createTestEnvironment(temporaryHome),
  });

  let electronApp: ElectronApplication | undefined;
  try {
    electronApp = await launch(true);
    const window = await electronApp.firstWindow();
    await expect(window.getByRole("heading", { name: /信任这个工作区|Trust this workspace/ })).toBeVisible();
    await expect(window.locator(".workspace-path")).toContainText("tests/fixtures/workspace");

    await window.getByRole("button", { name: /信任并继续|Trust and continue/ }).click();
    await expect(window.getByText(/需要云模型凭据|Cloud credentials required/)).toBeVisible();
    await expect(window.getByText(/本地 AI 开发工作台|Local AI development workspace/)).toBeVisible();
    const navigation = window.getByRole("navigation", { name: "项目和会话" });
    await expect(navigation.getByText("项目", { exact: true })).toBeVisible();
    await expect(navigation.getByText("会话", { exact: true })).toBeVisible();
    await expect(navigation.getByRole("button", { name: "新建会话" })).toBeVisible();
    await expect(window.locator(".status-line", { hasText: "Skills" })).toContainText(
      "test-skill",
    );
    await expect(window.getByText("这是模拟的流式响应。")).toBeVisible();
    await expect(window.locator(".tool-card summary strong").first()).toHaveText(
      "deki__project_info",
    );
    const inlineTool = window.locator(".inline-tools .tool-card").first();
    await inlineTool.getByText("完成").click();
    await expect(inlineTool.locator(".tool-payload", { hasText: "结果" })).toContainText("fixture");
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
    args: [resolve("apps/desktop"), "--lang=zh-CN", "--workspace", workspace],
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

function createTestEnvironment(temporaryHome: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name, value]) => (
        value !== undefined
        && !name.endsWith("_API_KEY")
        && !name.endsWith("_TOKEN")
      )),
    ),
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    LANG: "zh_CN.UTF-8",
  };
}

async function seedChineseSettings(temporaryHome: string) {
  const root = join(temporaryHome, ".deki");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "settings.json"), JSON.stringify({
    version: 1,
    revision: 1,
    settings: {
      general: { locale: "zh-CN" },
    },
  }));
}
