import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MemoryAccountStore,
  PostgresAccountStore,
  SESSION_COOKIE_NAME,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../accounts.js';
import { postgresSsl, validateAccountEnvironment } from '../postgres.js';
import { createApp, signToken, verifyToken } from '../server.js';

const tokenSecret = 'test-token-secret-that-is-long-enough';

async function withAccountServer(context, callback, options = {}) {
  const store = options.store ?? new MemoryAccountStore();
  const env = {
    TOKEN_SECRET: tokenSecret,
    S3_BUCKET: 'test-bucket',
    NODE_ENV: 'test',
    SESSION_LIFETIME_HOURS: '24',
    ...(options.env ?? {}),
  };
  const app = createApp({
    env,
    accountStore: store,
    s3: options.s3 ?? { send: async () => ({}) },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await callback({ origin, store, env });
}

async function jsonRequest(origin, path, options = {}) {
  const headers = {
    Origin: origin,
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers ?? {}),
  };
  return fetch(`${origin}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') ?? '').split(';', 1)[0];
}

async function register(origin, email, displayName = 'Тест') {
  const response = await jsonRequest(origin, '/api/auth/register', {
    body: { email, displayName, password: 'correct horse battery staple' },
  });
  return { response, payload: await response.json(), cookie: cookieFrom(response) };
}

test('scrypt хранит соль и проверяет пароль без сохранения исходного значения', async () => {
  const encoded = await hashPassword('very strong password', 'test-pepper');
  assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
  assert.equal(encoded.includes('very strong password'), false);
  assert.equal(await verifyPassword('very strong password', encoded, 'test-pepper'), true);
  assert.equal(await verifyPassword('wrong password', encoded, 'test-pepper'), false);
});

test('регистрация создаёт opaque-сессию и защищённую cookie, /me и logout работают', async (context) => {
  await withAccountServer(context, async ({ origin, store }) => {
    const { response, payload, cookie } = await register(origin, 'User@Example.com', 'Danil');
    assert.equal(response.status, 201);
    assert.equal(payload.user.email, 'user@example.com');
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /Secure/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.match(response.headers.get('set-cookie'), /Path=\//i);
    assert.doesNotMatch(response.headers.get('set-cookie'), /Domain=/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const rawToken = decodeURIComponent(cookie.slice(`${SESSION_COOKIE_NAME}=`.length));
    assert.equal(store.sessions.has(rawToken), false);
    assert.equal(store.sessions.has(hashSessionToken(rawToken)), true);

    const me = await jsonRequest(origin, '/api/auth/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.displayName, 'Danil');

    const logout = await jsonRequest(origin, '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);

    const denied = await jsonRequest(origin, '/api/me', { headers: { Cookie: cookie } });
    assert.equal(denied.status, 401);
  });
});

test('login использует одинаковую ошибку для неизвестного пользователя и неверного пароля', async (context) => {
  await withAccountServer(context, async ({ origin }) => {
    await register(origin, 'known@example.com');
    const wrong = await jsonRequest(origin, '/api/auth/login', {
      body: { email: 'known@example.com', password: 'not the correct password' },
    });
    const missing = await jsonRequest(origin, '/api/auth/login', {
      body: { email: 'missing@example.com', password: 'not the correct password' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal((await wrong.json()).error, (await missing.json()).error);

    const success = await jsonRequest(origin, '/api/auth/login', {
      body: { email: 'known@example.com', password: 'correct horse battery staple' },
    });
    assert.equal(success.status, 200);
    assert.match(success.headers.get('set-cookie'), new RegExp(`^${SESSION_COOKIE_NAME}=`));
  });
});

test('проекты принадлежат сессии, чужой ID не раскрывается, access выдаёт новый job-token', async (context) => {
  await withAccountServer(context, async ({ origin }) => {
    const first = await register(origin, 'first@example.com', 'First');
    const second = await register(origin, 'second@example.com', 'Second');

    const created = await jsonRequest(origin, '/api/projects', {
      headers: { Cookie: first.cookie },
      body: {
        title: 'Первый Reel',
        userId: second.payload.user.id,
        processing: { mode: 'short', hookEnabled: false },
      },
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    const signedJob = verifyToken(createdPayload.jobToken, tokenSecret, 'job');
    assert.equal(signedJob.userId, first.payload.user.id);
    assert.equal(signedJob.jobId, createdPayload.project.jobId);
    assert.equal(signedJob.processing.hookEnabled, false);

    const firstList = await jsonRequest(origin, '/api/projects', { headers: { Cookie: first.cookie } });
    assert.equal((await firstList.json()).projects.length, 1);
    const secondList = await jsonRequest(origin, '/api/projects', { headers: { Cookie: second.cookie } });
    assert.equal((await secondList.json()).projects.length, 0);

    const hidden = await jsonRequest(origin, `/api/projects/${createdPayload.project.id}`, {
      headers: { Cookie: second.cookie },
    });
    assert.equal(hidden.status, 404);
    const deniedAccess = await jsonRequest(origin, `/api/projects/${createdPayload.project.id}/access`, {
      method: 'POST',
      headers: { Cookie: second.cookie },
    });
    assert.equal(deniedAccess.status, 404);

    const refreshed = await jsonRequest(origin, `/api/projects/${createdPayload.project.jobId}/access`, {
      method: 'POST',
      headers: { Cookie: first.cookie },
    });
    assert.equal(refreshed.status, 200);
    const refreshedPayload = await refreshed.json();
    assert.equal(refreshedPayload.token, refreshedPayload.jobToken);
    assert.equal(verifyToken(refreshedPayload.jobToken, tokenSecret, 'job').jobId, signedJob.jobId);
  });
});

test('старый /api/jobs автоматически связывает новый job с вошедшим пользователем', async (context) => {
  await withAccountServer(context, async ({ origin }) => {
    const account = await register(origin, 'compatible@example.com');
    const created = await jsonRequest(origin, '/api/jobs', {
      headers: { Cookie: account.cookie },
      body: { quickStart: true, title: 'Совместимый проект', processing: { mode: 'short' } },
    });
    assert.equal(created.status, 201);
    const payload = await created.json();
    assert.equal(payload.project.title, 'Совместимый проект');
    assert.equal(verifyToken(payload.token, tokenSecret, 'job').userId, account.payload.user.id);

    const projects = await jsonRequest(origin, '/api/projects', { headers: { Cookie: account.cookie } });
    const list = (await projects.json()).projects;
    assert.equal(list.length, 1);
    assert.equal(list[0].jobId, payload.jobId);
  });
});

test('старый job можно атомарно привязать только к одному аккаунту', async (context) => {
  await withAccountServer(context, async ({ origin }) => {
    const first = await register(origin, 'owner@example.com');
    const second = await register(origin, 'other@example.com');
    const legacyToken = signToken({
      kind: 'job',
      jobId: 'web-legacy1234',
      source: 'web',
      processing: { mode: 'long', subtitlesEnabled: false },
      exp: Math.floor(Date.now() / 1000) + 600,
    }, tokenSecret);

    const claimed = await jsonRequest(origin, '/api/projects/claim', {
      headers: { Cookie: first.cookie },
      body: { legacyToken, title: 'Старый проект' },
    });
    assert.equal(claimed.status, 201);
    const claimedPayload = await claimed.json();
    const fresh = verifyToken(claimedPayload.jobToken, tokenSecret, 'job');
    assert.equal(fresh.jobId, 'web-legacy1234');
    assert.equal(fresh.userId, first.payload.user.id);
    assert.equal(fresh.processing.mode, 'long');

    const repeated = await jsonRequest(origin, '/api/projects/claim', {
      headers: { Cookie: first.cookie },
      body: { legacyToken },
    });
    assert.equal(repeated.status, 200);

    const stolen = await jsonRequest(origin, '/api/projects/claim', {
      headers: { Cookie: second.cookie },
      body: { legacyToken },
    });
    assert.equal(stolen.status, 409);
  });
});

test('без DATABASE_URL account API выключен, но приложение и guest flow остаются доступны', async (context) => {
  const app = createApp({
    env: { TOKEN_SECRET: tokenSecret, S3_BUCKET: 'test-bucket', NODE_ENV: 'production' },
    accountStore: null,
    s3: { send: async () => ({}) },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${origin}/api/health`);
  assert.equal((await health.json()).accountsEnabled, false);
  const capabilities = await fetch(`${origin}/api/auth/capabilities`);
  assert.equal((await capabilities.json()).enabled, false);
  const registerResponse = await jsonRequest(origin, '/api/auth/register', {
    body: { email: 'user@example.com', password: 'correct horse battery staple' },
  });
  assert.equal(registerResponse.status, 503);

  const guest = await jsonRequest(origin, '/api/jobs', {
    body: { quickStart: true, processing: { mode: 'short' } },
  });
  assert.equal(guest.status, 201);
  assert.match((await guest.json()).jobId, /^web-/);
});

