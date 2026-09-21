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
    env: { TOKEN_SECRET: secret, RETENTION_HOURS: '12', NODE_ENV: 'production' },
    s3: { send: async () => ({}) },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(await home.text(), /MontageAI/);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.retentionHours, 12);
  assert.equal(payload.maxFileSize, 1024 * 1024 * 1024);
});

async function completeMultipartUpload(context, storedSize) {
  const commands = [];
  const jobId = 'web-sizecheck01';
  const uploadId = 'upload-sizecheck01';
  const declaredSize = 10 * 1024 * 1024 + 17;
  const expires = Math.floor(Date.now() / 1000) + 60;
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test-bucket' },
    s3: {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'ListPartsCommand') {
          return {
            Parts: [
              { ETag: '"part-1"', PartNumber: 1 },
              { ETag: '"part-2"', PartNumber: 2 },
            ],
          };
        }
        if (command.constructor.name === 'CompleteMultipartUploadCommand') {
          return { ETag: '"completed"' };
        }
        if (command.constructor.name === 'HeadObjectCommand') {
          return { ContentLength: storedSize };
        }
        return {};
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const jobToken = signToken({ kind: 'job', jobId, source: 'web', exp: expires }, secret);
  const sessionToken = signToken({
    kind: 'session',
    sessionId: uploadId,
    multipartUploadId: 'multipart-sizecheck01',
    jobId,
    key: `${jobId}/clip.mp4`,
    name: 'clip.mp4',
    size: declaredSize,
    type: 'video/mp4',
    chunkSize: 10 * 1024 * 1024,
    exp: expires,
  }, secret);
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/uploads/${uploadId}/complete`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jobToken}`,
        'X-Upload-Session': sessionToken,
      },
    },
  );
  return { commands, declaredSize, response };
}

test('проверяет фактический размер S3 перед постановкой видео в очередь', async (context) => {
  const declaredSize = 10 * 1024 * 1024 + 17;
  const { commands, response } = await completeMultipartUpload(context, declaredSize);
  assert.equal(response.status, 200);
  const names = commands.map((command) => command.constructor.name);
  assert.ok(names.indexOf('HeadObjectCommand') > names.indexOf('CompleteMultipartUploadCommand'));
  assert.ok(names.indexOf('PutObjectCommand') > names.indexOf('HeadObjectCommand'));
  assert.equal(names.includes('DeleteObjectCommand'), false);
});

