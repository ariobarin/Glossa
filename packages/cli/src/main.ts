#!/usr/bin/env node
import { loadAuthConfig } from "./auth-config.js";
import { validCredentials } from "./auth-session.js";
import {
  signedInSession,
  type SignedInSession,
} from "./auth-login.js";
import {
  parseInvocation,
  UsageError,
  type CliInvocation,
} from "./cli-options.js";
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
import {
  checkForUpdate,
  cleanupUpdateBackups,
  installUpdate,
  type GlossaDistribution,
  type UpdateInfo,
} from "./update-service.js";
import {
  configureUpdates,
  isUpdateCheckDue,
  loadUpdateState,
  recordUpdateCheck,
} from "./update-state.js";
import { withUpdateLease, withWorkspaceLease } from "./update-lock.js";
import { runManagedSession } from "./worker/managed-session.js";
import { selectExposureRoot } from "./worker/root-selection.js";
import { acquireWorkspaceLease } from "./worker/workspace-lease.js";

declare const __GLOSSA_VERSION__: string;
declare const __GLOSSA_DISTRIBUTION__: GlossaDistribution;

const VERSION = __GLOSSA_VERSION__;
const DISTRIBUTION = __GLOSSA_DISTRIBUTION__;

const HELP = `Glossa ${VERSION}

Usage:
  glossa [--label <name>] [directory]
  glossa status
  glossa devices revoke <id>
  glossa logout
  glossa update [--check]
  glossa update --policy <notify|auto|off>
  glossa update --channel <beta|stable>
  glossa --help
  glossa --version

Running glossa opens one workspace in an interactive terminal.
Update checks run at most once per day before a workspace connects.

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

async function runWorkspaceSession(
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

async function runWorkspace(
  path: string | undefined,
  label: string | undefined,
): Promise<void> {
  await withWorkspaceLease(async () => await runWorkspaceSession(path, label));
}

async function refreshUpdateInfo(timeoutMs: number): Promise<UpdateInfo> {
  const info = await loadUpdateInfo(timeoutMs);
  await recordUpdateCheck(VERSION, info.availableVersion);
  return info;
}

async function loadUpdateInfo(timeoutMs: number): Promise<UpdateInfo> {
  const state = await loadUpdateState(VERSION);
  return await checkForUpdate(VERSION, state.channel, {
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function runUpdateCommand(
  invocation: Extract<CliInvocation, { command: "update" }>,
): Promise<void> {
  if (invocation.action === "configure") {
    const state = await configureUpdates(VERSION, {
      ...(invocation.policy ? { policy: invocation.policy } : {}),
      ...(invocation.channel ? { channel: invocation.channel } : {}),
    });
    console.log(
      `Glossa update policy is ${state.policy}; release channel is ${state.channel}.`,
    );
    return;
  }

  const info = await refreshUpdateInfo(15_000);
  if (!info.updateAvailable) {
    console.log(`Glossa ${VERSION} is current on the ${info.channel} channel.`);
    return;
  }
  if (invocation.action === "check") {
    console.log(
      `Glossa ${info.availableVersion} is available on the ${info.channel} channel. Run glossa update.`,
    );
    return;
  }

  console.log(`Updating Glossa ${VERSION} to ${info.availableVersion}...`);
  await withUpdateLease(
    async () => await installUpdate(info, DISTRIBUTION),
  );
  console.log(`Updated Glossa to ${info.availableVersion}. Run glossa again.`);
}

async function updateBeforeWorkspace(): Promise<boolean> {
  const state = await loadUpdateState(VERSION);
  if (state.policy === "off" || !isUpdateCheckDue(state.lastCheckedAt)) {
    return false;
  }

  let info: UpdateInfo;
  try {
    info = await loadUpdateInfo(2_000);
  } catch (error) {
    if (state.policy === "auto") {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Glossa could not check for an automatic update: ${message} Continuing with ${VERSION}.`,
      );
    }
    return false;
  }
  if (!info.updateAvailable) {
    await recordUpdateCheck(VERSION, info.availableVersion);
    return false;
  }

  if (state.policy === "notify") {
    await recordUpdateCheck(VERSION, info.availableVersion);
    console.error(
      `Glossa ${info.availableVersion} is available. Run glossa update after disconnecting.`,
    );
    return false;
  }

  try {
    console.error(`Updating Glossa ${VERSION} to ${info.availableVersion}...`);
    await withUpdateLease(
      async () => await installUpdate(info, DISTRIBUTION),
    );
    console.error(`Updated Glossa to ${info.availableVersion}. Run glossa again.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Glossa could not update automatically: ${message} Continuing with ${VERSION}.`,
    );
    return false;
  }
}

async function main(): Promise<void> {
  await cleanupUpdateBackups(DISTRIBUTION);
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.command === "help") {
    console.log(HELP);
  } else if (invocation.command === "version") {
    console.log(VERSION);
  } else if (invocation.command === "workspace") {
    if (await updateBeforeWorkspace()) return;
    await runWorkspace(invocation.path, invocation.label);
  } else if (invocation.command === "status") {
    await showStatus();
  } else if (invocation.command === "logout") {
    await logoutFromGlossa();
  } else if (invocation.command === "update") {
    await runUpdateCommand(invocation);
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
