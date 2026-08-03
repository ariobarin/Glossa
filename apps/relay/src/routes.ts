import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import {
  MAX_TEXT_BYTES,
  MAX_WORKER_POLL_MS,
  deviceNameSchema,
  workerResultSchema,
  workspaceIdSchema,
  workspaceLabelSchema,
  workspaceRootPathSchema,
} from "@glossa/protocol";
import type { RelayConfig } from "./config.js";
import { requireAuth, type AuthenticatedRequest } from "./auth.js";
import { parseDeviceToken } from "./device-token.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { handleMcpRequest } from "./mcp.js";
import type { DeviceRecord, RelayStore } from "./store.js";
import type { RouterState } from "./router-state.js";

export const MAX_RELAY_JSON_BYTES = 16 * MAX_TEXT_BYTES;

const enrollSchema = z
  .object({
    name: deviceNameSchema,
    platform: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

const renameSchema = z.object({ name: deviceNameSchema }).strict();
const deviceIdSchema = z.string().uuid();
const workerIdSchema = z.string().uuid();
const workerJobTypeSchema = z.enum([
  "read_file",
  "list_files",
  "search_text",
  "read_file_range",
  "write_file",
  "edit_file",
  "run_command",
  "get_command",
  "cancel_command",
]);
const registerSchema = z.union([
  z.object({
    workerId: workerIdSchema,
    workspaceLabel: workspaceLabelSchema.optional(),
    workspaceId: workspaceIdSchema.optional(),
    rootPath: workspaceRootPathSchema.optional(),
    capabilities: z
      .object({
        commandProgress: z.literal(true).optional(),
        concurrentJobs: z.literal(true).optional(),
        structuredReads: z.literal(true).optional(),
      })
      .strict()
      .optional(),
  }).strict(),
  z.object({}).strict(),
]);
const pollSchema = z.union([
  z.object({
    workerId: workerIdSchema,
    generation: z.string().uuid(),
    acceptedTypes: z.array(workerJobTypeSchema).min(1).max(9).optional(),
    waitMs: z.number().int().positive().max(MAX_WORKER_POLL_MS).optional(),
  }).strict(),
  z.object({ generation: z.string().uuid() }).strict(),
]);
const workerResultRequestSchema = z.union([
  z.object({
    workerId: workerIdSchema,
    result: workerResultSchema,
  }).strict(),
  workerResultSchema,
]);
const unregisterSchema = z.object({ workerId: workerIdSchema }).strict();
const heartbeatSchema = z.object({
  workerId: workerIdSchema,
  generation: z.string().uuid(),
}).strict();

class RequestDeadlineError extends Error {}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new RequestDeadlineError();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequestDeadlineError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type AuthFactory = (
  config: RelayConfig,
  requiredScope?: string,
) => RequestHandler;

type DeadlineRunner = <T>(operation: Promise<T>, deadlineAt: number) => Promise<T>;

export interface RouteDependencies {
  authFactory?: AuthFactory;
  enrollmentRateLimiter?: FixedWindowRateLimiter;
  deviceRateLimiter?: FixedWindowRateLimiter;
  beforeDeadline?: DeadlineRunner;
}

function publicDevice(device: DeviceRecord, state: RouterState) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    activeWorkers: state.activeWorkerCount(device.accountId, device.id),
  };
}

function parseDeviceId(request: Request): string | null {
  const rawDeviceId = request.params.deviceId;
  const deviceId = Array.isArray(rawDeviceId) ? rawDeviceId[0] : rawDeviceId;
  const parsed = deviceIdSchema.safeParse(deviceId);
  return parsed.success ? parsed.data : null;
}

function rejectInvalidInput(response: Response): void {
  response.status(400).json({ error: "invalid_request" });
}

function rejectRateLimit(
  response: Response,
  limiter: FixedWindowRateLimiter,
  key: string,
): boolean {
  const result = limiter.consume(key);
  if (result.allowed) return false;
  response.setHeader("Retry-After", String(result.retryAfterSeconds));
  response.status(429).json({ error: "rate_limited" });
  return true;
}

async function activeAccountId(
  request: AuthenticatedRequest,
  response: Response,
  store: RelayStore,
): Promise<string | null> {
  const accountId = await store.accountIdForSubject(request.auth!.subject);
  if (accountId) return accountId;
  response.status(403).json({ error: "account_disabled" });
  return null;
}

type WorkerRequestIdentity =
  | { mode: "worker"; accountId: string; deviceId: string; workerId: string; generation: string }
  | { mode: "device"; device: DeviceRecord };

