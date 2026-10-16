import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

// Validates a Glossa plugin package against the directory submission rules in
// https://developers.openai.com/plugins/deploy/submission and
// https://developers.openai.com/plugins/deploy/submission-errors.
// Usage: node scripts/check-plugin-package.mjs [package-directory]
// With no directory, checks the built .plugin-build output and its ZIP.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = resolve(repositoryRoot, process.env.GLOSSA_PLUGIN_BUILD_DIR ?? ".plugin-build");
const directoryArgument = process.argv[2] ?? process.env.GLOSSA_PLUGIN_PACKAGE_DIR;
const pluginRoot = resolve(directoryArgument ?? join(buildRoot, "glossa"));
const checkingBuild = directoryArgument === undefined;
const expectedPublisherName = process.env.GLOSSA_VERIFIED_PUBLISHER_NAME || undefined;
const expectedAppId = process.env.GLOSSA_PLUGIN_APP_ID || undefined;

const MCP_URL = "https://mcp.glossa.sh/mcp";
const LISTING_URLS = {
  websiteURL: "https://glossa.sh",
  supportURL: "https://glossa.sh/support",
  privacyPolicyURL: "https://glossa.sh/privacy",
  termsOfServiceURL: "https://glossa.sh/terms",
};
const ALLOWED_FILES = /^(?:plugin\.json|mcp\.json|assets\/[a-z0-9][a-z0-9-]*\.(?:svg|png|jpe?g|webp))$/;

async function jsonFile(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${label} must contain a JSON object`);
  return parsed;
}

function supportedText(value, label, { maximum, singleLine = true, required = true } = {}) {
  if (!required && value === undefined) return;
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must be non-empty`);
  assert.ok(value.length <= maximum, `${label} must be at most ${maximum} characters; got ${value.length}`);
  assert.doesNotMatch(value, /[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u, `${label} contains unsupported characters`);
  if (singleLine) assert.doesNotMatch(value, /\n/, `${label} must fit on one line`);
}

function httpsUrl(value, label, maximum = 1024) {
  supportedText(value, label, { maximum });
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS`);
  assert.ok(url.hostname && !url.username && !url.password, `${label} must have a host and no credentials`);
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, keys);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

const files = [];
let totalBytes = 0;
async function scanTree(directory, depth = 1) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = relative(pluginRoot, path).split(sep).join("/");
    assert.ok(depth <= 20, `${name} is nested more than 20 segments deep`);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), `${name} is a symbolic link`);
    if (info.isDirectory()) await scanTree(path, depth + 1);
    else {
      assert.ok(info.isFile(), `${name} is not a regular file`);
      assert.ok(info.size <= 100 * 1024 * 1024, `${name} exceeds 100 MiB`);
      totalBytes += info.size;
      files.push(name);
    }
  }
}
await scanTree(pluginRoot);
files.sort();
assert.ok(files.length <= 5000, "package contains more than 5000 entries");
assert.ok(totalBytes <= 512 * 1024 * 1024, "package exceeds 512 MiB uncompressed");
for (const name of files) {
  assert.match(name, ALLOWED_FILES, `${name} is not part of an MCP-only submission package; .app.json, .codex-plugin, .mcp.json, hooks, and skills are excluded`);
}

const manifest = await jsonFile(join(pluginRoot, "plugin.json"), "plugin.json");
assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
assert.match(manifest.name ?? "", /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name must be lowercase letters, digits, and single hyphens");
assert.ok(manifest.name.length <= 64, "name must be at most 64 characters");
assert.match(manifest.version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "version must be semantic");
supportedText(manifest.description, "description", { maximum: 4000, singleLine: false });
assert.ok(manifest.author && typeof manifest.author === "object", "author is required");
supportedText(manifest.author.name, "author.name", { maximum: 120 });
httpsUrl(manifest.author.url, "author.url", 2048);
httpsUrl(manifest.homepage, "homepage", 2048);
assert.equal(manifest.repository, "https://github.com/ariobarin/glossa");
assert.equal(manifest.license, "MIT");
for (const field of ["skills", "mcpServers", "apps", "hooks", "interface"]) {
  assert.equal(manifest[field], undefined, `root plugin.json must not declare ${field}`);
}

const openai = manifest.extensions?.["com.openai"];
assert.ok(openai && typeof openai === "object", "extensions.com.openai is required");
for (const field of ["apps", "hooks", "onboardingSkill", "requires_local_executor"]) {
  assert.equal(openai[field], undefined, `extensions.com.openai.${field} is not allowed in the submission package`);
}
const forbiddenKeys = collectKeys(manifest);
for (const key of ["test_credentials", "reviewer_instructions", "clientSecret"]) {
  assert.ok(!forbiddenKeys.has(key), `${key} must not appear in the package`);
}

const ui = openai.interface;
assert.ok(ui && typeof ui === "object", "interface is required");
supportedText(ui.displayName, "interface.displayName", { maximum: 30 });
assert.equal(ui.displayName, "Glossa");
supportedText(ui.shortDescription, "interface.shortDescription", { maximum: 30 });
supportedText(ui.longDescription, "interface.longDescription", { maximum: 4000, singleLine: false });
supportedText(ui.developerName, "interface.developerName", { maximum: 80 });
assert.equal(ui.developerName, manifest.author.name, "interface.developerName must match author.name");
if (expectedPublisherName) {
  assert.equal(ui.developerName, expectedPublisherName, "developer name must match the verified publisher identity");
}
assert.equal(ui.category, "Developer Tools");
assert.ok(Array.isArray(ui.capabilities) && ui.capabilities.length > 0 && ui.capabilities.length <= 20, "capabilities must list 1-20 entries");
ui.capabilities.forEach((capability, index) => supportedText(capability, `interface.capabilities[${index}]`, { maximum: 120 }));
for (const [field, expected] of Object.entries(LISTING_URLS)) {
  httpsUrl(ui[field], `interface.${field}`);
  assert.equal(ui[field], expected, `interface.${field} must be ${expected}`);
}
assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3, "defaultPrompt must list 1-3 prompts");
const normalizedPrompts = new Set();
ui.defaultPrompt.forEach((prompt, index) => {
  supportedText(prompt, `interface.defaultPrompt[${index}]`, { maximum: 128 });
  assert.doesNotMatch(prompt, /@/, "starter prompts must not mention a plugin with @");
  normalizedPrompts.add(prompt.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase());
});
assert.equal(normalizedPrompts.size, ui.defaultPrompt.length, "starter prompts must be unique");
assert.equal(ui.screenshots, undefined, "screenshots are only allowed for MCP servers with custom UI");
for (const color of ["brandColor", "brandColorDark"]) {
  if (ui[color] !== undefined) assert.match(ui[color], /^#[0-9A-Fa-f]{6}$/, `${color} must be #RRGGBB`);
}

