import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { withProcessLease } from "./process-lease.js";
import { configDirectory } from "./secure-store.js";
import type { UpdateInfo } from "./update-service.js";

export type UpdateChannel = "beta" | "stable";
export type UpdatePolicy = "notify" | "auto" | "off";

export interface UpdateState {
  policy: UpdatePolicy;
  channel: UpdateChannel;
  lastCheckedAt?: string;
  availableUpdate?: Pick<UpdateInfo, "currentVersion" | "availableVersion" | "channel">;
  mcpContractVersion?: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_STATE_LOCK_POLL_MS = 25;
const UPDATE_STATE_LOCK_MAX_AGE_MS = 60_000;
const UPDATE_STATE_GUARD_MAX_AGE_MS = 30_000;

export function defaultUpdateChannel(version: string): UpdateChannel {
  return version.includes("-") ? "beta" : "stable";
}

export function updateStateFile(): string {
  return path.join(configDirectory(), "updates.json");
}

function isPolicy(value: unknown): value is UpdatePolicy {
  return value === "notify" || value === "auto" || value === "off";
}

function isChannel(value: unknown): value is UpdateChannel {
  return value === "beta" || value === "stable";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validatedAvailableUpdate(
  value: unknown,
  currentVersion: string,
  channel: UpdateChannel,
): UpdateState["availableUpdate"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const current = semver.valid(currentVersion);
  const available = typeof candidate.availableVersion === "string"
    ? semver.valid(candidate.availableVersion)
    : null;
  if (
    !current || !available || candidate.currentVersion !== current ||
    candidate.channel !== channel || !semver.gt(available, current) ||
    (channel === "stable" && semver.prerelease(available) !== null)
  ) return undefined;
  return { currentVersion: current, availableVersion: available, channel };
}

export async function withUpdateStateLease<T>(
  action: () => Promise<T>,
  file = updateStateFile(),
): Promise<T> {
  return await withProcessLease(
    action,
    {
      lockName: `${path.basename(file)}.lock`,
      pollMs: UPDATE_STATE_LOCK_POLL_MS,
      maxAgeMs: UPDATE_STATE_LOCK_MAX_AGE_MS,
      guardMaxAgeMs: UPDATE_STATE_GUARD_MAX_AGE_MS,
    },
    undefined,
    path.dirname(file),
  );
}

export async function loadUpdateState(
  currentVersion: string,
  file = updateStateFile(),
): Promise<UpdateState> {
  const defaults: UpdateState = {
    policy: "notify",
    channel: defaultUpdateChannel(currentVersion),
  };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
    const lastCheckedAt = optionalString(parsed.lastCheckedAt);
    const mcpContractVersion = optionalString(parsed.mcpContractVersion);
    const channel = isChannel(parsed.channel) ? parsed.channel : defaults.channel;
    const availableUpdate = validatedAvailableUpdate(parsed.availableUpdate, currentVersion, channel);
    return {
      policy: isPolicy(parsed.policy) ? parsed.policy : defaults.policy,
      channel,
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(availableUpdate ? { availableUpdate } : {}),
      ...(mcpContractVersion ? { mcpContractVersion } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return defaults;
    }
    throw error;
  }
}

async function saveUpdateState(
  state: UpdateState,
  file: string,
): Promise<void> {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function configureUpdates(
  currentVersion: string,
  changes: Partial<Pick<UpdateState, "policy" | "channel">>,
  file = updateStateFile(),
): Promise<UpdateState> {
  return await withUpdateStateLease(async () => {
    const previous = await loadUpdateState(currentVersion, file);
    const state: UpdateState = {
      policy: changes.policy ?? previous.policy,
      channel: changes.channel ?? previous.channel,
      ...(previous.mcpContractVersion
        ? { mcpContractVersion: previous.mcpContractVersion }
        : {}),
    };
    await saveUpdateState(state, file);
    return state;
  }, file);
}

export async function recordUpdateCheck(
  info: UpdateInfo,
  checkedAt = new Date(),
  file = updateStateFile(),
): Promise<UpdateState> {
  return await withUpdateStateLease(async () => {
    const loaded = await loadUpdateState(info.currentVersion, file);
    if (loaded.channel !== info.channel) return loaded;
    const { availableUpdate: _previousUpdate, ...previous } = loaded;
    const availableUpdate = info.updateAvailable
      ? validatedAvailableUpdate(info, info.currentVersion, previous.channel)
      : undefined;
    const state = {
      ...previous,
      lastCheckedAt: checkedAt.toISOString(),
      ...(availableUpdate ? { availableUpdate } : {}),
    };
    await saveUpdateState(state, file);
    return state;
  }, file);
}

export async function observeMcpContractVersion(
  currentVersion: string,
  mcpContractVersion: string,
  file = updateStateFile(),
): Promise<boolean> {
  return await withUpdateStateLease(async () => {
    const previous = await loadUpdateState(currentVersion, file);
    if (previous.mcpContractVersion === mcpContractVersion) return false;
    await saveUpdateState({ ...previous, mcpContractVersion }, file);
    return previous.mcpContractVersion !== undefined;
  }, file);
}

export function isUpdateCheckDue(
  lastCheckedAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!lastCheckedAt) return true;
  const checkedAt = Date.parse(lastCheckedAt);
  return !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}
