import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { marked } from "marked";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDirectory = join(repositoryRoot, "site", "docs");
const pagesDirectory = join(repositoryRoot, "site", "pages");
const checkOnly = process.argv.includes("--check");

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function findMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findMarkdownFiles(path));
    } else if (extname(entry.name) === ".md") {
      files.push(path);
    }
  }

  return files.sort();
}

function readPage(source, sourcePath) {
  const lines = source.replaceAll("\r\n", "\n").trim().split("\n");
  const titleLine = lines.findIndex((line) => line.startsWith("# "));
  if (titleLine === -1) {
    throw new Error(`${sourcePath} needs a level-one heading`);
  }

  const summaryLine = lines.findIndex(
    (line, index) => index > titleLine && line.trim() !== "",
  );
  if (summaryLine === -1 || lines[summaryLine].startsWith("#")) {
    throw new Error(`${sourcePath} needs a summary after its title`);
  }

  return {
    title: lines[titleLine].slice(2).trim(),
    summary: lines[summaryLine].trim(),
    body: lines.filter((_, index) => index !== titleLine && index !== summaryLine).join("\n").trim(),
  };
}

function addCopyButtons(html, slug) {
  let index = 0;

  return html.replace(
    /<pre><code(?: class="([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_, className, code) => {
      index += 1;
      const id = `${slug.replaceAll("/", "-")}-code-${index}`;
      const classAttribute = className ? ` class="${escapeHtml(className)}"` : "";
      return `<div class="code-block">
  <button class="copy-button" type="button" data-copy-target="${id}" aria-label="Copy code">
    <span class="copy-tooltip" aria-hidden="true">Copy</span>
  </button>
  <pre><code${classAttribute} id="${id}">${code}</code></pre>
</div>`;
    },
  );
}

function slugifyHeading(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function addHeadingIds(html) {
  const usedIds = new Map();

  return html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, level, content) => {
    const baseId = slugifyHeading(content) || "section";
    const count = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, count + 1);
    const id = count === 0 ? baseId : `${baseId}-${count + 1}`;
    return `<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(content.replace(/<[^>]+>/g, ""))}"></a>${content}</h${level}>`;
  });
}

