export type RelaySecuritySurface =
  | "mcp_oauth"
  | "device_enrollment_oauth";

export type RelaySecurityCategory =
  | "authentication_required"
  | "invalid_token"
  | "identity_not_allowed"
  | "insufficient_scope";

export interface RelaySecurityEvent {
  event: "relay_security_event";
  surface: RelaySecuritySurface;
  category: RelaySecurityCategory;
}

export type RelaySecuritySink = (event: RelaySecurityEvent) => void;

export const consoleRelaySecuritySink: RelaySecuritySink = (event) => {
  console.warn(JSON.stringify(event));
};

export function emitRelaySecurityEvent(
  sink: RelaySecuritySink | undefined,
  surface: RelaySecuritySurface,
  category: RelaySecurityCategory,
): void {
  if (!sink) return;
  try {
    sink({ event: "relay_security_event", surface, category });
  } catch {
    // Monitoring must never affect authentication or request delivery.
  }
}
