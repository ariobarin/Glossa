import {
  SessionExpiredError,
  validCredentials,
} from "./auth-session.js";
import {
  loadCredentials,
  type StoredCredentials,
} from "./config-store.js";
import {
  loginWithDeviceFlow,
  type LoginOptions,
} from "./device-flow.js";
import {
  grantedScopesSatisfyRequest,
  scopesMatch,
} from "./auth-scopes.js";

export interface SignInDependencies {
  loadCredentials?: typeof loadCredentials;
  validCredentials?: typeof validCredentials;
  loginWithDeviceFlow?: typeof loginWithDeviceFlow;
}

function normalizedIssuer(value: string): string {
  return value.replace(/\/+$/, "");
}

export function credentialsMatchLoginOptions(
  credentials: StoredCredentials,
  options: LoginOptions,
): boolean {
  return (
    normalizedIssuer(credentials.issuer) === normalizedIssuer(options.issuer) &&
    credentials.clientId === options.clientId &&
    credentials.audience === options.audience &&
    scopesMatch(credentials.requestedScope, options.scope) &&
    grantedScopesSatisfyRequest(
      credentials.scope,
      options.scope,
      Boolean(credentials.refreshToken),
    )
  );
}

/**
 * Returns the stored session, refreshing it when needed. Never starts an
 * interactive login: callers that cannot open a browser prompt (such as the
 * running HUD) use this and surface the SessionExpiredError instead.
 */
export async function currentSession(
  options: LoginOptions,
  dependencies: SignInDependencies = {},
): Promise<StoredCredentials> {
  const load = dependencies.loadCredentials ?? loadCredentials;
  const validate = dependencies.validCredentials ?? validCredentials;
  const loaded = await load();

  if (!loaded || !credentialsMatchLoginOptions(loaded.credentials, options)) {
    throw new SessionExpiredError();
  }
  return await validate(
    loaded.credentials,
    options.signal ? { signal: options.signal } : {},
  );
}

/**
 * Returns a valid session, signing in through the browser device flow when no
 * valid stored session exists.
 */
export async function signedInSession(
  options: LoginOptions,
  dependencies: SignInDependencies = {},
): Promise<StoredCredentials> {
  const login = dependencies.loginWithDeviceFlow ?? loginWithDeviceFlow;
  try {
    return await currentSession(options, dependencies);
  } catch (error) {
    if (!(error instanceof SessionExpiredError)) throw error;
  }

  await login(options);
  return await currentSession(options, dependencies);
}
