import { setTimeout as delay } from "node:timers/promises";
import { grantedScopesSatisfyRequest } from "./auth-scopes.js";
import { type FetchLike } from "./auth-session.js";
import { saveCredentials, type StoredCredentials } from "./config-store.js";
import { openBrowser } from "./open-browser.js";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

interface OAuthError {
  error: string;
  error_description?: string;
}

export interface LoginOptions {
  issuer: string;
  clientId: string;
  audience: string;
  scope: string;
  signal?: AbortSignal;
}

export interface DeviceFlowDependencies {
  fetch?: FetchLike;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  openBrowser?: typeof openBrowser;
  saveCredentials?: typeof saveCredentials;
  now?: () => number;
  log?: (message: string) => void;
}

export type DeviceAuthorizationDependencies = Omit<
  DeviceFlowDependencies,
  "saveCredentials"
>;

function endpoint(issuer: string, pathname: string): string {
  return new URL(pathname, issuer.endsWith("/") ? issuer : `${issuer}/`).toString();
}

function canceledError(): Error {
  return new Error("Login canceled.");
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw canceledError();
}

async function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, signal ? { signal } : undefined);
}

async function postForm<T>(
  fetchRequest: FetchLike,
  url: string,
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    ...(signal ? { signal } : {}),
  });
  const data = (await response.json()) as T;
  if (!response.ok) {
    const oauth = data as OAuthError;
    throw new Error(oauth.error_description ?? oauth.error ?? `HTTP ${response.status}`);
  }
  return data;
}

export async function authorizeWithDeviceFlow(
  options: LoginOptions,
  dependencies: DeviceAuthorizationDependencies = {},
): Promise<StoredCredentials> {
  const fetchRequest = dependencies.fetch ?? fetch;
  const wait = dependencies.delay ?? defaultDelay;
  const browse = dependencies.openBrowser ?? openBrowser;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;

  try {
    assertActive(options.signal);
    const code = await postForm<DeviceCodeResponse>(
      fetchRequest,
      endpoint(options.issuer, "oauth/device/code"),
      {
        client_id: options.clientId,
        audience: options.audience,
        scope: options.scope,
      },
      options.signal,
    );

    const verificationUrl = code.verification_uri_complete ?? code.verification_uri;
    const opened = await browse(verificationUrl);

    log(opened ? "Opened your browser for Glossa login." : "Open this URL to sign in:");
    log(verificationUrl);
    if (!code.verification_uri_complete) log(`Code: ${code.user_code}`);

    const startedAt = now();
    let intervalSeconds = Math.max(code.interval ?? 5, 1);

    while (now() - startedAt < code.expires_in * 1000) {
      assertActive(options.signal);
      await wait(intervalSeconds * 1000, options.signal);
      assertActive(options.signal);

      const response = await fetchRequest(endpoint(options.issuer, "oauth/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: options.clientId,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const data = (await response.json()) as TokenResponse | OAuthError;
      if (response.ok && "access_token" in data) {
        const grantedScope = data.scope ?? options.scope;
        if (!grantedScopesSatisfyRequest(
          grantedScope,
          options.scope,
          Boolean(data.refresh_token),
        )) {
          throw new Error("Auth0 did not grant the permissions Glossa requires.");
        }
        return {
          issuer: options.issuer,
          clientId: options.clientId,
          audience: options.audience,
          accessToken: data.access_token,
          ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
          expiresAt: new Date(now() + data.expires_in * 1000).toISOString(),
          tokenType: data.token_type,
          scope: grantedScope,
          requestedScope: options.scope,
        };
      }

      const error = data as OAuthError;
      if (error.error === "authorization_pending") continue;
      if (error.error === "slow_down") {
        intervalSeconds += 5;
        continue;
      }
      if (error.error === "access_denied") throw new Error("Login was denied.");
      if (error.error === "expired_token") throw new Error("The login code expired.");
      throw new Error(error.error_description ?? error.error);
    }

    throw new Error("The login code expired.");
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw canceledError();
    }
    throw error;
  }
}

export async function loginWithDeviceFlow(
  options: LoginOptions,
  dependencies: DeviceFlowDependencies = {},
): Promise<void> {
  const credentials = await authorizeWithDeviceFlow(options, dependencies);
  if (!credentials.refreshToken) {
    throw new Error("Auth0 did not issue a refresh token.");
  }
  const save = dependencies.saveCredentials ?? saveCredentials;
  await save(credentials);
  (dependencies.log ?? console.log)("Signed in to Glossa.");
}
