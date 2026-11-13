import { SEED_URL } from "./config.js";
import {
  BOOKING_STATUS,
  CONSULTATION_FORMAT,
  NEED_TAGS,
  findConsultationSlot,
  getInstitute,
  getTopic,
  isFutureSlot,
  isInstituteAllowed,
} from "./domain.js";
import { ERROR_CODES, RepositoryError, createValidationError } from "./errors.js";
import {
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
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.some((tag) => typeof tag !== "string")) {
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

export function normalizeBookingInput(input) {
  const source = isObject(input) ? input : {};
  const normalized = {
    slotId: normalizeIdentifier(source.slotId),
    requesterInstituteId: normalizeIdentifier(source.requesterInstituteId),
    need: normalizeNeed(source.need),
    needTags: normalizeNeedTags(source.needTags),
  };
  const fields = {};

  if (!normalized.slotId) {
    fields.slotId = "Выберите слот консультации.";
  }
  if (!normalized.requesterInstituteId) {
    fields.requesterInstituteId = "Выберите институт.";
  }
  if (normalized.need.length < NEED_MIN_LENGTH || normalized.need.length > NEED_MAX_LENGTH) {
    fields.need = `Опишите потребность: от ${NEED_MIN_LENGTH} до ${NEED_MAX_LENGTH} символов после trim.`;
  }
  if (normalized.needTags === null) {
    fields.needTags = "Теги потребности должны быть массивом строк.";
  } else if (
    normalized.needTags.some((tag) => !ALLOWED_NEED_TAGS.includes(tag))
  ) {
    fields.needTags = `Допустимые теги: ${ALLOWED_NEED_TAGS.join(", ")}.`;
  }

  if (Object.keys(fields).length > 0) {
    throw createValidationError(fields);
  }
  return normalized;
}

function normalizeListStatus(status) {
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

function samePayload(booking, payload) {
  return booking.slotId === payload.slotId
    && booking.requesterInstituteId === payload.requesterInstituteId
    && booking.need === payload.need
    && JSON.stringify(booking.needTags) === JSON.stringify(payload.needTags);
}

function activeCount(bookings, slotId) {
  return bookings.reduce(
    (count, booking) => count + Number(booking.slotId === slotId && booking.status === BOOKING_STATUS.ACTIVE),
    0,
  );
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
      && Array.isArray(consultation.instituteIds)
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
  if (topicId === undefined || topicId === null) {
    return null;
  }
  const normalized = normalizeIdentifier(topicId);
  if (!normalized || !getTopic(seed, normalized)) {
    throw createValidationError(
      { topicId: "Выберите тему из справочника." },
      "Неизвестная тема аналитики.",
    );
  }
  return normalized;
}

export function buildLocalAnalytics(seed, bookings, topicId, now) {
  const selectedTopicId = requireTopic(seed, topicId);
  const active = bookings.filter((booking) => booking.status === BOOKING_STATUS.ACTIVE
    && (selectedTopicId === null || booking.topicId === selectedTopicId));

  const byInstitute = Object.fromEntries(seed.institutes.map(({ id }) => [id, 0]));
  const byTopic = Object.fromEntries(seed.topics.map(({ id }) => [id, 0]));
  const byFormat = Object.fromEntries(Object.values(CONSULTATION_FORMAT).map((mode) => [mode, 0]));
  const byNeedTag = Object.fromEntries(ALLOWED_NEED_TAGS.map((tag) => [tag, 0]));

  for (const booking of active) {
    if (Object.hasOwn(byInstitute, booking.requesterInstituteId)) {
      byInstitute[booking.requesterInstituteId] += 1;
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

  async function getCatalog() {
    const [seed, state] = await Promise.all([
      loadSeed(),
      Promise.resolve().then(() => readState(storageOptions)),
    ]);
    return decorateCatalog(seed, state.local.bookings, now);
  }

  async function createBooking(input, idempotencyKey) {
    const payload = normalizeBookingInput(input);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const seed = await loadSeed();

    return updateState((state) => {
      const existing = state.local.bookings.find(
        (booking) => booking.idempotencyKey === normalizedKey,
      );
      if (existing) {
        if (samePayload(existing, payload)) {
          return { result: existing, changed: false };
        }
        throw new RepositoryError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "Этот ключ идемпотентности уже использован для другого содержимого записи.",
          { fields: { idempotencyKey: "Создайте новый ключ для изменённой записи." } },
        );
      }

      const match = findConsultationSlot(seed, payload.slotId);
      if (!match) {
        throw new RepositoryError(ERROR_CODES.NOT_FOUND, "Выбранный слот не найден.", {
          fields: { slotId: "Выберите слот из актуального каталога." },
        });
      }
      const { consultation, slot } = match;
      if (!getInstitute(seed, payload.requesterInstituteId)) {
        throw createValidationError({
          requesterInstituteId: "Выбранный институт отсутствует в справочнике.",
        });
      }
      if (!isInstituteAllowed(consultation, payload.requesterInstituteId)) {
        throw createValidationError({
          requesterInstituteId: "Эта консультация недоступна для выбранного института.",
        });
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
        (booking) => booking.slotId === payload.slotId
          && booking.status === BOOKING_STATUS.ACTIVE,
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
        slotId: slot.id,
        consultationId: consultation.id,
        title: consultation.title,
        topicId: consultation.topicId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        mode: slot.mode,
        location: slot.location,
        durationMinutes: consultation.durationMinutes,
        consultantLabel: consultation.consultantLabel,
        requesterInstituteId: payload.requesterInstituteId,
        need: payload.need,
        needTags: [...payload.needTags],
        status: BOOKING_STATUS.ACTIVE,
        createdAt: currentDate.toISOString(),
        cancelledAt: null,
        idempotencyKey: normalizedKey,
      };
      state.local.bookings.push(booking);
      return { result: booking, changed: true };
    }, storageOptions);
  }

  async function listBookings(status) {
    const normalizedStatus = normalizeListStatus(status);
    const state = readState(storageOptions);
    return state.local.bookings
      .filter((booking) => normalizedStatus === null || booking.status === normalizedStatus)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt)
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .map(copyJson);
  }

  async function cancelBooking(id) {
    const bookingId = normalizeIdentifier(id);
    if (!bookingId) {
      throw createValidationError({ id: "Укажите ID записи." }, "Некорректный ID записи.");
    }

    return updateState((state) => {
      const booking = state.local.bookings.find(({ id: currentId }) => currentId === bookingId);
      if (!booking) {
        throw new RepositoryError(ERROR_CODES.NOT_FOUND, "Запись не найдена.", {
          fields: { id: "Обновите список записей." },
        });
      }
      if (booking.status === BOOKING_STATUS.CANCELLED) {
        return { result: booking, changed: false };
      }

      booking.status = BOOKING_STATUS.CANCELLED;
      booking.cancelledAt = resolveNow(now).toISOString();
      return { result: booking, changed: true };
    }, storageOptions);
  }

  async function getAnalytics(topicId) {
    const [seed, state] = await Promise.all([
      loadSeed(),
      Promise.resolve().then(() => readState(storageOptions)),
    ]);
    return buildLocalAnalytics(seed, state.local.bookings, topicId, now);
  }

  const capabilities = getStorageCapabilities(storageOptions);
  return Object.freeze({
    mode: LOCAL_MODE,
    scope: LOCAL_ANALYTICS_SCOPE,
    atomicity: capabilities.atomicity,
    crossTabLock: capabilities.crossTabLock,
    getCatalog,
    listBookings,
    createBooking,
    cancelBooking,
    getAnalytics,
  });
}
