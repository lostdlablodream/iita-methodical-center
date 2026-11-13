import json
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qsl

ALLOWED_NEED_TAGS = frozenset(
    {"materials", "assessment", "digital-tools", "accessibility"}
)
ALLOWED_MODES = frozenset({"online", "offline"})
BOOKING_FIELDS = frozenset(
    {"consultationId", "slotId", "instituteId", "displayName", "need", "needTags"}
)
IDENTIFIER_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,127}")
OWNER_TOKEN_RE = re.compile(r"Bearer ([0-9a-fA-F]{64,})")
RFC3339_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})"
)
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class ApiError(Exception):
    def __init__(self, status, code, message, fields=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields or {}


def validation(message, fields=None, status=422):
    return ApiError(status, "VALIDATION_ERROR", message, fields)


def not_found(message, fields=None):
    return ApiError(404, "NOT_FOUND", message, fields)


def conflict(code, message, fields=None):
    return ApiError(409, code, message, fields)


def decode_json_object(data):
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise validation("Тело запроса должно быть JSON в UTF-8.", status=400) from error

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate object key")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("non-finite number")

    try:
        value = json.loads(
            text, object_pairs_hook=unique_object, parse_constant=reject_constant
        )
    except (json.JSONDecodeError, ValueError) as error:
        raise validation("Тело запроса содержит некорректный JSON.", status=400) from error
    if not isinstance(value, dict):
        raise validation("Тело запроса должно быть JSON-объектом.", status=422)
    return value


def require_owner_token(header):
    match = OWNER_TOKEN_RE.fullmatch(header.strip() if isinstance(header, str) else "")
    if not match:
        raise ApiError(
            401,
            "OWNER_MISMATCH",
            "Требуется Bearer owner token из не менее чем 64 шестнадцатеричных символов.",
            {"ownerToken": "Проверьте токен владельца записей."},
        )
    return match.group(1)


def require_idempotency_key(header):
    key = header.strip() if isinstance(header, str) else ""
    if not key or len(key) > 200 or CONTROL_RE.search(key):
        raise validation(
            "Некорректный ключ идемпотентности.",
            {"idempotencyKey": "Укажите ключ длиной от 1 до 200 символов без управляющих символов."},
            status=400,
        )
    return key


def parse_query(query, allowed_fields):
    try:
        pairs = parse_qsl(
            query, keep_blank_values=True, max_num_fields=20, encoding="utf-8", errors="strict"
        )
    except (ValueError, UnicodeDecodeError) as error:
        raise validation("Некорректная строка запроса.", status=400) from error
    fields = {}
    values = {}
    for name, value in pairs:
        if name not in allowed_fields:
            fields[name or "query"] = "Неизвестный параметр запроса."
        elif name in values:
            fields[name] = "Параметр можно передать только один раз."
        else:
            values[name] = value
    if fields:
        raise validation("Некорректные параметры запроса.", fields, status=400)
    return values


def normalize_identifier(value, field):
    normalized = value.strip() if isinstance(value, str) else ""
    if not IDENTIFIER_RE.fullmatch(normalized):
        raise validation(
            "Некорректный идентификатор.",
            {field: "Используйте строчные буквы, цифры и дефисы, не более 128 символов."},
        )
    return normalized


def normalize_booking_id(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError) as error:
        raise validation(
            "Некорректный ID записи.", {"bookingId": "Укажите UUID записи."}
        ) from error
    if str(parsed) != value.lower():
        raise validation(
            "Некорректный ID записи.", {"bookingId": "Укажите канонический UUID записи."}
        )
    return str(parsed)


def parse_date_filter(value, field):
    normalized = value.strip()
    try:
        if DATE_RE.fullmatch(normalized):
            parsed = datetime.fromisoformat(normalized).replace(tzinfo=timezone.utc)
        elif RFC3339_RE.fullmatch(normalized):
            parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        else:
            raise ValueError("not RFC3339")
    except ValueError as error:
        raise validation(
            "Некорректные фильтры каталога.",
            {field: "Укажите дату или дату и время RFC3339."},
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise validation(
            "Некорректные фильтры каталога.",
            {field: "Укажите часовой пояс."},
        )
    return parsed.astimezone(timezone.utc)


def parse_stored_datetime(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def normalize_catalog_filters(query):
    values = parse_query(
        query, {"query", "topicId", "instituteId", "mode", "from", "to"}
    )
    filters = {}
    for name, value in values.items():
        trimmed = value.strip()
        if trimmed:
            filters[name] = trimmed
    for name in ("topicId", "instituteId"):
        if name in filters:
            filters[name] = normalize_identifier(filters[name], name)
    if "query" in filters and len(filters["query"]) > 200:
        raise validation(
            "Некорректные фильтры каталога.",
            {"query": "Поисковый запрос не должен превышать 200 символов."},
        )
    if "mode" in filters and filters["mode"] not in ALLOWED_MODES:
        raise validation(
            "Некорректные фильтры каталога.",
            {"mode": "Допустимые форматы: online, offline."},
        )
    from_time = parse_date_filter(filters["from"], "from") if "from" in filters else None
    to_time = parse_date_filter(filters["to"], "to") if "to" in filters else None
    if from_time and to_time and from_time > to_time:
        raise validation(
            "Некорректные фильтры каталога.",
            {"to": "Конец диапазона должен быть не раньше его начала."},
        )
    filters["fromTime"] = from_time
    filters["toTime"] = to_time
    return filters


def normalize_analytics_filters(query):
    values = parse_query(query, {"topicId"})
    if "topicId" not in values:
        return None
    return normalize_identifier(values["topicId"], "topicId")


def normalize_booking_status(query):
    values = parse_query(query, {"status"})
    if "status" not in values:
        return None
    status = values["status"].strip()
    if status not in {"active", "cancelled"}:
        raise validation(
            "Некорректный фильтр статуса.",
            {"status": "Допустимые статусы: active, cancelled."},
        )
    return status


def normalize_weather_filters(query):
    values = parse_query(query, {"current"})
    if "current" not in values or values["current"].strip().lower() in {"1", "true"}:
        return True
    raise validation(
        "Поддерживается только текущий прогноз.",
        {"current": "Передайте current=true или опустите параметр."},
    )


def normalize_booking_payload(value):
    supplied = set(value)
    fields = {
        name: "Поле обязательно." for name in sorted(BOOKING_FIELDS - supplied)
    }
    fields.update(
        {name: "Недопустимое поле." for name in sorted(supplied - BOOKING_FIELDS)}
    )
    if fields:
        raise validation("Проверьте поля записи.", fields)

    payload = {}
    for name in ("consultationId", "slotId", "instituteId"):
        raw = value[name]
        normalized = raw.strip() if isinstance(raw, str) else ""
        if not IDENTIFIER_RE.fullmatch(normalized):
            fields[name] = "Укажите корректный ID из каталога."
        payload[name] = normalized

    display_name = value["displayName"].strip() if isinstance(value["displayName"], str) else ""
    need = value["need"].strip() if isinstance(value["need"], str) else ""
    if not 2 <= len(display_name) <= 80:
        fields["displayName"] = "Укажите имя длиной от 2 до 80 символов после trim."
    if not 10 <= len(need) <= 1000:
        fields["need"] = "Опишите потребность: от 10 до 1000 символов после trim."
    payload["displayName"] = display_name
    payload["need"] = need

    raw_tags = value["needTags"]
    if not isinstance(raw_tags, list) or any(not isinstance(tag, str) for tag in raw_tags):
        fields["needTags"] = "Теги потребности должны быть массивом строк."
        tags = None
    else:
        tags = sorted({tag.strip() for tag in raw_tags})
        if any(tag not in ALLOWED_NEED_TAGS for tag in tags):
            fields["needTags"] = (
                "Допустимые теги: materials, assessment, digital-tools, accessibility."
            )
    payload["needTags"] = tags

    if fields:
        raise validation("Проверьте поля записи.", fields)
    return payload
