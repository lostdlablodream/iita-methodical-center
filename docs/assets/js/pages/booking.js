import { clearElement, createElement } from "../components.js";
import { DEFAULT_INSTITUTE_ID } from "../config.js";
import {
  BOOKING_STATUS,
  CONSULTATION_FORMAT,
  NEED_TAGS,
  findConsultationSlot,
  getConsultation,
  getFormatLabel,
  getTopic,
  isFutureSlot,
} from "../domain.js";
import { formatCapacity, formatDateTime, formatDuration, formatSlotRange, formatTime } from "../format.js";
import {
  ERROR_CODES,
  LOCAL_MODE,
  RepositoryError,
  normalizeRepositoryError,
} from "../repository.js";
import { canonicalizeBookingPayload, normalizeBookingInput } from "../repository.local.js";
import { renderWeatherWidget } from "../weather.js";
import { createRepositoryRuntime, getPublicErrorMessage } from "./runtime.js";

const ALLOWED_NEED_TAGS = Object.freeze(Object.values(NEED_TAGS));
const NEED_TAG_LABELS = Object.freeze({
  [NEED_TAGS.MATERIALS]: "Материалы курса",
  [NEED_TAGS.ASSESSMENT]: "Оценивание",
  [NEED_TAGS.DIGITAL_TOOLS]: "Цифровые инструменты",
  [NEED_TAGS.ACCESSIBILITY]: "Доступные форматы",
});
const FIELD_ORDER = Object.freeze(["slotId", "displayName", "instituteId", "need", "needTags", "demoConfirmed"]);
export const PENDING_BOOKING_SESSION_KEY = "iita.consultations.pending-booking.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readBookingLocation(search = "") {
  const parameters = new URLSearchParams(search);
  return {
    consultationId: cleanString(parameters.get("consultationId")),
    slotId: cleanString(parameters.get("slotId")),
    createdId: cleanString(parameters.get("created")),
  };
}

export function buildBookingUrl(consultationId = "", slotId = "", createdId = "", base = "./booking.html") {
  const parameters = new URLSearchParams();
  const consultation = cleanString(consultationId);
  const slot = cleanString(slotId);
  const created = cleanString(createdId);
  if (consultation) {
    parameters.set("consultationId", consultation);
  }
  if (slot) {
    parameters.set("slotId", slot);
  }
  if (created) {
    parameters.set("created", created);
  }
  const query = parameters.toString();
  return `${base}${query ? `?${query}` : ""}`;
}

export function createOrdersLink(bookingId) {
  const parameters = new URLSearchParams({ bookingId: cleanString(bookingId) });
  return `./orders.html?${parameters.toString()}`;
}

export function resolveBookingSelection(catalog, consultationId, slotId = "") {
  const consultation = cleanString(consultationId);
  const slot = cleanString(slotId);
  if (!consultation) {
    return { status: "missing-consultation", consultation: null, slot: null };
  }
  const selectedConsultation = getConsultation(catalog, consultation);
  if (!selectedConsultation) {
    return { status: "unknown-consultation", consultation: null, slot: null };
  }
  if (!slot) {
    return { status: "needs-slot", consultation: selectedConsultation, slot: null };
  }
  const selectedSlot = selectedConsultation.slots.find((candidate) => candidate.id === slot);
  if (!selectedSlot) {
    return {
      status: findConsultationSlot(catalog, slot) ? "mismatched-slot" : "unknown-slot",
      consultation: selectedConsultation,
      slot: null,
    };
  }
  return { status: "ok", consultation: selectedConsultation, slot: selectedSlot };
}

export function getBookingSlotAvailability(slot, now = new Date()) {
  const capacity = Number.isInteger(slot?.capacity) ? slot.capacity : 0;
  const reserved = Number.isInteger(slot?.reservedCount) ? slot.reservedCount : 0;
  const remainingCount = Number.isInteger(slot?.remainingCount)
    ? Math.max(0, slot.remainingCount)
    : Math.max(0, capacity - reserved);
  const isPast = !isFutureSlot(slot, now);
  const isAvailable = !isPast && slot?.isOpen !== false && remainingCount > 0;
  let reason = "";
  if (isPast) {
    reason = "Время слота прошло";
  } else if (remainingCount === 0) {
    reason = "Свободных мест нет";
  } else if (slot?.isOpen === false) {
    reason = "Запись закрыта";
  }
  return { isAvailable, isPast, remainingCount, reason };
}

