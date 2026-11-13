import hashlib
import hmac
import json
import math
import socket
import sqlite3
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit

from .validation import (
    ALLOWED_NEED_TAGS,
    ApiError,
    conflict,
    normalize_analytics_filters,
    normalize_booking_id,
    normalize_booking_payload,
    normalize_booking_status,
    normalize_catalog_filters,
    normalize_weather_filters,
    not_found,
    parse_stored_datetime,
    validation,
)

WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_FIELDS = "temperature_2m,precipitation_probability,weather_code,wind_speed_10m"
WEATHER_RESPONSE_LIMIT = 65536

BOOKING_SELECT = """
SELECT
    b.id, b.consultation_id, b.slot_id, b.institute_id,
    b.display_name, b.need, b.status, b.created_at, b.cancelled_at,
    c.title, c.topic_id, c.duration_minutes, c.consultant_label,
    s.starts_at, s.ends_at, s.mode, s.location
FROM bookings b
JOIN consultations c ON c.id = b.consultation_id
JOIN slots s ON s.id = b.slot_id
"""


def utc_now():
    return format_datetime(datetime.now(timezone.utc))


def format_datetime(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def owner_hash(owner_token):
    return hashlib.sha256(owner_token.encode("ascii")).hexdigest()


def request_hash(operation, payload):
    canonical = json.dumps(
        {"operation": operation, "payload": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _existing_idempotency(connection, hashed_owner, key):
    return connection.execute(
        """
        SELECT operation, request_hash, response_body
        FROM idempotency_keys
        WHERE owner_hash = ? AND key = ?
        """,
        (hashed_owner, key),
    ).fetchone()


def _replay_or_conflict(existing, operation, digest):
    if existing is None:
        return None
    if existing["operation"] == operation and hmac.compare_digest(
        existing["request_hash"], digest
    ):
        return json.loads(existing["response_body"])
    raise conflict(
        "IDEMPOTENCY_CONFLICT",
        "Этот ключ идемпотентности уже использован для другой операции или содержимого.",
        {"idempotencyKey": "Используйте новый ключ для этого запроса."},
    )


def _save_idempotency(
    connection, hashed_owner, key, operation, digest, status, response, created_at
):
    connection.execute(
        """
        INSERT INTO idempotency_keys (
            owner_hash, key, operation, request_hash,
            response_status, response_body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            hashed_owner,
            key,
            operation,
            digest,
            status,
            json.dumps(response, ensure_ascii=False, separators=(",", ":")),
            created_at,
        ),
    )


def get_catalog(connection, query):
    filters = normalize_catalog_filters(query)
    meta = json.loads(
        connection.execute(
            "SELECT value FROM schema_meta WHERE key = 'seed_meta'"
        ).fetchone()[0]
    )
    institutes = [
        {"id": row["id"], "name": row["name"]}
        for row in connection.execute("SELECT id, name FROM institutes ORDER BY position")
    ]
    topics = [
        {"id": row["id"], "name": row["name"], "description": row["description"]}
        for row in connection.execute(
            "SELECT id, name, description FROM topics ORDER BY position"
        )
    ]

    consultation_rows = connection.execute(
        """
        SELECT id, topic_id, title, summary, description, audience_label,
               consultant_label, duration_minutes
        FROM consultations
        ORDER BY position
        """
    ).fetchall()
    institute_ids = {}
    for row in connection.execute(
        """
        SELECT consultation_id, institute_id
        FROM consultation_institutes
        ORDER BY consultation_id, position
        """
    ):
        institute_ids.setdefault(row["consultation_id"], []).append(row["institute_id"])
    tags = {}
    for row in connection.execute(
        """
        SELECT consultation_id, tag
        FROM consultation_tags
        ORDER BY consultation_id, position
        """
    ):
        tags.setdefault(row["consultation_id"], []).append(row["tag"])
    slots = {}
    now = datetime.now(timezone.utc)
    for row in connection.execute(
        """
        SELECT id, consultation_id, starts_at, ends_at, mode, location,
               capacity, reserved_count
        FROM slots
        ORDER BY consultation_id, position
        """
    ):
        starts_at = parse_stored_datetime(row["starts_at"])
        if filters.get("mode") and row["mode"] != filters["mode"]:
            continue
        if filters["fromTime"] and starts_at < filters["fromTime"]:
            continue
        if filters["toTime"] and starts_at > filters["toTime"]:
            continue
        remaining = row["capacity"] - row["reserved_count"]
        slots.setdefault(row["consultation_id"], []).append(
            {
                "id": row["id"],
                "startsAt": row["starts_at"],
                "endsAt": row["ends_at"],
                "mode": row["mode"],
                "location": row["location"],
                "capacity": row["capacity"],
                "reservedCount": row["reserved_count"],
                "remainingCount": remaining,
                "isOpen": starts_at > now and remaining > 0,
            }
        )

    has_slot_filters = any(filters.get(name) for name in ("mode", "from", "to"))
    query_text = filters.get("query", "").casefold()
    consultations = []
    for row in consultation_rows:
        consultation_institutes = institute_ids.get(row["id"], [])
        consultation_tags = tags.get(row["id"], [])
        if filters.get("topicId") and row["topic_id"] != filters["topicId"]:
            continue
        if filters.get("instituteId") and filters["instituteId"] not in consultation_institutes:
            continue
        if query_text:
            searchable = "\n".join(
                [
                    row["title"],
                    row["summary"],
                    row["description"],
                    *consultation_tags,
                ]
            ).casefold()
            if query_text not in searchable:
                continue
        consultation_slots = slots.get(row["id"], [])
        if has_slot_filters and not consultation_slots:
            continue
        consultations.append(
            {
                "id": row["id"],
                "topicId": row["topic_id"],
                "title": row["title"],
                "summary": row["summary"],
                "description": row["description"],
                "audienceLabel": row["audience_label"],
                "instituteIds": consultation_institutes,
                "consultantLabel": row["consultant_label"],
                "durationMinutes": row["duration_minutes"],
                "tags": consultation_tags,
                "slots": consultation_slots,
            }
        )
    return {
        "meta": meta,
        "institutes": institutes,
        "topics": topics,
        "consultations": consultations,
    }


def _booking_dto(connection, row):
    need_tags = [
        tag_row["tag"]
        for tag_row in connection.execute(
            "SELECT tag FROM booking_need_tags WHERE booking_id = ? ORDER BY tag",
            (row["id"],),
        )
    ]
    return {
        "id": row["id"],
        "consultationId": row["consultation_id"],
        "slotId": row["slot_id"],
        "instituteId": row["institute_id"],
        "displayName": row["display_name"],
        "need": row["need"],
        "needTags": need_tags,
        "title": row["title"],
        "topicId": row["topic_id"],
        "startsAt": row["starts_at"],
        "endsAt": row["ends_at"],
        "mode": row["mode"],
        "location": row["location"],
        "durationMinutes": row["duration_minutes"],
        "consultantLabel": row["consultant_label"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "cancelledAt": row["cancelled_at"],
    }


def _get_booking(connection, booking_id, hashed_owner):
    row = connection.execute(
        BOOKING_SELECT + " WHERE b.id = ? AND b.owner_hash = ?",
        (booking_id, hashed_owner),
    ).fetchone()
    return _booking_dto(connection, row) if row else None


def list_bookings(connection, owner_token, query):
    hashed_owner = owner_hash(owner_token)
    status = normalize_booking_status(query)
    sql = BOOKING_SELECT + " WHERE b.owner_hash = ?"
    parameters = [hashed_owner]
    if status:
        sql += " AND b.status = ?"
        parameters.append(status)
    sql += " ORDER BY s.starts_at, b.created_at, b.id"
    rows = connection.execute(sql, parameters).fetchall()
    return {"bookings": [_booking_dto(connection, row) for row in rows]}


def create_booking(connection, owner_token, key, value):
    payload = normalize_booking_payload(value)
    hashed_owner = owner_hash(owner_token)
    digest = request_hash("create", payload)
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "INSERT OR IGNORE INTO owners (token_hash, created_at) VALUES (?, ?)",
            (hashed_owner, now),
        )
        replay = _replay_or_conflict(
            _existing_idempotency(connection, hashed_owner, key), "create", digest
        )
        if replay is not None:
            connection.commit()
            return 200, replay

        consultation = connection.execute(
            "SELECT id FROM consultations WHERE id = ?", (payload["consultationId"],)
        ).fetchone()
        if not consultation:
            raise not_found(
                "Выбранная консультация не найдена.",
                {"consultationId": "Выберите консультацию из актуального каталога."},
            )
        slot = connection.execute(
            "SELECT id, consultation_id, starts_at FROM slots WHERE id = ?",
            (payload["slotId"],),
        ).fetchone()
        if not slot:
            raise not_found(
                "Выбранный слот не найден.",
                {"slotId": "Выберите слот из актуального каталога."},
            )
        if slot["consultation_id"] != payload["consultationId"]:
            raise validation(
                "consultationId и slotId не образуют допустимую пару.",
                {"slotId": "Слот принадлежит другой консультации."},
            )
        institute = connection.execute(
            "SELECT id FROM institutes WHERE id = ?", (payload["instituteId"],)
        ).fetchone()
        if not institute:
            raise validation(
                "Выбранный институт отсутствует в справочнике.",
                {"instituteId": "Выберите институт из справочника."},
            )
        allowed = connection.execute(
            """
            SELECT 1 FROM consultation_institutes
            WHERE consultation_id = ? AND institute_id = ?
            """,
            (payload["consultationId"], payload["instituteId"]),
        ).fetchone()
        if not allowed:
            raise validation(
                "Эта консультация недоступна для выбранного института.",
                {"instituteId": "Выберите разрешённый институт."},
            )
        if parse_stored_datetime(slot["starts_at"]) <= datetime.now(timezone.utc):
            raise validation(
                "Выбранный слот недоступен для новой записи.",
                {"slotId": "Слот уже прошёл."},
            )
        duplicate = connection.execute(
            """
            SELECT 1 FROM bookings
            WHERE owner_hash = ? AND slot_id = ? AND status = 'active'
            """,
            (hashed_owner, payload["slotId"]),
        ).fetchone()
        if duplicate:
            raise conflict(
                "DUPLICATE_BOOKING",
                "У вас уже есть активная запись на этот слот.",
                {"slotId": "Отмените текущую запись перед повторным оформлением."},
            )

        updated = connection.execute(
            """
            UPDATE slots
            SET reserved_count = reserved_count + 1
            WHERE id = ? AND consultation_id = ?
              AND reserved_count < capacity
              AND julianday(starts_at) > julianday('now')
            """,
            (payload["slotId"], payload["consultationId"]),
        )
        if updated.rowcount != 1:
            current_slot = connection.execute(
                "SELECT starts_at FROM slots WHERE id = ?", (payload["slotId"],)
            ).fetchone()
            if current_slot and parse_stored_datetime(
                current_slot["starts_at"]
            ) <= datetime.now(timezone.utc):
                raise validation(
                    "Выбранный слот недоступен для новой записи.",
                    {"slotId": "Слот уже прошёл."},
                )
            raise conflict(
                "SLOT_FULL",
                "На выбранный слот не осталось мест.",
                {"slotId": "Выберите другой слот."},
            )

        booking_id = str(uuid.uuid4())
        connection.execute(
            """
            INSERT INTO bookings (
                id, owner_hash, consultation_id, slot_id, institute_id,
                display_name, need, status, created_at, cancelled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
            """,
            (
                booking_id,
                hashed_owner,
                payload["consultationId"],
                payload["slotId"],
                payload["instituteId"],
                payload["displayName"],
                payload["need"],
                now,
            ),
        )
        connection.executemany(
            "INSERT INTO booking_need_tags (booking_id, tag) VALUES (?, ?)",
            [(booking_id, tag) for tag in payload["needTags"]],
        )
        row = connection.execute(
            BOOKING_SELECT + " WHERE b.id = ?", (booking_id,)
        ).fetchone()
        response = {"booking": _booking_dto(connection, row)}
        _save_idempotency(
            connection,
            hashed_owner,
            key,
            "create",
            digest,
            201,
            response,
            now,
        )
        connection.commit()
        return 201, response
    except Exception:
        connection.rollback()
        raise


def cancel_booking(connection, owner_token, key, value):
    booking_id = normalize_booking_id(value)
    hashed_owner = owner_hash(owner_token)
    digest = request_hash("cancel", {"bookingId": booking_id})
    now = utc_now()
    connection.execute("BEGIN IMMEDIATE")
    try:
        replay = _replay_or_conflict(
            _existing_idempotency(connection, hashed_owner, key), "cancel", digest
        )
        if replay is not None:
            connection.commit()
            return 200, replay
        booking = connection.execute(
            "SELECT status FROM bookings WHERE id = ? AND owner_hash = ?",
            (booking_id, hashed_owner),
        ).fetchone()
        if not booking:
            raise not_found(
                "Запись не найдена.", {"bookingId": "Обновите список записей."}
            )
        if booking["status"] == "active":
            updated = connection.execute(
                """
                UPDATE bookings
                SET status = 'cancelled', cancelled_at = ?
                WHERE id = ? AND owner_hash = ? AND status = 'active'
                """,
                (now, booking_id, hashed_owner),
            )
            if updated.rowcount != 1:
                raise sqlite3.DatabaseError("Booking cancellation was not applied")
            slot_id = connection.execute(
                "SELECT slot_id FROM bookings WHERE id = ?", (booking_id,)
            ).fetchone()[0]
            decremented = connection.execute(
                """
                UPDATE slots
                SET reserved_count = reserved_count - 1
                WHERE id = ? AND reserved_count > 0
                """,
                (slot_id,),
            )
            if decremented.rowcount != 1:
                raise sqlite3.DatabaseError("Slot release was not applied")

        row = connection.execute(
            BOOKING_SELECT + " WHERE b.id = ? AND b.owner_hash = ?",
            (booking_id, hashed_owner),
        ).fetchone()
        response = {"booking": _booking_dto(connection, row)}
        _save_idempotency(
            connection,
            hashed_owner,
            key,
            "cancel",
            digest,
            200,
            response,
            now,
        )
        connection.commit()
        return 200, response
    except Exception:
        connection.rollback()
        raise


def get_analytics(connection, query):
    topic_id = normalize_analytics_filters(query)
    if topic_id and not connection.execute(
        "SELECT 1 FROM topics WHERE id = ?", (topic_id,)
    ).fetchone():
        raise validation(
            "Неизвестная тема аналитики.",
            {"topicId": "Выберите тему из справочника."},
        )

    by_institute = {
        row["id"]: 0
        for row in connection.execute("SELECT id FROM institutes ORDER BY position")
    }
    by_topic = {
        row["id"]: 0
        for row in connection.execute("SELECT id FROM topics ORDER BY position")
    }
    by_format = {"online": 0, "offline": 0}
    by_need_tag = {tag: 0 for tag in sorted(ALLOWED_NEED_TAGS)}
    parameters = []
    topic_clause = ""
    if topic_id:
        topic_clause = " AND c.topic_id = ?"
        parameters.append(topic_id)
    active_rows = connection.execute(
        """
        SELECT b.institute_id, c.topic_id, s.mode
        FROM bookings b
        JOIN consultations c ON c.id = b.consultation_id
        JOIN slots s ON s.id = b.slot_id
        WHERE b.status = 'active'
        """
        + topic_clause,
        parameters,
    ).fetchall()
    for row in active_rows:
        if row["institute_id"] in by_institute:
            by_institute[row["institute_id"]] += 1
        if row["topic_id"] in by_topic:
            by_topic[row["topic_id"]] += 1
        if row["mode"] in by_format:
            by_format[row["mode"]] += 1
    tag_rows = connection.execute(
        """
        SELECT t.tag, COUNT(*) AS count
        FROM booking_need_tags t
        JOIN bookings b ON b.id = t.booking_id
        JOIN consultations c ON c.id = b.consultation_id
        WHERE b.status = 'active'
        """
        + topic_clause
        + " GROUP BY t.tag",
        parameters,
    ).fetchall()
    for row in tag_rows:
        if row["tag"] in by_need_tag:
            by_need_tag[row["tag"]] = row["count"]
    return {
        "scope": "server",
        "generatedAt": utc_now(),
        "topicId": topic_id,
        "totalActive": len(active_rows),
        "byInstitute": by_institute,
        "byTopic": by_topic,
        "byFormat": by_format,
        "byNeedTag": by_need_tag,
    }


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def get_weather(query, upstream_url=WEATHER_API_URL, timeout=5.0):
    normalize_weather_filters(query)
    parameters = urlencode(
        {
            "latitude": "59.9386",
            "longitude": "30.3141",
            "current": WEATHER_FIELDS,
            "timezone": "Europe/Moscow",
            "timeformat": "unixtime",
            "temperature_unit": "celsius",
            "wind_speed_unit": "ms",
        }
    )
    separator = "&" if urlsplit(upstream_url).query else "?"
    request = urllib.request.Request(
        upstream_url + separator + parameters,
        headers={"Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                raise ApiError(
                    503,
                    "UPSTREAM_UNAVAILABLE",
                    "Сервис погоды временно недоступен.",
                )
            content_type = response.headers.get_content_type()
            if content_type != "application/json" and not content_type.endswith("+json"):
                raise ApiError(
                    503,
                    "UPSTREAM_UNAVAILABLE",
                    "Сервис погоды вернул неподдерживаемый ответ.",
                )
            data = response.read(WEATHER_RESPONSE_LIMIT + 1)
    except ApiError:
        raise
    except (TimeoutError, socket.timeout) as error:
        raise ApiError(
            504, "UPSTREAM_TIMEOUT", "Сервис погоды не ответил вовремя."
        ) from error
    except urllib.error.HTTPError as error:
        raise ApiError(
            503, "UPSTREAM_UNAVAILABLE", "Сервис погоды временно недоступен."
        ) from error
    except urllib.error.URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise ApiError(
                504, "UPSTREAM_TIMEOUT", "Сервис погоды не ответил вовремя."
            ) from error
        raise ApiError(
            503, "UPSTREAM_UNAVAILABLE", "Сервис погоды временно недоступен."
        ) from error
    except (OSError, ValueError) as error:
        raise ApiError(
            503, "UPSTREAM_UNAVAILABLE", "Сервис погоды временно недоступен."
        ) from error
    if len(data) > WEATHER_RESPONSE_LIMIT:
        raise ApiError(
            503, "UPSTREAM_UNAVAILABLE", "Сервис погоды вернул слишком большой ответ."
        )
    try:
        payload = json.loads(data.decode("utf-8"))
        current = payload["current"]
        temperature = current["temperature_2m"]
        precipitation = current["precipitation_probability"]
        weather_code = current["weather_code"]
        wind_speed = current["wind_speed_10m"]
        observed = current["time"]
        if not all(
            _finite_number(value)
            for value in (temperature, precipitation, weather_code, wind_speed)
        ):
            raise ValueError("invalid weather values")
        if _finite_number(observed):
            observed_at = datetime.fromtimestamp(observed, tz=timezone.utc)
        elif isinstance(observed, str):
            observed_at = parse_stored_datetime(observed)
        else:
            raise ValueError("invalid observation time")
    except (KeyError, TypeError, ValueError, OverflowError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ApiError(
            503, "UPSTREAM_UNAVAILABLE", "Сервис погоды вернул некорректный ответ."
        ) from error
    return {
        "source": "Open-Meteo",
        "locationLabel": "Санкт-Петербург",
        "observedAt": format_datetime(observed_at),
        "temperature": temperature,
        "precipitationProbability": precipitation,
        "weatherCode": weather_code,
        "windSpeed": wind_speed,
        "units": {
            "temperature": "°C",
            "precipitationProbability": "%",
            "windSpeed": "m/s",
        },
    }
