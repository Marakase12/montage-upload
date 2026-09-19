import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  PutBucketCorsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import express from 'express';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const DEFAULT_DIRECT_LIMIT = 20 * 1024 * 1024;
const DEFAULT_LINK_LIFETIME_HOURS = 24;
const DEFAULT_RETENTION_HOURS = 24;
const PROCESSABLE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);
export function isProcessableVideoFile(name) {
  return PROCESSABLE_VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}
const PIPELINE_STATES = new Set([
  'QUEUED', 'PROCESSING', 'READY_FOR_REVIEW', 'LONG_CANDIDATES_READY', 'APPROVED', 'FAILED',
]);
const ACTION_STATES = new Set(['PENDING', 'PROCESSING', 'COMPLETE', 'FAILED']);
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(CURRENT_DIR, '../public');
const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.mxf',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.zip', '.7z', '.rar', '.txt', '.md', '.json',
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function signToken(payload, secret) {
  if (!secret) throw new Error('TOKEN_SECRET is not configured');
  const encoded = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token, secret, expectedKind) {
  if (!token || !secret) throw new HttpError(401, 'Недействительная ссылка загрузки');
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new HttpError(401, 'Недействительная ссылка загрузки');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    throw new HttpError(401, 'Недействительная ссылка загрузки');
  }
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new HttpError(401, 'Недействительная ссылка загрузки');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, 'Недействительная ссылка загрузки');
  }
  if (payload.kind !== expectedKind) throw new HttpError(401, 'Неверный тип ссылки');
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, 'Срок действия ссылки истёк');
  }
  return payload;
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

function bearer(request) {
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function bucketCorsConfiguration(env) {
  return {
    CORSRules: [{
      AllowedOrigins: allowedOrigins(env),
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    }],
  };
}

async function configureBucketCors(s3, bucket, env) {
  if (!bucket || !allowedOrigins(env).length) return;
  await s3.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: bucketCorsConfiguration(env),
  }));
}

function processingOptions(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    mode: input.mode === 'long' ? 'long' : 'short',
    faceTrackingEnabled: input.faceTrackingEnabled !== false,
    subtitlesEnabled: input.subtitlesEnabled !== false,
    hookEnabled: input.hookEnabled !== false,
    musicEnabled: input.musicEnabled !== false,
    requestText: shortText(input.requestText, 500),
  };
}

function workerAuthorized(request, env) {
  const expected = String(env.WORKER_SECRET ?? '');
  const supplied = String(request.headers['x-worker-secret'] ?? '');
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function requireWorker(request, env) {
  if (!workerAuthorized(request, env)) throw new HttpError(401, 'Доступ локальной машины запрещён');
}

function safeIdentifier(value, label) {
  const result = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(result)) throw new HttpError(400, `Некорректный ${label}`);
  return result;
}

function queueKey(jobId, taskId) {
  return `.queue/${safeIdentifier(jobId, 'jobId')}/${safeIdentifier(taskId, 'taskId')}.json`;
}

function statusKey(jobId, taskId) {
  return `.status/${safeIdentifier(jobId, 'jobId')}/${safeIdentifier(taskId, 'taskId')}.json`;
}

function actionKey(jobId, actionId) {
  return `.actions/${safeIdentifier(jobId, 'jobId')}/${safeIdentifier(actionId, 'actionId')}.json`;
}

function actionIsAvailable(action) {
  if (action?.state === 'PENDING') return true;
  const updatedAt = Date.parse(String(action?.updatedAt ?? ''));
  return action?.state === 'PROCESSING'
    && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 2 * 60 * 60 * 1000);
}

async function objectJson(s3, bucket, key) {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await object.Body.transformToString('utf-8');
  return JSON.parse(text);
}

async function listPrefix(s3, bucket, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    objects.push(...(page.Contents ?? []).filter((object) => object.Key));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function putJson(s3, bucket, key, payload) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(payload, null, 2),
    ContentType: 'application/json; charset=utf-8',
  }));
}

