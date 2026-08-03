import { createHash } from "node:crypto";

const NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

export function workspaceIdentity(
  deviceId: string,
  canonicalRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const root = platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const bytes = createHash("sha1")
    .update(NAMESPACE)
    .update(`https://glossa.sh/workspace/v1\0${deviceId.toLowerCase()}\0${root}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
