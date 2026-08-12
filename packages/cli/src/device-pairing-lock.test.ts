import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withDevicePairingLease } from "./device-pairing-lock.js";

test("serializes device pairing across competing sessions", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-pairing-lock-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));

  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted = false;
  let secondStarted = false;
  const first = withDevicePairingLease(async () => {
    firstStarted = true;
    await firstBlocked;
    return "first";
  }, undefined, directory);

  while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = withDevicePairingLease(async () => {
    secondStarted = true;
    return "second";
  }, undefined, directory);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondStarted, false);
  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(secondStarted, true);
});

test("reclaims a stale device pairing lock", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-pairing-lock-stale-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "device-pairing.lock"),
    `${JSON.stringify({ pid: 2147483647, startedAt: new Date(0).toISOString() })}\n`,
    "utf8",
  );

  const result = await withDevicePairingLease(
    async () => "recovered",
    undefined,
    directory,
  );
  assert.equal(result, "recovered");
});

test("does not reclaim an old lock owned by a live process", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-pairing-lock-live-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "device-pairing.lock"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() })}\n`,
    "utf8",
  );
  const controller = new AbortController();
  const pending = withDevicePairingLease(
    async () => {
      throw new Error("A live owner's lock must not be reclaimed.");
    },
    controller.signal,
    directory,
  );

  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, { name: "AbortError" });
});
