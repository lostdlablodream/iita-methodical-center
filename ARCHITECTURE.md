# Архитектура «Методики»

Документ описывает фактическую реализацию на `main` после merged PR #1–#7. Это не проектный план: четыре страницы, оба repository adapter, Python/SQLite backend, Docker и GitHub Pages уже существуют. Итоговые статусы проверок находятся в [`CHANGELOG.md`](CHANGELOG.md).

## 1. Назначение и границы

«Методика» — учебный сервис записи преподавателей ИИТА СПбГУПТД на методические консультации и сбора обобщённых потребностей. Пользователь может найти консультацию, выбрать слот, оформить демонстрационную запись, увидеть её после обновления, отменить, повторно оформить и получить агрегированную аналитику.

Справочник содержит 20 институтов, 6 тем, 12 консультаций и 31 слот. Официальное расписание, реальные аккаунты, оплата, роли администратора и обработка настоящих персональных данных не входят в систему. Название и SUTD-inspired палитра не превращают проект в официальный сайт университета; логотип и герб не копируются.

## 2. Фактическая форма решения

```text
HTML/CSS в docs
      │
      ▼
page modules в docs/assets/js/pages
      │       ├── domain/format/components/config
      │       ├── weather.js ───────────────► Open-Meteo напрямую из браузера
      │       └── analytics-export.js / calendar.js
      ▼
repository.js: выбор local/server и общий badge
      │
      ├── repository.local.js ──► storage.js ──► один localStorage key
      │
      └── repository.server.js ──► REST ./api/v1
                                      │
                                      ▼
                           backend/app.py + repository.py
                                      │
                                      ▼
                           backend/db.py ──► SQLite

Backend weather proxy существует отдельно в backend/repository.py
и не входит в frontend repository contract.
```

Frontend не требует npm, сборки, framework или CDN. Backend использует только Python stdlib и SQLite. Все внутренние ссылки и ресурсы относительные, что позволяет публиковать `docs` в подкаталоге GitHub Pages.

## 3. Страницы и модули

| Страница | Фактические модули и ответственность |
|---|---|
| `index.html` | `pages/home.js`: компас, FAQ, weather и один `createRepositoryRuntime`; `pages/analytics.js`: KPI, диаграммы, таблица, фильтр и обновления; `pages/analytics-export.js`: CSV BOM и Blob download. |
| `catalog.html` | `pages/catalog.js`: repository catalog, поиск, тема/институт/формат, active filters, пустой/ошибочный результат и переход с `consultationId`/`slotId`. |
| `booking.html` | `pages/booking.js`: чтение query, validation, обязательный label «Какая потребность/проблема», pending create, idempotent submit, availability refresh и weather для слота. |
| `orders.html` | `pages/orders.js`: list/cancel, история, rebook, native dialog, mutation epoch и ICS через `pages/calendar.js`. |

Общие модули:

- `config.js` — `STORAGE_KEY`, `SEED_URL`, `API_PREFIX`, `Europe/Moscow` и timeout погоды.
- `domain.js` — форматы, статусы, need tags и чистые предметные helpers.
- `format.js` — дата/время и русские формы числительных через `Intl`.
- `components.js` — безопасный DOM/`textContent`, badge, активная навигация и mobile menu.
- `pages/runtime.js` — единый для страницы runtime подключения repository, mode badge/alert и явный force local.
- `storage.js` — строгая схема local state, crypto random, read/write и Web Locks.
- `errors.js` — `RepositoryError`, коды и нормализация ошибок для UI.

Page modules отвечают за `loading / empty / result / error / retry`; repository не изменяет DOM. Пользовательские и API-строки выводятся через DOM/`textContent`, а не `innerHTML`.

## 4. Repository contract

Оба adapter возвращают объект с пятью асинхронными предметными методами:

```js
repository.getCatalog(filters);
repository.createBooking(draft, { idempotencyKey, ownerToken });
repository.listBookings({ status, ownerToken });
repository.cancelBooking({ bookingId, idempotencyKey, ownerToken });
repository.getAnalytics({ topicId });
```

