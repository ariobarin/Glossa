import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { Store } from "./store.js";

interface QueryCall {
  sql: string;
  values: unknown[];
}

function storeFixture(...rowSets: unknown[][]): {
  store: Store;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const results = [...rowSets];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const rows = results.shift();
      if (!rows) throw new Error("Unexpected query.");
      return {
        command: "",
        rowCount: rows.length,
        oid: 0,
        fields: [],
        rows,
      };
    },
    async end() {},
  };
  return {
    store: new Store(
      "postgres://unused",
      pool as unknown as Pool,
    ),
    calls,
  };
}

const accountId = "00000000-0000-4000-8000-000000000001";
const subject = "google-oauth2|account";

test("uses a lock-only lookup for an admitted account", async () => {
  const { store, calls } = storeFixture([
    {
      id: accountId,
      admitted_at: new Date("2026-01-01T00:00:00Z"),
      disabled_at: null,
    },
  ]);

  assert.equal(await store.accountIdForSubject(subject), accountId);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /^SELECT id, admitted_at, disabled_at/m);
  assert.match(calls[0]!.sql, /FOR NO KEY UPDATE/);
  assert.doesNotMatch(calls[0]!.sql, /^(INSERT|UPDATE)\b/m);
  assert.deepEqual(calls[0]!.values, [subject]);
});

test("rejects a disabled account without writing it", async () => {
  const { store, calls } = storeFixture([
    {
      id: accountId,
      admitted_at: new Date("2026-01-01T00:00:00Z"),
      disabled_at: new Date("2026-01-02T00:00:00Z"),
    },
  ]);

  assert.equal(await store.accountIdForSubject(subject), null);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!.sql, /^(INSERT|UPDATE)\b/m);
});

test("admits an active legacy account only when needed", async () => {
  const { store, calls } = storeFixture(
    [{ id: accountId, admitted_at: null, disabled_at: null }],
    [{ id: accountId }],
  );

  assert.equal(await store.accountIdForSubject(subject), accountId);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.sql, /^INSERT INTO accounts/m);
  assert.match(calls[1]!.sql, /ON CONFLICT \(auth0_subject\) DO UPDATE/);
});

test("creates a new account after a read miss", async () => {
  const { store, calls } = storeFixture([], [{ id: accountId }]);

  assert.equal(await store.accountIdForSubject(subject), accountId);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.sql, /^SELECT/m);
  assert.match(calls[0]!.sql, /FOR NO KEY UPDATE/);
  assert.match(calls[1]!.sql, /^INSERT INTO accounts/m);
  assert.equal(calls[1]!.values[1], subject);
});

test("keeps a concurrent disabled-account conflict rejected", async () => {
  const { store, calls } = storeFixture([], []);

  assert.equal(await store.accountIdForSubject(subject), null);
  assert.equal(calls.length, 2);
});
