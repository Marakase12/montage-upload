import http from 'node:http';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UPLOAD_DIR = path.resolve(APP_DIR, '..', 'inbox');
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024;
const JSON_LIMIT = 64 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.mxf',
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.zip', '.7z', '.rar', '.txt', '.md', '.json',
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function sanitizeFilename(input) {
  const basename = path.basename(String(input ?? '').normalize('NFC'));
  const clean = basename
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!clean || clean === '.' || clean === '..') {
    throw new HttpError(400, 'Некорректное имя файла');
  }

  const extension = path.extname(clean);
  const stem = path.basename(clean, extension).slice(0, 150);
  return `${stem}${extension.slice(0, 20)}`;
}

function assertAllowedFile(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new HttpError(
      415,
      `Формат ${extension || 'без расширения'} не поддерживается`,
    );
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error(error);
  sendJson(response, status, {
    error: status === 500 ? 'Внутренняя ошибка сервера' : error.message,
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function uniqueFilename(directory, filename) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = filename;
  let counter = 2;

  while (await pathExists(path.join(directory, candidate))) {
    candidate = `${stem} (${counter})${extension}`;
    counter += 1;
  }
  return candidate;
}

function publicSession(session) {
  return {
    uploadId: session.id,
    name: session.finalName ?? session.safeName,
    size: session.size,
    type: session.type,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.received,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function createUploadServer(options = {}) {
  const uploadDir = path.resolve(options.uploadDir ?? process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR);
  const stateDir = path.join(uploadDir, '.uploads');
  const tempDir = path.join(stateDir, 'parts');
  const publicDir = path.resolve(options.publicDir ?? path.join(APP_DIR, 'public'));
  const chunkSize = parseInteger(options.chunkSize ?? process.env.CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
  const maxFileSize = parseInteger(
    options.maxFileSize ?? process.env.MAX_FILE_SIZE,
    DEFAULT_MAX_FILE_SIZE,
  );
  const uploadToken = String(options.uploadToken ?? process.env.UPLOAD_TOKEN ?? '');
  const locks = new Map();

  const statePath = (id) => path.join(stateDir, `${id}.json`);
  const partPath = (id) => path.join(tempDir, `${id}.part`);

  async function ensureDirectories() {
    await Promise.all([
      mkdir(uploadDir, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
      mkdir(tempDir, { recursive: true }),
    ]);
  }

  async function saveSession(session) {
    session.updatedAt = new Date().toISOString();
    const destination = statePath(session.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), 'utf8');
    await rename(temporary, destination);
  }

  async function loadSession(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new HttpError(400, 'Некорректный ID загрузки');
    try {
      return JSON.parse(await readFile(statePath(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'Загрузка не найдена');
      throw error;
    }
  }

  async function findResumable({ safeName, size, lastModified }) {
    const files = await readdir(stateDir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const session = JSON.parse(await readFile(path.join(stateDir, entry.name), 'utf8'));
        if (
          session.status === 'uploading'
          && session.safeName === safeName
          && session.size === size
          && session.lastModified === lastModified
          && await pathExists(partPath(session.id))
        ) {
          return session;
        }
      } catch {
        // Повреждённая служебная запись не должна блокировать новые загрузки.
      }
    }
    return null;
  }

  function withLock(id, task) {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const tracked = current.finally(() => {
      if (locks.get(id) === tracked) locks.delete(id);
    });
    locks.set(id, tracked);
    return current;
  }

  function assertAuthorized(request) {
    if (!uploadToken) return;
    const authorization = request.headers.authorization ?? '';
    const supplied = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : request.headers['x-upload-token'];
    if (supplied !== uploadToken) throw new HttpError(401, 'Неверный ключ доступа');
  }

  async function initializeUpload(request, response) {
    assertAuthorized(request);
    const input = await readJson(request);
    const safeName = sanitizeFilename(input.name);
    assertAllowedFile(safeName);

    const size = Number(input.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new HttpError(400, 'Некорректный размер файла');
    }
    if (size > maxFileSize) {
      throw new HttpError(413, `Файл превышает лимит ${maxFileSize} байт`);
    }

    const lastModified = Number.isFinite(Number(input.lastModified))
      ? Number(input.lastModified)
      : 0;
    const resumable = await findResumable({ safeName, size, lastModified });
    if (resumable) {
      sendJson(response, 200, { ...publicSession(resumable), resumed: true });
      return;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const session = {
      id,
      originalName: String(input.name),
      safeName,
      size,
      type: String(input.type ?? 'application/octet-stream').slice(0, 120),
      lastModified,
      chunkSize,
      totalChunks: Math.ceil(size / chunkSize),
      received: [],
      status: 'uploading',
      createdAt: now,
      updatedAt: now,
    };

    const handle = await open(partPath(id), 'wx');
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
    await saveSession(session);
    sendJson(response, 201, publicSession(session));
  }

  async function writeChunk(request, response, id, indexText) {
    assertAuthorized(request);
    const index = Number(indexText);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new HttpError(400, 'Некорректный номер части');
    }

    await withLock(id, async () => {
      const session = await loadSession(id);
      if (session.status !== 'uploading') throw new HttpError(409, 'Загрузка уже завершена');
      if (index >= session.totalChunks) throw new HttpError(416, 'Часть вне диапазона файла');

      const start = index * session.chunkSize;
      const expectedLength = Math.min(session.chunkSize, session.size - start);
      const contentLength = Number(request.headers['content-length']);
      if (contentLength !== expectedLength) {
        throw new HttpError(400, `Ожидалось ${expectedLength} байт, получено ${contentLength || 0}`);
      }

      if (session.received.includes(index)) {
        for await (const _ of request) { /* дочитываем повторный запрос */ }
        sendJson(response, 200, { ok: true, duplicate: true, index });
        return;
      }

      const handle = await open(partPath(id), 'r+');
      let received = 0;
      try {
        for await (const buffer of request) {
          received += buffer.length;
          if (received > expectedLength) throw new HttpError(413, 'Часть файла слишком большая');
          await handle.write(buffer, 0, buffer.length, start + received - buffer.length);
        }
      } finally {
        await handle.close();
      }

      if (received !== expectedLength) {
        throw new HttpError(400, `Часть загружена не полностью: ${received}/${expectedLength}`);
      }

      session.received.push(index);
      session.received.sort((a, b) => a - b);
      await saveSession(session);
      sendJson(response, 200, {
        ok: true,
        index,
        receivedChunks: session.received.length,
        totalChunks: session.totalChunks,
      });
    });
  }

  async function completeUpload(request, response, id) {
    assertAuthorized(request);
    await withLock(id, async () => {
      const session = await loadSession(id);
      if (session.status === 'completed') {
        sendJson(response, 200, publicSession(session));
        return;
      }
      if (session.received.length !== session.totalChunks) {
        throw new HttpError(
          409,
          `Не все части загружены: ${session.received.length}/${session.totalChunks}`,
        );
      }

      const fileStat = await stat(partPath(id));
      if (fileStat.size !== session.size) throw new HttpError(409, 'Размер файла не совпадает');

      session.finalName = await uniqueFilename(uploadDir, session.safeName);
      await rename(partPath(id), path.join(uploadDir, session.finalName));
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      await saveSession(session);
      sendJson(response, 200, publicSession(session));
    });
  }

  async function cancelUpload(request, response, id) {
    assertAuthorized(request);
    await withLock(id, async () => {
      const session = await loadSession(id);
      if (session.status === 'completed') throw new HttpError(409, 'Готовый файл уже сохранён');
      await rm(partPath(id), { force: true });
      await rm(statePath(id), { force: true });
      sendJson(response, 200, { ok: true });
    });
  }

  async function listFiles(request, response) {
    assertAuthorized(request);
    const entries = await readdir(uploadDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fileStat = await stat(path.join(uploadDir, entry.name));
      files.push({ name: entry.name, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() });
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    sendJson(response, 200, { files: files.slice(0, 100), uploadDir });
  }

  async function serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(publicDir, relative);
    const relativeCheck = path.relative(publicDir, target);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      throw new HttpError(403, 'Доступ запрещён');
    }

    let fileStat;
    try {
      fileStat = await stat(target);
    } catch {
      throw new HttpError(404, 'Страница не найдена');
    }
    if (!fileStat.isFile()) throw new HttpError(404, 'Страница не найдена');

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': path.extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(target).pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    try {
      await ensureDirectories();
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;

      if (request.method === 'GET' && pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          chunkSize,
          maxFileSize,
          protected: Boolean(uploadToken),
        });
        return;
      }
      if (request.method === 'GET' && pathname === '/api/files') {
        await listFiles(request, response);
        return;
      }
      if (request.method === 'POST' && pathname === '/api/uploads') {
        await initializeUpload(request, response);
        return;
      }

      const chunkMatch = pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/chunks\/(\d+)$/i);
      if (request.method === 'PUT' && chunkMatch) {
        await writeChunk(request, response, chunkMatch[1], chunkMatch[2]);
        return;
      }

      const completeMatch = pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/complete$/i);
      if (request.method === 'POST' && completeMatch) {
        await completeUpload(request, response, completeMatch[1]);
        return;
      }

      const cancelMatch = pathname.match(/^\/api\/uploads\/([a-f0-9-]+)$/i);
      if (request.method === 'DELETE' && cancelMatch) {
        await cancelUpload(request, response, cancelMatch[1]);
        return;
      }

      if (pathname.startsWith('/api/')) throw new HttpError(404, 'API-метод не найден');
      await serveStatic(request, response, pathname);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error);
    }
  });

  return {
    server,
    uploadDir,
    chunkSize,
    maxFileSize,
    async listen({ host = '127.0.0.1', port = 3020 } = {}) {
      await ensureDirectories();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createUploadServer();
  const host = process.env.HOST ?? '127.0.0.1';
  const port = parseInteger(process.env.PORT, 3020);
  app.listen({ host, port })
    .then(() => {
      console.log(`Загрузка файлов: http://${host}:${port}`);
      console.log(`Папка назначения: ${app.uploadDir}`);
      console.log(`Размер части: ${Math.round(app.chunkSize / 1024 / 1024)} МБ`);
      console.log(`Максимальный файл: ${(app.maxFileSize / 1024 / 1024 / 1024).toFixed(1)} ГБ`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
