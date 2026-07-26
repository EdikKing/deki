import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const desktopRoot = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@deki-ai/shared",
          "@deki-ai/config",
          "@deki-ai/tool-gateway",
          "@deki-ai/mcp-manager",
          "@deki-ai/memory-engine",
          "@deki-ai/settings",
          "@deki-ai/permission-engine",
          "@deki-ai/git-checkpoint",
          "@deki-ai/agent-runtime",
        ],
      }),
    ],
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@deki-ai/shared", "@deki-ai/settings", "zod"],
      }),
    ],
    ssr: {
      noExternal: true,
    },
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "src/preload/index.ts"),
        external: ["electron"],
        output: {
          entryFileNames: "index.cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(desktopRoot, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(desktopRoot, "src/renderer/index.html"),
      },
    },
  },
});
