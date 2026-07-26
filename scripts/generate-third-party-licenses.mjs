import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const result = spawnSync("pnpm", ["licenses", "list", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
if (result.status !== 0) {
  throw new Error(result.stderr || "Unable to enumerate third-party licenses");
}
const groups = JSON.parse(result.stdout);
const rows = Object.entries(groups).flatMap(([license, packages]) =>
  packages.map((item) => ({
    name: item.name,
    versions: item.versions.join(", "),
    license,
    homepage: item.homepage ?? "",
  }))).sort((left, right) => left.name.localeCompare(right.name));
const output = resolve(root, "apps/desktop/resources/THIRD_PARTY_LICENSES.md");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, [
  "# Deki third-party licenses",
  "",
  "Generated from the locked pnpm dependency graph. Refer to each linked package for full license text.",
  "",
  "| Package | Version(s) | License | Homepage |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) =>
    `| ${escapeCell(row.name)} | ${escapeCell(row.versions)} | ${escapeCell(row.license)} | ${row.homepage ? `[link](${row.homepage})` : ""} |`),
  "",
].join("\n"), "utf8");

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
