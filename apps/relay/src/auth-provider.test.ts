import assert from "node:assert/strict";
import test from "node:test";
import { subjectIsAllowedIdentity } from "./auth.js";
import { loadConfig } from "./config.js";

function config(environment: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    GLOSSA_PUBLIC_ORIGIN: "https://mcp.glossa.test",
    GLOSSA_AUTH0_ISSUER: "https://identity.glossa.test/",
    GLOSSA_AUTH0_AUDIENCE: "https://mcp.glossa.test/",
    ...environment,
  });
}

test("managed identity defaults to Google subjects", () => {
  const managed = config();

  assert.deepEqual(managed.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES, [
    "google-oauth2|",
  ]);
  assert.deepEqual(managed.GLOSSA_AUTH0_ALLOWED_SUBJECTS, []);
  assert.equal(
    subjectIsAllowedIdentity(managed, "google-oauth2|123456789"),
    true,
  );
  assert.equal(subjectIsAllowedIdentity(managed, "auth0|reviewer"), false);
});

test("managed review can allow one exact database identity alongside Google", () => {
  const reviewReady = config({
    GLOSSA_AUTH0_ALLOWED_SUBJECTS: "auth0|openai-reviewer",
  });

  assert.deepEqual(reviewReady.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES, [
    "google-oauth2|",
  ]);
  assert.deepEqual(reviewReady.GLOSSA_AUTH0_ALLOWED_SUBJECTS, [
    "auth0|openai-reviewer",
  ]);
  assert.equal(
    subjectIsAllowedIdentity(reviewReady, "google-oauth2|123456789"),
    true,
  );
  assert.equal(
    subjectIsAllowedIdentity(reviewReady, "auth0|openai-reviewer"),
    true,
  );
  assert.equal(subjectIsAllowedIdentity(reviewReady, "auth0|other-user"), false);
  assert.equal(subjectIsAllowedIdentity(reviewReady, "github|123456789"), false);
});

test("self-hosted relays retain the legacy single-prefix setting", () => {
  const selfHosted = config({
    GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX: "github|",
  });

  assert.deepEqual(selfHosted.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES, ["github|"]);
  assert.equal(subjectIsAllowedIdentity(selfHosted, "github|123456789"), true);
  assert.equal(
    subjectIsAllowedIdentity(selfHosted, "google-oauth2|123456789"),
    false,
  );
});

test("provider prefix configuration rejects ambiguous or unsafe values", () => {
  assert.throws(
    () => config({ GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: "google-oauth2" }),
    /Auth0 subject prefix must end with \|/,
  );
  assert.throws(
    () => config({ GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: "google-oauth2|," }),
  );
  assert.throws(
    () =>
      config({
        GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: "google-oauth2|,google-oauth2|",
      }),
    /Auth0 subject prefixes must be unique/,
  );
  assert.throws(
    () =>
      config({
        GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES: "google-oauth2|,auth0|",
        GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX: "google-oauth2|",
      }),
    /either plural or legacy singular Auth0 subject prefixes/,
  );
});

test("exact identity configuration rejects malformed and duplicate subjects", () => {
  assert.throws(
    () => config({ GLOSSA_AUTH0_ALLOWED_SUBJECTS: "auth0|" }),
    /provider prefix and user identifier/,
  );
  assert.throws(
    () => config({ GLOSSA_AUTH0_ALLOWED_SUBJECTS: "auth0|reviewer," }),
  );
  assert.throws(
    () =>
      config({
        GLOSSA_AUTH0_ALLOWED_SUBJECTS: "auth0|reviewer,auth0|reviewer",
      }),
    /Exact Auth0 subjects must be unique/,
  );
  assert.throws(
    () => config({ GLOSSA_AUTH0_ALLOWED_SUBJECTS: "auth0|reviewer name" }),
    /provider prefix and user identifier/,
  );
});
