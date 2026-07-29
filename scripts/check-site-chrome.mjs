import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDirectory = join(repositoryRoot, "site");
const generatedPages = new Set([
  "site/docs/quickstart.html",
  "site/docs/security.html",
  "site/docs/why.html",
  "site/privacy.html",
  "site/security.html",
  "site/support.html",
  "site/terms.html",
]);

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
      '<nav class="docs-sidebar" aria-label="Documentation">',
      '<link rel="stylesheet" href="/styles.css?v=38" />',
      '<script src="/copy.js?v=5" defer></script>',
    ], page.name);
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
requireAll(styles, [
  "--page-width: 1180px",
  "--reading-width: 720px",
  "--sidebar-width: 190px",
  "--toc-width: 180px",
  ".page-width {",
  ".site-header {",
], "site/styles.css");
if (styles.includes(".docs-shell .site-header")) {
  throw new Error("Docs must use the landing header geometry without overrides");
}

const interactions = await readFile(join(siteDirectory, "copy.js"), "utf8");
requireAll(interactions, [
  "function initCodeCopy()",
  "function initPageCopy()",
  "function initDocsTabs()",
  "function initSectionNavigation()",
  "new IntersectionObserver",
  'window.addEventListener("storage"',
  "new URLSearchParams",
], "site/copy.js");
if (
  interactions.includes('addEventListener("scroll"')
  || interactions.includes("requestAnimationFrame")
) {
  throw new Error("Section navigation must use IntersectionObserver");
}

const quickstart = pagesByName.get("site/docs/quickstart.html")?.html ?? "";
requireAll(quickstart, [
  'data-tabs-storage="glossa-install-method-v2" data-tabs-param="install"',
  'data-tabs-storage="glossa-direct-platform-v2" data-tabs-param="platform"',
  'role="tablist" aria-label="Install method"',
  'role="tablist" aria-label="Direct installer platform"',
  'role="tabpanel"',
  "data-copy-target=",
], "site/docs/quickstart.html");

const generator = await readFile(
  join(repositoryRoot, "scripts", "build-docs.mjs"),
  "utf8",
);
requireAll(generator, [
  "const PAGE_GROUPS = [",
  "new Marked()",
  "renderer: {",
  "heading(token)",
  "code(token)",
  "renderSectionNavigation(page.bodyTokens)",
], "scripts/build-docs.mjs");
for (const forbidden of ["addCopyButtons", "addHeadingIds", "matchAll(/<h2"]) {
  if (generator.includes(forbidden)) {
    throw new Error(`Generator still uses rendered HTML transform: ${forbidden}`);
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
