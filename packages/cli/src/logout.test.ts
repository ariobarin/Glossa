import assert from "node:assert/strict";
import test from "node:test";
import type { StoredCredentials } from "./config-store.js";
import { browserLogoutUrl, logoutFromGlossa } from "./logout.js";

const credentials: StoredCredentials = {
  issuer: "https://identity.glossa.test/",
  clientId: "client",
  audience: "https://mcp.glossa.test/",
  accessToken: "access",
  expiresAt: "2099-01-01T00:00:00.000Z",
  tokenType: "Bearer",
};
const stored = { credentials, backend: "file" as const };

test("builds the Auth0 browser logout URL", () => {
  assert.equal(
    browserLogoutUrl("https://identity.glossa.test/"),
    "https://identity.glossa.test/v2/logout",
  );
});

test("browser logout opens the Auth0 session endpoint", async () => {
  let openedUrl: string | undefined;
  const messages: string[] = [];

  await logoutFromGlossa({
    peekCredentials: async () => stored,
    deleteCredentials: async () => undefined,
    openBrowser: async (url) => {
      openedUrl = url;
      return true;
    },
    issuer: "https://identity.glossa.test/",
    log: (message) => messages.push(message),
  });

  assert.equal(openedUrl, "https://identity.glossa.test/v2/logout");
  assert.match(messages[0] ?? "", /Signed out/);
});

test("browser logout uses the stored session issuer", async () => {
  let openedUrl: string | undefined;

  await logoutFromGlossa({
    peekCredentials: async () => ({
      credentials: { ...credentials, issuer: "https://stored-identity.glossa.test/" },
      backend: "file",
    }),
    deleteCredentials: async () => undefined,
    openBrowser: async (url) => {
      openedUrl = url;
      return true;
    },
    log: () => undefined,
  });

  assert.equal(openedUrl, "https://stored-identity.glossa.test/v2/logout");
});

test("browser logout still opens when already signed out locally", async () => {
  let openedUrl: string | undefined;
  let deleted = false;
  const messages: string[] = [];

  await logoutFromGlossa({
    peekCredentials: async () => null,
    deleteCredentials: async () => {
      deleted = true;
    },
    openBrowser: async (url) => {
      openedUrl = url;
      return false;
    },
    issuer: "https://identity.glossa.test/",
    log: (message) => messages.push(message),
  });

  assert.equal(deleted, true);
  assert.equal(openedUrl, "https://identity.glossa.test/v2/logout");
  assert.equal(messages.at(-1), openedUrl);
});
