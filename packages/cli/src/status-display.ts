import type { StatusDetails } from "./status-service.js";
import { formatDeviceRow } from "./device-format.js";

export function formatStatus(status: StatusDetails): string[] {
  const lines = [
    `Signed in as ${status.account}.`,
    `Relay connected: ${status.relay}`,
  ];
  if (status.activeWorkers === null) {
    lines.push("Active workspaces: unavailable");
  } else if (status.activeWorkers === 0) {
    lines.push("No active workspaces. Run glossa from the project folder you want to expose.");
  } else {
    lines.push(`Active workspaces: ${status.activeWorkers}`);
  }
  if (status.devices.length === 0) lines.push("No devices enrolled.");
  else lines.push(...status.devices.map(formatDeviceRow));
  return lines;
}
