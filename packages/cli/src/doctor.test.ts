import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkWorkspaceRoot,
  formatDoctorResult,
  nodeVersionSatisfies,
  runDoctor,
  runDoctorChecks,
  type DoctorDependencies,
} from "./doctor.js";

test("node version check accepts the minimum and newer", () => {
  assert.equal(nodeVersionSatisfies("22.9.0"), true);
  assert.equal(nodeVersionSatisfies("22.9.1"), true);
  assert.equal(nodeVersionSatisfies("23.0.0"), true);
  assert.equal(nodeVersionSatisfies("24.13.0"), true);
  assert.equal(nodeVersionSatisfies("v22.9.0"), true);
});

test("node version check rejects older and malformed versions", () => {
  assert.equal(nodeVersionSatisfies("22.8.0"), false);
  assert.equal(nodeVersionSatisfies("21.7.0"), false);
  assert.equal(nodeVersionSatisfies("garbage"), false);
  assert.equal(nodeVersionSatisfies(""), false);
});

const healthy: DoctorDependencies = {
  nodeVersion: "24.13.0",
  endpoints: {
    relayOrigin: "https://mcp.glossa.test",
    workerOrigin: "https://mcp.glossa.test",
  },
  checkWorkspace: async () => true,
  fetchHealthz: async () => "healthy",
  probeCredentials: async () => "stored",
};

test("reports a configured machine while qualifying stored credentials", async () => {
  const checks = await runDoctorChecks(healthy);
  assert.deepEqual(
    checks.map((check) => check.name),
    ["Node.js", "Workspace", "Relay", "Sign-in"],
  );
  assert.equal(checks.find((check) => check.name === "Sign-in")?.status, "pass");
  assert.match(
    checks.find((check) => check.name === "Sign-in")?.detail ?? "",
    /expiry and refresh viability were not checked/,
  );
});

test("warns when the current directory cannot be exposed", async () => {
  const checks = await runDoctorChecks({
    ...healthy,
    checkWorkspace: async () => false,
  });
  const workspace = checks.find((check) => check.name === "Workspace");
  assert.equal(workspace?.status, "warn");
  assert.match(workspace?.nextStep ?? "", /glossa <path>/);
});