function createS3(env) {
  return new S3Client({
    region: env.S3_REGION || 'ru-1',
    endpoint: env.S3_ENDPOINT || 'https://s3.twcstorage.ru',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
  });
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

async function listAllParts(s3, bucket, key, uploadId) {
  const parts = [];
  let marker;
  do {
    const page = await s3.send(new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: marker,
      MaxParts: 1000,
    }));
    for (const part of page.Parts ?? []) {
      parts.push({ ETag: part.ETag, PartNumber: part.PartNumber });
    }
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

async function cleanupExpiredObjects(s3, bucket, retentionHours) {
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  let continuationToken;
  let deleted = 0;

  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    const expired = (page.Contents ?? [])
      .filter((object) => object.Key && object.LastModified?.getTime() < cutoff)
      .map((object) => ({ Key: object.Key }));
    if (expired.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: expired, Quiet: true },
      }));
      deleted += expired.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  let keyMarker;
  let uploadIdMarker;
  let aborted = 0;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
      MaxUploads: 1000,
    }));
    const stale = (page.Uploads ?? []).filter(
      (upload) => upload.Key && upload.UploadId && upload.Initiated?.getTime() < cutoff,
    );
    await Promise.all(stale.map((upload) => s3.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: upload.Key,
      UploadId: upload.UploadId,
    }))));
    aborted += stale.length;
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker || uploadIdMarker);

  return { deleted, aborted };
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

function telegramMedia(message) {
  return message?.document || message?.video || message?.audio || message?.voice || message?.animation;
}

function telegramCommand(message) {
  const text = String(message?.text ?? '').trim();
  const command = text.split(/\s+/, 1)[0].toLowerCase().split('@', 1)[0];
  return command;
}

export function createTelegramUploadAccess(message, env, now = Math.floor(Date.now() / 1000)) {
  if (!message?.chat?.id) throw new HttpError(400, 'Не удалось определить пользователя');
  if (!env.PUBLIC_SITE_URL) throw new Error('PUBLIC_SITE_URL is not configured');
  const lifetimeHours = integer(env.UPLOAD_LINK_LIFETIME_HOURS, DEFAULT_LINK_LIFETIME_HOURS);
  const job = {
    kind: 'job',
    jobId: `tg-${crypto.randomUUID()}`,
    chatId: String(message.chat.id),
    userId: String(message.from?.id ?? message.chat.id),
    iat: now,
    exp: now + lifetimeHours * 60 * 60,
  };
  const token = signToken(job, env.TOKEN_SECRET);
  const uploadUrl = new URL(env.PUBLIC_SITE_URL);
  uploadUrl.searchParams.set('token', token);
  return { job, token, uploadUrl: uploadUrl.toString(), lifetimeHours };
}

export function createWebUploadAccess(env, now = Math.floor(Date.now() / 1000), processing = {}) {
  const lifetimeHours = integer(env.UPLOAD_LINK_LIFETIME_HOURS, DEFAULT_LINK_LIFETIME_HOURS);
  const job = {
    kind: 'job',
    jobId: `web-${crypto.randomUUID()}`,
    userId: `web-${crypto.randomUUID()}`,
    source: 'web',
    processing: processingOptions(processing),
    iat: now,
    exp: now + lifetimeHours * 60 * 60,
  };
  return {
    job,
    token: signToken(job, env.TOKEN_SECRET),
    lifetimeHours,
    expiresAt: new Date(job.exp * 1000).toISOString(),
  };
}

function shortText(value, maxLength) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

async function sendUploadButton(env, message, lead) {
  const access = createTelegramUploadAccess(message, env);
  await sendTelegram(env, 'sendMessage', {
    chat_id: message.chat.id,
    ...(message.message_id ? { reply_to_message_id: message.message_id } : {}),
    text: `${lead}\n\nСсылка персональная и действует ${access.lifetimeHours} ч. Её не нужно пересылать другим.`,
    reply_markup: {
      inline_keyboard: [[{ text: 'Загрузить файлы', url: access.uploadUrl }]],
    },
  });
  return access;
}

