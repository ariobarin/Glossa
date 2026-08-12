import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  announceConnectHint,
  connectHintStore,
  CONNECT_HINT_URL,
  shouldShowConnectHint,
  type ConnectHintStore,
} from "./first-run.js";

test("only shows the connect hint for the managed relay", () => {
  assert.equal(shouldShowConnectHint("https://mcp.glossa.sh"), true);
  assert.equal(shouldShowConnectHint("https://mcp.example.com"), false);
  assert.equal(shouldShowConnectHint("http://localhost:39100"), false);
});

test("announces the connect hint and marks the store when not seen", async () => {
  const messages: string[] = [];
  let marked = false;
  const store: ConnectHintStore = {
    exists: async () => false,
    mark: async () => {
      marked = true;
    },
  };
  const announced = await announceConnectHint(store, (message) => messages.push(message));
  assert.equal(announced, true);
  assert.equal(marked, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /return to ChatGPT/i);
  assert.match(messages[0]!, new RegExp(CONNECT_HINT_URL));
});

test("stays quiet once the hint has been seen", async () => {
  const messages: string[] = [];
  let marked = false;
  const store: ConnectHintStore = {
    exists: async () => true,
    mark: async () => {
      marked = true;
    },
  };
  const announced = await announceConnectHint(store, (message) => messages.push(message));
  assert.equal(announced, false);
  assert.equal(marked, false);
  assert.equal(messages.length, 0);
});

test("the connect hint store round-trips through a real directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-hint-"));
  const dir = path.join(root, "config");
  try {
    const store = connectHintStore(dir);
    assert.equal(await store.exists(), false);
    const messages: string[] = [];
    assert.equal(await announceConnectHint(store, (m) => messages.push(m)), true);
    assert.equal(await store.exists(), true);
    assert.equal(await announceConnectHint(store, (m) => messages.push(m)), false);
    assert.equal(messages.length, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
