import assert from "node:assert/strict";
import test from "node:test";
import { BindingState } from "./binding-state.js";

const account = "00000000-0000-4000-8000-000000000001";
const otherAccount = "00000000-0000-4000-8000-000000000002";
const alpha = "00000000-0000-4000-8000-000000000003";
const beta = "00000000-0000-4000-8000-000000000004";

function selected(
  result: ReturnType<BindingState["select"]>,
): Exclude<ReturnType<BindingState["select"]>, string> {
  if (typeof result === "string") assert.fail(`Unexpected ${result}`);
  return result;
}

test("replaces one session binding and counts independent sessions", () => {
  const state = new BindingState();
  assert.equal(selected(state.select(account, "session-a", undefined, alpha)).binding.workspaceId, alpha);
  assert.equal(selected(state.select(account, "session-a", undefined, beta)).binding.workspaceId, beta);
  assert.equal(selected(state.select(account, "session-b", undefined, beta)).binding.workspaceId, beta);
  assert.equal(state.count(account, alpha), 0);
  assert.equal(state.count(account, beta), 2);
});

test("issues account-scoped fallback tokens", () => {
  const state = new BindingState();
  const binding = selected(state.select(account, undefined, undefined, alpha));
  const token = binding.bindingToken!;
  assert.match(token, /^glt_[A-Za-z0-9_-]{43}$/);
  const resolved = state.resolve(account, undefined, token);
  if (resolved === "invalid") assert.fail("Expected a valid token binding");
  assert.equal(resolved?.workspaceId, alpha);
  assert.equal(state.resolve(otherAccount, undefined, token), "invalid");
  assert.equal(selected(state.select(account, undefined, token, beta)).binding.workspaceId, beta);
});

test("renews active bindings and expires inactive bindings", () => {
  let now = 1_000;
  const state = new BindingState(100, () => now);
  state.select(account, "session", undefined, alpha);
  now = 1_050;
  const renewed = state.resolve(account, "session", undefined);
  if (renewed === "invalid") assert.fail("Expected a valid session binding");
  assert.equal(renewed?.expiresAt, 1_150);
  now = 1_149;
  assert.equal(state.count(account, alpha), 1);
  now = 1_250;
  assert.equal(state.resolve(account, "session", undefined), null);
});

test("rejects conflicting or unknown binding context", () => {
  const state = new BindingState();
  assert.equal(state.resolve(account, 42, undefined), "invalid");
  assert.equal(state.resolve(account, "session", `glt_${"a".repeat(43)}`), "invalid");
  assert.equal(state.resolve(account, undefined, `glt_${"a".repeat(43)}`), "invalid");
});
