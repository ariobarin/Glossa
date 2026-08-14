import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDirectory } from "./secure-store.js";

export type UpdateChannel = "beta" | "stable";
export type UpdatePolicy = "notify" | "auto" | "off";

export interface UpdateState {
  policy: UpdatePolicy;
  channel: UpdateChannel;
  lastCheckedAt?: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    const lastCheckedAt = optionalString(parsed.lastCheckedAt);
    return {
      policy: isPolicy(parsed.policy) ? parsed.policy : defaults.policy,
      channel: isChannel(parsed.channel) ? parsed.channel : defaults.channel,
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return defaults;
    }
    throw error;
  }
}

export async function saveUpdateState(
  state: UpdateState,
  file = updateStateFile(),
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
  const previous = await loadUpdateState(currentVersion, file);
  const state: UpdateState = {
    policy: changes.policy ?? previous.policy,
    channel: changes.channel ?? previous.channel,
  };
  await saveUpdateState(state, file);
  return state;
}

export async function recordUpdateCheck(
  currentVersion: string,
  checkedAt = new Date(),
  file = updateStateFile(),
): Promise<UpdateState> {
  const state = {
    ...await loadUpdateState(currentVersion, file),
    lastCheckedAt: checkedAt.toISOString(),
  };
  await saveUpdateState(state, file);
  return state;
}

export function isUpdateCheckDue(
  lastCheckedAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!lastCheckedAt) return true;
  const checkedAt = Date.parse(lastCheckedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}