test('удаляет multipart-объект неверного размера и не создаёт pipeline-задачу', async (context) => {
  const { commands, declaredSize, response } = await completeMultipartUpload(context, 1);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Размер загруженного файла/);
  const names = commands.map((command) => command.constructor.name);
  assert.equal(names.includes('DeleteObjectCommand'), true);
  assert.equal(names.includes('PutObjectCommand'), false);
  const deletion = commands.find((command) => command.constructor.name === 'DeleteObjectCommand');
  assert.equal(deletion.input.Key, 'web-sizecheck01/clip.mp4');
  assert.ok(declaredSize > 1);
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

  const updated = await fetch(`http://127.0.0.1:${port}/api/worker/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': 'worker-secret',
    },
    body: JSON.stringify({
      workerId: 'test-worker01',
      phase: 'idle',
    }),
  });
  assert.equal(updated.status, 200);
  const payload = await updated.json();
  assert.equal(payload.ok, true);
  assert.equal(commands.at(-1).constructor.name, 'PutObjectCommand');
  assert.equal(commands.at(-1).input.Key, '.workers/test-worker01.json');
});

test('показывает только запрошенную неудавшуюся задачу для безопасного повтора', async (context) => {
  const jobId = 'web-12345678';
  const taskId = 'task-failed01';
  const task = { jobId, taskId, fileName: 'rotated.mp4', size: 100 };
  const status = { jobId, taskId, state: 'FAILED', updatedAt: new Date().toISOString() };
  const app = createApp({
    env: { TOKEN_SECRET: secret, WORKER_SECRET: 'worker-secret', S3_BUCKET: 'test-bucket' },
    s3: {
      send: async (command) => {
        if (command.constructor.name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: `.queue/${jobId}/${taskId}.json` }] };
        }
        if (command.constructor.name === 'GetObjectCommand') {
          const body = command.input.Key.startsWith('.queue/') ? task : status;
          return { Body: { transformToString: async () => JSON.stringify(body) } };
        }
        return {};
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/worker/tasks`;
  const headers = { 'X-Worker-Secret': 'worker-secret' };

  assert.equal((await fetch(base)).status, 401);
  assert.equal((await (await fetch(base, { headers })).json()).tasks.length, 0);
  const found = await (await fetch(`${base}?failedTaskId=${taskId}`, { headers })).json();
  assert.deepEqual(found.tasks, [task]);
  const unrelated = await (await fetch(`${base}?failedTaskId=task-other01`, { headers })).json();
  assert.equal(unrelated.tasks.length, 0);
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
        if (command.constructor.name === 'HeadObjectCommand') {
          return { ContentLength: 1024, LastModified: new Date() };
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

test('не создаёт действие для отсутствующего, просроченного или чужого preview', async () => {
  const commands = [];
  const jobId = 'web-guard1234';
  const taskId = 'task-guard1234';
  let availability = 'MISSING';
  let resultKey = `.results/${jobId}/${taskId}.mp4`;
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test-bucket', RETENTION_HOURS: '24' },
    s3: {
      send: async (command) => {
        commands.push(command);
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: { transformToString: async () => JSON.stringify({
            version: 1,
            jobId,
            taskId,
            state: 'READY_FOR_REVIEW',
            localJobId: '20260922T120000000000Z_guard',
            resultKey,
            updatedAt: new Date().toISOString(),
          }) } };
        }
        if (command.constructor.name === 'HeadObjectCommand') {
          if (availability === 'MISSING') throw Object.assign(new Error('missing'), { name: 'NotFound' });
          return {
            ContentLength: 1024,
            LastModified: new Date(Date.now() - 25 * 60 * 60 * 1000),
          };
        }
        if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [] };
        return {};
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const token = signToken({
    kind: 'job', jobId, source: 'web', exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  const request = () => fetch(
    `http://127.0.0.1:${server.address().port}/api/pipeline/${taskId}/actions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'REVISION', requestText: 'Сделай музыку тише' }),
    },
  );

  try {
    assert.equal((await request()).status, 409);
    availability = 'EXPIRED';
    assert.equal((await request()).status, 410);
    resultKey = '.results/web-other1234/task-guard1234.mp4';
    assert.equal((await request()).status, 409);
    assert.equal(commands.filter((command) => command.constructor.name === 'PutObjectCommand').length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('даёт отдельную ссылку для скачивания только готового MP4', async (context) => {
  const jobId = 'web-12345678';
  const readyId = 'task-ready01';
  const approvedId = 'task-approved01';
  const pendingId = 'task-pending01';
  const statuses = [
    { jobId, taskId: readyId, state: 'READY_FOR_REVIEW', resultKey: `.results/${jobId}/${readyId}.mp4` },
    { jobId, taskId: approvedId, state: 'APPROVED', resultKey: `.results/${jobId}/${approvedId}.mp4` },
    { jobId, taskId: pendingId, state: 'PROCESSING', resultKey: `.results/${jobId}/${pendingId}.mp4` },
  ];
  const signed = [];
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test-bucket' },
    s3: {
      send: async (command) => {
        if (command.constructor.name === 'ListObjectsV2Command') {
          return {
            Contents: command.input.Prefix.startsWith('.status/')
              ? statuses.map((status) => ({ Key: `.status/${jobId}/${status.taskId}.json` }))
              : [],
          };
        }
        if (command.constructor.name === 'GetObjectCommand') {
          const status = statuses.find((item) => command.input.Key.endsWith(`/${item.taskId}.json`));
          return { Body: { transformToString: async () => JSON.stringify(status) } };
        }
        if (command.constructor.name === 'HeadObjectCommand') {
          return { ContentLength: 1024, LastModified: new Date() };
        }
        return {};
      },
    },
    getSignedUrl: async (_s3, command, options) => {
      signed.push({ input: command.input, options });
      return `https://storage.example/${signed.length}`;
    },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const token = signToken({
    kind: 'job', jobId, source: 'web', exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pipeline`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const { tasks } = await response.json();
  for (const taskId of [readyId, approvedId]) {
    const task = tasks.find((item) => item.taskId === taskId);
    assert.equal(task.resultAvailability, 'AVAILABLE');
    assert.match(task.previewUrl, /^https:\/\/storage\.example\//);
    assert.match(task.downloadUrl, /^https:\/\/storage\.example\//);
    const download = signed.find((item) => item.input.ResponseContentDisposition?.includes(taskId));
    assert.equal(download.input.Key, `.results/${jobId}/${taskId}.mp4`);
    assert.equal(download.input.ResponseContentDisposition,
      `attachment; filename="MontageAI_${taskId}.mp4"`);
    assert.equal(download.options.expiresIn, 15 * 60);
  }
  const pending = tasks.find((item) => item.taskId === pendingId);
  assert.equal(pending.downloadUrl, undefined);
  assert.equal(pending.previewUrl, undefined);
  assert.equal(signed.length, 4);
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
