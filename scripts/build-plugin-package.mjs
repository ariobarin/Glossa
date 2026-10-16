import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

// Builds the directory submission ZIP from plugin/glossa and, when a
// registered ChatGPT connection ID is supplied, a Codex-format package for
// local marketplace testing. Submission ZIPs must not contain .app.json.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "plugin", "glossa");

function option(name, environmentName) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    return value;
  }
  return process.env[environmentName] || undefined;
}

const publisher = option("publisher", "GLOSSA_VERIFIED_PUBLISHER_NAME");
const demoUrl = option("demo-url", "GLOSSA_PLUGIN_DEMO_URL");
const appId = option("app-id", "GLOSSA_PLUGIN_APP_ID");
const outputRoot = resolve(repositoryRoot, option("out", "GLOSSA_PLUGIN_BUILD_DIR") ?? ".plugin-build");

if (appId !== undefined && !/^plugin_asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(appId)) {
  throw new Error("--app-id must be the plugin_asdk_app_... ID from the ChatGPT plugin URL");
}
if (demoUrl !== undefined && !/^https:\/\/[^\s@]+$/.test(demoUrl)) {
  throw new Error("--demo-url must be an HTTPS URL without credentials");
}

const manifest = JSON.parse(await readFile(join(sourceRoot, "plugin.json"), "utf8"));
const openai = manifest.extensions["com.openai"];
if (publisher !== undefined) {
  manifest.author.name = publisher;
  openai.interface.developerName = publisher;
}
if (demoUrl !== undefined) openai.review.demo_recording_url = demoUrl;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile()) files.push(relative(sourceRoot, path).replaceAll("\\", "/"));
    else throw new Error(`Unsupported plugin source entry: ${path}`);
  }
  return files.sort();
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeTree(root, files) {
  await rm(root, { recursive: true, force: true });
  for (const [name, contents] of files) {
    const path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    if (typeof contents === "string") await writeFile(path, contents, "utf8");
    else await copyFile(contents.copyFrom, path);
  }
}

// Minimal deterministic ZIP writer: fixed timestamps, sorted forward-slash
// entry names, and raw deflate, so identical inputs produce identical bytes.
function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

const assetFiles = (await sourceFiles(sourceRoot)).filter((name) => name.startsWith("assets/"));
const submissionFiles = [
  ["mcp.json", await readFile(join(sourceRoot, "mcp.json"), "utf8")],
  ["plugin.json", json(manifest)],
  ...assetFiles.map((name) => [name, { copyFrom: join(sourceRoot, ...name.split("/")) }]),
].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

const submissionRoot = join(outputRoot, "glossa");
await writeTree(submissionRoot, submissionFiles);
const zipPath = join(outputRoot, `glossa-${manifest.version}.zip`);
await writeFile(
  zipPath,
  zip(
    await Promise.all(
      submissionFiles.map(async ([name]) => ({
        name,
        data: await readFile(join(submissionRoot, ...name.split("/"))),
      })),
    ),
  ),
);
console.log(`Submission package: ${relative(repositoryRoot, submissionRoot)}`);
console.log(`Submission ZIP: ${relative(repositoryRoot, zipPath)}`);

if (appId !== undefined) {
  // Local marketplace testing uses the Codex compatibility layout and the
  // connection registered in ChatGPT. Its .app.json uses the asdk_app_ ID.
  const { interface: listing } = openai;
  const localManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords,
    apps: "./.app.json",
    interface: listing,
  };
  const localRoot = join(outputRoot, "local", "glossa");
  await writeTree(localRoot, [
    [".app.json", json({ apps: { glossa: { id: appId.slice("plugin_".length) } } })],
    [".codex-plugin/plugin.json", json(localManifest)],
    ...assetFiles.map((name) => [name, { copyFrom: join(sourceRoot, ...name.split("/")) }]),
  ]);
  console.log(`Local test package: ${relative(repositoryRoot, localRoot)}`);
}
