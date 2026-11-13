export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  SLOT_FULL: "SLOT_FULL",
  DUPLICATE_BOOKING: "DUPLICATE_BOOKING",
  OWNER_MISMATCH: "OWNER_MISMATCH",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  STORAGE_CORRUPT: "STORAGE_CORRUPT",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  DETECTION_FAILED: "DETECTION_FAILED",
});

const DEFAULT_STATUS = Object.freeze({
  [ERROR_CODES.VALIDATION_ERROR]: 422,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.SLOT_FULL]: 409,
  [ERROR_CODES.DUPLICATE_BOOKING]: 409,
  [ERROR_CODES.OWNER_MISMATCH]: 403,
  [ERROR_CODES.IDEMPOTENCY_CONFLICT]: 409,
  [ERROR_CODES.STORAGE_UNAVAILABLE]: 503,
  [ERROR_CODES.STORAGE_CORRUPT]: 500,
  [ERROR_CODES.UPSTREAM_UNAVAILABLE]: 503,
  [ERROR_CODES.UPSTREAM_TIMEOUT]: 504,
  [ERROR_CODES.INVALID_RESPONSE]: 502,
  [ERROR_CODES.DETECTION_FAILED]: 503,
});

export class RepositoryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RepositoryError";
    this.code = code || ERROR_CODES.UPSTREAM_UNAVAILABLE;
    this.status = Number.isInteger(options.status)
      ? options.status
      : DEFAULT_STATUS[this.code] ?? null;
    this.fields = { ...(options.fields ?? options.fieldErrors ?? {}) };
    this.fieldErrors = this.fields;
    this.retryable = Boolean(options.retryable);

    if (options.contentType !== undefined) {
      this.contentType = options.contentType;
    }
    if (options.isHtml !== undefined) {
      this.isHtml = Boolean(options.isHtml);
    }
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      fields: { ...this.fields },
      retryable: this.retryable,
    };
  }
}

export function isRepositoryError(value, code) {
  return value instanceof RepositoryError && (code === undefined || value.code === code);
}

export function normalizeRepositoryError(
  error,
  code = ERROR_CODES.UPSTREAM_UNAVAILABLE,
  message = "Не удалось выполнить операцию. Попробуйте ещё раз.",
) {
  if (isRepositoryError(error)) {
    return error;
  }

  return new RepositoryError(code, message, { cause: error, retryable: true });
}

export function createValidationError(fields, message = "Проверьте заполнение полей записи.") {
  return new RepositoryError(ERROR_CODES.VALIDATION_ERROR, message, { fields });
}
