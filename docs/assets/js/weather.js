import { DEFAULT_LOCALE, TIME_ZONE, WEATHER_TIMEOUT_MS } from "./config.js";
import { clearElement, createElement } from "./components.js";
import { formatDateTime } from "./format.js";

const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
const CURRENT_FIELDS = "temperature_2m,precipitation_probability,weather_code,wind_speed_10m";
const DEFAULT_OPTIONS = Object.freeze({
  latitude: 59.9386,
  longitude: 30.3141,
  locationLabel: "Санкт-Петербург",
  timeZone: TIME_ZONE,
  timeoutMs: WEATHER_TIMEOUT_MS,
});

const WEATHER_CODE_LABELS = Object.freeze({
  0: "Ясно",
  1: "Преимущественно ясно",
  2: "Переменная облачность",
  3: "Пасмурно",
  45: "Туман",
  48: "Туман с изморозью",
  51: "Слабая морось",
  53: "Умеренная морось",
  55: "Плотная морось",
  56: "Слабая ледяная морось",
  57: "Сильная ледяная морось",
  61: "Небольшой дождь",
  63: "Умеренный дождь",
  65: "Сильный дождь",
  66: "Слабый ледяной дождь",
  67: "Сильный ледяной дождь",
  71: "Небольшой снег",
  73: "Умеренный снег",
  75: "Сильный снег",
  77: "Снежная крупа",
  80: "Небольшой ливень",
  81: "Умеренный ливень",
  82: "Сильный ливень",
  85: "Небольшой снегопад",
  86: "Сильный снегопад",
  95: "Гроза",
  96: "Гроза с небольшим градом",
  99: "Гроза с сильным градом",
});

const numberFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  maximumFractionDigits: 1,
});
const temperatureFormatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const mountedWidgets = new WeakMap();

export function getWeatherCodeLabel(code) {
  return WEATHER_CODE_LABELS[code] ?? "Погодные условия уточняются";
}

export function buildCurrentWeatherUrl(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const parameters = new URLSearchParams({
    latitude: String(config.latitude),
    longitude: String(config.longitude),
    current: CURRENT_FIELDS,
    timezone: config.timeZone,
    timeformat: "unixtime",
    temperature_unit: "celsius",
    wind_speed_unit: "ms",
  });

  return `${WEATHER_API_URL}?${parameters.toString()}`;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeCurrentWeather(payload) {
  const current = payload?.current;
  if (!current
    || !isFiniteNumber(current.temperature_2m)
    || !isFiniteNumber(current.precipitation_probability)
    || !isFiniteNumber(current.weather_code)
    || !isFiniteNumber(current.wind_speed_10m)) {
    throw new Error("Open-Meteo вернул неполный текущий прогноз");
  }

  const observedAt = typeof current.time === "number"
    ? new Date(current.time * 1000)
    : new Date(current.time);
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("Open-Meteo вернул некорректное время наблюдения");
  }

  return {
    observedAt,
    temperature: current.temperature_2m,
    precipitationProbability: current.precipitation_probability,
    weatherCode: current.weather_code,
    windSpeed: current.wind_speed_10m,
  };
}

