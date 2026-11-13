# Методика

«Методика» — учебный сервис записи преподавателей ИИТА СПбГУПТД на методические консультации и выявления их потребностей. Это не официальный сайт университета: справочник, консультанты, расписание и записи демонстрационные, оплата и аккаунты не требуются.

Основной путь реализован: найти консультацию → выбрать слот → оформить запись → увидеть её в «Моих записях» → отменить или повторно оформить. Общий демонстрационный справочник содержит **20 институтов, 6 тем, 12 консультаций и 31 слот**.

## Публичная версия

**[Открыть «Методику» на GitHub Pages](https://lostdlablodream.github.io/iita-methodical-center/)**

Pages публикуется из `main` / `docs` по HTTPS. На Pages работает статический local/demo-режим: браузер загружает `seed.json`, а записи остаются в localStorage текущего origin. Python, SQLite и серверный HMAC на Pages не исполняются. Отдельный backend разворачивается независимо в Docker; его инфраструктурные адреса и секреты в репозиторий не включены.

Статус ручных проверок и семь пропущенных по решению пользователя задач `CANCELED` зафиксированы в [`CHANGELOG.md`](CHANGELOG.md). Эти проверки не называются выполненными.

## Возможности

- **Главная:** «Методический компас» с шестью сценариями, содержательные направления, FAQ и независимый Open-Meteo виджет с loading/result/error/retry.
- **Аналитика:** KPI, диаграммы по шести темам, институтам и тегам, online/offline, полная таблица 20 институтов, фильтр темы и экспорт агрегатов CSV. Local scope включает только записи этого браузера; server scope — только агрегаты общего демо API. Источники не суммируются.
- **Каталог:** поиск, фильтры темы, института и формата, карточки консультаций, остаток мест и передача `consultationId`/`slotId` через относительный URL.
- **Оформление:** проверка слота и формы, обязательное видимое поле «Какая потребность/проблема», дополнительные теги, идемпотентный повтор и восстановление pending create из sessionStorage.
- **Мои записи:** активные и история, native dialog отмены с возвратом фокуса, повторное оформление, обновление после изменений и экспорт активной записи в `.ics`.
- **Repository:** два явно отображаемых режима без скрытого fallback, единые предметные методы и ошибки.
- **Backend:** Python stdlib, SQLite transactions, Bearer owner token, idempotency, analytics и отдельный weather proxy.
- **Интерфейс:** SUTD-inspired navy/cyan палитра без логотипа или герба, адаптивность от 320 px, keyboard focus, native controls и reduced-motion CSS.

Не вводите настоящие персональные данные, сведения о студентах, пароли, платёжные данные или секреты. Проект не предназначен для реальных персональных данных и не создаёт официальных обязательств.

## Стек

- HTML, CSS и vanilla JavaScript ES modules, DOM/`textContent` для динамического текста.
- Без npm, React, сборщиков, внешних шрифтов, CDN и requirements-файла.
- Python stdlib и SQLite; `Dockerfile` и `compose.yaml` для независимого server-режима.
- Относительные frontend-ссылки и ресурсы; ES modules и `fetch` запускаются по HTTP, не через `file://`.

## Статический запуск

Из корня репозитория:

```bash
python3 -m http.server 8000 --directory docs
```

Откройте `http://localhost:8000`. Остановка — `Ctrl+C`.

Статическая проверка демонстрационных данных:

```bash
python3 -m json.tool docs/data/seed.json > /dev/null
```

## Docker Compose: независимый server-режим

Backend использует только Python stdlib и SQLite. Compose публикует порт на `${APP_BIND:-127.0.0.1}` и `${APP_PORT:-8080}`: обе переменные имеют defaults и не обязательны к ручной настройке. Внутри контейнера приложение слушает `0.0.0.0:8080`, база находится в `/data/iita.db` на named volume `iita-data`.

`APP_OWNER_PEPPER` **обязателен**. Он должен генерироваться локально и храниться вне Git. Не вписывайте готовый секрет в Dockerfile, Compose, документацию или репозиторий.

Практичный способ подготовить локальный `.env` (команды приведены как инструкция, при документировании они не выполнялись):

```bash
# В корне проекта; .env и .env.* исключены из Git и Docker context.
umask 077
python3 -c 'import secrets; print(f"APP_OWNER_PEPPER={secrets.token_hex(32)}")' > .env
chmod 600 .env

docker compose up --build -d
docker compose ps
```

Compose автоматически читает `.env`. По умолчанию локальный просмотр доступен на `http://localhost:8080`; production origin здесь не задаётся и не публикуется. `docker compose logs -f app` показывает журнал контейнера, healthcheck использует `/api/v1/health`.

Обновление и остановка:

```bash
docker compose up --build -d
docker compose stop
```

Named volume и `.env` сохраняются между остановками и пересозданием контейнера. **Перед каждым restart используйте тот же pepper.** Смена pepper меняет HMAC владельца: прежние owner-token больше не откроют старые записи, хотя строки базы физически сохранятся.

Образ запускается под числовым non-root `USER`, корневая файловая система доступна read-only, запись разрешена только в `/data` и небольшой `/tmp` через tmpfs, capabilities сброшены. Healthcheck и graceful stop заданы в Dockerfile/Compose.

Автоматических backup/restore в проекте нет. Для согласованной копии SQLite остановите writer или используйте SQLite backup API в рамках отдельной операционной процедуры; не копируйте активную БД как обычный файл без согласования WAL.

## Режимы и хранение

- **Local:** один localStorage key `iita.consultations.state.v1`; записи доступны только в этом браузере и origin, не синхронизируются и могут исчезнуть после очистки данных. Глобальной занятости нет.
- **Server:** общий демонстрационный REST API и SQLite. Bearer token владельца нужен для list/create/cancel; между устройствами один локальный token не переносится автоматически.
- **Выбор режима:** `sessionStorage` ключа `iita.consultations.repository-mode.v1`. Badge показывает local/server. При сетевой ошибке определения режима local не включается незаметно: есть retry и явный выбор local.
- **Pending create:** `sessionStorage` ключа `iita.consultations.pending-booking.v1` хранит UUID idempotency key и canonical draft только в текущей вкладке до terminal response или очистки по правилам оформления.

Подробная схема модулей, DTO, REST и ограничения — в [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Реализованный сквозной путь

1. На главной выбрать сценарий компаса или открыть тему каталога.
2. Найти консультацию поиском и тремя фильтрами, сравнить формат, слоты и остаток мест.
3. Перейти к оформлению с `consultationId` и `slotId`, заполнить институт, демонстрационное имя и обязательную потребность.
4. Подтвердить учебную запись; при timeout повторить тот же canonical draft с прежним idempotency key.
5. Открыть «Мои записи», проверить активную запись после обновления, экспортировать `.ics` или отменить через dialog.
6. Убедиться в освобождении места и при необходимости повторно оформить консультацию.
7. На главной посмотреть агрегаты того же local или server источника и выгрузить CSV без raw need, displayName, booking ID и owner token.
8. Отдельно посмотреть погоду для очной встречи: loading, результат или ошибка с retry; сбой погоды не блокирует основной путь.

## Команда, страницы и рабочие ветки

| Участник | Роль и страницы | Рабочие ветки этапов |
|---|---|---|
| Дмитрий | Лид; главная/аналитика, архитектура, backend/Docker, палитра | `dmitry/core-home`, `dmitry/sqlite-docker-api`, `dmitry/sutd-palette`, `dmitry/home-analytics` |
| Максим | Каталог и оформление записи | `maxim/catalog-booking` |
| Алексей | Storage/adapters, «Мои записи», календарь и сквозная интеграция | `alexey/dual-mode-storage`, `alexey/orders-integration` |

Перечисленные рабочие ветки соответствуют фактическим merged PR и сохранены в репозитории. Общие файлы изменялись по согласованию; вклад каждого участника виден в его коммитах и запросах слияния.

## Merged pull request

### Дмитрий

- [PR #1 — главная и методический компас](https://github.com/lostdlablodream/iita-methodical-center/pull/1).
- [PR #3 — SQLite REST API и Docker](https://github.com/lostdlablodream/iita-methodical-center/pull/3).
- [PR #5 — SUTD-inspired палитра](https://github.com/lostdlablodream/iita-methodical-center/pull/5).
- [PR #7 — аналитика потребностей и CSV](https://github.com/lostdlablodream/iita-methodical-center/pull/7).

### Максим

- [PR #4 — каталог и оформление записи](https://github.com/lostdlablodream/iita-methodical-center/pull/4).

### Алексей

- [PR #2 — repository и двухрежимное хранение](https://github.com/lostdlablodream/iita-methodical-center/pull/2).
- [PR #6 — записи, отмена и календарь](https://github.com/lostdlablodream/iita-methodical-center/pull/6).

[Все merged PR](https://github.com/lostdlablodream/iita-methodical-center/pulls?q=is%3Apr+is%3Amerged).

## Использованные удачные промпты

Ниже — **фактические инструкции, отправленные AI-агентам от лица участников**, а не цитаты личной переписки людей. Контекст и связанный PR указаны отдельно от самих цитат.

### Дмитрий

Главная и погода, PR #1:

> Добавь интерактивный “Методический компас”: 4–6 реальных сценариев потребности

> Добавь полезный Open-Meteo виджет на главную “Перед очной встречей”

Палитра, PR #5:

> привести палитру всего сайта к визуальному образцу sutd.ru

> Не меняй JS, HTML или функциональность, только CSS.

Аналитика, PR #7:

> добавить на главную интерактивную аналитику методических потребностей

> Local scope явно “только записи этого браузера”, server scope “агрегаты общего демо API”. Не смешивай источники.

### Максим

Основная работа, PR #4:

> Реализуй личные страницы Максима

> обязательное поле с ТОЧНЫМ видимым label “Какая потребность/проблема”

Итерация восстановления незавершённого создания:

> Сохрани pending create operation (idempotency key + canonical draft + slot/consultation) в sessionStorage до финального ответа

Итерация обновления доступности:

> После ЛЮБОГО успешного createBooking (обычного, restored replay или restored first success) повторно получи актуальный catalog через тот же repository

### Алексей

Repository и владение данными, PR #2:

> Один localStorage key iita.consultations.state.v1, state schemaVersion=1, ownerToken crypto random 256-bit, local {revision, bookings}.

> Не скрывай серверный outage локальной записью.

Записи и календарь, PR #6:

> Доступный native dialog отмены: название/дата, две явные кнопки, Escape, overlay, возврат фокуса на исходную кнопку.

> Полезный экспорт активной записи в .ics (RFC5545)

Итерация защиты от stale response:

> Добавь mutation epoch/version, который увеличивается при подтверждённой отмене

> stale refresh delayed → cancel success → stale active response → failed queued refresh; запись обязана остаться cancelled, upcoming=0, history=1.

## Структура проекта

```text
.
├── backend/
│   ├── app.py                 # stdlib HTTP server, routes, static, headers
│   ├── repository.py          # REST operations, HMAC, transactions, weather proxy
│   ├── db.py                  # schema, constraints, seed import, SQLite connection
│   └── validation.py          # входные DTO, query/header validation, API errors
├── docs/
│   ├── index.html
│   ├── catalog.html
│   ├── booking.html
│   ├── orders.html
│   ├── assets/css/            # common + page styles, SUTD palette
│   ├── assets/js/
│   │   ├── repository.js      # выбор режима без silent fallback
│   │   ├── repository.local.js
│   │   ├── repository.server.js
│   │   ├── storage.js
│   │   ├── weather.js
│   │   └── pages/             # home/catalog/booking/orders, analytics,
│   │                          # analytics-export, calendar, runtime
│   └── data/seed.json
├── Dockerfile
├── compose.yaml
├── ARCHITECTURE.md
└── CHANGELOG.md
```

## Процесс и ограничения сдачи

Реализованы личные коммиты и ветки, семь PR с review и merge, публикация Pages и отдельный Docker deploy. Детальный roadmap содержит 122 задачи: итоговые статусы и объём результата находятся в [`CHANGELOG.md`](CHANGELOG.md).

Семь оставшихся ручных проверок отмечены `CANCELED` по явной директиве пользователя и не считаются пройденными. Этот release включает финальную документацию и mobile header CSS-fix. Отправка ссылок в личный кабинет выполняется пользователем вручную.
