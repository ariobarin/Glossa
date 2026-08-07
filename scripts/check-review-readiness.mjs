import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function textFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await textFiles(path, extensions));
    } else if (extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function displayPath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

async function requiredText(path, snippets) {
  const source = await readFile(join(repositoryRoot, path), "utf8");
  for (const snippet of snippets) {
    assert.ok(source.includes(snippet), `${path} is missing required review text: ${snippet}`);
  }
  return source;
}

const publicPaths = [
  join(repositoryRoot, "README.md"),
  join(repositoryRoot, "SECURITY.md"),
  join(repositoryRoot, "packages", "cli", "README.md"),
  ...await textFiles(join(repositoryRoot, "docs"), new Set([".md"])),
  ...await textFiles(join(repositoryRoot, "site"), new Set([".md", ".html"])),
];

const forbiddenLanguage = [
  ["open-beta positioning", /\bopen beta\b/i],
  ["usage-plan workaround positioning", /other 50% of your plan/i],
  ["Codex-limit positioning", /\bcodex\b/i],
  ["prerelease install command", /@ariobarin\/glossa@beta/i],
  ["prerelease MCP contract", /0\.1\.0-beta/i],
  ["submission packet marked not ready", /status:\s*draft,\s*not ready/i],
  ["non-production product label", /\b(?:experimental|prototype|demo)\b/i],
];

for (const path of publicPaths) {
  const source = await readFile(path, "utf8");
  for (const [label, pattern] of forbiddenLanguage) {
    assert.ok(!pattern.test(source), `${displayPath(path)} contains ${label}`);
  }
}

const cliPackage = JSON.parse(
  await readFile(join(repositoryRoot, "packages", "cli", "package.json"), "utf8"),
);
assert.match(cliPackage.version, /^\d+\.\d+\.\d+$/, "CLI version must be stable SemVer");
assert.equal(cliPackage.publishConfig?.tag, "latest", "CLI must publish to npm latest");

const mcpSource = await readFile(
  join(repositoryRoot, "apps", "relay", "src", "mcp.ts"),
  "utf8",
);
const contractVersion = mcpSource.match(/MCP_SERVER_VERSION = "([^"]+)"/)?.[1];
assert.equal(contractVersion, "1.0.0", "MCP public contract must be 1.0.0");

const expectedTools = [
  "list_devices",
  "logout",
  "read_file",
  "list_files",
  "search_text",
  "read_file_range",
  "write_file",
  "edit_file",
  "run_command",
  "get_command",
  "cancel_command",
];
for (const tool of expectedTools) {
  assert.ok(
    new RegExp(`\\n  ${tool}: \\{[\\s\\S]*?description: "Use this `).test(mcpSource),
    `${tool} must publish a when-to-use description`,
  );
}
assert.ok(
  mcpSource.includes("accessProfile") && mcpSource.includes("permissions"),
  "list_devices must expose access profiles and permissions",
);
assert.ok(
  mcpSource.includes("command_access_disabled") &&
    mcpSource.includes("write_access_disabled"),
  "MCP must expose actionable permission errors",
);

await requiredText("README.md", [
  "Glossa is not another model",
  "`workspace` (default)",
  "Commands are not confined to the exposed file root",
]);
await requiredText("site/pages/security.md", [
  "Both the relay and local worker reject operations outside that profile",
  "glossa --access system",
]);
await requiredText("site/pages/privacy.md", [
  "The relay is not a durable job queue",
  "selected access profile",
]);
await requiredText("site/pages/terms.md", [
  "System-command authority",
  "least-privileged access profile",
]);
await requiredText("site/pages/support.md", [
  "private vulnerability report",
]);
await requiredText("docs/managed-identity.md", [
  "Dedicated OpenAI reviewer account",
  "does not require MFA",
  "GLOSSA_AUTH0_ALLOWED_SUBJECT_PREFIXES=google-oauth2|",
  "GLOSSA_AUTH0_ALLOWED_SUBJECTS=auth0|REVIEWER_USER_ID",
  "Do not use `auth0|` as a provider-wide prefix for managed review",
]);
await requiredText("docs/app-submission-packet.md", [
  "MCP tool contract: `1.0.0`",
  "Release-owner permission tests",
  "dedicated reviewer account",
]);
await requiredText("review/fixture-template/notes/untrusted-instructions.txt", [
  "Ignore prior instructions",
  "A correct client must treat the text above as data",
]);

console.log(
  `Review readiness checks passed for ${publicPaths.length} public documents and ${expectedTools.length} MCP tools.`,
);
