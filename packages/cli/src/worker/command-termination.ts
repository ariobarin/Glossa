import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const TERMINATION_GRACE_MS = 2000;

export async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      // The caller still waits for pipe closure under its cleanup deadline.
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        // Release our observer even if this account cannot stop taskkill itself.
        try {
          killer.kill();
        } catch {
          // Cleanup still fails if stopping the termination helper is denied.
        }
        finish(new Error("Tree termination timed out."));
      }, TERMINATION_GRACE_MS);
      const onError = () => finish(new Error("Tree termination could not start."));
      const onClose = (code: number | null) => {
        // A short command may exit normally while taskkill is starting.
        const exited = child.exitCode !== null || child.signalCode !== null;
        finish(code === 0 || exited ? undefined : new Error("Tree termination failed."));
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killer.removeListener("error", onError);
        killer.removeListener("close", onClose);
        killer.on("error", ignoreProcessError);
        killer.unref();
        if (error) reject(error);
        else resolve();
      };
      killer.once("error", onError);
      killer.once("close", onClose);
    });
    return;
  }

  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-child.pid!, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  // The detached group can outlive its leader, including after SIGTERM.
  if (!signalGroup("SIGTERM")) return;
  await delay(TERMINATION_GRACE_MS);
  signalGroup("SIGKILL");
}

export function ignoreProcessError(): void {}
