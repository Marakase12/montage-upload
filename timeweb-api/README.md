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
PUBLIC_SITE_URL=https://marakase12.github.io/montage-upload/
MAX_FILE_SIZE_BYTES=21474836480
CHUNK_SIZE_BYTES=10485760
DIRECT_FILE_LIMIT_BYTES=20971520
TELEGRAM_BOT_TOKEN=<добавить после создания бота>
TELEGRAM_WEBHOOK_SECRET=<добавить после создания бота>
```

После деплоя вызовите `POST /api/admin/configure-cors` с заголовком `X-Admin-Secret`, чтобы разрешить GitHub Pages загружать части напрямую в бакет.
