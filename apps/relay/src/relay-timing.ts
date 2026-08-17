import { performance } from "node:perf_hooks";
import type { Request, RequestHandler } from "express";

const MCP_TOOL_NAMES = new Set([
  "cancel_command",
  "delete_path",
  "edit_file",
  "get_command",
  "get_logout_instructions",
  "list_files",
  "list_workspaces",
  "make_directory",
  "move_path",
  "read_command_output",
  "read_file",
  "read_file_range",
  "run_command",
  "search_text",
  "write_file",
]);

const FIXED_PATHS = new Set([
  "/healthz",
  "/.well-known/openai-apps-challenge",
  "/.well-known/oauth-protected-resource",
  "/device/register",
  "/device/poll",
  "/device/result",
  "/device/heartbeat",
  "/device/unregister",
  "/v1/devices",
]);

export interface RelayTimingEvent {
  event: "relay_request_timing";
  operation: string;
  status: number;
  durationMs: number;
}

export type RelayTimingSink = (event: RelayTimingEvent) => void;

function mcpOperation(body: unknown): string {
  if (typeof body !== "object" || body === null) return "mcp:request";
  const record = body as Record<string, unknown>;
  if (record.method !== "tools/call") {
    return typeof record.method === "string" &&
        ["initialize", "notifications/initialized", "tools/list"].includes(record.method)
      ? `mcp:${record.method}`
      : "mcp:request";
  }
  const params = record.params;
  if (typeof params !== "object" || params === null) return "mcp:tools/call";
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && MCP_TOOL_NAMES.has(name)
    ? `mcp:${name}`
    : "mcp:tools/call";
}

export function relayOperation(request: Pick<Request, "path" | "body">): string {
  if (request.path === "/" || request.path === "/mcp") {
    return mcpOperation(request.body);
  }
  if (FIXED_PATHS.has(request.path)) return `http:${request.path}`;
  if (request.path.startsWith("/v1/devices/")) return "http:/v1/devices/:deviceId";
  return "http:other";
}

export function relayTimingMiddleware(sink: RelayTimingSink): RequestHandler {
  return (request, response, next) => {
    const startedAt = performance.now();
    const operation = relayOperation(request);
    response.once("finish", () => {
      try {
        sink({
          event: "relay_request_timing",
          operation,
          status: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        });
      } catch {
        // Profiling must never affect request delivery.
      }
    });
    next();
  };
}

export const consoleRelayTimingSink: RelayTimingSink = (event) => {
  console.info(JSON.stringify(event));
};
