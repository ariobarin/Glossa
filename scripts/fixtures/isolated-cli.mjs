import { register } from "node:module";
register("./isolated-keyring-loader.mjs", import.meta.url);

// Windows does not deliver POSIX signals through ChildProcess.kill(). The
// private test IPC channel exercises the real CLI's SIGTERM handler instead.
if (process.platform === "win32" && process.send) {
  process.on("message", (message) => {
    if (message === "stop") process.emit("SIGTERM");
  });
  process.channel?.unref();
}
