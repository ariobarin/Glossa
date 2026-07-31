#!/usr/bin/env node
import { loadAuthConfig } from "./auth-config.js";
import { validCredentials } from "./auth-session.js";
import {
  signedInSession,
  type SignedInSession,
} from "./auth-login.js";
import { parseInvocation, UsageError } from "./cli-options.js";
import type { StoredCredentials } from "./config-store.js";
import { deviceStatus, formatRelativeTime } from "./device-format.js";
import { logoutFromGlossa } from "./logout.js";
import {
  loadRelayEndpoints,
  revokeDevice,
} from "./relay-client.js";
import { formatStatus } from "./status-display.js";
import {
  WorkspaceStatusService,
  type StatusDetails,
} from "./status-service.js";
import {
  retainPostExitNotice,
  runSessionHud,
  type HudExitAction,
  type HudStatus,
} from "./ui-hud.js";
import { runManagedSession } from "./worker/managed-session.js";
import { selectExposureRoot } from "./worker/root-selection.js";
import { acquireWorkspaceLease } from "./worker/workspace-lease.js";

declare const __GLOSSA_VERSION__: string;

const VERSION = __GLOSSA_VERSION__;

const HELP = `Glossa ${VERSION}

Usage:
  glossa [--label <name>] [directory]
  glossa status
  glossa devices revoke <id>
  glossa logout
  glossa --help
  glossa --version

Running glossa opens one workspace in an interactive terminal.

Keys:
  d  recent activity
  s  account and devices
  r  revoke a device from status
  l  sign out
  ?  help
  q  disconnect and quit`;

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

function hudStatus(status: StatusDetails): HudStatus {
  return {
    ...status,
    devices: status.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform ?? "Unknown platform",
      lastSeen: formatRelativeTime(device.lastSeenAt),
      status: deviceStatus(device),
    })),
  };
}

async function revokeKnownDevice(deviceId: string): Promise<void> {
  const credentials = await authenticatedCredentials();
  await revokeDevice(loadRelayEndpoints(), credentials, deviceId);
}

async function runWorkspace(
  path: string | undefined,
  label: string | undefined,
): Promise<void> {
  const root = await selectExposureRoot(path);
  const lease = await acquireWorkspaceLease(root);
  try {
    const endpoints = loadRelayEndpoints();
    let credentials = (await authenticatedSession()).credentials;
    const statusService = new WorkspaceStatusService(credentials, endpoints);
    let postExitNotice: string | undefined;
    const exitAction: HudExitAction = await runSessionHud({
      workspace: root,
      run: async (signal, onEvent) => {
        await runManagedSession(root, endpoints, {
          credentials,
          ...(label ? { workspaceLabel: label } : {}),
          signal,
          onEvent: (event) => {
            postExitNotice = retainPostExitNotice(postExitNotice, event);
            onEvent(event);
          },
          quiet: true,
          handleProcessSignals: false,
        });
      },
      loadStatus: async (signal) => {
        return hudStatus(await statusService.refresh(signal));
      },
      revokeDevice: async (deviceId, signal) => {
        credentials = await validCredentials(credentials, { signal });
        await revokeDevice(
          endpoints,
          credentials,
          deviceId,
          async (input, init) => await fetch(input, { ...init, signal }),
        );
      },
    });
    if (postExitNotice) console.error(postExitNotice);
    if (exitAction === "logout") await logoutFromGlossa();
  } finally {
    await lease.release();
  }
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.command === "help") {
    console.log(HELP);
  } else if (invocation.command === "version") {
    console.log(VERSION);
  } else if (invocation.command === "workspace") {
    await runWorkspace(invocation.path, invocation.label);
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
