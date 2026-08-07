const knownAuthenticationSecretPatterns = [
  /-----BEGIN (?:ENCRYPTED |RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bsk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{20,})\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,})\b/,
  /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/i,
  /(?:https?|ssh):\/\/[^/\s:@]+:(?!\$\{)[^/\s@]{8,}@/i,
] as const;

const labeledAuthenticationSecretPattern =
  /\b[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password|passwd|private[_-]?key|mfa[_-]?(?:code|token)|otp)[A-Za-z0-9_-]*\b\s*(?:=|:)\s*(?:"([^"]{8,})"|'([^']{8,})'|([^"'\s,;]{8,}))/gi;

const placeholderFragments = [
  "example",
  "placeholder",
  "redacted",
  "dummy",
  "changeme",
  "change-me",
  "not-a-secret",
  "not_secret",
  "your-key",
  "your_key",
  "replace-me",
  "replace_me",
  "test-only",
  "test_only",
  "fixture",
  "sample",
  "access-token",
  "refresh-token",
] as const;

const exactPlaceholderCredentials = new Set([
  "access",
  "token",
  "secret",
  "password",
  "passwd",
]);

export const RESTRICTED_DATA_ERROR_CODE = "restricted_data_blocked";
export const RESTRICTED_DATA_ERROR_MESSAGE =
  "Glossa blocked content that appears to contain access credentials or authentication secrets.";

function placeholderCredential(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 8 || exactPlaceholderCredentials.has(normalized)) {
    return true;
  }
  if (
    (normalized.startsWith("<") && normalized.endsWith(">")) ||
    normalized.includes("${") ||
    normalized.includes("process.env")
  ) {
    return true;
  }
  if (placeholderFragments.some((fragment) => normalized.includes(fragment))) {
    return true;
  }
  if (
    /^(?:[A-Za-z_$][A-Za-z0-9_$]*)(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]]+\])*$/.test(
      value.trim(),
    )
  ) {
    return true;
  }
  return /^[x*._-]+$/i.test(normalized);
}

export function stringContainsRestrictedAuthenticationData(
  value: string,
): boolean {
  if (knownAuthenticationSecretPatterns.some((pattern) => pattern.test(value))) {
    return true;
  }

  labeledAuthenticationSecretPattern.lastIndex = 0;
  for (
    let match = labeledAuthenticationSecretPattern.exec(value);
    match;
    match = labeledAuthenticationSecretPattern.exec(value)
  ) {
    const candidate = match[1] ?? match[2] ?? match[3] ?? "";
    if (!placeholderCredential(candidate)) return true;
  }
  return false;
}

export function containsRestrictedAuthenticationData(value: unknown): boolean {
  const visited = new Set<object>();

  const inspect = (candidate: unknown, depth: number): boolean => {
    if (depth > 12) return false;
    if (typeof candidate === "string") {
      return stringContainsRestrictedAuthenticationData(candidate);
    }
    if (typeof candidate !== "object" || candidate === null) return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.some((entry) => inspect(entry, depth + 1));
    }
    return Object.values(candidate).some((entry) => inspect(entry, depth + 1));
  };

  return inspect(value, 0);
}
