import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const mainBundle = resolve(import.meta.dirname, "../apps/desktop/out/main/index.js");
const source = await readFile(mainBundle, "utf8");
const externalWorkspaceImport =
  /\bfrom\s*["']@deki-ai\/|\bimport\s*\(\s*["']@deki-ai\//;

if (externalWorkspaceImport.test(source)) {
  throw new Error(
    "Desktop main bundle still imports a @deki-ai workspace package. "
    + "Add that package to externalizeDepsPlugin.exclude so packaged Electron "
    + "does not try to execute TypeScript from node_modules.",
  );
}

console.log("Desktop bundle verification passed: no external @deki-ai imports.");