test("accepts a regular directory that Glossa can expose", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glossa-doctor-root-"));
  try {
    assert.equal(await checkWorkspaceRoot(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a protected workspace root", async () => {
  assert.equal(await checkWorkspaceRoot(path.parse(process.cwd()).root), false);
});

test("distinguishes unreachable and unhealthy relay health endpoints", async () => {
  const unreachable = await runDoctorChecks({
    ...healthy,
    fetchHealthz: async () => "unreachable",
  });
  const unhealthy = await runDoctorChecks({
    ...healthy,
    fetchHealthz: async () => "unhealthy",
  });
  const unreachableRelay = unreachable.find((check) => check.name === "Relay");
  const unhealthyRelay = unhealthy.find((check) => check.name === "Relay");
  assert.match(unreachableRelay?.detail ?? "", /Could not reach/);
  assert.match(unreachableRelay?.nextStep ?? "", /connection and DNS/);
  assert.match(unhealthyRelay?.detail ?? "", /responded/);
  assert.match(unhealthyRelay?.nextStep ?? "", /healthz/);
});

test("reports a separate worker endpoint with its own health failure", async () => {
  const checkedOrigins: string[] = [];
  const checks = await runDoctorChecks({
    ...healthy,
    endpoints: {
      relayOrigin: "https://relay.glossa.test",
      workerOrigin: "https://worker.glossa.test",
    },
    fetchHealthz: async (origin) => {
      checkedOrigins.push(origin);
      return origin === "https://worker.glossa.test" ? "unhealthy" : "healthy";
    },
  });
  assert.deepEqual(checkedOrigins, [
    "https://relay.glossa.test",
    "https://worker.glossa.test",
  ]);
  const worker = checks.find((check) => check.name === "Worker");
  assert.equal(worker?.status, "fail");
  assert.match(worker?.detail ?? "", /responded/);
  assert.match(worker?.nextStep ?? "", /GLOSSA_WORKER_ORIGIN/);
});

test("attributes malformed relay and worker origins to their owning endpoints", async () => {
  const relayChecks = await runDoctorChecks({
    nodeVersion: "24.13.0",
    checkWorkspace: async () => true,
    loadRelayOrigin: () => {
      throw new Error("GLOSSA_RELAY_ORIGIN must contain only an origin.");
    },
    probeCredentials: async () => "stored",
  });
  assert.equal(relayChecks.find((check) => check.name === "Relay")?.status, "fail");
  assert.equal(relayChecks.some((check) => check.name === "Worker"), false);

  const workerChecks = await runDoctorChecks({
    nodeVersion: "24.13.0",
    checkWorkspace: async () => true,
    loadRelayOrigin: () => "https://relay.glossa.test",
    loadWorkerOrigin: () => {
      throw new Error("GLOSSA_WORKER_ORIGIN must contain only an origin.");
    },
    fetchHealthz: async () => "healthy",
    probeCredentials: async () => "stored",
  });
  const worker = workerChecks.find((check) => check.name === "Worker");
  const relay = workerChecks.find((check) => check.name === "Relay");
  assert.equal(relay?.status, "pass");
  assert.equal(worker?.status, "fail");
  assert.match(worker?.detail ?? "", /GLOSSA_WORKER_ORIGIN/);
  assert.match(worker?.nextStep ?? "", /GLOSSA_WORKER_ORIGIN/);
});

test("warns instead of failing when not signed in yet", async () => {
  const checks = await runDoctorChecks({
    ...healthy,
    probeCredentials: async () => "absent",
  });
  const signIn = checks.find((check) => check.name === "Sign-in");
  assert.equal(signIn?.status, "warn");
  assert.ok(signIn?.nextStep);
});

test("fails the sign-in check when stored credentials are unreadable", async () => {
  const deps = { ...healthy, probeCredentials: async () => "error" as const };
  const checks = await runDoctorChecks(deps);
  const signIn = checks.find((check) => check.name === "Sign-in");
  assert.equal(signIn?.status, "fail");
  assert.match(signIn?.nextStep ?? "", /glossa logout/);
  assert.equal(await runDoctor(false, deps, () => undefined), false);
});

test("skips the Node.js prerequisite for standalone executables", async () => {
  const checks = await runDoctorChecks({
    ...healthy,
    standalone: true,
    nodeVersion: "0.0.0",
  });
  const runtime = checks.find((check) => check.name === "Runtime");
  assert.equal(checks.some((check) => check.name === "Node.js"), false);
  assert.equal(runtime?.status, "pass");
  assert.match(runtime?.detail ?? "", /Node\.js is not required/);
});

test("text and JSON output report readiness when stored credentials are present", async () => {
  const checks = await runDoctorChecks(healthy);
  const text = formatDoctorResult(checks, false);
  assert.match(text, /Glossa is ready to start/);
  assert.doesNotMatch(text, /not fully ready/);

  const json = JSON.parse(formatDoctorResult(checks, true));
  assert.equal(json.ready, true);
  assert.deepEqual(json.checks, checks);
  assert.equal(await runDoctor(true, healthy, () => undefined), true);
});

test("reports ready only when every check passes", () => {
  const checks = [
    { name: "Runtime", status: "pass" as const, detail: "Standalone executable includes its Bun runtime." },
  ];
  const text = formatDoctorResult(checks, false);
  assert.match(text, /Glossa is ready to start/);
  const json = JSON.parse(formatDoctorResult(checks, true));
  assert.equal(json.ready, true);
});

test("text output counts failures", () => {
  const failing = [
    {
      name: "Runtime",
      status: "fail" as const,
      detail: "Runtime was not found.",
      nextStep: "Install the runtime.",
    },
  ];
  assert.match(formatDoctorResult(failing, false), /1 check failed/);
  assert.match(
    formatDoctorResult(
      [...failing, { name: "Relay", status: "fail" as const, detail: "down" }],
      false,
    ),
    /2 checks failed/,
  );
});
