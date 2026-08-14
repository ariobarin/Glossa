import { setTimeout as delay } from "node:timers/promises";
import { grantedScopesSatisfyRequest } from "./auth-scopes.js";
import {
  isTokenResponse,
  issuerEndpoint,
  oauthErrorMessage,
  type FetchLike,
  type OAuthError,
  type OAuthTokenResponse,
} from "./oauth.js";
import { openBrowser } from "./open-browser.js";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface PairingOptions {
  issuer: string;
  clientId: string;
  audience: string;
  scope: string;
  signal?: AbortSignal;
}

/**
 * The temporary browser authorization used to enroll this computer. It is
 * never stored: pairing trades it for the durable device credential.
 */
export interface PairingAuthorization {
  accessToken: string;
  tokenType: string;
}

export interface DeviceFlowDependencies {
  fetch?: FetchLike;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  openBrowser?: typeof openBrowser;
  now?: () => number;
  log?: (message: string) => void;
}

function canceledError(): Error {
  return new Error("Pairing canceled.");
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
    throw new Error(oauthErrorMessage(data as OAuthError, response.status));
  }
  return data;
}

export async function authorizePairing(
  options: PairingOptions,
  dependencies: DeviceFlowDependencies = {},
): Promise<PairingAuthorization> {
  const fetchRequest = dependencies.fetch ?? fetch;
  const wait = dependencies.delay ?? defaultDelay;
  const browse = dependencies.openBrowser ?? openBrowser;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.log;

  try {
    assertActive(options.signal);
    const code = await postForm<DeviceCodeResponse>(
      fetchRequest,
      issuerEndpoint(options.issuer, "oauth/device/code"),
      {
        client_id: options.clientId,
        audience: options.audience,
        scope: options.scope,
      },
      options.signal,
    );

    const verificationUrl = code.verification_uri_complete ?? code.verification_uri;
    const opened = await browse(verificationUrl);

    log(opened ? "Opened your browser to pair this computer." : "Open this URL to pair this computer:");
    log(verificationUrl);
    if (!code.verification_uri_complete) log(`Code: ${code.user_code}`);

    const startedAt = now();
    let intervalSeconds = Math.max(code.interval ?? 5, 1);

    while (now() - startedAt < code.expires_in * 1000) {
      assertActive(options.signal);
      await wait(intervalSeconds * 1000, options.signal);
      assertActive(options.signal);

      const response = await fetchRequest(issuerEndpoint(options.issuer, "oauth/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: options.clientId,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      const data = (await response.json()) as OAuthTokenResponse | OAuthError;
      if (response.ok && isTokenResponse(data)) {
        const grantedScope = data.scope ?? options.scope;
        if (!grantedScopesSatisfyRequest(
          grantedScope,
          options.scope,
          Boolean(data.refresh_token),
        )) {
          throw new Error("Auth0 did not grant the permissions Glossa requires.");
        }
        return {
          accessToken: data.access_token,
          tokenType: data.token_type,
        };
      }

      const error = data as OAuthError;
      if (error.error === "authorization_pending") continue;
      if (error.error === "slow_down") {
        intervalSeconds += 5;
        continue;
      }
      if (error.error === "access_denied") throw new Error("Pairing was denied.");
      if (error.error === "expired_token") throw new Error("The pairing code expired.");
      throw new Error(oauthErrorMessage(error, response.status));
    }

    throw new Error("The pairing code expired.");
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw canceledError();
    }
    throw error;
  }
}
