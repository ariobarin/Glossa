import {
  DEFAULT_WORKER_ACCESS_PROFILE,
  workerAccessProfileSchema,
  workspaceLabelSchema,
  type WorkerAccessProfile,
} from "@glossa/protocol";
import type { UpdateChannel, UpdatePolicy } from "./update-state.js";

export class UsageError extends Error {}

export type CliInvocation =
  | {
      command: "workspace";
      path?: string;
      label?: string;
      accessProfile: WorkerAccessProfile;
    }
  | { command: "unpair" }
  | { command: "update"; action: "install" | "check" }
  | {
      command: "update";
      action: "configure";
      policy?: UpdatePolicy;
      channel?: UpdateChannel;
    }
  | { command: "help" }
  | { command: "version" };

const retiredCommands = new Set([
  "completions",
  "devices",
  "doctor",
  "login",
  "logout",
  "start",
  "status",
]);

function parseWorkspace(args: string[]): CliInvocation {
  let selectedPath: string | undefined;
  let label: string | undefined;
  let accessProfile = DEFAULT_WORKER_ACCESS_PROFILE;
  let accessProfileSet = false;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && argument === "--label") {
      if (label !== undefined) {
        throw new UsageError("Glossa accepts at most one workspace label.");
      }
      const value = args[index + 1];
      if (value === undefined || value === "--") {
        throw new UsageError("Use --label <name>.");
      }
      const parsed = workspaceLabelSchema.safeParse(value);
      if (!parsed.success) {
        throw new UsageError("Workspace labels must be 1-80 printable characters.");
      }
      label = parsed.data;
      index += 1;
    } else if (!optionsEnded && argument === "--access") {
      if (accessProfileSet) {
        throw new UsageError("Glossa accepts at most one access profile.");
      }
      const value = args[index + 1];
      if (value === undefined || value === "--") {
        throw new UsageError("Use --access <read-only|workspace|system>.");
      }
      const parsed = workerAccessProfileSchema.safeParse(value);
      if (!parsed.success) {
        throw new UsageError("Access must be read-only, workspace, or system.");
      }
      accessProfile = parsed.data;
      accessProfileSet = true;
      index += 1;
    } else if (!optionsEnded && argument.startsWith("-")) {
      throw new UsageError(`Unknown option: ${argument}`);
    } else if (selectedPath) {
      throw new UsageError("Glossa accepts at most one directory.");
    } else if (!optionsEnded && retiredCommands.has(argument)) {
      throw new UsageError(`The ${argument} command is no longer available.`);
    } else {
      selectedPath = argument;
    }
  }

  return {
    command: "workspace",
    ...(selectedPath ? { path: selectedPath } : {}),
    ...(label ? { label } : {}),
    accessProfile,
  };
}

function parseUpdate(args: string[]): CliInvocation {
  if (args.length === 0) return { command: "update", action: "install" };
  let check = false;
  let policy: UpdatePolicy | undefined;
  let channel: UpdateChannel | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--check") {
      if (check) throw new UsageError("Use --check at most once.");
      check = true;
    } else if (argument === "--policy") {
      if (policy) throw new UsageError("Use --policy at most once.");
      const value = args[index + 1];
      if (value !== "notify" && value !== "auto" && value !== "off") {
        throw new UsageError("Use --policy notify, auto, or off.");
      }
      policy = value;
      index += 1;
    } else if (argument === "--channel") {
      if (channel) throw new UsageError("Use --channel at most once.");
      const value = args[index + 1];
      if (value !== "beta" && value !== "stable") {
        throw new UsageError("Use --channel beta or stable.");
      }
      channel = value;
      index += 1;
    } else {
      throw new UsageError(`Unknown update option: ${argument}`);
    }
  }

  if (check && (policy || channel)) {
    throw new UsageError("Use --check separately from update settings.");
  }
  if (check) return { command: "update", action: "check" };
  if (policy || channel) {
    return {
      command: "update",
      action: "configure",
      ...(policy ? { policy } : {}),
      ...(channel ? { channel } : {}),
    };
  }
  throw new UsageError("Use: glossa update [--check | --policy <value> | --channel <value>].");
}

function noOptions(command: string, args: string[]): void {
  if (args.length > 0) throw new UsageError(`${command} accepts no options.`);
}

export function parseInvocation(args: string[]): CliInvocation {
  const [command, ...options] = args;
  if (!command) return parseWorkspace([]);
  if (command === "--help" || command === "-h") {
    noOptions("Help", options);
    return { command: "help" };
  }
  if (command === "--version" || command === "-v") {
    noOptions("Version", options);
    return { command: "version" };
  }
  if (command === "--") return parseWorkspace(args);
  if (command === "unpair") {
    noOptions("Unpair", options);
    return { command };
  }
  if (command === "update") return parseUpdate(options);
  return parseWorkspace(args);
}
