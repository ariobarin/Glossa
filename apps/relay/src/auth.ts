import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { RelayConfig } from "./config.js";

const jwksByIssuer = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function jwksForIssuer(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(
    new URL(".well-known/jwks.json", issuer),
    { timeoutDuration: 5_000 },
  );
  jwksByIssuer.set(issuer, created);
  return created;
}

export interface AuthenticatedRequest extends Request {
  auth?: {
    subject: string;
    scopes: Set<string>;
    claims: JWTPayload;
  };
}

export function subjectIsAllowedIdentity(
  config: RelayConfig,
  subject: string,
): boolean {
  return (
    config.GLOSSA_AUTH0_ALLOWED_SUBJECTS.includes(subject) ||
    config.GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES.some((prefix) =>
      subject.startsWith(prefix),
    )
  );
}

function bearerToken(request: Request): string | null {
  const header = request.header("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function scopes(payload: JWTPayload): Set<string> {
  const claim = typeof payload.scope === "string" ? payload.scope : "";
  return new Set(claim.split(/\s+/).filter(Boolean));
}

function authenticationChallenge(
  config: RelayConfig,
  error?: "invalid_token" | "insufficient_scope",
  requiredScope?: string,
): string {
  const origin = config.GLOSSA_PUBLIC_ORIGIN.replace(/\/$/, "");
  const parameters = [
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    ...(error ? [`error="${error}"`] : []),
    ...(requiredScope ? [`scope="${requiredScope}"`] : []),
  ];
  return `Bearer ${parameters.join(", ")}`;
}

export function requireAuth(config: RelayConfig, requiredScope?: string) {
  const issuer = config.GLOSSA_AUTH0_ISSUER.endsWith("/")
    ? config.GLOSSA_AUTH0_ISSUER
    : `${config.GLOSSA_AUTH0_ISSUER}/`;
  const jwks = jwksForIssuer(issuer);

  return async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const token = bearerToken(request);
    if (!token) {
      response.setHeader(
        "WWW-Authenticate",
        authenticationChallenge(config),
      );
      response.status(401).json({ error: "authentication_required" });
      return;
    }

    try {
      const verified = await jwtVerify(token, jwks, {
        issuer,
        audience: config.GLOSSA_AUTH0_AUDIENCE,
      });
      if (!verified.payload.sub) throw new Error("Missing subject.");
      if (!subjectIsAllowedIdentity(config, verified.payload.sub)) {
        response.status(403).json({ error: "identity_provider_not_allowed" });
        return;
      }
      const grantedScopes = scopes(verified.payload);
      if (requiredScope && !grantedScopes.has(requiredScope)) {
        response.setHeader(
          "WWW-Authenticate",
          authenticationChallenge(config, "insufficient_scope", requiredScope),
        );
        response.status(403).json({ error: "insufficient_scope" });
        return;
      }
      request.auth = {
        subject: verified.payload.sub,
        scopes: grantedScopes,
        claims: verified.payload,
      };
      next();
    } catch {
      response.setHeader(
        "WWW-Authenticate",
        authenticationChallenge(config, "invalid_token"),
      );
      response.status(401).json({ error: "invalid_token" });
    }
  };
}