`getHealth` и `getWeather` в этот contract **не входят**. Доступность сервера отдельно проверяет `checkServerHealth()` из `repository.server.js`; погоду браузер получает через `weather.js`.

### Входы и результаты

- `getCatalog({ query, topicId, instituteId, mode, from, to })` возвращает `meta`, `institutes`, `topics` и `consultations`. В слотах есть `capacity`, `reservedCount`, `remainingCount`, `isOpen`, время, формат и место.
- `createBooking` принимает `consultationId`, `slotId`, `instituteId`, `displayName`, `need`, `needTags`; возвращает booking DTO. Отдельный replay flag клиенту не добавляется. HTTP 200/201 остаётся транспортной деталью server adapter.
- `listBookings` возвращает массив записей текущего владельца, опционально отфильтрованный по `status`, отсортированный по началу слота, созданию и ID.
- `cancelBooking` возвращает booking DTO; повторная отмена не освобождает место повторно.
- `getAnalytics` возвращает `scope`, `generatedAt`, `topicId`, `totalActive`, `byInstitute`, `byTopic`, `byFormat`, `byNeedTag`. Local scope — `local-browser`, server scope — `server`.

Ошибки приводятся к `RepositoryError` с `code`, `message`, `status`, `fields`/`fieldErrors`, `retryable`; transport metadata может включать `contentType` и `isHtml`. Используются коды:

```text
VALIDATION_ERROR, NOT_FOUND, SLOT_FULL, DUPLICATE_BOOKING,
OWNER_MISMATCH, IDEMPOTENCY_CONFLICT, STORAGE_UNAVAILABLE,
STORAGE_CORRUPT, UPSTREAM_UNAVAILABLE, UPSTREAM_TIMEOUT,
INVALID_RESPONSE, DETECTION_FAILED
```

## 5. Выбор режима и sessionStorage

`repository.js` выбирает режим через health API и сохраняет выбор в sessionStorage:

- `iita.consultations.repository-mode.v1` — `local` или `server` для текущей вкладки;
- `iita.consultations.pending-booking.v1` — отдельный ключ `pages/booking.js` для незавершённого создания.

HTTP 404/405 health означает статический local-режим. Timeout, сетевая ошибка или неподдерживаемый health не вызывают скрытый local fallback: UI показывает ошибку, retry и явную кнопку local. Runtime обновляет badge и поясняет, где хранятся записи.

Pending create имеет `{version: 1, key, canonical, draft, consultationId, slotId}`. При восстановлении canonical вычисляется заново и сравнивается с draft. UUID и черновик остаются в текущей вкладке при timeout/неопределённом ответе; успех, окончательная validation-ошибка или явный новый черновик очищает операцию по правилам `booking.js`. Поля формы после F5 намеренно не подставляются автоматически.

## 6. Local mode

### Единственный state

`storage.js` читает и пишет только `iita.consultations.state.v1`:

```js
{
  schemaVersion: 1,
  ownerToken, // 64 hex символа = 256 бит
  local: {
    revision,
    bookings
  }
}
```

При чтении проверяются версия, owner token, revision и каждая запись. Повреждённые или несовместимые данные приводят к `STORAGE_CORRUPT`; автоматической миграции и параллельных ключей заказов нет. Недоступность хранилища — `STORAGE_UNAVAILABLE`.

Local mutations требуют Web Locks API. Без `navigator.locks` создание и отмена не выполняются и возвращают `STORAGE_UNAVAILABLE`; чтение и аналитика остаются отдельными операциями. `revision` увеличивается только при фактическом изменении.

### Booking DTO

Local booking хранит не только IDs и пользовательские поля, но и snapshot отображаемых данных:

```text
id, consultationId, slotId, instituteId,
displayName, need, needTags,
title, topicId, startsAt, endsAt, mode, location,
durationMinutes, consultantLabel,
status, createdAt, cancelledAt,
idempotencyKey, idempotencyHash,
cancelIdempotencyKey, cancelIdempotencyKeys
```

