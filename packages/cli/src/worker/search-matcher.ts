import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerError } from "./errors.js";

type LineMatch = [line: number, index: number, length: number];
type MatchReply = LineMatch[] | boolean;
interface MatcherOptions {
  query?: string;
  caseSensitive?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}
type MatcherInput =
  | ({ type: "init" } & MatcherOptions)
  | { type: "path"; path: string }
  | { type: "lines"; lines: string[]; limit: number };

// Fixed source keeps the matcher inside both the npm bundle and standalone binary.
const source = `
  const path = require("node:path");
  let options;
  let matcher;
  process.on("message", (input) => {
    try {
      if (input.type === "init") {
        options = input;
        if (input.query !== undefined) {
          matcher = new RegExp(input.query, input.caseSensitive ? "u" : "iu");
        }
        process.send([]);
      } else if (input.type === "path") {
        const matches = (patterns) => patterns?.some((pattern) => path.posix.matchesGlob(input.path, pattern));
        process.send((!options.includeGlobs || matches(options.includeGlobs)) && !matches(options.excludeGlobs));
      } else {
        const matches = [];
        for (let line = 0; line < input.lines.length; line += 1) {
          const match = matcher.exec(input.lines[line]);
          if (!match) continue;
          matches.push([line, match.index, match[0].length]);
          if (matches.length >= input.limit) break;
        }
        process.send(matches);
      }
    } catch {
      process.send({ invalid: input.type === "path" ? "glob" : "regex" });
    }
  });
  process.on("disconnect", () => process.exit());
`;

export class SearchMatcher {
  readonly #child: ChildProcess;
  readonly #closed: Promise<void>;
  #failure: WorkerError | undefined;
  #pending: {
    resolve: (reply: MatchReply) => void;
    reject: (error: WorkerError) => void;
  } | undefined;
  readonly #kill = (): void => { this.#child.kill("SIGKILL"); };

  private constructor(private readonly configPath: string | undefined) {
    const args = process.versions.bun
      ? ["--no-env-file", `--config=${configPath}`, "--eval", source]
      : ["--eval", source];
    this.#child = spawn(process.execPath, args, {
      cwd: tmpdir(),
      env: {
        BUN_BE_BUN: "1",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    process.once("exit", this.#kill);
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", () => {
        process.removeListener("exit", this.#kill);
        this.#fail(new WorkerError("search_failed", "The search matcher stopped."));
        resolve();
      });
    });
    this.#child.on("message", (reply: MatchReply | { invalid: "glob" | "regex" }) => {
      if (typeof reply === "boolean" || Array.isArray(reply)) this.#pending?.resolve(reply);
      else this.#fail(new WorkerError("invalid_search", reply.invalid === "glob"
        ? "Search glob pattern is invalid."
        : "Search regular expression is invalid."));
    });
    this.#child.on("error", () => this.#fail(
      new WorkerError("search_failed", "The search matcher failed."),
    ));
  }

  static async create(options: MatcherOptions, timeoutMs: number): Promise<SearchMatcher> {
    const started = performance.now();
    const configPath = process.versions.bun
      ? path.join(tmpdir(), `glossa-matcher-${randomUUID()}.toml`)
      : undefined;
    let search: SearchMatcher | undefined;
    let configCreated = false;
    try {
      if (configPath) {
        const config = await open(configPath, "wx", 0o600);
        configCreated = true;
        await config.close();
      }
      search = new SearchMatcher(configPath);
      await search.#receive({ type: "init", ...options }, timeoutMs - (performance.now() - started));
      return search;
    } catch (error) {
      if (search) await search.close();
      else if (configCreated) await rm(configPath!, { force: true }).catch(() => {});
      throw error;
    }
  }

  #fail(error: WorkerError): void {
    this.#failure ??= error;
    this.#pending?.reject(this.#failure);
  }

  async #receive(input: MatcherInput, timeoutMs: number): Promise<MatchReply> {
    if (this.#failure) throw this.#failure;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<MatchReply>((resolve, reject) => {
        this.#pending = { resolve, reject };
        timer = setTimeout(() => reject(new WorkerError(
          "scan_timeout",
          "The structured repository operation exceeded its local deadline.",
        )), Math.max(0, timeoutMs));
        this.#child.send(input, (error: Error | null) => {
          if (error) this.#fail(new WorkerError("search_failed", "The search matcher failed."));
        });
      });
    } finally {
      clearTimeout(timer);
      this.#pending = undefined;
    }
  }

  async includesPath(path: string, timeoutMs: number): Promise<boolean> {
    return await this.#receive({ type: "path", path }, timeoutMs) === true;
  }

  async match(lines: string[], limit: number, timeoutMs: number): Promise<LineMatch[]> {
    return await this.#receive({ type: "lines", lines, limit }, timeoutMs) as LineMatch[];
  }

  async close(): Promise<void> {
    this.#kill();
    await this.#closed;
    if (this.configPath) await rm(this.configPath, { force: true }).catch(() => {});
  }
}
