const UTF8_ENCODER = new TextEncoder();

function pad(value) {
  return String(value).padStart(2, "0");
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIcsUtc(value) {
  const date = asDate(value);
  if (!date) {
    throw new TypeError("Для ICS требуется корректная дата");
  }
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function escapeIcsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

export function foldIcsLine(line, maxOctets = 75) {
  if (!Number.isInteger(maxOctets) || maxOctets < 8) {
    throw new TypeError("maxOctets должен быть целым числом не меньше 8");
  }

  const value = String(line);
  const chunks = [];
  let chunk = "";
  let chunkBytes = 0;
  let limit = maxOctets;

  for (const character of value) {
    const bytes = UTF8_ENCODER.encode(character).length;
    if (chunk && chunkBytes + bytes > limit) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
      limit = maxOctets - 1;
    }
    chunk += character;
    chunkBytes += bytes;
  }
  if (chunk || chunks.length === 0) {
    chunks.push(chunk);
  }
  return chunks.join("\r\n ");
}

export function createIcsFilename(bookingId) {
  const normalized = String(bookingId ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80) || "booking";
  return `metodika-${normalized}.ics`;
}

export function buildBookingIcs(booking, { now = new Date() } = {}) {
  if (!booking || typeof booking.id !== "string" || !booking.id.trim()) {
    throw new TypeError("Для ICS требуется ID записи");
  }
  const startsAt = formatIcsUtc(booking.startsAt);
  const endsAt = formatIcsUtc(booking.endsAt);
  if (asDate(booking.endsAt).getTime() <= asDate(booking.startsAt).getTime()) {
    throw new TypeError("Окончание события ICS должно быть позже начала");
  }
  const dtStamp = formatIcsUtc(booking.createdAt ?? now);
  const modeLabel = booking.mode === "online" ? "Онлайн" : booking.mode === "offline" ? "Очно" : booking.mode;
  const description = `Потребность: ${booking.need ?? "Не указана"}\nФормат: ${modeLabel ?? "Уточняется"}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//IITA//Metodika//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(booking.id.trim())}@metodika.invalid`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${startsAt}`,
    `DTEND:${endsAt}`,
    `SUMMARY:${escapeIcsText(booking.title ?? "Методическая консультация")}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    `LOCATION:${escapeIcsText(booking.location ?? "")}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map((line) => foldIcsLine(line)).join("\r\n")}\r\n`;
}
