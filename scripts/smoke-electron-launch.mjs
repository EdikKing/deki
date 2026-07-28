import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporaryHome = await mkdtemp(join(tmpdir(), "deki-electron-launch-"));
const electronPath = createRequire(import.meta.url)("electron");
let child;
let output = "";

try {
  const settingsRoot = join(temporaryHome, ".deki");
  await mkdir(settingsRoot, { recursive: true });
  await writeFile(join(settingsRoot, "settings.json"), JSON.stringify({
    version: 1,
    revision: 1,
    settings: {
      general: { locale: "zh-CN" },
    },
  }));

  child = spawn(electronPath, [
    "--enable-logging=stderr",
    `--user-data-dir=${join(temporaryHome, "electron-user-data")}`,
    resolve(root, "apps/desktop"),
    "--lang=zh-CN",
  ], {
    cwd: root,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name, value]) => (
          value !== undefined
          && !name.endsWith("_API_KEY")
          && !name.endsWith("_TOKEN")
        )),
      ),
      DEKI_LAUNCH_SMOKE: "1",
      DEKI_HOME: settingsRoot,
      ...(process.platform === "win32" ? {} : { HOME: temporaryHome }),
      LANG: "zh_CN.UTF-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", captureOutput);
  child.stderr.on("data", captureOutput);

  await waitForReady(child);

  console.log("Electron launch smoke test passed.");
} finally {
  if (child?.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    } else {
      await terminateChild(child);
    }
  }
  await rm(temporaryHome, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

async function terminateChild(childProcess) {
  childProcess.kill("SIGTERM");
  if (await waitForExit(childProcess, 2_000)) return;
  childProcess.kill("SIGKILL");
  await waitForExit(childProcess, 2_000);
}

function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    childProcess.once("exit", onExit);
    function finish(exited) {
      clearTimeout(timeout);
      childProcess.off("exit", onExit);
      resolveExit(exited);
    }
  });
}

function captureOutput(chunk) {
  output = `${output}${chunk}`.slice(-64 * 1024);
}

function waitForReady(childProcess) {
  return new Promise((resolveReady, reject) => {
    const interval = setInterval(() => {
      if (output.includes("DEKI_LAUNCH_SMOKE_READY")) {
        finish(resolveReady);
      }
    }, 50);
    const timeout = setTimeout(() => {
      finish(reject, new Error(
        `Electron did not load its renderer within 20 seconds.\n${output}`,
      ));
    }, 20_000);
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => {
      finish(reject, new Error(
        `Electron exited before its renderer loaded (code=${code}, signal=${signal}).\n${output}`,
      ));
    };
    childProcess.once("error", onError);
    childProcess.once("exit", onExit);

    function finish(callback, value) {
      clearInterval(interval);
      clearTimeout(timeout);
      childProcess.off("error", onError);
      childProcess.off("exit", onExit);
      callback(value);
    }
  });
}
