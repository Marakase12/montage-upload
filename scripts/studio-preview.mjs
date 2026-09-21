#!/usr/bin/env node

import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 3032;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_FIXTURE_FILE_SIZE = 16 * 1024 * 1024;
const FIXTURE_CHUNK_SIZE = 256 * 1024;
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(CURRENT_DIR, '../public');

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

const DEFAULT_FIXTURES = {
  user: {
    id: 'fixture-user-0001',
    email: 'demo@example.test',
    displayName: 'Демо Монтажёр',
    createdAt: '2026-08-12T09:00:00.000Z',
  },
  projects: [
    {
      id: 'fixture-project-ready',
      jobId: 'fixture-ready',
      title: 'Осенний запуск продукта.mp4',
      source: 'account',
      state: 'READY_FOR_REVIEW',
      percent: 100,
      processing: { mode: 'short', subtitlesEnabled: true, hookEnabled: true },
      createdAt: '2026-09-20T08:30:00.000Z',
      updatedAt: '2026-09-22T08:42:00.000Z',
    },
    {
      id: 'fixture-project-working',
      jobId: 'fixture-working',
      title: 'Интервью с основателем.mov',
      source: 'account',
      state: 'PROCESSING',
      percent: 63,
      processing: { mode: 'long', subtitlesEnabled: true, hookEnabled: false },
      createdAt: '2026-09-21T12:15:00.000Z',
      updatedAt: '2026-09-22T09:18:00.000Z',
    },
    {
      id: 'fixture-project-failed',
      jobId: 'fixture-failed',
      title: 'Вертикальный тизер.mp4',
      source: 'account',
      state: 'FAILED',
      percent: 38,
      processing: { mode: 'short', subtitlesEnabled: false, hookEnabled: true },
      createdAt: '2026-09-18T16:05:00.000Z',
      updatedAt: '2026-09-18T16:29:00.000Z',
    },
    {
      id: 'fixture-project-expired',
      jobId: 'fixture-expired',
      title: 'Архивный ролик.mp4',
      source: 'legacy_claim',
      state: 'EXPIRED',
      percent: 100,
      processing: { mode: 'short', subtitlesEnabled: true, hookEnabled: true },
      createdAt: '2026-06-03T10:00:00.000Z',
      updatedAt: '2026-06-04T10:00:00.000Z',
    },
  ],
  pipelines: {
    'fixture-ready': {
      tasks: [
        {
          taskId: 'fixture-task-ready',
          fileName: 'autumn-launch-source.mp4',
          state: 'READY_FOR_REVIEW',
          percent: 100,
          detail: 'Черновик готов. Проверьте титры и темп монтажа.',
          updatedAt: '2026-09-22T08:42:00.000Z',
          previewUrl: '/__fixture__/blank.mp4',
          downloadUrl: '/__fixture__/blank.mp4?download=1',
          candidates: [
            {
              candidateId: 'A',
              title: 'Сильный хук',
              sourceStart: 12.4,
              sourceEnd: 41.8,
              score: 94,
              reason: 'Быстрый вход и ясный тезис',
            },
            {
              candidateId: 'B',
              title: 'Демонстрация продукта',
              sourceStart: 58.1,
              sourceEnd: 89.6,
              score: 87,
              reason: 'Хорошая визуальная динамика',
            },
          ],
        },
      ],
    },
    'fixture-working': {
      tasks: [
        {
          taskId: 'fixture-task-working',
          fileName: 'founder-interview.mov',
          state: 'PROCESSING',
          percent: 63,
          detail: 'Собираем субтитры и выравниваем громкость.',
          updatedAt: '2026-09-22T09:18:00.000Z',
        },
      ],
    },
    'fixture-failed': {
      tasks: [
        {
          taskId: 'fixture-task-failed',
          fileName: 'vertical-teaser.mp4',
          state: 'FAILED',
          percent: 38,
          detail: 'Тестовая ошибка: в синтетическом файле не найден аудиопоток.',
          updatedAt: '2026-09-18T16:29:00.000Z',
        },
      ],
    },
    'fixture-expired': { tasks: [] },
  },
  files: {
    'fixture-ready': [
      { name: 'autumn-launch-source.mp4', size: 48_328_704, modifiedAt: '2026-09-20T08:31:00.000Z' },
      { name: 'brand-notes.txt', size: 4_812, modifiedAt: '2026-09-20T08:32:00.000Z' },
    ],
    'fixture-working': [
      { name: 'founder-interview.mov', size: 724_566_016, modifiedAt: '2026-09-21T12:16:00.000Z' },
    ],
    'fixture-failed': [
      { name: 'vertical-teaser.mp4', size: 96_468_992, modifiedAt: '2026-09-18T16:06:00.000Z' },
    ],
    'fixture-expired': [],
  },
};

