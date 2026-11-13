import { SEED_URL } from "./config.js";
import {
  BOOKING_STATUS,
  CONSULTATION_FORMAT,
  NEED_TAGS,
  findConsultationSlot,
  getConsultation,
  getInstitute,
  getSlot,
  getTopic,
  isFutureSlot,
  isInstituteAllowed,
} from "./domain.js";
import { ERROR_CODES, RepositoryError, createValidationError } from "./errors.js";
import {
  assertStorageMutationsAvailable,
  copyJson,
  createBookingId,
  getStorageCapabilities,
  readState,
  updateState,
} from "./storage.js";

export const LOCAL_MODE = "local";
export const LOCAL_ANALYTICS_SCOPE = "local-browser";
export const NEED_MIN_LENGTH = 10;
export const NEED_MAX_LENGTH = 1000;
export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 80;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const ALLOWED_NEED_TAGS = Object.freeze(Object.values(NEED_TAGS));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("now должен быть корректной датой или функцией, возвращающей дату");
  }
  return date;
}

function normalizeIdentifier(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeNeed(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeNeedTags(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    return null;
  }
  return [...new Set(value.map((tag) => tag.trim()))].sort();
}

export function normalizeIdempotencyKey(value) {
  const key = normalizeIdentifier(value);
  if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw createValidationError(
      { idempotencyKey: `Укажите ключ длиной от 1 до ${IDEMPOTENCY_KEY_MAX_LENGTH} символов.` },
      "Некорректный ключ идемпотентности.",
    );
  }
  return key;
}

export function normalizeCatalogFilters(filters = {}) {
  if (!isObject(filters)) {
    throw createValidationError({ filters: "Передайте объект фильтров." }, "Некорректные фильтры каталога.");
  }

  const normalized = {};
  const fields = {};
  for (const name of ["query", "topicId", "instituteId", "mode", "from", "to"]) {
    const value = filters[name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      fields[name] = "Значение фильтра должно быть строкой.";
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      normalized[name] = trimmed;
    }
  }

  if (normalized.mode && !Object.values(CONSULTATION_FORMAT).includes(normalized.mode)) {
    fields.mode = "Допустимые форматы: online, offline.";
  }
  for (const name of ["from", "to"]) {
    if (normalized[name] && Number.isNaN(new Date(normalized[name]).getTime())) {
      fields[name] = "Укажите корректную дату RFC3339.";
    }
  }
  if (normalized.from && normalized.to
    && new Date(normalized.from).getTime() > new Date(normalized.to).getTime()) {
    fields.to = "Конец диапазона должен быть не раньше его начала.";
  }

  if (Object.keys(fields).length > 0) {
    throw createValidationError(fields, "Некорректные фильтры каталога.");
  }
  return normalized;
}

export function normalizeAnalyticsFilters(filters = {}) {
  const source = typeof filters === "string" ? { topicId: filters } : filters;
  if (!isObject(source)) {
    throw createValidationError({ filters: "Передайте объект фильтров." }, "Некорректные фильтры аналитики.");
  }
  if (source.topicId === undefined || source.topicId === null) {
    return {};
  }
  const topicId = normalizeIdentifier(source.topicId);
  if (!topicId) {
    throw createValidationError({ topicId: "Укажите ID темы." }, "Некорректный ID темы.");
  }
  return { topicId };
}

export function normalizeBookingStatus(status) {
  if (status === undefined || status === null) {
    return null;
  }
  const normalized = normalizeIdentifier(status);
  if (!Object.values(BOOKING_STATUS).includes(normalized)) {
    throw createValidationError(
      { status: "Допустимые статусы: active, cancelled." },
      "Некорректный фильтр статуса.",
    );
  }
  return normalized;
}

