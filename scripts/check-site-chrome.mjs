import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chooseActiveSection } from "../site/copy.js";
import { PAGE_REGISTRY } from "./build-docs.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDirectory = join(repositoryRoot, "site");
const generatedPages = new Set(PAGE_REGISTRY.map((page) => page.output));

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findHtmlFiles(path));
    } else if (extname(entry.name) === ".html") {
      files.push(path);
    }
  }

  return files.sort();
}

function sitePath(path) {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

function readChrome(html, tag, className, path) {
  const expression = new RegExp(`<${tag} class="${className}">[\\s\\S]*?</${tag}>`);
  const match = html.match(expression);

  if (!match) {
    throw new Error(`${sitePath(path)} needs a ${className}`);
  }

  return match[0].replaceAll(/\s+/g, " ").trim();
}

function requireAll(source, values, label) {
  const missing = values.filter((value) => !source.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} is missing: ${missing.join(", ")}`);
  }
}

const pages = await Promise.all((await findHtmlFiles(siteDirectory)).map(
  async (path) => ({
    path,
    name: sitePath(path),
    html: await readFile(path, "utf8"),
  }),
));
const pagesByName = new Map(pages.map((page) => [page.name, page]));
const landingPage = pagesByName.get("site/index.html");
if (!landingPage) throw new Error("Site needs site/index.html");

const expectedHeader = readChrome(
  landingPage.html,
  "header",
  "site-header page-width",
  landingPage.path,
);
const expectedFooter = readChrome(
  landingPage.html,
  "footer",
  "site-footer",
  landingPage.path,
);
const inconsistentPages = new Set();

for (const page of pages) {
  const header = readChrome(page.html, "header", "site-header page-width", page.path);
  const footer = readChrome(page.html, "footer", "site-footer", page.path);

  if (header !== expectedHeader || footer !== expectedFooter) {
    inconsistentPages.add(page.name);
  }

  if (generatedPages.has(page.name)) {
    requireAll(page.html, [
      '<body class="docs-shell">',
      '<div class="docs-page">',
      '<nav class="docs-sidebar" aria-label="Documentation">',
    ], page.name);
    if (!/<script type="module" src="\/copy\.js(?:\?[^"]*)?"><\/script>/.test(page.html)) {
      throw new Error(`${page.name} must load the site interactions`);
    }
  }
}

const missingGeneratedPages = [...generatedPages].filter(
  (pageName) => !pagesByName.has(pageName),
);
if (missingGeneratedPages.length > 0) {
  throw new Error(`Generated pages are missing: ${missingGeneratedPages.join(", ")}`);
}

if (inconsistentPages.size > 0) {
  throw new Error(`Site chrome differs in: ${[...inconsistentPages].join(", ")}`);
}

const styles = await readFile(join(siteDirectory, "styles.css"), "utf8");
if (styles.includes(".docs-shell .site-header")) {
  throw new Error("Docs must use the landing header geometry without overrides");
}

const interactions = await readFile(join(siteDirectory, "copy.js"), "utf8");
assert.ok(
  interactions.includes("await writeClipboard(markdown)"),
  "page copy writes the embedded Markdown source",
);
assert.ok(
  !interactions.includes("await writeClipboard(window.location.href)"),
  "page copy does not write the page URL",
);
assert.equal(chooseActiveSection([
  { id: "before", top: -1800, visible: false },
  { id: "install", top: -900, visible: false },
  { id: "connect", top: -80, visible: false },
  { id: "verify", top: 760, visible: false },
]), "connect", "a large scroll jump selects the latest passed section");
assert.equal(chooseActiveSection([
  { id: "before", top: -120, visible: false },
  { id: "install", top: 420, visible: true },
]), "install", "an observed section takes precedence");

const quickstart = pagesByName.get("site/docs/quickstart.html")?.html ?? "";
requireAll(quickstart, [
  '<div class="docs-layout has-toc">',
  '<nav class="docs-sidebar" aria-label="Documentation">',
  '<nav class="docs-toc" aria-label="On this page">',
  'data-copy-page',
  'data-page-markdown',
  'class="heading-anchor"',
  '<h1>Connect ChatGPT to a local workspace</h1>',
  '<h2 id="1-install"><a class="heading-anchor"',
  '<h2 id="2-start-a-workspace"><a class="heading-anchor"',
  '<h2 id="3-add-glossa-to-chatgpt"><a class="heading-anchor"',
  '<h2 id="4-test-it"><a class="heading-anchor"',
  'npm install --global @ariobarin/glossa',
  'https://mcp.glossa.sh/mcp',
  '<strong>Scan Tools</strong>',
  'Use Glossa to list my connected workspaces and report each access profile.',
  'unsandboxed',
  'href="/security"',
  'Review security',
  "data-copy-target=",
], "site/docs/quickstart.html");
for (const unnecessary of [
  'data-docs-tabs',
  'Direct installer',
  'glossa --version',
  'glossa update',
  'glossa --access read-only',
  'glossa --access system',
  'Press Ctrl+C',
  'Review requested writes and commands carefully.',
]) {
  assert.ok(
    !quickstart.includes(unnecessary),
    `quickstart omits ${unnecessary}`,
  );
}

const generator = await readFile(
  join(repositoryRoot, "scripts", "build-docs.mjs"),
  "utf8",
);
const renderedHtmlTransforms = [
  ["legacy copy wrapper", "addCopyButtons"],
  ["legacy heading wrapper", "addHeadingIds"],
  ["heading HTML matching", "matchAll(/<h2"],
  ["heading HTML replacement", ".replace(/<h"],
  ["code HTML replacement", ".replace(/<pre"],
];
for (const [label, forbidden] of renderedHtmlTransforms) {
  if (generator.includes(forbidden)) {
    throw new Error(`Generator still uses ${label}`);
  }
}

const vercel = JSON.parse(
  await readFile(join(siteDirectory, "vercel.json"), "utf8"),
);
const getStarted = vercel.redirects?.find(
  (redirect) => redirect.source === "/get-started",
);
if (
  getStarted?.destination !== "/docs/quickstart"
  || getStarted.permanent !== true
) {
  throw new Error("/get-started must redirect permanently to /docs/quickstart");
}

const textToCheck = [
  ...pages.map((page) => page.html),
  styles,
  interactions,
  generator,
].join("\n");
if (/[\u2013\u2014]/u.test(textToCheck)) {
  throw new Error("Site source contains an en dash or em dash");
}

console.log(
  `Checked shared chrome, routes, rendering, and interactions across ${pages.length} pages.`,
);
