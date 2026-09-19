import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApp,
  createTelegramUploadAccess,
  createWebUploadAccess,
  isProcessableVideoFile,
  signToken,
  verifyToken,
} from '../server.js';

const secret = 'test-secret-that-is-long-enough';

test('MP4, MOV и MKV ставятся в очередь обработки', () => {
  for (const name of ['clip.mp4', 'iphone.MOV', 'long.mkv']) {
    assert.equal(isProcessableVideoFile(name), true, name);
  }
  assert.equal(isProcessableVideoFile('notes.txt'), false);
});

test('подписывает и проверяет временную ссылку', () => {
  const token = signToken({
    kind: 'job',
    jobId: 'job-1',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  assert.equal(verifyToken(token, secret, 'job').jobId, 'job-1');
});

test('отклоняет изменённую и просроченную ссылку', () => {
  const token = signToken({
    kind: 'job',
    jobId: 'job-1',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  assert.throws(() => verifyToken(`${token}x`, secret, 'job'), /Недействительная/);

  const expired = signToken({ kind: 'job', jobId: 'job-1', exp: 1 }, secret);
  assert.throws(() => verifyToken(expired, secret, 'job'), /истёк/);
});

test('отдаёт сайт и healthcheck из одного приложения', async (context) => {
  const app = createApp({
    env: { TOKEN_SECRET: secret, RETENTION_HOURS: '12' },
    s3: { send: async () => ({}) },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /MontageAI Studio/);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.retentionHours, 12);
  assert.equal(payload.maxFileSize, 1024 * 1024 * 1024);
});

test('создаёт изолированную веб-заявку без Telegram', async (context) => {
  const commands = [];
  const app = createApp({
    env: {
      TOKEN_SECRET: secret,
      S3_BUCKET: 'test-bucket',
      UPLOAD_LINK_LIFETIME_HOURS: '24',
    },
    s3: { send: async (command) => { commands.push(command); return {}; } },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Иван',
      contact: '@ivan',
      projectType: 'gaming',
      comment: 'Нужен динамичный ролик',
      processing: {
        mode: 'short',
        faceTrackingEnabled: false,
        subtitlesEnabled: true,
        hookEnabled: false,
        requestText: 'не центрируй на лице',
      },
    }),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  const job = verifyToken(result.token, secret, 'job');
  assert.match(job.jobId, /^web-/);
  assert.equal(job.source, 'web');
  assert.equal(job.processing.faceTrackingEnabled, false);
  assert.equal(job.processing.hookEnabled, false);
  assert.equal(commands[0].constructor.name, 'PutObjectCommand');
  assert.match(commands[0].input.Key, /^\.briefs\/web-/);
});

test('не создаёт веб-заявку без контакта', async (context) => {
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test-bucket' },
    s3: { send: async () => ({}) },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerName: 'Иван' }),
  });
  assert.equal(response.status, 400);
});

test('быстрый старт создаёт изолированный проект без обязательного контакта', async (context) => {
  const commands = [];
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test-bucket' },
    s3: { send: async (command) => { commands.push(command); return {}; } },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quickStart: true,
      projectType: 'shorts',
      processing: { mode: 'short' },
    }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  const job = verifyToken(payload.token, secret, 'job');
  assert.match(job.jobId, /^web-/);
  const brief = JSON.parse(commands[0].input.Body);
  assert.equal(brief.quickStart, true);
  assert.equal(brief.contact, null);
});

test('создаёт веб-токены без персональных данных внутри', () => {
  const now = Math.floor(Date.now() / 1000);
  const access = createWebUploadAccess({ TOKEN_SECRET: secret }, now);
  const job = verifyToken(access.token, secret, 'job');
  assert.equal(job.source, 'web');
  assert.equal(job.exp, now + 24 * 60 * 60);
  assert.equal('contact' in job, false);
  assert.equal('customerName' in job, false);
});

test('защищает API локальной машины отдельным секретом', async (context) => {
  const commands = [];
  const app = createApp({
    env: {
      TOKEN_SECRET: secret,
      WORKER_SECRET: 'worker-secret',
      S3_BUCKET: 'test-bucket',
    },
    s3: { send: async (command) => { commands.push(command); return {}; } },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const denied = await fetch(`http://127.0.0.1:${port}/api/worker/tasks`);
  assert.equal(denied.status, 401);

  const updated = await fetch(`http://127.0.0.1:${port}/api/worker/tasks/task-12345/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': 'worker-secret',
    },
    body: JSON.stringify({
      jobId: 'web-12345678',
      state: 'PROCESSING',
      percent: 42,
      stage: 'analysis',
      detail: 'GPT анализирует содержание',
    }),
  });
  assert.equal(updated.status, 200);
  const payload = await updated.json();
  assert.equal(payload.status.percent, 42);
  assert.equal(payload.status.stage, 'analysis');
  assert.equal(commands.at(-1).constructor.name, 'PutObjectCommand');
  assert.equal(commands.at(-1).input.Key, '.status/web-12345678/task-12345.json');
});

test('создаёт правку и требует отдельное явное подтверждение preview', async (context) => {
  const commands = [];
  const jobId = 'web-12345678';
  const taskId = 'task-12345';
  const status = {
    version: 1,
    jobId,
    taskId,
    state: 'READY_FOR_REVIEW',
    localJobId: '20260820T132302145547Z_76e02c5c',
    resultKey: `.results/${jobId}/${taskId}.mp4`,
  };
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test-bucket' },
    s3: {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: { transformToString: async () => JSON.stringify(status) } };
        }
        if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
        return {};
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const token = signToken({
    kind: 'job',
    jobId,
    source: 'web',
    exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const revision = await fetch(`http://127.0.0.1:${port}/api/pipeline/${taskId}/actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'REVISION', requestText: 'Сделай музыку тише' }),
  });
  assert.equal(revision.status, 202);
  const stored = commands.filter((command) => command.constructor.name === 'PutObjectCommand').at(-1);
  assert.match(stored.input.Key, /^\.actions\/web-12345678\/[a-f0-9-]+\.json$/);

  const approvalWithoutConfirmation = await fetch(
    `http://127.0.0.1:${port}/api/pipeline/${taskId}/actions`,
    { method: 'POST', headers, body: JSON.stringify({ kind: 'APPROVE' }) },
  );
  assert.equal(approvalWithoutConfirmation.status, 400);
});

test('выдаёт разным Telegram-пользователям изолированные ссылки', () => {
  const env = {
    TOKEN_SECRET: secret,
    PUBLIC_SITE_URL: 'https://upload.example/',
    UPLOAD_LINK_LIFETIME_HOURS: '6',
  };
  const now = Math.floor(Date.now() / 1000);
  const first = createTelegramUploadAccess({ chat: { id: 100 }, from: { id: 100 } }, env, now);
  const second = createTelegramUploadAccess({ chat: { id: 200 }, from: { id: 200 } }, env, now);
  const firstJob = verifyToken(first.token, secret, 'job');
  const secondJob = verifyToken(second.token, secret, 'job');

  assert.notEqual(firstJob.jobId, secondJob.jobId);
  assert.equal(firstJob.userId, '100');
  assert.equal(secondJob.userId, '200');
  assert.equal(firstJob.exp, now + 6 * 60 * 60);
  assert.match(first.uploadUrl, /^https:\/\/upload\.example\/\?token=/);
});