export function normalizeBookingInput(input) {
  const source = isObject(input) ? input : {};
  const normalized = {
    consultationId: normalizeIdentifier(source.consultationId),
    slotId: normalizeIdentifier(source.slotId),
    instituteId: normalizeIdentifier(source.instituteId ?? source.requesterInstituteId),
    displayName: normalizeIdentifier(source.displayName),
    need: normalizeNeed(source.need),
    needTags: normalizeNeedTags(source.needTags),
  };
  const fields = {};

  if (!normalized.consultationId) {
    fields.consultationId = "Выберите консультацию.";
  }
  if (!normalized.slotId) {
    fields.slotId = "Выберите слот консультации.";
  }
  if (!normalized.instituteId) {
    fields.instituteId = "Выберите институт.";
  }
  if (normalized.displayName.length < DISPLAY_NAME_MIN_LENGTH
    || normalized.displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    fields.displayName = `Укажите имя длиной от ${DISPLAY_NAME_MIN_LENGTH} до ${DISPLAY_NAME_MAX_LENGTH} символов после trim.`;
  }
  if (normalized.need.length < NEED_MIN_LENGTH || normalized.need.length > NEED_MAX_LENGTH) {
    fields.need = `Опишите потребность: от ${NEED_MIN_LENGTH} до ${NEED_MAX_LENGTH} символов после trim.`;
  }
  if (normalized.needTags === null) {
    fields.needTags = "Теги потребности должны быть массивом строк.";
  } else if (normalized.needTags.some((tag) => !ALLOWED_NEED_TAGS.includes(tag))) {
    fields.needTags = `Допустимые теги: ${ALLOWED_NEED_TAGS.join(", ")}.`;
  }

  if (Object.keys(fields).length > 0) {
    throw createValidationError(fields);
  }
  return normalized;
}

export function canonicalizeBookingPayload(payload) {
  return JSON.stringify({
    consultationId: payload.consultationId,
    slotId: payload.slotId,
    instituteId: payload.instituteId,
    displayName: payload.displayName,
    need: payload.need,
    needTags: payload.needTags,
  });
}

export async function createIdempotencyHash(payload, cryptoImpl = globalThis.crypto) {
  const canonical = canonicalizeBookingPayload(payload);
  if (cryptoImpl?.subtle && typeof TextEncoder === "function") {
    try {
      const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `sha256:${hex}`;
    } catch {
      return `json:${canonical}`;
    }
  }
  return `json:${canonical}`;
}

function assertOwner(state, ownerToken) {
  if (ownerToken === undefined || ownerToken === null) {
    return state.ownerToken;
  }
  const normalized = normalizeIdentifier(ownerToken);
  if (!normalized || normalized !== state.ownerToken) {
    throw new RepositoryError(ERROR_CODES.OWNER_MISMATCH, "Owner token не соответствует локальному владельцу.", {
      fields: { ownerToken: "Проверьте токен владельца записей." },
    });
  }
  return state.ownerToken;
}

function activeCount(bookings, slotId) {
  return bookings.reduce(
    (count, booking) => count + Number(booking.slotId === slotId && booking.status === BOOKING_STATUS.ACTIVE),
    0,
  );
}

function getCancelIdempotencyKeys(booking) {
  const audited = Array.isArray(booking.cancelIdempotencyKeys) ? booking.cancelIdempotencyKeys : [];
  if (booking.cancelIdempotencyKey && !audited.includes(booking.cancelIdempotencyKey)) {
    return [booking.cancelIdempotencyKey, ...audited];
  }
  return audited;
}

function rememberCancelIdempotencyKey(booking, key) {
  const audited = getCancelIdempotencyKeys(booking);
  booking.cancelIdempotencyKeys = audited.includes(key) ? [...audited] : [...audited, key];
  if (booking.cancelIdempotencyKey === null) {
    booking.cancelIdempotencyKey = key;
  }
}

function validateSeed(seed) {
  const valid = isObject(seed)
    && Array.isArray(seed.institutes)
    && seed.institutes.length > 0
    && seed.institutes.every((institute) => isObject(institute)
      && normalizeIdentifier(institute.id)
      && normalizeIdentifier(institute.name))
    && Array.isArray(seed.topics)
    && seed.topics.length > 0
    && seed.topics.every((topic) => isObject(topic)
      && normalizeIdentifier(topic.id)
      && normalizeIdentifier(topic.name))
    && Array.isArray(seed.consultations)
    && seed.consultations.every((consultation) => isObject(consultation)
      && normalizeIdentifier(consultation.id)
      && normalizeIdentifier(consultation.topicId)
      && normalizeIdentifier(consultation.title)
      && typeof consultation.summary === "string"
      && typeof consultation.description === "string"
      && normalizeIdentifier(consultation.consultantLabel)
      && Array.isArray(consultation.tags)
      && consultation.tags.every((tag) => typeof tag === "string")
      && Array.isArray(consultation.instituteIds)
      && consultation.instituteIds.every((id) => typeof id === "string")
      && Number.isInteger(consultation.durationMinutes)
      && consultation.durationMinutes > 0
      && Array.isArray(consultation.slots)
      && consultation.slots.every((slot) => isObject(slot)
        && normalizeIdentifier(slot.id)
        && !Number.isNaN(new Date(slot.startsAt).getTime())
        && !Number.isNaN(new Date(slot.endsAt).getTime())
        && Object.values(CONSULTATION_FORMAT).includes(slot.mode)
        && typeof slot.location === "string"
        && Number.isInteger(slot.capacity)
        && slot.capacity > 0));

  if (!valid) {
    throw new RepositoryError(
      ERROR_CODES.INVALID_RESPONSE,
      "Справочник консультаций имеет неподдерживаемый формат.",
    );
  }
  return seed;
}

