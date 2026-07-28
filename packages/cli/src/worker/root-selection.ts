import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerError } from "./errors.js";
import {
  accountHomeDirectory,
  canonicalizeRoot,
} from "./path-policy.js";

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function rejectImplicitHomeAncestor(root: string): Promise<void> {
  const homes = await Promise.all(
    [os.homedir(), accountHomeDirectory()].map(async (home) =>
      await realpath(home).catch(() => path.resolve(home))
    ),
  );
  if (homes.some((home) => containsPath(root, home))) {
    throw new WorkerError(
      "broad_root_refused",
      "The selected root contains a home directory, which Glossa will not expose implicitly. Choose a workspace directory instead.",
    );
  }
}

export async function selectExposureRoot(
  explicitPath: string | undefined,
  cwd = process.cwd(),
): Promise<string> {
  const root = await canonicalizeRoot(explicitPath ?? cwd);
  if (explicitPath === undefined) await rejectImplicitHomeAncestor(root);
  return root;
}
