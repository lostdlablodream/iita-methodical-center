import { DEFAULT_LOCALE, QUERY_PARAMS, SEED_URL } from "../config.js";
import { clearElement, createElement } from "../components.js";
import { getConsultation, getFormatLabel, getTopic } from "../domain.js";
import { formatDuration, pluralize } from "../format.js";
import { renderWeatherWidget } from "../weather.js";

const SCENARIOS = Object.freeze([
  {
    id: "rebuild-course",
    topicId: "digital-lms",
    consultationIds: ["lms-course-map", "lms-assignments-communication"],
    advice: "Начните с карты курса, затем проверьте задания и коммуникацию: так изменения не останутся набором несвязанных настроек.",
  },
  {
    id: "use-ai",
    topicId: "ai-assistant",
    consultationIds: ["ai-lesson-design", "ai-academic-integrity"],
    advice: "Сначала выберите одну задачу для ИИ и способ проверки результата, затем сформулируйте правила для студентов.",
  },
  {
    id: "assessment",
    topicId: "assessment-methods",
    consultationIds: ["assessment-rubrics", "formative-feedback"],
    advice: "Соберите наблюдаемые критерии и добавьте короткие проверки по ходу темы, чтобы обратная связь появлялась до итогового контроля.",
  },
  {
    id: "project",
    topicId: "project-learning",
    consultationIds: ["project-brief", "project-team-assessment"],
    advice: "Определите продукт и контрольные точки проекта, после чего распределите роли и доказательства индивидуального вклада.",
  },
  {
    id: "accessibility",
    topicId: "accessibility",
    consultationIds: ["accessible-documents", "accessible-media-lms"],
    advice: "Начните со структуры документов, а затем добавьте текстовые альтернативы медиа и проверьте навигацию с клавиатуры.",
  },
  {
    id: "publication",
    topicId: "research-publications",
    consultationIds: ["research-article-plan", "research-evidence-review"],
    advice: "Сформулируйте вклад исследования и план разделов, затем проверьте доказательства и посмотрите на текст глазами рецензента.",
  },
]);

let seedPromise = null;

async function requestSeed() {
  const response = await fetch(SEED_URL, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(`Не удалось загрузить справочник: ${response.status}`);
  }

  const seed = await response.json();
  if (!Array.isArray(seed?.topics) || !Array.isArray(seed?.consultations)) {
    throw new Error("Справочник имеет неподдерживаемый формат");
  }

  return seed;
}

function loadSeed() {
  if (!seedPromise) {
    seedPromise = requestSeed().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }

  return seedPromise;
}

function createCatalogLink(topicId, consultationId) {
  const parameters = new URLSearchParams({ [QUERY_PARAMS.TOPIC]: topicId });
  if (consultationId) {
    parameters.set(QUERY_PARAMS.CONSULTATION, consultationId);
  }
  return `./catalog.html?${parameters.toString()}`;
}

function createLoadingState() {
  const wrapper = createElement("div", { className: "compass-loading" });
  wrapper.append(
    createElement("span", { className: "loading-indicator", attributes: { "aria-hidden": "true" } }),
    createElement("h3", { text: "Подбираем направление" }),
    createElement("p", { text: "Загружаем темы и консультации из демонстрационного справочника…" }),
  );
  return wrapper;
}

function createRecommendationCard(consultation, topic) {
  const formats = new Set(
    (consultation.slots ?? []).map((slot) => getFormatLabel(slot.mode)),
  );
  const formatLabel = formats.size > 0 ? [...formats].join(" / ") : "Формат уточняется";
  const card = createElement("article", { className: "recommendation-card" });

  card.append(
    createElement("h4", { text: consultation.title }),
    createElement("p", { text: consultation.summary }),
    createElement("p", {
      className: "recommendation-meta",
      text: `${formatDuration(consultation.durationMinutes)} · ${formatLabel}`,
    }),
    createElement("a", {
      className: "button button-secondary recommendation-link",
      text: "Открыть в каталоге",
      attributes: { href: createCatalogLink(topic.id, consultation.id) },
    }),
  );

  return card;
}

