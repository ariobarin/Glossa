import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withProcessLease } from "./process-lease.js";

const options = { lockName: "lease", pollMs: 10, maxAgeMs: 60_000, guardMaxAgeMs: 30_000 };

for (const lockName of ["lease", "lease.guard"]) {
  test(`bounds exclusive-open recovery for ${lockName}`, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "glossa-lease-open-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, lockName);
    const originalWrite = fs.writeFile;
    for (const scenario of ["transient", "persistent", "abort", "write", "access"] as const) {
      await fs.rm(path.join(directory, "lease"), { force: true });
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), 3_000);
      const error = Object.assign(new Error("lease fixture failure"), {
        code: scenario === "access" ? "EACCES" : "EPERM",
        syscall: scenario === "write" ? "write" : "open",
      });
      let attempts = 0;
      const mocked = context.mock.method(fs, "writeFile", async (...args: Parameters<typeof originalWrite>) => {
        if (args[0] === target) {
          attempts += 1;
          assert.equal((args[2] as { flag: string }).flag, "wx");
          if (scenario === "abort") controller.abort();
          if (scenario !== "transient" || attempts < 3) throw error;
        }
        await originalWrite(...args);
      });
      syncBuiltinESMExports();
      try {
        const pending = withProcessLease(async () => "acquired", options, controller.signal, directory);
        if (process.platform === "win32" && scenario === "transient") {
          assert.equal(await pending, "acquired");
          assert.equal(attempts, 3);
        } else if (process.platform === "win32" && scenario === "abort") {
          await assert.rejects(pending, { name: "AbortError" });
          assert.equal(attempts, 1);
        } else {
          await assert.rejects(pending, (failure) => failure === error);
          assert.equal(attempts, process.platform === "win32" && scenario === "persistent" ? 6 : 1);
        }
      } finally {
        clearTimeout(watchdog);
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    }
  });
}
