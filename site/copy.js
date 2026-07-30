const RESET_DELAY = 1600;

export function chooseActiveSection(sections, threshold = 140) {
  return sections.find((section) => section.visible)?.id
    ?? [...sections].reverse().find((section) => section.top <= threshold)?.id
    ?? null;
}

export function tabSelectionUrl(href, param, value, hiddenHashTarget) {
  const url = new URL(href);
  url.searchParams.set(param, value);
  if (hiddenHashTarget) url.hash = "";
  return url;
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

function readStorage(key) {
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  if (!key) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function readUrlValue(controller) {
  const params = new URLSearchParams(window.location.search);
  const queryValue = controller.param ? params.get(controller.param) : null;
  if (controller.values.includes(queryValue)) return queryValue;

  let hashId;
  try {
    hashId = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return null;
  }
  if (!hashId) return null;
  const hashTarget = document.getElementById(hashId);
  const panel = controller.panels.find((candidate) => (
    candidate.id === hashId || (hashTarget && candidate.contains(hashTarget))
  ));
  return panel?.dataset.docsTabPanel ?? null;
}

function writeUrlValue(controller, value) {
  if (!controller.param || !window.history?.replaceState) return;

  try {
    const currentUrl = new URL(window.location.href);
    let hashId = "";
    try {
      hashId = decodeURIComponent(currentUrl.hash.slice(1));
    } catch {
      hashId = "";
    }
    const hashTarget = hashId ? document.getElementById(hashId) : null;
    const url = tabSelectionUrl(
      currentUrl,
      controller.param,
      value,
      Boolean(hashTarget?.closest("[hidden]")),
    );
    window.history.replaceState(window.history.state, "", url);
  } catch {
    return;
  }
}

function applyTabSelection(controller, value) {
  if (!controller.values.includes(value)) return false;

  for (const tab of controller.tabs) {
    const selected = tab.dataset.docsTab === value;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  for (const panel of controller.panels) {
    panel.hidden = panel.dataset.docsTabPanel !== value;
  }

  return true;
}

function initDocsTabs() {
  const controllers = [...document.querySelectorAll("[data-docs-tabs]")]
    .map((tabSet) => {
      const tabList = tabSet.querySelector(":scope > .docs-tabs");
      const tabs = [...(tabList?.querySelectorAll("[data-docs-tab]") ?? [])];
      const panels = [
        ...tabSet.querySelectorAll(":scope > [data-docs-tab-panel]"),
      ];
      return {
        tabs,
        panels,
        values: tabs.map((tab) => tab.dataset.docsTab),
        storageKey: tabSet.dataset.tabsStorage,
        param: tabSet.dataset.tabsParam,
      };
    })
    .filter((controller) => (
      controller.tabs.length > 0 && controller.panels.length > 0
    ));

  const select = (controller, value, options = {}) => {
    const { focus = false, persist = true, updateUrl = false } = options;
    if (!applyTabSelection(controller, value)) return;
    if (persist) writeStorage(controller.storageKey, value);
    if (updateUrl) writeUrlValue(controller, value);

    for (const peer of controllers) {
      if (
        peer !== controller
        && peer.storageKey === controller.storageKey
        && peer.values.includes(value)
      ) {
        applyTabSelection(peer, value);
      }
    }

    if (focus) {
      controller.tabs.find((tab) => tab.dataset.docsTab === value)?.focus();
    }
  };

  const applyInitialSelections = () => {
    for (const controller of controllers) {
      const selectedTab = controller.tabs.find(
        (tab) => tab.getAttribute("aria-selected") === "true",
      );
      const urlValue = readUrlValue(controller);
      const storedValue = readStorage(controller.storageKey);
      const initialValue = urlValue
        ?? (controller.values.includes(storedValue) ? storedValue : null)
        ?? selectedTab?.dataset.docsTab
        ?? controller.values[0];
      select(controller, initialValue, { persist: false });
    }
  };

  for (const controller of controllers) {
    for (const tab of controller.tabs) {
      tab.addEventListener("click", () => {
        select(controller, tab.dataset.docsTab, { updateUrl: true });
      });
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          return;
        }
        event.preventDefault();

        const currentIndex = controller.tabs.indexOf(tab);
        const nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? controller.tabs.length - 1
            : (
              currentIndex
              + (event.key === "ArrowRight" ? 1 : -1)
              + controller.tabs.length
            ) % controller.tabs.length;
        select(
          controller,
          controller.tabs[nextIndex].dataset.docsTab,
          { focus: true, updateUrl: true },
        );
      });
    }
  }

  window.addEventListener("popstate", applyInitialSelections);
  window.addEventListener("hashchange", applyInitialSelections);
  window.addEventListener("storage", (event) => {
    if (!event.key || !event.newValue) return;
    for (const controller of controllers) {
      if (controller.storageKey === event.key) {
        select(controller, event.newValue, { persist: false });
      }
    }
  });
  applyInitialSelections();
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
    initDocsTabs,
    initSectionNavigation,
  ]) {
    try {
      initialize();
    } catch {
      continue;
    }
  }
}
