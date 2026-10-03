import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  RESTRICTED_DATA_ERROR_CODE,
  RESTRICTED_DATA_ERROR_MESSAGE,
  viewImageResultSchema,
  workerErrorMessage,
  type WorkerResult,
} from "@glossa/protocol";

export function structuredResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
    isError: true,
  };
}

export function restrictedDataResult(): CallToolResult {
  return errorResult(
    RESTRICTED_DATA_ERROR_CODE,
    RESTRICTED_DATA_ERROR_MESSAGE,
  );
}

export function routedError(error: unknown): CallToolResult {
  const code = error instanceof Error ? error.message : "relay_failure";
  if (code === "device_offline") {
    return errorResult(code, "The workspace is offline. Reconnect before inspecting state. A dispatched mutation may have applied; verify files or command effects before retrying. Never blindly rerun a side-effecting command.");
  }
  if (code === "job_timeout") {
    return errorResult(code, "The worker did not respond in time. A dispatched mutation may have applied; inspect files or use the returned command handle before retrying. Without a handle, verify command effects; never blindly rerun a side-effecting command.");
  }
  if (code === "write_access_disabled" || code === "command_access_disabled") {
    return errorResult(code, workerErrorMessage(code));
  }
  if (code === "worker_protocol_unsupported") {
    return errorResult(
      code,
      "This workspace is connected with an older Glossa CLI that does not support image viewing. Update Glossa on that computer and reconnect the workspace.",
    );
  }
  return errorResult("relay_failure", "The relay operation failed.");
}

function workerError(result: WorkerResult) {
  const suppliedCode = result.error?.code ?? "worker_failure";
  const code = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(suppliedCode)
    ? suppliedCode : "worker_failure";
  return errorResult(
    code,
    workerErrorMessage(code),
  );
}

export function workerSuccess<T extends z.ZodObject>(
  result: WorkerResult,
  schema: T,
  workspaceId?: string,
): CallToolResult {
  if (!result.ok) return workerError(result);
  const parsed = schema.safeParse(result.value);
  if (!parsed.success) {
    return errorResult(
      "invalid_worker_result",
      "The worker returned an invalid result.",
    );
  }
  return structuredResult(workspaceId ? { workspaceId, ...parsed.data } : parsed.data);
}

export function imageSuccess(result: WorkerResult): CallToolResult {
  if (!result.ok) return workerError(result);
  const parsed = viewImageResultSchema.safeParse(result.value);
  if (!parsed.success) {
    return errorResult(
      "invalid_worker_result",
      "The worker returned an invalid image result.",
    );
  }
  const { data, ...metadata } = parsed.data;
  return {
    content: [
      {
        type: "image" as const,
        data,
        mimeType: metadata.mimeType,
      },
    ],
    structuredContent: metadata,
  };
}
