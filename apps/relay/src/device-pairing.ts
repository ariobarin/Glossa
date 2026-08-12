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

export type DevicePairingCompletion =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "invalid" }
  | {
      status: "approved";
      accountId: string;
      name: string;
      platform: string | null;
    };

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
    this.#byId.set(pairingId, {
      pairingId,
      userCode,
      secretHash: secretHash(pairingSecret),
      name,
      platform,
      expiresAtMs,
    });
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

  complete(pairingId: string, pairingSecret: string): DevicePairingCompletion {
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

    this.#delete(pairing);
    return {
      status: "approved",
      accountId: pairing.approvedAccountId,
      name: pairing.name,
      platform: pairing.platform,
    };
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
