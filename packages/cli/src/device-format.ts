import type { RelayDevice } from "./relay-client.js";

export function deviceStatus(device: RelayDevice): string {
  if (device.revokedAt) return "revoked";
  if (device.activeWorkers === null) return "workspace count unavailable";
  if (device.activeWorkers === 0) return "offline";
  return `${device.activeWorkers} active ${device.activeWorkers === 1 ? "workspace" : "workspaces"}`;
}

export function formatRelativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown";
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatDeviceRow(device: RelayDevice, now: number = Date.now()): string {
  const platform = device.platform ?? "unknown platform";
  return `${device.id}  ${device.name}  ${platform}  last seen ${formatRelativeTime(device.lastSeenAt, now)}  ${deviceStatus(device)}`;
}
