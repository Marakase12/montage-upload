import assert from 'node:assert/strict';
import test from 'node:test';
import { createPipelineRuntime, createTaskLock, LEASE_MS, publicPipelineStatus } from '../pipeline-runtime.js';
import { checkResultAvailability } from '../project-status.js';
import { createApp, signToken } from '../server.js';

const jobId = 'web-project01';
const taskId = 'task-fixture01';
const workerId = 'worker-process01';
const otherWorker = 'worker-process02';
const secret = 'test-pipeline-secret-not-production';

function fixture() {
  let clock = Date.now();
  const objects = new Map();
  const head = new Map();
  const writes = [];
  const taskKey = `.queue/${jobId}/${taskId}.json`;
  const statusKey = `.status/${jobId}/${taskId}.json`;
  const task = { jobId, taskId, objectKey: `${jobId}/clip.mp4`, fileName: 'clip.mp4', size: 100, createdAt: new Date(clock).toISOString() };
  objects.set(taskKey, task);
  objects.set(statusKey, { jobId, taskId, state: 'QUEUED', percent: 0, updatedAt: new Date(clock).toISOString() });
  head.set(task.objectKey, { ContentLength: 100, LastModified: new Date(clock) });
  const notFound = () => Object.assign(new Error('missing'), { name: 'NoSuchKey' });
  const s3 = { async send(command) {
    const { Key, Body, Prefix } = command.input;
    switch (command.constructor.name) {
      case 'GetObjectCommand': {
        if (!objects.has(Key)) throw notFound();
        return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } };
      }
      case 'PutObjectCommand': {
        objects.set(Key, JSON.parse(Body));
        head.set(Key, { ContentLength: Buffer.byteLength(Body), LastModified: new Date(clock) });
        writes.push(Key);
        return {};
      }
      case 'ListObjectsV2Command': return { Contents: [...objects.keys()].filter((key) => key.startsWith(Prefix))
        .map((key) => ({ Key: key, LastModified: head.get(key)?.LastModified ?? new Date(clock) })) };
      case 'HeadObjectCommand': { if (!head.has(Key)) throw notFound(); return head.get(Key); }
      default: return {};
    }
  } };
  const withLock = createTaskLock(null, { allowMemory: true });
  const now = () => clock;
  const runtime = createPipelineRuntime({ s3, bucket: 'test', withLock, now });
  const getStatus = () => objects.get(statusKey);
  const setStatus = (values) => objects.set(statusKey, { ...getStatus(), ...values });
  const credentials = (claim, owner = workerId) => ({ workerId: owner, leaseId: claim.leaseId, leaseToken: claim.leaseToken });
  return { runtime, s3, objects, head, writes, now, withLock, task, taskKey, statusKey, getStatus, setStatus, credentials,
    advance: (amount) => { clock += amount; } };
}

test('lease heartbeat protects a long stage; expired initial lease recovers with a new fence', async () => {
  const f = fixture();
  const first = await f.runtime.claim(jobId, taskId, workerId);
  f.advance(LEASE_MS - 1000);
  await f.runtime.heartbeat({ workerId, phase: 'busy', activeTask: { jobId, taskId, ...f.credentials(first) } });
  f.advance(2000);
  assert.equal(f.runtime.recoverable(f.getStatus()), false);
  await assert.rejects(f.runtime.claim(jobId, taskId, otherWorker), { status: 409 });
  f.advance(LEASE_MS);
  assert.equal(f.runtime.recoverable(f.getStatus()), true);
  const next = await f.runtime.claim(jobId, taskId, otherWorker);
  assert.notEqual(next.leaseId, first.leaseId);
  await assert.rejects(f.runtime.update(jobId, taskId, f.credentials(first), { state: 'FAILED' }), { status: 409 });
  await assert.rejects(f.runtime.resultUpload(jobId, taskId, f.credentials(first)), { status: 409 });
  await assert.rejects(f.runtime.heartbeat({ workerId, activeTask: { jobId, taskId, ...f.credentials(first) } }), { status: 409 });
  assert.match(await f.runtime.resultUpload(jobId, taskId, f.credentials(next, otherWorker)), new RegExp(`${next.leaseId}\\.mp4$`));
});

