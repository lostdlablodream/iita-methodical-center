import { clearElement, createElement } from "../components.js";
import { DEFAULT_LOCALE, STORAGE_KEY } from "../config.js";
import { CONSULTATION_FORMAT, NEED_TAGS, getFormatLabel } from "../domain.js";
import { formatDateTime, pluralize } from "../format.js";
import { LOCAL_MODE, SERVER_MODE } from "../repository.js";
import { downloadAnalyticsCsv } from "./analytics-export.js";
import { getPublicErrorMessage } from "./runtime.js";

const NEED_TAG_LABELS = Object.freeze({
  [NEED_TAGS.MATERIALS]: "Материалы курса",
  [NEED_TAGS.ASSESSMENT]: "Оценивание",
  [NEED_TAGS.DIGITAL_TOOLS]: "Цифровые инструменты",
  [NEED_TAGS.ACCESSIBILITY]: "Доступные форматы",
});

const percentageFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatPercentage(value) {
  return percentageFormatter.format(Number.isFinite(value) ? value : 0);
}

function normalizeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function getTopRow(rows) {
  const top = rows.reduce((current, row) => (!current || row.count > current.count ? row : current), null);
  return top?.count > 0 ? top : null;
}

export function getAnalyticsScopeCopy(mode) {
  if (mode === LOCAL_MODE) {
    return {
      label: "Браузер · локальные записи",
      text: "Только записи этого браузера. Локальные записи не суммируются с общим API.",
    };
  }
  if (mode === SERVER_MODE) {
    return {
      label: "Сервер · общий демо API",
      text: "Агрегаты общего демо API. Локальные записи этого браузера не добавляются.",
    };
  }
  return {
    label: "Источник не выбран",
    text: "Сначала завершите подключение repository; агрегаты из разных источников не объединяются.",
  };
}

export function createDebouncedScheduler(callback, options = {}) {
  const delay = options.delay ?? 300;
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  let timer = null;

  function cancel() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule() {
    cancel();
    timer = setTimer(() => {
      timer = null;
      callback();
    }, delay);
  }

  return {
    schedule,
    cancel,
    get pending() {
      return timer !== null;
    },
  };
}

export function shouldRefreshAnalyticsFromStorage(event, mode) {
  return mode === LOCAL_MODE && event?.key === STORAGE_KEY;
}

export function buildAnalyticsModel(catalog, analytics, requestedTopicId = "") {
  if (!Array.isArray(catalog?.institutes) || !Array.isArray(catalog?.topics) || !analytics) {
    throw new TypeError("Каталог или аналитика имеют неподдерживаемый формат");
  }

  const totalActive = normalizeCount(analytics.totalActive);
  const withPercentage = (row) => ({
    ...row,
    percentage: totalActive > 0 ? row.count / totalActive : 0,
  });
  const topics = catalog.topics.map((topic) => withPercentage({
    id: topic.id,
    name: topic.name,
    count: normalizeCount(analytics.byTopic?.[topic.id]),
  }));
  const institutes = catalog.institutes.map((institute) => withPercentage({
    id: institute.id,
    name: institute.name,
    count: normalizeCount(analytics.byInstitute?.[institute.id]),
  }));
  const needTags = Object.entries(NEED_TAG_LABELS).map(([id, name]) => withPercentage({
    id,
    name,
    count: normalizeCount(analytics.byNeedTag?.[id]),
  }));
  const formats = Object.values(CONSULTATION_FORMAT).map((id) => withPercentage({
    id,
    name: getFormatLabel(id),
    count: normalizeCount(analytics.byFormat?.[id]),
  }));
  const topInstitutes = institutes
    .filter(({ count }) => count > 0)
    .sort((left, right) => right.count - left.count
      || left.name.localeCompare(right.name, DEFAULT_LOCALE))
    .slice(0, 5);
  const topTopic = totalActive > 0 ? getTopRow(topics) : null;
  const topInstitute = totalActive > 0 ? getTopRow(institutes) : null;
  const online = formats.find(({ id }) => id === CONSULTATION_FORMAT.ONLINE);
  const offline = formats.find(({ id }) => id === CONSULTATION_FORMAT.OFFLINE);

  return {
    scope: typeof analytics.scope === "string" ? analytics.scope : "unknown",
    generatedAt: typeof analytics.generatedAt === "string" ? analytics.generatedAt : "",
    topicId: requestedTopicId || analytics.topicId || null,
    totalActive,
    isEmpty: totalActive === 0,
    topics,
    institutes,
    topInstitutes,
    needTags,
    formats,
    topTopic,
    topInstitute,
    onlineOffline: {
      online: online?.count ?? 0,
      offline: offline?.count ?? 0,
      onlinePercentage: online?.percentage ?? 0,
      offlinePercentage: offline?.percentage ?? 0,
    },
  };
}

