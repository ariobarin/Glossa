import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

const WINDOWS_KEEP_AWAKE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class GlossaPower {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);

    public static void Hold() {
        if (SetThreadExecutionState(0x80000001) == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            Console.WriteLine("ready");
            Console.Out.Flush();
            while (Console.In.Read() != -1) {}
        } finally {
            SetThreadExecutionState(0x80000000);
        }
    }
}
'@
[GlossaPower]::Hold()
`;

type PowerHelper = ChildProcessByStdio<Writable, Readable, null>;

export function startKeepAwakeHelper(): PowerHelper {
  if (process.platform !== "win32") {
    throw new Error("--keep-awake is currently supported only on Windows.");
  }
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  return spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_KEEP_AWAKE,
  ], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
}

export async function withKeepAwake<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
  startHelper: () => PowerHelper = startKeepAwakeHelper,
): Promise<T> {
  signal.throwIfAborted();
  const helper = startHelper();
  const failure = new AbortController();
  const sessionSignal = AbortSignal.any([signal, failure.signal]);
  let releasing = false;
  const fail = (): void => {
    if (!releasing) failure.abort(new Error(
      "Glossa's keep-awake helper stopped. Check that Windows PowerShell and native power requests are allowed, then restart Glossa.",
    ));
  };
  helper.once("error", fail);
  helper.stdin.on("error", fail);
  const closed = new Promise<void>((resolve) => {
    helper.once("close", () => { fail(); resolve(); });
  });
  const lines = createInterface({ input: helper.stdout });
  try {
    // Readiness means the native call succeeded, not merely that PowerShell started.
    const [line] = await once(lines, "line", {
      signal: AbortSignal.any([sessionSignal, AbortSignal.timeout(15_000)]),
    }).catch((error: unknown) => {
      sessionSignal.throwIfAborted();
      throw new Error("Glossa's keep-awake helper did not become ready within 15 seconds.", { cause: error });
    });
    if (line !== "ready") throw new Error("Glossa could not acquire a keep-awake request.");
    sessionSignal.throwIfAborted();
    const result = await run(sessionSignal);
    failure.signal.throwIfAborted();
    return result;
  } finally {
    releasing = true;
    lines.close();
    // EOF also releases the request if the Glossa parent crashes or is killed.
    helper.stdin.end();
    const deadline = setTimeout(() => helper.kill(), 2_000);
    try {
      await closed;
    } finally {
      clearTimeout(deadline);
    }
  }
}
