import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Marked, Parser } from "marked";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

export const PAGE_GROUPS = [
  {
    label: "Getting started",
    pages: [
      {
        source: "site/docs/quickstart.md",
        output: "site/docs/quickstart.html",
        route: "/docs/quickstart",
        tabTitle: "Quickstart",
        navLabel: "Quickstart",
      },
    ],
  },
  {
    label: "Learn",
    pages: [
      {
        source: "site/docs/why.md",
        output: "site/docs/why.html",
        route: "/docs/why",
        tabTitle: "Why",
        navLabel: "Why Glossa",
        copyPage: false,
      },
    ],
  },
  {
    label: "Safety",
    pages: [
      {
        source: "site/pages/security.md",
        output: "site/security.html",
        route: "/security",
        tabTitle: "Security",
        navLabel: "Security overview",
      },
      {
        source: "docs/security.md",
        output: "site/docs/security.html",
        route: "/docs/security",
        tabTitle: "Security",
        navLabel: "Technical security",
      },
      {
        source: "site/pages/privacy.md",
        output: "site/privacy.html",
        route: "/privacy",
        tabTitle: "Privacy",
        navLabel: "Privacy",
      },
    ],
  },
  {
    label: "Help",
    pages: [
      {
        source: "site/pages/support.md",
        output: "site/support.html",
        route: "/support",
        tabTitle: "Support",
        navLabel: "Support",
      },
    ],
  },
  {
    label: "Legal",
    pages: [
      {
        source: "site/pages/terms.md",
        output: "site/terms.html",
        route: "/terms",
        tabTitle: "Terms",
        navLabel: "Terms",
      },
    ],
  },
];

export const PAGE_REGISTRY = PAGE_GROUPS.flatMap((group) => group.pages.map((page) => ({
  ...page,
  group: group.label,
  sourcePath: join(repositoryRoot, page.source),
  outputPath: join(repositoryRoot, page.output),
})));

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plainText(tokens) {
  return tokens.map((token) => {
    if (Array.isArray(token.tokens)) return plainText(token.tokens);
    if (typeof token.text === "string") return token.text;
    return "";
  }).join("");
}

function slugifyHeading(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseDirectiveOptions(line, directive, sourceLabel) {
  const prefix = `:::${directive} `;
  if (!line.startsWith(prefix)) {
    throw new Error(`${sourceLabel} has an invalid ${directive} directive`);
  }

  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    throw new Error(`${sourceLabel} has invalid JSON in a ${directive} directive`);
  }
}

function findDirectiveEnd(lines, sourceLabel) {
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(":::docs-tabs ")) depth += 1;
    if (lines[index] === ":::docs-tabs-end") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`${sourceLabel} has an unclosed docs-tabs directive`);
}

function parseDirectiveTabs(lines, lexer, sourceLabel) {
  const tabs = [];
  let index = 0;

  while (index < lines.length) {
    while (lines[index]?.trim() === "") index += 1;
    if (index >= lines.length) break;

    const options = parseDirectiveOptions(lines[index], "docs-tab", sourceLabel);
    const contentStart = index + 1;
    let nestedTabs = 0;
    let contentEnd = -1;

    for (index = contentStart; index < lines.length; index += 1) {
      if (lines[index].startsWith(":::docs-tabs ")) nestedTabs += 1;
      if (lines[index] === ":::docs-tabs-end") nestedTabs -= 1;
      if (lines[index] === ":::docs-tab-end" && nestedTabs === 0) {
        contentEnd = index;
        break;
      }
    }

    if (contentEnd === -1) {
      throw new Error(`${sourceLabel} has an unclosed docs-tab directive`);
    }

    if (!options.value || !options.label) {
      throw new Error(`${sourceLabel} docs-tab directives need value and label`);
    }

    const markdown = lines.slice(contentStart, contentEnd).join("\n").trim();
    tabs.push({
      ...options,
      tokens: lexer.blockTokens(markdown ? `${markdown}\n` : ""),
    });
    index = contentEnd + 1;
  }

  if (tabs.length < 2) {
    throw new Error(`${sourceLabel} docs-tabs directives need at least two tabs`);
  }

  if (tabs.filter((tab) => tab.selected).length > 1) {
    throw new Error(`${sourceLabel} docs-tabs directives can select only one tab`);
  }

  if (!tabs.some((tab) => tab.selected)) tabs[0].selected = true;
  return tabs;
}

