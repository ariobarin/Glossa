#!/usr/bin/env node
import { validCredentials } from "./auth-session.js";
import { loadAuthConfig } from "./auth-config.js";
import {
  signedInSession,
  type SignedInSession,
} from "./auth-login.js";
import { parseInvocation, UsageError } from "./cli-options.js";
import { runDoctor } from "./doctor.js";
import type { StoredCredentials } from "./config-store.js";
import {
  deviceStatus,
  formatDeviceRow,
  formatRelativeTime,
} from "./device-format.js";
import { logoutFromGlossa } from "./logout.js";
import {
  listDevices,
  loadRelayEndpoints,
  revokeDevice,
} from "./relay-client.js";
import {
  WorkspaceStatusService,
  type StatusDetails,
} from "./status-service.js";
import { formatStatus } from "./status-display.js";
import {
  runSessionHud,
  type HudExitAction,
  type HudStatus,
} from "./ui-hud.js";
import { updateGlossa } from "./update.js";
import { runManagedSession } from "./worker/managed-session.js";
import { selectExposureRoot } from "./worker/root-selection.js";

declare const __GLOSSA_VERSION__: string;

const VERSION = __GLOSSA_VERSION__;

const HELP = `Glossa ${VERSION}

Usage:
  glossa [--label <name>] [directory]
  glossa status [--json]
  glossa doctor [--json]
  glossa devices [--json]
  glossa devices revoke <id>
  glossa update
  glossa login
  glossa logout
  glossa --version

Running glossa opens one workspace in an interactive terminal.
Direct commands remain available for scripts and quick checks.

Keys:
  d  recent activity
  s  account and devices
  r  revoke a device
  l  sign out
  u  update Glossa
  ?  show all keys
  q or Ctrl+C  disconnect and quit`;

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

async function loadStatusDetails(signal?: AbortSignal): Promise<StatusDetails> {
  const credentials = await authenticatedCredentials(signal);
  const endpoints = loadRelayEndpoints();
  return await new WorkspaceStatusService(
    credentials,
    endpoints,
  ).refresh(signal, true);
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

async function showStatus(json: boolean): Promise<void> {
  const status = await loadStatusDetails();
  if (json) {
    console.log(JSON.stringify({ ...status, connected: true }, null, 2));
    return;
  }
  for (const line of formatStatus(status)) console.log(line);
}

async function showDevices(json: boolean): Promise<void> {
  const credentials = await authenticatedCredentials();
  const devices = await listDevices(loadRelayEndpoints(), credentials);
  if (json) console.log(JSON.stringify({ devices }, null, 2));
  else if (devices.length === 0) console.log("No devices enrolled.");
  else for (const device of devices) console.log(formatDeviceRow(device));
}

async function runWorkspace(
  path: string | undefined,
  label: string | undefined,
): Promise<void> {
  const root = await selectExposureRoot(path);
  const endpoints = loadRelayEndpoints();
  let credentials = (await authenticatedSession()).credentials;
  let statusService: WorkspaceStatusService | undefined;
  let statusListener: ((status: HudStatus) => void) | undefined;
  let postExitNotice: string | undefined;
  let unsubscribeStatusService = (): void => undefined;

  const createStatusService = (
    sessionCredentials: StoredCredentials,
  ): WorkspaceStatusService => {
    unsubscribeStatusService();
    const service = new WorkspaceStatusService(sessionCredentials, endpoints);
    unsubscribeStatusService = service.subscribe((status) => {
      statusListener?.(hudStatus(status));
    });
    statusService = service;
    return service;
  };

  const refreshStatus = async (signal: AbortSignal): Promise<HudStatus> => {
    const service = statusService ?? createStatusService(
      credentials,
    );
    return hudStatus(await service.refresh(signal));
  };

  createStatusService(credentials);

  let exitAction: HudExitAction;
  try {
    exitAction = await runSessionHud({
      workspace: root,
      peekStatus: () => {
        const cached = statusService?.peek();
        return cached ? hudStatus(cached) : undefined;
      },
      subscribeStatus: (listener) => {
        statusListener = listener;
        return () => {
          if (statusListener === listener) statusListener = undefined;
        };
      },
      run: async (signal, onEvent) => {
        await runManagedSession(root, endpoints, {
          credentials,
          ...(label ? { workspaceLabel: label } : {}),
          signal,
          onEvent(event) {
            onEvent(event);
            if (event.type === "notice") postExitNotice = event.message;
            if (
              event.type === "status" &&
              event.status.state === "connected" &&
              !statusService?.peek()
            ) {
              void statusService?.refresh(signal).catch(() => undefined);
            }
          },
          quiet: true,
          handleProcessSignals: false,
        });
      },
      loadStatus: refreshStatus,
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
  } finally {
    unsubscribeStatusService();
  }

  if (postExitNotice) console.log(postExitNotice);
  if (exitAction === "logout") await logoutFromGlossa();
  else if (exitAction === "update") {
    await updateGlossa({ currentVersion: VERSION });
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
    await showStatus(invocation.json);
  } else if (invocation.command === "doctor") {
    if (!await runDoctor(invocation.json)) process.exitCode = 1;
  } else if (invocation.command === "login") {
    const session = await authenticatedSession();
    if (!session.loginPerformed) console.log("Signed in to Glossa.");
  } else if (invocation.command === "logout") {
    await logoutFromGlossa();
  } else if (invocation.command === "update") {
    await updateGlossa({ currentVersion: VERSION });
  } else if (invocation.action === "list") {
    await showDevices(invocation.json);
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
