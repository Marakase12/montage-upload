import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAccountStore } from '../accounts.js';
import { createApp, signToken, verifyToken } from '../server.js';

const secret = 'aspect-ratio-test-secret-not-production';
const fileSize = 127;

async function fixture(context) {
  const objects = new Map();
  const commands = [];
  const store = new MemoryAccountStore();
  const app = createApp({
    env: { TOKEN_SECRET: secret, WORKER_SECRET: 'test-worker', S3_BUCKET: 'test-bucket' },
    accountStore: store,
    getSignedUrl: async () => 'https://example.invalid/synthetic-source.mp4',
    s3: {
      async send(command) {
        commands.push(command);
        const { Key, Prefix, Body } = command.input;
        switch (command.constructor.name) {
          case 'PutObjectCommand': objects.set(Key, JSON.parse(Body)); return {};
          case 'GetObjectCommand': {
            if (!objects.has(Key)) throw Object.assign(new Error('Missing'), { name: 'NoSuchKey' });
            return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } };
          }
          case 'ListObjectsV2Command': return {
            Contents: [...objects.keys()].filter((key) => key.startsWith(Prefix)).map((key) => ({ Key: key })),
          };
          case 'CreateMultipartUploadCommand': return { UploadId: 'synthetic-multipart' };
          case 'ListPartsCommand': return { Parts: [{ ETag: '"synthetic-part"', PartNumber: 1 }] };
          case 'HeadObjectCommand': return { ContentLength: fileSize, LastModified: new Date() };
          default: return {};
        }
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, extraHeaders = {}, method) {
    return fetch(`${origin}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function register() {
    const response = await request('/api/auth/register', {
      email: 'aspect@example.com', displayName: 'Aspect Test', password: 'strong synthetic password',
    });
    assert.equal(response.status, 201);
    return String(response.headers.get('set-cookie')).split(';', 1)[0];
  }
  return { request, register, objects, commands, store };
}

async function assertUploadRoundTrip(api, token, expectedRatio) {
  const headers = { Authorization: `Bearer ${token}` };
  const sessionResponse = await api.request('/api/session', undefined, headers);
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).processing.aspectRatio, expectedRatio);

  const uploadResponse = await api.request('/api/uploads', { name: 'clip.mp4', size: fileSize, type: 'video/mp4' }, headers);
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  assert.equal(verifyToken(upload.sessionToken, secret, 'session').processing.aspectRatio, expectedRatio);
  const finished = await api.request(`/api/uploads/${upload.uploadId}/complete`, {}, {
    ...headers, 'X-Upload-Session': upload.sessionToken,
  });
  assert.equal(finished.status, 200);
  const job = verifyToken(token, secret, 'job');
  const task = api.objects.get(`.queue/${job.jobId}/${upload.uploadId}.json`);
  assert.equal(task.processing.aspectRatio, expectedRatio);

  const workerList = await api.request('/api/worker/tasks', undefined, { 'X-Worker-Secret': 'test-worker' });
  assert.equal(workerList.status, 200);
  const listedTask = (await workerList.json()).tasks.find((item) => item.taskId === upload.uploadId);
  assert.equal(listedTask.processing.aspectRatio, expectedRatio);
  const claim = await api.request(`/api/worker/tasks/${upload.uploadId}/claim`, { jobId: job.jobId, workerId: 'test-worker01' }, {
    'X-Worker-Secret': 'test-worker',
  });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).task.processing.aspectRatio, expectedRatio);
}

test('guest aspect ratio survives brief, access token, upload session and worker queue', async (context) => {
  const api = await fixture(context);
  for (const aspectRatio of ['9:16', '1:1', '16:9']) {
    const created = await api.request('/api/jobs', { quickStart: true, processing: { mode: 'short', aspectRatio } });
    assert.equal(created.status, 201);
    const payload = await created.json();
    assert.equal(verifyToken(payload.token, secret, 'job').processing.aspectRatio, aspectRatio);
    assert.equal(api.objects.get(`.briefs/${payload.jobId}.json`).processing.aspectRatio, aspectRatio);
    await assertUploadRoundTrip(api, payload.token, aspectRatio);
  }
});

test('account project aspect ratio survives create, list, detail, renewed access and LONG queue', async (context) => {
  const api = await fixture(context);
  const cookie = await api.register();
  const headers = { Cookie: cookie };
  for (const aspectRatio of ['9:16', '1:1', '16:9']) {
    const created = await api.request('/api/projects', { title: aspectRatio, processing: { mode: 'long', aspectRatio } }, headers);
    assert.equal(created.status, 201);
    const payload = await created.json();
    assert.equal(payload.project.processing.aspectRatio, aspectRatio);
    assert.equal(api.objects.get(`.briefs/${payload.project.jobId}.json`).processing.aspectRatio, aspectRatio);
    const storedProject = [...api.store.projects.values()].find((project) => project.id === payload.project.id);
    assert.equal(storedProject.processing.aspectRatio, aspectRatio);
    const list = await api.request('/api/projects', undefined, headers);
    assert.equal((await list.json()).projects.find((project) => project.id === payload.project.id).processing.aspectRatio, aspectRatio);
    const detail = await api.request(`/api/projects/${payload.project.id}`, undefined, headers);
    assert.equal((await detail.json()).project.processing.aspectRatio, aspectRatio);
    const access = await api.request(`/api/projects/${payload.project.id}/access`, {}, headers);
    assert.equal(access.status, 200);
    const renewed = await access.json();
    assert.equal(renewed.project.processing.aspectRatio, aspectRatio);
    const job = verifyToken(renewed.jobToken, secret, 'job');
    assert.equal(job.processing.aspectRatio, aspectRatio);
    assert.equal(job.processing.mode, 'long');
    await assertUploadRoundTrip(api, renewed.jobToken, aspectRatio);
  }
});

test('signed-in legacy create and claim preserve an explicit aspect ratio', async (context) => {
  const api = await fixture(context);
  const cookie = await api.register();
  const headers = { Cookie: cookie };
  const created = await api.request('/api/jobs', { quickStart: true, processing: { aspectRatio: '16:9' } }, headers);
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.project.processing.aspectRatio, '16:9');
  assert.equal(verifyToken(payload.token, secret, 'job').processing.aspectRatio, '16:9');
  const guest = await api.request('/api/jobs', { quickStart: true, processing: { aspectRatio: '1:1' } });
  const claim = await api.request('/api/projects/claim', { jobToken: (await guest.json()).token }, headers);
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  assert.equal(claimed.project.processing.aspectRatio, '1:1');
  assert.equal(verifyToken(claimed.jobToken, secret, 'job').processing.aspectRatio, '1:1');
});

test('missing aspect ratio retains 9:16 for new jobs and legacy tokens', async (context) => {
  const api = await fixture(context);
  const created = await api.request('/api/jobs', { quickStart: true });
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(verifyToken(payload.token, secret, 'job').processing.aspectRatio, '9:16');
  const token = signToken({
    kind: 'job', jobId: 'web-legacyaspect', source: 'web', exp: Math.floor(Date.now() / 1000) + 600,
  }, secret);
  await assertUploadRoundTrip(api, token, '9:16');
});

test('invalid explicit ratios return 400 without creating brief or project on both creation APIs', async (context) => {
  const api = await fixture(context);
  const cookie = await api.register();
  const invalid = ['4:3', '9;16', '', ' 1:1 ', null, 1, ['1:1'], { ratio: '1:1' }];
  for (const path of ['/api/jobs', '/api/projects']) {
    for (const aspectRatio of invalid) {
      const response = await api.request(path, { quickStart: true, processing: { aspectRatio } }, {
        ...(path === '/api/projects' ? { Cookie: cookie } : {}),
      });
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(aspectRatio)}`);
      assert.match((await response.json()).error, /9:16, 1:1 или 16:9/);
    }
  }
  assert.equal(api.objects.size, 0);
  assert.equal(api.store.projects.size, 0);
  assert.equal(api.commands.some((command) => command.constructor.name === 'PutObjectCommand'), false);
});