export function calculateSlotDurationMinutes(slot) {
  const start = new Date(slot?.startsAt).getTime();
  const end = new Date(slot?.endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return Math.round((end - start) / 60000);
}

export function validateBookingValues(values = {}, context = {}) {
  const draft = {
    consultationId: cleanString(values.consultationId),
    slotId: cleanString(values.slotId),
    instituteId: cleanString(values.instituteId),
    displayName: cleanString(values.displayName),
    need: cleanString(values.need),
    needTags: Array.isArray(values.needTags)
      ? [...new Set(values.needTags.map(cleanString))].sort()
      : [],
  };
  const errors = {};
  if (!draft.consultationId) {
    errors.consultationId = "Выберите консультацию в каталоге.";
  }
  if (!draft.slotId || !context.slot) {
    errors.slotId = "Выберите доступное время консультации.";
  } else if (context.slot.id !== draft.slotId) {
    errors.slotId = "Выбранный слот не принадлежит текущей консультации.";
  } else if (!getBookingSlotAvailability(context.slot, context.now ?? new Date()).isAvailable) {
    errors.slotId = "Этот слот прошёл, закрыт или уже заполнен. Выберите другое время.";
  }
  if (draft.displayName.length < 2 || draft.displayName.length > 80) {
    errors.displayName = "Укажите от 2 до 80 символов после удаления пробелов по краям.";
  }
  if (!draft.instituteId) {
    errors.instituteId = "Выберите институт.";
  } else if (Array.isArray(context.instituteIds) && !context.instituteIds.includes(draft.instituteId)) {
    errors.instituteId = "Выберите институт из общего справочника.";
  } else if (Array.isArray(context.allowedInstituteIds)
    && !context.allowedInstituteIds.includes(draft.instituteId)) {
    errors.instituteId = "Эта консультация недоступна для выбранного института.";
  }
  if (draft.need.length < 10 || draft.need.length > 1000) {
    errors.need = "Опишите потребность: от 10 до 1000 символов после удаления пробелов по краям.";
  }
  if (!Array.isArray(values.needTags) || draft.needTags.some((tag) => !ALLOWED_NEED_TAGS.includes(tag))) {
    errors.needTags = "Выберите только потребности из предложенного списка.";
  }
  if (values.demoConfirmed !== true) {
    errors.demoConfirmed = "Подтвердите учебный характер записи и отсутствие реальных персональных данных.";
  }
  return { draft, errors, isValid: Object.keys(errors).length === 0 };
}

export function createIdempotencyKey(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== "function") {
    throw new RepositoryError(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      "Браузер не может создать криптографически случайный UUID. Запись не отправлена.",
    );
  }
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ensureBookingOperation(operation, draft, cryptoImpl = globalThis.crypto) {
  const fingerprint = canonicalizeBookingPayload(draft);
  if (operation && operation.fingerprint !== fingerprint) {
    return { operation, fingerprint, conflict: true };
  }
  return {
    operation: operation ?? { key: createIdempotencyKey(cryptoImpl), fingerprint },
    fingerprint,
    conflict: false,
  };
}

function resolvePendingSessionStorage(storage) {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function savePendingBookingOperation(operation, draft, storage) {
  const session = resolvePendingSessionStorage(storage);
  if (!session || typeof session.setItem !== "function") {
    return false;
  }
  try {
    const normalizedDraft = normalizeBookingInput(draft);
    const canonical = canonicalizeBookingPayload(normalizedDraft);
    if (!operation || operation.fingerprint !== canonical || !UUID_PATTERN.test(operation.key)) {
      return false;
    }
    session.setItem(PENDING_BOOKING_SESSION_KEY, JSON.stringify({
      version: 1,
      key: operation.key,
      canonical,
      draft: normalizedDraft,
      consultationId: normalizedDraft.consultationId,
      slotId: normalizedDraft.slotId,
    }));
    return true;
  } catch {
    return false;
  }
}

export function restorePendingBookingOperation(storage) {
  const session = resolvePendingSessionStorage(storage);
  if (!session || typeof session.getItem !== "function") {
    return null;
  }
  try {
    const serialized = session.getItem(PENDING_BOOKING_SESSION_KEY);
    if (serialized === null || serialized === undefined) {
      return null;
    }
    if (typeof serialized !== "string") {
      return null;
    }
    const record = JSON.parse(serialized);
    if (!record || record.version !== 1 || !UUID_PATTERN.test(record.key)) {
      return null;
    }
    const draft = normalizeBookingInput(record.draft);
    const canonical = canonicalizeBookingPayload(draft);
    if (record.canonical !== canonical
      || record.consultationId !== draft.consultationId
      || record.slotId !== draft.slotId) {
      return null;
    }
    return {
      key: record.key,
      fingerprint: canonical,
      draft,
      consultationId: draft.consultationId,
      slotId: draft.slotId,
    };
  } catch {
    return null;
  }
}

export function clearPendingBookingOperation(storage) {
  const session = resolvePendingSessionStorage(storage);
  if (!session || typeof session.removeItem !== "function") {
    return false;
  }
  try {
    session.removeItem(PENDING_BOOKING_SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function shouldDiscardPendingOperation(error) {
  return normalizeRepositoryError(error).code === ERROR_CODES.VALIDATION_ERROR;
}

export function resolveBookingConfirmation(bookings, bookingId, consultationId, slotId) {
  const booking = Array.isArray(bookings)
    ? bookings.find((candidate) => candidate.id === cleanString(bookingId))
    : null;
  if (!booking) {
    return { status: "missing", booking: null };
  }
  if (booking.consultationId !== cleanString(consultationId) || booking.slotId !== cleanString(slotId)) {
    return { status: "mismatched", booking: null };
  }
  if (booking.status === BOOKING_STATUS.ACTIVE) {
    return { status: "active", booking };
  }
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    return { status: "cancelled", booking };
  }
  return { status: "unavailable", booking: null };
}

export function pendingOperationMatchesBooking(operation, booking) {
  if (!operation || !booking) {
    return false;
  }
  try {
    return operation.fingerprint === canonicalizeBookingPayload(normalizeBookingInput(booking));
  } catch {
    return false;
  }
}

function createSummaryRow(label, value) {
  const row = createElement("div");
  row.append(createElement("dt", { text: label }), createElement("dd", { text: value }));
  return row;
}

function createCatalogLink(text = "Вернуться в каталог") {
  return createElement("a", {
    className: "button button-secondary",
    text,
    attributes: { href: "./catalog.html" },
  });
}

export function initializeBooking(root = document) {
  const form = root.querySelector("[data-booking-form]");
  const selection = root.querySelector("[data-booking-selection]");
  if (!form || !selection) {
    return null;
  }

  const formFields = form.querySelector("[data-booking-fields]");
  const submitButton = form.querySelector("[data-booking-submit]");
  const detailsSection = root.querySelector("[data-booking-details-section]");
  const selectionBadge = root.querySelector("[data-booking-selection-badge]");
  const selectionError = root.querySelector("[data-booking-selection-error]");
  const slotFieldset = root.querySelector("[data-slot-fieldset]");
  const slotOptions = root.querySelector("[data-slot-options]");
  const slotError = root.querySelector("[data-slot-error]");
  const confirmation = root.querySelector("[data-booking-confirmation]");
  const feedback = root.querySelector("[data-booking-feedback]");
  const summary = root.querySelector("[data-booking-summary]");
  const needCounter = root.querySelector("[data-need-counter]");
  const needTagsGroup = root.querySelector("[data-need-tags]");
  const weatherContainer = root.querySelector("[data-booking-weather]");
  const onlineNote = root.querySelector("[data-online-note]");
  const extraPlaceholder = root.querySelector("[data-slot-extra-placeholder]");
  const displayNameInput = form.elements.namedItem("displayName");
  const instituteSelect = form.elements.namedItem("instituteId");
  const needInput = form.elements.namedItem("need");
  const demoInput = form.elements.namedItem("demoConfirmed");
  const fieldControls = {
    slotId: slotFieldset,
    displayName: displayNameInput,
    instituteId: instituteSelect,
    need: needInput,
    needTags: needTagsGroup,
    demoConfirmed: demoInput,
  };
  const fieldErrors = Object.fromEntries(
    [...root.querySelectorAll("[data-field-error]")].map((element) => [element.dataset.fieldError, element]),
  );
  const initial = readBookingLocation(window.location.search);
  const restoredPendingOperation = restorePendingBookingOperation();
  const state = {
    consultationId: initial.consultationId,
    selectedSlotId: initial.slotId,
    createdId: initial.createdId,
    catalog: null,
    consultation: null,
    confirmation: null,
    cancelledBooking: null,
    createdLookupMissing: false,
    operation: restoredPendingOperation,
    restoredPending: Boolean(restoredPendingOperation),
    pending: false,
    loading: false,
  };
  let runtime;
  let requestNumber = 0;
  let weatherWidget = null;
  let weatherStartsAt = "";

  function selectedSlot() {
    return state.consultation?.slots.find((slot) => slot.id === state.selectedSlotId) ?? null;
  }

  function updateUrl() {
    const base = buildBookingUrl(
      state.consultationId,
      state.selectedSlotId,
      state.createdId,
      window.location.pathname,
    );
    window.history.replaceState(window.history.state, "", `${base}${window.location.hash}`);
  }

  function hideFeedback() {
    feedback.hidden = true;
    clearElement(feedback);
  }

  function discardPendingOperation() {
    state.operation = null;
    state.restoredPending = false;
    clearPendingBookingOperation();
  }

  function renderRestoredPendingNotice() {
    if (!state.restoredPending || !state.operation || state.createdId) {
      return;
    }
    renderFeedback({
      kind: "info",
      title: "Найдена незавершённая операция записи",
      messages: [
        "UUID и канонический черновик восстановлены из sessionStorage этой вкладки. Поля формы намеренно не заполнены автоматически: введите прежние значения, чтобы повторить операцию с тем же ключом, или явно начните новый черновик.",
      ],
      actions: [
        { label: "Проверить «Мои записи»", href: "./orders.html" },
        { label: "Начать новый черновик", attribute: "data-new-draft" },
      ],
    });
  }

  function renderFeedback({ kind = "error", title, messages = [], actions = [] }) {
    clearElement(feedback);
    feedback.className = kind === "error" ? "alert-error" : kind === "success" ? "alert-success" : "alert-info";
    feedback.setAttribute("role", kind === "error" ? "alert" : "status");
    feedback.append(createElement("strong", { text: title }));
    messages.forEach((message) => feedback.append(createElement("p", { text: message })));
    if (actions.length > 0) {
      const row = createElement("div", { className: "button-row" });
      actions.forEach((action) => {
        if (action.href) {
          row.append(createElement("a", {
            className: "button button-secondary",
            text: action.label,
            attributes: { href: action.href },
          }));
        } else {
          row.append(createElement("button", {
            className: "button button-secondary",
            text: action.label,
            attributes: { type: "button", [action.attribute]: "true" },
          }));
        }
      });
      feedback.append(row);
    }
    feedback.hidden = false;
  }

  function clearValidationErrors() {
    Object.entries(fieldErrors).forEach(([name, element]) => {
      element.textContent = "";
      element.hidden = true;
      fieldControls[name]?.removeAttribute("aria-invalid");
    });
    slotError.textContent = "";
    slotError.hidden = true;
    slotFieldset.removeAttribute("aria-invalid");
  }

  function clearFieldError(name) {
    const element = fieldErrors[name];
    if (element) {
      element.textContent = "";
      element.hidden = true;
    }
    if (name === "slotId") {
      slotError.textContent = "";
      slotError.hidden = true;
    }
    fieldControls[name]?.removeAttribute("aria-invalid");
  }

  function setFieldError(name, message) {
    const element = name === "slotId" ? slotError : fieldErrors[name];
    if (!element) {
      return;
    }
    element.textContent = message;
    element.hidden = false;
    fieldControls[name]?.setAttribute("aria-invalid", "true");
  }

  function focusField(name) {
    const control = fieldControls[name];
    if (name === "needTags") {
      control?.querySelector("input")?.focus();
    } else {
      control?.focus({ preventScroll: false });
    }
  }

  function applyValidationErrors(errors, shouldFocus = true) {
    clearValidationErrors();
    Object.entries(errors).forEach(([name, message]) => setFieldError(name, message));
    if (errors.consultationId) {
      setFieldError("slotId", errors.consultationId);
    }
    if (shouldFocus) {
      const first = FIELD_ORDER.find((name) => errors[name]) ?? (errors.consultationId ? "slotId" : null);
      if (first) {
        focusField(first);
      }
    }
  }

  function updateNeedCounter() {
    const length = needInput.value.trim().length;
    needCounter.textContent = `${length} / 1000; минимум 10`;
    needCounter.classList.toggle("is-invalid", length > 0 && length < 10);
  }

  function readFormValues() {
    return {
      consultationId: state.consultationId,
      slotId: state.selectedSlotId,
      instituteId: instituteSelect.value,
      displayName: displayNameInput.value,
      need: needInput.value,
      needTags: [...form.querySelectorAll('input[name="needTags"]:checked')].map((input) => input.value),
      demoConfirmed: demoInput.checked,
    };
  }

  function renderSummary() {
    clearElement(summary);
    const list = createElement("dl", { className: "summary-list" });
    const slot = selectedSlot();
    const booking = state.confirmation;
    const summarySlot = booking ?? slot;
    list.append(createSummaryRow("Консультация", state.consultation?.title ?? "Не выбрана"));
    if (summarySlot) {
      const duration = calculateSlotDurationMinutes(summarySlot) ?? state.consultation?.durationMinutes;
      list.append(
        createSummaryRow("Начало", formatDateTime(summarySlot.startsAt)),
        createSummaryRow("Окончание", formatDateTime(summarySlot.endsAt)),
        createSummaryRow("Длительность", duration ? formatDuration(duration) : "Уточняется"),
        createSummaryRow("Формат", getFormatLabel(summarySlot.mode)),
        createSummaryRow("Место", summarySlot.location),
      );
      if (slot) {
        list.append(createSummaryRow("Свободно", formatCapacity(getBookingSlotAvailability(slot).remainingCount)));
      }
    } else {
      list.append(createSummaryRow("Время", "Выберите доступный слот"));
    }

    const source = booking ?? readFormValues();
    const institute = state.catalog?.institutes.find((item) => item.id === source.instituteId);
    const tags = (source.needTags ?? []).map((tag) => NEED_TAG_LABELS[tag] ?? tag);
    list.append(
      createSummaryRow("Участник", cleanString(source.displayName) || "Не указано"),
      createSummaryRow("Институт", institute?.name || cleanString(source.instituteId) || "Не выбран"),
      createSummaryRow("Дополнительные потребности", tags.length ? tags.join(", ") : "Не выбраны"),
      createSummaryRow("Стоимость", "Бесплатно"),
      createSummaryRow("Аккаунт", "Не требуется"),
      createSummaryRow("Оплата", "Не требуется"),
    );
    summary.append(list);
  }

  function populateInstitutes() {
    const selected = instituteSelect.value || DEFAULT_INSTITUTE_ID;
    clearElement(instituteSelect);
    state.catalog?.institutes.forEach((institute) => {
      instituteSelect.append(createElement("option", {
        text: institute.name,
        attributes: { value: institute.id },
      }));
    });
    instituteSelect.value = state.catalog?.institutes.some((institute) => institute.id === selected)
      ? selected
      : DEFAULT_INSTITUTE_ID;
  }

  function renderSelectionDetails() {
    clearElement(selection);
    selection.setAttribute("aria-busy", "false");
    clearElement(selectionError);
    selectionError.hidden = true;

    if (!state.consultation) {
      selectionBadge.textContent = "Не выбрана";
      const empty = createElement("div", { className: "empty-state booking-selection" });
      empty.append(
        createElement("h3", { text: "Сначала выберите консультацию" }),
        createElement("p", { text: "В каталоге выберите карточку и свободное время. Идентификаторы будут переданы в адрес этой страницы." }),
        createCatalogLink("Открыть каталог"),
      );
      selection.append(empty);
      return;
    }

    const topic = getTopic(state.catalog, state.consultation.topicId);
    selectionBadge.textContent = topic?.name ?? "Консультация выбрана";
    const details = createElement("article", { className: "booking-selection" });
    details.append(
      createElement("p", { className: "eyebrow", text: topic?.name ?? state.consultation.topicId }),
      createElement("h3", { text: state.consultation.title }),
      createElement("p", { className: "booking-consultant", text: state.consultation.consultantLabel }),
      createElement("p", { text: state.consultation.description }),
      createElement("p", { className: "booking-audience", text: `Для кого: ${state.consultation.audienceLabel || "аудитория указана в описании"}` }),
    );
    selection.append(details);
  }

  function renderResolutionError(status) {
    const messages = {
      "unknown-consultation": "Консультация с указанным consultationId не найдена в актуальном справочнике.",
      "unknown-slot": "Слот с указанным slotId не найден. Выберите доступное время ниже или вернитесь в каталог.",
      "mismatched-slot": "Указанный slotId принадлежит другой консультации. Выберите слот из списка ниже или вернитесь в каталог.",
    };
    if (!messages[status]) {
      return;
    }
    clearElement(selectionError);
    selectionError.append(
      createElement("strong", { text: "Выбор по ссылке не удалось восстановить" }),
      createElement("p", { text: messages[status] }),
      createCatalogLink(),
    );
    selectionError.hidden = false;
  }

  function renderSlotOptions() {
    clearElement(slotOptions);
    slotFieldset.hidden = !state.consultation || Boolean(state.confirmation);
    if (!state.consultation || state.confirmation) {
      return;
    }
    const slots = [...state.consultation.slots].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    slots.forEach((slot, index) => {
      const availability = getBookingSlotAvailability(slot);
      const checked = state.selectedSlotId === slot.id;
      const disabled = !availability.isAvailable || state.pending || state.createdLookupMissing;
      const id = `booking-slot-${index}`;
      const input = createElement("input", {
        attributes: {
          type: "radio",
          name: "selectedSlot",
          id,
          value: slot.id,
          checked: checked,
          disabled,
          "aria-describedby": `booking-slot-hint booking-slot-error`,
        },
      });
      const content = createElement("span", { className: "slot-option-content" });
      content.append(
        createElement("strong", { text: formatSlotRange(slot.startsAt, slot.endsAt) }),
        createElement("span", { text: `${getFormatLabel(slot.mode)} · ${slot.location}` }),
        createElement("span", {
          className: "slot-availability",
          text: availability.isAvailable
            ? `Свободно: ${formatCapacity(availability.remainingCount)}`
            : `Недоступно: ${availability.reason.toLocaleLowerCase()}`,
        }),
      );
      const label = createElement("label", {
        className: `slot-option${checked ? " is-selected" : ""}${!availability.isAvailable ? " is-disabled" : ""}`,
        attributes: { for: id },
      }, [input, content]);
      slotOptions.append(label);
    });
    if (slots.length === 0) {
      slotOptions.append(createElement("p", { text: "Для этой консультации нет слотов в актуальном справочнике." }));
    }

    const slot = selectedSlot();
    if (slot && !getBookingSlotAvailability(slot).isAvailable) {
      setFieldError("slotId", `${getBookingSlotAvailability(slot).reason}. Выберите другое доступное время.`);
    }
  }

  function updateControls() {
    const slot = selectedSlot();
    const available = slot ? getBookingSlotAvailability(slot).isAvailable : false;
    const locked = state.pending || state.loading || Boolean(state.confirmation) || state.createdLookupMissing;
    slotFieldset.disabled = locked || !state.consultation;
    formFields.disabled = locked || !state.consultation || !slot || !available;
    submitButton.disabled = formFields.disabled;
    submitButton.textContent = state.pending
      ? "Сохраняем запись…"
      : state.operation
        ? "Повторить с тем же ключом"
        : "Сохранить демонстрационную запись";
    form.setAttribute("aria-busy", String(state.pending));
    detailsSection.hidden = !state.consultation || Boolean(state.confirmation);
    confirmation.hidden = !state.confirmation && !state.cancelledBooking;
    renderSlotOptions();
  }

  function renderConfirmation() {
    clearElement(confirmation);
    const booking = state.confirmation ?? state.cancelledBooking;
    if (!booking) {
      confirmation.hidden = true;
      confirmation.classList.remove("is-cancelled");
      return;
    }
    const isCancelled = Boolean(state.cancelledBooking);
    confirmation.classList.toggle("is-cancelled", isCancelled);
    confirmation.append(
      createElement("p", { className: "eyebrow", text: isCancelled ? "Статус записи" : "Запись подтверждена" }),
      createElement("h2", {
        text: isCancelled ? "Запись отменена" : "Запись сохранена",
        attributes: { id: "confirmation-title" },
      }),
      createElement("p", { text: booking.title }),
      createElement("p", {
        text: `${formatDateTime(booking.startsAt)}–${formatTime(booking.endsAt)}, ${getFormatLabel(booking.mode)}`,
      }),
      createElement("p", {}, [
        "ID записи: ",
        createElement("code", { className: "confirmation-id", text: booking.id }),
      ]),
      createElement("p", {
        text: isCancelled
          ? "Эта запись отменена и не является активной. Старый черновик не подставлен в форму; выберите слот и заполните новые данные или явно начните новый черновик."
          : runtime.mode === LOCAL_MODE
            ? "Подтверждение сохранено в локальном repository этого браузера."
            : "Подтверждение сохранено в общем демонстрационном серверном repository.",
      }),
    );
    const actions = createElement("div", { className: "button-row" });
    actions.append(createElement("a", {
      className: "button button-primary",
      text: isCancelled ? "Открыть отменённую запись" : "Открыть созданную запись",
      attributes: { href: createOrdersLink(booking.id) },
    }));
    if (isCancelled) {
      actions.append(createElement("button", {
        className: "button button-secondary",
        text: "Начать новый черновик",
        attributes: { type: "button", "data-new-draft": "true" },
      }));
    } else {
      actions.append(createCatalogLink("Выбрать другую консультацию"));
    }
    confirmation.append(actions);
    confirmation.append(createElement("p", {
      className: "text-small",
      text: isCancelled
        ? "Статус проверен по repository. Ссылка ведёт к отменённой записи, а не к активному подтверждению."
        : "Ссылка содержит ID созданной записи. При обновлении этой страницы подтверждение восстанавливается из repository, а не имитируется заново.",
    }));
    confirmation.hidden = false;
  }

  function renderSlotExtras() {
    const slot = selectedSlot();
    if (!slot) {
      weatherWidget?.cancel();
      weatherStartsAt = "";
      weatherContainer.hidden = true;
      onlineNote.hidden = true;
      extraPlaceholder.hidden = false;
      clearElement(weatherContainer);
      return;
    }
    extraPlaceholder.hidden = true;
    if (slot.mode === CONSULTATION_FORMAT.OFFLINE) {
      onlineNote.hidden = true;
      weatherContainer.hidden = false;
      if (weatherStartsAt !== slot.startsAt) {
        weatherStartsAt = slot.startsAt;
        weatherWidget = renderWeatherWidget(weatherContainer, { startsAt: slot.startsAt });
      }
    } else {
      weatherWidget?.cancel();
      weatherStartsAt = "";
      clearElement(weatherContainer);
      weatherContainer.hidden = true;
      onlineNote.hidden = false;
    }
  }

  function renderPayloadConflict() {
    renderFeedback({
      title: "Содержимое изменилось после попытки отправки",
      messages: [
        "Автоматическая смена ключа запрещена, чтобы не создать дубль. Проверьте, не завершилась ли предыдущая операция, или осознанно начните новый черновик с новым UUID при следующей отправке.",
      ],
      actions: [
        { label: "Открыть «Мои записи»", href: "./orders.html" },
        { label: "Начать новый черновик", attribute: "data-new-draft" },
      ],
    });
    feedback.focus({ preventScroll: false });
  }

  function startNewDraft() {
    discardPendingOperation();
    state.confirmation = null;
    state.cancelledBooking = null;
    state.createdLookupMissing = false;
    state.createdId = "";
    state.selectedSlotId = "";
    form.reset();
    instituteSelect.value = DEFAULT_INSTITUTE_ID;
    clearValidationErrors();
    hideFeedback();
    updateNeedCounter();
    updateUrl();
    renderSelectionDetails();
    updateControls();
    renderSummary();
    renderSlotExtras();
    setFieldError("slotId", "Новый черновик создан. Выберите время ещё раз; прежний UUID больше не используется.");
    slotFieldset.focus({ preventScroll: false });
  }

  function renderSubmissionError(error, { pendingSaved = false } = {}) {
    const normalized = normalizeRepositoryError(error);
    const fields = normalized.fields ?? {};
    const knownFields = Object.fromEntries(
      Object.entries(fields).filter(([name]) => FIELD_ORDER.includes(name) || name === "consultationId"),
    );
    if (Object.keys(knownFields).length > 0) {
      applyValidationErrors(knownFields, false);
    }

    const ordersAction = { label: "Открыть «Мои записи»", href: "./orders.html" };
    const newDraftAction = { label: "Начать новый черновик", attribute: "data-new-draft" };
    const retryAction = { label: "Повторить с тем же ключом", attribute: "data-booking-submit-retry" };
    const refreshAction = { label: "Обновить доступность", attribute: "data-booking-refresh" };
    let content;
    switch (normalized.code) {
      case ERROR_CODES.SLOT_FULL:
        content = {
          title: "На выбранном слоте закончились места",
          messages: ["Обновите доступность и выберите другое время. Для изменённого черновика явно начните новую операцию, не меняя старый ключ автоматически."],
          actions: [refreshAction, ordersAction, newDraftAction],
        };
        break;
      case ERROR_CODES.DUPLICATE_BOOKING:
        content = {
          title: "Активная запись на этот слот уже существует",
          messages: ["Откройте «Мои записи», чтобы найти существующую запись. Не отправляйте тот же черновик как новую операцию."],
          actions: [ordersAction, newDraftAction],
        };
        break;
      case ERROR_CODES.IDEMPOTENCY_CONFLICT:
        content = {
          title: "Ключ уже связан с другим содержимым",
          messages: ["Повтор остановлен. Проверьте существующие записи или начните новый черновик: новый UUID будет создан только при его следующей отправке."],
          actions: [ordersAction, newDraftAction],
        };
        break;
      case ERROR_CODES.STORAGE_UNAVAILABLE:
        content = {
          title: "Браузер не смог сохранить или подтвердить запись",
          messages: [normalized.message, "Проверьте доступность localStorage и Web Locks API, затем повторите неизменённую операцию с тем же ключом. Переход в другой режим автоматически не выполнялся."],
          actions: [retryAction, ordersAction],
        };
        break;
      case ERROR_CODES.UPSTREAM_UNAVAILABLE:
      case ERROR_CODES.UPSTREAM_TIMEOUT:
      case ERROR_CODES.INVALID_RESPONSE:
        content = {
          title: "Окончательный ответ не получен",
          messages: [pendingSaved
            ? "Запись могла быть принята. UUID и канонический черновик сохраняются в sessionStorage этой вкладки. После обновления введите прежние значения для повтора с тем же ключом или сначала проверьте «Мои записи». Новый ключ автоматически не создаётся."
            : "Запись могла быть принята. Сохранить операцию в sessionStorage не удалось: не обновляйте страницу и повторите неизменённую форму с тем же UUID либо проверьте «Мои записи».", normalized.message],
          actions: [retryAction, ordersAction, newDraftAction],
        };
        break;
      case ERROR_CODES.NOT_FOUND:
        content = {
          title: "Консультация или слот больше не найдены",
          messages: [normalized.message, "Обновите справочник и выберите актуальное время."],
          actions: [refreshAction, { label: "Открыть каталог", href: "./catalog.html" }],
        };
        break;
      case ERROR_CODES.VALIDATION_ERROR:
        content = {
          title: "Проверьте данные записи",
          messages: [normalized.message, "Переданные значения окончательно отклонены. Сохранённая операция очищена; после исправления будет создан новый UUID без конфликта со старым содержимым."],
          actions: [],
        };
        break;
      default:
        content = {
          title: "Не удалось подтвердить запись",
          messages: [normalized.message, "Не создавайте новую операцию, пока не проверили результат в «Моих записях»."],
          actions: normalized.retryable ? [retryAction, ordersAction] : [ordersAction, newDraftAction],
        };
    }
    renderFeedback(content);
    const firstField = FIELD_ORDER.find((name) => knownFields[name]);
    if (firstField) {
      focusField(firstField);
    } else {
      feedback.focus({ preventScroll: false });
    }
  }

  async function submitBooking(event) {
    event.preventDefault();
    if (state.pending || state.confirmation) {
      return;
    }
    const validation = validateBookingValues(readFormValues(), {
      slot: selectedSlot(),
      instituteIds: state.catalog?.institutes.map((institute) => institute.id) ?? [],
      allowedInstituteIds: state.consultation?.instituteIds,
    });
    if (!validation.isValid) {
      applyValidationErrors(validation.errors);
      renderFeedback({
        title: "Форма пока не готова",
        messages: [state.operation
          ? "Исправьте отмеченные поля. Сохранённый UUID не изменён; новый запрос не отправлялся."
          : "Исправьте отмеченные поля. UUID ещё не создан, запрос не отправлялся."],
        actions: [],
      });
      return;
    }

    let operationResult;
    try {
      operationResult = ensureBookingOperation(state.operation, validation.draft);
    } catch (error) {
      renderSubmissionError(error);
      return;
    }
    if (operationResult.conflict) {
      renderPayloadConflict();
      return;
    }
    state.operation = operationResult.operation;
    state.restoredPending = false;
    const pendingSaved = savePendingBookingOperation(state.operation, validation.draft);
    const operationKey = state.operation.key;
    state.pending = true;
    clearValidationErrors();
    updateControls();
    renderFeedback({
      kind: "info",
      title: "Создаём демонстрационную запись…",
      messages: [pendingSaved
        ? "UUID и канонический черновик сохранены в sessionStorage этой вкладки. После обновления введите прежние значения: автозаполнение намеренно не выполняется."
        : "Не удалось сохранить операцию в sessionStorage. Не обновляйте страницу до ответа; повтор без обновления использует тот же UUID."],
    });

    try {
      const booking = await runtime.repository.createBooking(validation.draft, {
        idempotencyKey: operationKey,
      });
      if (![BOOKING_STATUS.ACTIVE, BOOKING_STATUS.CANCELLED].includes(booking.status)) {
        throw new RepositoryError(ERROR_CODES.INVALID_RESPONSE, "Repository вернул неизвестный статус записи.");
      }
      state.pending = false;
      discardPendingOperation();
      if (booking.status === BOOKING_STATUS.ACTIVE) {
        const bookedSlot = selectedSlot();
        if (bookedSlot) {
          const availability = getBookingSlotAvailability(bookedSlot);
          bookedSlot.remainingCount = Math.max(0, availability.remainingCount - 1);
          if (Number.isInteger(bookedSlot.reservedCount)) {
            bookedSlot.reservedCount += 1;
          }
          if (bookedSlot.remainingCount === 0) {
            bookedSlot.isOpen = false;
          }
        }
      }
      state.confirmation = booking.status === BOOKING_STATUS.ACTIVE ? booking : null;
      state.cancelledBooking = booking.status === BOOKING_STATUS.CANCELLED ? booking : null;
      state.createdId = booking.id;
      state.createdLookupMissing = false;
      hideFeedback();
      updateUrl();
      updateControls();
      renderConfirmation();
      renderSummary();
      renderSlotExtras();
      confirmation.focus({ preventScroll: false });
    } catch (error) {
      state.pending = false;
      if (shouldDiscardPendingOperation(error)) {
        discardPendingOperation();
      }
      updateControls();
      renderSubmissionError(error, { pendingSaved });
      renderSummary();
    }
  }

  function renderLoading() {
    state.loading = true;
    state.confirmation = null;
    state.cancelledBooking = null;
    confirmation.hidden = true;
    selection.setAttribute("aria-busy", "true");
    clearElement(selection);
    const skeleton = createElement("div", {
      className: "booking-selection-skeleton",
      attributes: { "aria-hidden": "true" },
    });
    skeleton.append(
      createElement("div", { className: "skeleton skeleton-line skeleton-line-short" }),
      createElement("div", { className: "skeleton skeleton-line" }),
      createElement("div", { className: "skeleton skeleton-line" }),
    );
    selection.append(skeleton);
    selectionBadge.textContent = "Загрузка";
    selectionError.hidden = true;
    hideFeedback();
    updateControls();
  }

  function renderLoadError(error) {
    state.loading = false;
    state.consultation = null;
    state.confirmation = null;
    state.cancelledBooking = null;
    clearElement(selection);
    selection.setAttribute("aria-busy", "false");
    selectionBadge.textContent = "Ошибка загрузки";
    clearElement(selectionError);
    selectionError.append(
      createElement("strong", { text: "Не удалось загрузить данные для записи" }),
      createElement("p", { text: getPublicErrorMessage(error) }),
      createElement("p", { text: "Автоматический fallback в local не выполнялся. Повторите запрос или явно выберите local mode с отдельными записями." }),
    );
    const actions = createElement("div", { className: "button-row" });
    actions.append(createElement("button", {
      className: "button button-secondary",
      text: "Повторить загрузку",
      attributes: { type: "button", "data-booking-retry": "true" },
    }));
    if (runtime.mode !== LOCAL_MODE) {
      actions.append(createElement("button", {
        className: "button button-secondary",
        text: "Использовать local (forceLocalRepository)",
        attributes: { type: "button", "data-force-local-repository": "true" },
      }));
    }
    actions.append(createCatalogLink());
    selectionError.append(actions);
    selectionError.hidden = false;
    slotFieldset.hidden = true;
    detailsSection.hidden = true;
    confirmation.hidden = true;
    weatherWidget?.cancel();
    weatherStartsAt = "";
    clearElement(weatherContainer);
    weatherContainer.hidden = true;
    onlineNote.hidden = true;
    extraPlaceholder.hidden = false;
    updateControls();
    renderSummary();
  }

  async function loadBooking() {
    const repository = runtime.repository;
    if (!repository) {
      return;
    }
    const currentRequest = ++requestNumber;
    renderLoading();
    try {
      const [catalog, bookings] = await Promise.all([
        repository.getCatalog({}),
        state.createdId ? repository.listBookings({}) : Promise.resolve(null),
      ]);
      if (currentRequest !== requestNumber || repository !== runtime.repository) {
        return;
      }
      state.catalog = catalog;
      populateInstitutes();
      const resolution = resolveBookingSelection(catalog, state.consultationId, state.selectedSlotId);
      state.consultation = resolution.consultation;
      state.confirmation = null;
      state.cancelledBooking = null;
      state.createdLookupMissing = false;
      if (resolution.status === "needs-slot" || resolution.status === "missing-consultation"
        || resolution.status === "unknown-consultation") {
        state.selectedSlotId = "";
      }

      if (state.createdId && Array.isArray(bookings)) {
        const restored = resolution.status === "ok"
          ? resolveBookingConfirmation(
            bookings,
            state.createdId,
            state.consultationId,
            state.selectedSlotId,
          )
          : { status: "mismatched", booking: null };
        if (restored.status === "active") {
          state.confirmation = restored.booking;
        } else if (restored.status === "cancelled") {
          state.cancelledBooking = restored.booking;
        } else {
          state.createdLookupMissing = true;
        }
        if (restored.booking && pendingOperationMatchesBooking(state.operation, restored.booking)) {
          discardPendingOperation();
        }
      }

      state.loading = false;
      renderSelectionDetails();
      renderResolutionError(resolution.status);
      updateControls();
      renderConfirmation();
      renderSummary();
      renderSlotExtras();
      if (state.createdLookupMissing) {
        renderFeedback({
          title: "Созданная запись не найдена в текущем repository",
          messages: ["Подтверждение не будет выдумано. Возможно, выбран другой режим хранения или владелец. Проверьте «Мои записи» и не создавайте дубль; для новой операции начните черновик явно."],
          actions: [
            { label: "Проверить «Мои записи»", href: createOrdersLink(state.createdId) },
            { label: "Начать новый черновик", attribute: "data-new-draft" },
          ],
        });
      } else {
        renderRestoredPendingNotice();
      }
    } catch (error) {
      if (currentRequest === requestNumber && repository === runtime.repository) {
        renderLoadError(error);
      }
    }
  }

  form.addEventListener("submit", (event) => {
    void submitBooking(event);
  });
  form.addEventListener("input", (event) => {
    if (event.target.name) {
      clearFieldError(event.target.name);
    }
    updateNeedCounter();
    renderSummary();
  });
  form.addEventListener("change", (event) => {
    if (event.target.name) {
      clearFieldError(event.target.name);
    }
    renderSummary();
  });
  slotOptions.addEventListener("change", (event) => {
    if (!event.target.matches('input[name="selectedSlot"]') || event.target.disabled) {
      return;
    }
    state.selectedSlotId = event.target.value;
    clearFieldError("slotId");
    hideFeedback();
    updateUrl();
    updateControls();
    renderSummary();
    renderSlotExtras();
    [...slotOptions.querySelectorAll('input[name="selectedSlot"]')]
      .find((input) => input.value === event.target.value)
      ?.focus({ preventScroll: true });
  });
  feedback.addEventListener("click", (event) => {
    if (event.target.closest("[data-new-draft]")) {
      startNewDraft();
    } else if (event.target.closest("[data-booking-submit-retry]")) {
      form.requestSubmit();
    } else if (event.target.closest("[data-booking-refresh]")) {
      void loadBooking();
    }
  });
  confirmation.addEventListener("click", (event) => {
    if (event.target.closest("[data-new-draft]")) {
      startNewDraft();
    }
  });
  selectionError.addEventListener("click", (event) => {
    if (event.target.closest("[data-booking-retry]")) {
      void loadBooking();
    } else if (event.target.closest("[data-force-local-repository]")) {
      void runtime.forceLocal();
    }
  });

  runtime = createRepositoryRuntime({
    root,
    onStateChange(repositoryState) {
      requestNumber += 1;
      if (repositoryState.status === "loading") {
        renderLoading();
      } else if (repositoryState.status === "ready") {
        void loadBooking();
      } else if (repositoryState.status === "error") {
        state.loading = false;
        state.consultation = null;
        state.confirmation = null;
        state.cancelledBooking = null;
        weatherWidget?.cancel();
        weatherStartsAt = "";
        weatherContainer.hidden = true;
        onlineNote.hidden = true;
        extraPlaceholder.hidden = false;
        selectionError.hidden = true;
        clearElement(selection);
        selection.setAttribute("aria-busy", "false");
        selection.append(
          createElement("h3", { text: "Repository недоступен" }),
          createElement("p", { text: "Повторите проверку режима или явно выберите local mode в сообщении выше." }),
        );
        selectionBadge.textContent = "Нет подключения";
        slotFieldset.hidden = true;
        detailsSection.hidden = true;
        confirmation.hidden = true;
        updateControls();
        renderSummary();
      }
    },
  });

  updateNeedCounter();
  clearValidationErrors();
  renderSummary();
  void runtime.connect();
  return runtime;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initializeBooking(document), { once: true });
  } else {
    initializeBooking(document);
  }
}