test('concurrent claims have one owner; same owner claim retry is idempotent', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.runtime.claim(jobId, taskId, workerId), f.runtime.claim(jobId, taskId, otherWorker)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const first = results[0].value;
  const retry = await f.runtime.claim(jobId, taskId, workerId);
  assert.equal(retry.leaseId, first.leaseId);
  assert.equal(retry.leaseToken, first.leaseToken);
});

test('manual retry accepts only FAILED, verifies source and coalesces concurrent duplicate retries', async () => {
  const f = fixture();
  f.setStatus({ state: 'FAILED', operationType: 'INITIAL' });
  assert.equal((await f.runtime.retryInfo(jobId, taskId, f.getStatus())).retryable, true);
  const [first, second] = await Promise.all([f.runtime.retry(jobId, taskId), f.runtime.retry(jobId, taskId)]);
  assert.equal(first.alreadyQueued, false);
  assert.equal(second.alreadyQueued, true);
  assert.equal(f.getStatus().retryCount, 1);
  assert.equal(f.getStatus().state, 'QUEUED');
  await f.runtime.claim(jobId, taskId, workerId);
  assert.equal((await f.runtime.retry(jobId, taskId)).alreadyQueued, true);
});

test('retry rejects foreign task, missing/expired source, terminal result and actions', async () => {
  const f = fixture();
  await assert.rejects(f.runtime.retry('web-foreign01', taskId), { status: 409 });
  for (const state of ['QUEUED', 'PROCESSING', 'READY_FOR_REVIEW', 'APPROVED', 'LONG_CANDIDATES_READY']) {
    f.setStatus({ state });
    await assert.rejects(f.runtime.retry(jobId, taskId), { status: 409 });
  }
  f.setStatus({ state: 'FAILED' });
  const source = f.head.get(f.task.objectKey);
  f.head.delete(f.task.objectKey);
  await assert.rejects(f.runtime.retry(jobId, taskId), { status: 409 });
  f.head.set(f.task.objectKey, source);
  f.advance(25 * 3_600_000);
  await assert.rejects(f.runtime.retry(jobId, taskId), { status: 410 });
  const actions = fixture();
  actions.setStatus({ state: 'FAILED', operationType: 'REVISION' });
  await assert.rejects(actions.runtime.retry(jobId, taskId), { status: 409 });
  actions.setStatus({ operationType: 'INITIAL' });
  actions.objects.set(`.actions/${jobId}/action-failed01.json`, { taskId, state: 'FAILED' });
  await assert.rejects(actions.runtime.retry(jobId, taskId), { status: 409 });
});

test('legacy PROCESSING and all action processing states never auto-recover', async () => {
  const f = fixture();
  f.setStatus({ state: 'PROCESSING', updatedAt: '2020-01-01T00:00:00Z' });
  assert.equal(f.runtime.recoverable(f.getStatus()), false);
  await assert.rejects(f.runtime.claim(jobId, taskId, workerId), { status: 409 });
  for (const operationType of ['REVISION', 'APPROVE']) {
    f.setStatus({ operationType, lease: { expiresAt: '2020-01-01T00:00:00Z' } });
    assert.equal(f.runtime.recoverable(f.getStatus()), false);
  }
});

test('automatic initial recovery is capped at three attempts; explicit retry resets the allowance', async () => {
  const f = fixture();
  for (let index = 0; index < 3; index += 1) {
    await f.runtime.claim(jobId, taskId, workerId);
    assert.equal(f.getStatus().attemptCount, index + 1);
    f.advance(LEASE_MS + 1);
  }
  await assert.rejects(f.runtime.claim(jobId, taskId, workerId), { status: 409 });
  assert.equal(f.getStatus().state, 'FAILED');
  assert.equal(f.getStatus().stage, 'recovery_limit');
  await f.runtime.retry(jobId, taskId);
  await f.runtime.claim(jobId, taskId, workerId);
  assert.equal(f.getStatus().attemptCount, 1);
});

