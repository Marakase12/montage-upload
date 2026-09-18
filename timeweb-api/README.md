# Timeweb Upload API

Backend для App Platform. Создаёт персональные ссылки загрузки и подписывает multipart-запросы, а сами файлы идут напрямую из браузера в Timeweb S3.

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
PUBLIC_SITE_URL=https://<домен-app-platform>/
MAX_FILE_SIZE_BYTES=1073741824
CHUNK_SIZE_BYTES=10485760
DIRECT_FILE_LIMIT_BYTES=20971520
RETENTION_HOURS=24
TELEGRAM_BOT_TOKEN=<добавить после создания бота>
TELEGRAM_WEBHOOK_SECRET=<добавить после создания бота>
```

Сайт отдаётся этим же Express-приложением, поэтому отдельный фронтенд-хостинг не нужен. После деплоя вызовите `POST /api/admin/configure-cors` с заголовком `X-Admin-Secret`, чтобы браузер мог загружать части напрямую в бакет.

Сервер каждый час удаляет объекты и незавершённые multipart-загрузки старше `RETENTION_HOURS`. Ручной запуск: `POST /api/admin/cleanup`.
