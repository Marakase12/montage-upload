# Timeweb Upload API

Backend для публичного сайта на GitHub Pages. Посетитель создаёт заявку на сайте, получает изолированную сессию и загружает файлы частями напрямую в Timeweb S3.

Пакет коммерческой безопасности и порядок согласованного обновления API/worker:
[COMMERCIAL_HARDENING.md](../docs/COMMERCIAL_HARDENING.md).
Приоритеты и проверенные статусы: [COMMERCIAL_BACKLOG.md](../docs/COMMERCIAL_BACKLOG.md).

## App Platform

- Тип: Backend → Express → Node.js.
- Репозиторий: `https://github.com/Marakase12/montage-upload`.
- Ветка: `main`.
- Путь проекта: `timeweb-api`.
- Команда запуска: `npm start`.
- Healthcheck: `/api/health`.

## Переменные

```text
S3_ENDPOINT=https://s3.twcstorage.ru
S3_REGION=ru-1
S3_BUCKET=montage-uploads
S3_ACCESS_KEY=<ключ дополнительного пользователя S3>
S3_SECRET_KEY=<секрет дополнительного пользователя S3>
TOKEN_SECRET=<длинная случайная строка>
ADMIN_SECRET=<другая длинная случайная строка>
ALLOWED_ORIGIN=https://marakase12.github.io
PUBLIC_SITE_URL=https://marakase12.github.io/montage-upload/
MAX_FILE_SIZE_BYTES=5368709120
CHUNK_SIZE_BYTES=10485760
DIRECT_FILE_LIMIT_BYTES=20971520
RETENTION_HOURS=24
UPLOAD_LINK_LIFETIME_HOURS=24
TELEGRAM_BOT_TOKEN=<добавить после создания бота>
TELEGRAM_WEBHOOK_SECRET=<добавить после создания бота>
ADMIN_CHAT_ID=<Telegram ID владельца для уведомлений>
WORKER_SECRET=<отдельная длинная случайная строка для Windows bridge>
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<database>
DATABASE_SSL=require
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_SSL_CA_PATH=certs/timeweb-dbaas-ca.crt
DATABASE_POOL_SIZE=10
AUTH_PASSWORD_PEPPER=<отдельная длинная случайная строка>
SESSION_AUDIT_SECRET=<отдельная длинная случайная строка>
SESSION_LIFETIME_HOURS=720
ACCOUNT_ALLOWED_ORIGIN=https://<единый-домен-сайта>
TRUST_PROXY_HOPS=1
AUTH_REGISTER_RATE_LIMIT=5
AUTH_REGISTER_RATE_WINDOW_SECONDS=3600
AUTH_LOGIN_RATE_LIMIT=10
AUTH_LOGIN_IP_RATE_LIMIT=30
AUTH_LOGIN_RATE_WINDOW_SECONDS=900
ACCOUNT_PROJECT_RATE_LIMIT=20
ACCOUNT_PROJECT_RATE_WINDOW_SECONDS=3600
ACCOUNT_PROJECT_QUOTA=200
RATE_LIMIT_RETENTION_HOURS=168
```

`DATABASE_URL` необязателен для старого guest-flow. Если он не задан, загрузка по
персональным ссылкам продолжает работать, а `/api/health` возвращает
`accountsEnabled: false`. In-memory аккаунты разрешены только локально через
`ACCOUNT_STORE=memory` и только при явном `NODE_ENV=development` или
`NODE_ENV=test`. В production попытка включить memory-store останавливает запуск.

При обычном `npm start` prestart автоматически запускает versioned migration
runner (`npm run migrate`). Он применяет SQL-файлы из `migrations/` по порядку,
записывает SHA-256 checksum в `account_schema_migrations` и останавливает запуск
при ошибке или изменении уже применённой миграции. Не применяйте только
`001_accounts.sql` вручную: актуальная схема включает все versioned migrations.

Если `DATABASE_URL` задан, `NODE_ENV` должен быть явно равен `development`,
`test` или `production`. В production значения `TOKEN_SECRET`,
`AUTH_PASSWORD_PEPPER` и `SESSION_AUDIT_SECRET` должны содержать минимум 32
символа и отличаться друг от друга; иначе приложение fail-closed и не стартует.

Пароли хешируются через `scrypt`; сырые сессионные токены в БД не записываются.
Браузер получает только cookie
`__Host-montage_session` с атрибутами `HttpOnly`, `Secure`, `SameSite=Lax` и
`Path=/`.

`/api/health` является readiness-проверкой: при настроенной, но недоступной или
непромигрированной PostgreSQL он возвращает HTTP 503 и
`accountsEnabled: false`. Без `DATABASE_URL` guest-flow остаётся healthy, а
аккаунты явно отключены.

