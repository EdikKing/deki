import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "release-assets");
const output = resolve(process.argv[3] ?? join(directory, "SHA256SUMS.txt"));
const ignored = new Set([basename(output)]);
const entries = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && !ignored.has(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));

if (entries.length === 0) {
  throw new Error(`No release assets found in ${directory}.`);
}

const lines = [];
for (const entry of entries) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(directory, entry.name))) {
    hash.update(chunk);
  }
  lines.push(`${hash.digest("hex")}  ${entry.name}`);
}

await writeFile(output, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${entries.length} SHA-256 checksums to ${output}.`);
