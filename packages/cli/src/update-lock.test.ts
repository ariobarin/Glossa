import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withUpdateLease, withWorkspaceLease } from "./update-lock.js";

test("refuses an update while a workspace lease is active", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-lock-"));
  try {
    await withWorkspaceLease(async () => {
      await assert.rejects(
        withUpdateLease(async () => undefined, directory),
        /Disconnect every running Glossa workspace/,
      );
    }, directory);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks a workspace while an update lease is active", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-lock-"));
  try {
    await withUpdateLease(async () => {
      await assert.rejects(
        withWorkspaceLease(async () => undefined, directory),
        /Glossa is updating/,
      );
    }, directory);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans stale workspace leases before updating", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-lock-"));
  try {
    await writeFile(
      path.join(directory, "2147483647-stale.session"),
      '{"pid":2147483647}\n',
      "utf8",
    );
    let ran = false;
    await withUpdateLease(async () => { ran = true; }, directory);
    assert.equal(ran, true);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps an active update lease when another updater competes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-lock-"));
  try {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withUpdateLease(async () => {
      entered();
      await hold;
    }, directory);

    await started;
    const activeEntries = await readdir(directory);
    assert.equal(activeEntries.length, 1);
    assert.match(
      activeEntries[0]!,
      /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.update$/,
    );

    await assert.rejects(
      withUpdateLease(async () => undefined, directory),
      /Another Glossa update is already running/,
    );
    assert.deepEqual(await readdir(directory), activeEntries);

    release();
    await first;
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
