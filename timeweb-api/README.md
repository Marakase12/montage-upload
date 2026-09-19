# Timeweb Upload API

Backend для публичного сайта на GitHub Pages. Посетитель создаёт заявку на сайте, получает изолированную сессию и загружает файлы частями напрямую в Timeweb S3.

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
```

Публичный сайт размещён на GitHub Pages; `public/config.js` указывает технический домен API. Express также может отдать страницу со своего домена для диагностики. В настройках CORS бакета разрешите origin `https://marakase12.github.io`, методы `GET`, `PUT`, `HEAD`, заголовки `*` и expose-заголовок `ETag`.

После смены домена API проверьте его извне командой `npm run smoke:cloud -- https://<домен-api>` из корня репозитория. Проверка создаёт отдельную заявку и загружает маленький синтетический текстовый файл; личные медиа не используются. Зелёный healthcheck в App Platform проверяет только локальный процесс и не заменяет этот тест.

Сервер каждый час удаляет объекты и незавершённые multipart-загрузки старше `RETENTION_HOURS`. Ручной запуск: `POST /api/admin/cleanup`.

Каждая веб-заявка получает собственный подписанный токен и отдельный job-префикс, поэтому один клиент не видит файлы другого. Краткий бриф заявки хранится в `.briefs/<job-id>.json` и удаляется общим процессом очистки. Telegram-команды `/start` и `/upload` остаются дополнительным способом создать персональную ссылку.

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
