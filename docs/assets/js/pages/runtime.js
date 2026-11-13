import { clearElement, createElement } from "../components.js";
import {
  LOCAL_MODE,
  SERVER_MODE,
  forceLocalRepository,
  getRepository,
  getRepositoryMode,
  normalizeRepositoryError,
} from "../repository.js";

export function getPublicErrorMessage(error) {
  return normalizeRepositoryError(error).message;
}

function getModeCopy(mode) {
  if (mode === LOCAL_MODE) {
    return {
      badge: "Local · этот браузер",
      title: "Local mode: записи только в этом браузере",
      text: "Локальный демонстрационный режим. Записи хранятся только в этом браузере, не синхронизируются между устройствами и могут быть удалены при очистке данных.",
    };
  }
  if (mode === SERVER_MODE) {
    return {
      badge: "Server · общий демо API",
      title: "Server mode: общий демонстрационный API",
      text: "Серверный демонстрационный режим. Каталог и записи используют общий учебный API; это не официальное расписание и не рабочая система ИИТА.",
    };
  }
  return {
    badge: "Режим не определён",
    title: "Режим repository не определён",
    text: "Режим хранения пока не выбран.",
  };
}

function createAction(text, attribute) {
  return createElement("button", {
    className: "button button-secondary",
    text,
    attributes: { type: "button", [attribute]: "true" },
  });
}

export function createRepositoryRuntime({ root = document, onStateChange = () => {} } = {}) {
  const alert = root.querySelector("[data-repository-alert]");
  const badges = [...root.querySelectorAll("[data-mode-badge]")];
  let requestNumber = 0;
  let state = { status: "idle", repository: null, error: null };

  function render() {
    const mode = getRepositoryMode(state.repository);
    const copy = getModeCopy(mode);
    const isLoading = state.status === "loading";
    const isError = state.status === "error";

    for (const badge of badges) {
      badge.textContent = isLoading ? "Определяем режим…" : copy.badge;
      badge.title = isLoading ? "Проверяем доступность общего демонстрационного API" : copy.title;
      badge.setAttribute("aria-label", isLoading ? "Определение режима repository" : copy.title);
      badge.classList.toggle("badge-neutral", isLoading || isError);
    }

    if (!alert) {
      return;
    }

    alert.className = `alert ${isError ? "alert-error" : "alert-info"}`;
    alert.setAttribute("role", isError ? "alert" : "status");
    clearElement(alert);

    if (isLoading) {
      alert.append(createElement("strong", {
        text: state.forceLocal
          ? "Явно подключаем local mode."
          : "Проверяем доступность общего демо API…",
      }));
      alert.append(createElement("p", {
        text: "Дождитесь результата. При сетевой ошибке local mode не включается автоматически.",
      }));
      return;
    }

    if (isError) {
      alert.append(
        createElement("strong", { text: "Не удалось определить или загрузить режим repository." }),
        createElement("p", { text: getPublicErrorMessage(state.error) }),
        createElement("p", {
          text: "Автоматический переход в local не выполнялся: серверные и локальные записи не смешиваются незаметно.",
        }),
      );
      const actions = createElement("div", { className: "button-row repository-actions" });
      actions.append(createAction("Повторить проверку", "data-repository-retry"));
      if (mode !== LOCAL_MODE) {
        actions.append(createAction(
          "Использовать local (forceLocalRepository)",
          "data-force-local-repository",
        ));
      }
      alert.append(actions);
      return;
    }

    alert.append(createElement("strong", { text: copy.title }));
    alert.append(createElement("p", { text: copy.text }));
  }

  function setState(nextState) {
    state = { ...nextState };
    render();
    onStateChange(state);
  }

  async function connect({ forceLocal = false } = {}) {
    const currentRequest = ++requestNumber;
    setState({ status: "loading", repository: null, error: null, forceLocal });
    let repository;
    try {
      repository = forceLocal ? await forceLocalRepository() : await getRepository();
    } catch (error) {
      if (currentRequest === requestNumber) {
        setState({
          status: "error",
          repository: null,
          error: normalizeRepositoryError(error),
          forceLocal,
        });
      }
      return null;
    }

    if (currentRequest !== requestNumber) {
      return null;
    }
    setState({ status: "ready", repository, error: null, forceLocal });
    return repository;
  }

  alert?.addEventListener("click", (event) => {
    if (event.target.closest("[data-repository-retry]")) {
      void connect();
    } else if (event.target.closest("[data-force-local-repository]")) {
      void connect({ forceLocal: true });
    }
  });

  render();
  return {
    connect,
    retry: () => connect(),
    forceLocal: () => connect({ forceLocal: true }),
    get repository() {
      return state.repository;
    },
    get mode() {
      return getRepositoryMode(state.repository);
    },
    get state() {
      return state;
    },
  };
}