test('terminal completion retry is idempotent; late failure cannot overwrite confirmed result', async () => {
  const f = fixture();
  const claim = await f.runtime.claim(jobId, taskId, workerId);
  const body = f.credentials(claim);
  const resultKey = await f.runtime.resultUpload(jobId, taskId, body);
  const ready = await f.runtime.update(jobId, taskId, body, { state: 'READY_FOR_REVIEW', resultKey, percent: 100 });
  f.advance(LEASE_MS * 2);
  assert.deepEqual(await f.runtime.update(jobId, taskId, body, { state: 'READY_FOR_REVIEW', resultKey, percent: 100 }), ready);
  await assert.rejects(f.runtime.update(jobId, taskId, body, { state: 'FAILED', resultKey: null }), { status: 409 });
  assert.equal('lease' in ready, false);
  assert.equal(JSON.stringify(publicPipelineStatus(f.getStatus())).includes(claim.leaseToken), false);
  f.head.set(resultKey, { ContentLength: 200, LastModified: new Date(f.now()) });
  assert.equal((await checkResultAvailability({ s3: f.s3, bucket: 'test', status: f.getStatus(), jobId, now: f.now() })).state, 'AVAILABLE');
  assert.equal((await checkResultAvailability({ s3: f.s3, bucket: 'test', status: { ...f.getStatus(), resultAttemptId: 'f'.repeat(32) }, jobId, now: f.now() })).state, 'MISSING');
});

test('heartbeat exposes only sanitized online/offline state, independent of progress updates', async () => {
  const f = fixture();
  assert.equal((await f.runtime.worker()).state, 'OFFLINE');
  await f.runtime.heartbeat({ workerId, phase: 'busy' });
  f.advance(5001);
  assert.deepEqual(Object.keys(await f.runtime.worker()).sort(), ['lastSeenAt', 'phase', 'state']);
  assert.equal((await f.runtime.worker()).state, 'ONLINE');
  f.advance(60_000);
  assert.equal((await f.runtime.worker()).state, 'OFFLINE');
});

test('production lock uses database transaction lock and fails closed without a database', async () => {
  const queries = [];
  const pool = { async connect() { return { async query(sql, params) { queries.push({ sql, params }); }, release() { queries.push({ sql: 'release' }); } }; } };
  await createTaskLock(pool)('job:task', async () => { queries.push({ sql: 'mutation' }); });
  assert.match(queries[2].sql, /pg_advisory_xact_lock/);
  assert.equal(queries[3].sql, 'mutation');
  assert.equal(queries[4].sql, 'COMMIT');
  await assert.rejects(createTaskLock(null)('job:task', async () => {}), { status: 503 });
});

