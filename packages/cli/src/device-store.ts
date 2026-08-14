import path from "node:path";
import { configDirectory, SecureStore } from "./secure-store.js";

export const FILE_DEVICE_WARNING =
  "Warning: the operating-system credential store is unavailable. Glossa is using a mode-0600 device credential file.";

export interface StoredDeviceCredential {
  relayOrigin: string;
  accountSubject?: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

export function parseDeviceCredential(value: string): StoredDeviceCredential {
  let parsed: Partial<StoredDeviceCredential>;
  try {
    parsed = JSON.parse(value) as Partial<StoredDeviceCredential>;
  } catch {
    throw new Error("Stored Glossa device credentials are invalid.");
  }
  let relayOriginValid = false;
  if (typeof parsed.relayOrigin === "string") {
    try {
      relayOriginValid = new URL(parsed.relayOrigin).origin === parsed.relayOrigin;
    } catch {
      relayOriginValid = false;
    }
  }
  if (
    !relayOriginValid ||
    typeof parsed.deviceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed.deviceId,
    ) ||
    typeof parsed.deviceName !== "string" ||
    parsed.deviceName.length === 0 ||
    (parsed.accountSubject !== undefined &&
      (typeof parsed.accountSubject !== "string" ||
        parsed.accountSubject.length === 0)) ||
    typeof parsed.token !== "string" ||
    !parsed.token.startsWith(`gld_${parsed.deviceId}_`)
  ) {
    throw new Error("Stored Glossa device credentials are invalid.");
  }
  return parsed as StoredDeviceCredential;
}

const store = new SecureStore<StoredDeviceCredential>({
  account: "device",
  file: path.join(configDirectory(), "device.json"),
  warning: FILE_DEVICE_WARNING,
  parse: parseDeviceCredential,
});

export async function loadDeviceCredential(): Promise<StoredDeviceCredential | null> {
  return (await store.load())?.value ?? null;
}

export async function saveDeviceCredential(
  credential: StoredDeviceCredential,
): Promise<void> {
  await store.save(credential);
}

export async function deleteDeviceCredential(): Promise<void> {
  await store.delete();
}
