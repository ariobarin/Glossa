#!/usr/bin/env node
import type { WorkerAccessProfile } from "@glossa/protocol";
import {
  parseInvocation,
  UsageError,
  type CliInvocation,
} from "./cli-options.js";
import { deviceStatus, formatRelativeTime } from "./device-format.js";
import {
  listDevices,
  loadRelayEndpoints,
  revokeDevice,
} from "./relay-client.js";
import { runSessionHud } from "./ui-hud.js";
import {
  retainPostExitNotice,
} from "./ui-hud-model.js";
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
import { unpairComputer } from "./unpair.js";
import {
  deviceForSession,
  runManagedSession,
} from "./worker/managed-session.js";
import { selectExposureRoot } from "./worker/root-selection.js";
import { acquireWorkspaceLease } from "./worker/workspace-lease.js";

declare const __GLOSSA_VERSION__: string;
declare const __GLOSSA_DISTRIBUTION__: GlossaDistribution;

const VERSION = __GLOSSA_VERSION__;
const DISTRIBUTION = __GLOSSA_DISTRIBUTION__;

const HELP = `Glossa ${VERSION}

Usage:
  glossa [--access <read-only|workspace|system>] [--label <name>] [directory]
  glossa unpair
  glossa update [--check]
  glossa update --policy <notify|auto|off>
  glossa update --channel <beta|stable>
  glossa --help
  glossa --version

Running glossa opens one workspace in an interactive terminal.
Access defaults to workspace: guarded file reads and writes, with commands disabled.
Use read-only to prevent file changes. Use system only when ChatGPT must run commands;
those commands inherit this account's permissions, environment, credentials, and network.
Update checks run at most once per day before a workspace connects.

Keys:
  a  activity
  w  workspace
  d  devices
  ↑↓ select or browse
  ←→ change workspace access
  Enter/r  revoke selected device
  Esc  workspace
  ?  help
  q  disconnect and quit`;

async function runWorkspaceSession(
  path: string | undefined,
  label: string | undefined,
  accessProfile: WorkerAccessProfile,
): Promise<void> {
  const root = await selectExposureRoot(path);
  const lease = await acquireWorkspaceLease(root);
  try {
    const endpoints = loadRelayEndpoints();
    const device = await deviceForSession(endpoints);
    let postExitNotice: string | undefined;
    let requestedAccessProfile = accessProfile;
    let activeSessionController: AbortController | undefined;
    await runSessionHud({
      workspace: root,
      ...(label ? { workspaceLabel: label } : {}),
      run: async (signal, onEvent) => {
        while (!signal.aborted) {
          const sessionAccessProfile = requestedAccessProfile;
          const sessionController = new AbortController();
          activeSessionController = sessionController;
          const stopSession = (): void => sessionController.abort(signal.reason);
          if (signal.aborted) sessionController.abort(signal.reason);
          else signal.addEventListener("abort", stopSession, { once: true });
          try {
            await runManagedSession(root, endpoints, {
              device,
              workerVersion: VERSION,
              accessProfile: sessionAccessProfile,
              ...(label ? { workspaceLabel: label } : {}),
              signal: sessionController.signal,
              onEvent: (event) => {
                postExitNotice = retainPostExitNotice(postExitNotice, event);
                onEvent(event);
              },
              quiet: true,
              handleProcessSignals: false,
            });
          } catch (error) {
            if (signal.aborted) return;
            if (
              sessionController.signal.aborted &&
              requestedAccessProfile !== sessionAccessProfile
            ) {
              continue;
            }
            throw error;
          } finally {
            signal.removeEventListener("abort", stopSession);
            if (activeSessionController === sessionController) {
              activeSessionController = undefined;
            }
          }
          if (requestedAccessProfile === sessionAccessProfile) return;
        }
      },
      loadStatus: async (signal) => {
        const withSignal = async (input: string, init?: RequestInit) =>
          await fetch(input, { ...init, signal });
        const devices = (
          await listDevices(endpoints, `Device ${device.token}`, withSignal)
        ).filter((entry) => entry.revokedAt === null);
        return {
          relay: endpoints.relayOrigin,
          activeWorkers: devices.some((entry) => entry.activeWorkers === null)
            ? null
            : devices.reduce((total, entry) => total + entry.activeWorkers!, 0),
          devices: devices.map((entry) => ({
            id: entry.id,
            name: entry.name,
            platform: entry.platform ?? "Unknown platform",
            lastSeen: formatRelativeTime(entry.lastSeenAt),
            status: deviceStatus(entry),
          })),
        };
      },
      revokeDevice: async (deviceId, signal) => {
        await revokeDevice(
          endpoints,
          `Device ${device.token}`,
          deviceId,
          async (input, init) => await fetch(input, { ...init, signal }),
        );
      },
      changeAccessProfile: (nextAccessProfile) => {
        if (nextAccessProfile === requestedAccessProfile) return;
        requestedAccessProfile = nextAccessProfile;
        activeSessionController?.abort();
      },
    });
    if (postExitNotice) console.error(postExitNotice);
  } finally {
    await lease.release();
  }
}

async function runWorkspace(
  path: string | undefined,
  label: string | undefined,
  accessProfile: WorkerAccessProfile,
): Promise<void> {
  await withWorkspaceLease(
    async () => await runWorkspaceSession(path, label, accessProfile),
  );
}

async function refreshUpdateInfo(timeoutMs: number): Promise<UpdateInfo> {
  const info = await loadUpdateInfo(timeoutMs);
  await recordUpdateCheck(VERSION);
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
    await recordUpdateCheck(VERSION);
    return false;
  }

  if (state.policy === "notify") {
    await recordUpdateCheck(VERSION);
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
    await runWorkspace(
      invocation.path,
      invocation.label,
      invocation.accessProfile,
    );
  } else if (invocation.command === "unpair") {
    await unpairComputer();
  } else if (invocation.command === "update") {
    await runUpdateCommand(invocation);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof UsageError) console.error("Run glossa --help for usage.");
  process.exitCode = 1;
});
