const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.mxf',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.zip', '.7z', '.rar', '.txt', '.md', '.json',
]);

const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const DEFAULT_DIRECT_LIMIT = 20 * 1024 * 1024;
const TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodePayload(payload) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePayload(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function signToken(payload, secret) {
  if (!secret) throw new Error('TOKEN_SECRET is not configured');
  const encoded = encodePayload(payload);
  return `${encoded}.${bytesToBase64Url(await hmac(secret, encoded))}`;
}

async function verifyToken(token, secret, expectedKind) {
  if (!token || !secret) throw new HttpError(401, 'Недействительная ссылка загрузки');
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new HttpError(401, 'Недействительная ссылка загрузки');

  const expected = await hmac(secret, encoded);
  const actual = base64UrlToBytes(signature);
  if (expected.length !== actual.length) throw new HttpError(401, 'Недействительная ссылка загрузки');
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index];
  }
  if (difference !== 0) throw new HttpError(401, 'Недействительная ссылка загрузки');

  let payload;
  try {
    payload = decodePayload(encoded);
  } catch {
    throw new HttpError(401, 'Недействительная ссылка загрузки');
  }
  if (payload.kind !== expectedKind) throw new HttpError(401, 'Неверный тип ссылки');
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, 'Срок действия ссылки истёк');
  }
  return payload;
}

function bearer(request) {
  const authorization = request.headers.get('Authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function sanitizeFilename(input) {
  const basename = String(input ?? '').normalize('NFC').split(/[\\/]/).pop();
  const clean = basename
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!clean || clean === '.' || clean === '..') throw new HttpError(400, 'Некорректное имя файла');
  const dot = clean.lastIndexOf('.');
  const extension = dot >= 0 ? clean.slice(dot).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new HttpError(415, `Формат ${extension || 'без расширения'} не поддерживается`);
  }
  const stem = dot >= 0 ? clean.slice(0, dot) : clean;
  return `${stem.slice(0, 150)}${extension.slice(0, 20)}`;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = String(env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const originAllowed = !origin || allowed.includes(origin.replace(/\/$/, ''));
  return {
    'Access-Control-Allow-Origin': originAllowed && origin ? origin : allowed[0] ?? 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Session',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(request, env, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const allowed = String(env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (!allowed.includes(origin.replace(/\/$/, ''))) throw new HttpError(403, 'Этот сайт не разрешён');
}

async function jobFromRequest(request, env) {
  return verifyToken(bearer(request), env.TOKEN_SECRET, 'job');
}

async function sessionFromRequest(request, env) {
  return verifyToken(request.headers.get('X-Upload-Session') ?? '', env.TOKEN_SECRET, 'session');
}

async function createUpload(request, env) {
  const job = await jobFromRequest(request, env);
  const input = await request.json();
  const safeName = sanitizeFilename(input.name);
  const size = Number(input.size);
  const maxFileSize = integer(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE);
  const chunkSize = Math.max(integer(env.CHUNK_SIZE_BYTES, DEFAULT_CHUNK_SIZE), 5 * 1024 * 1024);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'Некорректный размер файла');
  if (size > maxFileSize) throw new HttpError(413, 'Файл превышает лимит сервиса');

  if (input.resumeSession) {
    const resumed = await verifyToken(input.resumeSession, env.TOKEN_SECRET, 'session');
    if (
      resumed.jobId === job.jobId
      && resumed.name === safeName
      && resumed.size === size
      && resumed.lastModified === Number(input.lastModified ?? 0)
    ) {
      return {
        uploadId: resumed.uploadId,
        name: resumed.name,
        size,
        type: resumed.type,
        chunkSize: resumed.chunkSize,
        totalChunks: Math.ceil(size / resumed.chunkSize),
        receivedChunks: Array.isArray(input.receivedChunks) ? input.receivedChunks : [],
        status: 'uploading',
        resumed: true,
        sessionToken: input.resumeSession,
      };
    }
  }

  const random = crypto.randomUUID().slice(0, 8);
  const key = `${job.jobId}/${Date.now()}-${random}-${safeName}`;
  const type = String(input.type || 'application/octet-stream').slice(0, 120);
  const upload = await env.UPLOADS.createMultipartUpload(key, {
    httpMetadata: { contentType: type },
    customMetadata: {
      originalName: safeName,
      jobId: String(job.jobId),
      source: 'github-pages-upload-portal',
    },
  });
  const session = {
    kind: 'session',
    jobId: job.jobId,
    chatId: job.chatId,
    key,
    uploadId: upload.uploadId,
    name: safeName,
    size,
    type,
    lastModified: Number(input.lastModified ?? 0),
    chunkSize,
    exp: job.exp,
  };

  return {
    uploadId: upload.uploadId,
    name: safeName,
    size,
    type,
    chunkSize,
    totalChunks: Math.ceil(size / chunkSize),
    receivedChunks: [],
    status: 'uploading',
    sessionToken: await signToken(session, env.TOKEN_SECRET),
  };
}

