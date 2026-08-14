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

export interface SignedInSession {
  credentials: StoredCredentials;
  loginPerformed: boolean;
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

export async function signedInSession(
  options: LoginOptions,
  dependencies: SignInDependencies = {},
): Promise<SignedInSession> {
  const load = dependencies.loadCredentials ?? loadCredentials;
  const validate = dependencies.validCredentials ?? validCredentials;
  const login = dependencies.loginWithDeviceFlow ?? loginWithDeviceFlow;
  const loaded = await load();

  if (loaded && credentialsMatchLoginOptions(loaded.credentials, options)) {
    try {
      const credentials = await validate(
        loaded.credentials,
        options.signal ? { signal: options.signal } : {},
      );
      return { credentials, loginPerformed: false };
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
    }
  }

  await login(options);
  const completed = await load();
  if (!completed) throw new Error("Glossa could not load the completed login.");
  return {
    credentials: await validate(
      completed.credentials,
      options.signal ? { signal: options.signal } : {},
    ),
    loginPerformed: true,
  };
}
