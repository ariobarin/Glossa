const RESET_DELAY = 1600;

export function chooseActiveSection(sections, threshold = 140) {
  return sections.find((section) => section.visible)?.id
    ?? [...sections].reverse().find((section) => section.top <= threshold)?.id
    ?? null;
}

function resetAfter(callback) {
  window.setTimeout(callback, RESET_DELAY);
}

async function writeClipboard(text) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard is unavailable");
  }
  await navigator.clipboard.writeText(text);
}

function selectText(target) {
  const selection = window.getSelection();
  if (!selection) return false;

  try {
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

function initCodeCopy() {
  document.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-copy-target]");
    if (!button) return;

    const target = document.getElementById(button.dataset.copyTarget);
    const tooltip = button.querySelector(".copy-tooltip");
    if (!target || !tooltip) return;

    const originalLabel = button.getAttribute("aria-label") ?? "Copy code";
    let nextLabel = "Copied";

    try {
      await writeClipboard(target.textContent.trim());
      button.dataset.state = "copied";
    } catch {
      nextLabel = selectText(target) ? "Selected" : "Copy failed";
    }

    button.setAttribute(
      "aria-label",
      nextLabel === "Selected" ? "Code selected" : nextLabel,
    );
    tooltip.textContent = nextLabel;

    resetAfter(() => {
      button.setAttribute("aria-label", originalLabel);
      tooltip.textContent = "Copy";
      delete button.dataset.state;
    });
  });
}

function initPageCopy() {
  const button = document.querySelector("[data-copy-page]");
  const source = document.querySelector("[data-page-markdown]");
  if (!button || !source) return;

  let markdown;
  try {
    markdown = JSON.parse(source.textContent ?? "");
  } catch {
    return;
  }
  if (typeof markdown !== "string") return;

  button.addEventListener("click", async () => {
    const originalLabel = button.textContent;
    try {
      await writeClipboard(markdown);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }

    resetAfter(() => {
      button.textContent = originalLabel;
    });
  });
}

function initSectionNavigation() {
  const links = [...document.querySelectorAll(".docs-toc a[href^='#']")];
  const headings = links
    .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
    .filter(Boolean);
  if (links.length === 0 || headings.length === 0) return;

  const setActive = (heading) => {
    for (const link of links) {
      const active = decodeURIComponent(link.hash.slice(1)) === heading.id;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };

  setActive(
    headings.find((heading) => heading.id === window.location.hash.slice(1))
      ?? headings[0],
  );
  for (const link of links) {
    link.addEventListener("click", () => {
      const heading = document.getElementById(
        decodeURIComponent(link.hash.slice(1)),
      );
      if (heading) setActive(heading);
    });
  }

  if (!("IntersectionObserver" in window)) return;
  const visibleHeadings = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleHeadings.add(entry.target);
      else visibleHeadings.delete(entry.target);
    }

    const activeId = chooseActiveSection(headings.map((heading) => ({
      id: heading.id,
      top: heading.getBoundingClientRect().top,
      visible: visibleHeadings.has(heading),
    })));
    const active = headings.find((heading) => heading.id === activeId);
    if (active) setActive(active);
  }, {
    rootMargin: "-120px 0px -15% 0px",
    threshold: [0, 1],
  });

  for (const heading of headings) observer.observe(heading);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  for (const initialize of [
    initCodeCopy,
    initPageCopy,
    initSectionNavigation,
  ]) {
    try {
      initialize();
    } catch {
      continue;
    }
  }
}