async function uploadPart(request, env, uploadId, indexText) {
  const job = await jobFromRequest(request, env);
  const session = await sessionFromRequest(request, env);
  if (session.jobId !== job.jobId || session.uploadId !== uploadId) {
    throw new HttpError(403, 'Сессия не принадлежит этой ссылке');
  }
  const index = Number(indexText);
  const totalChunks = Math.ceil(session.size / session.chunkSize);
  if (!Number.isSafeInteger(index) || index < 0 || index >= totalChunks) {
    throw new HttpError(416, 'Часть вне диапазона файла');
  }

  const expectedLength = Math.min(session.chunkSize, session.size - index * session.chunkSize);
  if (Number(request.headers.get('Content-Length')) !== expectedLength) {
    throw new HttpError(400, 'Некорректный размер части');
  }

  const upload = env.UPLOADS.resumeMultipartUpload(session.key, session.uploadId);
  const result = await upload.uploadPart(index + 1, request.body);
  return { ok: true, index, partNumber: result.partNumber, etag: result.etag };
}

async function completeUpload(request, env, uploadId) {
  const job = await jobFromRequest(request, env);
  const session = await sessionFromRequest(request, env);
  if (session.jobId !== job.jobId || session.uploadId !== uploadId) {
    throw new HttpError(403, 'Сессия не принадлежит этой ссылке');
  }
  const input = await request.json();
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const expectedParts = Math.ceil(session.size / session.chunkSize);
  if (parts.length !== expectedParts) throw new HttpError(409, 'Не все части загружены');

  const upload = env.UPLOADS.resumeMultipartUpload(session.key, session.uploadId);
  const object = await upload.complete(parts);

  if (job.chatId && env.TELEGRAM_BOT_TOKEN) {
    await sendTelegram(env, 'sendMessage', {
      chat_id: job.chatId,
      text: `✅ Файл «${session.name}» загружен. Размер: ${formatBytes(session.size)}.`,
    }).catch(() => {});
  }

  return {
    uploadId,
    name: session.name,
    size: session.size,
    status: 'completed',
    etag: object.httpEtag,
  };
}

async function abortUpload(request, env, uploadId) {
  const job = await jobFromRequest(request, env);
  const session = await sessionFromRequest(request, env);
  if (session.jobId !== job.jobId || session.uploadId !== uploadId) {
    throw new HttpError(403, 'Сессия не принадлежит этой ссылке');
  }
  const upload = env.UPLOADS.resumeMultipartUpload(session.key, session.uploadId);
  await upload.abort();
  return { ok: true };
}