function createDocsTabsExtension(sourceLabel) {
  return {
    name: "docsTabs",
    level: "block",
    start(source) {
      const index = source.indexOf(":::docs-tabs ");
      return index === -1 ? undefined : index;
    },
    tokenizer(source) {
      if (!source.startsWith(":::docs-tabs ")) return undefined;

      const lines = source.split("\n");
      const end = findDirectiveEnd(lines, sourceLabel);
      const raw = lines.slice(0, end + 1).join("\n")
        + (end < lines.length - 1 ? "\n" : "");
      const options = parseDirectiveOptions(lines[0], "docs-tabs", sourceLabel);
      const tabs = parseDirectiveTabs(
        lines.slice(1, end),
        this.lexer,
        sourceLabel,
      );

      if (!options.id || !options.storage || !options.label || !options.ariaLabel) {
        throw new Error(
          `${sourceLabel} docs-tabs directives need id, storage, label, and ariaLabel`,
        );
      }

      return {
        type: "docsTabs",
        raw,
        options,
        tabs,
      };
    },
    renderer(token) {
      const { options, tabs } = token;
      const containerClass = options.nested
        ? "docs-switcher docs-switcher-nested"
        : "docs-switcher";
      const tabsClass = options.wide ? "docs-tabs docs-tabs-wide" : "docs-tabs";
      const buttons = tabs.map((tab) => {
        const tabId = `${options.id}-${tab.value}-tab`;
        const panelId = `${options.id}-${tab.value}`;
        return `    <button id="${escapeHtml(tabId)}" type="button" role="tab" aria-selected="${tab.selected ? "true" : "false"}" aria-controls="${escapeHtml(panelId)}" data-docs-tab="${escapeHtml(tab.value)}"${tab.selected ? "" : " tabindex=\"-1\""}>${escapeHtml(tab.label)}</button>`;
      }).join("\n");
      const panels = tabs.map((tab) => {
        const tabId = `${options.id}-${tab.value}-tab`;
        const panelId = `${options.id}-${tab.value}`;
        return `  <div id="${escapeHtml(panelId)}" class="docs-tab-panel" role="tabpanel" aria-labelledby="${escapeHtml(tabId)}" data-docs-tab-panel="${escapeHtml(tab.value)}"${tab.selected ? "" : " hidden"}>
${this.parser.parse(tab.tokens).trimEnd()}
  </div>`;
      }).join("\n");
      const paramAttribute = options.param
        ? ` data-tabs-param="${escapeHtml(options.param)}"`
        : "";

      return `<div class="${containerClass}" data-docs-tabs data-tabs-storage="${escapeHtml(options.storage)}"${paramAttribute}>
  <p class="docs-switcher-label">${escapeHtml(options.label)}</p>
  <div class="${tabsClass}" role="tablist" aria-label="${escapeHtml(options.ariaLabel)}">
${buttons}
  </div>
${panels}
</div>
`;
    },
  };
}

function createMarkdown(sourceLabel, route) {
  const headingIds = new Map();
  let codeIndex = 0;
  const markdown = new Marked();

  markdown.use({
    gfm: true,
    extensions: [createDocsTabsExtension(sourceLabel)],
    renderer: {
      heading(token) {
        const content = this.parser.parseInline(token.tokens);
        if (token.depth !== 2 && token.depth !== 3) {
          return `<h${token.depth}>${content}</h${token.depth}>\n`;
        }

        const label = plainText(token.tokens);
        const baseId = slugifyHeading(label) || "section";
        const count = headingIds.get(baseId) ?? 0;
        headingIds.set(baseId, count + 1);
        token.docId = count === 0 ? baseId : `${baseId}-${count + 1}`;
        token.docLabel = label;
        return `<h${token.depth} id="${token.docId}"><a class="heading-anchor" href="#${token.docId}" aria-label="Link to ${escapeHtml(label)}"></a>${content}</h${token.depth}>\n`;
      },
      code(token) {
        codeIndex += 1;
        const id = `${route.slice(1).replaceAll("/", "-")}-code-${codeIndex}`;
        const language = token.lang?.match(/^\S*/)?.[0];
        const classAttribute = language
          ? ` class="language-${escapeHtml(language)}"`
          : "";
        const code = escapeHtml(token.text.replace(/\n$/, ""));
        return `<div class="code-block">
  <button class="copy-button" type="button" data-copy-target="${id}" aria-label="Copy code">
    <span class="copy-tooltip" aria-hidden="true">Copy</span>
  </button>
  <pre><code${classAttribute} id="${id}">${code}</code></pre>
</div>
`;
      },
    },
  });

  return markdown;
}

