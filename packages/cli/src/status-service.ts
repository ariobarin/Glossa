import {
  loadUserProfile,
  validCredentials,
  type FetchLike,
} from "./auth-session.js";
import type { StoredCredentials } from "./config-store.js";
import {
  listDevices,
  type RelayDevice,
  type RelayEndpoints,
} from "./relay-client.js";

export interface StatusDetails {
  account: string;
  relay: string;
  activeWorkers: number | null;
  devices: RelayDevice[];
}

export interface StatusDependencies {
  validCredentials?: typeof validCredentials;
  loadUserProfile?: typeof loadUserProfile;
  listDevices?: typeof listDevices;
  fetch?: FetchLike;
}

function accountLabel(profile: {
  sub: string;
  name?: string;
  email?: string;
}): string {
  return profile.email ?? profile.name ?? profile.sub;
}

function activeWorkerCount(devices: RelayDevice[]): number | null {
  if (devices.some((device) => device.activeWorkers === null)) return null;
  return devices.reduce((sum, device) => sum + device.activeWorkers!, 0);
}

export class WorkspaceStatusService {
  #credentials: StoredCredentials;

  constructor(
    credentials: StoredCredentials,
    readonly endpoints: RelayEndpoints,
    readonly dependencies: StatusDependencies = {},
  ) {
    this.#credentials = credentials;
  }

  async refresh(signal?: AbortSignal): Promise<StatusDetails> {
    const validate = this.dependencies.validCredentials ?? validCredentials;
    const devicesForAccount = this.dependencies.listDevices ?? listDevices;
    const profileForAccount =
      this.dependencies.loadUserProfile ?? loadUserProfile;
    const baseFetch = this.dependencies.fetch ?? fetch;
    const fetchRequest: FetchLike = signal
      ? async (input, init) => await baseFetch(input, { ...init, signal })
      : baseFetch;

    this.#credentials = await validate(
      this.#credentials,
      signal ? { signal } : {},
    );
    const requestCredentials = this.#credentials;
    const profileRequest = profileForAccount(
      requestCredentials,
      signal ? { signal, fetch: fetchRequest } : { fetch: fetchRequest },
    ).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return null;
    });
    const devicesRequest = devicesForAccount(
      this.endpoints,
      requestCredentials,
      fetchRequest,
    );
    const [profile, devices] = await Promise.all([
      profileRequest,
      devicesRequest,
    ]);
    if (profile) this.#credentials = profile.credentials;

    return {
      account: profile ? accountLabel(profile.profile) : "Account unavailable",
      relay: this.endpoints.relayOrigin,
      activeWorkers: activeWorkerCount(devices),
      devices,
    };
  }
}
