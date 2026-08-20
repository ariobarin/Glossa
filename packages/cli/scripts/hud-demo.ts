import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { WorkerAccessProfile, WorkerJob } from "@glossa/protocol";
import { runSessionHud } from "../src/ui-hud.js";

const workspace = fileURLToPath(new URL("../../..", import.meta.url));
const deviceName = `${hostname()} (demo)`;

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const demoJobs: WorkerJob[] = [
  {
    type: "read_file",
    requestId: "demo-read",
    path: "packages/cli/src/ui-hud.ts",
  },
  {
    type: "search_text",
    requestId: "demo-search",
    query: "workspaceLabel",
    path: "packages/cli/src",
    timeoutMs: 5_000,
  },
  {
    type: "run_command",
    requestId: "demo-command",
    argv: [
      "npm",
      "run",
      "check",
      "--workspace",
      "@ariobarin/glossa",
      "--",
      "--reporter",
      "spec",
    ],
    timeoutMs: 120_000,
  },
];

let cycle = 0;
let revoked = false;
let accessProfile: WorkerAccessProfile = "system";
let reportAccessProfile: ((profile: WorkerAccessProfile) => void) | undefined;
let reportConnected: (() => void) | undefined;

await runSessionHud({
  workspace,
  workspaceLabel: "hud-demo",
  async run(signal, onEvent) {
    reportAccessProfile = (profile) => onEvent({
      type: "session",
      root: workspace,
      deviceName,
      accessProfile: profile,
    });
    reportConnected = () => onEvent({
      type: "status",
      status: {
        state: "connected",
        reconnected: true,
        legacyRelay: false,
        accessProfileAccepted: true,
        workspaceLabelAccepted: true,
      },
    });
    reportAccessProfile(accessProfile);
    if (!await sleep(450, signal)) return;
    onEvent({
      type: "status",
      status: {
        state: "connected",
        reconnected: false,
        legacyRelay: false,
        accessProfileAccepted: true,
        workspaceLabelAccepted: true,
      },
    });

    // Leave enough time to open Activity and see the untouched waiting state.
    if (!await sleep(2_000, signal)) return;

    while (!signal.aborted) {
      for (const template of demoJobs) {
        cycle += 1;
        const job = { ...template, requestId: `${template.requestId}-${cycle}` } as WorkerJob;
        onEvent({ type: "activity", phase: "started", job });
        if (!await sleep(job.type === "run_command" ? 2_400 : 1_500, signal)) {
          return;
        }
        onEvent({
          type: "activity",
          phase: "returned",
          job,
          ok: job.type !== "search_text",
        });
        if (!await sleep(1_500, signal)) return;
      }
      if (!await sleep(3_000, signal)) return;
    }
  },
  async loadStatus() {
    return {
      account: "Demo account",
      relay: "Local HUD simulation",
      activeWorkers: revoked ? 0 : 1,
      devices: revoked
        ? []
        : [{
            id: "demo-device",
            name: deviceName,
            platform: `${process.platform}-${process.arch}`,
            lastSeen: "just now",
            status: "1 active worker",
          }],
    };
  },
  async revokeDevice() {
    revoked = true;
  },
  changeAccessProfile(nextAccessProfile) {
    accessProfile = nextAccessProfile;
    setTimeout(() => {
      reportAccessProfile?.(accessProfile);
      reportConnected?.();
    }, 250);
  },
});
