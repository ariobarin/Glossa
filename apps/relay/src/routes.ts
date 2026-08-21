import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_TEXT_BYTES,
  MAX_WORKER_POLL_MS,
  deviceNameSchema,
  workerAccessProfileSchema,
  workerResultSchema,
  workspaceLabelSchema,
} from "@glossa/protocol";
import type { RelayConfig } from "./config.js";
import { requireAuth, type AuthenticatedRequest } from "./auth.js";
import { parseDeviceToken } from "./device-token.js";
import { generatePairingCode, pairingCodeHash } from "./pairing-code.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { handleMcpRequest } from "./mcp.js";
import type { DeviceRecord, RelayStore } from "./store.js";
import {
  CURRENT_WORKER_CAPABILITIES,
  RevokedDeviceRegistrationError,
  type RouterState,
} from "./router-state.js";
import {
  consoleRelayTimingSink,
  relayTimingMiddleware,
  type RelayTimingSink,
} from "./relay-timing.js";

export const MAX_RELAY_JSON_BYTES = 16 * MAX_TEXT_BYTES;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

const enrollSchema = z
  .object({
    name: deviceNameSchema,
    platform: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

const renameSchema = z.object({ name: deviceNameSchema }).strict();
const pairingRedeemSchema = z.object({ code: z.string() }).strict();
const deviceIdSchema = z.string().uuid();
const workerIdSchema = z.string().uuid();
const workerJobTypeSchema = z.enum([
  "read_file",
  "view_image",
  "list_files",
  "search_text",
  "read_file_range",
  "write_file",
  "edit_file",
  "make_directory",
  "delete_path",
  "move_path",
  "run_command",
  "get_command",
  "read_command_output",
  "cancel_command",
]);
const registerSchema = z.object({
  workerId: workerIdSchema,
  accessProfile: workerAccessProfileSchema,
  workspaceLabel: workspaceLabelSchema.optional(),
  workerVersion: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
    .optional(),
  capabilities: z.object({
    commandProgress: z.literal(true),
    concurrentJobs: z.literal(true),
    structuredReads: z.literal(true),
    imageReads: z.literal(true).optional(),
    structuredMutations: z.literal(true),
    commandOutputRanges: z.literal(true),
  }).strict(),
}).strict();
const pollSchema = z.object({
  workerId: workerIdSchema,
  generation: z.string().uuid(),
  acceptedTypes: z.array(workerJobTypeSchema).min(1).max(14).optional(),
  waitMs: z.number().int().positive().max(MAX_WORKER_POLL_MS).optional(),
}).strict();
const workerResultRequestSchema = z.object({
  workerId: workerIdSchema,
  result: workerResultSchema,
}).strict();
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
  timingSink?: RelayTimingSink;
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

interface ManagementRequest extends AuthenticatedRequest {
  deviceAccountId?: string;
}

async function managementAccountId(
  request: ManagementRequest,
  response: Response,
  store: RelayStore,
): Promise<string | null> {
  // A paired device manages its own account directly; the OAuth path resolves
  // the account from the human's subject instead.
  if (request.deviceAccountId) return request.deviceAccountId;
  return await activeAccountId(request, response, store);
}

type WorkerRequestIdentity = {
  accountId: string;
  deviceId: string;
  workerId: string;
  generation: string;
};

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
  const identity = scheme?.toLowerCase() === "worker" && token
    ? state.authenticateWorkerToken(token)
    : null;
  if (!identity) {
    const source = request.ip || request.socket.remoteAddress || "unknown";
    if (!rejectRateLimit(response, limiter, source)) {
      response.status(401).json({ error: "invalid_worker" });
    }
    return null;
  }
  return await refreshWorkerDevicePresence(
    identity,
    response,
    store,
    state,
    deadlineAt,
    runBeforeDeadline,
  )
    ? identity
    : null;
}

function workerIdentityMismatch(
  identity: WorkerRequestIdentity,
  workerId: string,
  generation?: string,
): boolean {
  return identity.workerId !== workerId ||
    (generation !== undefined && identity.generation !== generation);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function requestPairingCodeHash(request: Request): Buffer | null {
  const rawCode = request.params.code;
  const code = Array.isArray(rawCode) ? rawCode[0] : rawCode;
  return code ? pairingCodeHash(code) : null;
}

function retriedDeviceName(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const suffix = `-${attempt + 1}`;
  return `${name.slice(0, 80 - suffix.length)}${suffix}`;
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
  const timingSink = dependencies.timingSink ??
    (config.GLOSSA_TIMING_LOGS ? consoleRelayTimingSink : undefined);
  if (timingSink) router.use(relayTimingMiddleware(timingSink));

  // Device management accepts either the human's OAuth token or a paired
  // device credential; enrollment stays OAuth-only so only a
  // human-authenticated session can bind a new device to an account.
  const managementOAuth = authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE);
  const managementAuth: RequestHandler = async (
    request: ManagementRequest,
    response: Response,
    next: NextFunction,
  ) => {
    const header = request.header("authorization");
    const scheme = header?.split(/\s+/, 2)[0]?.toLowerCase();
    if (scheme !== "device") {
      await managementOAuth(request, response, next);
      return;
    }
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
    request.deviceAccountId = device.accountId;
    next();
  };

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

  router.get("/.well-known/openai-apps-challenge", (_request, response) => {
    const challenge = config.GLOSSA_OPENAI_APPS_CHALLENGE;
    if (!challenge) {
      response.status(404).end();
      return;
    }
    response.set("cache-control", "no-store");
    response.type("text/plain").send(challenge);
  });

  router.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json({
      resource: config.GLOSSA_AUTH0_AUDIENCE,
      authorization_servers: [config.GLOSSA_AUTH0_ISSUER],
      scopes_supported: [config.GLOSSA_MCP_REQUIRED_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://glossa.sh/security",
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
    managementAuth,
    async (request: ManagementRequest, response: Response) => {
      const accountId = await managementAccountId(request, response, store);
      if (!accountId) return;
      const devices = await store.listDevices(accountId);
      response.json({ devices: devices.map((device) => publicDevice(device, state)) });
    },
  );

  router.patch(
    "/v1/devices/:deviceId",
    managementAuth,
    async (request: ManagementRequest, response: Response) => {
      const deviceId = parseDeviceId(request);
      const parsed = renameSchema.safeParse(request.body);
      if (!deviceId || !parsed.success) {
        rejectInvalidInput(response);
        return;
      }
      const accountId = await managementAccountId(request, response, store);
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
    managementAuth,
    async (request: ManagementRequest, response: Response) => {
      const deviceId = parseDeviceId(request);
      if (!deviceId) {
        rejectInvalidInput(response);
        return;
      }
      const accountId = await managementAccountId(request, response, store);
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

  router.post("/v1/pairings", async (request, response) => {
    const source = request.ip || request.socket.remoteAddress || "unknown";
    if (rejectRateLimit(response, enrollmentRateLimiter, source)) return;
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    const generated = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    await store.createPairing(
      randomUUID(),
      generated.hash,
      parsed.data.name,
      parsed.data.platform ?? null,
      expiresAt,
    );
    response
      .status(201)
      .json({ code: generated.code, expiresAt: expiresAt.toISOString() });
  });

  router.get(
    "/v1/pairings/:code",
    authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      const codeHash = requestPairingCodeHash(request);
      const pairing = codeHash ? await store.findPairing(codeHash) : null;
      if (!pairing) {
        response.status(404).json({ error: "pairing_not_found" });
        return;
      }
      response.json({
        deviceName: pairing.deviceName,
        platform: pairing.platform,
        expiresAt: pairing.expiresAt.toISOString(),
        claimed: pairing.accountId !== null,
      });
    },
  );

  router.post(
    "/v1/pairings/:code/claim",
    authFactory(config, config.GLOSSA_DEVICE_ENROLL_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      const codeHash = requestPairingCodeHash(request);
      const pairing = codeHash ? await store.findPairing(codeHash) : null;
      if (!pairing) {
        response.status(404).json({ error: "pairing_not_found" });
        return;
      }
      if (pairing.accountId) {
        response.status(409).json({ error: "pairing_already_claimed" });
        return;
      }
      const claimed = await store.claimPairing(codeHash!, accountId);
      if (!claimed) {
        response.status(409).json({ error: "pairing_already_claimed" });
        return;
      }
      response.json({
        deviceName: claimed.deviceName,
        platform: claimed.platform,
      });
    },
  );

  router.post("/v1/pairings/redeem", async (request, response) => {
    const source = request.ip || request.socket.remoteAddress || "unknown";
    if (rejectRateLimit(response, deviceRateLimiter, source)) return;
    const parsed = pairingRedeemSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectInvalidInput(response);
      return;
    }
    const codeHash = pairingCodeHash(parsed.data.code);
    const pairing = codeHash ? await store.findPairing(codeHash) : null;
    if (!pairing) {
      response.status(404).json({ error: "pairing_not_found" });
      return;
    }
    if (!pairing.accountId) {
      response.status(202).json({ status: "pending" });
      return;
    }
    const redeemed = await store.redeemPairing(codeHash!);
    if (!redeemed?.accountId) {
      response.status(404).json({ error: "pairing_not_found" });
      return;
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const enrolled = await store.enrollDevice(
          redeemed.accountId,
          retriedDeviceName(redeemed.deviceName, attempt),
          redeemed.platform,
        );
        response.json({
          device: publicDevice(enrolled.device, state),
          device_token: enrolled.token,
        });
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    response.status(409).json({ error: "device_name_conflict" });
  });

  router.delete("/device", async (request, response) => {
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
    const revoked = await store.revokeDevice(device.accountId, device.id);
    if (!revoked) {
      response.status(404).json({ error: "device_not_found" });
      return;
    }
    state.unregisterDevice(device.id);
    response.status(204).end();
  });

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
    const workerId = parsed.data.workerId;
    let session: ReturnType<RouterState["register"]>;
    try {
      session = state.register(
        device.accountId,
        device.id,
        device.name,
        workerId,
        {
          accessProfile: parsed.data.accessProfile,
          ...(parsed.data.workerVersion
            ? { workerVersion: parsed.data.workerVersion }
            : {}),
          ...(parsed.data.workspaceLabel
            ? { workspaceLabel: parsed.data.workspaceLabel }
            : {}),
          capabilities: {
            commandProgress: true,
            concurrentJobs: true,
            structuredReads: true,
            imageReads: parsed.data.capabilities.imageReads === true,
            structuredMutations: true,
            commandOutputRanges: true,
          },
        },
      );
    } catch (error) {
      if (!(error instanceof RevokedDeviceRegistrationError)) throw error;
      response.status(401).json({ error: "invalid_device" });
      return;
    }
    response.json({
      deviceId: device.id,
      workerId,
      generation: session.generation,
      workerToken: session.workerToken,
      accessProfile: parsed.data.accessProfile,
      capabilities: CURRENT_WORKER_CAPABILITIES,
      ...(parsed.data.workspaceLabel
        ? { workspaceLabel: parsed.data.workspaceLabel }
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
    const { accountId, deviceId } = identity;
    const workerId = parsed.data.workerId;
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
          parsed.data.waitMs !== undefined
            ? parsed.data.waitMs
            : config.GLOSSA_WORKER_POLL_MS,
          remainingRequestMs,
        ),
        parsed.data.acceptedTypes
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
    if (workerIdentityMismatch(identity, parsed.data.workerId)) {
      response.status(409).json({ error: "unknown_worker_generation" });
      return;
    }
    const accepted = state.complete(
      identity.accountId,
      identity.workerId,
      parsed.data.result,
    );
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
      identity.accountId,
      identity.deviceId,
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
      identity.accountId,
      identity.deviceId,
      parsed.data.workerId,
      identity.generation,
    );
    response.status(204).end();
  });

  router.all(
    ["/", "/mcp"],
    authFactory(config, config.GLOSSA_MCP_REQUIRED_SCOPE),
    async (request: AuthenticatedRequest, response: Response) => {
      const accountId = await activeAccountId(request, response, store);
      if (!accountId) return;
      await handleMcpRequest(
        request,
        response,
        config,
        state,
        accountId,
      );
    },
  );

  return router;
}