async function authenticatedDevice(
  request: Request,
  response: Response,
  store: RelayStore,
  limiter: FixedWindowRateLimiter,
  deadlineAt: number,
  runBeforeDeadline: DeadlineRunner,
): Promise<DeviceRecord | null> {
  const source = request.ip || request.socket.remoteAddress || "unknown";

  const header = request.header("authorization");
  const [scheme, token] = header?.split(/\s+/, 2) ?? [];
  if (scheme?.toLowerCase() !== "device" || !token) {
    if (!rejectRateLimit(response, limiter, source)) {
      response.status(401).json({ error: "invalid_device" });
    }
    return null;
  }
  const parsed = parseDeviceToken(token);
  if (!parsed) {
    if (!rejectRateLimit(response, limiter, source)) {
      response.status(401).json({ error: "invalid_device" });
    }
    return null;
  }
  const failureKey = source;
  const rateLimit = limiter.check(failureKey);
  if (!rateLimit.allowed) {
    response.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    response.status(429).json({ error: "rate_limited" });
    return null;
  }
  let device: DeviceRecord | null;
  try {
    device = await runBeforeDeadline(
      store.authenticateDevice(parsed.deviceId, parsed.secret),
      deadlineAt,
    );
  } catch (error) {
    if (!(error instanceof RequestDeadlineError)) throw error;
    response.status(503).json({ error: "request_timeout" });
    return null;
  }
  if (!device && !rejectRateLimit(response, limiter, failureKey)) {
    response.status(401).json({ error: "invalid_device" });
  }
  return device;
}

async function refreshWorkerDevicePresence(
  identity: { accountId: string; deviceId: string },
  response: Response,
  store: RelayStore,
  state: RouterState,
  deadlineAt: number,
  runBeforeDeadline: DeadlineRunner,
): Promise<boolean> {
  const claimedAt = state.claimDeviceSeenPersistence(
    identity.accountId,
    identity.deviceId,
  );
  if (claimedAt === null) return true;
  try {
    if (
      await runBeforeDeadline(
        store.touchDevice(identity.accountId, identity.deviceId),
        deadlineAt,
      )
    ) {
      return true;
    }
  } catch {
    // Presence metadata is best effort while an authenticated worker is active.
    return true;
  }
  state.unregisterDevice(identity.deviceId);
  response.status(401).json({ error: "invalid_worker" });
  return false;
}

async function authenticatedWorkerRequest(
  request: Request,
  response: Response,
  store: RelayStore,
  state: RouterState,
  limiter: FixedWindowRateLimiter,
  deadlineAt: number,
  runBeforeDeadline: DeadlineRunner,
): Promise<WorkerRequestIdentity | null> {
  const header = request.header("authorization");
  const [scheme, token] = header?.split(/\s+/, 2) ?? [];
  if (scheme?.toLowerCase() === "worker" && token) {
    const identity = state.authenticateWorkerToken(token);
    if (
      identity &&
      await refreshWorkerDevicePresence(
        identity,
        response,
        store,
        state,
        deadlineAt,
        runBeforeDeadline,
      )
    ) {
      return { mode: "worker", ...identity };
    }
    if (identity) return null;
    const source = request.ip || request.socket.remoteAddress || "unknown";
    if (!rejectRateLimit(response, limiter, source)) {
      response.status(401).json({ error: "invalid_worker" });
    }
    return null;
  }

  const device = await authenticatedDevice(
    request,
    response,
    store,
    limiter,
    deadlineAt,
    runBeforeDeadline,
  );
  return device ? { mode: "device", device } : null;
}

