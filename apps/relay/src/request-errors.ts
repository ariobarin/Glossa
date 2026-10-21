import type { ErrorRequestHandler, Request } from "express";
import { log as defaultLog, safeErrorFields, type Logger } from "./log.js";

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === "number" ? status : statusCode;
  return typeof value === "number" && value >= 400 && value < 500 ? value : undefined;
}

/** The matched route pattern, never the raw URL, so IDs and codes stay out. */
export function routePattern(request: Request): string {
  const path = (request.route as { path?: unknown } | undefined)?.path;
  if (typeof path === "string") return `${request.baseUrl}${path}`;
  if (Array.isArray(path)) return path.map((part) => `${request.baseUrl}${String(part)}`).join("|");
  return "unmatched";
}

/**
 * Last-resort Express error handler. Body-parser rejections (malformed or
 * oversized JSON) are client errors; everything else is a relay bug.
 */
export function requestErrorHandler(log: Logger = defaultLog): ErrorRequestHandler {
  return (error, request, response, _next) => {
    const clientStatus = clientErrorStatus(error);
    const status = clientStatus ?? 500;
    log(clientStatus ? "warn" : "error", "request_error", {
      method: request.method,
      route: routePattern(request),
      status,
      ...safeErrorFields(error),
    });
    if (response.headersSent) {
      // Express's default handler would print the full message, so end the
      // partial response here instead of delegating.
      response.destroy();
      return;
    }
    response
      .status(status)
      .json({ error: clientStatus ? "invalid_request" : "internal_error" });
  };
}
