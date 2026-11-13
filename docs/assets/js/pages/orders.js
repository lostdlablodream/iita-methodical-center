import { clearElement, createElement } from "../components.js";
import { STORAGE_KEY } from "../config.js";
import {
  BOOKING_STATUS,
  getConsultation,
  getFormatLabel,
  getInstitute,
  getSlot,
  getTopic,
  isFutureSlot,
} from "../domain.js";
import { formatDateTime, formatSlotRange } from "../format.js";
import {
  ERROR_CODES,
  LOCAL_MODE,
  SERVER_MODE,
  RepositoryError,
  normalizeRepositoryError,
} from "../repository.js";
import { buildBookingIcs, createIcsFilename } from "./calendar.js";
import { createRepositoryRuntime, getPublicErrorMessage } from "./runtime.js";

export const ORDERS_FILTERS = Object.freeze({
  ALL: "all",
  ACTIVE: "active",
  CANCELLED: "cancelled",
});

const NEED_TAG_LABELS = Object.freeze({
  materials: "Материалы курса",
  assessment: "Оценивание",
  "digital-tools": "Цифровые инструменты",
  accessibility: "Доступные форматы",
});

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function timeValue(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeFilter(filter) {
  return Object.values(ORDERS_FILTERS).includes(filter) ? filter : ORDERS_FILTERS.ALL;
}

export function isUpcomingBooking(booking, now = new Date()) {
  return booking?.status === BOOKING_STATUS.ACTIVE && isFutureSlot(booking, now);
}

function compareUpcoming(left, right) {
  return timeValue(left.startsAt) - timeValue(right.startsAt)
    || timeValue(left.createdAt) - timeValue(right.createdAt)
    || cleanString(left.id).localeCompare(cleanString(right.id));
}

function historyTime(booking) {
  return booking.status === BOOKING_STATUS.CANCELLED
    ? timeValue(booking.cancelledAt) || timeValue(booking.startsAt)
    : timeValue(booking.startsAt);
}

function compareHistory(left, right) {
  return historyTime(right) - historyTime(left)
    || timeValue(right.startsAt) - timeValue(left.startsAt)
    || cleanString(left.id).localeCompare(cleanString(right.id));
}

export function buildOrdersView(bookings, filter = ORDERS_FILTERS.ALL, now = new Date()) {
  const source = Array.isArray(bookings) ? [...bookings] : [];
  const normalizedFilter = normalizeFilter(filter);
  const upcoming = source.filter((booking) => isUpcomingBooking(booking, now)).sort(compareUpcoming);
  const history = source.filter((booking) => !isUpcomingBooking(booking, now)).sort(compareHistory);
  const filteredUpcoming = normalizedFilter === ORDERS_FILTERS.CANCELLED ? [] : upcoming;
  const filteredHistory = normalizedFilter === ORDERS_FILTERS.ACTIVE
    ? history.filter((booking) => booking.status === BOOKING_STATUS.ACTIVE)
    : normalizedFilter === ORDERS_FILTERS.CANCELLED
      ? history.filter((booking) => booking.status === BOOKING_STATUS.CANCELLED)
      : history;

  return {
    filter: normalizedFilter,
    total: source.length,
    counts: {
      active: source.filter((booking) => booking.status === BOOKING_STATUS.ACTIVE).length,
      upcoming: upcoming.length,
      cancelled: source.filter((booking) => booking.status === BOOKING_STATUS.CANCELLED).length,
    },
    upcoming: filteredUpcoming,
    history: filteredHistory,
    visible: [...filteredUpcoming, ...filteredHistory],
  };
}

export function readOrdersLocation(search = "") {
  const parameters = new URLSearchParams(search);
  const bookingId = cleanString(parameters.get("bookingId"));
  const createdId = cleanString(parameters.get("created"));
  return {
    bookingId: bookingId || createdId,
    source: bookingId ? "bookingId" : createdId ? "created" : "",
  };
}

export function resolveBookingHighlight(bookings, visibleBookings, bookingId) {
  const normalizedId = cleanString(bookingId);
  if (!normalizedId) {
    return { status: "none", booking: null };
  }
  const booking = Array.isArray(bookings)
    ? bookings.find((candidate) => candidate.id === normalizedId)
    : null;
  if (!booking) {
    return { status: "missing", booking: null };
  }
  const visible = Array.isArray(visibleBookings)
    && visibleBookings.some((candidate) => candidate.id === normalizedId);
  return { status: visible ? "found" : "filtered", booking };
}

export function getShortBookingId(bookingId) {
  const id = cleanString(bookingId);
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function resolveRebookAction(booking, catalog, now = new Date()) {
  const consultation = getConsultation(catalog, booking?.consultationId);
  const slot = getSlot(consultation, booking?.slotId);
  const remainingCount = Number.isInteger(slot?.remainingCount)
    ? Math.max(0, slot.remainingCount)
    : Math.max(0, (slot?.capacity ?? 0) - (slot?.reservedCount ?? 0));
  const available = Boolean(slot && isFutureSlot(slot, now) && slot.isOpen !== false && remainingCount > 0);
  const parameters = new URLSearchParams();
  if (consultation) {
    parameters.set("consultationId", consultation.id);
  }
  if (available) {
    parameters.set("slotId", slot.id);
  }
  const query = parameters.toString();
  let reason = "";
  if (!consultation || !slot) {
    reason = "Прежняя консультация или слот не найдены. Выберите другое время в каталоге.";
  } else if (!isFutureSlot(slot, now)) {
    reason = "Время прежнего слота прошло. Выберите новое время в каталоге.";
  } else if (remainingCount === 0) {
    reason = "На прежнем слоте нет свободных мест. Выберите другое время в каталоге.";
  } else if (slot.isOpen === false) {
    reason = "Прежний слот закрыт для записи. Выберите другое время в каталоге.";
  }
  return {
    available,
    href: `${available ? "./booking.html" : "./catalog.html"}${query ? `?${query}` : ""}`,
    reason,
    slot,
  };
}

export function createCancelOperationKey(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== "function") {
    throw new RepositoryError(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      "Браузер не может создать UUID для отмены. Запрос не отправлен.",
    );
  }
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getOrCreateCancelOperationKey(operations, bookingId, cryptoImpl = globalThis.crypto) {
  const id = cleanString(bookingId);
  if (!id || !operations || typeof operations.get !== "function" || typeof operations.set !== "function") {
    throw new TypeError("Для отмены нужны bookingId и Map операций");
  }
  const existing = operations.get(id);
  if (existing) {
    return existing;
  }
  const key = createCancelOperationKey(cryptoImpl);
  operations.set(id, key);
  return key;
}

export async function executeCancelOperation({ repository, operations, bookingId, cryptoImpl }) {
  const idempotencyKey = getOrCreateCancelOperationKey(operations, bookingId, cryptoImpl);
  const booking = await repository.cancelBooking({ bookingId, idempotencyKey });
  if (!booking || booking.id !== bookingId || booking.status !== BOOKING_STATUS.CANCELLED) {
    throw new RepositoryError(
      ERROR_CODES.INVALID_RESPONSE,
      "Repository не подтвердил отмену выбранной записи.",
    );
  }
  return { booking, idempotencyKey };
}

export function upsertBooking(bookings, updatedBooking) {
  const source = Array.isArray(bookings) ? bookings : [];
  let found = false;
  const next = source.map((booking) => {
    if (booking.id !== updatedBooking.id) {
      return booking;
    }
    found = true;
    return updatedBooking;
  });
  if (!found) {
    next.push(updatedBooking);
  }
  return next;
}

export function shouldRefreshOrdersFromStorage(event, mode) {
  return mode === LOCAL_MODE && event?.key === STORAGE_KEY;
}

export function createRefreshScheduler(callback, options = {}) {
  const delay = options.delay ?? 250;
  const setTimer = options.setTimeout ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  let timer = null;

  function cancel() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule() {
    cancel();
    timer = setTimer(() => {
      timer = null;
      callback();
    }, delay);
  }

  return {
    schedule,
    cancel,
    get pending() {
      return timer !== null;
    },
  };
}

function createDetailRow(label, value) {
  const row = createElement("div");
  row.append(createElement("dt", { text: label }), createElement("dd", { text: value }));
  return row;
}

function statusForBooking(booking, now) {
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    return { key: "cancelled", label: "Отменена", badge: "badge-danger" };
  }
  if (isUpcomingBooking(booking, now)) {
    return { key: "upcoming", label: "Активна", badge: "badge-success" };
  }
  return { key: "completed", label: "Завершена", badge: "badge-neutral" };
}

export function initializeOrders(root = document) {
  const filterControl = root.querySelector("[data-orders-filter]");
  const upcomingList = root.querySelector("[data-upcoming-list]");
  const historyList = root.querySelector("[data-history-list]");
  if (!filterControl || !upcomingList || !historyList) {
    return null;
  }

  const elements = {
    count: root.querySelector("[data-orders-count]"),
    activeCount: root.querySelector("[data-orders-stat-active]"),
    upcomingCount: root.querySelector("[data-orders-stat-upcoming]"),
    cancelledCount: root.querySelector("[data-orders-stat-cancelled]"),
    refresh: root.querySelector("[data-orders-refresh]"),
    error: root.querySelector("[data-orders-error]"),
    errorMessage: root.querySelector("[data-orders-error-message]"),
    loading: root.querySelector("[data-orders-loading]"),
    refreshing: root.querySelector("[data-orders-refreshing]"),
    result: root.querySelector("[data-orders-result]"),
    upcomingSection: root.querySelector("[data-upcoming-section]"),
    historySection: root.querySelector("[data-history-section]"),
    upcomingEmpty: root.querySelector("[data-upcoming-empty]"),
    historyEmpty: root.querySelector("[data-history-empty]"),
    empty: root.querySelector("[data-orders-empty]"),
    emptyBadge: root.querySelector("[data-orders-empty-badge]"),
    emptyTitle: root.querySelector("[data-orders-empty-title]"),
    emptyText: root.querySelector("[data-orders-empty-text]"),
    highlight: root.querySelector("[data-orders-highlight]"),
    toast: root.querySelector("[data-orders-toast]"),
    dialog: root.querySelector("[data-cancel-dialog]"),
    dialogTitle: root.querySelector("[data-cancel-booking-title]"),
    dialogDate: root.querySelector("[data-cancel-booking-date]"),
    dialogError: root.querySelector("[data-cancel-error]"),
    dialogClose: root.querySelector("[data-cancel-close]"),
    dialogConfirm: root.querySelector("[data-cancel-confirm]"),
  };

  const initialLocation = readOrdersLocation(window.location.search);
  const state = {
    bookings: [],
    catalog: null,
    filter: ORDERS_FILTERS.ALL,
    loaded: false,
    loading: false,
    pendingCancelId: null,
  };
  const cancelOperations = new Map();
  let runtime;
  let requestNumber = 0;
  let mutationEpoch = 0;
  let activeLoad = null;
  let refreshQueued = false;
  let highlightedBookingId = "";
  let cancelContext = null;

  function showToast(message, { error = false } = {}) {
    elements.toast.classList.toggle("is-error", error);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
  }

  function updateControls() {
    const disabled = state.loading || !state.loaded;
    filterControl.disabled = disabled;
    elements.refresh.disabled = disabled;
    filterControl.value = state.filter;
  }

  function createOrderCard(booking) {
    const now = new Date();
    const status = statusForBooking(booking, now);
    const topic = getTopic(state.catalog, booking.topicId);
    const institute = getInstitute(state.catalog, booking.instituteId);
    const card = createElement("article", {
      className: `card order-card order-status-${status.key}`,
      attributes: {
        "data-booking-id": booking.id,
        "aria-label": `${booking.title}. ${status.label}`,
        tabindex: "-1",
      },
    });
    card.dataset.bookingId = booking.id;

    const heading = createElement("div", { className: "order-card-heading" });
    heading.append(
      createElement("p", { className: "eyebrow", text: topic?.name ?? booking.topicId ?? "Методическая консультация" }),
      createElement("h4", { text: booking.title ?? "Консультация" }),
    );
    const header = createElement("div", { className: "order-card-header" }, [
      heading,
      createElement("span", { className: `badge ${status.badge}`, text: status.label }),
    ]);
    const time = createElement("time", {
      text: formatSlotRange(booking.startsAt, booking.endsAt),
      attributes: { datetime: booking.startsAt },
    });
    const timeParagraph = createElement("p", { className: "order-card-time" }, [time]);
    const consultant = createElement("p", {
      className: "order-card-consultant",
      text: booking.consultantLabel ?? "Консультант уточняется",
    });
    const details = createElement("dl", { className: "order-meta" });
    details.append(
      createDetailRow("Формат", getFormatLabel(booking.mode)),
      createDetailRow("Место", booking.location ?? "Уточняется"),
      createDetailRow("Участник", booking.displayName ?? "Не указан"),
      createDetailRow("Институт", institute?.name ?? booking.instituteId ?? "Не указан"),
      createDetailRow("Создана", formatDateTime(booking.createdAt)),
    );
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      details.append(createDetailRow("Отменена", formatDateTime(booking.cancelledAt)));
    }
    const idCode = createElement("code", {
      text: getShortBookingId(booking.id),
      attributes: { title: booking.id },
    });
    const idRow = createElement("div");
    idRow.append(createElement("dt", { text: "ID записи" }), createElement("dd", {}, [idCode]));
    details.append(idRow);

    const needBlock = createElement("section", { className: "order-need-block" });
    needBlock.append(
      createElement("h4", { text: "Методическая потребность" }),
      createElement("p", { className: "order-need", text: booking.need ?? "Не указана" }),
    );
    const tagsBlock = createElement("section", { className: "order-tags-block" });
    tagsBlock.append(createElement("h4", { text: "Дополнительные потребности" }));
    const tags = Array.isArray(booking.needTags) ? booking.needTags : [];
    if (tags.length === 0) {
      tagsBlock.append(createElement("p", { className: "text-muted", text: "Не выбраны" }));
    } else {
      const tagList = createElement("div", { className: "tag-list order-tags" });
      tags.forEach((tag) => tagList.append(createElement("span", {
        className: "tag",
        text: NEED_TAG_LABELS[tag] ?? tag,
      })));
      tagsBlock.append(tagList);
    }

    card.append(header, timeParagraph, consultant, details, needBlock, tagsBlock);
    const actions = createElement("div", { className: "order-actions", attributes: { "aria-label": "Действия с записью" } });
    if (booking.status === BOOKING_STATUS.ACTIVE) {
      actions.append(createElement("button", {
        className: "button button-secondary",
        text: "В календарь (.ics)",
        attributes: { type: "button", "data-export-ics": "true" },
      }));
      if (status.key === "upcoming") {
        actions.append(createElement("button", {
          className: "button button-danger",
          text: "Отменить запись",
          attributes: { type: "button", "data-cancel-booking": "true" },
        }));
      }
    } else if (booking.status === BOOKING_STATUS.CANCELLED) {
      const rebook = resolveRebookAction(booking, state.catalog, now);
      actions.append(createElement("a", {
        className: "button button-primary",
        text: "Записаться снова",
        attributes: {
          href: rebook.href,
          title: rebook.available ? "Повторить запись на тот же слот" : rebook.reason,
        },
      }));
      if (!rebook.available) {
        card.append(createElement("p", { className: "order-rebook-note", text: rebook.reason }));
      }
    }
    if (actions.childElementCount > 0) {
      card.append(actions);
    }
    return card;
  }

  function renderEmpty(view) {
    const isEmpty = view.visible.length === 0;
    elements.empty.hidden = !isEmpty;
    elements.result.hidden = isEmpty;
    if (!isEmpty) {
      return;
    }
    const hasAny = view.total > 0;
    const copy = state.filter === ORDERS_FILTERS.ACTIVE
      ? { badge: "Нет активных", title: "Активных записей нет", text: "Предстоящие и завершённые активные записи появятся здесь после оформления." }
      : state.filter === ORDERS_FILTERS.CANCELLED
        ? { badge: "Нет отменённых", title: "Отменённых записей нет", text: "После подтверждённой отмены запись останется в истории." }
        : { badge: "Нет записей", title: "Записей пока нет", text: "Выберите консультацию и доступное время в каталоге." };
    elements.emptyBadge.textContent = copy.badge;
    elements.emptyTitle.textContent = copy.title;
    elements.emptyText.textContent = copy.text;
    elements.empty.querySelector("[data-orders-show-all]").hidden = !hasAny || state.filter === ORDERS_FILTERS.ALL;
  }

  function renderHighlight(view) {
    const resolution = resolveBookingHighlight(state.bookings, view.visible, initialLocation.bookingId);
    for (const card of [...upcomingList.children, ...historyList.children]) {
      card.classList.toggle("is-highlighted", resolution.status === "found"
        && card.dataset.bookingId === resolution.booking.id);
    }
    clearElement(elements.highlight);
    if (resolution.status === "none") {
      elements.highlight.hidden = true;
      return;
    }

    elements.highlight.hidden = false;
    if (resolution.status === "missing") {
      elements.highlight.append(createElement("p", {
        text: "Запись из ссылки не найдена в текущем режиме или принадлежит другому владельцу. Это не ошибка загрузки: остальные доступные записи показаны ниже.",
      }));
      return;
    }
    if (resolution.status === "filtered") {
      elements.highlight.append(createElement("p", { text: "Запись из ссылки скрыта текущим фильтром." }));
      const showAll = createElement("button", {
        className: "button button-secondary",
        text: "Показать все записи",
        attributes: { type: "button", "data-orders-show-all": "true" },
      });
      elements.highlight.append(showAll);
      return;
    }

    elements.highlight.append(createElement("p", {
      text: `Показана запись ${getShortBookingId(resolution.booking.id)} из ссылки${initialLocation.source === "created" ? " (параметр created)" : ""}.`,
    }));
    if (highlightedBookingId === resolution.booking.id) {
      return;
    }
    highlightedBookingId = resolution.booking.id;
    const card = [...upcomingList.children, ...historyList.children]
      .find((candidate) => candidate.dataset.bookingId === resolution.booking.id);
    requestAnimationFrame(() => {
      card?.scrollIntoView({
        block: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      card?.focus({ preventScroll: true });
    });
  }

  function render() {
    if (!state.loaded) {
      updateControls();
      return;
    }
    const view = buildOrdersView(state.bookings, state.filter, new Date());
    elements.activeCount.textContent = String(view.counts.active);
    elements.upcomingCount.textContent = String(view.counts.upcoming);
    elements.cancelledCount.textContent = String(view.counts.cancelled);
    elements.count.textContent = `Показано ${view.visible.length} из ${view.total}`;
    clearElement(upcomingList);
    clearElement(historyList);
    view.upcoming.forEach((booking) => upcomingList.append(createOrderCard(booking)));
    view.history.forEach((booking) => historyList.append(createOrderCard(booking)));
    elements.upcomingSection.hidden = state.filter === ORDERS_FILTERS.CANCELLED;
    elements.historySection.hidden = false;
    elements.upcomingEmpty.hidden = view.upcoming.length > 0 || state.filter === ORDERS_FILTERS.CANCELLED;
    elements.historyEmpty.hidden = view.history.length > 0;
    renderEmpty(view);
    renderHighlight(view);
    updateControls();
  }

  function renderLoading(background) {
    state.loading = true;
    elements.error.hidden = true;
    elements.loading.hidden = background;
    elements.refreshing.hidden = !background;
    if (!background) {
      elements.result.hidden = true;
      elements.empty.hidden = true;
      elements.highlight.hidden = true;
      elements.count.textContent = "Загружаем записи…";
      if (!state.loaded) {
        elements.activeCount.textContent = "—";
        elements.upcomingCount.textContent = "—";
        elements.cancelledCount.textContent = "—";
      }
    }
    updateControls();
  }

  function renderLoadError(error) {
    state.loading = false;
    elements.loading.hidden = true;
    elements.refreshing.hidden = true;
    elements.result.hidden = true;
    elements.empty.hidden = true;
    elements.highlight.hidden = true;
    elements.errorMessage.textContent = getPublicErrorMessage(error);
    elements.error.hidden = false;
    elements.count.textContent = "Ошибка загрузки";
    updateControls();
  }

  async function loadOrders({ background = false } = {}) {
    const repository = runtime?.repository;
    if (!repository) {
      return false;
    }
    if (activeLoad) {
      refreshQueued = true;
      return activeLoad;
    }

    const currentRequest = ++requestNumber;
    const loadEpoch = mutationEpoch;
    const keepCurrentView = background && state.loaded;
    renderLoading(keepCurrentView);
    const promise = (async () => {
      try {
        const [bookings, catalog] = await Promise.all([
          repository.listBookings({}),
          repository.getCatalog({}),
        ]);
        if (currentRequest !== requestNumber || loadEpoch !== mutationEpoch || repository !== runtime.repository) {
          return false;
        }
        if (!Array.isArray(bookings) || !catalog || !Array.isArray(catalog.institutes)) {
          throw new RepositoryError(ERROR_CODES.INVALID_RESPONSE, "Repository вернул неподдерживаемые данные записей.");
        }
        state.bookings = bookings;
        state.catalog = catalog;
        state.loaded = true;
        state.loading = false;
        elements.loading.hidden = true;
        elements.refreshing.hidden = true;
        elements.error.hidden = true;
        render();
        return true;
      } catch (error) {
        if (currentRequest === requestNumber && loadEpoch === mutationEpoch && repository === runtime.repository) {
          state.loading = false;
          if (keepCurrentView) {
            elements.refreshing.hidden = true;
            render();
            showToast(`Записи не обновлены: ${getPublicErrorMessage(error)}`, { error: true });
          } else {
            renderLoadError(error);
          }
        }
        return false;
      }
    })();
    activeLoad = promise;
    try {
      return await promise;
    } finally {
      if (activeLoad === promise) {
        activeLoad = null;
      }
      if (currentRequest === requestNumber && loadEpoch === mutationEpoch) {
        state.loading = false;
        elements.refreshing.hidden = true;
        updateControls();
      }
      if (refreshQueued) {
        refreshQueued = false;
        if (repository === runtime.repository) {
          void loadOrders({ background: true });
        }
      }
    }
  }

  const refreshScheduler = createRefreshScheduler(() => {
    if (runtime?.repository && state.loaded) {
      void loadOrders({ background: true });
    }
  });

  function restoreDialogFocus(target) {
    if (target && target.isConnected !== false && typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  }

  function closeCancelDialog({ focusTarget = null } = {}) {
    if (state.pendingCancelId) {
      return;
    }
    const context = cancelContext;
    cancelContext = null;
    if (elements.dialog.open) {
      elements.dialog.close();
    }
    restoreDialogFocus(focusTarget ?? context?.returnFocus);
  }

  function openCancelDialog(booking, sourceButton) {
    if (state.pendingCancelId || !isUpcomingBooking(booking, new Date())) {
      return;
    }
    cancelContext = { booking, returnFocus: sourceButton };
    elements.dialogTitle.textContent = booking.title;
    elements.dialogDate.textContent = formatSlotRange(booking.startsAt, booking.endsAt);
    elements.dialogError.hidden = true;
    elements.dialogError.textContent = "";
    elements.dialogConfirm.textContent = "Отменить запись";
    elements.dialogClose.disabled = false;
    elements.dialogConfirm.disabled = false;
    elements.dialog.setAttribute("aria-busy", "false");
    if (typeof elements.dialog.showModal !== "function") {
      showToast("Этот браузер не поддерживает native dialog. Обновите браузер перед отменой.", { error: true });
      return;
    }
    elements.dialog.showModal();
    elements.dialogConfirm.focus();
  }

  async function confirmCancellation() {
    const context = cancelContext;
    if (!context || state.pendingCancelId || !runtime.repository) {
      return;
    }
    const { booking } = context;
    if (!isUpcomingBooking(booking, new Date())) {
      closeCancelDialog();
      showToast("Время консультации уже началось: запись перенесена в историю без отмены.");
      void loadOrders({ background: true });
      return;
    }

    const repository = runtime.repository;
    state.pendingCancelId = booking.id;
    elements.dialog.setAttribute("aria-busy", "true");
    elements.dialogClose.disabled = true;
    elements.dialogConfirm.disabled = true;
    elements.dialogConfirm.textContent = "Отменяем…";
    elements.dialogError.hidden = true;
    try {
      const outcome = await executeCancelOperation({
        repository,
        operations: cancelOperations,
        bookingId: booking.id,
        cryptoImpl: window.crypto,
      });
      if (repository !== runtime.repository) {
        state.pendingCancelId = null;
        closeCancelDialog();
        showToast("Отмена подтверждена в прежнем режиме хранения. Текущий список не изменён.");
        return;
      }
      mutationEpoch += 1;
      requestNumber += 1;
      state.bookings = upsertBooking(state.bookings, outcome.booking);
      state.loaded = true;
      state.pendingCancelId = null;
      elements.dialog.setAttribute("aria-busy", "false");
      render();
      showToast(`Запись «${outcome.booking.title}» отменена. Место освобождено.`);
      closeCancelDialog({ focusTarget: elements.toast });
      void loadOrders({ background: true });
    } catch (error) {
      state.pendingCancelId = null;
      elements.dialog.setAttribute("aria-busy", "false");
      elements.dialogClose.disabled = false;
      elements.dialogConfirm.disabled = false;
      elements.dialogConfirm.textContent = "Повторить отмену с тем же ключом";
      elements.dialogError.textContent = normalizeRepositoryError(error).message;
      elements.dialogError.hidden = false;
    }
  }

  function downloadCalendar(booking) {
    const documentRef = root.ownerDocument ?? document;
    const urlApi = documentRef.defaultView?.URL ?? globalThis.URL;
    const BlobImpl = documentRef.defaultView?.Blob ?? globalThis.Blob;
    let objectUrl = "";
    try {
      const blob = new BlobImpl([buildBookingIcs(booking)], { type: "text/calendar;charset=utf-8" });
      objectUrl = urlApi.createObjectURL(blob);
      const link = createElement("a", {
        attributes: { href: objectUrl, download: createIcsFilename(booking.id), hidden: true },
      });
      documentRef.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
      showToast(`Календарный файл ${createIcsFilename(booking.id)} создан на устройстве.`);
    } catch (error) {
      showToast(`Не удалось создать файл календаря: ${normalizeRepositoryError(error).message}`, { error: true });
    } finally {
      if (objectUrl) {
        setTimeout(() => urlApi.revokeObjectURL(objectUrl), 0);
      }
    }
  }

  function showAllBookings() {
    state.filter = ORDERS_FILTERS.ALL;
    highlightedBookingId = "";
    render();
  }

  filterControl.addEventListener("change", () => {
    state.filter = normalizeFilter(filterControl.value);
    render();
  });
  elements.refresh.addEventListener("click", () => void loadOrders({ background: state.loaded }));
  root.querySelector("[data-orders-retry]")?.addEventListener("click", () => {
    if (runtime.repository) {
      void loadOrders();
    } else {
      void runtime.retry();
    }
  });
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-orders-show-all]")) {
      showAllBookings();
    }
  });
  for (const list of [upcomingList, historyList]) {
    list.addEventListener("click", (event) => {
      const card = event.target.closest("[data-booking-id]");
      const booking = state.bookings.find((candidate) => candidate.id === card?.dataset.bookingId);
      if (!booking) {
        return;
      }
      if (event.target.closest("[data-cancel-booking]")) {
        openCancelDialog(booking, event.target.closest("[data-cancel-booking]"));
      } else if (event.target.closest("[data-export-ics]")) {
        downloadCalendar(booking);
      }
    });
  }
  elements.dialogClose.addEventListener("click", () => closeCancelDialog());
  elements.dialogConfirm.addEventListener("click", () => void confirmCancellation());
  elements.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCancelDialog();
  });
  elements.dialog.addEventListener("close", () => {
    const context = cancelContext;
    cancelContext = null;
    restoreDialogFocus(context?.returnFocus);
  });
  elements.dialog.addEventListener("click", (event) => {
    if (event.target !== elements.dialog || state.pendingCancelId) {
      return;
    }
    const bounds = elements.dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      closeCancelDialog();
    }
  });

  window.addEventListener("storage", (event) => {
    if (shouldRefreshOrdersFromStorage(event, runtime?.mode)) {
      refreshScheduler.schedule();
    }
  });
  window.addEventListener("focus", () => {
    if (runtime?.mode === SERVER_MODE) {
      refreshScheduler.schedule();
    }
  });
  root.addEventListener("visibilitychange", () => {
    if (root.visibilityState === "visible" && runtime?.mode === SERVER_MODE) {
      refreshScheduler.schedule();
    }
  });

  runtime = createRepositoryRuntime({
    root,
    onStateChange(repositoryState) {
      mutationEpoch += 1;
      requestNumber += 1;
      activeLoad = null;
      refreshQueued = false;
      refreshScheduler.cancel();
      state.bookings = [];
      state.catalog = null;
      state.loaded = false;
      state.pendingCancelId = null;
      cancelContext = null;
      if (elements.dialog.open) {
        elements.dialog.close();
      }
      if (repositoryState.status === "loading") {
        renderLoading(false);
      } else if (repositoryState.status === "ready") {
        void loadOrders();
      } else if (repositoryState.status === "error") {
        renderLoadError(repositoryState.error);
      }
    },
  });

  updateControls();
  void runtime.connect();
  return runtime;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initializeOrders(document), { once: true });
  } else {
    initializeOrders(document);
  }
}
