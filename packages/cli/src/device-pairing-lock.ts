import { withProcessLease } from "./process-lease.js";
import { updateRuntimeDirectory } from "./update-lock.js";

const DEVICE_PAIRING_LEASE = {
  lockName: "device-pairing.lock",
  pollMs: 100,
  maxAgeMs: 6 * 60_000,
  guardMaxAgeMs: 30_000,
} as const;

export async function withDevicePairingLease<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
  directory = updateRuntimeDirectory(),
): Promise<T> {
  return await withProcessLease(action, DEVICE_PAIRING_LEASE, signal, directory);
}
