import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import {
  databaseOptions,
  relayPoolOptions,
} from "./database-options.js";

const databaseUrl = "postgres://user:password@database.example/glossa";

function ssl(environment: NodeJS.ProcessEnv): unknown {
  const client = new Client(databaseOptions(databaseUrl, environment));
  return (client as unknown as { connectionParameters: { ssl: unknown } })
    .connectionParameters.ssl;
}

test("verifies production database certificates", () => {
  assert.deepEqual(ssl({ NODE_ENV: "production" }), {
    rejectUnauthorized: true,
  });
  assert.deepEqual(
    ssl({
      NODE_ENV: "production",
      GLOSSA_DATABASE_CA_PEM: "  trusted-ca  ",
    }),
    { rejectUnauthorized: true, ca: "trusted-ca" },
  );
});

test("selects the configured database TLS mode", () => {
  assert.deepEqual(
    ssl({
      NODE_ENV: "production",
      GLOSSA_DATABASE_SSL_MODE: "require",
    }),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    ssl({
      NODE_ENV: "production",
      DYNO: "release.1",
    }),
    { rejectUnauthorized: false },
  );
  assert.deepEqual(
    ssl({
      NODE_ENV: "production",
      DYNO: "release.1",
      GLOSSA_DATABASE_SSL_MODE: "verify-full",
    }),
    { rejectUnauthorized: true },
  );
});

test("rejects conflicting or invalid database TLS settings", () => {
  assert.throws(
    () =>
      databaseOptions(databaseUrl, {
        NODE_ENV: "production",
        GLOSSA_DATABASE_SSL_MODE: "require",
        GLOSSA_DATABASE_CA_PEM: "trusted-ca",
      }),
    /cannot be used/,
  );
  assert.throws(
    () =>
      databaseOptions(databaseUrl, {
        NODE_ENV: "production",
        GLOSSA_DATABASE_SSL_MODE: "disabled",
      }),
    /must be verify-full or require/,
  );
});

test("rejects production URL parameters that override TLS", () => {
  for (const parameter of [
    "ssl=false",
    "sslmode=disable",
    "sslmode=no-verify",
    "sslmode=require",
    "sslrootcert=database-ca.pem",
  ]) {
    assert.throws(
      () =>
        databaseOptions(`${databaseUrl}?${parameter}`, {
          NODE_ENV: "production",
        }),
      /must not contain SSL parameters/,
    );
  }
});

test("does not expose an invalid database URL in errors", () => {
  assert.throws(
    () => databaseOptions("not a URL with secret-password", { NODE_ENV: "production" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "DATABASE_URL must be a valid Postgres URL." &&
      !error.message.includes("secret-password"),
  );
});

test("does not enable TLS for local development", () => {
  assert.deepEqual(databaseOptions(databaseUrl, { NODE_ENV: "development" }), {
    connectionString: databaseUrl,
    ssl: undefined,
  });
});

test("keeps relay database connections across worker polls", () => {
  assert.deepEqual(
    relayPoolOptions(databaseUrl, { NODE_ENV: "development" }),
    {
      connectionString: databaseUrl,
      ssl: undefined,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 60_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  );
});