test('register и login имеют независимые persistent rate limits с Retry-After', async (context) => {
  await withAccountServer(context, async ({ origin }) => {
    assert.equal((await register(origin, 'first-limit@example.com')).response.status, 201);
    assert.equal((await register(origin, 'second-limit@example.com')).response.status, 201);
    const blockedRegister = await register(origin, 'third-limit@example.com');
    assert.equal(blockedRegister.response.status, 429);
    assert.equal(blockedRegister.payload.code, 'ACCOUNT_RATE_LIMIT');
    assert.ok(Number(blockedRegister.response.headers.get('retry-after')) > 0);
  }, { env: { AUTH_REGISTER_RATE_LIMIT: '2' } });

  await withAccountServer(context, async ({ origin }) => {
    await register(origin, 'login-limit@example.com');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const denied = await jsonRequest(origin, '/api/auth/login', {
        body: { email: 'login-limit@example.com', password: 'incorrect password' },
      });
      assert.equal(denied.status, 401);
    }
    const blocked = await jsonRequest(origin, '/api/auth/login', {
      body: { email: 'login-limit@example.com', password: 'incorrect password' },
    });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'ACCOUNT_RATE_LIMIT');
  }, { env: { AUTH_LOGIN_RATE_LIMIT: '2' } });
});

