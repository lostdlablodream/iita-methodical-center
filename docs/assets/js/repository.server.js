import { API_PREFIX, buildApiUrl, requestJson } from "./api.js";
import { BOOKING_STATUS } from "./domain.js";
import { ERROR_CODES, RepositoryError, createValidationError } from "./errors.js";
import { normalizeBookingInput, normalizeIdempotencyKey } from "./repository.local.js";
import { copyJson, getOwnerToken } from "./storage.js";

export const SERVER_MODE = "server";
export const SERVER_ANALYTICS_SCOPE = "server";

function invalidResponse(message) {
  return new RepositoryError(ERROR_CODES.INVALID_RESPONSE, message, { retryable: true });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCatalog(catalog) {
  const valid = isObject(catalog)
    && Array.isArray(catalog.institutes)
    && Array.isArray(catalog.topics)
    && Array.isArray(catalog.consultations)
    && catalog.consultations.every((consultation) => isObject(consultation)
      && typeof consultation.id === "string"
      && Array.isArray(consultation.slots)
      && consultation.slots.every((slot) => isObject(slot) && typeof slot.id === "string"));
  if (!valid) {
    throw invalidResponse("Сервер вернул каталог неподдерживаемой структуры.");
  }
  return catalog;
}

function validateBooking(booking) {
  if (!isObject(booking)
    || typeof booking.id !== "string"
    || !booking.id
    || !Object.values(BOOKING_STATUS).includes(booking.status)) {
    throw invalidResponse("Сервер вернул запись неподдерживаемой структуры.");
  }
  return booking;
}

function unwrapBooking(payload) {
  return validateBooking(isObject(payload) && isObject(payload.booking) ? payload.booking : payload);
}

function validateAnalytics(analytics) {
  const valid = isObject(analytics)
    && typeof analytics.scope === "string"
    && typeof analytics.generatedAt === "string"
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

function normalizeStatus(status) {
  if (status === undefined || status === null) {
    return null;
  }
  const normalized = typeof status === "string" ? status.trim() : "";
  if (!Object.values(BOOKING_STATUS).includes(normalized)) {
    throw createValidationError(
      { status: "Допустимые статусы: active, cancelled." },
      "Некорректный фильтр статуса.",
    );
  }
  return normalized;
}

function normalizeTopicId(topicId) {
  if (topicId === undefined || topicId === null) {
    return null;
  }
  const normalized = typeof topicId === "string" ? topicId.trim() : "";
  if (!normalized) {
    throw createValidationError({ topicId: "Укажите ID темы." }, "Некорректный ID темы.");
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
    const ownerToken = getOwnerToken(storageOptions);
    return requestJson(buildApiUrl(path, requestOptions.query, baseUrl), {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      method: requestOptions.method,
      query: requestOptions.query,
      body: requestOptions.body,
      headers: {
        "X-Client-Token": ownerToken,
        ...requestOptions.headers,
      },
    });
  }

  async function getCatalog() {
    const catalog = await request("catalog");
    return copyJson(validateCatalog(catalog));
  }

  async function listBookings(status) {
    const normalizedStatus = normalizeStatus(status);
    const payload = await request("bookings", {
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
    return copyJson(bookings.map(validateBooking));
  }

  async function createBooking(input, idempotencyKey) {
    const payload = normalizeBookingInput(input);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const response = await request("bookings", {
      method: "POST",
      body: payload,
      headers: { "Idempotency-Key": normalizedKey },
    });
    return copyJson(unwrapBooking(response));
  }

  async function cancelBooking(id) {
    const bookingId = typeof id === "string" ? id.trim() : "";
    if (!bookingId) {
      throw createValidationError({ id: "Укажите ID записи." }, "Некорректный ID записи.");
    }
    const response = await request(`bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: "POST",
    });
    return copyJson(unwrapBooking(response));
  }

  async function getAnalytics(topicId) {
    const normalizedTopicId = normalizeTopicId(topicId);
    const analytics = await request("analytics", {
      query: normalizedTopicId === null ? undefined : { topicId: normalizedTopicId },
    });
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
