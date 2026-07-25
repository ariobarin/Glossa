import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { peekCredentials } from "./config-store.js";
import {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
} from "./node-version.js";
import { nodeVersionSatisfies } from "./node-version.js";
import {
  loadRelayEndpoints,
  type RelayEndpoints,
} from "./relay-client.js";

const execFileAsync = promisify(execFile);

const HEALTHZ_TIMEOUT_MS = 5_000;

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  nextStep?: string;
}

export type CredentialProbe = "present" | "absent" | "error";

export interface DoctorDependencies {
  nodeVersion?: string;
  endpoints?: RelayEndpoints;
  loadEndpoints?: () => RelayEndpoints;
  checkGit?: () => Promise<boolean>;
  checkWorkspace?: () => Promise<boolean>;
  fetchHealthz?: (origin: string) => Promise<boolean>;
  probeCredentials?: () => Promise<CredentialProbe>;
}

export { nodeVersionSatisfies } from "./node-version.js";

export async function runDoctorChecks(
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const nodeOk = nodeVersionSatisfies(nodeVersion);
  const checks: DoctorCheck[] = [
    {
      name: "Node.js",
      status: nodeOk ? "pass" : "fail",
      detail: `Node.js v${nodeVersion}`,
      ...(nodeOk ? {} : { nextStep: `Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer and restart your terminal.` }),
    },
  ];

  const checkGit = dependencies.checkGit ?? defaultCheckGit;
  const gitOk = await checkGit();
  checks.push({
    name: "Git",
    status: gitOk ? "pass" : "fail",
    detail: gitOk ? "Git is installed." : "Git was not found.",
    ...(gitOk ? {} : { nextStep: "Install Git from https://git-scm.com/ and restart your terminal." }),
  });

  const checkWorkspace = dependencies.checkWorkspace ?? defaultCheckWorkspace;
  const workspaceOk = gitOk && await checkWorkspace();
  checks.push({
    name: "Workspace",
    status: workspaceOk ? "pass" : "warn",
    detail: workspaceOk
      ? "Current directory is a Git workspace."
      : "Current directory is not a Git workspace.",
    ...(workspaceOk
      ? {}
      : { nextStep: "Run glossa doctor from a workspace to verify its Git context." }),
  });

  let endpoints = dependencies.endpoints;
  if (!endpoints) {
    try {
      endpoints = (dependencies.loadEndpoints ?? loadRelayEndpoints)();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "Relay",
        status: "fail",
        detail: `Endpoint configuration is invalid: ${message}`,
        nextStep: "Set GLOSSA_RELAY_ORIGIN and GLOSSA_WORKER_ORIGIN to origin URLs only, without paths.",
      });
    }
  }

  if (endpoints) {
    const fetchHealthz = dependencies.fetchHealthz ?? defaultFetchHealthz;
    const relayOk = await fetchHealthz(endpoints.relayOrigin);
    checks.push({
      name: "Relay",
      status: relayOk ? "pass" : "fail",
      detail: relayOk
        ? `${endpoints.relayOrigin} is reachable.`
        : `${endpoints.relayOrigin} is not reachable.`,
      ...(relayOk ? {} : { nextStep: "Check your internet connection. If you self-host, confirm GLOSSA_RELAY_ORIGIN." }),
    });

    if (endpoints.workerOrigin !== endpoints.relayOrigin) {
      const workerOk = await fetchHealthz(endpoints.workerOrigin);
      checks.push({
        name: "Worker",
        status: workerOk ? "pass" : "fail",
        detail: workerOk
          ? `${endpoints.workerOrigin} is reachable.`
          : `${endpoints.workerOrigin} is not reachable.`,
        ...(workerOk ? {} : { nextStep: "Confirm GLOSSA_WORKER_ORIGIN and the worker endpoint reverse proxy." }),
      });
    }
  }

  const probeCredentials = dependencies.probeCredentials ?? defaultProbeCredentials;
  const credentialState = await probeCredentials();
  checks.push(signInCheck(credentialState));

  return checks;
}

function signInCheck(state: CredentialProbe): DoctorCheck {
  if (state === "present") {
    return { name: "Sign-in", status: "pass", detail: "Signed in to Glossa." };
  }
  if (state === "absent") {
    return {
      name: "Sign-in",
      status: "warn",
      detail: "Not signed in yet.",
      nextStep: 'Run "glossa" inside a workspace. Sign-in opens automatically.',
    };
  }
  return {
    name: "Sign-in",
    status: "fail",
    detail: "Stored credentials are unreadable.",
    nextStep: 'Run "glossa logout" to clear them, then start Glossa again.',
  };
}

export function formatDoctorResult(checks: DoctorCheck[], json: boolean): string {
  if (json) return JSON.stringify({ checks }, null, 2);
  const nameWidth = Math.max(...checks.map((check) => check.name.length));
  const lines: string[] = ["Glossa doctor", ""];
  for (const check of checks) {
    const name = check.name.padEnd(nameWidth);
    lines.push(`  ${name}  ${check.status.toUpperCase()}  ${check.detail}`);
    if (check.nextStep) {
      lines.push(`  ${" ".repeat(nameWidth)}  ${check.nextStep}`);
    }
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  lines.push("");
  lines.push(
    failed === 0
      ? "Glossa is ready to start."
      : `${failed} check${failed === 1 ? "" : "s"} failed. Resolve the items above before starting.`,
  );
  return lines.join("\n");
}

export async function runDoctor(
  json: boolean,
  dependencies: DoctorDependencies = {},
  log: (message: string) => void = console.log,
): Promise<boolean> {
  const checks = await runDoctorChecks(dependencies);
  log(formatDoctorResult(checks, json));
  return checks.every((check) => check.status !== "fail");
}

async function defaultCheckGit(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function defaultCheckWorkspace(): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchHealthz(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { ok?: unknown; service?: unknown };
    return data.ok === true && data.service === "glossa-relay";
  } catch {
    return false;
  }
}

async function defaultProbeCredentials(): Promise<CredentialProbe> {
  try {
    return (await peekCredentials()) !== null ? "present" : "absent";
  } catch {
    // A malformed credential store would also break glossa start/status, so
    // surface it as a failure rather than masking it as "not signed in".
    return "error";
  }
}
