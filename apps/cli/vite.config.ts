import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    ssr: "src/index.ts",
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: {
        entryFileNames: "deki.js",
        banner: "#!/usr/bin/env node",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
