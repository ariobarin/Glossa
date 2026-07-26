import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { peekCredentials } from "./config-store.js";
import {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
} from "./node-version.js";
import { nodeVersionSatisfies } from "./node-version.js";
import {
  loadRelayOrigin,
  loadWorkerOrigin,
  type RelayEndpoints,
} from "./relay-client.js";
import { isStandaloneExecutable } from "./runtime.js";

const execFileAsync = promisify(execFile);

const HEALTHZ_TIMEOUT_MS = 5_000;

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  nextStep?: string;
}

export type HealthProbe = "healthy" | "unreachable" | "unhealthy";

export type CredentialProbe = "stored" | "absent" | "error";

export interface DoctorDependencies {
  nodeVersion?: string;
  standalone?: boolean;
  endpoints?: RelayEndpoints;
  loadRelayOrigin?: () => string;
  loadWorkerOrigin?: (relayOrigin: string) => string;
  checkGit?: () => Promise<boolean>;
  checkWorkspace?: () => Promise<boolean>;
  fetchHealthz?: (origin: string) => Promise<HealthProbe>;
  probeCredentials?: () => Promise<CredentialProbe>;
}

export { nodeVersionSatisfies } from "./node-version.js";

export async function runDoctorChecks(
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const standalone = dependencies.standalone ?? isStandaloneExecutable();
  const checks: DoctorCheck[] = [];
  if (standalone) {
    checks.push({
      name: "Runtime",
      status: "pass",
      detail: "Standalone executable includes its Bun runtime. Node.js is not required.",
    });
  } else {
    const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
    const nodeOk = nodeVersionSatisfies(nodeVersion);
    checks.push({
      name: "Node.js",
      status: nodeOk ? "pass" : "fail",
      detail: `Node.js v${nodeVersion}`,
      ...(nodeOk ? {} : { nextStep: `Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer and restart your terminal.` }),
    });
  }

  const checkGit = dependencies.checkGit ?? defaultCheckGit;
  const gitOk = await checkGit();
  checks.push({
    name: "Git",
    status: gitOk ? "pass" : "warn",
    detail: gitOk
      ? "Git is installed."
      : "Git was not found. It is only needed when Glossa discovers the current worktree.",
    ...(gitOk ? {} : { nextStep: 'Install Git to run "glossa" without a path, or use "glossa <path>" to expose a selected directory.' }),
  });

  const checkWorkspace = dependencies.checkWorkspace ?? defaultCheckWorkspace;
  const workspaceOk = gitOk && await checkWorkspace();
  checks.push({
    name: "Workspace",
    status: workspaceOk ? "pass" : "warn",
    detail: workspaceOk
      ? "Current directory is a Git worktree."
      : gitOk
        ? "Current directory is not a Git worktree."
        : "Current directory cannot be checked without Git.",
    ...(workspaceOk
      ? {}
      : { nextStep: 'Run "glossa doctor" from a Git worktree, or use "glossa <path>" to expose a selected non-Git directory.' }),
  });

  let relayOrigin = dependencies.endpoints?.relayOrigin;
  if (!relayOrigin) {
    try {
      relayOrigin = (dependencies.loadRelayOrigin ?? loadRelayOrigin)();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "Relay",
        status: "fail",
        detail: `Endpoint configuration is invalid: ${message}`,
        nextStep: "Set GLOSSA_RELAY_ORIGIN to an origin URL only, without paths.",
      });
    }
  }

  let workerOrigin = dependencies.endpoints?.workerOrigin;
  if (relayOrigin && !workerOrigin) {
    try {
      workerOrigin = (dependencies.loadWorkerOrigin ?? loadWorkerOrigin)(relayOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "Worker",
        status: "fail",
        detail: `Endpoint configuration is invalid: ${message}`,
        nextStep: "Set GLOSSA_WORKER_ORIGIN to an origin URL only, without paths.",
      });
    }
  }

  if (relayOrigin) {
    const fetchHealthz = dependencies.fetchHealthz ?? defaultFetchHealthz;
    checks.push(endpointCheck("Relay", relayOrigin, await fetchHealthz(relayOrigin)));

    if (workerOrigin && workerOrigin !== relayOrigin) {
      checks.push(endpointCheck("Worker", workerOrigin, await fetchHealthz(workerOrigin)));
    }
  }

  const probeCredentials = dependencies.probeCredentials ?? defaultProbeCredentials;
  checks.push(signInCheck(await probeCredentials()));

  return checks;
}

function signInCheck(state: CredentialProbe): DoctorCheck {
  if (state === "stored") {
    return {
      name: "Sign-in",
      status: "pass",
      detail: "Stored Glossa credentials were found. Their expiry and refresh viability were not checked.",
      nextStep: 'Run "glossa" to validate sign-in when it starts, or run "glossa logout" and sign in again if it fails.',
    };
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
  const ready = checks.every((check) => check.status === "pass");
  if (json) return JSON.stringify({ ready, checks }, null, 2);
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
  const warned = checks.filter((check) => check.status === "warn").length;
  lines.push("");
  lines.push(
    failed > 0
      ? `${failed} check${failed === 1 ? "" : "s"} failed. Resolve the items above before starting.`
      : warned > 0
        ? "Glossa is not fully ready. Review the warnings above before relying on this configuration."
        : "Glossa is ready to start.",
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
  return await checkGitWorktree();
}

export async function checkGitWorktree(cwd = process.cwd()): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function endpointCheck(
  name: "Relay" | "Worker",
  origin: string,
  health: HealthProbe,
): DoctorCheck {
  const setting = name === "Relay" ? "GLOSSA_RELAY_ORIGIN" : "GLOSSA_WORKER_ORIGIN";
  if (health === "healthy") {
    return { name, status: "pass", detail: `${origin} returned a healthy Glossa relay response.` };
  }
  if (health === "unreachable") {
    return {
      name,
      status: "fail",
      detail: `Could not reach ${origin}.`,
      nextStep: `Check your connection and DNS, then confirm ${setting}.`,
    };
  }
  return {
    name,
    status: "fail",
    detail: `${origin} responded, but its health endpoint is not a healthy Glossa relay response.`,
    nextStep: `Confirm ${setting} points to a Glossa relay and that /healthz returns the expected response.`,
  };
}

async function defaultFetchHealthz(origin: string): Promise<HealthProbe> {
  try {
    const response = await fetch(`${origin}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!response.ok) return "unhealthy";
    try {
      const data = (await response.json()) as { ok?: unknown; service?: unknown };
      return data.ok === true && data.service === "glossa-relay"
        ? "healthy"
        : "unhealthy";
    } catch {
      return "unhealthy";
    }
  } catch {
    return "unreachable";
  }
}

async function defaultProbeCredentials(): Promise<CredentialProbe> {
  try {
    return (await peekCredentials()) !== null ? "stored" : "absent";
  } catch {
    // A malformed credential store would also break glossa start/status, so
    // surface it as a failure rather than masking it as "not signed in".
    return "error";
  }
}