export function filterCatalog(seed, filters = {}) {
  const normalized = normalizeCatalogFilters(filters);
  const catalog = copyJson(seed);
  const query = normalized.query?.toLocaleLowerCase();
  const hasSlotFilters = Boolean(normalized.mode || normalized.from || normalized.to);
  const fromTime = normalized.from ? new Date(normalized.from).getTime() : null;
  const toTime = normalized.to ? new Date(normalized.to).getTime() : null;

  catalog.consultations = catalog.consultations
    .filter((consultation) => {
      if (normalized.topicId && consultation.topicId !== normalized.topicId) {
        return false;
      }
      if (normalized.instituteId && !consultation.instituteIds.includes(normalized.instituteId)) {
        return false;
      }
      if (query) {
        const searchable = [
          consultation.title,
          consultation.summary,
          consultation.description,
          ...consultation.tags,
        ].join("\n").toLocaleLowerCase();
        if (!searchable.includes(query)) {
          return false;
        }
      }
      return true;
    })
    .map((consultation) => {
      if (!hasSlotFilters) {
        return consultation;
      }
      consultation.slots = consultation.slots.filter((slot) => {
        const startsAt = new Date(slot.startsAt).getTime();
        return (!normalized.mode || slot.mode === normalized.mode)
          && (fromTime === null || startsAt >= fromTime)
          && (toTime === null || startsAt <= toTime);
      });
      return consultation;
    })
    .filter((consultation) => !hasSlotFilters || consultation.slots.length > 0);

  return catalog;
}

export function decorateCatalog(seed, bookings, now) {
  const referenceDate = resolveNow(now);
  const catalog = copyJson(seed);
  for (const consultation of catalog.consultations) {
    for (const slot of consultation.slots) {
      const wasOpen = slot.isOpen !== false;
      const reservedCount = activeCount(bookings, slot.id);
      const remainingCount = Math.max(0, slot.capacity - reservedCount);
      slot.reservedCount = reservedCount;
      slot.remainingCount = remainingCount;
      slot.isOpen = wasOpen && isFutureSlot(slot, referenceDate) && remainingCount > 0;
    }
  }
  return catalog;
}

function requireTopic(seed, topicId) {
  if (!topicId) {
    return null;
  }
  if (!getTopic(seed, topicId)) {
    throw createValidationError(
      { topicId: "Выберите тему из справочника." },
      "Неизвестная тема аналитики.",
    );
  }
  return topicId;
}

export function buildLocalAnalytics(seed, bookings, filters = {}, now) {
  const selectedTopicId = requireTopic(seed, normalizeAnalyticsFilters(filters).topicId);
  const active = bookings.filter((booking) => booking.status === BOOKING_STATUS.ACTIVE
    && (selectedTopicId === null || booking.topicId === selectedTopicId));

  const byInstitute = Object.fromEntries(seed.institutes.map(({ id }) => [id, 0]));
  const byTopic = Object.fromEntries(seed.topics.map(({ id }) => [id, 0]));
  const byFormat = Object.fromEntries(Object.values(CONSULTATION_FORMAT).map((mode) => [mode, 0]));
  const byNeedTag = Object.fromEntries(ALLOWED_NEED_TAGS.map((tag) => [tag, 0]));

  for (const booking of active) {
    if (Object.hasOwn(byInstitute, booking.instituteId)) {
      byInstitute[booking.instituteId] += 1;
    }
    if (Object.hasOwn(byTopic, booking.topicId)) {
      byTopic[booking.topicId] += 1;
    }
    if (Object.hasOwn(byFormat, booking.mode)) {
      byFormat[booking.mode] += 1;
    }
    for (const tag of booking.needTags) {
      if (Object.hasOwn(byNeedTag, tag)) {
        byNeedTag[tag] += 1;
      }
    }
  }

  return {
    scope: LOCAL_ANALYTICS_SCOPE,
    generatedAt: resolveNow(now).toISOString(),
    topicId: selectedTopicId,
    totalActive: active.length,
    byInstitute,
    byTopic,
    byFormat,
    byNeedTag,
  };
}

