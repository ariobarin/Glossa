import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectExposureRoot } from "./root-selection.js";
import { WorkerError } from "./errors.js";

test("uses the current directory when no path is given", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "glossa-root-parent-"));
  const dir = path.join(parent, "nested");
  await mkdir(dir);
  try {
    assert.equal(await selectExposureRoot(undefined, dir), await realpath(dir));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("uses an explicitly selected directory", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "glossa-root-cwd-"));
  const target = await mkdtemp(path.join(os.tmpdir(), "glossa-root-target-"));
  try {
    assert.equal(await selectExposureRoot(target, cwd), await realpath(target));
  } finally {
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(target, { recursive: true, force: true }),
    ]);
  }
});

test("refuses a broad current directory", async () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  await assert.rejects(
    selectExposureRoot(undefined, filesystemRoot),
    (error: unknown) => {
      if (!(error instanceof WorkerError) || error.code !== "broad_root_refused") return false;
      return /filesystem root/.test(error.message) && /project directory/.test(error.message);
    },
  );
});

test("refuses a home directory ancestor when selected implicitly", async () => {
  const accountHome = await realpath(os.userInfo().homedir);
  const profileRoot = path.dirname(accountHome);
  if (profileRoot === path.parse(profileRoot).root) return;
  await assert.rejects(
    selectExposureRoot(undefined, profileRoot),
    (error: unknown) => {
      if (!(error instanceof WorkerError) || error.code !== "broad_root_refused") return false;
      return /home directory/.test(error.message) && /workspace directory/.test(error.message);
    },
  );
});

test("refuses every implicit ancestor of a nested account home", async (context) => {
  const account = os.userInfo();
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-root-ancestor-"));
  const home = path.join(root, "accounts", "person");
  await mkdir(home, { recursive: true });
  context.mock.method(os, "userInfo", () => ({ ...account, homedir: home }));
  try {
    await assert.rejects(
      selectExposureRoot(undefined, root),
      (error: unknown) =>
        error instanceof WorkerError && error.code === "broad_root_refused",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows a home directory ancestor when selected explicitly", async () => {
  const accountHome = await realpath(os.userInfo().homedir);
  const profileRoot = path.dirname(accountHome);
  if (profileRoot === path.parse(profileRoot).root) return;
  assert.equal(
    await selectExposureRoot(profileRoot, process.cwd()),
    profileRoot,
  );
});

test("uses the environment home when account lookup is unavailable", async (context) => {
  context.mock.method(os, "userInfo", () => {
    throw new Error("account lookup unavailable");
  });
  const parent = await mkdtemp(path.join(os.tmpdir(), "glossa-root-fallback-"));
  const dir = path.join(parent, "nested");
  await mkdir(dir);
  try {
    assert.equal(await selectExposureRoot(undefined, dir), await realpath(dir));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