Для Timeweb DBaaS оставляйте проверку TLS включённой и указывайте
`DATABASE_SSL_CA_PATH=certs/timeweb-dbaas-ca.crt`. Файл содержит публичный
корневой сертификат, скачанный из вкладки «Подключение» кластера Timeweb.
Не заменяйте это на `DATABASE_SSL_REJECT_UNAUTHORIZED=false` в production.

Лимиты регистрации, входа и создания проектов хранятся в PostgreSQL, поэтому не
сбрасываются при рестарте и работают между экземплярами сервиса. Memory-store
повторяет ту же семантику только для локальной разработки. Значения выше —
production defaults: 5 регистраций/час на IP, 10 попыток входа за 15 минут на
пару IP+email и 30 на IP, 20 новых проектов/час и не более 200 проектов на
пользователя. `RATE_LIMIT_RETENTION_HOURS` управляет очисткой старых buckets.

По умолчанию Express не доверяет `X-Forwarded-For`. Для Timeweb задайте
`TRUST_PROXY_HOPS=1` только после подтверждения, что до приложения ровно один
доверенный reverse proxy; иначе оставьте переменную пустой.

Личный кабинет должен открываться с того же пользовательского домена, что и
API. GitHub Pages можно оставить для старых временных ссылок, но Safari на
iPhone не гарантирует работу account-cookie в схеме GitHub Pages → чужой домен
API.

Основные account endpoints:

- `POST /api/auth/register` — регистрация по email и паролю;
- `POST /api/auth/login` — вход и новая серверная сессия;
- `GET /api/me` или `GET /api/auth/me` — текущий пользователь;
- `POST /api/auth/logout` — отзыв текущей сессии;
- `GET /api/projects` — проекты текущего пользователя;
- `POST /api/projects` — новый проект и совместимый временный job-token;
- `POST /api/projects/claim` — привязка существующего job-token к аккаунту;
- `POST /api/projects/:projectId/access` — свежий job-token только для
  собственного проекта; для совместимости принимается также его `jobId`.

Старый `POST /api/jobs` сохранён. Если запрос пришёл с действующей account
cookie, новый job автоматически записывается в список проектов вошедшего
пользователя; без cookie маршрут продолжает создавать обычную временную заявку.

Account responses не кешируются. Чужой `projectId` возвращает `404`, а не
раскрывает существование проекта. `AUTH_PASSWORD_PEPPER`, `TOKEN_SECRET` и
`SESSION_AUDIT_SECRET` должны быть разными секретами и храниться только в
переменных Timeweb.

`POST /api/projects` сохраняет нормализованный brief (`customerName`, `contact`,
`projectType`, `comment`, `processing`) в том же S3-префиксе `.briefs/`, который
использует совместимый `/api/jobs`, поэтому поля формы личного кабинета не
теряются перед передачей локальному worker.

Личный кабинет и сайт работают на домене Express/API; GitHub Pages остаётся
гостевым входом. Обе страницы загружают части файла напрямую в S3, поэтому
разрешение origin в API не заменяет разрешение того же origin в CORS бакета.
API автоматически допускает свой домен; S3 требует его явного перечисления.

`ALLOWED_ORIGIN` и `ACCOUNT_ALLOWED_ORIGIN` поддерживают несколько origin через
запятую. Для текущего сайта, с сохранением прежнего разрешённого домена:

```text
ALLOWED_ORIGIN=https://marakase12.github.io
ACCOUNT_ALLOWED_ORIGIN=https://marakase12-montage-upload-1827.twc1.net,https://marakase12-montage-upload-7b8d.twc1.net
```

Настройки CORS бакета должны совпадать:

```json
{
  "CORSRules": [{
    "AllowedOrigins": [
      "https://marakase12.github.io",
      "https://marakase12-montage-upload-1827.twc1.net",
      "https://marakase12-montage-upload-7b8d.twc1.net"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }]
}
```