async function fetchSeed(fetchImpl, seedUrl) {
  if (typeof fetchImpl !== "function") {
    throw new RepositoryError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      "В этом окружении недоступна загрузка справочника.",
      { retryable: true },
    );
  }

  let response;
  try {
    response = await fetchImpl(seedUrl, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new RepositoryError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      "Не удалось загрузить общий справочник.",
      { cause: error, retryable: true },
    );
  }

  if (!response || !response.ok) {
    throw new RepositoryError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      "Общий справочник временно недоступен.",
      { status: response?.status ?? 503, retryable: true },
    );
  }

  try {
    const seed = await response.json();
    return validateSeed(seed);
  } catch (error) {
    if (error instanceof RepositoryError) {
      throw error;
    }
    throw new RepositoryError(
      ERROR_CODES.INVALID_RESPONSE,
      "Общий справочник не содержит корректный JSON.",
      { cause: error },
    );
  }
}

export function createLocalRepository(options = {}) {
  const storageOptions = {
    storage: options.storage,
    crypto: options.crypto,
    locks: options.locks,
  };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const seedUrl = options.seedUrl ?? SEED_URL;
  const now = options.now;
  let seedPromise;

  function loadSeed() {
    if (!seedPromise) {
      seedPromise = fetchSeed(fetchImpl, seedUrl).catch((error) => {
        seedPromise = undefined;
        throw error;
      });
    }
    return seedPromise;
  }

  async function getCatalog(filters = {}) {
    const normalizedFilters = normalizeCatalogFilters(filters);
    const [seed, state] = await Promise.all([
      loadSeed(),
      Promise.resolve().then(() => readState(storageOptions)),
    ]);
    return decorateCatalog(filterCatalog(seed, normalizedFilters), state.local.bookings, now);
  }

  async function createBooking(draft, mutationOptions = {}) {
    assertStorageMutationsAvailable(storageOptions);
    const payload = normalizeBookingInput(draft);
    const normalizedKey = normalizeIdempotencyKey(mutationOptions?.idempotencyKey);
    const idempotencyHash = await createIdempotencyHash(payload, options.crypto);
    const canonicalPayload = canonicalizeBookingPayload(payload);
    const seed = await loadSeed();

    return updateState((state) => {
      assertOwner(state, mutationOptions?.ownerToken);
      const existing = state.local.bookings.find(
        (booking) => booking.idempotencyKey === normalizedKey,
      );
      if (existing) {
        if (canonicalizeBookingPayload(existing) === canonicalPayload) {
          return { result: existing, changed: false };
        }
        throw new RepositoryError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "Этот ключ идемпотентности уже использован для другого содержимого записи.",
          { fields: { idempotencyKey: "Создайте новый ключ для изменённой записи." } },
        );
      }

      const consultation = getConsultation(seed, payload.consultationId);
      if (!consultation) {
        throw new RepositoryError(ERROR_CODES.NOT_FOUND, "Выбранная консультация не найдена.", {
          fields: { consultationId: "Выберите консультацию из актуального каталога." },
        });
      }
      const slot = getSlot(consultation, payload.slotId);
      if (!slot) {
        if (findConsultationSlot(seed, payload.slotId)) {
          throw createValidationError(
            { slotId: "Слот принадлежит другой консультации." },
            "consultationId и slotId не образуют допустимую пару.",
          );
        }
        throw new RepositoryError(ERROR_CODES.NOT_FOUND, "Выбранный слот не найден.", {
          fields: { slotId: "Выберите слот из актуального каталога." },
        });
      }
      if (!getInstitute(seed, payload.instituteId)) {
        throw createValidationError({ instituteId: "Выбранный институт отсутствует в справочнике." });
      }
      if (!isInstituteAllowed(consultation, payload.instituteId)) {
        throw createValidationError({ instituteId: "Эта консультация недоступна для выбранного института." });
      }

      const currentDate = resolveNow(now);
      if (!isFutureSlot(slot, currentDate) || slot.isOpen === false) {
        throw createValidationError(
          { slotId: "Слот уже прошёл или закрыт для записи." },
          "Выбранный слот недоступен для новой записи.",
        );
      }
      if (activeCount(state.local.bookings, payload.slotId) >= slot.capacity) {
        throw new RepositoryError(ERROR_CODES.SLOT_FULL, "На выбранный слот не осталось мест.", {
          fields: { slotId: "Выберите другой слот." },
        });
      }
      const duplicate = state.local.bookings.some(
        (booking) => booking.slotId === payload.slotId && booking.status === BOOKING_STATUS.ACTIVE,
      );
      if (duplicate) {
        throw new RepositoryError(
          ERROR_CODES.DUPLICATE_BOOKING,
          "У вас уже есть активная запись на этот слот.",
          { fields: { slotId: "Отмените текущую запись перед повторным оформлением." } },
        );
      }

      const booking = {
        id: createBookingId(options.crypto),
        consultationId: consultation.id,
        slotId: slot.id,
        instituteId: payload.instituteId,
        displayName: payload.displayName,
        need: payload.need,
        needTags: [...payload.needTags],
        title: consultation.title,
        topicId: consultation.topicId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        mode: slot.mode,
        location: slot.location,
        durationMinutes: consultation.durationMinutes,
        consultantLabel: consultation.consultantLabel,
        status: BOOKING_STATUS.ACTIVE,
        createdAt: currentDate.toISOString(),
        cancelledAt: null,
        idempotencyKey: normalizedKey,
        idempotencyHash,
        cancelIdempotencyKey: null,
        cancelIdempotencyKeys: [],
      };
      state.local.bookings.push(booking);
      return { result: booking, changed: true };
    }, storageOptions);
  }

  async function listBookings(listOptions = {}) {
    if (!isObject(listOptions)) {
      throw createValidationError({ options: "Передайте объект параметров." }, "Некорректные параметры списка.");
    }
    const normalizedStatus = normalizeBookingStatus(listOptions.status);
    const state = readState(storageOptions);
    assertOwner(state, listOptions.ownerToken);
    return state.local.bookings
      .filter((booking) => normalizedStatus === null || booking.status === normalizedStatus)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .map(copyJson);
  }

  async function cancelBooking(cancelOptions = {}) {
    assertStorageMutationsAvailable(storageOptions);
    const source = isObject(cancelOptions) ? cancelOptions : {};
    const bookingId = normalizeIdentifier(source.bookingId);
    const normalizedKey = normalizeIdempotencyKey(source.idempotencyKey);
    if (!bookingId) {
      throw createValidationError({ bookingId: "Укажите ID записи." }, "Некорректный ID записи.");
    }

    return updateState((state) => {
      assertOwner(state, source.ownerToken);
      const booking = state.local.bookings.find(({ id }) => id === bookingId);
      if (!booking) {
        throw new RepositoryError(ERROR_CODES.NOT_FOUND, "Запись не найдена.", {
          fields: { bookingId: "Обновите список записей." },
        });
      }
      const keyUsedByAnotherBooking = state.local.bookings.some((candidate) =>
        candidate.id !== bookingId && getCancelIdempotencyKeys(candidate).includes(normalizedKey));
      if (keyUsedByAnotherBooking) {
        throw new RepositoryError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "Этот ключ отмены уже связан с другой записью.",
          { fields: { idempotencyKey: "Используйте новый ключ отмены для этой записи." } },
        );
      }

      const keyAlreadyUsed = getCancelIdempotencyKeys(booking).includes(normalizedKey);
      if (booking.status === BOOKING_STATUS.CANCELLED && keyAlreadyUsed) {
        return { result: booking, changed: false };
      }

      rememberCancelIdempotencyKey(booking, normalizedKey);
      if (booking.status === BOOKING_STATUS.CANCELLED) {
        return { result: booking, changed: true };
      }

      booking.status = BOOKING_STATUS.CANCELLED;
      booking.cancelledAt = resolveNow(now).toISOString();
      return { result: booking, changed: true };
    }, storageOptions);
  }

  async function getAnalytics(filters = {}) {
    const normalizedFilters = normalizeAnalyticsFilters(filters);
    const [seed, state] = await Promise.all([
      loadSeed(),
      Promise.resolve().then(() => readState(storageOptions)),
    ]);
    return buildLocalAnalytics(seed, state.local.bookings, normalizedFilters, now);
  }

  const capabilities = getStorageCapabilities(storageOptions);
  return Object.freeze({
    mode: LOCAL_MODE,
    scope: LOCAL_ANALYTICS_SCOPE,
    atomicity: capabilities.atomicity,
    crossTabLock: capabilities.crossTabLock,
    mutationsAvailable: capabilities.mutationsAvailable,
    getCatalog,
    listBookings,
    createBooking,
    cancelBooking,
    getAnalytics,
  });
}
