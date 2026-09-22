import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  PutBucketCorsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import express from 'express';
import { normalizeSmartProposal, confirmedSmartEditAction, requireSmartBridge } from './smart-edit.js';
import {
  AccountError,
  AccountRateLimitError,
  AccountService,
  MemoryAccountStore,
  SESSION_COOKIE_NAME,
  createPostgresAccountStore,
  hashAuditValue,
  parseCookies,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from './accounts.js';
import { validateAccountEnvironment } from './postgres.js';
import { checkResultAvailability, createProjectStatusReader } from './project-status.js';
import { PipelineError, createPipelineRuntime, createTaskLock, publicPipelineStatus } from './pipeline-runtime.js';
import { StorageCleanupReportError, reportStorageRetention } from './storage-cleanup.js';
import {
  PipelineOwnerError,
  assertPipelineOwnerAccess,
  normalizePipelineOwner,
  ownerFromJobAccess,
  ownerFromTask,
} from './pipeline-owner.js';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const DEFAULT_DIRECT_LIMIT = 20 * 1024 * 1024;
const DEFAULT_LINK_LIFETIME_HOURS = 24;
const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_AUTH_REGISTER_LIMIT = 5;
const DEFAULT_AUTH_REGISTER_WINDOW_SECONDS = 60 * 60;
const DEFAULT_AUTH_LOGIN_LIMIT = 10;
const DEFAULT_AUTH_LOGIN_IP_LIMIT = 30;
const DEFAULT_AUTH_LOGIN_WINDOW_SECONDS = 15 * 60;
const DEFAULT_ACCOUNT_PROJECT_LIMIT = 20;
const DEFAULT_ACCOUNT_PROJECT_WINDOW_SECONDS = 60 * 60;
const DEFAULT_ACCOUNT_PROJECT_QUOTA = 200;
const DEFAULT_RATE_LIMIT_RETENTION_HOURS = 7 * 24;
const MINIMUM_BRIDGE_VERSION = 3;
const PROCESSABLE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);
const OUTPUT_ASPECT_RATIOS = new Set(['9:16', '1:1', '16:9']);
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
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
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
  return [env.ALLOWED_ORIGIN, env.ACCOUNT_ALLOWED_ORIGIN]
    .filter(Boolean)
    .join(',')
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
  const aspectRatio = Object.hasOwn(input, 'aspectRatio') ? input.aspectRatio : '9:16';
  if (!OUTPUT_ASPECT_RATIOS.has(aspectRatio)) {
    throw new HttpError(400, 'Выберите формат видео: 9:16, 1:1 или 16:9');
  }
  if (Object.hasOwn(input, 'smartEditEnabled') && typeof input.smartEditEnabled !== 'boolean') {
    throw new HttpError(400, 'Некорректная настройка умного монтажа');
  }
  return {
    mode: input.mode === 'long' ? 'long' : 'short',
    aspectRatio,
    faceTrackingEnabled: input.faceTrackingEnabled !== false,
    subtitlesEnabled: input.subtitlesEnabled !== false,
    hookEnabled: input.hookEnabled !== false,
    smartEditEnabled: input.mode !== 'long' && input.smartEditEnabled === true,
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

// Compatibility gate for new claims, not an authentication substitute.
function requireBridgeVersion(request) {
  const version = request.body?.bridgeVersion;
  if (!Number.isInteger(version) || version < MINIMUM_BRIDGE_VERSION) {
    throw new HttpError(426, 'Обновите MontageAI Cloud Bridge до версии 3 или новее для получения новых задач', 'WORKER_UPGRADE_REQUIRED');
  }
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
  return action?.state === 'PENDING';
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

async function putProjectBrief(s3, bucket, brief) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `.briefs/${safeIdentifier(brief.jobId, 'jobId')}.json`,
    Body: JSON.stringify(brief, null, 2),
    ContentType: 'application/json; charset=utf-8',
    Metadata: {
      jobid: brief.jobId,
      source: brief.source === 'account' ? 'account' : 'website',
    },
  }));
}

