import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireWorkspaceLease,
  WorkspaceAlreadyActiveError,
} from "./workspace-lease.js";

async function temporaryDirectory(
  context: { after(callback: () => Promise<void>): void },
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "glossa-lease-test-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

test("allows only one process lease for a canonical workspace", async (context) => {
  const directory = await temporaryDirectory(context);
  const root = path.join(directory, "workspace");
  const first = await acquireWorkspaceLease(root, { directory });
  context.after(async () => await first.release());

  await assert.rejects(
    acquireWorkspaceLease(root, { directory }),
    (error: unknown) =>
      error instanceof WorkspaceAlreadyActiveError &&
      /already exposed/.test(error.message),
  );

  await first.release();
  const replacement = await acquireWorkspaceLease(root, { directory });
  await replacement.release();
});

test("allows different canonical workspaces concurrently", async (context) => {
  const directory = await temporaryDirectory(context);
  const first = await acquireWorkspaceLease(path.join(directory, "one"), { directory });
  const second = await acquireWorkspaceLease(path.join(directory, "two"), { directory });
  await Promise.all([first.release(), second.release()]);
});

test("rejects a second operating-system process for the same workspace", async (context) => {
  const directory = await temporaryDirectory(context);
  const root = path.join(directory, "workspace");
  const moduleUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "workspace-lease.ts"),
  ).href;
  const script = `
    const { acquireWorkspaceLease } = await import(process.env.GLOSSA_LEASE_MODULE);
    const lease = await acquireWorkspaceLease(process.env.GLOSSA_LEASE_ROOT, {
      directory: process.env.GLOSSA_LEASE_DIRECTORY,
    });
    process.stdout.write("ready\\n");
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("end", resolve));
    await lease.release();
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: {
        ...process.env,
        GLOSSA_LEASE_MODULE: moduleUrl,
        GLOSSA_LEASE_ROOT: root,
        GLOSSA_LEASE_DIRECTORY: directory,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  context.after(() => {
    if (child.exitCode === null) child.kill();
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("ready\n")) {
        reject(new Error(`Lease child exited before ready with code ${code}.`));
      }
    });
  });

  await assert.rejects(
    acquireWorkspaceLease(root, { directory }),
    WorkspaceAlreadyActiveError,
  );
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);

  const replacement = await acquireWorkspaceLease(root, { directory });
  await replacement.release();
});
test("chooses exactly one winner during concurrent acquisition", async (context) => {
  const directory = await temporaryDirectory(context);
  const root = path.join(directory, "workspace");
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, async () => await acquireWorkspaceLease(root, { directory })),
  );
  const acquired = attempts.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireWorkspaceLease>>> =>
      result.status === "fulfilled",
  );
  const rejected = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((result) => result.reason instanceof WorkspaceAlreadyActiveError));
  await acquired[0]!.value.release();
});