async function listJobFiles(request, env) {
  const job = await jobFromRequest(request, env);
  const listed = await env.UPLOADS.list({
    prefix: `${job.jobId}/`,
    include: ['customMetadata'],
    limit: 100,
  });
  return {
    uploadDir: 'Защищённое облачное хранилище',
    files: listed.objects
      .map((object) => ({
        name: object.customMetadata?.originalName || object.key.split('/').pop(),
        size: object.size,
        modifiedAt: object.uploaded.toISOString(),
      }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
  };
}

function formatBytes(value) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let amount = Number(value) || 0;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

async function sendTelegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram API error ${response.status}`);
  return response.json();
}

function findTelegramMedia(message) {
  return message?.document || message?.video || message?.audio || message?.voice || message?.animation;
}

async function telegramWebhook(request, env) {
  const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET ?? '');
  const suppliedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!expectedSecret || suppliedSecret !== expectedSecret) throw new HttpError(401, 'Неверный секрет webhook');

  const update = await request.json();
  const message = update.message || update.edited_message;
  const media = findTelegramMedia(message);
  if (!message?.chat?.id || !media?.file_size) return { ok: true, handled: false };

  const directLimit = integer(env.DIRECT_FILE_LIMIT_BYTES, DEFAULT_DIRECT_LIMIT);
  if (Number(media.file_size) <= directLimit) return { ok: true, handled: false };

  const now = Math.floor(Date.now() / 1000);
  const jobId = `tg-${message.chat.id}-${message.message_id}`;
  const token = await signToken({
    kind: 'job',
    jobId,
    chatId: String(message.chat.id),
    userId: String(message.from?.id ?? ''),
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  }, env.TOKEN_SECRET);
  const uploadUrl = new URL(env.PUBLIC_SITE_URL);
  uploadUrl.searchParams.set('token', token);

  await sendTelegram(env, 'sendMessage', {
    chat_id: message.chat.id,
    reply_to_message_id: message.message_id,
    text: `Файл больше лимита прямой отправки (${formatBytes(directLimit)}). Загрузите его через защищённую страницу — ссылка действует 24 часа.`,
    reply_markup: {
      inline_keyboard: [[{ text: 'Загрузить большой файл', url: uploadUrl.toString() }]],
    },
  });
  return { ok: true, handled: true };
}

async function route(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') {
    assertAllowedOrigin(request, env);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (pathname.startsWith('/api/')) assertAllowedOrigin(request, env);

  if (request.method === 'GET' && pathname === '/api/health') {
    return json(request, env, 200, {
      ok: true,
      cloud: true,
      protected: true,
      maxFileSize: integer(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE),
      chunkSize: Math.max(integer(env.CHUNK_SIZE_BYTES, DEFAULT_CHUNK_SIZE), 5 * 1024 * 1024),
    });
  }
  if (request.method === 'GET' && pathname === '/api/files') {
    return json(request, env, 200, await listJobFiles(request, env));
  }
  if (request.method === 'POST' && pathname === '/api/uploads') {
    return json(request, env, 201, await createUpload(request, env));
  }
  if (request.method === 'POST' && pathname === '/telegram/webhook') {
    return json(request, env, 200, await telegramWebhook(request, env));
  }

  const chunkMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/chunks\/(\d+)$/);
  if (request.method === 'PUT' && chunkMatch) {
    return json(
      request,
      env,
      200,
      await uploadPart(request, env, decodeURIComponent(chunkMatch[1]), chunkMatch[2]),
    );
  }
  const completeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
  if (request.method === 'POST' && completeMatch) {
    return json(
      request,
      env,
      200,
      await completeUpload(request, env, decodeURIComponent(completeMatch[1])),
    );
  }
  const cancelMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (request.method === 'DELETE' && cancelMatch) {
    return json(
      request,
      env,
      200,
      await abortUpload(request, env, decodeURIComponent(cancelMatch[1])),
    );
  }

  throw new HttpError(404, 'Метод не найден');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      const status = error instanceof HttpError ? error.status : 500;
      return json(request, env, status, {
        error: status === 500 ? 'Внутренняя ошибка сервера' : error.message,
      });
    }
  },
};
