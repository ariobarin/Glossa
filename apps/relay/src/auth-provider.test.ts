import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import {
  requireAuth,
  subjectIsAllowedIdentity,
  type AuthenticatedRequest,
} from "./auth.js";
import { loadConfig } from "./config.js";
import type { RelaySecurityEvent } from "./security-event.js";

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

test("emits identifier-free OAuth failure events", async () => {
  const events: RelaySecurityEvent[] = [];
  const middleware = requireAuth(
    config(),
    "glossa:access",
    (event) => events.push(event),
  );
  let statusCode = 0;
  let responseBody: unknown;
  const request = {
    header: () => undefined,
  } as unknown as AuthenticatedRequest;
  const response = {
    setHeader: () => response,
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    json: (body: unknown) => {
      responseBody = body;
      return response;
    },
  } as unknown as Response;
  let nextCalled = false;

  await middleware(request, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 401);
  assert.deepEqual(responseBody, { error: "authentication_required" });
  assert.deepEqual(events, [{
    event: "relay_security_event",
    surface: "mcp_oauth",
    category: "authentication_required",
  }]);
  assert.deepEqual(Object.keys(events[0]!).sort(), ["category", "event", "surface"]);
});

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

test("rejects the removed singular subject-prefix setting", () => {
  assert.throws(
    () => config({ GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIX: "github|" }),
    /has been removed.*GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES/,
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
