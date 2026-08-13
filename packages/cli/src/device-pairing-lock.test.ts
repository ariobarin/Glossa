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
    `${JSON.stringify({ pid: 2147483647, startedAt: new Date(0).toISOString(), token: "stale" })}\n`,
    "utf8",
  );

  const result = await withDevicePairingLease(
    async () => "recovered",
    undefined,
    directory,
  );
  assert.equal(result, "recovered");
});

test("serializes concurrent stale-lock reclaimers", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-pairing-lock-race-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "device-pairing.lock"),
    `${JSON.stringify({ pid: 2147483647, startedAt: new Date(0).toISOString(), token: "stale" })}\n`,
    "utf8",
  );

  let active = 0;
  let maximumActive = 0;
  const contenders = Array.from({ length: 8 }, (_, index) =>
    withDevicePairingLease(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return index;
    }, undefined, directory)
  );

  assert.deepEqual((await Promise.all(contenders)).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maximumActive, 1);
});

test("does not reclaim a current lock owned by a live process", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-pairing-lock-live-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "device-pairing.lock"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "live" })}\n`,
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

test("reclaims an expired lock after the pairing window", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-pairing-lock-expired-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "device-pairing.lock"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString(), token: "expired" })}\n`,
    "utf8",
  );

  assert.equal(
    await withDevicePairingLease(async () => "recovered", undefined, directory),
    "recovered",
  );
});
