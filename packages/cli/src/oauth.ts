export interface OAuthError {
  error: string;
  error_description?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export function issuerEndpoint(issuer: string, pathname: string): string {
  return new URL(pathname, issuer.endsWith("/") ? issuer : `${issuer}/`).toString();
}

export function isTokenResponse(
  data: OAuthTokenResponse | OAuthError,
): data is OAuthTokenResponse {
  return "access_token" in data;
}

export function oauthErrorMessage(data: OAuthError, status: number): string {
  return data.error_description ?? data.error ?? `HTTP ${status}`;
}
