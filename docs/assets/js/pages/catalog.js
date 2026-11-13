import { clearElement, createElement } from "../components.js";
import { CONSULTATION_FORMAT, getConsultation, getFormatLabel, isFutureSlot } from "../domain.js";
import { formatCapacity, formatDateTime, formatDuration, formatSlotRange, formatTime, pluralize } from "../format.js";
import { LOCAL_MODE } from "../repository.js";
import { createRepositoryRuntime, getPublicErrorMessage } from "./runtime.js";

const FILTER_NAMES = Object.freeze(["query", "topicId", "instituteId", "mode"]);
const QUERY_DEBOUNCE_MS = 280;
const FILTER_LABELS = Object.freeze({
  query: "Поиск",
  topicId: "Тема",
  instituteId: "Институт",
  mode: "Формат",
});

function cleanParam(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readCatalogLocation(search = "") {
  const parameters = new URLSearchParams(search);
  const queryParameter = parameters.get("query");
  const mode = cleanParam(parameters.get("mode"));
  return {
    filters: {
      query: cleanParam(queryParameter !== null ? queryParameter : parameters.get("q")),
      topicId: cleanParam(parameters.get("topicId")),
      instituteId: cleanParam(parameters.get("instituteId")),
      mode: Object.values(CONSULTATION_FORMAT).includes(mode) ? mode : "",
    },
    consultationId: cleanParam(parameters.get("consultationId")),
  };
}

export function buildCatalogUrl(filters = {}, consultationId = "", base = "./catalog.html") {
  const parameters = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = cleanParam(filters[name]);
    if (value) {
      parameters.set(name, value);
    }
  }
  const selected = cleanParam(consultationId);
  if (selected) {
    parameters.set("consultationId", selected);
  }
  const query = parameters.toString();
  return `${base}${query ? `?${query}` : ""}`;
}

export function createBookingLink(consultationId, slotId = "") {
  const parameters = new URLSearchParams();
  const consultation = cleanParam(consultationId);
  const slot = cleanParam(slotId);
  if (consultation) {
    parameters.set("consultationId", consultation);
  }
  if (slot) {
    parameters.set("slotId", slot);
  }
  const query = parameters.toString();
  return `./booking.html${query ? `?${query}` : ""}`;
}

export function getSlotAvailability(slot, now = new Date()) {
  const capacity = Number.isInteger(slot?.capacity) ? slot.capacity : 0;
  const reserved = Number.isInteger(slot?.reservedCount) ? slot.reservedCount : 0;
  const remainingCount = Number.isInteger(slot?.remainingCount)
    ? Math.max(0, slot.remainingCount)
    : Math.max(0, capacity - reserved);
  const isPast = !isFutureSlot(slot, now);
  const isAvailable = !isPast && slot?.isOpen !== false && remainingCount > 0;
  let reason = "";
  if (isPast) {
    reason = "Время слота прошло";
  } else if (remainingCount === 0) {
    reason = "Свободных мест нет";
  } else if (slot?.isOpen === false) {
    reason = "Запись на слот закрыта";
  }
  return { isAvailable, isPast, remainingCount, reason };
}

function createMeta(label, value) {
  const wrapper = createElement("div");
  wrapper.append(createElement("dt", { text: label }), createElement("dd", { text: value }));
  return wrapper;
}

function createSlotItem(consultation, slot) {
  const availability = getSlotAvailability(slot);
  const item = createElement("li", {
    className: `catalog-slot${availability.isAvailable ? "" : " is-unavailable"}`,
  });
  const details = createElement("div");
  details.append(createElement("time", {
    text: formatSlotRange(slot.startsAt, slot.endsAt),
    attributes: { datetime: slot.startsAt },
  }));
  details.append(createElement("p", {
    text: `${getFormatLabel(slot.mode)} · ${slot.location}`,
  }));
  details.append(createElement("p", {
    text: availability.isAvailable
      ? `Осталось: ${formatCapacity(availability.remainingCount)}`
      : availability.reason,
  }));
  item.append(details);

  if (availability.isAvailable) {
    item.append(createElement("a", {
      className: "button button-primary",
      text: "Выбрать это время",
      attributes: {
        href: createBookingLink(consultation.id, slot.id),
        "aria-label": `Выбрать время: ${consultation.title}, ${formatDateTime(slot.startsAt)}`,
      },
    }));
  } else {
    item.append(createElement("span", {
      className: "slot-unavailable",
      text: `Недоступно: ${availability.reason.toLocaleLowerCase()}`,
    }));
  }
  return item;
}

