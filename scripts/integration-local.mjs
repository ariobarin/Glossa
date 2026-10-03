import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const project = `glossa-integration-${process.pid}`;
const compose = ["compose", "--project-name", project, "--env-file", "scripts/fixtures/integration.env",
  "-f", "compose.yaml", "-f", "scripts/fixtures/integration.compose.yaml"];

function docker(args, capture = false) {
  const result = spawnSync("docker", args, {
    cwd: root, stdio: capture ? "pipe" : "inherit", encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? "Docker command failed");
  return result.stdout?.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

docker(["version", "--format", "{{.Server.Version}}"]);
assert.equal(docker([...compose, "ps", "--all", "--quiet"], true), "",
  `Refusing to reuse existing containers in ${project}`);
assert.equal(docker(["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], true), "",
  `Refusing to reuse existing volumes in ${project}`);
try {
  docker([...compose, "up", "-d", "--wait", "postgres"]);
  const mapped = docker([...compose, "port", "postgres", "5432"], true);
  assert.match(mapped, /^127\.0\.0\.1:\d+$/);
  const relayPort = await freePort();
  let authPort = await freePort();
  while (authPort === relayPort) authPort = await freePort();
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/integration-smoke.ts"], {
    cwd: root, stdio: "inherit", timeout: 180_000,
    env: {
      ...process.env,
      GLOSSA_INTEGRATION_DATABASE_URL: `postgres://glossa:glossa@${mapped}/glossa`,
      GLOSSA_INTEGRATION_RELAY_ORIGIN: `http://127.0.0.1:${relayPort}`,
      GLOSSA_INTEGRATION_AUTH_PORT: String(authPort),
    },
  });
  assert.equal(result.status, 0, result.error?.message ?? "Integration smoke failed");
} finally {
  docker([...compose, "down", "--volumes", "--timeout", "15"]);
}
