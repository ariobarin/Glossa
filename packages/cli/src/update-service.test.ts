import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkForUpdate,
  cleanupUpdateBackups,
  installUpdate,
  npmInstallInvocation,
  parseReleaseChecksum,
  standaloneAssetName,
} from "./update-service.js";

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

test("maps every published standalone target", () => {
  assert.equal(standaloneAssetName("win32", "x64"), "glossa-windows-x64.exe");
  assert.equal(standaloneAssetName("win32", "arm64"), "glossa-windows-arm64.exe");
  assert.equal(standaloneAssetName("linux", "x64"), "glossa-linux-x64");
  assert.equal(standaloneAssetName("linux", "arm64"), "glossa-linux-arm64");
  assert.equal(standaloneAssetName("darwin", "x64"), "glossa-macos-x64");
  assert.equal(standaloneAssetName("darwin", "arm64"), "glossa-macos-arm64");
  assert.throws(() => standaloneAssetName("aix", "ppc64"), /does not publish/);
});

test("accepts only the checksum for the requested asset", () => {
  const hash = "a".repeat(64);
  assert.equal(parseReleaseChecksum(`${hash}  glossa-linux-x64\n`, "glossa-linux-x64"), hash);
  assert.throws(
    () => parseReleaseChecksum(`${hash}  another-file\n`, "glossa-linux-x64"),
    /checksum file was invalid/,
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

test("downloads, verifies, and atomically installs a standalone update", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-install-"));
  const executable = path.join(directory, "glossa");
  const binary = new TextEncoder().encode("new glossa binary");
  const hash = createHash("sha256").update(binary).digest("hex");
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith(".sha256")) {
      return new Response(`${hash}  glossa-linux-x64\n`, { status: 200 });
    }
    return new Response(binary, { status: 200 });
  };

  try {
    const result = await installUpdate(
      {
        currentVersion: "0.1.0-beta.13",
        availableVersion: "0.1.0-beta.14",
        channel: "beta",
        updateAvailable: true,
      },
      "standalone",
      {
        fetchImpl,
        releaseBaseUrl: "https://releases.example.test",
        platform: "linux",
        architecture: "x64",
        executablePath: executable,
      },
    );
    assert.equal(result, "installed");
    assert.deepEqual(Array.from(await readFile(executable)), Array.from(binary));
    assert.deepEqual(requested, [
      "https://releases.example.test/cli-v0.1.0-beta.14/glossa-linux-x64",
      "https://releases.example.test/cli-v0.1.0-beta.14/glossa-linux-x64.sha256",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a standalone update with a mismatched checksum", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-install-"));
  const executable = path.join(directory, "glossa");
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith(".sha256")) {
      return new Response(`${"0".repeat(64)}  glossa-linux-x64\n`, { status: 200 });
    }
    return new Response("tampered", { status: 200 });
  };

  try {
    await assert.rejects(
      installUpdate(
        {
          currentVersion: "0.1.0-beta.13",
          availableVersion: "0.1.0-beta.14",
          channel: "beta",
          updateAvailable: true,
        },
        "standalone",
        {
          fetchImpl,
          releaseBaseUrl: "https://releases.example.test",
          platform: "linux",
          architecture: "x64",
          executablePath: executable,
        },
      ),
      /checksum did not match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("replaces a running-style Windows executable and cleans its backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "glossa-update-windows-"));
  const executable = path.join(directory, "glossa.exe");
  const binary = new TextEncoder().encode("new windows glossa binary");
  const hash = createHash("sha256").update(binary).digest("hex");
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith(".sha256")) {
      return new Response(`${hash}  glossa-windows-x64.exe\n`, { status: 200 });
    }
    return new Response(binary, { status: 200 });
  };

  try {
    await writeFile(executable, "old windows glossa binary", "utf8");
    await installUpdate(
      {
        currentVersion: "0.1.0-beta.13",
        availableVersion: "0.1.0-beta.14",
        channel: "beta",
        updateAvailable: true,
      },
      "standalone",
      {
        fetchImpl,
        releaseBaseUrl: "https://releases.example.test",
        platform: "win32",
        architecture: "x64",
        executablePath: executable,
      },
    );

    assert.deepEqual(Array.from(await readFile(executable)), Array.from(binary));
    const backups = (await readdir(directory)).filter((file) =>
      file.startsWith("glossa.exe.old-")
    );
    assert.equal(backups.length, 1);
    assert.equal(
      await readFile(path.join(directory, backups[0]!), "utf8"),
      "old windows glossa binary",
    );

    await cleanupUpdateBackups("standalone", {
      platform: "win32",
      executablePath: executable,
    });
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["glossa.exe", backups[0]!].sort(),
    );

    const staleBackup = `${executable}.old-2147483647-${Date.now()}`;
    await rename(path.join(directory, backups[0]!), staleBackup);
    await cleanupUpdateBackups("standalone", {
      platform: "win32",
      executablePath: executable,
    });
    assert.deepEqual(await readdir(directory), ["glossa.exe"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
