import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server.js';

const jobId = 'web-protocol01';
const taskId = 'task-protocol01';
const actionId = 'action-protocol01';
const workerId = 'worker-protocol01';
const workerSecret = 'local-protocol-test-secret';

async function fixture(context, { action = false } = {}) {
  const now = new Date();
  const statusKey = `.status/${jobId}/${taskId}.json`;
  const objects = new Map([
    [`.queue/${jobId}/${taskId}.json`, { jobId, taskId, objectKey: `${jobId}/source.mp4`, size: 123, createdAt: now.toISOString() }],
    [statusKey, { jobId, taskId, state: action ? 'READY_FOR_REVIEW' : 'QUEUED' }],
  ]);
  if (action) objects.set(`.actions/${jobId}/${actionId}.json`, {
    jobId, taskId, actionId, kind: 'REVISION', state: 'PENDING', createdAt: now.toISOString(),
  });
  const commands = [];
  let lockCalls = 0;
  const app = createApp({
    env: { NODE_ENV: 'test', S3_BUCKET: 'test-bucket', WORKER_SECRET: workerSecret, TOKEN_SECRET: 'local-protocol-token-secret' },
    accountStore: null,
    pipelineLock: async (key, callback) => { lockCalls++; return callback(); },
    getSignedUrl: async () => 'https://synthetic.invalid/source',
    s3: { async send(command) {
      commands.push(command.constructor.name);
      const { Key, Body, Prefix } = command.input;
      switch (command.constructor.name) {
        case 'GetObjectCommand':
          if (!objects.has(Key)) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
          return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } };
        case 'PutObjectCommand': objects.set(Key, JSON.parse(Body)); return {};
        case 'HeadObjectCommand': return { ContentLength: 123, LastModified: now };
        case 'ListObjectsV2Command': return { Contents: [...objects.keys()].filter((key) => key.startsWith(Prefix)).map((key) => ({ Key: key })) };
        default: throw new Error('Unexpected storage command');
      }
    } },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const claimPath = action ? `/api/worker/actions/${actionId}/claim` : `/api/worker/tasks/${taskId}/claim`;
  const request = async (path, body, secret = workerSecret) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Worker-Secret': secret, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, claimPath, commands, objects, statusKey, lockCalls: () => lockCalls };
}

for (const action of [false, true]) {
  const kind = action ? 'action' : 'initial task';
  test(`${kind} claim rejects missing, old and non-numeric bridge versions before storage/lock calls`, async (context) => {
    const f = await fixture(context, { action });
    const before = structuredClone([...f.objects]);
    for (const version of [undefined, null, 0, 1, 2, -1, '3', true, {}, [], 3.1]) {
      const body = { jobId, workerId, ...(version === undefined ? {} : { bridgeVersion: version }) };
      const result = await f.request(f.claimPath, body);
      assert.equal(result.status, 426, `version=${JSON.stringify(version)}`);
      assert.equal(result.body.code, 'WORKER_UPGRADE_REQUIRED');
      assert.match(result.body.error, /версии 3/);
    }
    assert.equal(f.commands.length, 0);
    assert.equal(f.lockCalls(), 0);
    assert.deepEqual([...f.objects], before);
    const unauthorized = await f.request(f.claimPath, { jobId, workerId, bridgeVersion: 3 }, 'wrong-worker-secret');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, undefined);
    assert.equal(f.commands.length, 0);
  });

  for (const bridgeVersion of [3, 4]) {
    test(`${kind} claim accepts bridge version ${bridgeVersion}`, async (context) => {
      const f = await fixture(context, { action });
      const result = await f.request(f.claimPath, { jobId, workerId, bridgeVersion });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(f.objects.get(f.statusKey).state, 'PROCESSING');
      assert.ok(f.lockCalls() > 0);
      assert.ok(f.commands.includes('PutObjectCommand'));
    });
  }
}

test('heartbeat and finishing an already claimed initial task do not require bridgeVersion', async (context) => {
  const f = await fixture(context);
  const claim = await f.request(f.claimPath, { jobId, workerId, bridgeVersion: 3 });
  assert.equal(claim.status, 200);
  const credentials = { jobId, workerId, leaseId: claim.body.leaseId, leaseToken: claim.body.leaseToken };
  const heartbeat = await f.request('/api/worker/heartbeat', { workerId, phase: 'busy', activeTask: { ...credentials, taskId } });
  assert.equal(heartbeat.status, 200);
  const completed = await f.request(`/api/worker/tasks/${taskId}/status`, {
    ...credentials, state: 'FAILED', percent: 0, stage: 'test', detail: 'Synthetic completion',
  });
  assert.equal(completed.status, 200);
  assert.equal(f.objects.get(f.statusKey).state, 'FAILED');
});

test('finishing an already claimed action does not require bridgeVersion', async (context) => {
  const f = await fixture(context, { action: true });
  const claim = await f.request(f.claimPath, { jobId, workerId, bridgeVersion: 3 });
  assert.equal(claim.status, 200);
  const completed = await f.request(`/api/worker/actions/${actionId}/complete`, { jobId, workerId, state: 'FAILED', detail: 'Synthetic completion' });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.action.state, 'FAILED');
});

test('health advertises smart-edit release and minimum owner-aware bridge protocol', async (context) => {
  const f = await fixture(context);
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.release, 'studio-20260922-smart-edit-v2');
  assert.equal(health.body.smartEditProposalsVersion, 1);
  assert.equal(health.body.speechCleanupProposalsVersion, 1);
  assert.equal(health.body.minimumBridgeVersion, 3);
  assert.equal(health.body.ownerIsolationVersion, 1);
});