export async function fetchCurrentWeather(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const fetcher = config.fetchImpl ?? globalThis.fetch;

  try {
    if (typeof fetcher !== "function") {
      throw new Error("Fetch API недоступен");
    }

    const response = await fetcher(buildCurrentWeatherUrl(config), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      throw new Error(`Open-Meteo ответил со статусом ${response.status}`);
    }

    return normalizeCurrentWeather(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function renderLoading(container) {
  const wrapper = createElement("div", { className: "weather-loading" });
  wrapper.append(
    createElement("span", { className: "loading-indicator", attributes: { "aria-hidden": "true" } }),
    createElement("h3", { text: "Загружаем текущую погоду" }),
    createElement("p", { text: "Запрашиваем только прогноз для центра Санкт-Петербурга…" }),
  );
  clearElement(container);
  container.append(wrapper);
}

function renderError(container, error, timeoutMs) {
  const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError";
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const wrapper = createElement("div", { className: "weather-error" });
  wrapper.append(
    createElement("p", { className: "eyebrow", text: "Прогноз недоступен" }),
    createElement("h3", { text: "Не удалось получить погоду" }),
    createElement("p", {
      text: isTimeout
        ? `Сервис не ответил за ${seconds} секунд. Проверьте соединение и повторите попытку.`
        : "Сервис Open-Meteo временно недоступен или вернул неподдерживаемый ответ. Повторите попытку чуть позже.",
    }),
    createElement("button", {
      className: "button button-secondary",
      text: "Повторить",
      attributes: { type: "button", "data-weather-retry": "true" },
    }),
    createElement("p", {
      className: "weather-error-note",
      text: "Ошибка погоды не влияет на компас, ссылки и другие разделы страницы.",
    }),
  );
  clearElement(container);
  container.append(wrapper);
}

function createWeatherFact(label, value) {
  const wrapper = createElement("div");
  wrapper.append(
    createElement("dt", { text: label }),
    createElement("dd", { text: value }),
  );
  return wrapper;
}

function createSourceLink() {
  const hiddenText = createElement("span", {
    className: "visually-hidden",
    text: " (откроется в новой вкладке)",
  });
  return createElement("a", {
    text: "Open-Meteo",
    attributes: {
      href: "https://open-meteo.com/",
      target: "_blank",
      rel: "noopener noreferrer",
    },
  }, [hiddenText]);
}

function renderResult(container, weather, locationLabel) {
  const heading = createElement("div", { className: "weather-heading" });
  heading.append(
    createElement("p", { className: "weather-location", text: locationLabel }),
    createElement("h3", { text: getWeatherCodeLabel(weather.weatherCode) }),
    createElement("p", {
      className: "weather-code",
      text: `Код погоды WMO: ${weather.weatherCode}`,
    }),
  );

  const summary = createElement("div", { className: "weather-summary" });
  summary.append(
    heading,
    createElement("p", {
      className: "weather-temperature",
      text: `${temperatureFormatter.format(weather.temperature)} °C`,
      attributes: { "aria-label": `Температура ${numberFormatter.format(weather.temperature)} градусов Цельсия` },
    }),
  );

  const facts = createElement("dl", { className: "weather-facts" });
  facts.append(
    createWeatherFact("Осадки", `${numberFormatter.format(weather.precipitationProbability)}% вероятность`),
    createWeatherFact("Ветер", `${numberFormatter.format(weather.windSpeed)} м/с`),
  );

  const time = createElement("time", {
    text: `Данные на ${formatDateTime(weather.observedAt)}, московское время`,
    attributes: { datetime: weather.observedAt.toISOString() },
  });
  const metadata = createElement("div", { className: "weather-metadata" });
  const source = createElement("p", { className: "weather-source" }, ["Источник: ", createSourceLink(), "."]);
  metadata.append(
    createElement("p", {}, [time]),
    source,
    createElement("p", { text: "Запрос содержит только координаты города и параметры прогноза; ваши данные не отправляются." }),
  );

  clearElement(container);
  container.append(summary, facts, metadata);
}

export function renderWeatherWidget(container, options = {}) {
  if (!container || typeof container.replaceChildren !== "function") {
    throw new TypeError("renderWeatherWidget ожидает DOM-контейнер");
  }

  const existingWidget = mountedWidgets.get(container);
  if (existingWidget) {
    existingWidget.refresh();
    return existingWidget;
  }

  const config = { ...DEFAULT_OPTIONS, ...options };
  let requestNumber = 0;

  const load = async () => {
    const currentRequest = ++requestNumber;
    container.setAttribute("aria-busy", "true");
    renderLoading(container);

    try {
      const weather = await fetchCurrentWeather(config);
      if (currentRequest !== requestNumber) {
        return null;
      }
      renderResult(container, weather, config.locationLabel);
      return weather;
    } catch (error) {
      if (currentRequest === requestNumber) {
        renderError(container, error, config.timeoutMs);
      }
      return null;
    } finally {
      if (currentRequest === requestNumber) {
        container.setAttribute("aria-busy", "false");
      }
    }
  };

  const widget = { refresh: load };
  mountedWidgets.set(container, widget);
  container.classList.add("weather-widget");
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-atomic", "true");
  container.addEventListener("click", (event) => {
    if (event.target.closest("[data-weather-retry]")) {
      load();
    }
  });
  load();
  return widget;
}