async function validateIcon(value, label) {
  assert.equal(typeof value, "string", `${label} is required`);
  assert.ok(value.startsWith("./") && !isAbsolute(value), `${label} must be a ./ relative path`);
  const path = resolve(pluginRoot, value);
  const rel = relative(pluginRoot, path);
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), `${label} must stay inside the package`);
  const info = await lstat(path);
  assert.ok(info.isFile() && info.size > 0 && info.size <= 5 * 1024 * 1024, `${label} must be a file of at most 5 MiB`);
  assert.equal(extname(path).toLowerCase(), ".svg", `${label} should use the reviewed Glossa SVG badge`);
  const source = await readFile(path, "utf8");
  const viewBox = source.match(/viewBox\s*=\s*["']\s*[-+\d.]+\s+[-+\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  assert.ok(viewBox, `${label} SVG must define a numeric viewBox`);
  assert.equal(Number(viewBox[1]), Number(viewBox[2]), `${label} must be square`);
  assert.ok(Number(viewBox[1]) >= 48, `${label} must be at least 48 by 48`);
  const badge = await readFile(join(repositoryRoot, "site", "glossa-symbol-badge.svg"), "utf8");
  assert.equal(source, badge, `${label} must match site/glossa-symbol-badge.svg`);
}
await validateIcon(ui.logo, "interface.logo");
await validateIcon(ui.composerIcon, "interface.composerIcon");

const relayCopy = await readFile(join(repositoryRoot, "apps", "relay", "src", "mcp-copy.ts"), "utf8");
const toolNames = new Set([...relayCopy.matchAll(/^ {2}([a-z_]+): \{$/gm)].map((match) => match[1]));
assert.equal(toolNames.size, 16, "expected 16 relay tools in mcp-copy.ts");

const review = openai.review;
assert.ok(review && typeof review === "object", "review is required");
const cases = review.test_cases;
assert.ok(cases && Array.isArray(cases.positive) && Array.isArray(cases.negative), "review.test_cases needs positive and negative lists");
assert.equal(cases.positive.length, 5, "initial MCP review requires exactly five positive cases");
assert.equal(cases.negative.length, 3, "initial MCP review requires exactly three negative cases");
const prompts = new Set();
for (const [kind, list] of Object.entries(cases)) {
  list.forEach((testCase, index) => {
    const label = `review.test_cases.${kind}[${index}]`;
    supportedText(testCase.description, `${label}.description`, { maximum: 4000, singleLine: false });
    supportedText(testCase.prompt, `${label}.prompt`, { maximum: 4000, singleLine: false });
    assert.ok(!prompts.has(testCase.prompt), `${label}.prompt duplicates another case`);
    prompts.add(testCase.prompt);
    if (kind === "positive" || testCase.expected_behavior !== undefined) {
      supportedText(testCase.expected_behavior, `${label}.expected_behavior`, { maximum: 4000, singleLine: false });
    }
    if (kind === "positive") {
      supportedText(testCase.tools_triggered, `${label}.tools_triggered`, { maximum: 4000 });
      for (const tool of testCase.tools_triggered.split(/,\s*/)) {
        assert.ok(toolNames.has(tool), `${label}.tools_triggered names unknown tool ${tool}`);
      }
    } else {
      assert.equal(testCase.tools_triggered, undefined, `${label} must not list triggered tools`);
    }
  });
}
if (review.demo_recording_url !== undefined) httpsUrl(review.demo_recording_url, "review.demo_recording_url", 2048);
else console.warn("review.demo_recording_url is not set; enter the walkthrough URL in Review details before submitting.");
assert.equal(review.commerce, false, "Glossa does not support commerce");

const publication = openai.publication;
assert.ok(publication && typeof publication === "object", "publication is required");
supportedText(publication.release_notes, "publication.release_notes", { maximum: 4000, singleLine: false });
if (publication.countries !== undefined) {
  assert.ok(Array.isArray(publication.countries), "publication.countries must be an array");
  for (const country of publication.countries) assert.match(country, /^[A-Z]{2}$/, "countries must be uppercase country codes");
}

const mcp = await jsonFile(join(pluginRoot, "mcp.json"), "mcp.json");
assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
const servers = Object.entries(mcp.mcpServers ?? {});
assert.equal(servers.length, 1, "mcp.json must declare exactly one MCP server");
const [[serverName, server]] = servers;
assert.equal(serverName, "glossa");
assert.equal(server.type, "streamable-http");
assert.equal(server.url, MCP_URL, `MCP server URL must be ${MCP_URL}`);
assert.equal(server.headers, undefined, "public submission rejects server headers");
const auth = server.extensions?.["com.openai"]?.auth;
assert.equal(auth?.type, "oauth", "the MCP server uses OAuth");
assert.equal(auth.client?.mode, "cimd", "Auth0 advertises Client ID Metadata Document registration");
assert.equal(auth.client.clientId, undefined, "CIMD clients must not declare clientId");
assert.deepEqual(auth.baseScopes, ["glossa:access"]);

if (checkingBuild) {
  // The ZIP must hold exactly the package files at its root, with
  // forward-slash names and matching contents.
  const zipPath = join(buildRoot, `glossa-${manifest.version}.zip`);
  const archive = await readFile(zipPath);
  assert.ok(archive.length <= 100 * 1024 * 1024, "ZIP must be at most 100 MB");
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endOffset >= 0, "ZIP end-of-central-directory record is missing");
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const archived = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, "ZIP central directory is malformed");
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.ok(!name.includes("\\") && !name.startsWith("/") && !name.split("/").includes(".."), `ZIP entry ${name} has an unsafe path`);
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(stored) : stored;
    assert.equal(crc32(data), checksum, `ZIP entry ${name} fails its CRC`);
    assert.deepEqual(data, await readFile(join(pluginRoot, ...name.split("/"))), `ZIP entry ${name} differs from the package`);
    archived.push(name);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.deepEqual(archived.sort(), files, "ZIP entries must match the package files");
  console.log(`Submission ZIP checks passed for ${relative(repositoryRoot, zipPath)}: ${archived.length} entries.`);
}

if (expectedAppId) {
  assert.match(expectedAppId, /^plugin_asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/, "GLOSSA_PLUGIN_APP_ID must start with plugin_asdk_app_");
  const localRoot = join(buildRoot, "local", "glossa");
  const localManifest = await jsonFile(join(localRoot, ".codex-plugin", "plugin.json"), "local .codex-plugin/plugin.json");
  const appMapping = await jsonFile(join(localRoot, ".app.json"), "local .app.json");
  assert.equal(localManifest.apps, "./.app.json", "local manifest apps must point to ./.app.json");
  assert.deepEqual(localManifest.interface, ui, "local test package must use the submitted listing");
  assert.deepEqual(appMapping, { apps: { glossa: { id: expectedAppId.slice("plugin_".length) } } }, "local .app.json must map the registered connection");
  console.log(`Local test package maps ${expectedAppId}.`);
}

console.log(`Plugin package checks passed for ${relative(repositoryRoot, pluginRoot) || "."}: ${files.length} files, ${totalBytes} bytes.`);