function createConsultationCard(consultation, topic, highlightedId) {
  const highlighted = consultation.id === highlightedId;
  const card = createElement("article", {
    className: `card consultation-card${highlighted ? " is-highlighted" : ""}`,
    attributes: {
      id: `consultation-${encodeURIComponent(consultation.id)}`,
      tabindex: "-1",
      "data-consultation-id": consultation.id,
      "aria-labelledby": `consultation-title-${encodeURIComponent(consultation.id)}`,
    },
  });
  const header = createElement("div", { className: "consultation-card-header" });
  header.append(createElement("span", {
    className: "badge badge-neutral",
    text: topic?.name ?? consultation.topicId,
  }));
  if (highlighted) {
    header.append(createElement("span", {
      className: "badge badge-accent",
      text: "Выбрано на главной",
    }));
  }
  card.append(header);
  card.append(createElement("h3", {
    text: consultation.title,
    attributes: { id: `consultation-title-${encodeURIComponent(consultation.id)}` },
  }));
  card.append(createElement("p", { className: "consultation-summary", text: consultation.summary }));
  card.append(createElement("p", { className: "consultation-description", text: consultation.description }));

  const formats = [...new Set(consultation.slots.map((slot) => slot.mode))]
    .sort((left, right) => left.localeCompare(right))
    .map(getFormatLabel)
    .join(" / ") || "Нет слотов";
  const meta = createElement("dl", { className: "consultation-meta" });
  meta.append(
    createMeta("Для кого", consultation.audienceLabel || "Аудитория указана в описании"),
    createMeta("Консультант", consultation.consultantLabel),
    createMeta("Длительность и форматы", `${formatDuration(consultation.durationMinutes)} · ${formats}`),
  );
  card.append(meta);

  const tags = createElement("div", { className: "tag-list", attributes: { "aria-label": "Теги" } });
  consultation.tags.forEach((tag) => tags.append(createElement("span", { className: "tag", text: tag })));
  card.append(tags);
  card.append(createElement("h4", { className: "slot-list-title", text: "Время консультации" }));

  const slots = [...consultation.slots]
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .slice(0, 3);
  const list = createElement("ul", { className: "slot-list" });
  slots.forEach((slot) => list.append(createSlotItem(consultation, slot)));
  if (slots.length === 0) {
    list.append(createElement("li", { className: "slot-unavailable", text: "Слоты с такими параметрами не найдены" }));
  }
  card.append(list);
  card.append(createElement("a", {
    className: "button button-secondary choose-time",
    text: "Выбрать время",
    attributes: {
      href: createBookingLink(consultation.id),
      "aria-label": `Выбрать время: ${consultation.title}`,
    },
  }));
  return card;
}

function createSkeletonCard() {
  const card = createElement("article", {
    className: "card catalog-skeleton-card",
    attributes: { "aria-hidden": "true" },
  });
  card.append(
    createElement("div", { className: "skeleton skeleton-line skeleton-line-short" }),
    createElement("div", { className: "skeleton skeleton-line" }),
    createElement("div", { className: "skeleton skeleton-line" }),
    createElement("div", { className: "skeleton skeleton-line" }),
    createElement("div", { className: "skeleton skeleton-slot" }),
    createElement("div", { className: "skeleton skeleton-slot" }),
  );
  return card;
}

function populateSelect(select, items, selectedValue, allLabel) {
  clearElement(select);
  select.append(createElement("option", { text: allLabel, attributes: { value: "" } }));
  let hasSelected = !selectedValue;
  items.forEach((item) => {
    select.append(createElement("option", { text: item.name, attributes: { value: item.id } }));
    hasSelected ||= item.id === selectedValue;
  });
  if (!hasSelected) {
    select.append(createElement("option", {
      text: `Неизвестный ID: ${selectedValue}`,
      attributes: { value: selectedValue },
    }));
  }
  select.value = selectedValue;
}

