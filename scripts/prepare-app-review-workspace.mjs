import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const markerName = ".glossa-review-fixture";
const markerContent = "glossa-app-review-fixture-v2\n";
const acceptedMarkerContents = new Set([
  markerContent,
  "glossa-plugin-review-fixture-v1\n",
]);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const templateRoot = path.join(repositoryRoot, "review", "fixture-template");

const args = process.argv.slice(2);
const reset = args.includes("--reset");

if (args.some((arg) => arg !== "--reset") || args.length > 1) {
  throw new Error(
    "Usage: node scripts/prepare-app-review-workspace.mjs [--reset]",
  );
}

const target = path.join(repositoryRoot, ".review-workspace");
const backup = path.join(repositoryRoot, ".review-workspace.backup");

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function recognizedFixture(candidate) {
  const marker = await readFile(path.join(candidate, markerName), "utf8").catch(
    () => "",
  );
  return acceptedMarkerContents.has(marker);
}

if (await exists(backup)) {
  if (!(await recognizedFixture(backup))) {
    throw new Error(`Refusing to use an unrecognized backup: ${backup}`);
  }
  if (await exists(target)) {
    if (!(await recognizedFixture(target))) {
      throw new Error(
        `Refusing to remove a recognized backup while the target is unrecognized: ${target}`,
      );
    }
    await rm(backup, { recursive: true, force: false });
  } else {
    await rename(backup, target);
  }
}

const targetExists = await exists(target);
if (targetExists) {
  if (!reset) {
    throw new Error(
      `Target already exists: ${target}. Pass --reset to replace a recognized fixture.`,
    );
  }

  if (!(await recognizedFixture(target))) {
    throw new Error(`Refusing to reset an unrecognized directory: ${target}`);
  }
}

const staging = await mkdtemp(path.join(repositoryRoot, ".review-workspace-"));
try {
  await cp(templateRoot, staging, { recursive: true });
  await writeFile(path.join(staging, markerName), markerContent, "utf8");
  if (targetExists) await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (error) {
    if ((await exists(backup)) && !(await exists(target))) {
      await rename(backup, target);
    }
    throw error;
  }
  if (await exists(backup)) {
    await rm(backup, { recursive: true, force: false });
  }
} catch (error) {
  if (await exists(staging)) {
    await rm(staging, { recursive: true, force: true });
  }
  throw error;
}

console.log(`Prepared Glossa app review workspace at ${target}`);
