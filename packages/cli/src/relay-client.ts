import os from "node:os";
import { deviceNameSchema } from "@glossa/protocol";
import type { FetchLike } from "./oauth.js";
import type { StoredDeviceCredential } from "./device-store.js";

export const DEFAULT_RELAY_ORIGIN = "https://mcp.glossa.sh";

export interface RelayEndpoints {
  relayOrigin: string;
  workerOrigin: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function normalizedOrigin(value: string, kind: "relay" | "worker"): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`GLOSSA_${kind === "relay" ? "RELAY" : "WORKER"}_ORIGIN must contain only an origin.`);
  }
  if (url.protocol === "https:") return url.origin;
  const allowedHttp =
    url.protocol === "http:" &&
    (isLoopback(url.hostname) || (kind === "worker" && isPrivateIpv4(url.hostname)));
  if (!allowedHttp) {
    throw new Error(
      `GLOSSA_${kind === "relay" ? "RELAY" : "WORKER"}_ORIGIN must use HTTPS${
        kind === "worker" ? " unless it is a loopback or private IPv4 address" : " unless it is loopback"
      }.`,
    );
  }
  return url.origin;
}

export function loadRelayOrigin(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return normalizedOrigin(
    environment.GLOSSA_RELAY_ORIGIN?.trim() || DEFAULT_RELAY_ORIGIN,
    "relay",
  );
}

export function loadWorkerOrigin(
  relayOrigin: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return normalizedOrigin(
    environment.GLOSSA_WORKER_ORIGIN?.trim() || relayOrigin,
    "worker",
  );
}

export function loadRelayEndpoints(
  environment: NodeJS.ProcessEnv = process.env,
): RelayEndpoints {
  const relayOrigin = loadRelayOrigin(environment);
  const workerOrigin = loadWorkerOrigin(relayOrigin, environment);
  return { relayOrigin, workerOrigin };
}

export function defaultDeviceName(): string {
  return deviceNameSchema.parse(os.hostname());
}

interface EnrollmentResponse {
  device?: { id?: unknown; name?: unknown };
  device_token?: unknown;
  error?: unknown;
}

interface RelayErrorResponse {
  error?: unknown;
}

export interface RelayDevice {
  id: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  activeWorkers: number | null;
}

interface DeviceListResponse extends RelayErrorResponse {
  devices?: unknown;
}

function relayError(
  status: number,
  data: RelayErrorResponse,
  unauthorized: string,
): Error {
  if (status === 401) return new Error(unauthorized);
  if (status === 403 && data.error === "account_disabled") {
    return new Error("This Glossa account is disabled.");
  }
  if (status === 403 && data.error === "identity_provider_not_allowed") {
    return new Error(
      "This Glossa identity is not allowed. Sign in with an approved account.",
    );
  }
  if (status === 409 && data.error === "device_name_conflict") {
    return new Error(
      "Glossa could not choose a unique name for this computer. Try again.",
    );
  }
  if (status === 404 && data.error === "device_not_found") {
    return new Error("The Glossa device was not found.");
  }
  if (status === 429) return new Error("Glossa device enrollment is rate limited. Try again later.");
  return new Error(`The Glossa relay returned HTTP ${status}.`);
}

function validNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseDevices(value: unknown): RelayDevice[] {
  if (!Array.isArray(value)) {
    throw new Error("The Glossa relay returned an invalid device list response.");
  }
  const devices = value as Array<Partial<RelayDevice>>;
  if (devices.some((device) =>
    typeof device.id !== "string" ||
    typeof device.name !== "string" ||
    !validNullableString(device.platform) ||
    !validNullableString(device.lastSeenAt) ||
    !validNullableString(device.revokedAt) ||
    device.activeWorkers !== undefined &&
    (!Number.isInteger(device.activeWorkers) || device.activeWorkers! < 0)
  )) {
    throw new Error("The Glossa relay returned an invalid device list response.");
  }
  return devices.map((device) => ({
    ...(device as Omit<RelayDevice, "activeWorkers">),
    activeWorkers: device.activeWorkers ?? null,
  }));
}

const PAIRING_REJECTED =
  "This computer's pairing is no longer valid. Run Glossa again to pair it.";

export async function listDevices(
  endpoints: RelayEndpoints,
  authorization: string,
  fetchRequest: FetchLike = fetch,
): Promise<RelayDevice[]> {
  const response = await fetchRequest(`${endpoints.relayOrigin}/v1/devices`, {
    headers: { authorization },
  });
  let data: DeviceListResponse = {};
  try {
    data = (await response.json()) as DeviceListResponse;
  } catch {
    // Status-specific errors below remain stable for non-JSON proxy responses.
  }
  if (!response.ok) throw relayError(response.status, data, PAIRING_REJECTED);
  return parseDevices(data.devices);
}

export async function enrollDevice(
  endpoints: RelayEndpoints,
  authorization: string,
  deviceName: string,
  fetchRequest: FetchLike = fetch,
): Promise<StoredDeviceCredential> {
  const baseName = deviceNameSchema.parse(deviceName);
  let name = baseName;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchRequest(`${endpoints.relayOrigin}/v1/devices/enroll`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, platform: `${process.platform}-${process.arch}` }),
    });
    let data: EnrollmentResponse = {};
    try {
      data = (await response.json()) as EnrollmentResponse;
    } catch {
      // Status-specific errors below remain stable for non-JSON proxy responses.
    }
    if (
      response.status === 409 &&
      data.error === "device_name_conflict" &&
      attempt < 2
    ) {
      const activeNames = new Set(
        (await listDevices(endpoints, authorization, fetchRequest))
          .filter((device) => device.revokedAt === null)
          .map((device) => device.name),
      );
      for (let suffix = 2; ; suffix += 1) {
        const ending = `-${suffix}`;
        const candidate = `${baseName.slice(0, 80 - ending.length)}${ending}`;
        if (!activeNames.has(candidate)) {
          name = deviceNameSchema.parse(candidate);
          break;
        }
      }
      continue;
    }
    if (!response.ok) {
      throw relayError(
        response.status,
        data,
        "Pairing authorization was rejected. Run Glossa again to retry pairing.",
      );
    }
    if (
      typeof data.device?.id !== "string" ||
      typeof data.device.name !== "string" ||
      typeof data.device_token !== "string"
    ) {
      throw new Error("The Glossa relay returned an invalid device enrollment response.");
    }
    return {
      relayOrigin: endpoints.relayOrigin,
      deviceId: data.device.id,
      deviceName: data.device.name,
      token: data.device_token,
    };
  }

  throw new Error("Glossa could not enroll this computer.");
}

export async function revokePairedDevice(
  endpoints: Pick<RelayEndpoints, "relayOrigin">,
  device: StoredDeviceCredential,
  fetchRequest: FetchLike = fetch,
): Promise<void> {
  const response = await fetchRequest(`${endpoints.relayOrigin}/device`, {
    method: "DELETE",
    headers: { authorization: `Device ${device.token}` },
  });
  if (response.ok || response.status === 401 || response.status === 404) return;
  if (response.status === 429) {
    throw new Error("Glossa device authentication is rate limited. Try again later.");
  }
  throw new Error(`The Glossa relay returned HTTP ${response.status}.`);
}

export async function revokeDevice(
  endpoints: RelayEndpoints,
  authorization: string,
  deviceId: string,
  fetchRequest: FetchLike = fetch,
): Promise<void> {
  const response = await fetchRequest(`${endpoints.relayOrigin}/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { authorization },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as RelayErrorResponse;
    throw relayError(response.status, data, PAIRING_REJECTED);
  }
}
