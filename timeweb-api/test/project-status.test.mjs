import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectStatusReader } from '../project-status.js';
import { MemoryAccountStore } from '../accounts.js';
import { createApp, signToken } from '../server.js';

const now = Date.parse('2026-09-22T12:00:00Z');
const recent = new Date(now - 60_000);
const expired = new Date(now - 25 * 60 * 60_000);
const jobId = 'web-project1234';
const taskId = 'task-first1234';

function mockStorage({ statuses = [], results = {}, sources = [], truncated = false, failure = null } = {}) {
  const calls = [];
  const s3 = { async send(command) {
    calls.push(command);
    if (failure) throw failure;
    const { Key, Prefix } = command.input;
    switch (command.constructor.name) {
      case 'ListObjectsV2Command':
        if (Prefix.startsWith('.status/')) return {
          IsTruncated: truncated,
          Contents: statuses.filter((item) => `.status/${item.jobId}/${item.taskId}.json`.startsWith(Prefix))
            .map((item) => ({ Key: `.status/${item.jobId}/${item.taskId}.json`, LastModified: item.modifiedAt ?? recent })),
        };
        return { Contents: sources.filter((item) => item.Key.startsWith(Prefix)) };
      case 'GetObjectCommand': {
        const value = statuses.find((item) => Key === `.status/${item.jobId}/${item.taskId}.json`);
        if (!value) throw Object.assign(new Error(), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => JSON.stringify(value) } };
      }
      case 'HeadObjectCommand':
        if (!(Key in results)) throw Object.assign(new Error(), { name: 'NotFound' });
        if (results[Key] instanceof Error) throw results[Key];
        return results[Key];
      default: return {};
    }
  } };
  return { s3, calls };
}

function status(overrides = {}) {
  return {
    jobId, taskId, state: 'READY_FOR_REVIEW', percent: 100,
    updatedAt: recent.toISOString(), resultKey: `.results/${jobId}/${taskId}.mp4`,
    ...overrides,
  };
}

async function summary(storage, project = {}) {
  const reader = createProjectStatusReader({ s3: storage.s3, bucket: 'test', now: () => now });
  const [result] = await reader.enrich([{ jobId, createdAt: recent.toISOString(), ...project }]);
  assert.equal(result.state, result.summary.state);
  assert.equal(result.percent, result.summary.percent);
  assert.equal(result.detail, result.summary.detail);
  return result.summary;
}

test('summary aggregates verified results and active tasks without marking the entire project ready', async () => {
  const stored = status();
  const storage = mockStorage({
    statuses: [stored, status({ taskId: 'task-second1234', state: 'PROCESSING', percent: 40, detail: 'Создаю субтитры' })],
    results: { [stored.resultKey]: { ContentLength: 1024, LastModified: recent } },
  });
  const result = await summary(storage);
  assert.equal(result.state, 'PROCESSING');
  assert.equal(result.percent, 70);
  assert.equal(result.taskCount, 2);
  assert.equal(result.readyCount, 1);
  assert.match(result.detail, /Создаю субтитры/);
  assert.equal(result.retention.state, 'ACTIVE');
  assert.equal(JSON.stringify(result).includes('.results'), false);
  assert.equal(JSON.stringify(result).includes('http'), false);
});

test('missing, empty and cross-project result objects never count as ready', async () => {
  for (const options of [
    {},
    { results: { [status().resultKey]: { ContentLength: 0, LastModified: recent } } },
    { statuses: [status({ resultKey: '.results/web-other5678/task-first1234.mp4' })] },
  ]) {
    const storage = mockStorage({ statuses: [status()], ...options });
    const result = await summary(storage);
    assert.equal(result.state, 'UNAVAILABLE');
    assert.equal(result.readyCount, 0);
    assert.equal(result.percent, null);
    assert.equal(result.retention.state, 'MISSING');
    assert.ok(storage.calls.every((call) => !call.input.Key?.includes('web-other5678')));
  }
});

test('expired result or status is explicit; LONG candidates are not downloadable ready videos', async () => {
  for (const options of [
    { statuses: [status({ modifiedAt: expired })] },
    { results: { [status().resultKey]: { ContentLength: 1024, LastModified: expired } } },
  ]) {
    const result = await summary(mockStorage({ statuses: [status()], ...options }));
    assert.equal(result.state, 'EXPIRED');
    assert.equal(result.readyCount, 0);
    assert.equal(result.retention.state, 'EXPIRED');
  }
  const result = await summary(mockStorage({ statuses: [status({
    state: 'LONG_CANDIDATES_READY', resultKey: null, candidates: [{ title: 'One' }, { title: 'Two' }],
  })] }));
  assert.equal(result.state, 'LONG_CANDIDATES_READY');
  assert.equal(result.readyCount, 0);
  assert.equal(result.candidateCount, 2);
});

test('empty metadata differs from a received source and an expired archive', async () => {
  assert.equal((await summary(mockStorage())).state, 'CREATED');
  assert.equal((await summary(mockStorage(), { createdAt: expired.toISOString() })).state, 'EXPIRED');
  const result = await summary(mockStorage({ sources: [{ Key: `${jobId}/source.mp4`, LastModified: recent }] }));
  assert.equal(result.state, 'UPLOADED');
  assert.equal(result.readyCount, 0);
  const multiple = await summary(mockStorage({ sources: [
    { Key: `${jobId}/old.mp4`, LastModified: expired },
    { Key: `${jobId}/new.mp4`, LastModified: recent },
  ] }));
  assert.equal(multiple.state, 'UPLOADED');
  assert.equal(multiple.retention.state, 'ACTIVE');
});