async function removeProjectBrief(s3, bucket, jobId) {
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: `.briefs/${safeIdentifier(jobId, 'jobId')}.json`,
    }));
  } catch (error) {
    const code = String(error?.name ?? error?.code ?? 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    console.error(`Project brief rollback failed (${code || 'UNKNOWN'})`);
  }
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

function createAccountJobAccess(project, env, now = Math.floor(Date.now() / 1000)) {
  const lifetimeHours = integer(env.UPLOAD_LINK_LIFETIME_HOURS, DEFAULT_LINK_LIFETIME_HOURS);
  const job = {
    kind: 'job',
    jobId: project.jobId,
    userId: project.userId,
    source: 'account',
    processing: processingOptions(project.processing),
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

function publicProject(project) {
  return {
    id: project.id,
    jobId: project.jobId,
    title: project.title,
    source: project.source,
    processing: processingOptions(project.processing),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function projectTitle(value) {
  return shortText(value, 120) || 'Новый проект';
}

function accountCookieToken(request) {
  return parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME) ?? '';
}

function accountRequestMetadata(request, env) {
  return {
    userAgent: request.headers['user-agent'] ?? '',
    ipHash: hashAuditValue(
      request.ip || request.socket.remoteAddress || '',
      env.SESSION_AUDIT_SECRET || env.TOKEN_SECRET,
    ),
  };
}

function projectBrief(access, input, options = {}) {
  const processing = processingOptions(input?.processing ?? options.processing);
  return {
    version: 1,
    jobId: access.job.jobId,
    source: options.source === 'account' ? 'account' : 'website',
    accountUserId: options.accountUserId ?? null,
    title: projectTitle(input?.title ?? input?.projectTitle),
    customerName: shortText(input?.customerName, 80) || options.defaultCustomerName || null,
    contact: shortText(input?.contact, 120) || null,
    projectType: shortText(input?.projectType, 40) || 'other',
    comment: shortText(input?.comment, 1000),
    processing,
    quickStart: input?.quickStart === true,
    createdAt: options.createdAt ?? new Date().toISOString(),
    expiresAt: access.expiresAt,
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
  const projectStatusReader = createProjectStatusReader({
    s3, bucket, retentionHours: integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
  });
  const configuredAccountStore = String(env.ACCOUNT_STORE ?? '').trim().toLowerCase();
  if (!Object.hasOwn(options, 'accountStore')) validateAccountEnvironment(env);
  const accountStore = Object.hasOwn(options, 'accountStore')
    ? options.accountStore
    : configuredAccountStore === 'memory'
      ? new MemoryAccountStore({ maxRateLimitEntries: integer(env.MEMORY_RATE_LIMIT_MAX_KEYS, 10_000) })
      : createPostgresAccountStore(env);
  const accountService = options.accountService ?? (accountStore ? new AccountService({
    store: accountStore,
    passwordPepper: env.AUTH_PASSWORD_PEPPER,
    sessionLifetimeSeconds: integer(env.SESSION_LIFETIME_HOURS, 30 * 24) * 60 * 60,
    ...(options.now ? { now: options.now } : {}),
  }) : null);
  const pipelineRuntime = createPipelineRuntime({
    s3, bucket,
    withLock: options.pipelineLock ?? createTaskLock(accountStore?.pool, { allowMemory: env.NODE_ENV !== 'production' }),
    retentionHours: integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
    ...(options.pipelineNow ? { now: options.pipelineNow } : {}),
  });
  const app = express();
  const jobRequests = new Map();
  const accountRateLimits = {
    register: {
      limit: integer(env.AUTH_REGISTER_RATE_LIMIT, DEFAULT_AUTH_REGISTER_LIMIT),
      windowSeconds: integer(env.AUTH_REGISTER_RATE_WINDOW_SECONDS, DEFAULT_AUTH_REGISTER_WINDOW_SECONDS),
    },
    login: {
      limit: integer(env.AUTH_LOGIN_RATE_LIMIT, DEFAULT_AUTH_LOGIN_LIMIT),
      windowSeconds: integer(env.AUTH_LOGIN_RATE_WINDOW_SECONDS, DEFAULT_AUTH_LOGIN_WINDOW_SECONDS),
    },
    loginIp: {
      limit: integer(env.AUTH_LOGIN_IP_RATE_LIMIT, DEFAULT_AUTH_LOGIN_IP_LIMIT),
      windowSeconds: integer(env.AUTH_LOGIN_RATE_WINDOW_SECONDS, DEFAULT_AUTH_LOGIN_WINDOW_SECONDS),
    },
    project: {
      limit: integer(env.ACCOUNT_PROJECT_RATE_LIMIT, DEFAULT_ACCOUNT_PROJECT_LIMIT),
      windowSeconds: integer(env.ACCOUNT_PROJECT_RATE_WINDOW_SECONDS, DEFAULT_ACCOUNT_PROJECT_WINDOW_SECONDS),
    },
  };
  const accountProjectQuota = integer(env.ACCOUNT_PROJECT_QUOTA, DEFAULT_ACCOUNT_PROJECT_QUOTA);
  const rateLimitRetentionSeconds = integer(
    env.RATE_LIMIT_RETENTION_HOURS,
    DEFAULT_RATE_LIMIT_RETENTION_HOURS,
  ) * 60 * 60;

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS ? integer(env.TRUST_PROXY_HOPS, 1) : false);
  app.use(express.json({ limit: '64kb' }));
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (env.NODE_ENV === 'production') {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
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
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
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

  const jobFromRequest = async (request) => {
    const job = verifyToken(bearer(request), env.TOKEN_SECRET, 'job');
    const requestOwner = ownerFromJobAccess(job);
    if (typeof accountStore?.findProjectByJobId === 'function') {
      const project = await accountStore.findProjectByJobId(job.jobId);
      if (project && (requestOwner.kind !== 'account' || requestOwner.id !== project.userId)) {
        throw new PipelineOwnerError();
      }
      if (!project && requestOwner.kind === 'account') throw new PipelineOwnerError();
    } else if (requestOwner.kind === 'account') {
      throw new PipelineOwnerError();
    }
    return job;
  };
  const sessionFromRequest = (request) => verifyToken(
    request.headers['x-upload-session'] ?? '',
    env.TOKEN_SECRET,
    'session',
  );
  const assertSession = async (request) => {
    const job = await jobFromRequest(request);
    const session = sessionFromRequest(request);
    if (session.jobId !== job.jobId || session.sessionId !== request.params.uploadId) {
      throw new HttpError(403, 'Сессия не принадлежит этой ссылке');
    }
    // Validate before signing part URLs, completing or aborting storage work.
    const sessionOwner = normalizePipelineOwner(
      session.owner === undefined ? ownerFromJobAccess(job) : session.owner,
      job.jobId,
    );
    assertPipelineOwnerAccess(ownerFromJobAccess(job), sessionOwner, job.jobId);
    return { job, session };
  };

  const requireAccount = async (request) => {
    if (!accountService) throw new HttpError(503, 'Личные кабинеты ещё не подключены');
    const authenticated = await accountService.authenticate(accountCookieToken(request));
    if (!authenticated) throw new HttpError(401, 'Войдите в личный кабинет');
    return authenticated;
  };

  const accountReadiness = async () => {
    if (!accountService || !accountStore) return { ready: false, backend: null, schemaVersion: null };
    if (typeof accountStore.readiness !== 'function') {
      return { ready: true, backend: 'injected', schemaVersion: null };
    }
    try {
      return await accountStore.readiness();
    } catch {
      return { ready: false, backend: 'postgres', schemaVersion: null };
    }
  };

  const enforceAccountRateLimit = async (scope, subjects, settings) => {
    if (!accountStore?.consumeRateLimit) return;
    const uniqueSubjects = [...new Set(subjects.filter(Boolean))];
    for (const subjectHash of uniqueSubjects) {
      const result = await accountStore.consumeRateLimit({
        scope,
        subjectHash,
        limit: settings.limit,
        windowSeconds: settings.windowSeconds,
        retentionSeconds: rateLimitRetentionSeconds,
        now: options.now ? options.now() : new Date(),
      });
      if (!result.allowed) {
        throw new AccountRateLimitError('Слишком много попыток. Попробуйте позже', result.retryAfterSeconds);
      }
    }
  };

  const rateLimitSubjects = (request) => {
    const secret = env.SESSION_AUDIT_SECRET || env.TOKEN_SECRET;
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const identity = String(request.body?.email ?? '').trim().toLowerCase().slice(0, 254);
    return {
      ip: hashAuditValue(`ip:${ip}`, secret),
      identity: identity ? hashAuditValue(`email:${identity}`, secret) : null,
      ipIdentity: identity ? hashAuditValue(`ip-email:${ip}:${identity}`, secret) : null,
    };
  };

  const enforceProjectCreationLimit = async (userId) => {
    await enforceAccountRateLimit(
      'account_project_create',
      [hashAuditValue(`user:${userId}`, env.SESSION_AUDIT_SECRET || env.TOKEN_SECRET)],
      accountRateLimits.project,
    );
  };

  const findOwnedProject = async (identifier, userId) => {
    const project = await accountStore.findProjectForUser(identifier, userId);
    if (project || !accountStore.findProjectByJobIdForUser) return project;
    return accountStore.findProjectByJobIdForUser(identifier, userId);
  };

  const assertAccountMutationOrigin = (request) => {
    const origin = request.headers.origin?.replace(/\/$/, '');
    const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (!origin) {
      if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
        throw new HttpError(403, 'Запрос с этого сайта запрещён');
      }
      return;
    }
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === request.headers.host;
    } catch {
      sameOrigin = false;
    }
    const accountOrigins = String(env.ACCOUNT_ALLOWED_ORIGIN ?? '')
      .split(',')
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean);
    if (!sameOrigin && !accountOrigins.includes(origin)) {
      throw new HttpError(403, 'Личный кабинет доступен только с доверенного сайта');
    }
  };

  const setAccountSession = (response, result) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', serializeSessionCookie(result.token, result.expiresAt));
  };

  app.get('/api/auth/capabilities', asyncRoute(async (request, response) => {
    const readiness = await accountReadiness();
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      ok: true,
      configured: Boolean(accountService),
      enabled: Boolean(accountService) && readiness.ready,
      authEnabled: Boolean(accountService) && readiness.ready,
      registrationEnabled: Boolean(accountService) && readiness.ready,
      sameOriginCookie: true,
    });
  }));

  app.post('/api/auth/register', asyncRoute(async (request, response) => {
    if (!accountService) throw new HttpError(503, 'Личные кабинеты ещё не подключены');
    assertAccountMutationOrigin(request);
    const subjects = rateLimitSubjects(request);
    await enforceAccountRateLimit('auth_register_ip', [subjects.ip], accountRateLimits.register);
    await enforceAccountRateLimit('auth_register_identity', [subjects.identity], accountRateLimits.register);
    const result = await accountService.register(request.body, accountRequestMetadata(request, env));
    setAccountSession(response, result);
    response.status(201).json({ ok: true, user: result.user });
  }));

  app.post('/api/auth/login', asyncRoute(async (request, response) => {
    if (!accountService) throw new HttpError(503, 'Личные кабинеты ещё не подключены');
    assertAccountMutationOrigin(request);
    const subjects = rateLimitSubjects(request);
    await enforceAccountRateLimit('auth_login_ip', [subjects.ip], accountRateLimits.loginIp);
    await enforceAccountRateLimit('auth_login_ip_identity', [subjects.ipIdentity], accountRateLimits.login);
    const result = await accountService.login(request.body, accountRequestMetadata(request, env));
    setAccountSession(response, result);
    response.json({ ok: true, user: result.user });
  }));

  app.get(['/api/me', '/api/auth/me'], asyncRoute(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const { user } = await requireAccount(request);
    response.json({ ok: true, user });
  }));

  app.post('/api/auth/logout', asyncRoute(async (request, response) => {
    if (!accountService) throw new HttpError(503, 'Личные кабинеты ещё не подключены');
    assertAccountMutationOrigin(request);
    await accountService.logout(accountCookieToken(request));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Set-Cookie', serializeExpiredSessionCookie());
    response.json({ ok: true });
  }));

  app.get('/api/projects', asyncRoute(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const { user } = await requireAccount(request);
    const projects = await accountStore.listProjects(user.id);
    response.json({ ok: true, projects: await projectStatusReader.enrich(projects.map(publicProject)) });
  }));

  app.post('/api/projects', asyncRoute(async (request, response) => {
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    assertAccountMutationOrigin(request);
    const { user } = await requireAccount(request);
    const processing = processingOptions(request.body?.processing);
    await enforceProjectCreationLimit(user.id);
    const now = new Date();
    const pendingProject = {
      id: crypto.randomUUID(),
      userId: user.id,
      jobId: `web-${crypto.randomUUID()}`,
      title: projectTitle(request.body?.title),
      source: 'account',
      processing,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const access = createAccountJobAccess(pendingProject, env, Math.floor(now.getTime() / 1000));
    const brief = projectBrief(access, request.body, {
      source: 'account',
      accountUserId: user.id,
      defaultCustomerName: user.displayName,
      processing: pendingProject.processing,
      createdAt: now.toISOString(),
    });
    await putProjectBrief(s3, bucket, brief);
    let project;
    try {
      project = await accountStore.createProject(pendingProject, { quota: accountProjectQuota });
    } catch (error) {
      await removeProjectBrief(s3, bucket, pendingProject.jobId);
      throw error;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.status(201).json({
      ok: true,
      project: publicProject(project),
      jobToken: access.token,
      token: access.token,
      jobTokenExpiresAt: access.expiresAt,
    });
  }));

  app.post('/api/projects/claim', asyncRoute(async (request, response) => {
    assertAccountMutationOrigin(request);
    const { user } = await requireAccount(request);
    await enforceProjectCreationLimit(user.id);
    const legacyToken = String(request.body?.jobToken ?? request.body?.legacyToken ?? '');
    const legacyJob = verifyToken(legacyToken, env.TOKEN_SECRET, 'job');
    const jobId = safeIdentifier(legacyJob.jobId, 'jobId');
    const now = new Date();
    const project = await accountStore.claimProject({
      id: crypto.randomUUID(),
      userId: user.id,
      jobId,
      title: projectTitle(request.body?.title),
      source: 'legacy_claim',
      processing: processingOptions(legacyJob.processing),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }, { quota: accountProjectQuota });
    const access = createAccountJobAccess(project, env, Math.floor(now.getTime() / 1000));
    response.setHeader('Cache-Control', 'no-store');
    response.status(project.claimCreated ? 201 : 200).json({
      ok: true,
      project: publicProject(project),
      jobToken: access.token,
      token: access.token,
      jobTokenExpiresAt: access.expiresAt,
    });
  }));

  app.get('/api/projects/:projectId', asyncRoute(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const { user } = await requireAccount(request);
    const projectId = safeIdentifier(request.params.projectId, 'projectId');
    const project = await findOwnedProject(projectId, user.id);
    if (!project) throw new HttpError(404, 'Проект не найден');
    const [withStatus] = await projectStatusReader.enrich([publicProject(project)], { all: true });
    response.json({ ok: true, project: withStatus });
  }));

  app.post('/api/projects/:projectId/access', asyncRoute(async (request, response) => {
    assertAccountMutationOrigin(request);
    const { user } = await requireAccount(request);
    const projectId = safeIdentifier(request.params.projectId, 'projectId');
    const project = await findOwnedProject(projectId, user.id);
    if (!project) throw new HttpError(404, 'Проект не найден');
    const access = createAccountJobAccess(project, env);
    const [withStatus] = await projectStatusReader.enrich([publicProject(project)], { all: true });
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      ok: true,
      project: withStatus,
      jobToken: access.token,
      token: access.token,
      jobTokenExpiresAt: access.expiresAt,
    });
  }));

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
    const processing = processingOptions(input.processing);

    const now = Date.now();
    const requester = request.ip || request.socket.remoteAddress || 'unknown';
    const recent = (jobRequests.get(requester) ?? []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= 10) throw new HttpError(429, 'Слишком много заявок. Попробуйте через час');
    recent.push(now);
    jobRequests.set(requester, recent);

    const authenticated = accountService
      ? await accountService.authenticate(accountCookieToken(request))
      : null;
    let accountProject = null;
    let pendingAccountProject = null;
    let access;
    if (authenticated) {
      assertAccountMutationOrigin(request);
      await enforceProjectCreationLimit(authenticated.user.id);
      const createdAt = new Date(now).toISOString();
      pendingAccountProject = {
        id: crypto.randomUUID(),
        userId: authenticated.user.id,
        jobId: `web-${crypto.randomUUID()}`,
        title: projectTitle(input.title || input.projectTitle),
        source: 'account',
        processing,
        createdAt,
        updatedAt: createdAt,
      };
      access = createAccountJobAccess(pendingAccountProject, env, Math.floor(now / 1000));
    } else {
      access = createWebUploadAccess(env, Math.floor(now / 1000), processing);
    }
    const brief = projectBrief(access, {
      ...input,
      customerName,
      contact,
      projectType,
      comment,
      processing,
      quickStart,
    }, {
      source: pendingAccountProject ? 'account' : 'website',
      accountUserId: pendingAccountProject?.userId ?? null,
      defaultCustomerName: authenticated?.user.displayName,
      processing,
      createdAt: new Date(now).toISOString(),
    });
    await putProjectBrief(s3, bucket, brief);
    if (pendingAccountProject) {
      try {
        accountProject = await accountStore.createProject(
          pendingAccountProject,
          { quota: accountProjectQuota },
        );
      } catch (error) {
        await removeProjectBrief(s3, bucket, pendingAccountProject.jobId);
        throw error;
      }
    }
    response.status(201).json({
      ok: true,
      token: access.token,
      jobId: access.job.jobId,
      lifetimeHours: access.lifetimeHours,
      expiresAt: access.expiresAt,
      ...(accountProject ? { project: publicProject(accountProject) } : {}),
    });
  }));

  app.get('/api/health', asyncRoute(async (request, response) => {
    const readiness = await accountReadiness();
    const ready = !accountService || readiness.ready;
    response.status(ready ? 200 : 503).json({
      ok: ready,
      cloud: true,
      release: 'studio-20260922-smart-edit-v1',
      minimumBridgeVersion: MINIMUM_BRIDGE_VERSION,
      smartEditProposalsVersion: 1,
      ownerIsolationVersion: 1,
      recoveryAvailable: Boolean(accountStore?.pool) || env.NODE_ENV !== 'production',
      provider: 'timeweb-s3',
      protected: true,
      accountsConfigured: Boolean(accountService),
      accountsEnabled: Boolean(accountService) && readiness.ready,
      accountsReady: readiness.ready,
      accountBackend: readiness.backend,
      accountSchemaVersion: readiness.schemaVersion,
      maxFileSize: integer(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE),
      chunkSize: Math.max(integer(env.CHUNK_SIZE_BYTES, DEFAULT_CHUNK_SIZE), 5 * 1024 * 1024),
      retentionHours: integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
      worker: await pipelineRuntime.worker(),
    });
  }));

  app.get('/api/session', asyncRoute(async (request, response) => {
    const job = await jobFromRequest(request);
    response.json({
      ok: true,
      jobId: job.jobId,
      source: job.source || 'telegram',
      processing: processingOptions(job.processing),
      expiresAt: new Date(job.exp * 1000).toISOString(),
    });
  }));

  app.post('/api/uploads', asyncRoute(async (request, response) => {
    const job = await jobFromRequest(request);
    const owner = ownerFromJobAccess(job);
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
        const resumedOwner = normalizePipelineOwner(
          resumed.owner === undefined ? owner : resumed.owner,
          job.jobId,
        );
        assertPipelineOwnerAccess(owner, resumedOwner, job.jobId);
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
      owner,
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
    const { session } = await assertSession(request);
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
    const { job, session } = await assertSession(request);
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
    const stored = await s3.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: session.key,
    }));
    const storedSize = Number(stored.ContentLength);
    if (!Number.isSafeInteger(storedSize) || storedSize !== session.size) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: session.key }));
      throw new HttpError(409, 'Размер загруженного файла не совпадает с ожидаемым');
    }

    let pipelineTask = null;
    if (isProcessableVideoFile(session.name)) {
      pipelineTask = {
        version: 1,
        taskId: session.sessionId,
        jobId: job.jobId,
        owner: normalizePipelineOwner(session.owner === undefined ? ownerFromJobAccess(job) : session.owner, job.jobId),
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
    response.setHeader('Cache-Control', 'no-store');
    const job = await jobFromRequest(request);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const objects = await listPrefix(s3, bucket, `.status/${job.jobId}/`);
    const actionObjects = await listPrefix(s3, bucket, `.actions/${job.jobId}/`);
    const actions = [];
    for (const object of actionObjects) {
      const action = await objectJson(s3, bucket, object.Key);
      if (action.jobId === job.jobId) actions.push(action);
    }
    const tasks = [];
    const resultCheckSignal = AbortSignal.timeout(8_000);
    for (const object of objects) {
      const status = publicPipelineStatus(await objectJson(s3, bucket, object.Key));
      if (status.jobId !== job.jobId) continue;
      // URLs are generated only from a verified object, never from stored JSON.
      delete status.previewUrl;
      delete status.downloadUrl;
      if (['READY_FOR_REVIEW', 'APPROVED'].includes(status.state)) {
        const availability = await checkResultAvailability({
          s3, bucket, status, jobId: job.jobId, statusModifiedAt: object.LastModified,
          retentionHours: integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
          signal: resultCheckSignal,
        });
        status.resultAvailability = availability.state;
        status.resultExpiresAt = availability.expiresAt;
        status.resultUnavailableReason = availability.reason;
      }
      if (['READY_FOR_REVIEW', 'APPROVED'].includes(status.state)
          && status.resultAvailability === 'AVAILABLE') {
        status.previewUrl = await signUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket, Key: status.resultKey }),
          { expiresIn: 15 * 60 },
        );
        const downloadName = `MontageAI_${safeIdentifier(status.taskId, 'taskId')}.mp4`;
        status.downloadUrl = await signUrl(
          s3,
          new GetObjectCommand({
            Bucket: bucket,
            Key: status.resultKey,
            ResponseContentDisposition: `attachment; filename="${downloadName}"`,
          }),
          { expiresIn: 15 * 60 },
        );
      }
      status.action = actions
        .filter((action) => action.taskId === status.taskId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
      try { Object.assign(status, await pipelineRuntime.retryInfo(job.jobId, status.taskId, status)); }
      catch { Object.assign(status, { retryable: false, retryReason: 'SOURCE_UNKNOWN' }); }
      tasks.push(status);
    }
    tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    response.json({ ok: true, tasks, worker: await pipelineRuntime.worker() });
  }));

  app.post('/api/pipeline/:taskId/retry', asyncRoute(async (request, response) => {
    const job = await jobFromRequest(request);
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    let sourceTask;
    try {
      sourceTask = await pipelineRuntime.task(job.jobId, taskId);
    } catch (error) {
      if (error instanceof PipelineError && error.status === 404) throw new PipelineOwnerError();
      throw error;
    }
    assertPipelineOwnerAccess(
      ownerFromJobAccess(job),
      ownerFromTask(sourceTask, job.jobId, taskId),
      job.jobId,
    );
    response.json(await pipelineRuntime.retry(job.jobId, taskId));
  }));

  app.post('/api/worker/heartbeat', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    response.json(await pipelineRuntime.heartbeat(request.body ?? {}));
  }));

  app.post('/api/pipeline/:taskId/actions', asyncRoute(async (request, response) => {
    const job = await jobFromRequest(request);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const createdAction = await pipelineRuntime.withTask(job.jobId, taskId, async () => {
    const status = await objectJson(s3, bucket, statusKey(job.jobId, taskId));
    if (status.jobId !== job.jobId || status.taskId !== taskId) {
      throw new HttpError(409, 'Ролик не принадлежит этой заявке');
    }
    let sourceTask;
    try {
      sourceTask = await objectJson(s3, bucket, queueKey(job.jobId, taskId));
    } catch (error) {
      if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
        throw new PipelineOwnerError();
      }
      throw error;
    }
    const owner = ownerFromTask(sourceTask, job.jobId, taskId);
    assertPipelineOwnerAccess(ownerFromJobAccess(job), owner, job.jobId);
    const kind = String(request.body?.kind ?? '').toUpperCase();
    if (!['REVISION', 'APPROVE'].includes(kind)) throw new HttpError(400, 'Неизвестное действие');
    const smartAction = confirmedSmartEditAction(status, { ...request.body, kind });
    if (kind === 'REVISION' && !['READY_FOR_REVIEW', 'APPROVED'].includes(status.state)) {
      throw new HttpError(409, 'Ролик пока не готов к правкам');
    }
    if (kind === 'APPROVE' && status.state !== 'READY_FOR_REVIEW') {
      throw new HttpError(409, 'Подтвердить можно только готовый preview');
    }
    if (kind === 'APPROVE' && request.body?.confirmation !== 'APPROVE') {
      throw new HttpError(400, 'Нужно явно подтвердить выбранный preview');
    }
    const availability = await checkResultAvailability({
      s3,
      bucket,
      status,
      jobId: job.jobId,
      retentionHours: integer(env.RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
    });
    if (availability.state !== 'AVAILABLE') {
      if (availability.state === 'EXPIRED') {
        throw new HttpError(410, 'Срок хранения preview истёк');
      }
      if (availability.state === 'UNKNOWN') {
        throw new HttpError(503, 'Не удалось проверить доступность preview');
      }
      throw new HttpError(409, 'Файл preview недоступен');
    }
    const existingObjects = await listPrefix(s3, bucket, `.actions/${job.jobId}/`);
    for (const object of existingObjects) {
      const existing = await objectJson(s3, bucket, object.Key);
      if (existing.taskId === taskId && ['PENDING', 'PROCESSING'].includes(existing.state)) {
        throw new HttpError(409, 'Предыдущее действие ещё выполняется');
      }
    }
    const requestText = smartAction.smartEditProposalId
      ? 'Применить показанный план умного монтажа' : shortText(request.body?.requestText, 500);
    if (kind === 'REVISION' && requestText.length < 2) {
      throw new HttpError(400, 'Опиши, что изменить в ролике');
    }
    const actionId = crypto.randomUUID();
    const action = {
      version: 1,
      actionId,
      jobId: job.jobId,
      taskId,
      owner,
      localJobId: status.localJobId,
      resultKey: status.resultKey || null,
      resultAttemptId: status.resultAttemptId || null,
      kind,
      previousState: status.state,
      ...smartAction,
      requestText: kind === 'APPROVE' ? 'Всё хорошо, подтверждаю этот preview' : requestText,
      state: 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!action.localJobId) throw new HttpError(409, 'Локальный job ещё не привязан');
    await putJson(s3, bucket, actionKey(job.jobId, actionId), action);
    return action;
    });
    response.status(202).json({ ok: true, action: createdAction });
  }));

  app.get('/api/worker/tasks', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const failedTaskId = request.query.failedTaskId
      ? safeIdentifier(request.query.failedTaskId, 'taskId')
      : null;
    const objects = await listPrefix(s3, bucket, '.queue/');
    const tasks = [];
    for (const object of objects) {
      const task = await objectJson(s3, bucket, object.Key);
      if (failedTaskId && task.taskId !== failedTaskId) continue;
      let status = null;
      try {
        status = await objectJson(s3, bucket, statusKey(task.jobId, task.taskId));
      } catch (error) {
        if (error?.name !== 'NoSuchKey') throw error;
      }
      if (failedTaskId) {
        if (status?.state === 'FAILED') tasks.push(task);
      } else if (!status || status.state === 'QUEUED' || pipelineRuntime.recoverable(status)) {
        tasks.push(task);
      }
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
    requireBridgeVersion(request);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const actionId = safeIdentifier(request.params.actionId, 'actionId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const pending = await objectJson(s3, bucket, actionKey(jobId, actionId));
    requireSmartBridge(request.body?.bridgeVersion, Boolean(pending.smartEditProposalId));
    const workerId = safeIdentifier(request.body?.workerId, 'workerId');
    const action = await pipelineRuntime.withTask(jobId, pending.taskId, async () => {
      const current = await pipelineRuntime.read(actionKey(jobId, actionId));
      if (current.state === 'PROCESSING' && current.workerId === workerId) return current;
      if (current.actionId !== actionId || current.jobId !== jobId || !actionIsAvailable(current)) {
        throw new HttpError(409, 'Действие уже выполняется или завершено');
      }
      current.state = 'PROCESSING';
      current.workerId = workerId;
      current.updatedAt = new Date().toISOString();
      await pipelineRuntime.write(actionKey(jobId, actionId), current);
      const status = await pipelineRuntime.status(jobId, current.taskId);
      await pipelineRuntime.write(statusKey(jobId, current.taskId), {
        ...status, state: 'PROCESSING', operationType: current.kind, activeActionId: actionId,
        stage: 'action', detail: 'Выполняю правку или подтверждение', updatedAt: current.updatedAt,
      });
      return current;
    });
    response.json({ ok: true, action });
  }));

  app.post('/api/worker/actions/:actionId/complete', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const actionId = safeIdentifier(request.params.actionId, 'actionId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const pending = await objectJson(s3, bucket, actionKey(jobId, actionId));
    const state = String(request.body?.state ?? '').toUpperCase();
    if (!ACTION_STATES.has(state) || !['COMPLETE', 'FAILED'].includes(state)) {
      throw new HttpError(400, 'Некорректный результат действия');
    }
    const workerId = safeIdentifier(request.body?.workerId, 'workerId');
    const action = await pipelineRuntime.withTask(jobId, pending.taskId, async () => {
      const current = await pipelineRuntime.read(actionKey(jobId, actionId));
      if (current.workerId !== workerId) throw new HttpError(409, 'Действие принадлежит другому обработчику');
      if (current.state === state) return current;
      if (current.state !== 'PROCESSING') throw new HttpError(409, 'Действие уже завершено');
      current.state = state;
      current.detail = shortText(request.body?.detail, 300);
      current.updatedAt = new Date().toISOString();
      current.completedAt = current.updatedAt;
      await pipelineRuntime.write(actionKey(jobId, actionId), current);
      const status = await pipelineRuntime.status(jobId, current.taskId);
      if (state === 'FAILED' && status?.state === 'PROCESSING' && status.activeActionId === actionId) {
        await pipelineRuntime.write(statusKey(jobId, current.taskId), { ...status, state: 'FAILED',
          stage: 'action_unconfirmed', detail: 'Результат правки не подтверждён. Требуется проверка; повтор не запускался', updatedAt: current.updatedAt });
      }
      return current;
    });
    response.json({ ok: true, action });
  }));

  app.post('/api/worker/tasks/:taskId/claim', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    requireBridgeVersion(request);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const queued = await pipelineRuntime.task(jobId, taskId);
    requireSmartBridge(request.body?.bridgeVersion, queued.processing?.smartEditEnabled === true);
    const claimed = await pipelineRuntime.claim(jobId, taskId, request.body?.workerId);
    const { task } = claimed;
    const downloadUrl = await signUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: task.objectKey }),
      { expiresIn: 60 * 60 },
    );
    response.json({ ok: true, ...claimed, downloadUrl });
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
    if (Object.hasOwn(request.body ?? {}, 'smartEditProposal')) {
      status.smartEditProposal = normalizeSmartProposal(request.body.smartEditProposal);
    }
    const updated = await pipelineRuntime.update(jobId, taskId, request.body ?? {}, status);
    response.json({ ok: true, status: updated });
  }));

  app.post('/api/worker/tasks/:taskId/result-upload', asyncRoute(async (request, response) => {
    requireWorker(request, env);
    if (!bucket) throw new Error('S3_BUCKET is not configured');
    const taskId = safeIdentifier(request.params.taskId, 'taskId');
    const jobId = safeIdentifier(request.body?.jobId, 'jobId');
    const resultKey = await pipelineRuntime.resultUpload(jobId, taskId, request.body ?? {});
    const uploadUrl = await signUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: resultKey, ContentType: 'video/mp4' }),
      { expiresIn: 60 * 60 },
    );
    response.json({ ok: true, resultKey, uploadUrl });
  }));

  app.delete('/api/uploads/:uploadId', asyncRoute(async (request, response) => {
    const { session } = await assertSession(request);
    await s3.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: session.key,
      UploadId: session.multipartUploadId,
    }));
    response.json({ ok: true });
  }));

  app.get('/api/files', asyncRoute(async (request, response) => {
    const job = await jobFromRequest(request);
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

  const requireAdmin = (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    const expected = Buffer.from(String(env.ADMIN_SECRET ?? ''));
    const supplied = Buffer.from(typeof request.headers['x-admin-secret'] === 'string' ? request.headers['x-admin-secret'] : '');
    if (!expected.length || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      throw new HttpError(401, 'Доступ запрещён');
    }
    next();
  };

  app.get('/api/admin/auth-check', requireAdmin, (request, response) => {
    response.json({ ok: true });
  });

  app.post('/api/admin/configure-cors', requireAdmin, asyncRoute(async (request, response) => {
    await configureBucketCors(s3, bucket, env);
    response.json({ ok: true });
  }));

  app.post('/api/admin/cleanup', requireAdmin, asyncRoute(async (request, response) => {
    try {
      const report = await reportStorageRetention({ s3, bucket, retentionHours: env.RETENTION_HOURS ?? DEFAULT_RETENTION_HOURS });
      response.json({ ok: true, ...report });
    } catch (error) {
      if (error instanceof StorageCleanupReportError) throw new HttpError(503, 'Отчёт хранилища недоступен. Файлы и загрузки не изменены; проверьте доступ к S3 и RETENTION_HOURS (1–8760 часов)');
      throw error;
    }
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
    const publicError = error instanceof HttpError || error instanceof AccountError || error instanceof PipelineError || error instanceof PipelineOwnerError;
    if (!publicError) console.error(error);
    const status = publicError ? error.status : 500;
    if (error instanceof AccountRateLimitError) {
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
    }
    response.status(status).json({
      error: status === 500 ? 'Внутренняя ошибка сервера' : error.message,
      ...(error instanceof AccountError || (error instanceof HttpError && error.code) ? { code: error.code } : {}),
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
  app.listen(port, '0.0.0.0', () => {
    console.log(`Timeweb upload API listening on 0.0.0.0:${port}`);
  });
}