function groupSections(html) {
  const parts = html.split(/(?=<h2 id=")/);
  return parts.map((part) => (
    part.startsWith("<h2") ? `<section class="doc-section">\n${part}</section>` : part
  )).join("");
}

function renderSectionNavigation(html) {
  const headings = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
  if (headings.length < 2) return "";

  const links = headings.map(([, id, label]) => (
    `          <li><a href="#${id}">${label.replace(/<[^>]+>/g, "")}</a></li>`
  )).join("\n");

  return `      <nav class="docs-toc" aria-label="On this page">
        <strong>On this page</strong>
        <ol>
${links}
        </ol>
      </nav>`;
}

function renderDocsSidebar(route) {
  const groups = [
    {
      title: "Getting started",
      links: [{ route: "docs/quickstart", href: "/docs/quickstart", label: "Quickstart" }],
    },
    {
      title: "Learn",
      links: [{ route: "docs/why", href: "/docs/why", label: "Why Glossa" }],
    },
    {
      title: "Safety",
      links: [
        { route: "security", href: "/security", label: "Security overview" },
        { route: "docs/security", href: "/docs/security", label: "Technical security" },
        { route: "privacy", href: "/privacy", label: "Privacy" },
      ],
    },
    {
      title: "Help",
      links: [{ route: "support", href: "/support", label: "Support" }],
    },
    {
      title: "Legal",
      links: [{ route: "terms", href: "/terms", label: "Terms" }],
    },
  ];

  const contents = groups.map(({ title, links }) => {
    const items = links.map(({ route: linkRoute, href, label }) => {
      const current = route === linkRoute;
      return `          <li><a${current ? " class=\"is-current\" aria-current=\"page\"" : ""} href="${href}">${label}</a></li>`;
    }).join("\n");
    return `        <section>
          <h2>${title}</h2>
          <ul>
${items}
          </ul>
        </section>`;
  }).join("\n");

  return `      <nav class="docs-sidebar" aria-label="Documentation">
${contents}
      </nav>`;
}

function renderPage(page, route, sourceLabel) {
  const renderedTitle = escapeHtml(page.title);
  const sectionLabel = {
    "docs/quickstart": "Getting started",
    "docs/why": "Learn",
    "docs/security": "Safety",
    security: "Safety",
    privacy: "Safety",
    support: "Help",
    terms: "Legal",
  }[route] ?? "Documentation";
  const tabTitle = route
    .split("/")
    .at(-1)
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const renderedBody = addHeadingIds(
    addCopyButtons(marked.parse(page.body, { gfm: true }), route),
  );
  const body = groupSections(renderedBody);
  const sectionNavigation = renderSectionNavigation(renderedBody);
  const sidebar = renderDocsSidebar(route);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(page.summary)}" />
    <meta name="theme-color" content="#111016" />
    <title>${escapeHtml(tabTitle)} | Glossa</title>
    <link rel="icon" href="/glossa-symbol.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles.css?v=39" />
    <script src="/copy.js?v=4" defer></script>
  </head>
  <body class="docs-shell">
    <!-- Generated from ${sourceLabel}. Run npm run docs:build after editing Markdown. -->
    <header class="site-header page-width">
      <a class="brand" href="/" aria-label="Glossa home">
        <img class="brand-symbol" src="/glossa-symbol.svg" alt="" />
        <span>Glossa</span>
      </a>
      <nav class="header-links" aria-label="Site navigation">
        <a href="/docs/quickstart">Quickstart</a>
        <a href="/security">Security</a>
        <a href="/support">Support</a>
        <a href="https://github.com/ariobarin/glossa">GitHub</a>
      </nav>
    </header>

    <main class="docs-main">
      <div class="docs-layout${sectionNavigation ? " has-toc" : ""}">
${sidebar}
      <div class="docs-page">
      <header class="docs-intro">
        <div class="docs-kicker">${sectionLabel}</div>
        <div class="docs-title-row">
          <h1>${renderedTitle}</h1>
          <button class="copy-page-button" type="button" data-copy-page aria-label="Copy page link">Copy page</button>
        </div>
        <p class="docs-summary">${marked.parseInline(page.summary)}</p>
      </header>

      <article class="docs-content">
${body}
      </article>
      </div>

${sectionNavigation}
      </div>
    </main>

    <footer class="site-footer">
      <div class="site-footer-inner page-width">
        <span>Need help? <a href="/support">Visit support.</a></span>
        <nav aria-label="Legal and support">
          <a href="/security">Security</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/support">Support</a>
        </nav>
      </div>
    </footer>
  </body>
</html>
`;
}

const markdownPages = (await findMarkdownFiles(docsDirectory)).map((sourcePath) => ({
  sourcePath,
  route: `docs/${relative(docsDirectory, sourcePath).replaceAll("\\", "/").slice(0, -3)}`,
  outputPath: sourcePath.slice(0, -3) + ".html",
}));

markdownPages.push({
  sourcePath: join(repositoryRoot, "docs", "security.md"),
  route: "docs/security",
  outputPath: join(docsDirectory, "security.html"),
});

for (const sourcePath of await findMarkdownFiles(pagesDirectory)) {
  const route = relative(pagesDirectory, sourcePath).replaceAll("\\", "/").slice(0, -3);
  markdownPages.push({
    sourcePath,
    route,
    outputPath: join(repositoryRoot, "site", `${route}.html`),
  });
}

const stalePages = [];

for (const { sourcePath, route, outputPath } of markdownPages) {
  const source = await readFile(sourcePath, "utf8");
  const page = readPage(source, sourcePath);
  const sourceLabel = relative(repositoryRoot, sourcePath).replaceAll("\\", "/");
  const output = renderPage(page, route, sourceLabel);

  if (checkOnly) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current.replaceAll("\r\n", "\n") !== output) {
      stalePages.push(relative(repositoryRoot, sourcePath).replaceAll("\\", "/"));
    }
  } else {
    await writeFile(outputPath, output, "utf8");
  }
}

if (stalePages.length > 0) {
  throw new Error(`Generated docs are stale: ${stalePages.join(", ")}. Run npm run docs:build.`);
}

console.log(`${checkOnly ? "Checked" : "Built"} ${markdownPages.length} documentation page${markdownPages.length === 1 ? "" : "s"}.`);
