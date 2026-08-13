import assert from "node:assert/strict";
import test from "node:test";
import {
  DevicePairingCapacityError,
  DevicePairingState,
  DEVICE_PAIRING_TTL_MS,
} from "./device-pairing.js";

function deterministicState() {
  let now = Date.parse("2026-08-12T12:00:00.000Z");
  let randomCall = 0;
  const state = new DevicePairingState({
    now: () => now,
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    randomBytes: ((size: number) => {
      randomCall += 1;
      return Buffer.alloc(size, randomCall);
    }) as typeof import("node:crypto").randomBytes,
  });
  return {
    state,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test("creates a bounded pairing request without retaining the plaintext secret", () => {
  const { state } = deterministicState();
  const pairing = state.create("gpu-box", "linux-x64");

  assert.equal(pairing.pairingId, "00000000-0000-4000-8000-000000000001");
  assert.match(pairing.userCode, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(pairing.pairingSecret.length, 43);
  assert.equal(pairing.expiresAt, "2026-08-12T12:05:00.000Z");
});

test("approves by human code and completes only with the private pairing secret", async () => {
  const { state } = deterministicState();
  const created = state.create("gpu-box", "linux-x64");
  let issues = 0;
  const issue = async () => {
    issues += 1;
    return { token: "issued-once" };
  };

  assert.deepEqual(await state.complete(created.pairingId, "wrong", issue), {
    status: "invalid",
  });
  assert.deepEqual(
    await state.complete(created.pairingId, created.pairingSecret, issue),
    { status: "pending" },
  );

  const approval = state.approve("account-1", created.userCode.toLowerCase());
  assert.equal(approval.status, "approved");
  if (approval.status === "approved") {
    assert.equal(approval.pairing.name, "gpu-box");
    assert.equal(approval.pairing.platform, "linux-x64");
  }

  assert.deepEqual(
    await state.complete(created.pairingId, created.pairingSecret, issue),
    { status: "approved", value: { token: "issued-once" } },
  );
  assert.deepEqual(
    await state.complete(created.pairingId, created.pairingSecret, issue),
    { status: "approved", value: { token: "issued-once" } },
  );
  assert.equal(issues, 1);
});

test("coalesces concurrent completion and retries after issuance failure", async () => {
  const { state } = deterministicState();
  const created = state.create("gpu-box", null);
  state.approve("account-1", created.userCode);

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let issues = 0;
  const issue = async () => {
    issues += 1;
    await blocked;
    return { deviceId: "device-1" };
  };
  const first = state.complete(created.pairingId, created.pairingSecret, issue);
  const second = state.complete(created.pairingId, created.pairingSecret, issue);
  release();
  assert.deepEqual(await first, {
    status: "approved",
    value: { deviceId: "device-1" },
  });
  assert.deepEqual(await second, {
    status: "approved",
    value: { deviceId: "device-1" },
  });
  assert.equal(issues, 1);

  const retryState = deterministicState().state;
  const retryCreated = retryState.create("retry-box", null);
  retryState.approve("account-1", retryCreated.userCode);
  let attempts = 0;
  await assert.rejects(
    retryState.complete(
      retryCreated.pairingId,
      retryCreated.pairingSecret,
      async () => {
        attempts += 1;
        throw new Error("database unavailable");
      },
    ),
    /database unavailable/,
  );
  assert.deepEqual(
    await retryState.complete(
      retryCreated.pairingId,
      retryCreated.pairingSecret,
      async () => {
        attempts += 1;
        return { token: "retry-success" };
      },
    ),
    { status: "approved", value: { token: "retry-success" } },
  );
  assert.equal(attempts, 2);
});

test("does not allow another account to claim an approved pairing", () => {
  const { state } = deterministicState();
  const created = state.create("gpu-box", null);

  assert.equal(state.approve("account-1", created.userCode).status, "approved");
  assert.deepEqual(state.approve("account-2", created.userCode), {
    status: "already_claimed",
  });
  assert.equal(state.approve("account-1", created.userCode).status, "approved");
});

test("bounds anonymous pending pairing state", () => {
  const state = new DevicePairingState({ maxPendingPairings: 1 });
  state.create("gpu-box", null);
  assert.throws(
    () => state.create("second-box", null),
    DevicePairingCapacityError,
  );
});

test("expires pairing requests after five minutes", async () => {
  const { state, advance } = deterministicState();
  const created = state.create("gpu-box", null);
  advance(DEVICE_PAIRING_TTL_MS);

  assert.deepEqual(
    await state.complete(
      created.pairingId,
      created.pairingSecret,
      async () => ({ token: "must-not-issue" }),
    ),
    { status: "expired" },
  );
  assert.deepEqual(state.approve("account-1", created.userCode), {
    status: "not_found",
  });
});
