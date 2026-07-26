import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

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
    await expect(navigation.getByText(/未关联项目|No project/)).toBeVisible();
    await expect(navigation.getByText(/新会话|New chat/)).toBeVisible();
    await expect(navigation.getByRole("button", { name: "添加项目" })).toBeVisible();
    await expect(window.getByText(/普通会话无需选择项目|General chat needs no project/)).toBeVisible();
    await expect(window.locator("textarea")).toBeVisible();
    await window.getByTestId("open-settings").click();
    await expect(window.getByTestId("settings-page")).toBeVisible();
    await expect(window.getByRole("heading", { name: /通用|General/ })).toBeVisible();
    const scope = window.locator(".scope-picker select");
    await expect(scope.locator("option[value=projectShared]")).toBeDisabled();
    await window.getByTestId("settings-section-appearance").click();
    await window.locator(".setting-row").filter({ has: window.locator("select option[value=light]") }).getByRole("combobox").selectOption("light");
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
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
    await expect(window.locator(".timeline-item strong").first()).toHaveText(
      "deki__project_info",
    );

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
