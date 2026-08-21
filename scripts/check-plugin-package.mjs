import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [pluginDirectoryArg, expectedAppIdArg, expectedPublisherNameArg] = process.argv.slice(2);
const pluginDirectoryArgument = pluginDirectoryArg ?? process.env.GLOSSA_PLUGIN_PACKAGE_DIR;
const expectedAppId = expectedAppIdArg ?? process.env.GLOSSA_PLUGIN_APP_ID;
const expectedPublisherName = expectedPublisherNameArg ?? process.env.GLOSSA_VERIFIED_PUBLISHER_NAME;

if (!pluginDirectoryArgument || !expectedAppId) {
  console.error(
    "Provide the generated plugin package and registered MCP connection ID either as arguments or with GLOSSA_PLUGIN_PACKAGE_DIR and GLOSSA_PLUGIN_APP_ID. Usage: node scripts/check-plugin-package.mjs <plugin-directory> <plugin_asdk_app...> [verified-publisher-name]",
  );
  process.exit(2);
}
assert.match(
  expectedAppId,
  /^plugin_asdk_app_[A-Za-z0-9_-]+$/,
  "expected MCP connection ID must start with plugin_asdk_app_",
);

const pluginRoot = resolve(pluginDirectoryArgument);
const manifestPath = resolve(pluginRoot, ".codex-plugin", "plugin.json");
const appPath = resolve(pluginRoot, ".app.json");
const packetPath = resolve(repositoryRoot, "docs", "app-submission-packet.md");

