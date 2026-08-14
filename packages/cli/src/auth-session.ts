import {
  deleteCredentials,
  saveCredentials,
  type StoredCredentials,
} from "./config-store.js";
import { grantedScopesSatisfyRequest } from "./auth-scopes.js";
import {
  isTokenResponse,
  issuerEndpoint,
  oauthErrorMessage,
  type OAuthError,
  type OAuthTokenResponse,
} from "./oauth.js";

const EXPIRY_BUFFER_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UserProfile {
  sub: string;
  name?: string;
  email?: string;
}

export interface AuthSessionDependencies {
  fetch?: FetchLike;
  saveCredentials?: typeof saveCredentials;
  deleteCredentials?: typeof deleteCredentials;
  now?: () => number;
  signal?: AbortSignal;
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired. Run Glossa again to sign in.");
    this.name = "SessionExpiredError";
  }
}

export function accessTokenSubject(credentials: StoredCredentials): string {
  try {
    const parts = credentials.accessToken.split(".");
    if (parts.length !== 3) throw new Error();
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { sub?: unknown };
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error();
    }
    return payload.sub;
  } catch {
    throw new Error("Glossa could not identify the signed-in account.");
  }
}

function sessionExpiredError(): SessionExpiredError {
  return new SessionExpiredError();
}

export function accessTokenNeedsRefresh(
  credentials: StoredCredentials,
  now = Date.now(),
): boolean {
  return Date.parse(credentials.expiresAt) <= now + EXPIRY_BUFFER_MS;
}

export async function refreshCredentials(
  credentials: StoredCredentials,
  dependencies: AuthSessionDependencies = {},
): Promise<StoredCredentials> {
  if (!credentials.refreshToken) throw sessionExpiredError();

  const fetchRequest = dependencies.fetch ?? fetch;
  const remove = dependencies.deleteCredentials ?? deleteCredentials;
  const save = dependencies.saveCredentials ?? saveCredentials;
  const now = dependencies.now ?? Date.now;
  const response = await fetchRequest(issuerEndpoint(credentials.issuer, "oauth/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      refresh_token: credentials.refreshToken,
    }),
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  const data = (await response.json()) as OAuthTokenResponse | OAuthError;

  if (!response.ok || !isTokenResponse(data)) {
    const oauth = data as OAuthError;
    if (oauth.error === "invalid_grant") {
      await remove();
      throw sessionExpiredError();
    }
    throw new Error(oauthErrorMessage(oauth, response.status));
  }

  const grantedScope = data.scope ?? credentials.scope;
  if (
    credentials.requestedScope &&
    !grantedScopesSatisfyRequest(
      grantedScope,
      credentials.requestedScope,
      Boolean(data.refresh_token ?? credentials.refreshToken),
    )
  ) {
    await remove();
    throw sessionExpiredError();
  }

  const refreshed: StoredCredentials = {
    ...credentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    expiresAt: new Date(now() + data.expires_in * 1000).toISOString(),
    tokenType: data.token_type,
    ...(grantedScope ? { scope: grantedScope } : {}),
  };
  await save(refreshed);
  return refreshed;
}

export async function validCredentials(
  credentials: StoredCredentials,
  dependencies: AuthSessionDependencies = {},
): Promise<StoredCredentials> {
  const now = dependencies.now ?? Date.now;
  if (!accessTokenNeedsRefresh(credentials, now())) return credentials;
  return await refreshCredentials(credentials, dependencies);
}

function parseProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object") {
    throw new Error("Auth0 returned an invalid user profile.");
  }
  const profile = value as Partial<UserProfile>;
  if (
    typeof profile.sub !== "string" ||
    (profile.name !== undefined && typeof profile.name !== "string") ||
    (profile.email !== undefined && typeof profile.email !== "string")
  ) {
    throw new Error("Auth0 returned an invalid user profile.");
  }
  return profile as UserProfile;
}

async function requestProfile(
  credentials: StoredCredentials,
  fetchRequest: FetchLike,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetchRequest(issuerEndpoint(credentials.issuer, "userinfo"), {
    headers: { authorization: `${credentials.tokenType} ${credentials.accessToken}` },
    ...(signal ? { signal } : {}),
  });
}

export async function loadUserProfile(
  credentials: StoredCredentials,
  dependencies: AuthSessionDependencies = {},
): Promise<{ credentials: StoredCredentials; profile: UserProfile }> {
  const fetchRequest = dependencies.fetch ?? fetch;
  let current = await validCredentials(credentials, dependencies);
  let response = await requestProfile(current, fetchRequest, dependencies.signal);

  if (response.status === 401 && current.refreshToken) {
    current = await refreshCredentials(current, dependencies);
    response = await requestProfile(current, fetchRequest, dependencies.signal);
  }

  if (!response.ok) {
    throw new Error(`Auth0 profile request failed with HTTP ${response.status}.`);
  }
  return { credentials: current, profile: parseProfile(await response.json()) };
}
