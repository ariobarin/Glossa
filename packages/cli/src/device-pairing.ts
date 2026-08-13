import type { FetchLike } from "./auth-session.js";
import { loadAuthConfig } from "./auth-config.js";
import { authorizeWithDeviceFlow } from "./device-flow.js";
import type { StoredDeviceCredential } from "./device-store.js";
import {
  defaultDeviceName,
  enrollDevice,
  type RelayEndpoints,
} from "./relay-client.js";

export interface PairDeviceDependencies {
  authorizeWithDeviceFlow?: typeof authorizeWithDeviceFlow;
  defaultDeviceName?: typeof defaultDeviceName;
  enrollDevice?: typeof enrollDevice;
  loadAuthConfig?: typeof loadAuthConfig;
  fetch?: FetchLike;
  log?: (message: string) => void;
}

function canceledError(): Error {
  return new Error("Pairing canceled.");
}

function pairingScope(scope: string): string {
  return scope
    .split(/\s+/)
    .filter((value) => value && value !== "offline_access")
    .join(" ");
}

export async function pairDevice(
  endpoints: RelayEndpoints,
  signal?: AbortSignal,
  dependencies: PairDeviceDependencies = {},
): Promise<StoredDeviceCredential> {
  const authorize = dependencies.authorizeWithDeviceFlow ?? authorizeWithDeviceFlow;
  const enroll = dependencies.enrollDevice ?? enrollDevice;
  const authConfig = dependencies.loadAuthConfig ?? loadAuthConfig;
  const name = dependencies.defaultDeviceName ?? defaultDeviceName;
  const log = dependencies.log ?? console.log;
  const baseFetch = dependencies.fetch ?? fetch;
  const fetchRequest: FetchLike = signal
    ? async (input, init) => await baseFetch(input, { ...init, signal })
    : baseFetch;

  try {
    signal?.throwIfAborted();
    log("This computer needs to be paired with Glossa.");
    const auth = authConfig();
    const credentials = await authorize(
      {
        ...auth,
        scope: pairingScope(auth.scope),
        ...(signal ? { signal } : {}),
      },
      { fetch: fetchRequest, log },
    );
    signal?.throwIfAborted();
    const paired = await enroll(endpoints, credentials, name(), fetchRequest);
    log(`Paired with Glossa as ${paired.deviceName}.`);
    return paired;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw canceledError();
    }
    throw error;
  }
}
