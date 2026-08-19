const DNS_ERROR_CODES = new Set(["EAI_AGAIN", "ENOTFOUND"]);
const REFUSED_ERROR_CODES = new Set(["ECONNREFUSED"]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const INTERRUPTED_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

interface ErrorRecord {
  cause?: unknown;
  code?: unknown;
  errors?: unknown;
  message?: unknown;
  name?: unknown;
}

export class NetworkRequestError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined, cause: unknown) {
    super(message, { cause });
    this.name = "NetworkRequestError";
    this.code = code;
  }
}

function errorRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as ErrorRecord
    : undefined;
}

function nestedErrors(value: unknown): unknown[] {
  const record = errorRecord(value);
  if (!record) return [];
  const errors = Array.isArray(record.errors) ? record.errors : [];
  return [record.cause, ...errors].filter((entry) => entry !== undefined);
}

function errorCode(value: unknown): string | undefined {
  const pending = [value];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const record = errorRecord(current);
    if (!record) continue;
    if (typeof record.code === "string" && record.code) return record.code;
    pending.push(...nestedErrors(current));
  }
  return undefined;
}

function errorName(value: unknown): string | undefined {
  const record = errorRecord(value);
  return typeof record?.name === "string" ? record.name : undefined;
}

function usefulDetail(value: unknown): string | undefined {
  const pending = nestedErrors(value);
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const record = errorRecord(current);
    if (!record) continue;
    if (
      typeof record.message === "string" &&
      record.message &&
      record.message !== "fetch failed"
    ) {
      return record.message;
    }
    pending.push(...nestedErrors(current));
  }
  return undefined;
}

function networkMessage(
  error: unknown,
  target: string,
): { message: string; code: string | undefined } {
  const code = errorCode(error);
  const name = errorName(error);
  if (DNS_ERROR_CODES.has(code ?? "")) {
    return {
      message: `Could not resolve ${target}. Check your DNS or network connection.`,
      code,
    };
  }
  if (REFUSED_ERROR_CODES.has(code ?? "")) {
    return {
      message: `Could not connect to ${target}; the connection was refused.`,
      code,
    };
  }
  if (TIMEOUT_ERROR_CODES.has(code ?? "") || name === "TimeoutError") {
    return { message: `Connection to ${target} timed out.`, code };
  }
  if (INTERRUPTED_ERROR_CODES.has(code ?? "")) {
    return { message: `Connection to ${target} was interrupted.`, code };
  }
  if (TLS_ERROR_CODES.has(code ?? "")) {
    return {
      message: `Could not establish a trusted TLS connection to ${target}.`,
      code,
    };
  }
  const detail = usefulDetail(error);
  return {
    message: detail
      ? `Could not reach ${target}: ${detail}`
      : `Could not reach ${target}. Check your network connection.`,
    code,
  };
}

export function normalizeNetworkError(
  error: unknown,
  target = "the Glossa relay",
): Error {
  if (error instanceof NetworkRequestError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  const normalized = networkMessage(error, target);
  return new NetworkRequestError(normalized.message, normalized.code, error);
}

export async function withNetworkErrors<T>(
  action: () => Promise<T>,
  target = "the Glossa relay",
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw normalizeNetworkError(error, target);
  }
}
