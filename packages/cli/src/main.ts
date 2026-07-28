#!/usr/bin/env node
import { loadAuthConfig } from "./auth-config.js";
import {
  signedInSession,
  type SignedInSession,
} from "./auth-login.js";
import { parseInvocation, UsageError } from "./cli-options.js";
import type { StoredCredentials } from "./config-store.js";
import { logoutFromGlossa } from "./logout.js";
import {
  loadRelayEndpoints,
  revokeDevice,
} from "./relay-client.js";
import { formatStatus } from "./status-display.js";
import { WorkspaceStatusService } from "./status-service.js";
import { runManagedSession } from "./worker/managed-session.js";
import { selectExposureRoot } from "./worker/root-selection.js";

declare const __GLOSSA_VERSION__: string;

const VERSION = __GLOSSA_VERSION__;

const HELP = `Glossa ${VERSION}

Usage:
  glossa [directory]
  glossa status
  glossa devices revoke <id>
  glossa logout
  glossa --help
  glossa --version

Running glossa exposes one workspace until you press Ctrl+C.`;

async function withLoginSignal<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    return await action(controller.signal);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

async function authenticatedSession(
  signal?: AbortSignal,
): Promise<SignedInSession> {
  if (signal) return await signedInSession({ ...loadAuthConfig(), signal });
  return await withLoginSignal(async (loginSignal) =>
    await signedInSession({ ...loadAuthConfig(), signal: loginSignal })
  );
}

async function authenticatedCredentials(
  signal?: AbortSignal,
): Promise<StoredCredentials> {
  return (await authenticatedSession(signal)).credentials;
}

async function showStatus(): Promise<void> {
  const credentials = await authenticatedCredentials();
  const endpoints = loadRelayEndpoints();
  const status = await new WorkspaceStatusService(
    credentials,
    endpoints,
  ).refresh();
  for (const line of formatStatus(status)) console.log(line);
}

async function revokeKnownDevice(deviceId: string): Promise<void> {
  const credentials = await authenticatedCredentials();
  await revokeDevice(loadRelayEndpoints(), credentials, deviceId);
}

async function runWorkspace(
  path: string | undefined,
): Promise<void> {
  const root = await selectExposureRoot(path);
  const endpoints = loadRelayEndpoints();
  const credentials = (await authenticatedSession()).credentials;
  await runManagedSession(root, endpoints, { credentials });
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.command === "help") {
    console.log(HELP);
  } else if (invocation.command === "version") {
    console.log(VERSION);
  } else if (invocation.command === "workspace") {
    await runWorkspace(invocation.path);
  } else if (invocation.command === "status") {
    await showStatus();
  } else if (invocation.command === "logout") {
    await logoutFromGlossa();
  } else {
    await revokeKnownDevice(invocation.deviceId);
    console.log(`Revoked device ${invocation.deviceId}. Running workspaces on it are disconnected.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof UsageError) console.error("Run glossa --help for usage.");
  process.exitCode = 1;
});
