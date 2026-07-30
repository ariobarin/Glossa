import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDirectory = join(repositoryRoot, "site");

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

function readChrome(html, tag, className, path) {
  const expression = new RegExp(`<${tag} class="${className}">[\\s\\S]*?</${tag}>`);
  const match = html.match(expression);

  if (!match) {
    throw new Error(`${relative(repositoryRoot, path)} needs a ${className}`);
  }

  return match[0].replaceAll(/\s+/g, " ").trim();
}

const pages = await Promise.all((await findHtmlFiles(siteDirectory)).map(async (path) => ({
  path,
  html: await readFile(path, "utf8"),
})));

const expectedHeader = readChrome(pages[0].html, "header", "site-header page-width", pages[0].path);
const expectedFooter = readChrome(pages[0].html, "footer", "site-footer", pages[0].path);
const inconsistentPages = [];
const generatedInformationPages = new Set([
  "site/privacy.html",
  "site/security.html",
  "site/support.html",
  "site/terms.html",
]);

for (const page of pages) {
  const header = readChrome(page.html, "header", "site-header page-width", page.path);
  const footer = readChrome(page.html, "footer", "site-footer", page.path);

  if (header !== expectedHeader || footer !== expectedFooter) {
    inconsistentPages.push(relative(repositoryRoot, page.path).replaceAll("\\", "/"));
  }

  const pageName = relative(repositoryRoot, page.path).replaceAll("\\", "/");
  const isGeneratedInformationPage = pageName.startsWith("site/docs/") || generatedInformationPages.has(pageName);
  if (isGeneratedInformationPage && (
    !page.html.includes('<body class="docs-shell">') ||
    !page.html.includes('<div class="docs-page">') ||
    !page.html.includes('<nav class="docs-sidebar" aria-label="Documentation">')
  )) {
    inconsistentPages.push(pageName);
  }
}

if (inconsistentPages.length > 0) {
  throw new Error(`Site chrome differs in: ${inconsistentPages.join(", ")}`);
}

console.log(`Checked shared header and footer across ${pages.length} pages.`);