test('storage failure and truncated scans are unknown, not false processing failures or ready results', async () => {
  for (const storage of [mockStorage({ failure: new Error('offline') }), mockStorage({ truncated: true })]) {
    const result = await summary(storage);
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(result.percent, null);
    assert.equal(result.incomplete, true);
  }
});

test('project enrichment limits work, preserves all metadata and caches short-lived summaries', async () => {
  const storage = mockStorage();
  let time = now;
  const reader = createProjectStatusReader({ s3: storage.s3, bucket: 'test', now: () => time });
  const projects = Array.from({ length: 30 }, (_, index) => ({ jobId: `web-project${index}`, createdAt: recent.toISOString() }));
  const first = await reader.enrich(projects);
  assert.equal(first.length, 30);
  assert.equal(first.filter((item) => item.state === 'CREATED').length, 20);
  assert.equal(first[29].state, 'UNKNOWN');
  assert.equal(storage.calls.length, 40);
  assert.ok(storage.calls.every((call) => call.input.Prefix && call.input.MaxKeys <= 20));
  await reader.enrich(projects);
  assert.equal(storage.calls.length, 40);
  const selected = await reader.enrich([projects[29]], { all: true });
  assert.equal(selected[0].state, 'CREATED');
  time += 10_001;
  await reader.enrich([projects[0]]);
  assert.equal(storage.calls.length, 44);
});

test('account project summaries inspect only authenticated owner prefixes and hide foreign IDs', async (context) => {
  const store = new MemoryAccountStore();
  const storage = mockStorage();
  const app = createApp({
    env: { NODE_ENV: 'test', TOKEN_SECRET: 'test-secret-long-enough', S3_BUCKET: 'test' },
    accountStore: store, s3: storage.s3,
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const register = async (email) => {
    const response = await fetch(`${origin}/api/auth/register`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery staple', displayName: 'Test' }),
    });
    assert.equal(response.status, 201);
    return { ...(await response.json()), cookie: response.headers.get('set-cookie').split(';', 1)[0] };
  };
  const owner = await register('status-owner@example.com');
  const other = await register('status-other@example.com');
  await store.createProject({ id: 'project-owner123', userId: owner.user.id, jobId, createdAt: recent.toISOString() });
  await store.createProject({ id: 'project-other123', userId: other.user.id, jobId: 'web-private1234', createdAt: recent.toISOString() });
  const list = await fetch(`${origin}/api/projects`, { headers: { Cookie: owner.cookie } });
  assert.equal(list.status, 200);
  const payload = await list.json();
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].jobId, jobId);
  assert.ok(payload.projects[0].summary);
  const hidden = await fetch(`${origin}/api/projects/project-other123`, { headers: { Cookie: owner.cookie } });
  assert.equal(hidden.status, 404);
  assert.ok(storage.calls.filter((call) => call.input.Prefix).every((call) => call.input.Prefix.includes(jobId)));
});

test('pipeline withholds URLs for missing, expired, unverified and cross-project artifacts without altering stored state', async (context) => {
  const current = new Date();
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  const statuses = [
    status({ taskId: 'task-missing01' }),
    status({ taskId: 'task-expired01' }),
    status({ taskId: 'task-unknown01' }),
    status({ taskId: 'task-other0001', resultKey: '.results/web-private1234/task-other0001.mp4' }),
    status({ taskId: 'task-zero00001' }),
    status({ taskId: 'task-ready0001' }),
  ].map((item) => ({
    ...item, updatedAt: current.toISOString(), modifiedAt: current,
    resultKey: item.taskId === 'task-other0001' ? item.resultKey : `.results/${jobId}/${item.taskId}.mp4`,
    // Even stale URLs embedded in old artifacts must not escape verification.
    previewUrl: 'https://unverified.example/preview', downloadUrl: 'https://unverified.example/download',
  }));
  const storage = mockStorage({ statuses, results: {
    [statuses[1].resultKey]: { ContentLength: 1024, LastModified: old },
    [statuses[2].resultKey]: new Error('network failure'),
    [statuses[4].resultKey]: { ContentLength: 0, LastModified: current },
    [statuses[5].resultKey]: { ContentLength: 1024, LastModified: current },
  } });
  const signed = [];
  const secret = 'test-secret-long-enough';
  const app = createApp({
    env: { TOKEN_SECRET: secret, S3_BUCKET: 'test' }, s3: storage.s3,
    getSignedUrl: async (_s3, command) => {
      signed.push(command.input.Key);
      return 'https://verified.example/result';
    },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const token = signToken({ kind: 'job', jobId, exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pipeline`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { tasks } = await response.json();
  const expected = ['MISSING', 'EXPIRED', 'UNKNOWN', 'MISSING', 'MISSING', 'AVAILABLE'];
  for (const [index, item] of statuses.entries()) {
    const task = tasks.find((candidate) => candidate.taskId === item.taskId);
    assert.equal(task.state, 'READY_FOR_REVIEW');
    assert.equal(task.resultAvailability, expected[index]);
    if (expected[index] === 'AVAILABLE') {
      assert.equal(task.previewUrl, 'https://verified.example/result');
      assert.equal(task.downloadUrl, 'https://verified.example/result');
      assert.ok(task.resultExpiresAt);
    } else {
      assert.equal(task.previewUrl, undefined);
      assert.equal(task.downloadUrl, undefined);
      assert.ok(task.resultUnavailableReason);
    }
  }
  assert.deepEqual(signed, [statuses[5].resultKey, statuses[5].resultKey]);
  assert.equal(storage.calls.some((call) => call.constructor.name === 'PutObjectCommand'), false);
  assert.equal(storage.calls.some((call) => call.input.Key?.includes('web-private1234')), false);
});
