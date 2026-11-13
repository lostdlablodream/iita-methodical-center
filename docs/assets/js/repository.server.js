import { API_PREFIX, buildApiUrl, requestJson } from "./api.js";
import { BOOKING_STATUS, CONSULTATION_FORMAT } from "./domain.js";
import { ERROR_CODES, RepositoryError, createValidationError } from "./errors.js";
import {
  normalizeAnalyticsFilters,
  normalizeBookingInput,
  normalizeBookingStatus,
  normalizeCatalogFilters,
  normalizeIdempotencyKey,
} from "./repository.local.js";
import { copyJson, getOwnerToken } from "./storage.js";

export const SERVER_MODE = "server";
export const SERVER_ANALYTICS_SCOPE = "server";

function invalidResponse(message) {
  return new RepositoryError(ERROR_CODES.INVALID_RESPONSE, message, { retryable: true });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateString(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function validateCatalog(catalog) {
  const valid = isObject(catalog)
    && Array.isArray(catalog.institutes)
    && catalog.institutes.every((institute) => isObject(institute)
      && isNonEmptyString(institute.id)
      && isNonEmptyString(institute.name))
    && Array.isArray(catalog.topics)
    && catalog.topics.every((topic) => isObject(topic)
      && isNonEmptyString(topic.id)
      && isNonEmptyString(topic.name))
    && Array.isArray(catalog.consultations)
    && catalog.consultations.every((consultation) => isObject(consultation)
      && isNonEmptyString(consultation.id)
      && isNonEmptyString(consultation.topicId)
      && isNonEmptyString(consultation.title)
      && typeof consultation.summary === "string"
      && typeof consultation.description === "string"
      && isNonEmptyString(consultation.consultantLabel)
      && Array.isArray(consultation.tags)
      && consultation.tags.every((tag) => typeof tag === "string")
      && Array.isArray(consultation.instituteIds)
      && consultation.instituteIds.every(isNonEmptyString)
      && Number.isInteger(consultation.durationMinutes)
      && consultation.durationMinutes > 0
      && Array.isArray(consultation.slots)
      && consultation.slots.every((slot) => isObject(slot)
        && isNonEmptyString(slot.id)
        && isDateString(slot.startsAt)
        && isDateString(slot.endsAt)
        && Object.values(CONSULTATION_FORMAT).includes(slot.mode)
        && typeof slot.location === "string"
        && Number.isInteger(slot.capacity)
        && slot.capacity > 0
        && Number.isInteger(slot.reservedCount)
        && slot.reservedCount >= 0
        && slot.reservedCount <= slot.capacity
        && Number.isInteger(slot.remainingCount)
        && slot.remainingCount >= 0
        && slot.remainingCount <= slot.capacity
        && typeof slot.isOpen === "boolean"));
  if (!valid) {
    throw invalidResponse("Сервер вернул каталог неподдерживаемой структуры.");
  }
  return catalog;
}

function validateBooking(booking) {
  const valid = isObject(booking)
    && isNonEmptyString(booking.id)
    && isNonEmptyString(booking.consultationId)
    && isNonEmptyString(booking.slotId)
    && isNonEmptyString(booking.instituteId)
    && typeof booking.displayName === "string"
    && booking.displayName.length >= 2
    && booking.displayName.length <= 80
    && typeof booking.need === "string"
    && booking.need.length >= 10
    && booking.need.length <= 1000
    && Array.isArray(booking.needTags)
    && booking.needTags.every(isNonEmptyString)
    && isNonEmptyString(booking.title)
    && isNonEmptyString(booking.topicId)
    && isDateString(booking.startsAt)
    && isDateString(booking.endsAt)
    && Object.values(CONSULTATION_FORMAT).includes(booking.mode)
    && typeof booking.location === "string"
    && isNonEmptyString(booking.consultantLabel)
    && Number.isInteger(booking.durationMinutes)
    && booking.durationMinutes > 0
    && Object.values(BOOKING_STATUS).includes(booking.status)
    && isDateString(booking.createdAt)
    && (booking.cancelledAt === null || isDateString(booking.cancelledAt));
  if (!valid) {
    throw invalidResponse("Сервер вернул запись неподдерживаемой структуры.");
  }
  return booking;
}

function unwrapBooking(payload) {
  return validateBooking(isObject(payload) && isObject(payload.booking) ? payload.booking : payload);
}

function validateAnalytics(analytics) {
  const valid = isObject(analytics)
    && isNonEmptyString(analytics.scope)
    && isDateString(analytics.generatedAt)
    && Number.isInteger(analytics.totalActive)
    && analytics.totalActive >= 0
    && isObject(analytics.byInstitute)
    && isObject(analytics.byTopic)
    && isObject(analytics.byFormat)
    && isObject(analytics.byNeedTag);
  if (!valid) {
    throw invalidResponse("Сервер вернул аналитику неподдерживаемой структуры.");
  }
  return analytics;
}

function resolveOwnerToken(ownerToken, storageOptions) {
  if (ownerToken === undefined || ownerToken === null) {
    return getOwnerToken(storageOptions);
  }
  const normalized = typeof ownerToken === "string" ? ownerToken.trim() : "";
  if (!normalized) {
    throw new RepositoryError(ERROR_CODES.OWNER_MISMATCH, "Укажите непустой owner token.", {
      status: 401,
      fields: { ownerToken: "Токен не должен быть пустым." },
    });
  }
  return normalized;
}

export function isValidServerHealth(health) {
  return isObject(health)
    && health.status === "ok"
    && health.apiVersion === 1
    && health.mode === SERVER_MODE;
}

export async function checkServerHealth(options = {}) {
  return requestJson(buildApiUrl("health", undefined, options.baseUrl ?? API_PREFIX), {
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    headers: options.headers,
  });
}

export function createServerRepository(options = {}) {
  const baseUrl = options.baseUrl ?? API_PREFIX;
  const storageOptions = { storage: options.storage, crypto: options.crypto };

  async function request(path, requestOptions = {}) {
    const headers = { ...requestOptions.headers };
    if (requestOptions.auth) {
      const ownerToken = resolveOwnerToken(requestOptions.ownerToken, storageOptions);
      headers.Authorization = `Bearer ${ownerToken}`;
    }
    return requestJson(buildApiUrl(path, requestOptions.query, baseUrl), {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      method: requestOptions.method,
      body: requestOptions.body,
      headers,
    });
  }

  async function getCatalog(filters = {}) {
    const normalizedFilters = normalizeCatalogFilters(filters);
    const catalog = await request("catalog", { query: normalizedFilters });
    return copyJson(validateCatalog(catalog));
  }

  async function listBookings(listOptions = {}) {
    if (!isObject(listOptions)) {
      throw createValidationError({ options: "Передайте объект параметров." }, "Некорректные параметры списка.");
    }
    const normalizedStatus = normalizeBookingStatus(listOptions.status);
    const payload = await request("bookings", {
      auth: true,
      ownerToken: listOptions.ownerToken,
      query: normalizedStatus === null ? undefined : { status: normalizedStatus },
    });
    const bookings = Array.isArray(payload)
      ? payload
      : isObject(payload) && Array.isArray(payload.bookings)
        ? payload.bookings
        : null;
    if (!bookings) {
      throw invalidResponse("Сервер вернул список записей неподдерживаемой структуры.");
    }
    return copyJson(bookings.map(validateBooking).sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)));
  }

  async function createBooking(draft, mutationOptions = {}) {
    const payload = normalizeBookingInput(draft);
    const normalizedKey = normalizeIdempotencyKey(mutationOptions?.idempotencyKey);
    const response = await request("bookings", {
      auth: true,
      ownerToken: mutationOptions?.ownerToken,
      method: "POST",
      body: payload,
      headers: { "Idempotency-Key": normalizedKey },
    });
    return copyJson(unwrapBooking(response));
  }

  async function cancelBooking(cancelOptions = {}) {
    const source = isObject(cancelOptions) ? cancelOptions : {};
    const bookingId = typeof source.bookingId === "string" ? source.bookingId.trim() : "";
    const normalizedKey = normalizeIdempotencyKey(source.idempotencyKey);
    if (!bookingId) {
      throw createValidationError({ bookingId: "Укажите ID записи." }, "Некорректный ID записи.");
    }
    const response = await request(`bookings/${encodeURIComponent(bookingId)}/cancel`, {
      auth: true,
      ownerToken: source.ownerToken,
      method: "POST",
      headers: { "Idempotency-Key": normalizedKey },
    });
    return copyJson(unwrapBooking(response));
  }

  async function getAnalytics(filters = {}) {
    const normalizedFilters = normalizeAnalyticsFilters(filters);
    const analytics = await request("analytics", { query: normalizedFilters });
    return copyJson(validateAnalytics(analytics));
  }

  return Object.freeze({
    mode: SERVER_MODE,
    scope: SERVER_ANALYTICS_SCOPE,
    atomicity: "server",
    getCatalog,
    listBookings,
    createBooking,
    cancelBooking,
    getAnalytics,
  });
}
