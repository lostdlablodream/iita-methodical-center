import { APP_NAME, MODE_DESCRIPTION, MODE_LABEL } from "./config.js";

export function createElement(tagName, options = {}, children = []) {
  const element = document.createElement(tagName);
  const { className, text, attributes = {} } = options;

  if (className) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = String(text);
  }

  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false || /^on/i.test(name)) {
      continue;
    }
    element.setAttribute(name, value === true ? "" : String(value));
  }

  for (const child of children) {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return element;
}

export function setText(elementOrSelector, value) {
  const element = typeof elementOrSelector === "string"
    ? document.querySelector(elementOrSelector)
    : elementOrSelector;

  if (element) {
    element.textContent = String(value);
  }

  return element;
}

export function clearElement(element) {
  element?.replaceChildren();
  return element;
}

export function renderModeBadge(root = document) {
  root.querySelectorAll("[data-mode-badge]").forEach((badge) => {
    badge.textContent = MODE_LABEL;
    badge.title = MODE_DESCRIPTION;
    badge.setAttribute("aria-label", `${APP_NAME}: ${MODE_LABEL}`);
  });
}

export function setActiveNavigation(currentPage, root = document) {
  root.querySelectorAll("[data-page-link]").forEach((link) => {
    const isCurrent = link.dataset.pageLink === currentPage;
    link.classList.toggle("is-active", isCurrent);
    if (isCurrent) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

export function initializeMobileMenu(root = document) {
  const toggle = root.querySelector("[data-nav-toggle]");
  const navigation = root.querySelector("[data-site-nav]");

  if (!toggle || !navigation || toggle.dataset.menuInitialized === "true") {
    return;
  }

  toggle.dataset.menuInitialized = "true";
  navigation.dataset.open = "false";

  const setOpen = (open, returnFocus = false) => {
    navigation.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    if (returnFocus) {
      toggle.focus();
    }
  };

  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });

  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false, true);
    }
  });

  document.addEventListener("click", (event) => {
    if (toggle.getAttribute("aria-expanded") !== "true") {
      return;
    }
    if (!navigation.contains(event.target) && !toggle.contains(event.target)) {
      setOpen(false);
    }
  });

  const desktopMedia = window.matchMedia("(min-width: 761px)");
  desktopMedia.addEventListener("change", (event) => {
    if (event.matches) {
      setOpen(false);
    }
  });
}

export function initializeShell(root = document) {
  document.documentElement.classList.add("has-js");
  renderModeBadge(root);
  setActiveNavigation(document.body.dataset.page, root);
  initializeMobileMenu(root);
}

function bootShell() {
  initializeShell(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootShell, { once: true });
} else {
  bootShell();
}
