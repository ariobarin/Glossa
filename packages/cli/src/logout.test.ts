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
  assert.equal(
    browserLogoutUrl("https://identity.glossa.test"),
    "https://identity.glossa.test/v2/logout",
  );
});

test("browser sign-out opens only after confirmation", async () => {
  let openedUrl: string | undefined;
  const messages: string[] = [];

  await logoutFromGlossa({
    peekCredentials: async () => stored,
    deleteCredentials: async () => undefined,
    confirmBrowserSignOut: async () => true,
    openBrowser: async (url) => {
      openedUrl = url;
      return true;
    },
    issuer: "https://identity.glossa.test/",
    log: (message) => messages.push(message),
  });

  assert.equal(openedUrl, "https://identity.glossa.test/v2/logout");
  assert.match(messages[0] ?? "", /Signed out/);
  assert.equal(messages.at(-1), "Opened Glossa browser sign-out.");
});

test("browser sign-out prints the URL when skipped", async () => {
  let openCalled = false;
  const messages: string[] = [];

  await logoutFromGlossa({
    peekCredentials: async () => stored,
    deleteCredentials: async () => undefined,
    confirmBrowserSignOut: async () => false,
    openBrowser: async () => {
      openCalled = true;
      return true;
    },
    issuer: "https://identity.glossa.test/",
    log: (message) => messages.push(message),
  });

  assert.equal(openCalled, false);
  assert.equal(
    messages.at(-1),
    "Finish signing out in the browser when needed: https://identity.glossa.test/v2/logout",
  );
});

test("browser sign-out prints the URL when the browser cannot open", async () => {
  const messages: string[] = [];

  await logoutFromGlossa({
    peekCredentials: async () => stored,
    deleteCredentials: async () => undefined,
    confirmBrowserSignOut: async () => true,
    openBrowser: async () => false,
    issuer: "https://identity.glossa.test/",
    log: (message) => messages.push(message),
  });

  assert.match(messages.at(-1) ?? "", /https:\/\/identity\.glossa\.test\/v2\/logout$/);
});

test("browser sign-out uses the stored session issuer", async () => {
  let openedUrl: string | undefined;

  await logoutFromGlossa({
    peekCredentials: async () => ({
      credentials: { ...credentials, issuer: "https://stored-identity.glossa.test/" },
      backend: "file",
    }),
    deleteCredentials: async () => undefined,
    confirmBrowserSignOut: async () => true,
    openBrowser: async (url) => {
      openedUrl = url;
      return true;
    },
    log: () => undefined,
  });

  assert.equal(openedUrl, "https://stored-identity.glossa.test/v2/logout");
});

test("logout still deletes and reports when already signed out locally", async () => {
  let deleted = false;
  const messages: string[] = [];

  await logoutFromGlossa({
    peekCredentials: async () => null,
    deleteCredentials: async () => {
      deleted = true;
    },
    confirmBrowserSignOut: async () => false,
    openBrowser: async () => {
      throw new Error("browser should not open");
    },
    issuer: "https://identity.glossa.test/",
    log: (message) => messages.push(message),
  });

  assert.equal(deleted, true);
  assert.match(messages[0] ?? "", /Already signed out/);
  assert.match(messages.at(-1) ?? "", /v2\/logout$/);
});
