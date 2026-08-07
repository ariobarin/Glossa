import assert from "node:assert/strict";
import test from "node:test";
import {
  containsRestrictedAuthenticationData,
  deviceNameSchema,
  stringContainsRestrictedAuthenticationData,
  workspaceLabelSchema,
} from "@glossa/protocol";

function syntheticOpenAiKey(): string {
  return "sk-proj-" + "A".repeat(32);
}

test("detects recognizable authentication secrets", () => {
  const key = syntheticOpenAiKey();
  assert.equal(stringContainsRestrictedAuthenticationData(key), true);
  assert.equal(
    stringContainsRestrictedAuthenticationData(`OPENAI_API_KEY=${key}`),
    true,
  );
  assert.equal(
    stringContainsRestrictedAuthenticationData(
      `Authorization: Bearer ${"B".repeat(32)}`,
    ),
    true,
  );
  assert.equal(
    stringContainsRestrictedAuthenticationData(
      ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" "),
    ),
    true,
  );
  assert.equal(
    stringContainsRestrictedAuthenticationData([
      "eyJ" + "A".repeat(16),
      "B".repeat(16),
      "C".repeat(16),
    ].join(".")),
    true,
  );
  assert.equal(
    containsRestrictedAuthenticationData({ nested: [{ output: key }] }),
    true,
  );
});

test("does not block credential names or explicit placeholders", () => {
  for (const value of [
    "process.env.OPENAI_API_KEY",
    "OPENAI_API_KEY=<redacted>",
    "password: placeholder-value",
    "AUTH_TOKEN=replace-me",
    "This test verifies credential handling without including a credential.",
    'accessToken: "access",',
    'refreshToken: data.refresh_token ?? credentials.refreshToken,',
    [
      "printf '%s\\n' \"https://heroku:",
      "${HEROKU_API_KEY}",
      "@git.heroku.com\"",
    ].join(""),
  ]) {
    assert.equal(
      stringContainsRestrictedAuthenticationData(value),
      false,
      value,
    );
  }
});

test("rejects restricted authentication data in public worker metadata", () => {
  const key = syntheticOpenAiKey();
  assert.equal(deviceNameSchema.safeParse(key).success, false);
  assert.equal(workspaceLabelSchema.safeParse(key).success, false);
  assert.equal(deviceNameSchema.safeParse("Review workstation").success, true);
  assert.equal(workspaceLabelSchema.safeParse("frontend").success, true);
});