function workerIdentityMismatch(
  identity: WorkerRequestIdentity,
  workerId: string,
  generation?: string,
): boolean {
  return identity.mode === "worker" &&
    (identity.workerId !== workerId ||
      (generation !== undefined && identity.generation !== generation));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export function buildRoutes(
  config: RelayConfig,
  store: RelayStore,
  state: RouterState,
  dependencies: RouteDependencies = {},
): Router {
  const router = Router();
  const authFactory = dependencies.authFactory ?? requireAuth;
  const runBeforeDeadline = dependencies.beforeDeadline ?? beforeDeadline;
  const enrollmentRateLimiter =
    dependencies.enrollmentRateLimiter ??
    new FixedWindowRateLimiter(
      config.GLOSSA_ENROLL_RATE_LIMIT,
      config.GLOSSA_RATE_LIMIT_WINDOW_MS,
    );
  const deviceRateLimiter =
    dependencies.deviceRateLimiter ??
    new FixedWindowRateLimiter(
      config.GLOSSA_DEVICE_AUTH_RATE_LIMIT,
      config.GLOSSA_RATE_LIMIT_WINDOW_MS,
    );

  router.use((request, response, next) => {
    if (config.NODE_ENV === "production" && !request.secure) {
      response.status(400).json({ error: "https_required" });
      return;
    }
    next();
  });

  router.get("/healthz", (_request, response) => {
    response.json({ ok: true, service: "glossa-relay" });
  });

  router.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json({
      resource: config.GLOSSA_AUTH0_AUDIENCE,
      authorization_servers: [config.GLOSSA_AUTH0_ISSUER],
      scopes_supported: [config.GLOSSA_MCP_REQUIRED_SCOPE],
      bearer_methods_supported: ["header"],
    });
  });

  router.post(
    "/v1/devices/enroll",
    authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      if (
        rejectRateLimit(
          response,
          enrollmentRateLimiter,
          request.auth!.subject,
        )
      ) {
        return;
      }
      const parsed = enrollSchema.safeParse(request.body);
      if (!parsed.success) {
        rejectInvalidInput(response);
        return;
      }
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      try {
        const enrolled = await store.enrollDevice(
          accountId,
          parsed.data.name,
          parsed.data.platform ?? null,
        );
        response.status(201).json({
          device: publicDevice(enrolled.device, state),
          device_token: enrolled.token,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        response.status(409).json({ error: "device_name_conflict" });
      }
    },
  );

  router.get(
    "/v1/devices",
    authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      const devices = await store.listDevices(accountId);
      response.json({ devices: devices.map((device) => publicDevice(device, state)) });
    },
  );

  router.patch(
    "/v1/devices/:deviceId",
    authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const deviceId = parseDeviceId(request);
      const parsed = renameSchema.safeParse(request.body);
      if (!deviceId || !parsed.success) {
        rejectInvalidInput(response);
        return;
      }
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      try {
        const device = await store.renameDevice(
          accountId,
          deviceId,
          parsed.data.name,
        );
        if (!device) {
          response.status(404).json({ error: "device_not_found" });
          return;
        }
        response.json({ device: publicDevice(device, state) });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        response.status(409).json({ error: "device_name_conflict" });
      }
    },
  );

  router.delete(
    "/v1/devices/:deviceId",
    authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const deviceId = parseDeviceId(request);
      if (!deviceId) {
        rejectInvalidInput(response);
        return;
      }
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      const revoked = await store.revokeDevice(accountId, deviceId);
      if (!revoked) {
        response.status(404).json({ error: "device_not_found" });
        return;
      }
      state.unregisterDevice(deviceId);
      response.status(204).end();
    },
  );

  router.post("/device/register", async (request, response) => {
    const deadlineAt = Date.now() + config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS;
    const device = await authenticatedDevice(
      request,
      response,
      store,
      deviceRateLimiter,
      deadlineAt,
      runBeforeDeadline,
    );
    if (!device) return;
    const parsed = registerSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    if (
      ("workspaceId" in parsed.data || "rootPath" in parsed.data) &&
      (Boolean(parsed.data.workspaceId) !== Boolean(parsed.data.rootPath))
    ) {
      rejectInvalidInput(response);
      return;
    }
    const workerId = "workerId" in parsed.data ? parsed.data.workerId : device.id;
    let session: { generation: string; workerToken: string };
    try {
      session = state.register(
        device.accountId,
        device.id,
        device.name,
        workerId,
        {
          commandProgress:
            "capabilities" in parsed.data &&
            parsed.data.capabilities?.commandProgress === true,
          concurrentJobs:
            "capabilities" in parsed.data &&
            parsed.data.capabilities?.concurrentJobs === true,
          structuredReads:
            "capabilities" in parsed.data &&
            parsed.data.capabilities?.structuredReads === true,
          ...("workspaceLabel" in parsed.data && parsed.data.workspaceLabel
            ? { workspaceLabel: parsed.data.workspaceLabel }
            : {}),
          ...("workspaceId" in parsed.data &&
          parsed.data.workspaceId &&
          "rootPath" in parsed.data &&
          parsed.data.rootPath
            ? {
                workspaceId: parsed.data.workspaceId,
                rootPath: parsed.data.rootPath,
              }
            : {}),
        },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      if (code === "workspace_identity_conflict") {
        response.status(409).json({ error: code });
        return;
      }
      rejectInvalidInput(response);
      return;
    }
    response.json({
      deviceId: device.id,
      workerId,
      generation: session.generation,
      workerToken: session.workerToken,
      capabilities: {
        commandProgress: state.supportsCommandProgress(device.accountId, workerId),
        concurrentJobs: state.supportsConcurrentJobs(device.accountId, workerId),
        structuredReads: state.supportsStructuredReads(device.accountId, workerId),
      },
      ...("workspaceLabel" in parsed.data && parsed.data.workspaceLabel
        ? { workspaceLabel: parsed.data.workspaceLabel }
        : {}),
      ...("workspaceId" in parsed.data && parsed.data.workspaceId
        ? { workspaceId: parsed.data.workspaceId }
        : {}),
    });
  });

  router.post("/device/poll", async (request, response) => {
    const deadlineAt = Date.now() + config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS;
    const identity = await authenticatedWorkerRequest(
      request,
      response,
      store,
      state,
      deviceRateLimiter,
      deadlineAt,
      runBeforeDeadline,
    );
    if (!identity) return;
    const parsed = pollSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    const accountId = identity.mode === "worker"
      ? identity.accountId
      : identity.device.accountId;
    const deviceId = identity.mode === "worker"
      ? identity.deviceId
      : identity.device.id;
    const workerId = "workerId" in parsed.data
      ? parsed.data.workerId
      : deviceId;
    if (workerIdentityMismatch(identity, workerId, parsed.data.generation)) {
      response.status(409).json({ error: "unknown_worker_generation" });
      return;
    }
    try {
      const remainingRequestMs = Math.max(
        0,
        deadlineAt - Date.now(),
      );
      if (remainingRequestMs === 0) {
        response.status(204).end();
        return;
      }
      const job = await state.poll(
        accountId,
        deviceId,
        workerId,
        parsed.data.generation,
        Math.min(
          config.GLOSSA_WORKER_POLL_MS,
          "waitMs" in parsed.data && parsed.data.waitMs !== undefined
            ? parsed.data.waitMs
            : config.GLOSSA_WORKER_POLL_MS,
          remainingRequestMs,
        ),
        "acceptedTypes" in parsed.data && parsed.data.acceptedTypes
          ? new Set(parsed.data.acceptedTypes)
          : undefined,
      );
      if (!job) {
        response.status(204).end();
        return;
      }
      response.json({ job });
    } catch {
      response.status(409).json({ error: "unknown_worker_generation" });
    }
  });

  router.post("/device/result", async (request, response) => {
    const deadlineAt = Date.now() + config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS;
    const identity = await authenticatedWorkerRequest(
      request,
      response,
      store,
      state,
      deviceRateLimiter,
      deadlineAt,
      runBeforeDeadline,
    );
    if (!identity) return;
    const parsed = workerResultRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    const accountId = identity.mode === "worker"
      ? identity.accountId
      : identity.device.accountId;
    const deviceId = identity.mode === "worker"
      ? identity.deviceId
      : identity.device.id;
    const requestedWorkerId = "workerId" in parsed.data
      ? parsed.data.workerId
      : deviceId;
    if (workerIdentityMismatch(identity, requestedWorkerId)) {
      response.status(409).json({ error: "unknown_worker_generation" });
      return;
    }
    const workerId = identity.mode === "worker"
      ? identity.workerId
      : requestedWorkerId;
    const result = "result" in parsed.data ? parsed.data.result : parsed.data;
    const accepted = state.complete(accountId, workerId, result);
    response.status(202).json({ accepted });
  });

  router.post("/device/heartbeat", async (request, response) => {
    const deadlineAt = Date.now() + config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS;
    const identity = await authenticatedWorkerRequest(
      request,
      response,
      store,
      state,
      deviceRateLimiter,
      deadlineAt,
      runBeforeDeadline,
    );
    if (!identity) return;
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    if (
      workerIdentityMismatch(
        identity,
        parsed.data.workerId,
        parsed.data.generation,
      )
    ) {
      response.status(409).json({ error: "unknown_worker_generation" });
      return;
    }
    const accepted = state.heartbeat(
      identity.mode === "worker" ? identity.accountId : identity.device.accountId,
      identity.mode === "worker" ? identity.deviceId : identity.device.id,
      parsed.data.workerId,
      parsed.data.generation,
    );
    if (!accepted) {
      response.status(409).json({ error: "unknown_worker_generation" });
      return;
    }
    response.status(204).end();
  });

  router.post("/device/unregister", async (request, response) => {
    const deadlineAt = Date.now() + config.GLOSSA_RELAY_REQUEST_TIMEOUT_MS;
    const identity = await authenticatedWorkerRequest(
      request,
      response,
      store,
      state,
      deviceRateLimiter,
      deadlineAt,
      runBeforeDeadline,
    );
    if (!identity) return;
    const parsed = unregisterSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    if (workerIdentityMismatch(identity, parsed.data.workerId)) {
      response.status(409).json({ error: "unknown_worker_generation" });
      return;
    }
    state.unregisterWorker(
      identity.mode === "worker" ? identity.accountId : identity.device.accountId,
      identity.mode === "worker" ? identity.deviceId : identity.device.id,
      parsed.data.workerId,
      identity.mode === "worker" ? identity.generation : undefined,
    );
    response.status(204).end();
  });

  router.all(
    ["/", "/mcp"],
    authFactory(config, config.GLOSSA_MCP_REQUIRED_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      await handleMcpRequest(request, response, config, state, accountId);
    },
  );

  return router;
}
