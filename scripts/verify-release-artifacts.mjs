import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const platform = process.argv[2];
const releaseDirectory = resolve(process.argv[3] ?? "release");
const requirements = {
  macos: {
    extensions: [".dmg", ".zip"],
    metadata: "latest-mac.yml",
  },
  windows: {
    extensions: [".exe"],
    minimumExecutables: 2,
    metadata: "latest.yml",
  },
  linux: {
    extensions: [".AppImage", ".deb"],
    metadata: "latest-linux.yml",
  },
};
const requirement = requirements[platform];

if (!requirement) {
  throw new Error(`Unknown platform "${platform}".`);
}

const rootEntries = await readdir(releaseDirectory, { withFileTypes: true });
const files = rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);

for (const extension of requirement.extensions) {
  const count = files.filter((file) => file.endsWith(extension)).length;
  const minimum = extension === ".exe" ? requirement.minimumExecutables ?? 1 : 1;
  if (count < minimum) {
    throw new Error(`Expected at least ${minimum} ${extension} artifact(s), found ${count}.`);
  }
}
if (!files.includes(requirement.metadata)) {
  throw new Error(`Missing auto-update metadata ${requirement.metadata}.`);
}

const updateConfigurations = [];
async function findUpdateConfigurations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await findUpdateConfigurations(path);
    } else if (entry.name === "app-update.yml") {
      updateConfigurations.push(path);
    }
  }
}
await findUpdateConfigurations(releaseDirectory);

if (updateConfigurations.length === 0) {
  throw new Error("Packaged application does not contain app-update.yml.");
}

console.log(
  `Verified ${platform} installers, ${requirement.metadata}, and ${updateConfigurations.length} embedded update configuration(s).`,
);