Owner token создаётся через `crypto.getRandomValues`; booking ID использует `crypto.randomUUID`, с fallback на UUID из случайных байтов. Канонический draft связывается с idempotency key и SHA-256/доступным fallback хеша. Повтор с тем же содержимым возвращает существующую запись, другой payload с тем же ключом отклоняется.

Занятость вычисляется из активных записей, а не хранится отдельным счётчиком. Отмена переводит `active → cancelled`, сохраняет аудит cancel keys и не меняет занятость повторно. Snapshot позволяет показывать историю независимо от последующего чтения каталога.

LocalStorage привязан к браузеру/origin и не даёт глобальной вместимости. Raw owner token необходим list/cancel, но при XSS или доступе к профилю браузера может быть прочитан; это одна из причин запрета реальных данных в демо.

## 7. Server mode и REST v1

Frontend использует относительный `./api/v1`; production origin в коде и документации не фиксируется. Backend одновременно отдаёт `docs` и API.

| Метод и маршрут | Реализация | Успех и основные статусы |
|---|---|---|
| `GET /api/v1/health` | `SELECT 1` и маркер server/API version | `200`; ошибки запроса/БД `400`, `405`, `503`. |
| `GET /api/v1/catalog` | Фильтры query/topicId/instituteId/mode/from/to и остаток мест | `200`; `400`, `405`, `422`, `503`. |
| `GET /api/v1/bookings` | Записи по HMAC владельца, optional `status` | `200`; `400`, `401`, `405`, `422`, `503`. |
| `POST /api/v1/bookings` | Bearer + Idempotency-Key, создание и replay | `201`, replay `200`; `400`, `401`, `404`, `405`, `409`, `413`, `415`, `422`, `503`. |
| `POST /api/v1/bookings/{uuid}/cancel` | Bearer + Idempotency-Key, пустое тело | `200`; `400`, `401`, `404`, `405`, `409`, `422`, `503`. |
| `GET /api/v1/analytics` | Агрегаты, optional `topicId` | `200`; `400`, `405`, `422`, `503`. |
| `GET /api/v1/weather` | Отдельный current proxy к Open-Meteo | `200`; `400`, `405`, `422`, `503`, `504`. |

Неподдерживаемый маршрут даёт 404, неожиданная внутренняя ошибка — безопасное 500-сообщение без stack trace. JSON body ограничено 16 KiB; Content-Type, Content-Length, число query-параметров, поля и типы проверяются. Ошибки API имеют `{error: {code, message, fields}}`.

`Authorization: Bearer <ownerToken>` обязателен для list/create/cancel. `Idempotency-Key` обязателен для create/cancel. Сервер повторно проверяет связь consultation/slot, институт, будущее время, длину строк, need tags и активный дубликат владельца.

## 8. SQLite, транзакции и идемпотентность

`backend/db.py` создаёт:

- `schema_meta` с seed metadata/version и `owner_hash_algorithm=hmac-sha256-v1`;
- `institutes`, `topics`, `consultations`, `consultation_institutes`, `consultation_tags`;
- `slots` с `capacity` и `reserved_count`;
- `owners` с `token_hash` и `created_at`;
- `bookings`, `booking_need_tags`;
- `idempotency_keys` с owner/key/operation/request hash/response/status/created_at.

Каждое подключение включает foreign keys, `busy_timeout=5000`, WAL и `synchronous=NORMAL`. Constraints ограничивают формат, статус, длительность, вместимость, `0 <= reserved_count <= capacity`, need tags и длины полей. Частичный unique index допускает только одну активную запись владельца на слот; есть индексы owner/status, slot/status и consultation/position. Seed импортируется UPSERT-ами в `BEGIN IMMEDIATE`, без дублей и сброса занятости.

### Создание

`backend/repository.py` выполняет network/JSON validation до транзакции, затем `BEGIN IMMEDIATE`:

