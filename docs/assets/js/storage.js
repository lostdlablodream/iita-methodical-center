import { STATE_VERSION, STORAGE_KEY } from "./config.js";
import { BOOKING_STATUS } from "./domain.js";
import { ERROR_CODES, RepositoryError, isRepositoryError } from "./errors.js";

export { STATE_VERSION, STORAGE_KEY };

export const STATE_SCHEMA_VERSION = STATE_VERSION;
export const STORAGE_LOCK_NAME = `${STORAGE_KEY}.write`;
export const OWNER_TOKEN_BYTES = 32;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function copyJson(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function storageError(message, cause) {
  return new RepositoryError(ERROR_CODES.STORAGE_UNAVAILABLE, message, {
    cause,
    retryable: true,
  });
}

function corruptStateError(message = "Локальное состояние повреждено. Данные не были перезаписаны.") {
  return new RepositoryError(ERROR_CODES.STORAGE_CORRUPT, message);
}

function resolveStorage(storage) {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return globalThis.localStorage;
  } catch (error) {
    throw storageError("Браузер не разрешил доступ к локальному хранилищу.", error);
  }
}

function resolveCrypto(cryptoImpl) {
  if (cryptoImpl !== undefined) {
    return cryptoImpl;
  }
  return globalThis.crypto;
}

function randomBytes(cryptoImpl) {
  const cryptoApi = resolveCrypto(cryptoImpl);
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw storageError("Недоступен криптографический генератор случайных чисел.");
  }
  const bytes = new Uint8Array(OWNER_TOKEN_BYTES);
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

export function createOwnerToken(cryptoImpl) {
  return Array.from(randomBytes(cryptoImpl), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createBookingId(cryptoImpl) {
  const cryptoApi = resolveCrypto(cryptoImpl);
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = randomBytes(cryptoImpl).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createInitialState(cryptoImpl) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    ownerToken: createOwnerToken(cryptoImpl),
    local: {
      revision: 0,
      bookings: [],
    },
  };
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

function validateBooking(booking) {
  if (!isObject(booking)) {
    return false;
  }

  const requiredStrings = [
    "slotId",
    "consultationId",
    "title",
    "topicId",
    "mode",
    "location",
    "consultantLabel",
    "requesterInstituteId",
    "idempotencyKey",
  ];

  return UUID_PATTERN.test(booking.id)
    && requiredStrings.every((field) => isNonEmptyString(booking[field]))
    && isDateString(booking.startsAt)
    && isDateString(booking.endsAt)
    && Number.isInteger(booking.durationMinutes)
    && booking.durationMinutes > 0
    && typeof booking.need === "string"
    && booking.need.length >= 10
    && booking.need.length <= 1000
    && Array.isArray(booking.needTags)
    && booking.needTags.every(isNonEmptyString)
    && Object.values(BOOKING_STATUS).includes(booking.status)
    && isDateString(booking.createdAt)
    && (booking.cancelledAt === null || isDateString(booking.cancelledAt));
}

export function validateState(state) {
  const valid = isObject(state)
    && state.schemaVersion === STATE_SCHEMA_VERSION
    && typeof state.ownerToken === "string"
    && /^[0-9a-f]{64}$/i.test(state.ownerToken)
    && isObject(state.local)
    && Number.isInteger(state.local.revision)
    && state.local.revision >= 0
    && Array.isArray(state.local.bookings)
    && state.local.bookings.every(validateBooking);

  if (!valid) {
    throw corruptStateError();
  }
  return state;
}

export function readState(options = {}) {
  const storage = resolveStorage(options.storage);
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw storageError("Локальное хранилище недоступно в этом окружении.");
  }

  let serialized;
  try {
    serialized = storage.getItem(STORAGE_KEY);
  } catch (error) {
    throw storageError("Не удалось прочитать локальное состояние.", error);
  }

  if (serialized === null || serialized === undefined) {
    const initialState = createInitialState(options.crypto);
    writeState(initialState, options);
    return initialState;
  }
  if (typeof serialized !== "string") {
    throw corruptStateError();
  }

  let state;
  try {
    state = JSON.parse(serialized);
  } catch (error) {
    throw corruptStateError("Локальное состояние содержит некорректный JSON и не было изменено.");
  }

  return validateState(state);
}

export function writeState(state, options = {}) {
  validateState(state);
  const storage = resolveStorage(options.storage);
  if (!storage || typeof storage.setItem !== "function") {
    throw storageError("Локальное хранилище недоступно для записи.");
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    throw storageError("Не удалось сохранить локальное состояние. Запись не подтверждена.", error);
  }
  return state;
}

export function getOwnerToken(options = {}) {
  return readState(options).ownerToken;
}

function resolveLocks(locks) {
  if (locks !== undefined) {
    return locks;
  }
  try {
    return globalThis.navigator?.locks;
  } catch {
    return undefined;
  }
}

export function getStorageCapabilities(options = {}) {
  const locks = resolveLocks(options.locks);
  const hasLocks = Boolean(locks && typeof locks.request === "function");
  return Object.freeze({
    crossTabLock: hasLocks,
    atomicity: hasLocks ? "navigator.locks" : "best-effort",
  });
}

export async function withStorageLock(callback, options = {}) {
  const locks = resolveLocks(options.locks);
  if (!locks || typeof locks.request !== "function") {
    return callback();
  }

  try {
    return await locks.request(STORAGE_LOCK_NAME, { mode: "exclusive" }, callback);
  } catch (error) {
    if (isRepositoryError(error)) {
      throw error;
    }
    throw storageError("Не удалось сериализовать запись локального состояния.", error);
  }
}

export async function updateState(mutator, options = {}) {
  return withStorageLock(async () => {
    const state = readState(options);
    const outcome = await mutator(state);
    if (!isObject(outcome) || !("result" in outcome)) {
      throw new TypeError("updateState mutator должен вернуть { result, changed }");
    }

    if (outcome.changed) {
      state.local.revision += 1;
      writeState(state, options);
    }
    return copyJson(outcome.result);
  }, options);
}