function readPage(source, sourceLabel, route) {
  const markdown = createMarkdown(sourceLabel, route);
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const tokens = markdown.lexer(normalizedSource.trim());
  const titleIndex = tokens.findIndex(
    (token) => token.type === "heading" && token.depth === 1,
  );
  if (titleIndex === -1) {
    throw new Error(`${sourceLabel} needs a level-one heading`);
  }

  const summaryIndex = tokens.findIndex(
    (token, index) => index > titleIndex && token.type !== "space",
  );
  if (summaryIndex === -1 || tokens[summaryIndex].type !== "paragraph") {
    throw new Error(`${sourceLabel} needs a summary after its title`);
  }

  const titleToken = tokens[titleIndex];
  const summaryToken = tokens[summaryIndex];
  return {
    markdown,
    source: normalizedSource,
    title: plainText(titleToken.tokens),
    summary: plainText(summaryToken.tokens),
    summaryHtml: Parser.parseInline(summaryToken.tokens),
    bodyTokens: tokens.filter(
      (_, index) => index !== titleIndex && index !== summaryIndex,
    ),
  };
}

function renderBody(markdown, tokens) {
  const sections = [];
  let current = [];

  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 2 && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(token);
  }
  if (current.length > 0) sections.push(current);

  return sections.map((section) => {
    const html = markdown.parser(section).trim();
    const startsWithSection = section[0]?.type === "heading"
      && section[0].depth === 2;
    return startsWithSection
      ? `<section class="doc-section">\n${html}\n</section>`
      : html;
  }).join("\n");
}

function renderSectionNavigation(tokens) {
  const headings = tokens.filter(
    (token) => token.type === "heading" && token.depth === 2,
  );
  if (headings.length < 2) return "";

  const links = headings.map((heading) => (
    `          <li><a href="#${heading.docId}">${escapeHtml(heading.docLabel)}</a></li>`
  )).join("\n");

  return `      <nav class="docs-toc" aria-label="On this page">
        <strong>On this page</strong>
        <ol>
${links}
        </ol>
      </nav>`;
}

function renderDocsSidebar(currentRoute) {
  const groups = PAGE_GROUPS.map((group) => {
    const links = group.pages.map((page) => {
      const current = page.route === currentRoute;
      return `          <li><a${current ? " class=\"is-current\" aria-current=\"page\"" : ""} href="${page.route}">${escapeHtml(page.navLabel)}</a></li>`;
    }).join("\n");

    return `        <section>
          <h2>${escapeHtml(group.label)}</h2>
          <ul>
${links}
          </ul>
        </section>`;
  }).join("\n");

  return `      <nav class="docs-sidebar" aria-label="Documentation">
${groups}
      </nav>`;
}

function renderPage(pageConfig, page) {
  const body = renderBody(page.markdown, page.bodyTokens);
  const sectionNavigation = renderSectionNavigation(page.bodyTokens);
  const sidebar = renderDocsSidebar(pageConfig.route);
  const serializedSource = JSON.stringify(page.source).replaceAll("<", "\\u003c");
  const copyPageButton = pageConfig.copyPage === false
    ? ""
    : `          <button class="copy-page-button" type="button" data-copy-page aria-label="Copy page">Copy</button>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(page.summary)}" />
    <meta name="theme-color" content="#111016" />
    <title>${escapeHtml(pageConfig.tabTitle)} | Glossa</title>
    <link rel="icon" href="/glossa-symbol.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles.css?v=39" />
    <script type="module" src="/copy.js?v=7"></script>
  </head>
  <body class="docs-shell">
    <!-- Generated from ${pageConfig.source}. Run npm run docs:build after editing Markdown. -->
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
        <div class="docs-kicker">${escapeHtml(pageConfig.group)}</div>
        <div class="docs-title-row">
          <h1>${escapeHtml(page.title)}</h1>
${copyPageButton}
        </div>
        <script type="application/json" data-page-markdown>${serializedSource}</script>
        <p class="docs-summary">${page.summaryHtml}</p>
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

async function buildDocs() {
  const stalePages = [];

  for (const pageConfig of PAGE_REGISTRY) {
    const source = await readFile(pageConfig.sourcePath, "utf8");
    const page = readPage(source, pageConfig.source, pageConfig.route);
    const output = renderPage(pageConfig, page);

    if (checkOnly) {
      const current = await readFile(pageConfig.outputPath, "utf8").catch(() => "");
      if (current.replaceAll("\r\n", "\n") !== output) {
        stalePages.push(pageConfig.source);
      }
    } else {
      await writeFile(pageConfig.outputPath, output, "utf8");
    }
  }

  if (stalePages.length > 0) {
    throw new Error(`Generated docs are stale: ${stalePages.join(", ")}. Run npm run docs:build.`);
  }

  console.log(`${checkOnly ? "Checked" : "Built"} ${PAGE_REGISTRY.length} documentation pages.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDocs();
}
