export const APP_NAME = "Методика";
export const APP_ORGANIZATION = "ИИТА СПбГУПТД";
export const STATE_VERSION = 1;
export const STORAGE_KEY = "iita.consultations.state.v1";
export const DEFAULT_LOCALE = "ru-RU";
export const TIME_ZONE = "Europe/Moscow";
export const DEFAULT_INSTITUTE_ID = "iita";
export const SEED_URL = "./data/seed.json";
export const API_PREFIX = "./api/v1";
export const MODE = "demo-static";
export const MODE_LABEL = "Учебный демо";
export const MODE_DESCRIPTION = "Демонстрационный статический режим: справочник и расписание не являются официальными.";
export const WEATHER_PROVIDER = "Open-Meteo";
export const WEATHER_TIMEOUT_MS = 8000;
export const SLOT_REFERENCE_DATE = "2026-11-13";

export const QUERY_PARAMS = Object.freeze({
  TOPIC: "topicId",
  CONSULTATION: "consultationId",
  SLOT: "slotId",
});

export const APP_CONFIG = Object.freeze({
  name: APP_NAME,
  organization: APP_ORGANIZATION,
  stateVersion: STATE_VERSION,
  storageKey: STORAGE_KEY,
  locale: DEFAULT_LOCALE,
  timeZone: TIME_ZONE,
  defaultInstituteId: DEFAULT_INSTITUTE_ID,
  seedUrl: SEED_URL,
  apiPrefix: API_PREFIX,
  mode: MODE,
  weatherProvider: WEATHER_PROVIDER,
  weatherTimeoutMs: WEATHER_TIMEOUT_MS,
});
