import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdate, npmInstallInvocation } from "./update-service.js";

function registryFetch(tags: Record<string, string>): typeof fetch {
  return async () => new Response(
    JSON.stringify({ "dist-tags": tags }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("uses npm dist-tags and SemVer ordering for release channels", async () => {
  const beta = await checkForUpdate("0.1.0-beta.9", "beta", {
    fetchImpl: registryFetch({ beta: "0.1.0-beta.12", latest: "0.1.0-beta.6" }),
  });
  assert.equal(beta.availableVersion, "0.1.0-beta.12");
  assert.equal(beta.updateAvailable, true);

  await assert.rejects(
    checkForUpdate("0.1.0-beta.13", "stable", {
      fetchImpl: registryFetch({ beta: "0.1.0-beta.13", latest: "0.1.0-beta.6" }),
    }),
    /No stable Glossa release/,
  );
});

test("reports a missing stable channel clearly", async () => {
  await assert.rejects(
    checkForUpdate("0.1.0-beta.13", "stable", {
      fetchImpl: registryFetch({ beta: "0.1.0-beta.13" }),
    }),
    /No stable Glossa release/,
  );
});

test("routes Windows npm updates through cmd.exe", () => {
  assert.deepEqual(
    npmInstallInvocation("0.1.1", "win32", "C:\\Windows\\System32\\cmd.exe"),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm.cmd install --global @ariobarin/glossa@0.1.1",
      ],
    },
  );
  assert.deepEqual(npmInstallInvocation("0.1.1", "linux"), {
    command: "npm",
    args: ["install", "--global", "@ariobarin/glossa@0.1.1"],
  });
  assert.throws(
    () => npmInstallInvocation("0.1.1 & echo unsafe", "win32", "cmd.exe"),
    /invalid/,
  );
});
