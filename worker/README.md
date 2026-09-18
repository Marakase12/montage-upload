# Облачный API загрузки

Cloudflare Worker принимает запросы от страницы на GitHub Pages и складывает файлы напрямую в R2 через multipart upload.

## 1. Создать R2 bucket

В Cloudflare создайте bucket с именем `montage-uploads` или измените `bucket_name` в `wrangler.jsonc`.

## 2. Настроить адреса

В `wrangler.jsonc` замените:

- `ALLOWED_ORIGIN` на origin GitHub Pages, например `https://username.github.io`;
- `PUBLIC_SITE_URL` на полный адрес страницы, например `https://username.github.io/montage-upload/`.

После первого deploy укажите URL Worker в `public/config.js`:

```js
window.MONTAGE_UPLOAD_CONFIG = {
  apiBase: 'https://montage-upload-api.username.workers.dev',
};
```

## 3. Добавить секреты

```powershell
npx wrangler secret put TOKEN_SECRET --config worker/wrangler.jsonc
npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config worker/wrangler.jsonc
```

`TOKEN_SECRET` должен быть длинной случайной строкой. Секреты никогда не добавляются в Git.

## 4. Развернуть Worker

```powershell
npm run worker:deploy
```

## 5. Подключить Telegram webhook

Webhook указывает на:

```text
https://montage-upload-api.username.workers.dev/telegram/webhook
```

При настройке webhook передайте тот же `TELEGRAM_WEBHOOK_SECRET` как `secret_token`.

Если бот получает файл больше `DIRECT_FILE_LIMIT_BYTES`, он отвечает кнопкой на GitHub Pages. Ссылка персональная и действует 24 часа. После завершения загрузки бот подтверждает получение файла.

Текущий webhook обрабатывает только ветку слишком больших файлов. Логику скачивания и обработки небольших Telegram-файлов следует подключить отдельным этапом.
