import { createHash, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{8}$/;

export interface GeneratedPairingCode {
  code: string;
  hash: Buffer;
}

export function pairingCodeHash(code: string): Buffer | null {
  const normalized = code.toUpperCase().replaceAll("-", "");
  if (!CODE_PATTERN.test(normalized)) return null;
  return createHash("sha256").update(normalized).digest();
}

export function generatePairingCode(): GeneratedPairingCode {
  let raw = "";
  for (let index = 0; index < 8; index += 1) {
    raw += ALPHABET[randomInt(ALPHABET.length)];
  }
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return { code, hash: pairingCodeHash(code)! };
}