function printHelp() {
  console.log(`Usage: node scripts/studio-preview.mjs [--guest] [--fixtures=path]

Serves the current public studio and an in-memory fake API at:
  http://${HOST}:${PORT}

Options:
  --guest            Start without a signed-in demo session.
  --fixtures=path    Shallow-override user/projects/pipelines/files with JSON.
  --help             Show this help.

All API responses are local fixtures. Uploaded bytes are discarded.`);
}

function parseArguments(argv) {
  let guest = false;
  let fixturesPath = '';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true, guest, fixturesPath };
    if (argument === '--guest') {
      guest = true;
      continue;
    }
    if (argument === '--fixtures') {
      fixturesPath = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument.startsWith('--fixtures=')) {
      fixturesPath = argument.slice('--fixtures='.length);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return { help: false, guest, fixturesPath };
}

function loadFixtures(fixturesPath) {
  const overrides = fixturesPath
    ? JSON.parse(readFileSync(path.resolve(fixturesPath), 'utf8'))
    : {};
  return structuredClone({
    user: overrides.user ?? DEFAULT_FIXTURES.user,
    projects: overrides.projects ?? DEFAULT_FIXTURES.projects,
    pipelines: { ...DEFAULT_FIXTURES.pipelines, ...(overrides.pipelines ?? {}) },
    files: { ...DEFAULT_FIXTURES.files, ...(overrides.files ?? {}) },
  });
}

function parseCookies(header) {
  const cookies = new Map();
  for (const entry of String(header ?? '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    cookies.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
  }
  return cookies;
}

function requestIsSignedIn(request, guestByDefault) {
  const fixtureSession = parseCookies(request.headers.cookie).get('fixture_session');
  if (fixtureSession) return fixtureSession === 'demo';
  return !guestByDefault;
}

function json(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Montage-Fixture': 'true',
    ...headers,
  });
  response.end(body);
}

function empty(response, status, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
    'X-Montage-Fixture': 'true',
    ...headers,
  });
  response.end();
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw Object.assign(new Error('Fixture JSON body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Fixture received invalid JSON'), { status: 400 });
  }
}

async function discardBody(request, maximumBytes) {
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw Object.assign(new Error('Synthetic fixture chunk is too large'), { status: 413 });
  }
  return size;
}

