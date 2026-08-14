import path from "node:path";
import {
  configDirectory,
  SecureStore,
  type StorageBackend,
} from "./secure-store.js";

export const FILE_CREDENTIAL_WARNING =
  "Warning: the operating-system credential store is unavailable. Glossa is using a mode-0600 credential file.";

export interface StoredCredentials {
  issuer: string;
  clientId: string;
  audience: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  tokenType: string;
  scope?: string;
  requestedScope?: string;
}

export type CredentialBackend = StorageBackend;

export interface LoadedCredentials {
  credentials: StoredCredentials;
  backend: CredentialBackend;
}

function parseCredentials(value: string): StoredCredentials {
  let parsed: Partial<StoredCredentials>;
  try {
    parsed = JSON.parse(value) as Partial<StoredCredentials>;
  } catch {
    throw new Error("Stored Glossa credentials are invalid.");
  }
  if (
    typeof parsed.issuer !== "string" ||
    typeof parsed.clientId !== "string" ||
    typeof parsed.audience !== "string" ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    typeof parsed.tokenType !== "string" ||
    (parsed.refreshToken !== undefined && typeof parsed.refreshToken !== "string") ||
    (parsed.scope !== undefined && typeof parsed.scope !== "string") ||
    (parsed.requestedScope !== undefined && typeof parsed.requestedScope !== "string")
  ) {
    throw new Error("Stored Glossa credentials are invalid.");
  }
  return parsed as StoredCredentials;
}

const store = new SecureStore<StoredCredentials>({
  account: "oauth",
  file: path.join(configDirectory(), "credentials.json"),
  warning: FILE_CREDENTIAL_WARNING,
  parse: parseCredentials,
});

export async function saveCredentials(
  credentials: StoredCredentials,
): Promise<CredentialBackend> {
  return await store.save(credentials);
}

export async function loadCredentials(): Promise<LoadedCredentials | null> {
  const loaded = await store.load();
  return loaded
    ? { credentials: loaded.value, backend: loaded.backend }
    : null;
}

export async function deleteCredentials(): Promise<void> {
  await store.delete();
}
