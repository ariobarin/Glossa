export class UsageError extends Error {}

export type CliInvocation =
  | { command: "workspace"; path?: string }
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
  let optionsEnded = false;

  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
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
