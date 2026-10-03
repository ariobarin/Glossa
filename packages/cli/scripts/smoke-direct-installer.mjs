import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "");
const assetName = process.argv[3];
if (!process.argv[2] || !assetName) {
  throw new Error("Pass the executable path and release asset name.");
}
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const binary = await readFile(executable);
const hash = createHash("sha256").update(binary).digest("hex");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "glossa-installer-"));
const installDirectory = join(temporaryDirectory, "bin");
const poisonDirectory = join(temporaryDirectory, "no-node");
await mkdir(poisonDirectory);
if (process.platform === "win32") {
  await writeFile(join(poisonDirectory, "node.cmd"), "@exit /b 99\r\n");
  await writeFile(join(poisonDirectory, "npm.cmd"), "@exit /b 99\r\n");
} else {
  for (const command of ["node", "npm"]) {
    const poison = join(poisonDirectory, command);
    await writeFile(poison, "#!/bin/sh\nexit 99\n");
    await chmod(poison, 0o755);
  }
}

const server = createServer((request, response) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (request.url === "/releases") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{
      draft: false,
      tag_name: `cli-v${packageJson.version}`,
      assets: [
        { name: assetName, browser_download_url: `${origin}/${assetName}` },
        {
          name: `${assetName}.sha256`,
          browser_download_url: `${origin}/${assetName}.sha256`,
        },
      ],
    }]));
  } else if (request.url === `/${assetName}`) {
    response.end(binary);
  } else if (request.url === `/${assetName}.sha256`) {
    response.end(`${hash}  ${assetName}\n`);
  } else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

function run(command, args, environment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = {
    ...process.env,
    GLOSSA_RELEASES_API: `http://127.0.0.1:${address.port}/releases`,
    GLOSSA_INSTALL_DIR: installDirectory,
  };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.PATH = `${poisonDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`;
  const installer = process.platform === "win32"
    ? await run(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", "site/install.ps1"],
        environment,
      )
    : await run("sh", ["site/install.sh"], environment);
  assert.equal(installer.status, 0, `${installer.stdout}\n${installer.stderr}`);
  assert.match(installer.stdout, new RegExp(`Installed Glossa ${packageJson.version.replaceAll(".", "\\.")}`));

  const installed = join(
    installDirectory,
    process.platform === "win32" ? "glossa.exe" : "glossa",
  );
  await stat(installed);
  if (process.platform !== "win32") await chmod(installed, 0o755);
  const version = await run(installed, ["--version"], process.env);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageJson.version);
  console.log(`Direct installer smoke passed for ${assetName}.`);
} finally {
  server.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
