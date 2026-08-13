import { setTimeout as delay } from "node:timers/promises";
import type { FetchLike } from "./auth-session.js";
import type { StoredDeviceCredential } from "./device-store.js";
import {
  beginDevicePairing,
  completeDevicePairing,
  defaultDeviceName,
  type DevicePairingChallenge,
  type RelayEndpoints,
} from "./relay-client.js";

export interface PairDeviceDependencies {
  beginDevicePairing?: typeof beginDevicePairing;
  completeDevicePairing?: typeof completeDevicePairing;
  defaultDeviceName?: typeof defaultDeviceName;
  fetch?: FetchLike;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

async function defaultWait(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await delay(milliseconds, undefined, signal ? { signal } : undefined);
}

function canceledError(): Error {
  return new Error("Pairing canceled.");
}

export async function pairDevice(
  endpoints: RelayEndpoints,
  signal?: AbortSignal,
  dependencies: PairDeviceDependencies = {},
): Promise<StoredDeviceCredential> {
  const begin = dependencies.beginDevicePairing ?? beginDevicePairing;
  const complete = dependencies.completeDevicePairing ?? completeDevicePairing;
  const name = dependencies.defaultDeviceName ?? defaultDeviceName;
  const wait = dependencies.wait ?? defaultWait;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;
  const baseFetch = dependencies.fetch ?? fetch;
  const fetchRequest: FetchLike = signal
    ? async (input, init) => await baseFetch(input, { ...init, signal })
    : baseFetch;

  try {
    signal?.throwIfAborted();
    const challenge = await begin(endpoints, name(), fetchRequest);
    log("This computer needs to be paired with Glossa.");
    log("In ChatGPT, send this message:");
    log(`@Glossa pair ${challenge.userCode}`);
    log("Keep this terminal open. The pairing code expires in 5 minutes.");

    const expiresAt = Date.parse(challenge.expiresAt);
    while (now() < expiresAt) {
      signal?.throwIfAborted();
      await wait(challenge.pollIntervalMs, signal);
      signal?.throwIfAborted();
      const paired = await complete(endpoints, challenge, fetchRequest);
      if (!paired) continue;
      log(`Paired with Glossa as ${paired.deviceName}.`);
      return paired;
    }
    throw new Error("The Glossa pairing code expired. Run Glossa again to get a new code.");
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw canceledError();
    }
    throw error;
  }
}

export type { DevicePairingChallenge };
