import { readFile } from "node:fs/promises";

const tag = process.env.RELEASE_TAG
  ?? process.argv.slice(2).find((argument) => argument !== "--")
  ?? "";
const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);

if (!match) {
  throw new Error(
    `Invalid release tag "${tag}". Expected vMAJOR.MINOR.PATCH or a SemVer prerelease tag.`,
  );
}

const version = tag.slice(1);
const packageFiles = [
  "package.json",
  "apps/desktop/package.json",
  "apps/cli/package.json",
];

for (const file of packageFiles) {
  const metadata = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  if (metadata.version !== version) {
    throw new Error(
      `${file} has version ${metadata.version}; release tag ${tag} requires ${version}.`,
    );
  }
}

const sharedSource = await readFile(
  new URL("../packages/shared/src/index.ts", import.meta.url),
  "utf8",
);
const sourceVersion = /export const DEKI_VERSION = "([^"]+)";/.exec(sharedSource)?.[1];
if (sourceVersion !== version) {
  throw new Error(
    `packages/shared/src/index.ts has DEKI_VERSION ${sourceVersion ?? "(missing)"}; release tag ${tag} requires ${version}.`,
  );
}

console.log(`Release tag ${tag} matches all distributable package versions.`);
