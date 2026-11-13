import { API_PREFIX } from "./config.js";
import { ERROR_CODES, RepositoryError } from "./errors.js";

export { API_PREFIX };
export const DEFAULT_API_TIMEOUT_MS = 8000;

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function buildApiUrl(path, query, baseUrl = API_PREFIX) {
  const prefix = String(baseUrl).replace(/\/+$/, "");
  const suffix = String(path).replace(/^\/+/, "");
  const url = `${prefix}/${suffix}`;
  if (!query) {
    return url;
  }

  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(name, String(value));
    }
  }
  const serialized = params.toString();
  return serialized ? `${url}?${serialized}` : url;
}

function invalidResponse(message, options = {}) {
  return new RepositoryError(ERROR_CODES.INVALID_RESPONSE, message, options);
}

function responseErrorCode(status, payloadCode) {
  if (typeof payloadCode === "string" && Object.values(ERROR_CODES).includes(payloadCode)) {
    return payloadCode;
  }
  if (status === 400 || status === 422) {
    return ERROR_CODES.VALIDATION_ERROR;
  }
  if (status === 401 || status === 403) {
    return ERROR_CODES.OWNER_MISMATCH;
  }
  if (status === 404) {
    return ERROR_CODES.NOT_FOUND;
  }
  if (status === 409) {
    return ERROR_CODES.SLOT_FULL;
  }
  if (status === 408 || status === 504) {
    return ERROR_CODES.UPSTREAM_TIMEOUT;
  }
  return ERROR_CODES.UPSTREAM_UNAVAILABLE;
}

function responseErrorMessage(status, code) {
  switch (code) {
    case ERROR_CODES.VALIDATION_ERROR:
      return "Сервер отклонил переданные данные. Проверьте поля записи.";
    case ERROR_CODES.NOT_FOUND:
      return "Запрошенные данные не найдены.";
    case ERROR_CODES.SLOT_FULL:
      return "На выбранный слот не осталось мест.";
    case ERROR_CODES.DUPLICATE_BOOKING:
      return "Активная запись на этот слот уже существует.";
    case ERROR_CODES.IDEMPOTENCY_CONFLICT:
      return "Ключ идемпотентности уже использован для другого запроса.";
    case ERROR_CODES.OWNER_MISMATCH:
      return "Сервер не подтвердил доступ к этой записи.";
    case ERROR_CODES.UPSTREAM_TIMEOUT:
      return "Сервер не ответил вовремя.";
    default:
      return status === 429
        ? "Слишком много запросов. Повторите попытку позже."
        : "Сервер временно недоступен. Локальная запись не выполнялась.";
  }
}

export function mapResponseError(status, payload) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const nested = body.error && typeof body.error === "object" && !Array.isArray(body.error)
    ? body.error
    : {};
  const payloadCode = nested.code ?? body.code;
  const code = responseErrorCode(status, payloadCode);
  const suppliedMessage = nested.message
    ?? body.message
    ?? (typeof body.error === "string" ? body.error : undefined);
  const fields = nested.fields ?? nested.fieldErrors ?? body.fields ?? body.fieldErrors ?? {};

  return new RepositoryError(code,
    typeof suppliedMessage === "string" && suppliedMessage.trim()
      ? suppliedMessage
      : responseErrorMessage(status, code),
    {
      status,
      fields: fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {},
      retryable: RETRYABLE_STATUSES.has(status)
        || code === ERROR_CODES.UPSTREAM_UNAVAILABLE
        || code === ERROR_CODES.UPSTREAM_TIMEOUT,
    });
}

function looksLikeHtml(contentType, text) {
  return /(?:text|application)\/(?:xhtml\+xml|html)/i.test(contentType)
    || /^\s*<(?:!doctype\s+html|html\b)/i.test(text);
}

async function readJsonResponse(response) {
  const status = Number.isInteger(response?.status) ? response.status : 0;
  const contentType = response?.headers?.get?.("content-type") ?? "";
  let data;

  if (typeof response?.text === "function") {
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw invalidResponse("Не удалось прочитать ответ сервера.", {
        status,
        cause: error,
        contentType,
        retryable: true,
      });
    }

    if (looksLikeHtml(contentType, text)) {
      throw invalidResponse("Вместо JSON получен HTML-документ.", {
        status,
        contentType: contentType || "text/html",
        isHtml: true,
      });
    }
    if (contentType && !/(?:application|text)\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) {
      throw invalidResponse("Сервер вернул ответ не в формате JSON.", {
        status,
        contentType,
      });
    }
    if (!text.trim()) {
      data = null;
    } else {
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw invalidResponse("Сервер вернул некорректный JSON.", {
          status,
          cause: error,
          contentType,
        });
      }
    }
  } else if (typeof response?.json === "function") {
    try {
      data = await response.json();
    } catch (error) {
      throw invalidResponse("Сервер вернул некорректный JSON.", {
        status,
        cause: error,
        contentType,
        isHtml: /html/i.test(contentType),
      });
    }
  } else {
    throw invalidResponse("Ответ сервера не поддерживает чтение JSON.", { status, contentType });
  }

  const ok = typeof response?.ok === "boolean"
    ? response.ok
    : status >= 200 && status < 300;
  return { status, ok, data, contentType };
}

export async function requestJson(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RepositoryError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      "Fetch API недоступен. Локальная запись вместо серверной не выполнялась.",
      { retryable: false },
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs должен быть положительным числом");
  }

  const headers = { Accept: "application/json", ...options.headers };
  const request = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) {
    try {
      request.body = JSON.stringify(options.body);
    } catch (error) {
      throw new RepositoryError(ERROR_CODES.VALIDATION_ERROR, "Тело запроса не сериализуется в JSON.", {
        status: 400,
        cause: error,
      });
    }
    headers["Content-Type"] = "application/json";
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  if (controller) {
    request.signal = controller.signal;
  }

  let timeoutId;
  let didTimeout = false;
  const execute = async () => {
    const response = await fetchImpl(url, request);
    return readJsonResponse(response);
  };
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller?.abort();
      reject(new RepositoryError(
        ERROR_CODES.UPSTREAM_TIMEOUT,
        `Сервер не ответил за ${timeoutMs} мс. Локальная запись вместо серверной не выполнялась.`,
        { retryable: true },
      ));
    }, timeoutMs);
  });

  let result;
  try {
    result = await Promise.race([execute(), timeout]);
  } catch (error) {
    if (error instanceof RepositoryError) {
      throw error;
    }
    if (didTimeout || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new RepositoryError(
        ERROR_CODES.UPSTREAM_TIMEOUT,
        "Сервер не ответил вовремя. Локальная запись вместо серверной не выполнялась.",
        { cause: error, retryable: true },
      );
    }
    throw new RepositoryError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      "Не удалось связаться с сервером. Локальная запись вместо серверной не выполнялась.",
      { cause: error, retryable: true },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!result.ok) {
    throw mapResponseError(result.status, result.data);
  }
  return result.data;
}