function bearer(request) {
  const authorization = String(request.headers.authorization ?? '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function tokenForJob(jobId) {
  return `fixture.${Buffer.from(jobId).toString('base64url')}`;
}

function jobFromToken(token) {
  if (!String(token).startsWith('fixture.')) return '';
  try {
    return Buffer.from(String(token).slice('fixture.'.length), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function selectedJob(request, fixtures) {
  const jobId = jobFromToken(bearer(request));
  if (!jobId || !fixtures.pipelines[jobId] || !fixtures.files[jobId]) {
    throw Object.assign(new Error('Fixture project token is missing or unknown'), { status: 401 });
  }
  return jobId;
}

function findProject(fixtures, identifier) {
  return fixtures.projects.find((project) => project.id === identifier || project.jobId === identifier) ?? null;
}

function createFixtureProject(fixtures, input, includeInAccount) {
  let numericSerial = fixtures.projects.length + 1;
  while (fixtures.pipelines[`fixture-new-${String(numericSerial).padStart(2, '0')}`]) numericSerial += 1;
  const serial = String(numericSerial).padStart(2, '0');
  const jobId = `fixture-new-${serial}`;
  const now = new Date().toISOString();
  const project = {
    id: `fixture-project-new-${serial}`,
    jobId,
    title: String(input.title || 'Новый синтетический ролик').slice(0, 120),
    source: includeInAccount ? 'account' : 'website',
    state: 'NEW',
    percent: 0,
    processing: input.processing && typeof input.processing === 'object'
      ? input.processing
      : { mode: 'short' },
    createdAt: now,
    updatedAt: now,
  };
  if (includeInAccount) fixtures.projects.unshift(project);
  fixtures.pipelines[jobId] = { tasks: [] };
  fixtures.files[jobId] = [];
  return project;
}

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(response, 405, { error: 'Fixture static server accepts GET and HEAD only' });
    return;
  }

  if (url.pathname === '/config.js') {
    const body = [
      '// Generated by scripts/studio-preview.mjs. Never contacts the production API.',
      'window.MONTAGE_UPLOAD_CONFIG = { apiBase: "", allowManualToken: false, fixture: true };',
      '',
    ].join('\n');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Montage-Fixture': 'true',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  if (url.pathname === '/__fixture__/blank.mp4') {
    empty(response, 200, {
      'Content-Type': 'video/mp4',
      ...(url.searchParams.has('download')
        ? { 'Content-Disposition': 'attachment; filename="MontageAI_fixture.mp4"' }
        : {}),
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const original = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const badge = [
      '<div role="status" aria-label="Local demo with fake data"',
      ' style="position:fixed;top:8px;left:50%;z-index:2147483647;transform:translateX(-50%);',
      'pointer-events:none;border:1px solid rgba(255,255,255,.42);border-radius:999px;',
      'background:#6d28d9;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.28);',
      'padding:6px 12px;font:700 11px/1.2 system-ui,sans-serif;letter-spacing:.08em;white-space:nowrap">',
      'LOCAL DEMO · FAKE DATA</div>',
    ].join('');
    const body = original.replace(/(<body\b[^>]*>)/i, `$1\n${badge}`);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
      'Content-Type': 'text/html; charset=utf-8',
      'X-Montage-Fixture': 'true',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    json(response, 400, { error: 'Invalid fixture path' });
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const publicPrefix = `${PUBLIC_DIR}${path.sep}`.toLowerCase();
  if (filePath.toLowerCase() !== PUBLIC_DIR.toLowerCase() && !filePath.toLowerCase().startsWith(publicPrefix)) {
    json(response, 403, { error: 'Fixture path leaves the public directory' });
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    json(response, 404, { error: 'Fixture file not found' });
    return;
  }
  if (!fileStats.isFile()) {
    json(response, 404, { error: 'Fixture file not found' });
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': fileStats.size,
    'Content-Type': contentTypeFor(filePath),
    'X-Montage-Fixture': 'true',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function handleApi(request, response, url, context) {
  const { fixtures, guestByDefault, uploads } = context;
  const signedIn = requestIsSignedIn(request, guestByDefault);
  const method = request.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    empty(response, 204, { Allow: 'GET, HEAD, POST, PUT, DELETE, OPTIONS' });
    return;
  }

  if (method === 'GET' && pathname === '/api/health') {
    json(response, 200, {
      ok: true,
      fixture: true,
      cloud: false,
      provider: 'local-fixture-memory',
      protected: true,
      accountsEnabled: true,
      maxFileSize: MAX_FIXTURE_FILE_SIZE,
      chunkSize: FIXTURE_CHUNK_SIZE,
      retentionHours: 1,
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/auth/capabilities') {
    json(response, 200, {
      ok: true,
      fixture: true,
      enabled: true,
      authEnabled: true,
      registrationEnabled: true,
      sameOriginCookie: true,
    });
    return;
  }

  if (method === 'GET' && (pathname === '/api/auth/me' || pathname === '/api/me')) {
    if (!signedIn) {
      json(response, 401, { error: 'Fixture is in guest mode' });
      return;
    }
    json(response, 200, { ok: true, fixture: true, user: fixtures.user });
    return;
  }

  if (method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(pathname)) {
    await readJson(request);
    json(response, pathname.endsWith('register') ? 201 : 200, {
      ok: true,
      fixture: true,
      user: fixtures.user,
    }, {
      'Set-Cookie': 'fixture_session=demo; Path=/; HttpOnly; SameSite=Lax',
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    json(response, 200, { ok: true, fixture: true }, {
      'Set-Cookie': 'fixture_session=guest; Path=/; HttpOnly; SameSite=Lax',
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    if (!signedIn) {
      json(response, 401, { error: 'Sign in to inspect fixture projects' });
      return;
    }
    json(response, 200, { ok: true, fixture: true, projects: fixtures.projects });
    return;
  }

  if (method === 'POST' && pathname === '/api/projects') {
    if (!signedIn) {
      json(response, 401, { error: 'Sign in to create a fixture project' });
      return;
    }
    const project = createFixtureProject(fixtures, await readJson(request), true);
    const token = tokenForJob(project.jobId);
    json(response, 201, {
      ok: true,
      fixture: true,
      project,
      jobId: project.jobId,
      token,
      jobToken: token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/projects/claim') {
    if (!signedIn) {
      json(response, 401, { error: 'Sign in to claim a fixture project' });
      return;
    }
    const input = await readJson(request);
    const claimedJobId = jobFromToken(input.jobToken || input.legacyToken);
    let project = claimedJobId ? findProject(fixtures, claimedJobId) : null;
    if (!project) project = createFixtureProject(fixtures, { title: input.title || 'Привязанный демо-ролик' }, true);
    const token = tokenForJob(project.jobId);
    json(response, 201, { ok: true, fixture: true, project, token, jobToken: token });
    return;
  }

  const projectAccessMatch = pathname.match(/^\/api\/projects\/([^/]+)\/access$/);
  if (method === 'POST' && projectAccessMatch) {
    if (!signedIn) {
      json(response, 401, { error: 'Sign in to open a fixture project' });
      return;
    }
    const identifier = decodeURIComponent(projectAccessMatch[1]);
    const project = findProject(fixtures, identifier);
    if (!project) {
      json(response, 404, { error: 'Fixture project not found' });
      return;
    }
    if (project.state === 'EXPIRED') {
      json(response, 410, { error: 'Тестовый доступ к архивному проекту истёк' });
      return;
    }
    const token = tokenForJob(project.jobId);
    json(response, 200, {
      ok: true,
      fixture: true,
      project,
      token,
      jobToken: token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (method === 'GET' && projectMatch) {
    if (!signedIn) {
      json(response, 401, { error: 'Sign in to inspect a fixture project' });
      return;
    }
    const project = findProject(fixtures, decodeURIComponent(projectMatch[1]));
    if (!project) {
      json(response, 404, { error: 'Fixture project not found' });
      return;
    }
    json(response, 200, { ok: true, fixture: true, project });
    return;
  }

  if (method === 'POST' && pathname === '/api/jobs') {
    const project = createFixtureProject(fixtures, await readJson(request), signedIn);
    const token = tokenForJob(project.jobId);
    json(response, 201, {
      ok: true,
      fixture: true,
      jobId: project.jobId,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      lifetimeHours: 1,
      ...(signedIn ? { project } : {}),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/session') {
    const jobId = selectedJob(request, fixtures);
    const project = findProject(fixtures, jobId);
    json(response, 200, {
      ok: true,
      fixture: true,
      jobId,
      source: project?.source ?? 'website',
      processing: project?.processing ?? { mode: 'short' },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/files') {
    const jobId = selectedJob(request, fixtures);
    json(response, 200, { ok: true, fixture: true, files: fixtures.files[jobId] });
    return;
  }

  if (method === 'GET' && pathname === '/api/pipeline') {
    const jobId = selectedJob(request, fixtures);
    json(response, 200, { ok: true, fixture: true, tasks: fixtures.pipelines[jobId].tasks });
    return;
  }

  const actionMatch = pathname.match(/^\/api\/pipeline\/([^/]+)\/actions$/);
  if (method === 'POST' && actionMatch) {
    const jobId = selectedJob(request, fixtures);
    const taskId = decodeURIComponent(actionMatch[1]);
    const task = fixtures.pipelines[jobId].tasks.find((item) => item.taskId === taskId);
    if (!task) {
      json(response, 404, { error: 'Fixture pipeline task not found' });
      return;
    }
    const input = await readJson(request);
    task.action = {
      actionId: `fixture-action-${Date.now()}`,
      kind: input.kind === 'APPROVE' ? 'APPROVE' : 'REVISION',
      state: 'PENDING',
      detail: 'Fixture accepted the action; no renderer or worker is running.',
      updatedAt: new Date().toISOString(),
    };
    json(response, 202, { ok: true, fixture: true, action: task.action });
    return;
  }

  if (method === 'POST' && pathname === '/api/uploads') {
    const jobId = selectedJob(request, fixtures);
    const input = await readJson(request);
    const size = Number(input.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      json(response, 400, { error: 'Synthetic fixture file size is invalid' });
      return;
    }
    if (size > MAX_FIXTURE_FILE_SIZE) {
      json(response, 413, { error: 'Fixture accepts synthetic files up to 16 MB only' });
      return;
    }
    const uploadId = `fixture-upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const upload = {
      uploadId,
      jobId,
      name: String(input.name || 'synthetic-file.bin').slice(0, 170),
      size,
      type: String(input.type || 'application/octet-stream').slice(0, 120),
      received: new Set(),
    };
    uploads.set(uploadId, upload);
    json(response, 201, {
      provider: 'fixture-local',
      fixture: true,
      uploadId,
      name: upload.name,
      size,
      type: upload.type,
      chunkSize: FIXTURE_CHUNK_SIZE,
      totalChunks: Math.ceil(size / FIXTURE_CHUNK_SIZE),
      receivedChunks: [],
      status: 'uploading',
      sessionToken: `fixture-session-${uploadId}`,
    });
    return;
  }

  const chunkMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/chunks\/(\d+)$/);
  if (method === 'PUT' && chunkMatch) {
    const jobId = selectedJob(request, fixtures);
    const upload = uploads.get(decodeURIComponent(chunkMatch[1]));
    if (!upload || upload.jobId !== jobId) {
      json(response, 404, { error: 'Synthetic fixture upload not found' });
      return;
    }
    const index = Number(chunkMatch[2]);
    const bytes = await discardBody(request, FIXTURE_CHUNK_SIZE);
    upload.received.add(index);
    json(response, 200, { ok: true, fixture: true, index, bytes, etag: `fixture-etag-${index}` });
    return;
  }

  const completeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const jobId = selectedJob(request, fixtures);
    const uploadId = decodeURIComponent(completeMatch[1]);
    const upload = uploads.get(uploadId);
    if (!upload || upload.jobId !== jobId) {
      json(response, 404, { error: 'Synthetic fixture upload not found' });
      return;
    }
    await readJson(request);
    const now = new Date().toISOString();
    fixtures.files[jobId].unshift({ name: upload.name, size: upload.size, modifiedAt: now });
    const pipelineQueued = /\.(mp4|mov|mkv)$/i.test(upload.name);
    if (pipelineQueued) {
      fixtures.pipelines[jobId].tasks.unshift({
        taskId: `fixture-task-${Date.now()}`,
        fileName: upload.name,
        state: 'QUEUED',
        percent: 4,
        detail: 'Синтетическая загрузка принята. В fixture-сервере реальная обработка не запускается.',
        updatedAt: now,
      });
    }
    uploads.delete(uploadId);
    json(response, 200, {
      ok: true,
      fixture: true,
      name: upload.name,
      size: upload.size,
      pipelineQueued,
    });
    return;
  }

  const uploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
  if (method === 'DELETE' && uploadMatch) {
    selectedJob(request, fixtures);
    uploads.delete(decodeURIComponent(uploadMatch[1]));
    json(response, 200, { ok: true, fixture: true, cancelled: true });
    return;
  }

  json(response, 404, { error: `No local fixture for ${method} ${pathname}` });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const fixtures = loadFixtures(options.fixturesPath);
  const context = {
    fixtures,
    guestByDefault: options.guest,
    uploads: new Map(),
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    const operation = url.pathname.startsWith('/api/')
      ? handleApi(request, response, url, context)
      : serveStatic(request, response, url);
    operation.catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      json(response, Number(error?.status) || 500, {
        error: Number(error?.status) ? error.message : 'Local fixture server error',
      });
      if (!error?.status) console.error(error);
    });
  });

  server.on('error', (error) => {
    console.error(`Studio fixture failed on http://${HOST}:${PORT}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    console.log(`Studio fixture: http://${HOST}:${PORT}`);
    console.log(`Mode: ${options.guest ? 'guest (login is still available)' : 'signed-in demo user'}`);
    console.log('LOCAL FIXTURES ONLY — no production API, secrets, object storage, or processing worker.');
    console.log('Synthetic upload bytes are discarded; the MP4 result endpoint is intentionally empty.');
  });

  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