test('HTTP retry is project-token scoped and pipeline never leaks lease credentials', async (context) => {
  const f = fixture();
  f.setStatus({ state: 'FAILED' });
  const app = createApp({ env: { TOKEN_SECRET: secret, WORKER_SECRET: secret, S3_BUCKET: 'test' },
    s3: f.s3, accountStore: null, pipelineLock: f.withLock, pipelineNow: f.now });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = (id) => signToken({ kind: 'job', jobId: id, exp: Math.floor(Date.now() / 1000) + 600 }, secret);
  const call = (path, id = jobId, method = 'POST') => fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token(id)}` } });
  assert.equal((await call(`/api/pipeline/${taskId}/retry`, 'web-foreign01')).status, 409);
  const accepted = await call(`/api/pipeline/${taskId}/retry`);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status.state, 'QUEUED');
  const claim = await f.runtime.claim(jobId, taskId, workerId);
  const pipeline = await call('/api/pipeline', jobId, 'GET');
  const body = await pipeline.json();
  assert.equal(body.worker.state, 'OFFLINE');
  assert.equal(JSON.stringify(body).includes(claim.leaseToken), false);
});

test('APPROVE preserves the exact previous result; REVISION writes a fenced new result and is never replayed', async (context) => {
  const f = fixture();
  const oldResultKey = `.results/${jobId}/${taskId}.mp4`;
  f.setStatus({ state: 'READY_FOR_REVIEW', localJobId: 'local-job0001', resultKey: oldResultKey });
  f.head.set(oldResultKey, { ContentLength: 200, LastModified: new Date(f.now()) });
  const app = createApp({ env: { TOKEN_SECRET: secret, WORKER_SECRET: secret, S3_BUCKET: 'test' },
    s3: f.s3, accountStore: null, pipelineLock: f.withLock, pipelineNow: f.now,
    getSignedUrl: async (_s3, command) => `https://example.invalid/${command.input.Key}` });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = signToken({ kind: 'job', jobId, exp: Math.floor(Date.now() / 1000) + 600 }, secret);
  async function request(path, body, worker = false) {
    const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(worker ? { 'X-Worker-Secret': secret } : { Authorization: `Bearer ${token}` }) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const approved = await request(`/api/pipeline/${taskId}/actions`, { kind: 'APPROVE', confirmation: 'APPROVE' });
  assert.equal(approved.status, 202);
  const approveId = approved.body.action.actionId;
  assert.equal((await request(`/api/worker/actions/${approveId}/claim`, { jobId, workerId }, true)).status, 200);
  assert.equal(f.getStatus().state, 'PROCESSING');
  const approveFields = { jobId, workerId, actionId: approveId };
  assert.equal((await request(`/api/worker/tasks/${taskId}/result-upload`, approveFields, true)).status, 409);
  const statusFields = { ...approveFields, state: 'APPROVED', percent: 100, resultKey: oldResultKey, localJobId: 'local-job0001' };
  assert.equal((await request(`/api/worker/tasks/${taskId}/status`, statusFields, true)).status, 200);
  assert.equal((await request(`/api/worker/tasks/${taskId}/status`, statusFields, true)).status, 200);
  assert.equal(f.getStatus().resultKey, oldResultKey);
  assert.equal(f.getStatus().resultAttemptId, null);
  assert.equal((await request(`/api/worker/actions/${approveId}/complete`, { ...approveFields, state: 'COMPLETE' }, true)).status, 200);
  assert.equal((await request(`/api/worker/actions/${approveId}/complete`, { ...approveFields, state: 'COMPLETE' }, true)).status, 200);

  const revision = await request(`/api/pipeline/${taskId}/actions`, { kind: 'REVISION', requestText: 'Убери хук' });
  assert.equal(revision.status, 202);
  const actionId = revision.body.action.actionId;
  assert.equal((await request(`/api/worker/actions/${actionId}/claim`, { jobId, workerId }, true)).status, 200);
  f.advance(3 * 3_600_000);
  const pending = await request('/api/worker/actions', undefined, true);
  assert.equal(pending.body.actions.some((action) => action.actionId === actionId), false);
  assert.equal((await request(`/api/worker/actions/${actionId}/claim`, { jobId, workerId: otherWorker }, true)).status, 409);
  const actionFields = { jobId, workerId, actionId };
  const upload = await request(`/api/worker/tasks/${taskId}/result-upload`, actionFields, true);
  assert.equal(upload.status, 200);
  assert.notEqual(upload.body.resultKey, oldResultKey);
  assert.match(upload.body.resultKey, new RegExp(`${actionId.replaceAll('-', '')}\\.mp4$`));
  f.head.set(upload.body.resultKey, { ContentLength: 220, LastModified: new Date(f.now()) });
  const ready = await request(`/api/worker/tasks/${taskId}/status`, { ...actionFields, state: 'READY_FOR_REVIEW', percent: 100,
    resultKey: upload.body.resultKey, localJobId: 'local-job0001' }, true);
  assert.equal(ready.status, 200);
  assert.equal((await request(`/api/worker/actions/${actionId}/complete`, { ...actionFields, state: 'FAILED', detail: 'ambiguous response' }, true)).status, 200);
  assert.equal(f.getStatus().state, 'READY_FOR_REVIEW');
  assert.equal((await checkResultAvailability({ s3: f.s3, bucket: 'test', status: f.getStatus(), jobId, now: f.now() })).state, 'AVAILABLE');
});
