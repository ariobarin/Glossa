export const MIN_NODE_MAJOR = 18;
export const MIN_NODE_MINOR = 0;

export function nodeVersionSatisfies(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return (
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
  );
}

export function unsupportedNodeMessage(version: string): string {
  return `Glossa requires Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer, but this terminal is running Node ${version}. Install a newer Node.js from https://nodejs.org/ and restart your terminal.`;
}
