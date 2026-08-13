import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const DEVICE_PAIRING_TTL_MS = 5 * 60_000;
export const MAX_PENDING_DEVICE_PAIRINGS = 4_096;

export class DevicePairingCapacityError extends Error {
  constructor() {
    super("The relay has too many pending device pairings.");
    this.name = "DevicePairingCapacityError";
  }
}

interface PendingPairing {
  pairingId: string;
  userCode: string;
  secretHash: Buffer;
  name: string;
  platform: string | null;
  expiresAtMs: number;
  approvedAccountId?: string;
  completion?: unknown;
  completionPromise?: Promise<unknown>;
  expiryTimer?: NodeJS.Timeout;
}

export interface DevicePairingRequest {
  pairingId: string;
  userCode: string;
  pairingSecret: string;
  expiresAt: string;
}

export interface DevicePairingApproval {
  pairingId: string;
  userCode: string;
  name: string;
  platform: string | null;
  expiresAt: string;
}

export interface ApprovedPairingIdentity {
  accountId: string;
  name: string;
  platform: string | null;
}

export type DevicePairingCompletion<T> =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "approved"; value: T };

export type DevicePairingApprovalResult =
  | { status: "approved"; pairing: DevicePairingApproval }
  | { status: "not_found" }
  | { status: "already_claimed" };

export interface DevicePairingDependencies {
  now?: () => number;
  randomBytes?: typeof randomBytes;
  randomUUID?: typeof randomUUID;
  maxPendingPairings?: number;
}

function normalizedUserCode(value: string): string {
  return value.toUpperCase().replace(/[-\s]/g, "");
}

export function formatUserCode(value: string): string {
  const normalized = normalizedUserCode(value);
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

function secretHash(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class DevicePairingState {
  readonly #byId = new Map<string, PendingPairing>();
  readonly #idByCode = new Map<string, string>();
  readonly #now: () => number;
  readonly #randomBytes: typeof randomBytes;
  readonly #randomUUID: typeof randomUUID;
  readonly #maxPendingPairings: number;

  constructor(dependencies: DevicePairingDependencies = {}) {
    this.#now = dependencies.now ?? Date.now;
    this.#randomBytes = dependencies.randomBytes ?? randomBytes;
    this.#randomUUID = dependencies.randomUUID ?? randomUUID;
    this.#maxPendingPairings = dependencies.maxPendingPairings ??
      MAX_PENDING_DEVICE_PAIRINGS;
    if (!Number.isSafeInteger(this.#maxPendingPairings) || this.#maxPendingPairings < 1) {
      throw new Error("maxPendingPairings must be a positive integer.");
    }
  }

  create(name: string, platform: string | null): DevicePairingRequest {
    this.#pruneExpired();
    if (this.#byId.size >= this.#maxPendingPairings) {
      throw new DevicePairingCapacityError();
    }
    const pairingId = this.#randomUUID();
    const pairingSecret = this.#randomBytes(32).toString("base64url");
    const userCode = this.#createUserCode();
    const expiresAtMs = this.#now() + DEVICE_PAIRING_TTL_MS;
    const pairing: PendingPairing = {
      pairingId,
      userCode,
      secretHash: secretHash(pairingSecret),
      name,
      platform,
      expiresAtMs,
    };
    pairing.expiryTimer = setTimeout(() => this.#delete(pairing), DEVICE_PAIRING_TTL_MS);
    pairing.expiryTimer.unref();
    this.#byId.set(pairingId, pairing);
    this.#idByCode.set(normalizedUserCode(userCode), pairingId);
    return {
      pairingId,
      userCode,
      pairingSecret,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  approve(accountId: string, rawUserCode: string): DevicePairingApprovalResult {
    this.#pruneExpired();
    const pairingId = this.#idByCode.get(normalizedUserCode(rawUserCode));
    if (!pairingId) return { status: "not_found" };
    const pairing = this.#byId.get(pairingId);
    if (!pairing) return { status: "not_found" };
    if (
      pairing.approvedAccountId !== undefined &&
      pairing.approvedAccountId !== accountId
    ) {
      return { status: "already_claimed" };
    }
    pairing.approvedAccountId = accountId;
    return {
      status: "approved",
      pairing: {
        pairingId: pairing.pairingId,
        userCode: pairing.userCode,
        name: pairing.name,
        platform: pairing.platform,
        expiresAt: new Date(pairing.expiresAtMs).toISOString(),
      },
    };
  }

  async complete<T>(
    pairingId: string,
    pairingSecret: string,
    issue: (pairing: ApprovedPairingIdentity) => Promise<T>,
  ): Promise<DevicePairingCompletion<T>> {
    const pairing = this.#byId.get(pairingId);
    if (!pairing) return { status: "invalid" };
    if (!sameHash(pairing.secretHash, secretHash(pairingSecret))) {
      return { status: "invalid" };
    }
    if (pairing.expiresAtMs <= this.#now()) {
      this.#delete(pairing);
      return { status: "expired" };
    }
    if (!pairing.approvedAccountId) return { status: "pending" };
    if (pairing.completion !== undefined) {
      return { status: "approved", value: pairing.completion as T };
    }

    if (!pairing.completionPromise) {
      const approved: ApprovedPairingIdentity = {
        accountId: pairing.approvedAccountId,
        name: pairing.name,
        platform: pairing.platform,
      };
      pairing.completionPromise = issue(approved);
    }

    const activePromise = pairing.completionPromise as Promise<T>;
    try {
      const value = await activePromise;
      if (this.#byId.get(pairingId) === pairing) {
        pairing.completion = value;
        delete pairing.completionPromise;
      }
      return { status: "approved", value };
    } catch (error) {
      if (
        this.#byId.get(pairingId) === pairing &&
        pairing.completionPromise === activePromise
      ) {
        delete pairing.completionPromise;
      }
      throw error;
    }
  }

  #createUserCode(): string {
    for (;;) {
      const bytes = this.#randomBytes(10);
      let raw = "";
      for (let index = 0; index < 10; index += 1) {
        raw += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length];
      }
      const formatted = formatUserCode(raw);
      if (!this.#idByCode.has(normalizedUserCode(formatted))) return formatted;
    }
  }

  #delete(pairing: PendingPairing): void {
    if (pairing.expiryTimer) clearTimeout(pairing.expiryTimer);
    this.#byId.delete(pairing.pairingId);
    this.#idByCode.delete(normalizedUserCode(pairing.userCode));
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const pairing of this.#byId.values()) {
      if (pairing.expiresAtMs <= now) this.#delete(pairing);
    }
  }
}