test('POST /api/projects сохраняет полный brief в S3 и не теряет поля формы', async (context) => {
  const commands = [];
  await withAccountServer(context, async ({ origin }) => {
    const account = await register(origin, 'brief@example.com', 'Brief Owner');
    const response = await jsonRequest(origin, '/api/projects', {
      headers: { Cookie: account.cookie },
      body: {
        title: 'Карточка проекта',
        customerName: 'Клиент',
        contact: '@client',
        projectType: 'reels',
        comment: 'Сделать динамично',
        processing: { mode: 'long', musicEnabled: false },
      },
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    const command = commands.find((item) => item.input?.Key === `.briefs/${payload.project.jobId}.json`);
    assert.ok(command);
    const brief = JSON.parse(command.input.Body);
    assert.equal(brief.title, 'Карточка проекта');
    assert.equal(brief.customerName, 'Клиент');
    assert.equal(brief.contact, '@client');
    assert.equal(brief.projectType, 'reels');
    assert.equal(brief.comment, 'Сделать динамично');
    assert.equal(brief.processing.mode, 'long');
    assert.equal(brief.processing.musicEnabled, false);
    assert.equal(brief.accountUserId, account.payload.user.id);
    assert.equal(command.input.Metadata.source, 'account');
  }, { s3: { send: async (command) => { commands.push(command); return {}; } } });
});

test('создание проектов ограничено скоростью и общей квотой пользователя', async (context) => {
  await withAccountServer(context, async ({ origin }) => {
    const account = await register(origin, 'project-rate@example.com');
    for (let index = 0; index < 2; index += 1) {
      const created = await jsonRequest(origin, '/api/projects', {
        headers: { Cookie: account.cookie },
        body: { title: `Rate ${index}` },
      });
      assert.equal(created.status, 201);
    }
    const blocked = await jsonRequest(origin, '/api/projects', {
      headers: { Cookie: account.cookie },
      body: { title: 'Rate blocked' },
    });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'ACCOUNT_RATE_LIMIT');
  }, { env: { ACCOUNT_PROJECT_RATE_LIMIT: '2', ACCOUNT_PROJECT_QUOTA: '10' } });

  await withAccountServer(context, async ({ origin }) => {
    const account = await register(origin, 'project-quota@example.com');
    for (let index = 0; index < 2; index += 1) {
      const created = await jsonRequest(origin, '/api/projects', {
        headers: { Cookie: account.cookie },
        body: { title: `Quota ${index}` },
      });
      assert.equal(created.status, 201);
    }
    const blocked = await jsonRequest(origin, '/api/projects', {
      headers: { Cookie: account.cookie },
      body: { title: 'Quota blocked' },
    });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'PROJECT_QUOTA');
  }, { env: { ACCOUNT_PROJECT_RATE_LIMIT: '10', ACCOUNT_PROJECT_QUOTA: '2' } });
});

