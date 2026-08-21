import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureUpdates,
  isUpdateCheckDue,
  loadUpdateState,
  observeMcpContractVersion,
  recordUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update-state.js";

test("uses version-aware defaults and persists update settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-state-"));
  const file = path.join(directory, "updates.json");
  try {
    assert.deepEqual(await loadUpdateState("0.1.0-beta.13", file), {
      policy: "notify",
      channel: "beta",
    });
    assert.deepEqual(await loadUpdateState("0.1.0", file), {
      policy: "notify",
      channel: "stable",
    });

    const configured = await configureUpdates(
      "0.1.0-beta.13",
      { policy: "auto", channel: "stable" },
      file,
    );
    assert.equal(configured.policy, "auto");
    assert.equal(configured.channel, "stable");

    const checkedAt = new Date("2026-07-31T12:00:00.000Z");
    const recorded = await recordUpdateCheck(
      "0.1.0-beta.13",
      checkedAt,
      file,
    );
    assert.equal(recorded.lastCheckedAt, checkedAt.toISOString());
    assert.equal(
      await observeMcpContractVersion("0.1.0-beta.13", "3.1.0", file),
      false,
    );
    assert.equal(
      await observeMcpContractVersion("0.1.0-beta.13", "3.1.0", file),
      false,
    );
    assert.equal(
      await observeMcpContractVersion("0.1.0-beta.13", "3.2.0", file),
      true,
    );
    assert.match(await readFile(file, "utf8"), /"policy": "auto"/);
    const reset = await configureUpdates(
      "0.1.0-beta.13",
      { policy: "off" },
      file,
    );
    assert.deepEqual(reset, {
      policy: "off",
      channel: "stable",
      mcpContractVersion: "3.2.0",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores malformed update state and calculates the daily interval", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-state-"));
  const file = path.join(directory, "updates.json");
  try {
    await writeFile(file, "not-json", "utf8");
    assert.deepEqual(await loadUpdateState("0.1.0-beta.13", file), {
      policy: "notify",
      channel: "beta",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const checkedAt = Date.parse("2026-07-31T12:00:00.000Z");
  assert.equal(isUpdateCheckDue(undefined, checkedAt), true);
  assert.equal(isUpdateCheckDue(new Date(checkedAt).toISOString(), checkedAt), false);
  assert.equal(
    isUpdateCheckDue(
      new Date(checkedAt).toISOString(),
      checkedAt + UPDATE_CHECK_INTERVAL_MS,
    ),
    true,
  );
  assert.equal(isUpdateCheckDue("invalid", checkedAt), true);
});
