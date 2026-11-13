import json
import mimetypes
import os
import signal
import sqlite3
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit

from . import db, repository
from .validation import (
    ApiError,
    decode_json_object,
    normalize_booking_id,
    parse_query,
    require_idempotency_key,
    require_owner_token,
    validation,
)

JSON_BODY_LIMIT = 16 * 1024
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; connect-src 'self' https://api.open-meteo.com; "
        "img-src 'self' data:; style-src 'self'; script-src 'self'; "
        "font-src 'self'; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
}


class ApplicationServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = False
    block_on_close = True

    def __init__(
        self,
        address,
        db_path,
        docs_root,
        weather_url,
        weather_timeout,
    ):
        super().__init__(address, ApplicationHandler)
        self.db_path = db_path
        self.docs_root = docs_root
        self.weather_url = weather_url
        self.weather_timeout = weather_timeout


class ApplicationHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "IITA"
    sys_version = ""

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        self._handle_request()

    def do_HEAD(self):
        self._handle_request()

    def do_POST(self):
        self._handle_request()

    def do_PUT(self):
        self._handle_request()

    def do_PATCH(self):
        self._handle_request()

    def do_DELETE(self):
        self._handle_request()

    def do_OPTIONS(self):
        self._handle_request()

    def _handle_request(self):
        try:
            parsed = urlsplit(self.path)
            if parsed.scheme or parsed.netloc:
                raise validation("Некорректный адрес запроса.", status=400)
            if parsed.path.startswith("/api/"):
                self._handle_api(parsed.path, parsed.query)
            else:
                self._handle_static(parsed.path)
        except ApiError as error:
            self._send_error(error, api=True)
        except sqlite3.Error:
            self._send_error(
                ApiError(
                    503,
                    "STORAGE_UNAVAILABLE",
                    "Хранилище временно недоступно. Повторите попытку.",
                ),
                api=True,
            )
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            self._send_error(
                ApiError(
                    500,
                    "UPSTREAM_UNAVAILABLE",
                    "Не удалось обработать запрос. Повторите попытку позже.",
                ),
                api=True,
            )

    def _handle_api(self, path, query):
        method = "GET" if self.command == "HEAD" else self.command
        if path == "/api/v1/health":
            self._require_method(method, "GET")
            parse_query(query, set())
            with closing(db.connect(self.server.db_path)) as connection:
                connection.execute("SELECT 1").fetchone()
            self._send_json(200, {"status": "ok", "apiVersion": 1, "mode": "server"})
            return
        if path == "/api/v1/catalog":
            self._require_method(method, "GET")
            with closing(db.connect(self.server.db_path)) as connection:
                payload = repository.get_catalog(connection, query)
            self._send_json(200, payload)
            return
        if path == "/api/v1/bookings":
            if method == "GET":
                owner_token = require_owner_token(self.headers.get("Authorization"))
                with closing(db.connect(self.server.db_path)) as connection:
                    payload = repository.list_bookings(connection, owner_token, query)
                self._send_json(200, payload)
                return
            if method == "POST":
                parse_query(query, set())
                body = self._read_json_body()
                owner_token = require_owner_token(self.headers.get("Authorization"))
                key = require_idempotency_key(self.headers.get("Idempotency-Key"))
                with closing(db.connect(self.server.db_path)) as connection:
                    status, payload = repository.create_booking(
                        connection, owner_token, key, body
                    )
                self._send_json(status, payload)
                return
            self._require_method(method, "GET", "POST")
        cancel_prefix = "/api/v1/bookings/"
        if path.startswith(cancel_prefix) and path.endswith("/cancel"):
            encoded_id = path[len(cancel_prefix) : -len("/cancel")]
            if "/" not in encoded_id:
                self._require_method(method, "POST")
                parse_query(query, set())
                self._require_empty_body()
                owner_token = require_owner_token(self.headers.get("Authorization"))
                key = require_idempotency_key(self.headers.get("Idempotency-Key"))
                try:
                    booking_id = unquote_to_bytes(encoded_id).decode("utf-8")
                except UnicodeDecodeError as error:
                    raise validation(
                        "Некорректный ID записи.", {"bookingId": "Укажите UUID записи."}
                    ) from error
                booking_id = normalize_booking_id(booking_id)
                with closing(db.connect(self.server.db_path)) as connection:
                    _status, payload = repository.cancel_booking(
                        connection, owner_token, key, booking_id
                    )
                self._send_json(200, payload)
                return
        if path == "/api/v1/analytics":
            self._require_method(method, "GET")
            with closing(db.connect(self.server.db_path)) as connection:
                payload = repository.get_analytics(connection, query)
            self._send_json(200, payload)
            return
        if path == "/api/v1/weather":
            self._require_method(method, "GET")
            payload = repository.get_weather(
                query, self.server.weather_url, self.server.weather_timeout
            )
            self._send_json(200, payload)
            return
        if method == "POST":
            self.close_connection = True
        raise ApiError(404, "NOT_FOUND", "Маршрут API не найден.")

    @staticmethod
    def _require_method(actual, *allowed):
        if actual not in allowed:
            raise ApiError(
                405,
                "VALIDATION_ERROR",
                "Метод не поддерживается для этого маршрута.",
                {"method": "Допустимые методы: " + ", ".join(allowed) + "."},
            )

    def _read_json_body(self):
        self._require_json_content_type()
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise validation("Transfer-Encoding не поддерживается.", status=400)
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) != 1:
            self.close_connection = True
            raise validation("Требуется корректный Content-Length.", status=400)
        try:
            length = int(lengths[0], 10)
        except ValueError as error:
            self.close_connection = True
            raise validation("Некорректный Content-Length.", status=400) from error
        if length < 0:
            self.close_connection = True
            raise validation("Некорректный Content-Length.", status=400)
        if length > JSON_BODY_LIMIT:
            self.close_connection = True
            raise validation(
                "Тело запроса превышает 16 KiB.",
                {"body": "Максимальный размер JSON — 16384 байта."},
                status=413,
            )
        data = self.rfile.read(length)
        if len(data) != length:
            self.close_connection = True
            raise validation("Тело запроса получено не полностью.", status=400)
        return decode_json_object(data)

    def _require_json_content_type(self):
        content_type = self.headers.get("Content-Type", "")
        parts = [part.strip() for part in content_type.split(";")]
        if not parts or parts[0].lower() != "application/json":
            self.close_connection = True
            raise validation(
                "Требуется Content-Type: application/json.",
                {"Content-Type": "Используйте application/json с UTF-8."},
                status=415,
            )
        for parameter in parts[1:]:
            name, separator, value = parameter.partition("=")
            if (
                not separator
                or name.strip().lower() != "charset"
                or value.strip().strip('"').lower().replace("_", "-") not in {"utf-8", "utf8"}
            ):
                self.close_connection = True
                raise validation(
                    "Поддерживается только JSON в UTF-8.",
                    {"Content-Type": "Единственный допустимый параметр — charset=utf-8."},
                    status=415,
                )

    def _require_empty_body(self):
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise validation("Отмена записи не принимает тело запроса.", status=400)
        lengths = self.headers.get_all("Content-Length") or []
        if not lengths:
            return
        if len(lengths) != 1:
            self.close_connection = True
            raise validation("Некорректный Content-Length.", status=400)
        try:
            length = int(lengths[0], 10)
        except ValueError as error:
            self.close_connection = True
            raise validation("Некорректный Content-Length.", status=400) from error
        if length != 0:
            self.close_connection = True
            raise validation("Отмена записи не принимает тело запроса.", status=400)

    def _handle_static(self, raw_path):
        if self.command not in {"GET", "HEAD"}:
            raise ApiError(405, "VALIDATION_ERROR", "Метод не поддерживается.")
        try:
            path = unquote_to_bytes(raw_path).decode("utf-8")
        except UnicodeDecodeError as error:
            raise ApiError(404, "NOT_FOUND", "Файл не найден.") from error
        if "\x00" in path or "\\" in path:
            raise ApiError(404, "NOT_FOUND", "Файл не найден.")
        relative = "index.html" if path == "/" else path.lstrip("/")
        root = self.server.docs_root.resolve()
        candidate = (root / relative).resolve()
        if root not in candidate.parents or not candidate.is_file():
            raise ApiError(404, "NOT_FOUND", "Файл не найден.")
        try:
            data = candidate.read_bytes()
        except OSError as error:
            raise ApiError(404, "NOT_FOUND", "Файл не найден.") from error
        content_type, _encoding = mimetypes.guess_type(str(candidate))
        if candidate.suffix == ".js":
            content_type = "text/javascript"
        content_type = content_type or "application/octet-stream"
        if content_type.startswith("text/") or candidate.suffix in {".json", ".js", ".svg"}:
            content_type += "; charset=utf-8"
        self._send_bytes(200, data, content_type, cache_control="no-cache")

    def _send_error(self, error, api):
        body = {"error": {"code": error.code, "message": error.message, "fields": error.fields}}
        if api:
            self._send_json(error.status, body)
        else:
            self._send_bytes(
                error.status,
                error.message.encode("utf-8"),
                "text/plain; charset=utf-8",
                cache_control="no-store",
            )

    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(
            status,
            data,
            "application/json; charset=utf-8",
            cache_control="no-store",
        )

    def _send_bytes(self, status, data, content_type, cache_control):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache_control)
            for name, value in SECURITY_HEADERS.items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


