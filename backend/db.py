import json
import os
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DOCS_ROOT = PROJECT_ROOT / "docs"
SEED_PATH = DOCS_ROOT / "data" / "seed.json"
DEFAULT_DB_PATH = PROJECT_ROOT / "runtime" / "iita.db"
OWNER_HASH_ALGORITHM = "hmac-sha256-v1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS institutes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consultations (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    description TEXT NOT NULL,
    audience_label TEXT NOT NULL,
    consultant_label TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consultation_institutes (
    consultation_id TEXT NOT NULL REFERENCES consultations(id),
    institute_id TEXT NOT NULL REFERENCES institutes(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (consultation_id, institute_id)
);

CREATE TABLE IF NOT EXISTS consultation_tags (
    consultation_id TEXT NOT NULL REFERENCES consultations(id),
    tag TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (consultation_id, tag)
);

CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    consultation_id TEXT NOT NULL REFERENCES consultations(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('online', 'offline')),
    location TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    reserved_count INTEGER NOT NULL DEFAULT 0
        CHECK (reserved_count >= 0 AND reserved_count <= capacity),
    position INTEGER NOT NULL,
    UNIQUE (id, consultation_id)
);

CREATE TABLE IF NOT EXISTS owners (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    owner_hash TEXT NOT NULL REFERENCES owners(token_hash),
    consultation_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    institute_id TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80),
    need TEXT NOT NULL CHECK (length(need) BETWEEN 10 AND 1000),
    status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    FOREIGN KEY (slot_id, consultation_id)
        REFERENCES slots(id, consultation_id),
    FOREIGN KEY (consultation_id, institute_id)
        REFERENCES consultation_institutes(consultation_id, institute_id),
    CHECK (
        (status = 'active' AND cancelled_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS booking_need_tags (
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    tag TEXT NOT NULL CHECK (tag IN ('materials', 'assessment', 'digital-tools', 'accessibility')),
    PRIMARY KEY (booking_id, tag)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    owner_hash TEXT NOT NULL REFERENCES owners(token_hash),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
    operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel')),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_hash, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_owner_slot
    ON bookings(owner_hash, slot_id)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS bookings_owner_status
    ON bookings(owner_hash, status);
CREATE INDEX IF NOT EXISTS bookings_slot_status
    ON bookings(slot_id, status);
CREATE INDEX IF NOT EXISTS slots_consultation_position
    ON slots(consultation_id, position);
"""

INSTITUTE_UPSERT = """
INSERT INTO institutes (id, name, position) VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = excluded.position
"""

TOPIC_UPSERT = """
INSERT INTO topics (id, name, description, position) VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    position = excluded.position
"""

CONSULTATION_UPSERT = """
INSERT INTO consultations (
    id, topic_id, title, summary, description, audience_label,
    consultant_label, duration_minutes, position
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    topic_id = excluded.topic_id,
    title = excluded.title,
    summary = excluded.summary,
    description = excluded.description,
    audience_label = excluded.audience_label,
    consultant_label = excluded.consultant_label,
    duration_minutes = excluded.duration_minutes,
    position = excluded.position
"""

SLOT_UPSERT = """
INSERT INTO slots (
    id, consultation_id, starts_at, ends_at, mode, location,
    capacity, reserved_count, position
) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
ON CONFLICT(id) DO UPDATE SET
    consultation_id = excluded.consultation_id,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    mode = excluded.mode,
    location = excluded.location,
    capacity = excluded.capacity,
    position = excluded.position
"""


def resolve_db_path(value=None):
    configured = value if value is not None else os.environ.get("APP_DB_PATH")
    path = Path(configured) if configured else DEFAULT_DB_PATH
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    resolved = path.resolve()
    docs = DOCS_ROOT.resolve()
    if resolved == docs or docs in resolved.parents:
        raise ValueError("APP_DB_PATH must be outside docs")
    return resolved


def connect(path):
    connection = sqlite3.connect(
        str(path), timeout=5.0, isolation_level=None, check_same_thread=False
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    journal_mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()[0]
    if str(journal_mode).lower() != "wal":
        connection.close()
        raise sqlite3.OperationalError("WAL mode is unavailable")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection


def _reject_incompatible_pre_release(db_path):
    if not db_path.exists():
        return
    connection = sqlite3.connect(
        db_path.as_uri() + "?mode=ro", uri=True, isolation_level=None
    )
    try:
        connection.execute("PRAGMA query_only = ON")
        owners_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'owners'"
        ).fetchone()
        if not owners_table:
            return
        has_owners = connection.execute("SELECT 1 FROM owners LIMIT 1").fetchone()
        if not has_owners:
            return
        marker = None
        meta_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'"
        ).fetchone()
        if meta_table:
            row = connection.execute(
                "SELECT value FROM schema_meta WHERE key = 'owner_hash_algorithm'"
            ).fetchone()
            marker = row[0] if row else None
        if marker != OWNER_HASH_ALGORITHM:
            raise RuntimeError(
                "Incompatible pre-release database: owner hash algorithm marker "
                "is missing or unsupported; use a new volume"
            )
    finally:
        connection.close()


def initialize(path=None):
    db_path = resolve_db_path(path)
    _reject_incompatible_pre_release(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with SEED_PATH.open("r", encoding="utf-8") as seed_file:
        seed = json.load(seed_file)
    connection = connect(db_path)
    try:
        connection.executescript(SCHEMA)
        connection.execute("PRAGMA user_version = 1")
        import_seed(connection, seed)
    finally:
        connection.close()
    return db_path


def import_seed(connection, seed):
    connection.execute("BEGIN IMMEDIATE")
    try:
        for position, institute in enumerate(seed["institutes"]):
            connection.execute(
                INSTITUTE_UPSERT, (institute["id"], institute["name"], position)
            )
        for position, topic in enumerate(seed["topics"]):
            connection.execute(
                TOPIC_UPSERT,
                (topic["id"], topic["name"], topic["description"], position),
            )
        for position, consultation in enumerate(seed["consultations"]):
            connection.execute(
                CONSULTATION_UPSERT,
                (
                    consultation["id"],
                    consultation["topicId"],
                    consultation["title"],
                    consultation["summary"],
                    consultation["description"],
                    consultation["audienceLabel"],
                    consultation["consultantLabel"],
                    consultation["durationMinutes"],
                    position,
                ),
            )
            for institute_position, institute_id in enumerate(
                consultation["instituteIds"]
            ):
                connection.execute(
                    """
                    INSERT INTO consultation_institutes (
                        consultation_id, institute_id, position
                    ) VALUES (?, ?, ?)
                    ON CONFLICT(consultation_id, institute_id)
                    DO UPDATE SET position = excluded.position
                    """,
                    (consultation["id"], institute_id, institute_position),
                )
            for tag_position, tag in enumerate(consultation["tags"]):
                connection.execute(
                    """
                    INSERT INTO consultation_tags (consultation_id, tag, position)
                    VALUES (?, ?, ?)
                    ON CONFLICT(consultation_id, tag)
                    DO UPDATE SET position = excluded.position
                    """,
                    (consultation["id"], tag, tag_position),
                )
            for slot_position, slot in enumerate(consultation["slots"]):
                connection.execute(
                    SLOT_UPSERT,
                    (
                        slot["id"],
                        consultation["id"],
                        slot["startsAt"],
                        slot["endsAt"],
                        slot["mode"],
                        slot["location"],
                        slot["capacity"],
                        slot_position,
                    ),
                )
        serialized_meta = json.dumps(
            seed["meta"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        connection.execute(
            """
            INSERT INTO schema_meta (key, value) VALUES ('seed_meta', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (serialized_meta,),
        )
        connection.execute(
            """
            INSERT INTO schema_meta (key, value) VALUES ('seed_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (seed["meta"]["seedVersion"],),
        )
        connection.execute(
            """
            INSERT INTO schema_meta (key, value) VALUES ('owner_hash_algorithm', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (OWNER_HASH_ALGORITHM,),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