test('health и capabilities отключают аккаунты при неготовой схеме', async (context) => {
  const store = new MemoryAccountStore();
  store.readiness = async () => ({ ready: false, backend: 'postgres', schemaVersion: null });
  await withAccountServer(context, async ({ origin }) => {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 503);
    const healthPayload = await health.json();
    assert.equal(healthPayload.ok, false);
    assert.equal(healthPayload.accountsConfigured, true);
    assert.equal(healthPayload.accountsEnabled, false);

    const capabilities = await fetch(`${origin}/api/auth/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).enabled, false);
  }, { store });
});

test('memory limiter bounded, а PostgreSQL limiter использует атомарный upsert', async () => {
  const memory = new MemoryAccountStore({ maxRateLimitEntries: 100 });
  for (let index = 0; index < 130; index += 1) {
    await memory.consumeRateLimit({
      scope: 'test',
      subjectHash: String(index).padStart(64, '0'),
      limit: 1,
      windowSeconds: 60,
      retentionSeconds: 3600,
      now: new Date(1_800_000_000_000 + index),
    });
  }
  assert.equal(memory.rateLimits.size, 100);

  const queries = [];
  const postgres = new PostgresAccountStore({
    pool: {
      query: async (sql) => {
        queries.push(sql);
        return sql.includes('RETURNING hit_count') ? { rows: [{ hit_count: 3 }] } : { rows: [] };
      },
    },
  });
  const result = await postgres.consumeRateLimit({
    scope: 'auth_login_ip',
    subjectHash: 'a'.repeat(64),
    limit: 2,
    windowSeconds: 60,
    retentionSeconds: 3600,
    now: new Date('2026-01-01T00:00:01Z'),
  });
  assert.equal(result.allowed, false);
  assert.equal(queries.some((sql) => sql.includes('ON CONFLICT (scope, subject_hash)')), true);
});

test('production account config требует явный NODE_ENV и разные сильные секреты', () => {
  assert.throws(
    () => validateAccountEnvironment({ DATABASE_URL: 'postgresql://db' }),
    /NODE_ENV must be explicitly set/,
  );
  assert.throws(
    () => validateAccountEnvironment({
      DATABASE_URL: 'postgresql://db',
      NODE_ENV: 'production',
      TOKEN_SECRET: 'x'.repeat(40),
      AUTH_PASSWORD_PEPPER: 'x'.repeat(40),
      SESSION_AUDIT_SECRET: 'z'.repeat(40),
    }),
    /must be different/,
  );
  assert.throws(
    () => validateAccountEnvironment({ ACCOUNT_STORE: 'memory', NODE_ENV: 'production' }),
    /allowed only/,
  );
});

test('PostgreSQL TLS загружает официальный CA и сохраняет проверку сертификата', () => {
  const caPath = fileURLToPath(new URL('../certs/timeweb-dbaas-ca.crt', import.meta.url));
  const ssl = postgresSsl({
    DATABASE_SSL: 'require',
    DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
    DATABASE_SSL_CA_PATH: caPath,
  });
  assert.equal(ssl.rejectUnauthorized, true);
  assert.match(ssl.ca, /BEGIN CERTIFICATE/);
  assert.match(ssl.ca, /END CERTIFICATE/);
});
