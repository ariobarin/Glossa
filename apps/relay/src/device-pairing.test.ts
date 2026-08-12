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

test("approves by human code and completes only with the private pairing secret", () => {
  const { state } = deterministicState();
  const created = state.create("gpu-box", "linux-x64");

  assert.deepEqual(state.complete(created.pairingId, "wrong"), { status: "invalid" });
  assert.deepEqual(state.complete(created.pairingId, created.pairingSecret), {
    status: "pending",
  });

  const approval = state.approve("account-1", created.userCode.toLowerCase());
  assert.equal(approval.status, "approved");
  if (approval.status === "approved") {
    assert.equal(approval.pairing.name, "gpu-box");
    assert.equal(approval.pairing.platform, "linux-x64");
  }

  assert.deepEqual(state.complete(created.pairingId, created.pairingSecret), {
    status: "approved",
    accountId: "account-1",
    name: "gpu-box",
    platform: "linux-x64",
  });
  assert.deepEqual(state.complete(created.pairingId, created.pairingSecret), {
    status: "invalid",
  });
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

test("expires pairing requests after five minutes", () => {
  const { state, advance } = deterministicState();
  const created = state.create("gpu-box", null);
  advance(DEVICE_PAIRING_TTL_MS);

  assert.deepEqual(state.complete(created.pairingId, created.pairingSecret), {
    status: "expired",
  });
  assert.deepEqual(state.approve("account-1", created.userCode), {
    status: "not_found",
  });
});
