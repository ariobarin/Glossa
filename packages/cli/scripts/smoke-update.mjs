import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url))).version;
const available = `${Number(version.split(".")[0]) + 1}.0.0`;
const root = await mkdtemp(path.join(os.tmpdir(), "glossa-update-smoke-"));
const config = path.join(root, process.platform === "win32" ? "Glossa" : "glossa");
const workspace = path.join(root, "workspace");
const stateFile = path.join(config, "updates.json");
let checks = 0;
let offline = false;
const server = createServer((request, response) => {
  if (request.url === "/registry") {
    checks += 1;
    if (offline) return request.socket.destroy();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ "dist-tags": { latest: available } }));
  } else {
    // Refuse registration after the notice; no real account or jobs are used.
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end("{}");
  }
});
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(config);
  await mkdir(workspace);
  const preload = path.join(root, "isolate.mjs");
  const isolation = new URL("../../../scripts/fixtures/isolated-cli.mjs", import.meta.url).href;
  await writeFile(preload, `
    await import(${JSON.stringify(isolation)});
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (new URL(String(input)).origin !== ${JSON.stringify(origin)}) throw Error('Nonlocal network blocked');
      return fetch(input, init);
    };
  `);
  const deviceId = "11111111-1111-4111-8111-111111111111";
  await writeFile(path.join(config, "device.json"), JSON.stringify({
    relayOrigin: origin, deviceId, deviceName: "fixture", token: `gld_${deviceId}_synthetic`,
  }));
  const env = { ...process.env, NODE_OPTIONS: "", APPDATA: root, XDG_CONFIG_HOME: root,
    GLOSSA_NPM_REGISTRY_URL: `${origin}/registry`, GLOSSA_RELAY_ORIGIN: origin, GLOSSA_WORKER_ORIGIN: origin };
  async function run(args, expectedStatus) {
    const result = await execute(process.execPath, ["--import", pathToFileURL(preload).href, cli, ...args], {
      cwd: root, env, timeout: 10_000, windowsHide: true,
    }).then(value => ({ ...value, code: 0 })).catch(error => error);
    assert.equal(result.code, expectedStatus, result.stderr ?? result.message);
    return result.stderr;
  }
  const startup = async () => {
    const stderr = await run(["--headless", workspace], 1);
    assert.match(stderr, /relay does not support/, stderr);
    return stderr;
  };
  const notice = `Glossa ${available} is available. Run glossa update after disconnecting.`;
  const runtime = path.join(config, "runtime");
  await mkdir(runtime);
  await writeFile(path.join(runtime, `${process.pid}-reused.update`), JSON.stringify({
    pid: process.pid, startedAt: new Date(0).toISOString(),
  }));
  const first = await startup();
  assert.deepEqual(await readdir(runtime), [], "Startup retained a reused PID lease");
  assert.ok(first.includes(notice), first);
  assert.ok((await startup()).includes(notice), "Cached startup lost the update notice");
  assert.equal(checks, 1, "Cached startup fetched again");
  await run(["--help"], 0);
  await run(["--version"], 0);
  assert.equal(checks, 1);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await writeFile(stateFile, JSON.stringify({ ...saved, lastCheckedAt: expired }));
  offline = true;
  assert.ok((await startup()).includes(notice), "Offline startup lost the cached notice");
  assert.equal(checks, 2);
  await writeFile(stateFile, JSON.stringify({ ...saved, policy: "off", lastCheckedAt: expired }));
  assert.ok(!(await startup()).includes(notice));
  assert.equal(checks, 2, "Disabled updates fetched");
  console.log("Packaged CLI: cached notice, offline fallback, disabled checks and help/version passed.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
