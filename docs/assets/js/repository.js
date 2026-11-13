import { ERROR_CODES, RepositoryError } from "./errors.js";
import { LOCAL_MODE, createLocalRepository } from "./repository.local.js";
import {
  SERVER_MODE,
  checkServerHealth,
  createServerRepository,
  isValidServerHealth,
} from "./repository.server.js";

export {
  ERROR_CODES,
  RepositoryError,
  isRepositoryError,
  normalizeRepositoryError,
} from "./errors.js";
export { LOCAL_MODE, SERVER_MODE };

export const REPOSITORY_MODES = Object.freeze({
  LOCAL: LOCAL_MODE,
  SERVER: SERVER_MODE,
});
export const SESSION_MODE_KEY = "iita.consultations.repository-mode.v1";

let rememberedMode = null;
let defaultRepository = null;
let defaultRepositoryPromise = null;

function resolveSessionStorage(options = {}) {
  if (options && typeof options.getItem === "function") {
    return options;
  }
  if (Object.hasOwn(options, "sessionStorage")) {
    return options.sessionStorage;
  }
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function isMode(value) {
  return value === LOCAL_MODE || value === SERVER_MODE;
}

export function getSelectedMode(options = {}) {
  const storage = resolveSessionStorage(options);
  if (storage && typeof storage.getItem === "function") {
    try {
      const selected = storage.getItem(SESSION_MODE_KEY);
      if (isMode(selected)) {
        rememberedMode = selected;
        return selected;
      }
    } catch {
      return rememberedMode;
    }
  }
  return rememberedMode;
}

export function setSelectedMode(mode, options = {}) {
  if (!isMode(mode)) {
    throw new TypeError("Режим repository должен быть local или server");
  }
  rememberedMode = mode;
  const storage = resolveSessionStorage(options);
  if (!storage || typeof storage.setItem !== "function") {
    return false;
  }
  try {
    storage.setItem(SESSION_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export function clearSelectedMode(options = {}) {
  rememberedMode = null;
  const storage = resolveSessionStorage(options);
  if (!storage || typeof storage.removeItem !== "function") {
    return false;
  }
  try {
    storage.removeItem(SESSION_MODE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function detectRepositoryMode(options = {}) {
  let health;
  try {
    health = await checkServerHealth(options);
  } catch (error) {
    if (error instanceof RepositoryError) {
      if (error.status === 404 || error.status === 405
        || (error.code === ERROR_CODES.INVALID_RESPONSE && error.isHtml)) {
        return LOCAL_MODE;
      }
      if (error.code === ERROR_CODES.UPSTREAM_TIMEOUT) {
        throw new RepositoryError(
          ERROR_CODES.UPSTREAM_TIMEOUT,
          "Не удалось определить режим: health API не ответил вовремя. "
            + "Повторите проверку или явно вызовите forceLocalRepository().",
          { cause: error, retryable: true },
        );
      }
      if (error.code === ERROR_CODES.UPSTREAM_UNAVAILABLE) {
        throw new RepositoryError(
          ERROR_CODES.UPSTREAM_UNAVAILABLE,
          "Не удалось определить режим из-за сетевой ошибки. "
            + "Local mode автоматически не включён; используйте forceLocalRepository() только для отдельной локальной записи.",
          { cause: error, retryable: true },
        );
      }
      throw new RepositoryError(
        ERROR_CODES.DETECTION_FAILED,
        "Health API вернул неподдерживаемый ответ; режим автоматически не изменён.",
        {
          status: error.status,
          cause: error,
          retryable: error.retryable,
        },
      );
    }
    throw error;
  }

  if (isValidServerHealth(health)) {
    return SERVER_MODE;
  }
  throw new RepositoryError(
    ERROR_CODES.DETECTION_FAILED,
    "Health API должен вернуть {status:'ok', apiVersion:1, mode:'server'}; local mode не включён автоматически.",
    { retryable: true },
  );
}

function constructRepository(mode, options) {
  return mode === SERVER_MODE
    ? createServerRepository(options)
    : createLocalRepository(options);
}

async function selectRepository(options = {}) {
  if (options.forceLocal === true || options.mode === LOCAL_MODE) {
    setSelectedMode(LOCAL_MODE, options);
    return createLocalRepository(options);
  }
  if (options.mode !== undefined && options.mode !== "auto" && options.mode !== SERVER_MODE) {
    throw new TypeError("mode должен быть auto, local или server");
  }

  let mode = options.mode === SERVER_MODE ? SERVER_MODE : getSelectedMode(options);
  if (!mode) {
    mode = await detectRepositoryMode(options);
  }
  setSelectedMode(mode, options);
  return constructRepository(mode, options);
}

function isDefaultCall(options) {
  return Object.keys(options).length === 0;
}

export async function getRepository(options = {}) {
  if (!isDefaultCall(options)) {
    return selectRepository(options);
  }
  if (defaultRepository) {
    return defaultRepository;
  }
  if (defaultRepositoryPromise) {
    return defaultRepositoryPromise;
  }

  defaultRepositoryPromise = selectRepository()
    .then((repository) => {
      defaultRepository = repository;
      return repository;
    })
    .finally(() => {
      defaultRepositoryPromise = null;
    });
  return defaultRepositoryPromise;
}

export async function forceLocalRepository(options = {}) {
  const repository = createLocalRepository(options);
  setSelectedMode(LOCAL_MODE, options);
  if (isDefaultCall(options)) {
    defaultRepository = repository;
  }
  return repository;
}

export function resetRepository(options = {}) {
  defaultRepository = null;
  defaultRepositoryPromise = null;
  return clearSelectedMode(options);
}

export function getRepositoryMode(repositoryOrMode) {
  if (isMode(repositoryOrMode)) {
    return repositoryOrMode;
  }
  return isMode(repositoryOrMode?.mode) ? repositoryOrMode.mode : null;
}

export function isLocalMode(repositoryOrMode) {
  return getRepositoryMode(repositoryOrMode) === LOCAL_MODE;
}

export function isServerMode(repositoryOrMode) {
  return getRepositoryMode(repositoryOrMode) === SERVER_MODE;
}
