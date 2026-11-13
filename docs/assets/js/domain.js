export const CONSULTATION_FORMAT = Object.freeze({
  ONLINE: "online",
  OFFLINE: "offline",
});

export const FORMAT_LABELS = Object.freeze({
  [CONSULTATION_FORMAT.ONLINE]: "Онлайн",
  [CONSULTATION_FORMAT.OFFLINE]: "Очно",
});

export const BOOKING_STATUS = Object.freeze({
  ACTIVE: "active",
  CANCELLED: "cancelled",
});

export const NEED_TAGS = Object.freeze({
  MATERIALS: "materials",
  ASSESSMENT: "assessment",
  DIGITAL_TOOLS: "digital-tools",
  ACCESSIBILITY: "accessibility",
});

export function getInstitute(seed, instituteId) {
  return seed?.institutes?.find(({ id }) => id === instituteId) ?? null;
}

export function getTopic(seed, topicId) {
  return seed?.topics?.find(({ id }) => id === topicId) ?? null;
}

export function getConsultation(seed, consultationId) {
  return seed?.consultations?.find(({ id }) => id === consultationId) ?? null;
}

export function getSlot(consultation, slotId) {
  return consultation?.slots?.find(({ id }) => id === slotId) ?? null;
}

export function findConsultationSlot(seed, slotId) {
  for (const consultation of seed?.consultations ?? []) {
    const slot = getSlot(consultation, slotId);
    if (slot) {
      return { consultation, slot };
    }
  }
  return null;
}

export function isInstituteAllowed(consultation, instituteId) {
  return Boolean(consultation?.instituteIds?.includes(instituteId));
}

export function getRemainingCapacity(slot) {
  const capacity = Number.isInteger(slot?.capacity) ? slot.capacity : 0;
  const reserved = Number.isInteger(slot?.reservedCount) ? slot.reservedCount : 0;
  return Math.max(0, capacity - reserved);
}

export function isFutureSlot(slot, now = new Date()) {
  const startsAt = new Date(slot?.startsAt);
  const reference = now instanceof Date ? now : new Date(now);
  return !Number.isNaN(startsAt.getTime())
    && !Number.isNaN(reference.getTime())
    && startsAt.getTime() > reference.getTime();
}

export function getFormatLabel(format) {
  return FORMAT_LABELS[format] ?? "Формат уточняется";
}