export function initializeCatalog(root = document) {
  const form = root.querySelector("[data-catalog-filters]");
  const results = root.querySelector("[data-catalog-results]");
  const count = root.querySelector("[data-catalog-count]");
  if (!form || !results || !count) {
    return null;
  }

  const fieldset = form.querySelector("[data-catalog-filter-fields]");
  const search = form.elements.namedItem("query");
  const topicSelect = form.elements.namedItem("topicId");
  const instituteSelect = form.elements.namedItem("instituteId");
  const modeSelect = form.elements.namedItem("mode");
  const empty = root.querySelector("[data-catalog-empty]");
  const errorContainer = root.querySelector("[data-catalog-error]");
  const activeFilters = root.querySelector("[data-active-filters]");
  const activeFilterList = root.querySelector("[data-active-filter-list]");
  const highlightStatus = root.querySelector("[data-catalog-highlight-status]");
  const resetButtons = [...root.querySelectorAll("[data-catalog-reset]")];
  const initial = readCatalogLocation(window.location.search);
  const state = {
    filters: initial.filters,
    consultationId: initial.consultationId,
    topics: [],
    institutes: [],
  };
  let requestNumber = 0;
  let debounceTimer = null;
  let highlightedRequest = "";
  let runtime;

  function syncFormFromState() {
    search.value = state.filters.query;
    topicSelect.value = state.filters.topicId;
    instituteSelect.value = state.filters.instituteId;
    modeSelect.value = state.filters.mode;
  }

  function syncUrl() {
    const base = buildCatalogUrl(state.filters, state.consultationId, window.location.pathname);
    window.history.replaceState(window.history.state, "", `${base}${window.location.hash}`);
  }

  function getFilterValueLabel(name, value) {
    if (name === "mode") {
      return getFormatLabel(value);
    }
    if (name === "topicId") {
      return state.topics.find((topic) => topic.id === value)?.name ?? value;
    }
    if (name === "instituteId") {
      return state.institutes.find((institute) => institute.id === value)?.name ?? value;
    }
    return value;
  }

  function renderActiveFilters() {
    clearElement(activeFilterList);
    const entries = FILTER_NAMES
      .filter((name) => state.filters[name])
      .map((name) => [name, state.filters[name]]);
    if (state.consultationId) {
      entries.push(["consultationId", state.consultationId]);
    }
    activeFilters.hidden = entries.length === 0;
    resetButtons.forEach((button) => {
      button.disabled = entries.length === 0;
    });

    entries.forEach(([name, value]) => {
      const label = name === "consultationId"
        ? `Ссылка на консультацию: ${value}`
        : `${FILTER_LABELS[name]}: ${getFilterValueLabel(name, value)}`;
      activeFilterList.append(createElement("button", {
        className: "active-filter",
        text: label,
        attributes: {
          type: "button",
          "data-remove-filter": name,
          "aria-label": `Убрать: ${label}`,
        },
      }));
    });
  }

  function setLoading() {
    results.setAttribute("aria-busy", "true");
    count.textContent = "Обновляем каталог…";
    empty.hidden = true;
    errorContainer.hidden = true;
    highlightStatus.hidden = true;
    clearElement(results);
    for (let index = 0; index < 6; index += 1) {
      results.append(createSkeletonCard());
    }
  }

  async function loadCatalog(currentRequest) {
    const repository = runtime.repository;
    if (!repository) {
      return;
    }
    const filters = Object.fromEntries(
      Object.entries(state.filters).filter(([, value]) => Boolean(value)),
    );
    try {
      const catalog = await repository.getCatalog(filters);
      if (currentRequest !== requestNumber || repository !== runtime.repository) {
        return;
      }
      state.topics = catalog.topics;
      state.institutes = catalog.institutes;
      populateSelect(topicSelect, state.topics, state.filters.topicId, "Все темы");
      populateSelect(instituteSelect, state.institutes, state.filters.instituteId, "Все институты");
      renderCatalog(catalog);
    } catch (error) {
      if (currentRequest !== requestNumber || repository !== runtime.repository) {
        return;
      }
      results.setAttribute("aria-busy", "false");
      clearElement(results);
      empty.hidden = true;
      count.textContent = "Не удалось обновить каталог";
      renderCatalogError(error);
    } finally {
      if (currentRequest === requestNumber) {
        results.setAttribute("aria-busy", "false");
      }
    }
  }

  function scheduleCatalogLoad(delay = 0) {
    const currentRequest = ++requestNumber;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    syncUrl();
    renderActiveFilters();
    if (!runtime?.repository) {
      return;
    }
    setLoading();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void loadCatalog(currentRequest);
    }, delay);
  }

  function renderCatalogError(error) {
    clearElement(errorContainer);
    errorContainer.append(
      createElement("strong", { text: "Не удалось загрузить консультации" }),
      createElement("p", { text: getPublicErrorMessage(error) }),
      createElement("p", { text: "Режим хранения автоматически не менялся. Повторите запрос или явно выберите отдельный local mode." }),
    );
    const actions = createElement("div", { className: "button-row" });
    actions.append(createElement("button", {
      className: "button button-secondary",
      text: "Повторить загрузку",
      attributes: { type: "button", "data-catalog-retry": "true" },
    }));
    if (runtime.mode !== LOCAL_MODE) {
      actions.append(createElement("button", {
        className: "button button-secondary",
        text: "Использовать local (forceLocalRepository)",
        attributes: { type: "button", "data-force-local-repository": "true" },
      }));
    }
    errorContainer.append(actions);
    errorContainer.hidden = false;
  }

  function renderCatalog(catalog) {
    clearElement(results);
    results.setAttribute("aria-busy", "false");
    errorContainer.hidden = true;
    const consultations = catalog.consultations;
    const total = consultations.length;
    count.textContent = `${total} ${pluralize(total, ["консультация", "консультации", "консультаций"])}`;
    empty.hidden = total !== 0;
    renderActiveFilters();

    const topics = new Map(state.topics.map((topic) => [topic.id, topic]));
    consultations.forEach((consultation) => {
      results.append(createConsultationCard(
        consultation,
        topics.get(consultation.topicId),
        state.consultationId,
      ));
    });

    clearElement(highlightStatus);
    if (!state.consultationId) {
      highlightStatus.hidden = true;
      return;
    }
    const highlighted = getConsultation(catalog, state.consultationId);
    highlightStatus.hidden = false;
    if (!highlighted) {
      highlightStatus.className = "alert alert-warning";
      highlightStatus.append(createElement("p", {
        text: "Консультация из ссылки не входит в текущую выборку. Уберите фильтры или параметр consultationId, чтобы увидеть другие варианты.",
      }));
      return;
    }

    highlightStatus.className = "alert alert-info";
    highlightStatus.append(createElement("p", {
      text: `По ссылке с главной выделена консультация «${highlighted.title}». Свободные слоты доступны в карточке ниже.`,
    }));
    const highlightKey = `${requestNumber}:${highlighted.id}`;
    if (highlightedRequest !== highlightKey) {
      highlightedRequest = highlightKey;
      const card = [...results.children]
        .find((element) => element.dataset.consultationId === highlighted.id);
      requestAnimationFrame(() => {
        card?.scrollIntoView({
          block: "center",
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
      });
    }
  }

  function resetFilters() {
    FILTER_NAMES.forEach((name) => {
      state.filters[name] = "";
    });
    state.consultationId = "";
    syncFormFromState();
    scheduleCatalogLoad();
  }

  function removeFilter(name) {
    if (name === "consultationId") {
      state.consultationId = "";
    } else if (FILTER_NAMES.includes(name)) {
      state.filters[name] = "";
    } else {
      return;
    }
    syncFormFromState();
    scheduleCatalogLoad();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    scheduleCatalogLoad();
  });
  search.addEventListener("input", () => {
    state.filters.query = search.value;
    scheduleCatalogLoad(QUERY_DEBOUNCE_MS);
  });
  [topicSelect, instituteSelect, modeSelect].forEach((select) => {
    select.addEventListener("change", () => {
      state.filters[select.name] = select.value;
      scheduleCatalogLoad();
    });
  });
  resetButtons.forEach((button) => button.addEventListener("click", resetFilters));
  activeFilterList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-filter]");
    if (button) {
      removeFilter(button.dataset.removeFilter);
    }
  });
  errorContainer.addEventListener("click", (event) => {
    if (event.target.closest("[data-catalog-retry]")) {
      scheduleCatalogLoad();
    } else if (event.target.closest("[data-force-local-repository]")) {
      void runtime.forceLocal();
    }
  });

  runtime = createRepositoryRuntime({
    root,
    onStateChange(repositoryState) {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      requestNumber += 1;
      if (repositoryState.status === "loading") {
        fieldset.disabled = true;
        setLoading();
      } else if (repositoryState.status === "ready") {
        fieldset.disabled = false;
        scheduleCatalogLoad();
      } else if (repositoryState.status === "error") {
        fieldset.disabled = true;
        results.setAttribute("aria-busy", "false");
        clearElement(results);
        empty.hidden = true;
        errorContainer.hidden = true;
        count.textContent = "Сначала выберите доступный режим repository";
      }
    },
  });

  syncFormFromState();
  renderActiveFilters();
  void runtime.connect();
  return runtime;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initializeCatalog(document), { once: true });
  } else {
    initializeCatalog(document);
  }
}