export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const s3 = options.s3 ?? createS3(env);
  const signUrl = options.getSignedUrl ?? getSignedUrl;
  const bucket = env.S3_BUCKET;
  const app = express();
  const jobRequests = new Map();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));
  app.use((request, response, next) => {
    const origin = request.headers.origin?.replace(/\/$/, '');
    const allowed = allowedOrigins(env);
    let sameOrigin = false;
    if (origin) {
      try {
        sameOrigin = new URL(origin).host === request.headers.host;
      } catch {
        sameOrigin = false;
      }
    }
    if (origin && !sameOrigin && !allowed.includes(origin)) {
      next(new HttpError(403, 'Этот сайт не разрешён'));
      return;
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Upload-Session');
    response.setHeader('Access-Control-Max-Age', '86400');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  const jobFromRequest = (request) => verifyToken(bearer(request), env.TOKEN_SECRET, 'job');
  const sessionFromRequest = (request) => verifyToken(
    request.headers['x-upload-session'] ?? '',
    env.TOKEN_SECRET,
    'session',
  );
  const assertSession = (request) => {
    const job = jobFromRequest(request);
    const session = sessionFromRequest(request);
    if (session.jobId !== job.jobId || session.sessionId !== request.params.uploadId) {
      throw new HttpError(403, 'Сессия не принадлежит этой ссылке');
    }
    return { job, session };
  };

  app.post('/api/jobs', asyncRoute(async (request, response) => {
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const input = request.body ?? {};
    const customerName = shortText(input.customerName, 80);
    const contact = shortText(input.contact, 120);
    const projectType = shortText(input.projectType, 40) || 'other';
    const comment = shortText(input.comment, 1000);
    const quickStart = input.quickStart === true;
    if (!quickStart && customerName.length < 2) throw new HttpError(400, 'Укажите ваше имя');
    if (!quickStart && contact.length < 3) throw new HttpError(400, 'Укажите Telegram, email или другой контакт');

    const now = Date.now();
    const requester = request.ip || request.socket.remoteAddress || 'unknown';
    const recent = (jobRequests.get(requester) ?? []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= 10) throw new HttpError(429, 'Слишком много заявок. Попробуйте через час');
    recent.push(now);
    jobRequests.set(requester, recent);

    const processing = processingOptions(input.processing);
    const access = createWebUploadAccess(env, Math.floor(now / 1000), processing);
    const brief = {
      version: 1,
      jobId: access.job.jobId,
      source: 'website',
      customerName: customerName || null,
      contact: contact || null,
      projectType,
      comment,
      processing,
      quickStart,
      createdAt: new Date(now).toISOString(),
      expiresAt: access.expiresAt,
    };
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `.briefs/${access.job.jobId}.json`,
      Body: JSON.stringify(brief, null, 2),
      ContentType: 'application/json; charset=utf-8',
      Metadata: { jobid: access.job.jobId, source: 'website' },
    }));
    response.status(201).json({
      ok: true,
      token: access.token,
      jobId: access.job.jobId,
      lifetimeHours: access.lifetimeHours,
      expiresAt: access.expiresAt,
    });
  }));

  app.get('/api/health', (request, response) => {
    response.json({
      ok: true,
      cloud: true,
      provider: 'timeweb-s3',
      protected: true,
      maxFileSize: integer(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE),
      chunkSize: Math.max(integer(env.CHUNK_SIZE_BYTES, DEFAULT_CHUNK_SIZE), 5 * 1024 * 1024),
      retentionHours: integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
    });
  });

  app.get('/api/session', (request, response) => {
    const job = jobFromRequest(request);
    response.json({
      ok: true,
      jobId: job.jobId,
      source: job.source || 'telegram',
      processing: processingOptions(job.processing),
      expiresAt: new Date(job.exp * 1000).toISOString(),
    });
  });

  app.post('/api/uploads', asyncRoute(async (request, response) => {
    const job = jobFromRequest(request);
    const input = request.body ?? {};
    const safeName = sanitizeFilename(input.name);
    const size = Number(input.size);
    const maxFileSize = integer(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE);
    const chunkSize = Math.max(integer(env.CHUNK_SIZE_BYTES, DEFAULT_CHUNK_SIZE), 5 * 1024 * 1024);
    const lastModified = Number(input.lastModified ?? 0);
    if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'Некорректный размер файла');
    if (size > maxFileSize) throw new HttpError(413, 'Файл превышает лимит сервиса');
    if (!bucket) throw new Error('S3_BUCKET is not configured');

    if (input.resumeSession) {
      const resumed = verifyToken(input.resumeSession, env.TOKEN_SECRET, 'session');
      if (
        resumed.jobId === job.jobId
        && resumed.name === safeName
        && resumed.size === size
        && resumed.lastModified === lastModified
      ) {
        const parts = await listAllParts(s3, bucket, resumed.key, resumed.multipartUploadId);
        response.json({
          provider: 's3-direct',
          uploadId: resumed.sessionId,
          name: resumed.name,
          size,
          type: resumed.type,
          chunkSize: resumed.chunkSize,
          totalChunks: Math.ceil(size / resumed.chunkSize),
          receivedChunks: parts.map((part) => part.PartNumber - 1),
          status: 'uploading',
          resumed: true,
          sessionToken: input.resumeSession,
        });
        return;
      }
    }

    const type = String(input.type || 'application/octet-stream').slice(0, 120);
    const key = `${job.jobId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    const created = await s3.send(new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: type,
      Metadata: { originalname: encodeURIComponent(safeName), jobid: String(job.jobId) },
    }));
    const session = {
      kind: 'session',
      sessionId: crypto.randomUUID(),
      multipartUploadId: created.UploadId,
      jobId: job.jobId,
      chatId: job.chatId,
      key,
      name: safeName,
      size,
      type,
      lastModified,
      chunkSize,
      processing: processingOptions(job.processing),
      exp: job.exp,
    };

    response.status(201).json({
      provider: 's3-direct',
      uploadId: session.sessionId,
      name: safeName,
      size,
      type,
      chunkSize,
      totalChunks: Math.ceil(size / chunkSize),
      receivedChunks: [],
      status: 'uploading',
      sessionToken: signToken(session, env.TOKEN_SECRET),
    });
  }));

  app.post('/api/uploads/:uploadId/chunks/:index', asyncRoute(async (request, response) => {
    const { session } = assertSession(request);
    const index = Number(request.params.index);
    const totalChunks = Math.ceil(session.size / session.chunkSize);
    if (!Number.isSafeInteger(index) || index < 0 || index >= totalChunks) {
      throw new HttpError(416, 'Часть вне диапазона файла');
    }
    const command = new UploadPartCommand({
      Bucket: bucket,
      Key: session.key,
      UploadId: session.multipartUploadId,
      PartNumber: index + 1,
    });
    response.json({
      uploadUrl: await signUrl(s3, command, { expiresIn: 15 * 60 }),
      partNumber: index + 1,
      expiresIn: 15 * 60,
    });
  }));

  app.post('/api/uploads/:uploadId/complete', asyncRoute(async (request, response) => {
    const { job, session } = assertSession(request);
    const parts = await listAllParts(s3, bucket, session.key, session.multipartUploadId);
    const expectedParts = Math.ceil(session.size / session.chunkSize);
    if (parts.length !== expectedParts) {
      throw new HttpError(409, `Не все части загружены: ${parts.length}/${expectedParts}`);
    }
    const completed = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: session.key,
      UploadId: session.multipartUploadId,
      MultipartUpload: { Parts: parts },
    }));

    let pipelineTask = null;
    if (isProcessableVideoFile(session.name)) {
      pipelineTask = {
        version: 1,
        taskId: session.sessionId,
        jobId: job.jobId,
        source: job.source || 'telegram',
        chatId: job.chatId || null,
        userId: job.userId || null,
        objectKey: session.key,
        fileName: session.name,
        size: session.size,
        type: session.type,
        processing: processingOptions(session.processing || job.processing),
        createdAt: new Date().toISOString(),
      };
      await putJson(s3, bucket, queueKey(job.jobId, session.sessionId), pipelineTask);
      await putJson(s3, bucket, statusKey(job.jobId, session.sessionId), {
        version: 1,
        jobId: job.jobId,
        taskId: session.sessionId,
        state: 'QUEUED',
        percent: 0,
        stage: 'cloud_queue',
        detail: 'Видео загружено и ожидает локальную машину',
        updatedAt: new Date().toISOString(),
      });
    }

    if (job.chatId && env.TELEGRAM_BOT_TOKEN) {
      await sendTelegram(env, 'sendMessage', {
        chat_id: job.chatId,
        text: `✅ Файл «${session.name}» загружен. Размер: ${formatBytes(session.size)}.`,
      }).catch(() => {});
      if (env.ADMIN_CHAT_ID && String(env.ADMIN_CHAT_ID) !== String(job.chatId)) {
        await sendTelegram(env, 'sendMessage', {
          chat_id: env.ADMIN_CHAT_ID,
          text: `📥 Новый файл от пользователя ${job.userId || job.chatId}: «${session.name}», ${formatBytes(session.size)}.`,
        }).catch(() => {});
      }
    }
    response.json({
      uploadId: session.sessionId,
      name: session.name,
      size: session.size,
      status: 'completed',
      etag: completed.ETag,
      pipelineQueued: Boolean(pipelineTask),
    });
  }));

  app.get('/api/pipeline', asyncRoute(async (request, response) => {
    const job = jobFromRequest(request);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const objects = await listPrefix(s3, bucket, `.status/${job.jobId}/`);
    const actionObjects = await listPrefix(s3, bucket, `.actions/${job.jobId}/`);
    const actions = [];
    for (const object of actionObjects) {
      const action = await objectJson(s3, bucket, object.Key);
      if (action.jobId === job.jobId) actions.push(action);
    }
    const tasks = [];
    for (const object of objects) {
      const status = await objectJson(s3, bucket, object.Key);
      if (status.jobId !== job.jobId) continue;
      if (status.resultKey && ['READY_FOR_REVIEW', 'APPROVED'].includes(status.state)) {
        status.previewUrl = await signUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: status.resultKey }),
          { expiresIn: 15 * 60 },
        );
      }
      status.action = actions
        .filter((action) => action.taskId === status.taskId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
      tasks.push(status);
    }
    tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    response.json({ ok: true, tasks });
  }));

  app.post('/api/pipeline/:taskId/actions', asyncRoute(async (request, response) => {
    const job = jobFromRequest(request);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const status = await objectJson(s3, bucket, statusKey(job.jobId, taskId));
    if (status.jobId !== job.jobId || status.taskId !== taskId) {
      throw new HttpError(409, 'Ролик не принадлежит этой заявке');
    }
    const kind = String(request.body?.kind ?? '').toUpperCase();
    if (!['REVISION', 'APPROVE'].includes(kind)) throw new HttpError(400, 'Неизвестное действие');
    if (kind === 'REVISION' && !['READY_FOR_REVIEW', 'APPROVED'].includes(status.state)) {
      throw new HttpError(409, 'Ролик пока не готов к правкам');
    }
    if (kind === 'APPROVE' && status.state !== 'READY_FOR_REVIEW') {
      throw new HttpError(409, 'Подтвердить можно только готовый preview');
    }
    if (kind === 'APPROVE' && request.body?.confirmation !== 'APPROVE') {
      throw new HttpError(400, 'Нужно явно подтвердить выбранный preview');
    }
    const existingObjects = await listPrefix(s3, bucket, `.actions/${job.jobId}/`);
    for (const object of existingObjects) {
      const existing = await objectJson(s3, bucket, object.Key);
      if (existing.taskId === taskId && actionIsAvailable(existing)) {
        throw new HttpError(409, 'Предыдущее действие ещё выполняется');
      }
    }
    const requestText = shortText(request.body?.requestText, 500);
    if (kind === 'REVISION' && requestText.length < 2) {
      throw new HttpError(400, 'Опиши, что изменить в ролике');
    }
    const actionId = crypto.randomUUID();
    const action = {
      version: 1,
      actionId,
      jobId: job.jobId,
      taskId,
      localJobId: status.localJobId,
      resultKey: status.resultKey || null,
      kind,
      previousState: status.state,
      requestText: kind === 'APPROVE' ? 'Всё хорошо, подтверждаю этот preview' : requestText,
      state: 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!action.localJobId) throw new HttpError(409, 'Локальный job ещё не привязан');
    await putJson(s3, bucket, actionKey(job.jobId, actionId), action);
    response.status(202).json({ ok: true, action });
  }));

  app.get('/api/worker/tasks', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const objects = await listPrefix(s3, bucket, '.queue/');
    const tasks = [];
    for (const object of objects) {
      const task = await objectJson(s3, bucket, object.Key);
      let status = null;
      try {
        status = await objectJson(s3, bucket, statusKey(task.jobId, task.taskId));
      } catch (error) {
        if (error?.name !== 'NoSuchKey') throw error;
      }
      const updatedAt = Date.parse(String(status?.updatedAt ?? ''));
      const processingIsStale = status?.state === 'PROCESSING'
        && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 2 * 60 * 60 * 1000);
      if (!status || status.state === 'QUEUED' || processingIsStale) tasks.push(task);
    }
    response.json({ ok: true, tasks: tasks.slice(0, 20) });
  }));

  app.get('/api/worker/actions', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const objects = await listPrefix(s3, bucket, '.actions/');
    const actions = [];
    for (const object of objects) {
      const action = await objectJson(s3, bucket, object.Key);
      if (actionIsAvailable(action)) actions.push(action);
    }
    actions.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    response.json({ ok: true, actions: actions.slice(0, 20) });
  }));

  app.post('/api/worker/actions/:actionId/claim', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const actionId = safeIdentifier(request.params.actionId, 'actionId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const action = await objectJson(s3, bucket, actionKey(jobId, actionId));
    if (action.actionId !== actionId || action.jobId !== jobId || !actionIsAvailable(action)) {
      throw new HttpError(409, 'Действие уже выполняется или завершено');
    }
    action.state = 'PROCESSING';
    action.updatedAt = new Date().toISOString();
    await putJson(s3, bucket, actionKey(jobId, actionId), action);
    response.json({ ok: true, action });
  }));

  app.post('/api/worker/actions/:actionId/complete', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const actionId = safeIdentifier(request.params.actionId, 'actionId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const action = await objectJson(s3, bucket, actionKey(jobId, actionId));
    const state = String(request.body?.state ?? '').toUpperCase();
    if (!ACTION_STATES.has(state) || !['COMPLETE', 'FAILED'].includes(state)) {
      throw new HttpError(400, 'Некорректный результат действия');
    }
    action.state = state;
    action.detail = shortText(request.body?.detail, 300);
    action.updatedAt = new Date().toISOString();
    action.completedAt = new Date().toISOString();
    await putJson(s3, bucket, actionKey(jobId, actionId), action);
    response.json({ ok: true, action });
  }));

  app.post('/api/worker/tasks/:taskId/claim', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const task = await objectJson(s3, bucket, queueKey(jobId, taskId));
    if (task.taskId !== taskId || task.jobId !== jobId) throw new HttpError(409, 'Задача не совпадает');
    await putJson(s3, bucket, statusKey(jobId, taskId), {
      version: 1,
      jobId,
      taskId,
      state: 'PROCESSING',
      percent: 1,
      stage: 'download',
      detail: 'Локальная машина забирает исходник',
      updatedAt: new Date().toISOString(),
    });
    const downloadUrl = await signUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: task.objectKey }),
      { expiresIn: 60 * 60 },
    );
    response.json({ ok: true, task, downloadUrl });
  }));

  app.post('/api/worker/tasks/:taskId/status', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const state = String(request.body?.state ?? 'PROCESSING').toUpperCase();
    if (!PIPELINE_STATES.has(state)) throw new HttpError(400, 'Некорректное состояние pipeline');
    const percent = Math.max(0, Math.min(100, Number(request.body?.percent) || 0));
    const status = {
      version: 1,
      jobId,
      taskId,
      state,
      percent,
      stage: shortText(request.body?.stage, 80) || 'processing',
      detail: shortText(request.body?.detail, 300) || 'Обработка',
      localJobId: shortText(request.body?.localJobId, 100) || null,
      resultKey: shortText(request.body?.resultKey, 500) || null,
      updatedAt: new Date().toISOString(),
    };
    if (Array.isArray(request.body?.candidates)) {
      status.candidates = request.body.candidates.slice(0, 12).map((candidate) => ({
        candidateId: Number(candidate?.candidate_id) || null,
        title: shortText(candidate?.title, 120),
        sourceStart: Number(candidate?.source_start) || 0,
        sourceEnd: Number(candidate?.source_end) || 0,
        score: Number(candidate?.score) || null,
        reason: shortText(candidate?.selection_reason || candidate?.reason, 300),
      }));
    }
    await putJson(s3, bucket, statusKey(jobId, taskId), status);
    response.json({ ok: true, status });
  }));

  app.post('/api/worker/tasks/:taskId/result-upload', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const resultKey = `.results/${jobId}/${taskId}.mp4`;
    const uploadUrl = await signUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: resultKey, ContentType: 'video/mp4' }),
      { expiresIn: 60 * 60 },
    );
    response.json({ ok: true, resultKey, uploadUrl });
  }));

  app.delete('/api/uploads/:uploadId', asyncRoute(async (request, response) => {
    const { session } = assertSession(request);
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: session.key,
      UploadId: session.multipartUploadId,
    }));
    response.json({ ok: true });
  }));

  app.get('/api/files', asyncRoute(async (request, response) => {
    const job = jobFromRequest(request);
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${job.jobId}/`,
      MaxKeys: 100,
    }));
    response.json({
      uploadDir: 'Timeweb Cloud S3',
      files: (listed.Contents ?? [])
        .map((object) => ({
          name: object.Key.split('/').pop().replace(/^\d+-[a-f0-9]+-/, ''),
          size: object.Size,
          modifiedAt: object.LastModified.toISOString(),
        }))
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    });
  }));

  app.post('/telegram/webhook', asyncRoute(async (request, response) => {
    const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET ?? '');
    const suppliedSecret = request.headers['x-telegram-bot-api-secret-token'] ?? '';
    if (!expectedSecret || suppliedSecret !== expectedSecret) {
      throw new HttpError(401, 'Неверный секрет webhook');
    }
    const message = request.body?.message || request.body?.edited_message;
    const command = telegramCommand(message);
    if (message?.chat?.id && ['/start', '/upload'].includes(command)) {
      await sendUploadButton(
        env,
        message,
        command === '/start'
          ? 'Привет! Здесь можно безопасно передать видео, аудио, изображения и архивы.'
          : 'Откройте защищённую страницу и выберите один или несколько файлов.',
      );
      response.json({ ok: true, handled: true });
      return;
    }
    const media = telegramMedia(message);
    if (!message?.chat?.id || !media?.file_size) {
      response.json({ ok: true, handled: false });
      return;
    }
    const directLimit = integer(env.DIRECT_FILE_LIMIT_BYTES, DEFAULT_DIRECT_LIMIT);
    if (Number(media.file_size) <= directLimit) {
      response.json({ ok: true, handled: false });
      return;
    }

    await sendUploadButton(
      env,
      message,
      `Файл больше лимита прямой отправки (${formatBytes(directLimit)}). Загрузите его через сайт.`,
    );
    response.json({ ok: true, handled: true });
  }));

  app.post('/api/admin/configure-cors', asyncRoute(async (request, response) => {
    const supplied = request.headers['x-admin-secret'] ?? '';
    if (!env.ADMIN_SECRET || supplied !== env.ADMIN_SECRET) throw new HttpError(401, 'Доступ запрещён');
    await configureBucketCors(s3, bucket, env);
    response.json({ ok: true });
  }));

  app.post('/api/admin/cleanup', asyncRoute(async (request, response) => {
    const supplied = request.headers['x-admin-secret'] ?? '';
    if (!env.ADMIN_SECRET || supplied !== env.ADMIN_SECRET) throw new HttpError(401, 'Доступ запрещён');
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const retentionHours = integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS);
    response.json({ ok: true, retentionHours, ...(await cleanupExpiredObjects(s3, bucket, retentionHours)) });
  }));

  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    maxAge: env.NODE_ENV === 'production' ? '1h' : 0,
  }));

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (!(error instanceof HttpError)) console.error(error);
    const status = error instanceof HttpError ? error.status : 500;
    response.status(status).json({
      error: status === 500 ? 'Внутренняя ошибка сервера' : error.message,
    });
  });

  return app;
}

export { signToken, verifyToken };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = integer(process.env.PORT, 3000);
  const env = process.env;
  const s3 = createS3(env);
  const app = createApp({ env, s3 });
  configureBucketCors(s3, env.S3_BUCKET, env)
    .then(() => console.log('Storage CORS synchronized'))
    .catch((error) => console.error('Storage CORS sync failed', error));
  const cleanup = () => {
    if (!env.S3_BUCKET) return;
    cleanupExpiredObjects(
      s3,
      env.S3_BUCKET,
      integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
    ).then(({ deleted, aborted }) => {
      if (deleted || aborted) console.log(`Storage cleanup: deleted=${deleted}, aborted=${aborted}`);
    }).catch((error) => console.error('Storage cleanup failed', error));
  };
  cleanup();
  const timer = setInterval(cleanup, 60 * 60 * 1000);
  timer.unref();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Timeweb upload API listening on 0.0.0.0:${port}`);
  });
}
