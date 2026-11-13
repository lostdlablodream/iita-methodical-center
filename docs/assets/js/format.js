import { DEFAULT_LOCALE, TIME_ZONE } from "./config.js";

const dateFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

const dateTimeFormatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

const pluralRules = new Intl.PluralRules(DEFAULT_LOCALE);

function asValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = asValidDate(value);
  return date ? dateFormatter.format(date) : "Дата уточняется";
}

export function formatTime(value) {
  const date = asValidDate(value);
  return date ? timeFormatter.format(date) : "Время уточняется";
}

export function formatDateTime(value) {
  const date = asValidDate(value);
  return date ? dateTimeFormatter.format(date) : "Дата и время уточняются";
}

export function formatSlotRange(startsAt, endsAt) {
  const start = asValidDate(startsAt);
  const end = asValidDate(endsAt);

  if (!start || !end) {
    return "Дата и время уточняются";
  }

  if (dateFormatter.format(start) === dateFormatter.format(end)) {
    return `${dateFormatter.format(start)}, ${timeFormatter.format(start)}–${timeFormatter.format(end)}`;
  }

  return `${dateTimeFormatter.format(start)} — ${dateTimeFormatter.format(end)}`;
}

export function pluralize(count, forms) {
  if (!Array.isArray(forms) || forms.length !== 3) {
    throw new TypeError("pluralize ожидает три формы существительного");
  }

  const number = Math.abs(Math.trunc(Number(count) || 0));
  const rule = pluralRules.select(number);
  const formIndex = rule === "one" ? 0 : rule === "few" ? 1 : 2;
  return forms[formIndex];
}

export function formatCapacity(count) {
  const number = Math.max(0, Math.trunc(Number(count) || 0));
  return `${number} ${pluralize(number, ["место", "места", "мест"])}`;
}

export function formatDuration(minutes) {
  const value = Math.max(0, Math.trunc(Number(minutes) || 0));
  return `${value} ${pluralize(value, ["минута", "минуты", "минут"])}`;
}