function renderRecommendation(result, scenario, seed) {
  const topic = getTopic(seed, scenario.topicId);
  const consultations = scenario.consultationIds
    .map((consultationId) => getConsultation(seed, consultationId))
    .filter(Boolean)
    .slice(0, 2);

  if (!topic || consultations.length === 0) {
    throw new Error("Для сценария не найдены тема или консультации");
  }

  const heading = createElement("div", { className: "recommendation-heading" });
  heading.append(
    createElement("p", { className: "eyebrow", text: "Рекомендуемое направление" }),
    createElement("h3", { text: topic.name }),
    createElement("p", { text: topic.description }),
    createElement("a", {
      className: "text-link",
      text: "Все консультации по теме",
      attributes: { href: createCatalogLink(topic.id) },
    }),
  );

  const list = createElement("div", {
    className: "recommendation-list",
    attributes: { "aria-label": "Подходящие консультации" },
  });
  consultations.forEach((consultation) => {
    list.append(createRecommendationCard(consultation, topic));
  });

  clearElement(result);
  result.append(
    heading,
    createElement("p", { className: "recommendation-advice", text: scenario.advice }),
    list,
    createElement("p", {
      className: "recommendation-note",
      text: "Ссылки сохраняют выбор в адресе каталога. Запись на этой ветке не создаётся.",
    }),
  );
}

function renderCompassError(result) {
  const wrapper = createElement("div", { className: "compass-error" });
  wrapper.append(
    createElement("p", { className: "eyebrow", text: "Справочник недоступен" }),
    createElement("h3", { text: "Не удалось получить рекомендацию" }),
    createElement("p", { text: "Проверьте подключение и повторите загрузку. Остальные разделы главной продолжают работать." }),
    createElement("button", {
      className: "button button-secondary",
      text: "Повторить",
      attributes: { type: "button", "data-compass-retry": "true" },
    }),
  );
  clearElement(result);
  result.append(wrapper);
}

export function initializeCompass(root = document) {
  const picker = root.querySelector("[data-compass-scenarios]");
  const result = root.querySelector("[data-compass-result]");
  if (!picker || !result) {
    return;
  }

  const scenarioButtons = [...picker.querySelectorAll("[data-scenario]")];
  let selectedScenarioId = null;
  let requestNumber = 0;

  const selectScenario = async (scenarioId) => {
    const scenario = SCENARIOS.find(({ id }) => id === scenarioId);
    if (!scenario) {
      return;
    }

    selectedScenarioId = scenarioId;
    const currentRequest = ++requestNumber;
    scenarioButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.scenario === scenarioId));
    });

    result.setAttribute("aria-busy", "true");
    clearElement(result);
    result.append(createLoadingState());

    try {
      const seed = await loadSeed();
      if (currentRequest !== requestNumber) {
        return;
      }
      renderRecommendation(result, scenario, seed);
    } catch (error) {
      if (currentRequest === requestNumber) {
        renderCompassError(result);
      }
    } finally {
      if (currentRequest === requestNumber) {
        result.setAttribute("aria-busy", "false");
      }
    }
  };

  picker.addEventListener("click", (event) => {
    const button = event.target.closest("[data-scenario]");
    if (button && picker.contains(button)) {
      selectScenario(button.dataset.scenario);
    }
  });

  result.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-compass-retry]");
    if (retry && selectedScenarioId) {
      selectScenario(selectedScenarioId);
    }
  });
}

function normalizeSearchText(value) {
  return String(value).toLocaleLowerCase(DEFAULT_LOCALE).replace(/\s+/g, " ").trim();
}

export function initializeFaqSearch(root = document) {
  const search = root.querySelector("[data-faq-search]");
  const list = root.querySelector("[data-faq-list]");
  const count = root.querySelector("[data-faq-count]");
  const empty = root.querySelector("[data-faq-empty]");
  if (!search || !list || !count || !empty) {
    return;
  }

  const items = [...list.querySelectorAll("details")];
  const topClearButton = root.querySelector(".faq-clear[data-faq-clear]");
  const clearButtons = root.querySelectorAll("[data-faq-clear]");

  const updateFaq = () => {
    const query = normalizeSearchText(search.value);
    let visibleCount = 0;

    items.forEach((item) => {
      const matches = !query || normalizeSearchText(item.textContent).includes(query);
      item.hidden = !matches;
      if (matches) {
        visibleCount += 1;
      }
    });

    const questionForm = pluralize(visibleCount, ["вопрос", "вопроса", "вопросов"]);
    count.textContent = query
      ? `Найдено ${visibleCount} ${questionForm} из ${items.length}`
      : `Показаны все ${items.length} ${pluralize(items.length, ["вопрос", "вопроса", "вопросов"])}`;
    empty.hidden = visibleCount !== 0;
    if (topClearButton) {
      topClearButton.hidden = !query;
    }
  };

  const clearSearch = () => {
    search.value = "";
    updateFaq();
    search.focus();
  };

  search.addEventListener("input", updateFaq);
  clearButtons.forEach((button) => button.addEventListener("click", clearSearch));
  updateFaq();
}

function initializeHome() {
  initializeCompass(document);
  initializeFaqSearch(document);

  const weatherContainer = document.querySelector("[data-home-weather]");
  if (weatherContainer) {
    renderWeatherWidget(weatherContainer);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeHome, { once: true });
} else {
  initializeHome();
}