1. Находит `(owner_hash, key)` и сравнивает operation/request hash.
2. Возвращает сохранённый response с HTTP 200 при exact replay; другой operation/payload даёт `IDEMPOTENCY_CONFLICT`.
3. Повторно проверяет справочник и бизнес-правила.
4. Выполняет условный `UPDATE slots ... reserved_count = reserved_count + 1` только при `reserved_count < capacity` и будущем слоте.
5. Проверяет `rowcount`, вставляет booking/tags/idempotency response и делает commit.

При отсутствии места, ошибке или исключении транзакция откатывается. Сетевых вызовов внутри write-транзакции нет.

### Отмена

Отмена также использует `BEGIN IMMEDIATE` и request hash для `cancel + bookingId`. Переход active → cancelled выполняется условным UPDATE владельца; декремент слота происходит только при одной изменённой записи и `reserved_count > 0`. Повтор уже отменённой записи или exact idempotent replay не делает второй декремент. Response сохраняется, любые ошибки вызывают rollback.

### Ограничение хранения

Автоматической очистки старых idempotency responses пока нет. Для эксплуатации нужна отдельная retention-процедура, не удаляющая саму историю записей.

## 9. Owner token и HMAC

Клиентский owner token содержит 256 бит случайности. На сервере он не сохраняется: `owner_hash()` вычисляет HMAC-SHA-256(token, runtime pepper), а `owners.token_hash` и booking owner lookup используют этот hex hash в SQL.

`APP_OWNER_PEPPER` обязателен: принимается hex не менее 32 байтов или сильная строка не менее 32 символов без управляющих символов. Pepper не входит в Git, Docker image, seed, API или analytics. **При смене pepper старые HMAC перестают соответствовать owner-token, поэтому прежние записи становятся недоступны владельцам.** Между restarts нужен тот же pepper.

`hmac.compare_digest` применяется к **request hash идемпотентности**, а не к owner lookup: owner ищется SQL по HMAC. Raw token не пишется в SQLite, analytics или ответы; HTTP request logging отключён в `app.py`.

## 10. Analytics, CSV и ICS

Server analytics выполняет чтение в отдельной `BEGIN`-транзакции, чтобы каталог и агрегаты соответствовали одному read snapshot. По всем 20 институтам и 6 темам заранее создаются нулевые значения; `totalActive` считает только active записи, optional topic filter применяется к строкам и тегам. В ответе нет `displayName`, raw `need`, booking IDs, owner tokens или idempotency payloads.

Local analytics использует тот же seed и только активные записи текущего local state. Главная не объединяет local/server агрегаты, а scope явно подписан.

CSV создаётся в `pages/analytics-export.js` с UTF-8 BOM для Excel. Metadata ограничена scope/filter/generatedAt; секции институтов, тем, тегов и форматов содержат только `id/name/count`. Файл скачивается через Blob, ObjectURL отзывается.

`pages/calendar.js` создаёт RFC5545 VCALENDAR/VEVENT для активной записи: UTC `DTSTART`/`DTEND`/`DTSTAMP`, escaping текста и UTF-8 folding строк до 75 октетов. ICS содержит выбранную запись и её потребность, поэтому относится к данным владельца, а не к общей аналитике.

## 11. Погода

`docs/assets/js/weather.js` напрямую обращается к Open-Meteo без секретного API key:

- current для главной и hourly для конкретного слота;
- демонстрационные координаты Санкт-Петербурга и `Europe/Moscow`;
- `AbortController` с timeout, проверка HTTP/JSON и расшифровка WMO codes;
- выбор ближайшего часа, отдельная обработка даты вне горизонта;
- loading/result/error/retry без блокировки оформления;
- `WeakMap` смонтированных виджетов и requestNumber хранят состояние только в памяти. Отдельного persistent weather store нет; refresh создаёт новый запрос. Отдельного кэша погодных ответов в текущем `weather.js` нет.

Backend имеет самостоятельный `GET /api/v1/weather` с current proxy, server timeout, лимитом ответа и нормализацией. Браузерный UI **не обязан** использовать proxy и в текущей реализации обращается к Open-Meteo напрямую.

## 12. Безопасность и приватность

Реализовано:

