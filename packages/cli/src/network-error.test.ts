import assert from "node:assert/strict";
import test from "node:test";
import {
  NetworkRequestError,
  normalizeNetworkError,
  withNetworkErrors,
} from "./network-error.js";

function fetchFailure(code: string, message: string): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError("fetch failed", { cause });
}

test("turns opaque fetch failures into actionable connection errors", () => {
  const original = fetchFailure(
    "ECONNREFUSED",
    "connect ECONNREFUSED 127.0.0.1:39100",
  );
  const normalized = normalizeNetworkError(original);

  assert.ok(normalized instanceof NetworkRequestError);
  assert.equal(normalized.code, "ECONNREFUSED");
  assert.equal(
    normalized.message,
    "Could not connect to the Glossa relay; the connection was refused.",
  );
  assert.equal(normalized.cause, original);
});

test("distinguishes DNS, timeout, interruption, and TLS failures", () => {
  assert.match(
    normalizeNetworkError(fetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND relay")).message,
    /resolve the Glossa relay/,
  );
  assert.match(
    normalizeNetworkError(fetchFailure("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")).message,
    /timed out/,
  );
  assert.match(
    normalizeNetworkError(fetchFailure("ECONNRESET", "socket hang up")).message,
    /was interrupted/,
  );
  assert.match(
    normalizeNetworkError(fetchFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify")).message,
    /trusted TLS connection/,
  );
});

test("preserves cancellation errors", async () => {
  const aborted = new Error("This operation was aborted");
  aborted.name = "AbortError";

  await assert.rejects(
    withNetworkErrors(async () => {
      throw aborted;
    }),
    (error: unknown) => error === aborted,
  );
});