export function createAnalyticsController({ onStateChange = () => {} } = {}) {
  let repository = null;
  let catalog = null;
  let topicId = "";
  let requestNumber = 0;

  async function load(background = false) {
    if (!repository) {
      return null;
    }

    const source = repository;
    const selectedTopicId = topicId;
    const currentRequest = ++requestNumber;
    onStateChange({
      status: "loading",
      background,
      mode: source.mode,
      hasPreviousResult: catalog !== null,
    });

    try {
      const filters = selectedTopicId ? { topicId: selectedTopicId } : {};
      const [nextCatalog, analytics] = await Promise.all([
        source.getCatalog({}),
        source.getAnalytics(filters),
      ]);
      if (currentRequest !== requestNumber || source !== repository) {
        return null;
      }
      if (source.scope && analytics.scope !== source.scope) {
        throw new Error("Repository и аналитика возвращают разные источники данных");
      }

      const model = buildAnalyticsModel(nextCatalog, analytics, selectedTopicId);
      catalog = nextCatalog;
      onStateChange({
        status: "ready",
        background,
        mode: source.mode,
        catalog: nextCatalog,
        analytics,
        model,
      });
      return model;
    } catch (error) {
      if (currentRequest === requestNumber && source === repository) {
        onStateChange({ status: "error", background, mode: source.mode, error });
      }
      return null;
    }
  }

  return {
    setRepository(nextRepository) {
      repository = nextRepository;
      catalog = null;
      return load(false);
    },
    clear() {
      repository = null;
      catalog = null;
      requestNumber += 1;
    },
    setTopicId(nextTopicId) {
      topicId = typeof nextTopicId === "string" ? nextTopicId.trim() : "";
      return load(false);
    },
    refresh({ background = true } = {}) {
      return load(background);
    },
    get mode() {
      return repository?.mode ?? null;
    },
    get topicId() {
      return topicId;
    },
    get repository() {
      return repository;
    },
  };
}

function createKpiCard(label, value, note, { isName = false, extra = null } = {}) {
  const card = createElement("article", { className: "analytics-kpi" });
  card.append(
    createElement("p", { className: "analytics-kpi-label", text: label }),
    createElement("p", {
      className: `analytics-kpi-value${isName ? " is-name" : ""}`,
      text: value,
    }),
    createElement("p", { className: "analytics-kpi-note", text: note }),
  );
  if (extra) {
    card.append(extra);
  }
  return card;
}

function createFormatBar(model) {
  const bar = createElement("div", {
    className: "analytics-format-bar",
    attributes: { "aria-hidden": "true" },
  });
  model.formats.forEach((format) => {
    const segment = createElement("span", { className: `is-${format.id}` });
    segment.style.setProperty("--format-size", `${format.percentage * 100}%`);
    bar.append(segment);
  });
  return bar;
}

function renderBars(container, rows, emptyText) {
  clearElement(container);
  if (rows.length === 0) {
    container.append(createElement("li", { className: "analytics-chart-note", text: emptyText }));
    return;
  }

  const maxCount = Math.max(...rows.map(({ count }) => count));
  rows.forEach((row) => {
    const fill = createElement("span", { className: "analytics-bar-fill" });
    fill.style.setProperty("--bar-size", `${maxCount > 0 ? (row.count / maxCount) * 100 : 0}%`);
    const track = createElement("span", {
      className: "analytics-bar-track",
      attributes: { "aria-hidden": "true" },
    }, [fill]);
    const item = createElement("li", { className: "analytics-bar-row" });
    item.append(
      createElement("span", { className: "analytics-bar-label", text: row.name }),
      track,
      createElement("span", {
        className: "analytics-bar-value",
        text: `${row.count} · ${formatPercentage(row.percentage)}`,
      }),
    );
    container.append(item);
  });
}

