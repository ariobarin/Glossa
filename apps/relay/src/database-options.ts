import type { PoolConfig } from "pg";

const SSL_QUERY_PARAMETERS = new Set([
  "ssl",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslnegotiation",
  "sslrootcert",
  "uselibpqcompat",
]);

export function databaseOptions(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): Pick<PoolConfig, "connectionString" | "ssl"> {
  if (environment.NODE_ENV !== "production") {
    return { connectionString: databaseUrl, ssl: undefined };
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid Postgres URL.");
  }
  for (const key of url.searchParams.keys()) {
    if (SSL_QUERY_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(
        "DATABASE_URL must not contain SSL parameters in production. Use GLOSSA_DATABASE_CA_PEM for a private database CA.",
      );
    }
  }

  const sslMode =
    environment.GLOSSA_DATABASE_SSL_MODE ??
    (environment.DYNO ? "require" : "verify-full");
  if (sslMode !== "verify-full" && sslMode !== "require") {
    throw new Error(
      "GLOSSA_DATABASE_SSL_MODE must be verify-full or require.",
    );
  }

  const ca = environment.GLOSSA_DATABASE_CA_PEM?.trim();
  if (sslMode === "require" && ca) {
    throw new Error(
      "GLOSSA_DATABASE_CA_PEM cannot be used when GLOSSA_DATABASE_SSL_MODE is require.",
    );
  }

  return {
    connectionString: databaseUrl,
    ssl:
      sslMode === "require"
        ? { rejectUnauthorized: false }
        : {
            rejectUnauthorized: true,
            ...(ca ? { ca } : {}),
          },
  };
}

export function relayPoolOptions(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    ...databaseOptions(databaseUrl, environment),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  };
}