Origin указывается без пути и завершающего `/`. `OPTIONS` не добавляется в
AllowedMethods: S3 сам обслуживает preflight для разрешённого `PUT`.
`Authorization` и `X-Upload-Session` используются только в запросах к API;
загрузка в S3 авторизована подписанной ссылкой. См. [инструкцию Timeweb по CORS](https://timeweb.cloud/docs/s3-storage/supported-features/cors-setup).

При старте API синхронизирует CORS из этих переменных. Изменение только в панели
бакета может быть перезаписано при следующем запуске. Если старое приложение
использует тот же бакет, его конфигурация также должна содержать полный список
origin: иначе его перезапуск вернёт старые правила. Не удаляйте действующие origin
без проверки, какие сайты ещё используют бакет.

Проверка текущего развёртывания 22.09.2026 выявила `AccessDenied` при
`PutBucketCORS`: ограниченный S3-пользователь приложения не управляет CORS бакета.
Администратор добавил текущий домен через панель Timeweb, сохранив прежние origin.
Расширять права пользователя приложения или делать бакет публичным не требуется.
Переменные приложения уже содержат текущий origin; успешный healthcheck сам по
себе не подтверждает синхронизацию CORS.

После смены домена API проверьте **каждый** origin из корня репозитория:

```powershell
npm run smoke:cloud -- https://marakase12-montage-upload-1827.twc1.net https://marakase12.github.io
npm run smoke:cloud -- https://marakase12-montage-upload-1827.twc1.net https://marakase12-montage-upload-1827.twc1.net
```

Проверка создаёт отдельную заявку и маленький синтетический текстовый файл;
личные медиа не используются. Она проверяет API, S3 OPTIONS с `Content-Type`,
прямой PUT, CORS и доступность `ETag`, завершение multipart и список файлов.
Зелёный healthcheck в App Platform проверяет только процесс и не заменяет этот тест.

## Безопасность хранения и административная проверка

Автоматическое удаление S3-файлов и прерывание multipart-загрузок при старте и
по таймеру отключены. `POST /api/admin/cleanup` с `X-Admin-Secret` теперь возвращает
только отчёт: `dryRun: true`, `deletionEnabled: false`. Тело запроса не может
включить удаление. До отдельной project-aware политики retention удаления нет.

Отчёт считает старые файлы известных job/result-префиксов (`objects.candidates`:
количество, байты, количество неизвестных размеров), пропущенные служебные объекты
`.queue/`, `.status/`, `.actions/`, `.workers/`, `.briefs/`, неизвестные ключи и все
сохранённые незавершённые загрузки. Кандидат означает только возраст файла, а не
разрешение удалить его: активность и approval соответствующего job не проверяются.
Имена файлов, ключи объектов, upload ID и секреты в отчёт не попадают.

Сканирование ограничено 5 страницами по 1000 записей отдельно для объектов и
multipart-загрузок, общим сетевым таймаутом 15 секунд. `truncated: true` и
`pagination` явно отмечают неполный результат, лимит страниц либо некорректный
курсор; неполные числа нельзя считать итогом для всего бакета. Некорректный
`RETENTION_HOURS` (допустимы целые 1–8760 часов) отклоняется до обращения к S3.
Таймаут/ошибка доступа возвращают 503 без операций удаления.

`RETENTION_HOURS` по-прежнему ограничивает доступность исходников/результатов и
повтор обработки в других маршрутах; отключение физического удаления не продлевает
ссылки. Занятое место теперь может расти: следите за объёмом и стоимостью S3.
Эта защита не управляет внешними lifecycle-правилами бакета или старыми приложениями.

Проверять административный ключ после ротации нужно через **GET
`/api/admin/auth-check`**, передавая его только заголовком `X-Admin-Secret`:
действующий ключ — `200 {"ok":true}`, отсутствующий/старый — 401. Ответ не кэшируется,
S3 и БД не читаются и не меняются. Не используйте cleanup или configure-cors для
проверки ключа (особенно на старых версиях приложения).

Каждая веб-заявка получает собственный подписанный токен и отдельный job-префикс,
поэтому один клиент не видит файлы другого. Краткий бриф заявки хранится в
`.briefs/<job-id>.json` и защищён от этой очистки. Telegram-команды `/start` и
`/upload` остаются дополнительным способом создать персональную ссылку.

## Связь с локальным MontageAI

После завершения загрузки MP4, MOV или MKV backend создаёт S3-манифест в `.queue/`.
Локальная машина работает только через защищённые маршруты `/api/worker/*`:

- получает ожидающие задачи;
- забирает исходник по временной подписанной ссылке;
- отправляет процент и текущую стадию;
- получает временную ссылку для загрузки `preview.mp4`.
- забирает текстовые правки, возвращает новый preview и фиксирует явный approval.

Approval с сайта не означает публикацию: он только сохраняет проверенный
`final.mp4` на локальной машине. Маршрута автоматической публикации здесь нет.

Пользователь видит эти данные через `/api/pipeline` только внутри собственной
подписанной заявки. Для локальной машины добавьте в `.env` MontageAI:

```text
MONTAGE_CLOUD_API_URL=https://<домен-app-platform>
MONTAGE_CLOUD_WORKER_SECRET=<то же значение, что WORKER_SECRET в Timeweb>
```

Разовый диагностический запуск на Windows:

```powershell
& 'X:\AI\Codex\montage\.venv\Scripts\python.exe' 'X:\AI\Codex\montage\cloud_bridge.py' --once
```

Установка постоянного моста через Планировщик заданий Windows:

```powershell
& 'X:\AI\Codex\montage\install_cloud_bridge_task.ps1'
```

Скрипт проверяет наличие настроек, не выводит секрет и пишет технические логи в
`X:\AI\Codex\montage\runtime\cloud_bridge.*.log`.