async function jsonFile(path, label) {
  const source = await readFile(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(typeof parsed, "object", `${label} must contain a JSON object`);
  assert.ok(parsed !== null && !Array.isArray(parsed), `${label} must contain a JSON object`);
  return parsed;
}

const submissionPacket = await readFile(packetPath, "utf8");
function packetMatch(pattern, label) {
  const match = submissionPacket.match(pattern);
  assert.ok(match?.[1], `submission packet is missing ${label}`);
  return match[1].trim();
}

const expected = {
  name: packetMatch(/- Package name: `([^`]+)`/, "package name"),
  version: packetMatch(/- Initial plugin version: `([^`]+)`/, "plugin version"),
  packageDescription: packetMatch(/- Package description: `([^`]+)`/, "package description"),
  shortDescription: packetMatch(/Proposed short description:\r?\n\r?\n> ([^\r\n]+)/, "short description"),
  longDescription: packetMatch(
    /Proposed full description:\r?\n\r?\n> ([\s\S]*?)\r?\n\r?\n## Distinct product purpose/,
    "full description",
  ).replace(/^> /gm, "").trim(),
};
const capabilityLine = packetMatch(/- Capabilities: ([^\r\n]+)/, "capabilities");
expected.capabilities = [...capabilityLine.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const starterSection = packetMatch(
  /## Starter prompts\r?\n([\s\S]*?)\r?\n## Agent-routing evaluation set/,
  "starter prompts",
);
expected.defaultPrompt = starterSection
  .split(/\r?\n/)
  .filter((line) => line.startsWith("- "))
  .map((line) => line.slice(2));

const manifest = await jsonFile(manifestPath, "plugin manifest");
const appMapping = await jsonFile(appPath, ".app.json");

assert.equal(manifest.name, expected.name);
assert.equal(manifest.version, expected.version);
assert.equal(manifest.description, expected.packageDescription);
assert.equal(manifest.apps, "./.app.json", "manifest apps must point to ./.app.json");
assert.equal(manifest.skills, undefined, "Glossa is MCP-only and must not declare bundled skills");
assert.equal(manifest.mcpServers, undefined, "Glossa uses the registered .app.json MCP connection, not a bundled .mcp.json server");
assert.equal(manifest.homepage, "https://glossa.sh");
assert.equal(manifest.repository, "https://github.com/ariobarin/glossa");
assert.equal(manifest.license, "MIT");
assert.equal(typeof manifest.author, "object");
assert.ok(manifest.author && !Array.isArray(manifest.author));
assert.equal(typeof manifest.author.name, "string");
assert.ok(manifest.author.name.trim().length > 0, "author.name must be non-empty");
assert.equal(manifest.author.url, "https://glossa.sh");
if (expectedPublisherName) {
  assert.equal(manifest.author.name, expectedPublisherName, "author.name must match the selected verified publisher identity");
}

const ui = manifest.interface;
assert.ok(ui && typeof ui === "object" && !Array.isArray(ui), "manifest interface is required");
assert.equal(ui.displayName, "Glossa");
assert.equal(ui.shortDescription, expected.shortDescription);
assert.equal(ui.longDescription, expected.longDescription);
assert.equal(ui.developerName, manifest.author.name, "interface.developerName must exactly match author.name");
assert.ok(ui.developerName.length <= 80, "developer name must fit the final directory limit");
assert.equal(ui.category, "Developer Tools");
assert.deepEqual(ui.capabilities, expected.capabilities);
assert.deepEqual(ui.defaultPrompt, expected.defaultPrompt);
assert.equal(ui.websiteURL, "https://glossa.sh");
assert.equal(ui.privacyPolicyURL, "https://glossa.sh/privacy");
assert.equal(ui.termsOfServiceURL, "https://glossa.sh/terms");
assert.equal(ui.supportURL, "https://glossa.sh/support");
assert.equal(ui.screenshots, undefined, "screenshots must be omitted because Glossa has no custom MCP UI");

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}
const appIds = new Set(
  collectStrings(appMapping).filter((value) => value.startsWith("plugin_asdk_app")),
);
assert.deepEqual([...appIds], [expectedAppId], ".app.json must reference exactly the expected registered MCP connection ID");
assert.ok(!JSON.stringify(appMapping).includes("plugin_asdk_app..."), ".app.json contains a placeholder technical ID");

function resolveManifestPath(value, label) {
  assert.equal(typeof value, "string", `${label} path is required`);
  assert.ok(value.startsWith("./"), `${label} path must start with ./`);
  assert.ok(!isAbsolute(value), `${label} path must be relative`);
  const candidate = resolve(pluginRoot, value);
  const rel = relative(pluginRoot, candidate);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== "..", `${label} path must stay inside the plugin root`);
  return candidate;
}

async function validateSquareSvg(value, label) {
  const path = resolveManifestPath(value, label);
  assert.equal(extname(path).toLowerCase(), ".svg", `${label} should use the reviewed Glossa SVG badge for deterministic validation`);
  const info = await lstat(path);
  assert.ok(info.isFile(), `${label} must be a regular file`);
  assert.ok(info.size > 0 && info.size <= 5 * 1024 * 1024, `${label} must be non-empty and at most 5 MiB`);
  const source = await readFile(path, "utf8");
  const match = source.match(/viewBox\s*=\s*["']\s*[-+\d.]+\s+[-+\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  assert.ok(match, `${label} SVG must define a numeric viewBox`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  assert.equal(width, height, `${label} must be square`);
  assert.ok(width >= 48 && width <= 4096, `${label} must be 48-4096 pixels in viewBox dimensions`);
}
await validateSquareSvg(ui.logo, "interface.logo");
await validateSquareSvg(ui.composerIcon, "interface.composerIcon");

let entryCount = 0;
let totalBytes = 0;
async function scanTree(directory, depth = 0) {
  assert.ok(depth <= 20, "plugin package path depth exceeds 20 segments");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    entryCount += 1;
    assert.ok(entryCount <= 5000, "plugin package contains more than 5000 entries");
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    assert.ok(!info.isSymbolicLink(), `plugin package contains a symbolic link: ${relative(pluginRoot, path)}`);
    if (info.isDirectory()) await scanTree(path, depth + 1);
    else {
      assert.ok(info.isFile(), `plugin package contains an unsupported filesystem entry: ${relative(pluginRoot, path)}`);
      assert.ok(info.size <= 100 * 1024 * 1024, `plugin package file exceeds 100 MiB: ${relative(pluginRoot, path)}`);
      totalBytes += info.size;
      assert.ok(totalBytes <= 512 * 1024 * 1024, "plugin package exceeds 512 MiB uncompressed");
    }
  }
}
await scanTree(pluginRoot);

console.log(
  `Plugin package checks passed for ${pluginRoot}: ${entryCount} entries, ${totalBytes} bytes, MCP connection ${expectedAppId}.`,
);
