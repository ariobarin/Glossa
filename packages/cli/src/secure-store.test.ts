import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SecureStore } from "./secure-store.js";

async function withTempFile(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glossa-secure-store-"));
  try {
    await run(path.join(dir, "credentials.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("treats an unparseable keyring value as absent instead of throwing", async () => {
  await withTempFile(async (file) => {
    let deleted = false;
    const store = new SecureStore<{ token: string }>({
      account: "oauth",
      file,
      warning: "warned",
      parse: (serialized) => {
        const value = JSON.parse(serialized);
        if (typeof value !== "object" || value === null) {
          throw new Error("Stored credentials are invalid.");
        }
        return value;
      },
      warn: () => {},
      entryProvider: async () => ({
        getSecret: async () => null,
        setSecret: async () => {},
        getPassword: async () => "null",
        deleteCredential: async () => {
          deleted = true;
          return true;
        },
      }),
    });

    const loaded = await store.load();

    assert.equal(loaded, null);
    assert.equal(deleted, true);
  });
});

test("still loads valid keyring credentials", async () => {
  await withTempFile(async (file) => {
    const serialized = JSON.stringify({ token: "abc" });
    const store = new SecureStore<{ token: string }>({
      account: "oauth",
      file,
      warning: "warned",
      parse: (serialized) => JSON.parse(serialized) as { token: string },
      warn: () => {},
      entryProvider: async () => ({
        getSecret: async () => Array.from(new TextEncoder().encode(serialized)),
        setSecret: async () => {},
        getPassword: async () => null,
        deleteCredential: async () => true,
      }),
    });

    const loaded = await store.load();

    assert.deepEqual(loaded, { value: { token: "abc" }, backend: "keyring" });
  });
});

test("treats a missing native credential as empty", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-secure-store-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const store = new SecureStore<string>({
    account: "oauth",
    file: path.join(root, "credentials.json"),
    warning: "file fallback",
    parse: (serialized) => serialized,
    warn: (message) => warnings.push(message),
    entryProvider: async () => ({
      setSecret: async () => undefined,
      getSecret: async () => null,
      getPassword: async () => null,
      deleteCredential: async () => false,
    }),
  });

  assert.equal(await store.load(), null);
  await store.delete();
  assert.deepEqual(warnings, []);
});

test("reports failed native credential deletion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-secure-store-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const file = path.join(root, "credentials.json");
  await writeFile(file, "fallback-secret", "utf8");
  const store = new SecureStore<string>({
    account: "oauth",
    file,
    warning: "file fallback",
    parse: (serialized) => serialized,
    entryProvider: async () => ({
      setSecret: async () => undefined,
      getSecret: async () => new TextEncoder().encode("oauth-secret"),
      getPassword: async () => "oauth-secret",
      deleteCredential: async () => false,
    }),
  });

  await assert.rejects(
    store.delete(),
    /credential store could not remove the Glossa credential/,
  );
  assert.equal((await store.load())?.value, "oauth-secret");
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("peek reads a file credential without migrating it to the keyring", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-secure-store-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const file = path.join(root, "credentials.json");
  await writeFile(file, JSON.stringify({ token: "file-secret" }), "utf8");
  let setSecretCalls = 0;
  const store = new SecureStore<{ token: string }>({
    account: "oauth",
    file,
    warning: "file fallback",
    parse: (serialized) => JSON.parse(serialized) as { token: string },
    warn: () => {},
    entryProvider: async () => ({
      getSecret: async () => null,
      setSecret: async () => {
        setSecretCalls += 1;
      },
      getPassword: async () => null,
      deleteCredential: async () => true,
    }),
  });

  const peeked = await store.peek();

  assert.deepEqual(peeked, { value: { token: "file-secret" }, backend: "file" });
  assert.equal(setSecretCalls, 0);
  assert.equal(await readFile(file, "utf8"), JSON.stringify({ token: "file-secret" }));
});

test("stores a Windows-sized OAuth credential as bytes", async () => {
  await withTempFile(async (file) => {
    const value = { token: "x".repeat(1_327) };
    let stored: Uint8Array | undefined;
    const warnings: string[] = [];
    const store = new SecureStore<typeof value>({
      account: "oauth",
      file,
      warning: "file fallback",
      parse: (serialized) => JSON.parse(serialized) as typeof value,
      warn: (message) => warnings.push(message),
      entryProvider: async () => ({
        getSecret: async () => stored,
        setSecret: async (secret) => {
          stored = secret;
        },
        getPassword: async () => null,
        deleteCredential: async () => true,
      }),
    });

    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf16le") > 2_560);
    assert.equal(await store.save(value), "keyring");
    assert.equal(stored?.byteLength, JSON.stringify(value).length);
    assert.deepEqual(await store.load(), { value, backend: "keyring" });
    assert.deepEqual(warnings, []);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  });
});

test("migrates a legacy password entry to bytes", async () => {
  await withTempFile(async (file) => {
    const value = { token: "legacy" };
    const serialized = JSON.stringify(value);
    let stored: Uint8Array = new Uint8Array(Buffer.from(serialized, "utf16le"));
    let password: string | null = serialized;
    const store = new SecureStore<typeof value>({
      account: "oauth",
      file,
      warning: "file fallback",
      parse: (candidate) => JSON.parse(candidate) as typeof value,
      warn: () => {},
      entryProvider: async () => ({
        getSecret: async () => stored,
        setSecret: async (secret) => {
          stored = secret;
          password = null;
        },
        getPassword: async () => password,
        deleteCredential: async () => true,
      }),
    });

    assert.deepEqual(await store.load(), { value, backend: "keyring" });
    assert.equal(new TextDecoder().decode(stored), serialized);
    assert.equal(password, null);
  });
});

test("warns only once while reusing a file fallback", async () => {
  await withTempFile(async (file) => {
    const value = { token: "file-secret" };
    await writeFile(file, JSON.stringify(value), "utf8");
    const warnings: string[] = [];
    const store = new SecureStore<typeof value>({
      account: "oauth",
      file,
      warning: "file fallback",
      parse: (serialized) => JSON.parse(serialized) as typeof value,
      warn: (message) => warnings.push(message),
      entryProvider: async () => ({
        getSecret: async () => null,
        setSecret: async () => {
          throw new Error("credential store unavailable");
        },
        getPassword: async () => null,
        deleteCredential: async () => false,
      }),
    });

    assert.deepEqual(await store.load(), { value, backend: "file" });
    assert.deepEqual(await store.load(), { value, backend: "file" });
    assert.deepEqual(warnings, ["file fallback"]);
  });
});

test(
  "round-trips the native operating-system credential store",
  { skip: process.env.GLOSSA_TEST_NATIVE_KEYRING !== "1" },
  async (context) => {
    await withTempFile(async (file) => {
      const value = { token: `integration-${randomUUID()}` };
      const warnings: string[] = [];
      const store = new SecureStore<typeof value>({
        account: `integration-${randomUUID()}`,
        file,
        warning: "file fallback",
        parse: (serialized) => JSON.parse(serialized) as typeof value,
        warn: (message) => warnings.push(message),
      });
      context.after(async () => {
        await store.delete();
      });

      assert.equal(await store.save(value), "keyring");
      assert.deepEqual(await store.load(), { value, backend: "keyring" });
      assert.deepEqual(warnings, []);

      await store.delete();
      assert.equal(await store.load(), null);
    });
  },
);
