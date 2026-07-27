import { workspaceLabelSchema } from "@glossa/protocol";

export class UsageError extends Error {}

export type CliInvocation =
  | { command: "workspace"; path?: string; label?: string }
  | { command: "status"; json: boolean }
  | { command: "doctor"; json: boolean }
  | { command: "devices"; action: "list"; json: boolean }
  | { command: "devices"; action: "revoke"; deviceId: string }
  | { command: "update" }
  | { command: "login" }
  | { command: "logout" }
  | { command: "help" }
  | { command: "version" };

function parseWorkspace(args: string[]): CliInvocation {
  let selectedPath: string | undefined;
  let label: string | undefined;
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
    } else if (!optionsEnded && argument.startsWith("-")) {
      throw new UsageError(`Unknown option: ${argument}`);
    } else if (selectedPath) {
      throw new UsageError("Glossa accepts at most one directory.");
    } else {
      selectedPath = argument;
    }
  }

  return {
    command: "workspace",
    ...(selectedPath ? { path: selectedPath } : {}),
    ...(label ? { label } : {}),
  };
}

function parseJsonOption(command: string, args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--json") return true;
  throw new UsageError(`${command} accepts only --json.`);
}

function parseDevices(args: string[]): CliInvocation {
  if (args.length === 0 || (args.length === 1 && args[0] === "--json")) {
    return {
      command: "devices",
      action: "list",
      json: parseJsonOption("Devices", args),
    };
  }
  if (args[0] === "revoke" && args.length === 2) {
    return { command: "devices", action: "revoke", deviceId: args[1]! };
  }
  throw new UsageError("Use: glossa devices [--json] or glossa devices revoke <id>.");
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
  if (options.includes("--help") || options.includes("-h")) {
    return { command: "help" };
  }
  if (command === "status") {
    return { command, json: parseJsonOption("Status", options) };
  }
  if (command === "doctor") {
    return { command, json: parseJsonOption("Doctor", options) };
  }
  if (command === "devices") return parseDevices(options);
  if (command === "update" || command === "login" || command === "logout") {
    noOptions(command[0]!.toUpperCase() + command.slice(1), options);
    return { command };
  }
  return parseWorkspace(args);
}
