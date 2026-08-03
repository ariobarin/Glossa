import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_BINDING_TTL_MS = 15 * 60_000;
const TOKEN_PATTERN = /^glt_[A-Za-z0-9_-]{43}$/;

export interface WorkspaceBinding {
  accountId: string;
  workspaceId: string;
  mode: "session" | "token";
  expiresAt: number;
}

export type BindingResolution = WorkspaceBinding | null | "invalid";
export type BindingSelection =
  | { binding: WorkspaceBinding; bindingToken?: string }
  | "invalid"
  | "capacity";

type Context =
  | { mode: "session" | "token"; key: string }
  | { mode: "none" }
  | { mode: "invalid" };

function digest(accountId: string, kind: string, value: string): string {
  return createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
}

export class BindingState {
  readonly #bindings = new Map<string, WorkspaceBinding>();

  constructor(
    readonly ttlMs = DEFAULT_BINDING_TTL_MS,
    readonly now: () => number = Date.now,
    readonly maximumBindings = 4_096,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new Error("Binding TTL must be a positive integer.");
    }
    if (!Number.isInteger(maximumBindings) || maximumBindings < 1) {
      throw new Error("Binding capacity must be a positive integer.");
    }
  }

  resolve(
    accountId: string,
    session: unknown,
    bindingToken: unknown,
  ): BindingResolution {
    this.prune();
    const context = this.#context(accountId, session, bindingToken);
    if (context.mode === "invalid") return "invalid";
    if (context.mode === "none") return null;
    const binding = this.#bindings.get(context.key);
    if (!binding || binding.accountId !== accountId) {
      return context.mode === "token" ? "invalid" : null;
    }
    binding.expiresAt = this.now() + this.ttlMs;
    return { ...binding };
  }

  select(
    accountId: string,
    session: unknown,
    bindingToken: unknown,
    workspaceId: string,
  ): BindingSelection {
    this.prune();
    const context = this.#context(accountId, session, bindingToken);
    if (context.mode === "invalid") return "invalid";

    let key: string;
    let mode: WorkspaceBinding["mode"];
    let issuedToken: string | undefined;
    if (context.mode === "session") {
      key = context.key;
      mode = "session";
    } else if (context.mode === "token") {
      if (!this.#bindings.has(context.key)) return "invalid";
      key = context.key;
      mode = "token";
    } else {
      mode = "token";
      do {
        issuedToken = `glt_${randomBytes(32).toString("base64url")}`;
        key = digest(accountId, "token", issuedToken);
      } while (this.#bindings.has(key));
    }

    if (!this.#bindings.has(key) && this.#bindings.size >= this.maximumBindings) {
      return "capacity";
    }
    const binding: WorkspaceBinding = {
      accountId,
      workspaceId,
      mode,
      expiresAt: this.now() + this.ttlMs,
    };
    this.#bindings.set(key, binding);
    return {
      binding: { ...binding },
      ...(issuedToken ? { bindingToken: issuedToken } : {}),
    };
  }

  count(accountId: string, workspaceId: string): number {
    this.prune();
    let count = 0;
    for (const binding of this.#bindings.values()) {
      if (
        binding.accountId === accountId &&
        binding.workspaceId === workspaceId
      ) {
        count += 1;
      }
    }
    return count;
  }

  prune(): void {
    const now = this.now();
    for (const [key, binding] of this.#bindings) {
      if (binding.expiresAt <= now) this.#bindings.delete(key);
    }
  }

  #context(
    accountId: string,
    session: unknown,
    bindingToken: unknown,
  ): Context {
    if (session !== undefined && bindingToken !== undefined) {
      return { mode: "invalid" };
    }
    if (session !== undefined) {
      if (typeof session !== "string" || session.length < 1 || session.length > 512) {
        return { mode: "invalid" };
      }
      return { mode: "session", key: digest(accountId, "session", session) };
    }
    if (bindingToken !== undefined) {
      if (typeof bindingToken !== "string" || !TOKEN_PATTERN.test(bindingToken)) {
        return { mode: "invalid" };
      }
      return {
        mode: "token",
        key: digest(accountId, "token", bindingToken),
      };
    }
    return { mode: "none" };
  }
}