- DOM/`textContent`, строгие DTO, allowlist query/body fields и лимит размера;
- параметризованный SQL, constraints и транзакции;
- HMAC владельца и отсутствие raw token в БД/API analytics;
- безопасные публичные ошибки без SQL, внутренних путей и stack trace;
- запрет DB path внутри `docs`, исключение секретов/artefacts через `.gitignore` и `.dockerignore`;
- базовые response headers в `backend/app.py`: CSP, `nosniff`, `no-referrer`, frame/permissions restrictions;
- независимые ошибки погоды, отсутствие секретного weather key и demo privacy-инструкции.

Это не делает проект готовым к реальным персональным данным. Raw local token уязвим при XSS, учебный deploy не заменяет полноценную модель угроз и эксплуатационную защиту.

## 13. Accessibility и responsive

В интерфейсе присутствуют skip link, семантические регионы и заголовки, связанные labels/hints/errors, `aria-invalid`, `aria-describedby`, `aria-busy`, live regions, видимый focus, native details/dialog, возврат фокуса, keyboard-friendly controls, touch targets, reduced-motion CSS и layout от 320 px. Таблица аналитики прокручивается внутри собственного контейнера; итоговый media query до 25 rem скрывает mode badge, чтобы header не переполнялся.

Зафиксированный keyboard-only путь и проверка 320 px отмечены DONE в roadmap. Присутствие CSS не считается проверкой ассистивной технологией. По явной директиве пользователя следующие проверки имеют статус `CANCELED` и **не выполнены**: системная reduced-motion, live regions с ассистивной технологией, полный mobile-путь на публичном Pages, loading/error/retry API на Pages, репетиция защиты, реальный network block погоды и финальный комплексный security/release review.

## 14. Docker и независимый deploy

`Dockerfile` использует `python:3.13-alpine`, копирует только `backend` и `docs`, не требует requirements или frontend build. Контейнер запускается под numeric `USER 10001:10001`.

`compose.yaml` задаёт:

- named volume `iita-data` для `/data/iita.db`;
- `read_only: true`, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`;
- обязательный runtime `APP_OWNER_PEPPER` без значения в Git;
- необязательные `APP_BIND` и `APP_PORT` с defaults;
- restart policy, stop grace period и healthcheck `/api/v1/health`.

Backend и Pages разворачиваются независимо. Повторный запуск с тем же volume и pepper сохраняет данные и владение. Практический quickstart находится в [`README.md`](README.md).

## 15. GitHub Pages и static mode

Pages обслуживает только `main` / `docs` по HTTPS:

- Python, SQLite, HMAC и server transactions там не исполняются;
- ES modules и `fetch(seed.json)` требуют HTTP, не `file://`;
- localStorage принадлежит конкретному origin и браузеру;
- relative URLs необходимы для project base path;
- локальная занятость не доказывает глобальную вместимость;
- секреты и pepper на Pages не помещаются;
- weather зависит от сети/CORS/горизонта, но не блокирует основной путь.

## 16. Production-ограничения

- Rate limiting не реализован.
- Автоматической очистки старых idempotency responses нет.
- SQLite рассчитан на single-writer и одну учебную реплику, а не горизонтальное масштабирование.
- Backend отправляет базовые security headers, но конечные TLS/CSP/security-header гарантии зависят от внешнего reverse proxy и Pages; в учебном deploy они не гарантируются.
- Резервное копирование SQLite требует согласованной остановки writer или SQLite backup API и отдельной операционной процедуры. Готовые backup/restore не заявляются.
- Нет готовой инфраструктуры для реальных персональных данных, реальных аккаунтов и официального расписания.

## 17. Release status

Функциональность PR #1–#7 слита в `main`, Pages опубликован, отдельный Docker deploy проверен. Финальная ветка документации содержит отдельный mobile header CSS-fix и актуальные README/ARCHITECTURE/CHANGELOG; новый PR ещё не создаётся и не считается merged.

Детальные 122 задачи, подтверждённые результаты и семь `CANCELED` находятся в [`CHANGELOG.md`](CHANGELOG.md). Повторять отменённые пользователем проверки этот документ не предлагает.