export function initializeAnalytics(root = document) {
  const section = root.querySelector("[data-analytics]");
  if (!section) {
    return {
      onRepositoryStateChange() {},
      setRuntime() {},
    };
  }

  const panel = section.querySelector("[data-analytics-panel]");
  const topicSelect = section.querySelector("[data-analytics-topic]");
  const refreshButton = section.querySelector("[data-analytics-refresh]");
  const exportButton = section.querySelector("[data-analytics-export]");
  const scopeBadge = section.querySelector("[data-analytics-scope]");
  const scopeNote = section.querySelector("[data-analytics-scope-note]");
  const generated = section.querySelector("[data-analytics-generated]");
  const status = section.querySelector("[data-analytics-status]");
  const results = section.querySelector("[data-analytics-results]");
  const kpis = section.querySelector("[data-analytics-kpis]");
  const topicBars = section.querySelector("[data-analytics-topic-bars]");
  const instituteBars = section.querySelector("[data-analytics-institute-bars]");
  const tagBars = section.querySelector("[data-analytics-tag-bars]");
  const empty = section.querySelector("[data-analytics-empty]");
  const emptyLink = section.querySelector("[data-analytics-empty-link]");
  const tableDetails = section.querySelector("[data-analytics-table-details]");
  const tableSummary = section.querySelector("[data-analytics-table-summary]");
  const tableCaption = section.querySelector("[data-analytics-table-caption]");
  const tableRows = section.querySelector("[data-analytics-institute-rows]");
  const errorContainer = section.querySelector("[data-analytics-error]");
  const errorMessage = section.querySelector("[data-analytics-error-message]");

  let runtime = null;
  let currentModel = null;
  let optionSignature = "";

  function renderScope(mode) {
    const copy = getAnalyticsScopeCopy(mode);
    scopeBadge.textContent = copy.label;
    scopeBadge.classList.toggle("badge-neutral", !mode);
    scopeBadge.classList.toggle("badge-accent", Boolean(mode));
    scopeNote.textContent = copy.text;
  }

  function renderLoading(background) {
    exportButton.disabled = true;
    refreshButton.disabled = true;
    panel.setAttribute("aria-busy", "true");
    errorContainer.hidden = true;
    if (background && currentModel) {
      status.hidden = true;
      return;
    }

    currentModel = null;
    results.hidden = true;
    empty.hidden = true;
    tableDetails.hidden = true;
    generated.textContent = "";
    status.hidden = false;
    clearElement(status);
    status.append(
      createElement("span", { className: "loading-indicator", attributes: { "aria-hidden": "true" } }),
      createElement("p", { text: "Загружаем каталог и агрегаты из одного источника…" }),
    );
    topicSelect.disabled = true;
  }

  function renderError(error) {
    currentModel = null;
    panel.setAttribute("aria-busy", "false");
    status.hidden = true;
    results.hidden = true;
    empty.hidden = true;
    tableDetails.hidden = true;
    generated.textContent = "";
    errorMessage.textContent = getPublicErrorMessage(error);
    errorContainer.hidden = false;
    exportButton.disabled = true;
    refreshButton.disabled = true;
    topicSelect.disabled = topicSelect.options.length <= 1;
  }

  function renderTopicOptions(catalog) {
    const signature = catalog.topics.map(({ id, name }) => `${id}:${name}`).join("|");
    if (signature === optionSignature) {
      return;
    }

    clearElement(topicSelect);
    topicSelect.append(createElement("option", { text: "Все темы", attributes: { value: "" } }));
    catalog.topics.forEach((topic) => {
      topicSelect.append(createElement("option", {
        text: topic.name,
        attributes: { value: topic.id },
      }));
    });
    topicSelect.value = controller.topicId;
    optionSignature = signature;
  }

  function renderKpis(model) {
    clearElement(kpis);
    const selectedTopic = model.topics.find(({ id }) => id === model.topicId);
    const topTopic = model.topTopic;
    const topInstitute = model.topInstitute;
    kpis.append(
      createKpiCard(
        "Активные записи",
        String(model.totalActive),
        selectedTopic ? `Тема: ${selectedTopic.name}` : "По всем шести темам",
      ),
      createKpiCard(
        "Топ-тема",
        topTopic?.name ?? "Нет данных",
        topTopic ? `${topTopic.count} ${pluralize(topTopic.count, ["запись", "записи", "записей"])}` : "Нет активных записей",
        { isName: true },
      ),
      createKpiCard(
        "Топ-институт",
        topInstitute?.name ?? "Не указан",
        topInstitute ? `${topInstitute.count} ${pluralize(topInstitute.count, ["запись", "записи", "записей"])}` : "Нет агрегата по институтам",
        { isName: true },
      ),
      createKpiCard(
        "Онлайн / очно",
        `${formatPercentage(model.onlineOffline.onlinePercentage)} / ${formatPercentage(model.onlineOffline.offlinePercentage)}`,
        `Онлайн: ${model.onlineOffline.online} · очно: ${model.onlineOffline.offline}`,
        { extra: createFormatBar(model) },
      ),
    );
  }

  function renderInstituteTable(model) {
    clearElement(tableRows);
    model.institutes.forEach((institute) => {
      const row = createElement("tr");
      row.append(
        createElement("td", {}, [createElement("code", { text: institute.id })]),
        createElement("th", { text: institute.name, attributes: { scope: "row" } }),
        createElement("td", { text: institute.count }),
      );
      tableRows.append(row);
    });

    const selectedTopic = model.topics.find(({ id }) => id === model.topicId);
    tableSummary.textContent = `Показать все ${model.institutes.length} ${pluralize(model.institutes.length, ["институт", "института", "институтов"])}, включая нули`;
    tableCaption.textContent = `Активные записи по всем институтам справочника, включая нулевые значения. Тема: ${selectedTopic?.name ?? "все темы"}. Источник: ${getAnalyticsScopeCopy(controller.mode).label}.`;
    tableDetails.hidden = false;
  }

  function renderReady(model, catalog, mode) {
    currentModel = model;
    renderTopicOptions(catalog);
    renderScope(mode);
    panel.setAttribute("aria-busy", "false");
    status.hidden = true;
    errorContainer.hidden = true;
    generated.textContent = `Обновлено: ${formatDateTime(model.generatedAt)}`;
    topicSelect.disabled = false;
    refreshButton.disabled = false;
    exportButton.disabled = false;

    results.hidden = model.isEmpty;
    empty.hidden = !model.isEmpty;
    if (model.isEmpty) {
      const parameters = new URLSearchParams();
      if (model.topicId) {
        parameters.set("topicId", model.topicId);
      }
      emptyLink.href = `./catalog.html${parameters.size ? `?${parameters}` : ""}`;
    } else {
      renderKpis(model);
      renderBars(topicBars, model.topics, "Нет тем с активными записями");
      renderBars(instituteBars, model.topInstitutes, "Нет институтов с активными записями");
      renderBars(tagBars, model.needTags, "Теги не указаны");
    }
    renderInstituteTable(model);
  }

  const controller = createAnalyticsController({
    onStateChange(state) {
      if (state.status === "loading") {
        renderLoading(state.background);
      } else if (state.status === "ready") {
        renderReady(state.model, state.catalog, state.mode);
      } else if (state.status === "error") {
        renderError(state.error);
      }
    },
  });

  const refreshScheduler = createDebouncedScheduler(() => {
    if (controller.repository) {
      void controller.refresh({ background: true });
    }
  });

  section.addEventListener("click", (event) => {
    if (event.target.closest("[data-analytics-refresh]")) {
      void controller.refresh({ background: false });
    } else if (event.target.closest("[data-analytics-export]") && currentModel) {
      downloadAnalyticsCsv(currentModel);
    } else if (event.target.closest("[data-analytics-retry]")) {
      if (runtime?.state.status === "error") {
        void runtime.retry();
      } else {
        void controller.refresh({ background: false });
      }
    }
  });
  topicSelect.addEventListener("change", () => {
    void controller.setTopicId(topicSelect.value);
  });
  window.addEventListener("storage", (event) => {
    if (shouldRefreshAnalyticsFromStorage(event, controller.mode)) {
      refreshScheduler.schedule();
    }
  });
  window.addEventListener("focus", () => {
    if (controller.mode === SERVER_MODE) {
      refreshScheduler.schedule();
    }
  });
  root.addEventListener("visibilitychange", () => {
    if (root.visibilityState === "visible" && controller.mode === SERVER_MODE) {
      refreshScheduler.schedule();
    }
  });

  renderScope(null);
  return {
    onRepositoryStateChange(state) {
      refreshScheduler.cancel();
      if (state.status === "loading") {
        controller.clear();
        currentModel = null;
        renderScope(null);
        renderLoading(false);
      } else if (state.status === "ready") {
        optionSignature = "";
        void controller.setRepository(state.repository);
      } else if (state.status === "error") {
        controller.clear();
        renderScope(null);
        renderError(state.error);
      }
    },
    setRuntime(nextRuntime) {
      runtime = nextRuntime;
    },
    controller,
    refreshScheduler,
  };
}
