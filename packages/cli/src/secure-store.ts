import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYRING_SERVICE = "Glossa";

interface KeyringEntry {
  setSecret(secret: Uint8Array): Promise<void>;
  getSecret(): Promise<Uint8Array | number[] | null | undefined>;
  deleteCredential(): Promise<boolean>;
}

export type StorageBackend = "keyring" | "file";

export interface SecureStoreOptions<T> {
  account: string;
  file: string;
  warning: string;
  parse: (serialized: string) => T;
  warn?: (message: string) => void;
  entryProvider?: () => Promise<KeyringEntry | null>;
}

export function configDirectory(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), "Glossa");
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "glossa",
  );
}

/**
 * Reads credentials from wherever they are and writes them to the keyring
 * when available, falling back to a mode-0600 file. Reading never writes:
 * no format or backend migration happens as a side effect of a load.
 */
export class SecureStore<T> {
  readonly #options: SecureStoreOptions<T>;
  #warned = false;

  constructor(options: SecureStoreOptions<T>) {
    this.#options = options;
  }

  async save(value: T): Promise<StorageBackend> {
    const serialized = JSON.stringify(value);
    const entry = await this.#entry();
    if (entry) {
      try {
        await this.#writeEntry(entry, serialized);
        await rm(this.#options.file, { force: true });
        return "keyring";
      } catch {
        // Use the warned file fallback below.
      }
    }

    this.#warn();
    await mkdir(path.dirname(this.#options.file), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      this.#options.file,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (process.platform !== "win32") {
      await chmod(this.#options.file, 0o600);
    }
    return "file";
  }

  async load(): Promise<{ value: T; backend: StorageBackend } | null> {
    const entry = await this.#entry();
    if (entry) {
      const value = await this.#readEntry(entry);
      if (value != null) return { value, backend: "keyring" };
    }

    let value: T;
    try {
      value = this.#options.parse(await readFile(this.#options.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    this.#warn();
    return { value, backend: "file" };
  }

  async delete(): Promise<void> {
    const entry = await this.#entry();
    let keyringDeleteFailed = false;
    if (entry) {
      try {
        const deleted = await entry.deleteCredential();
        if (!deleted && (await entry.getSecret()) != null) {
          keyringDeleteFailed = true;
        }
      } catch {
        keyringDeleteFailed = true;
      }
    }
    await rm(this.#options.file, { force: true });
    if (keyringDeleteFailed) {
      throw new Error(
        "The operating-system credential store could not remove the Glossa credential.",
      );
    }
  }

  async #entry(): Promise<KeyringEntry | null> {
    if (this.#options.entryProvider) {
      try {
        return await this.#options.entryProvider();
      } catch {
        return null;
      }
    }
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(KEYRING_SERVICE, this.#options.account);
    } catch {
      return null;
    }
  }

  async #readEntry(entry: KeyringEntry): Promise<T | null> {
    try {
      const secret = await entry.getSecret();
      if (secret == null) return null;
      const bytes = secret instanceof Uint8Array ? secret : Uint8Array.from(secret);
      return this.#options.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      // A corrupt or unreadable entry reports as absent: the file can still
      // provide the credential, and delete() removes the entry outright.
      return null;
    }
  }

  async #writeEntry(entry: KeyringEntry, serialized: string): Promise<void> {
    await entry.setSecret(new TextEncoder().encode(serialized));
  }

  #warn(): void {
    if (this.#warned) return;
    this.#warned = true;
    (this.#options.warn ?? console.warn)(this.#options.warning);
  }
}
