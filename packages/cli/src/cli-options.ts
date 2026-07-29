import { workspaceLabelSchema } from "@glossa/protocol";

export class UsageError extends Error {}

export type CliInvocation =
  | { command: "workspace"; path?: string; label?: string }
  | { command: "status" }
  | { command: "devices"; action: "revoke"; deviceId: string }
  | { command: "logout" }
  | { command: "help" }
  | { command: "version" };

const retiredCommands = new Set([
  "completions",
  "doctor",
  "login",
  "start",
  "update",
]);

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
  };
}

function parseDevices(args: string[]): CliInvocation {
  if (args[0] === "revoke" && args.length === 2) {
    return { command: "devices", action: "revoke", deviceId: args[1]! };
  }
  throw new UsageError("Use: glossa devices revoke <id>.");
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
  if (command === "status") {
    noOptions("Status", options);
    return { command };
  }
  if (command === "devices") return parseDevices(options);
  if (command === "logout") {
    noOptions("Logout", options);
    return { command };
  }
  return parseWorkspace(args);
}
