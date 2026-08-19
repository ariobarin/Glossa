import { setTimeout as delay } from "node:timers/promises";
import type { StoredDeviceCredential } from "./device-store.js";
import { NetworkRequestError } from "./network-error.js";
import { networkFetch } from "./network-fetch.js";
import {
  createPairing,
  defaultDeviceName,
  PairingCodeExpiredError,
  redeemPairing,
  type FetchLike,
  type RelayEndpoints,
} from "./relay-client.js";

export interface PairDeviceDependencies {
  createPairing?: typeof createPairing;
  redeemPairing?: typeof redeemPairing;
  defaultDeviceName?: typeof defaultDeviceName;
  fetch?: FetchLike;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

const MAX_PAIRING_CODES = 3;
const MAX_CREATE_NETWORK_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 2_000;

function canceledError(): Error {
  return new Error("Pairing canceled.");
}

async function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, signal ? { signal } : undefined);
}

export async function pairDevice(
  endpoints: RelayEndpoints,
  signal?: AbortSignal,
  dependencies: PairDeviceDependencies = {},
): Promise<StoredDeviceCredential> {
  const create = dependencies.createPairing ?? createPairing;
  const redeem = dependencies.redeemPairing ?? redeemPairing;
  const name = dependencies.defaultDeviceName ?? defaultDeviceName;
  const wait = dependencies.delay ?? defaultDelay;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;
  const baseFetch = dependencies.fetch ?? networkFetch;
  const fetchRequest: FetchLike = signal
    ? async (input, init) => await baseFetch(input, { ...init, signal })
    : baseFetch;
  let lastNetworkMessage: string | undefined;

  try {
    signal?.throwIfAborted();
    log("This computer needs to be paired with Glossa.");
    const deviceName = name();
    const platform = `${process.platform}-${process.arch}`;

    for (let attempt = 0; attempt < MAX_PAIRING_CODES; attempt += 1) {
      signal?.throwIfAborted();
      const pairing = await (async () => {
        for (
          let networkAttempt = 0;
          networkAttempt < MAX_CREATE_NETWORK_ATTEMPTS;
          networkAttempt += 1
        ) {
          try {
            return await create(endpoints, deviceName, platform, fetchRequest);
          } catch (error) {
            if (
              !(error instanceof NetworkRequestError) ||
              networkAttempt === MAX_CREATE_NETWORK_ATTEMPTS - 1
            ) {
              throw error;
            }
            if (lastNetworkMessage !== error.message) {
              log(`${error.message} Retrying pairing...`);
              lastNetworkMessage = error.message;
            }
            await wait(POLL_INTERVAL_MS, signal);
            signal?.throwIfAborted();
          }
        }
        throw new Error("Glossa could not create a pairing code.");
      })();
      log("");
      log(`Pairing code: ${pairing.code} (valid for 10 minutes)`);
      log("");
      log(`Enter it at ${endpoints.relayOrigin}/panel`);

      const expiresAt = Date.parse(pairing.expiresAt);
      while (now() < expiresAt) {
        signal?.throwIfAborted();
        await wait(POLL_INTERVAL_MS, signal);
        signal?.throwIfAborted();
        try {
          const redeemed = await redeem(endpoints, pairing.code, fetchRequest);
          if (redeemed === "pending") continue;
          log(`Paired with Glossa as ${redeemed.device.name}.`);
          return {
            relayOrigin: endpoints.relayOrigin,
            deviceId: redeemed.device.id,
            deviceName: redeemed.device.name,
            token: redeemed.token,
          };
        } catch (error) {
          if (error instanceof PairingCodeExpiredError) {
            log(error.message);
            break;
          }
          if (error instanceof NetworkRequestError) {
            if (lastNetworkMessage !== error.message) {
              log(`${error.message} Retrying pairing...`);
              lastNetworkMessage = error.message;
            }
            continue;
          }
          throw error;
        }
      }
    }

    throw new Error("Pairing timed out. Run Glossa again to retry.");
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw canceledError();
    }
    throw error;
  }
}
