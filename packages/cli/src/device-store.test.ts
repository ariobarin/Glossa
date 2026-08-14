import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDeviceCredential } from "./device-store.js";
import { SecureStore } from "./secure-store.js";

async function temporaryStore(
  context: test.TestContext,
): Promise<{ file: string; store: SecureStore<ReturnType<typeof parseDeviceCredential>> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-device-store-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "device.json");
  return {
    file,
    store: new SecureStore({
      account: "device-test",
      file,
      warning: "unused",
      parse: parseDeviceCredential,
      entryProvider: async () => null,
    }),
  };
}

test("device reads reject truncated credential files", async (context) => {
  const { file, store } = await temporaryStore(context);
  await writeFile(file, '{"relayOrigin":', "utf8");

  await assert.rejects(store.load(), /Stored Glossa device credentials are invalid/);
});

test("device reads reject malformed credential files", async (context) => {
  const { file, store } = await temporaryStore(context);
  await writeFile(
    file,
    JSON.stringify({
      relayOrigin: "https://mcp.glossa.test/path",
      deviceId: "not-a-device-id",
      deviceName: "Workstation",
      token: "broken",
    }),
    "utf8",
  );

  await assert.rejects(store.load(), /Stored Glossa device credentials are invalid/);
});

test("accepts legacy and account-bound device credentials", () => {
  const legacy = {
    relayOrigin: "https://mcp.glossa.test",
    deviceId: "00000000-0000-4000-8000-000000000001",
    deviceName: "Workstation",
    token: "gld_00000000-0000-4000-8000-000000000001_secret",
  };
  assert.deepEqual(parseDeviceCredential(JSON.stringify(legacy)), legacy);
  assert.equal(
    parseDeviceCredential(JSON.stringify({
      ...legacy,
      accountSubject: "google-oauth2|account-1",
    })).accountSubject,
    "google-oauth2|account-1",
  );
  assert.throws(
    () => parseDeviceCredential(JSON.stringify({
      ...legacy,
      accountSubject: "",
    })),
    /Stored Glossa device credentials are invalid/,
  );
});
