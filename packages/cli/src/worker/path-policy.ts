import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerError } from "./errors.js";

export function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function accountHomeDirectory(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function validateRelativePath(value: string): string {
  if (value.includes("\0")) {
    throw new WorkerError("invalid_path", "Paths cannot contain null bytes.");
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw new WorkerError("absolute_path", "Absolute paths are not allowed.");
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new WorkerError("path_traversal", "Parent path traversal is not allowed.");
  }
  return value === "" ? "." : value;
}

export async function canonicalizeRoot(
  candidate: string,
): Promise<string> {
  const root = await realpath(path.resolve(candidate)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new WorkerError("root_not_found", "The workspace directory does not exist.");
    }
    throw error;
  });
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new WorkerError("root_not_directory", "The exposed root must be a directory.");
  }

  const filesystemRoot = path.parse(root).root;
  const homes = await Promise.all(
    [os.homedir(), accountHomeDirectory()].map(async (home) =>
      await realpath(home).catch(() => path.resolve(home))
    ),
  );
  const isHomeDirectory = homes.some((home) => samePath(root, home));
  if (samePath(root, filesystemRoot) || isHomeDirectory) {
    const kind = isHomeDirectory ? "your home directory" : "a filesystem root";
    throw new WorkerError(
      "broad_root_refused",
      `The selected root is ${kind}, which Glossa will not expose. Choose a project directory instead.`,
    );
  }
  return root;
}

export class PathPolicy {
  private constructor(readonly root: string) {}

  static async create(candidate: string): Promise<PathPolicy> {
    return new PathPolicy(await canonicalizeRoot(candidate));
  }

  async resolveExisting(relativePath: string): Promise<string> {
    const lexical = this.resolveLexical(relativePath);
    await this.rejectLinkedComponents(lexical);
    const canonical = await realpath(lexical).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new WorkerError("path_not_found", "The requested path does not exist.");
      }
      throw error;
    });
    if (!isWithin(this.root, canonical)) {
      throw new WorkerError("path_escape", "The requested path escapes the exposed root.");
    }
    return canonical;
  }

  async resolveWritableFile(relativePath: string): Promise<string> {
    const lexical = this.resolveLexical(relativePath);
    const parent = path.dirname(lexical);
    await this.rejectLinkedComponents(parent);
    const canonicalParent = await realpath(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new WorkerError("parent_not_found", "The destination directory does not exist.");
      }
      throw error;
    });
    if (!isWithin(this.root, canonicalParent)) {
      throw new WorkerError("path_escape", "The destination escapes the exposed root.");
    }
    if (!(await stat(canonicalParent)).isDirectory()) {
      throw new WorkerError("not_directory", "The destination parent is not a directory.");
    }

    try {
      const targetStat = await lstat(lexical);
      if (targetStat.isSymbolicLink()) {
        throw new WorkerError("linked_path", "Writes through links are not allowed.");
      }
      if (targetStat.isDirectory()) {
        throw new WorkerError("not_file", "The destination is a directory.");
      }
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    return path.join(canonicalParent, path.basename(lexical));
  }

  private resolveLexical(relativePath: string): string {
    const validated = validateRelativePath(relativePath);
    const candidate = path.resolve(this.root, validated);
    if (!isWithin(this.root, candidate)) {
      throw new WorkerError("path_escape", "The requested path escapes the exposed root.");
    }
    return candidate;
  }

  private async rejectLinkedComponents(candidate: string): Promise<void> {
    if (!isWithin(this.root, candidate)) {
      throw new WorkerError("path_escape", "The requested path escapes the exposed root.");
    }
    const relative = path.relative(this.root, candidate);
    if (!relative) return;
    let current = this.root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const currentStat = await lstat(current);
        if (currentStat.isSymbolicLink()) {
          throw new WorkerError(
            "linked_path",
            "Symlink and junction paths are not allowed.",
          );
        }
      } catch (error) {
        if (error instanceof WorkerError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
}
