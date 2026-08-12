import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RELAY_ORIGIN } from "./relay-client.js";
import { configDirectory } from "./secure-store.js";

const CONNECT_HINT_FILE = "connect-hint-shown";
export const CONNECT_HINT_URL = "https://glossa.sh/docs/quickstart";

export function shouldShowConnectHint(relayOrigin: string): boolean {
  return relayOrigin === DEFAULT_RELAY_ORIGIN;
}

export interface ConnectHintStore {
  exists(): Promise<boolean>;
  mark(): Promise<void>;
}

export function connectHintStore(
  directory: string = configDirectory(),
): ConnectHintStore {
  const file = path.join(directory, CONNECT_HINT_FILE);
  return {
    async exists() {
      try {
        await readFile(file, "utf8");
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async mark() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(file, "", { encoding: "utf8", mode: 0o600 });
    },
  };
}

export async function announceConnectHint(
  store: ConnectHintStore,
  log: (message: string) => void,
): Promise<boolean> {
  if (await store.exists()) return false;
  log(`Next: return to ChatGPT and use Glossa. If it is not connected yet, follow ${CONNECT_HINT_URL}.`);
  await store.mark();
  return true;
}