def create_server(
    host=None,
    port=None,
    db_path=None,
    weather_url=None,
    weather_timeout=None,
):
    repository.configure_owner_pepper()
    resolved_db_path = db.initialize(db_path)
    resolved_host = host if host is not None else os.environ.get("APP_HOST", "127.0.0.1")
    raw_port = port if port is not None else os.environ.get("APP_PORT", "8080")
    try:
        resolved_port = int(raw_port)
    except (TypeError, ValueError) as error:
        raise ValueError("APP_PORT must be an integer") from error
    if not 0 <= resolved_port <= 65535:
        raise ValueError("APP_PORT must be between 0 and 65535")
    resolved_weather_url = weather_url or os.environ.get(
        "APP_WEATHER_UPSTREAM_URL", repository.WEATHER_API_URL
    )
    raw_timeout = (
        weather_timeout
        if weather_timeout is not None
        else os.environ.get("APP_WEATHER_TIMEOUT_SECONDS", "5")
    )
    try:
        resolved_timeout = float(raw_timeout)
    except (TypeError, ValueError) as error:
        raise ValueError("APP_WEATHER_TIMEOUT_SECONDS must be numeric") from error
    if not 0.1 <= resolved_timeout <= 30:
        raise ValueError("APP_WEATHER_TIMEOUT_SECONDS must be between 0.1 and 30")
    return ApplicationServer(
        (resolved_host, resolved_port),
        resolved_db_path,
        Path(db.DOCS_ROOT).resolve(),
        resolved_weather_url,
        resolved_timeout,
    )


def main():
    try:
        httpd = create_server()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    stopping = threading.Event()

    def request_stop(_signum, _frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        httpd.serve_forever(poll_interval=0.25)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
