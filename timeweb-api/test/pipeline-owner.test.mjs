import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAccountStore } from '../accounts.js';
import { createApp, signToken, verifyToken } from '../server.js';
import {
  assertPipelineOwnerAccess,
  normalizePipelineOwner,
  ownerFromJobAccess,
  ownerFromTask,
} from '../pipeline-owner.js';

const SECRET = 'synthetic-owner-tests-not-a-real-key';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

test('owner identity is account UUID or exact guest project, never a client username', () => {
  assert.deepEqual(ownerFromJobAccess({ jobId: 'web-project01', source: 'account', userId: USER_A,
    owner: { kind: 'account', id: USER_B } }), { kind: 'account', id: USER_A });
  assert.deepEqual(ownerFromJobAccess({ jobId: 'web-project01', source: 'web', userId: USER_A }),
    { kind: 'guest', id: 'web-project01' });
  assert.deepEqual(ownerFromTask({ jobId: 'web-project01', taskId: 'task-00000001', source: 'account', userId: USER_A },
    'web-project01', 'task-00000001'), { kind: 'guest', id: 'web-project01' });
  for (const owner of [null, {}, [], 'marakase', { kind: 'telegram', id: 'marakase' },
    { kind: 'account', id: '../marakase' }, { kind: 'guest', id: 'web-someone-else' }]) {
    assert.throws(() => normalizePipelineOwner(owner, 'web-project01'));
  }
  assert.throws(() => ownerFromJobAccess({ jobId: '../secret', source: 'web' }));
  assert.throws(() => ownerFromJobAccess({ jobId: 'web-project01', source: 'account' }));
  assert.throws(() => ownerFromTask({ jobId: 'web-project01', taskId: 'task-00000002' },
    'web-project01', 'task-00000001'));
  assert.deepEqual(assertPipelineOwnerAccess(
    { kind: 'account', id: USER_A }, { kind: 'account', id: USER_A }, 'web-project01',
  ), { kind: 'account', id: USER_A });
  assert.deepEqual(assertPipelineOwnerAccess(
    { kind: 'account', id: USER_A }, { kind: 'guest', id: 'web-project01' }, 'web-project01',
  ), { kind: 'guest', id: 'web-project01' });
  assert.throws(() => assertPipelineOwnerAccess(
    { kind: 'guest', id: 'web-project01' }, { kind: 'account', id: USER_A }, 'web-project01',
  ));
  assert.throws(() => assertPipelineOwnerAccess(
    { kind: 'account', id: USER_B }, { kind: 'account', id: USER_A }, 'web-project01',
  ));
});

async function fixture(context, options = {}) {
  const objects = new Map();
  const commands = [];
  const store = options.store ?? new MemoryAccountStore();
  const app = createApp({
    env: { TOKEN_SECRET: SECRET, WORKER_SECRET: 'owner-test-worker', S3_BUCKET: 'synthetic' },
    accountStore: store,
    getSignedUrl: async () => 'https://example.invalid/synthetic',
    s3: { async send(command) {
      commands.push(command.constructor.name);
      const { Key, Prefix = '', Body } = command.input;
      switch (command.constructor.name) {
        case 'PutObjectCommand': objects.set(Key, JSON.parse(Body)); return {};
        case 'GetObjectCommand':
          if (!objects.has(Key)) throw Object.assign(new Error('Missing synthetic object'), { name: 'NoSuchKey' });
          return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } };
        case 'ListObjectsV2Command': return { Contents: [...objects.keys()]
          .filter(key => key.startsWith(Prefix)).map(Key => ({ Key, LastModified: new Date() })) };
        case 'CreateMultipartUploadCommand': return { UploadId: 'synthetic-multipart' };
        case 'ListPartsCommand': return { Parts: [{ ETag: '"part"', PartNumber: 1 }] };
        case 'HeadObjectCommand': return { ContentLength: 127, LastModified: new Date() };
        default: return {};
      }
    } },
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}, method) => fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Origin: base, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function register(email) {
    const response = await request('/api/auth/register', { email, displayName: 'Owner Test', password: 'strong synthetic owner password' });
    assert.equal(response.status, 201);
    return { user: (await response.json()).user, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
  }
  async function create(cookie, spoof = {}) {
    const response = await request(cookie ? '/api/projects' : '/api/jobs', {
      quickStart: true, title: 'Synthetic isolation test', ...spoof,
    }, cookie ? { Cookie: cookie } : {});
    assert.equal(response.status, 201);
    return response.json();
  }
  async function upload(token, spoof = {}) {
    const auth = { Authorization: `Bearer ${token}` };
    const response = await request('/api/uploads', { name: 'synthetic.mp4', size: 127, ...spoof }, auth);
    assert.equal(response.status, 201);
    const session = await response.json();
    const complete = await request(`/api/uploads/${session.uploadId}/complete`, spoof, {
      ...auth, 'X-Upload-Session': session.sessionToken,
    });
    assert.equal(complete.status, 200);
    const job = verifyToken(token, SECRET, 'job');
    return { session, task: objects.get(`.queue/${job.jobId}/${session.uploadId}.json`), auth };
  }
  function ready(task) {
    objects.set(`.status/${task.jobId}/${task.taskId}.json`, {
      jobId: task.jobId, taskId: task.taskId, localJobId: 'synthetic_local_job',
      state: 'READY_FOR_REVIEW', resultKey: `.results/${task.jobId}/${task.taskId}.mp4`, updatedAt: new Date().toISOString(),
    });
  }
  return { objects, commands, request, register, create, upload, ready, store };
}

test('two accounts get separate trusted owners; one account has one owner across projects', async context => {
  const api = await fixture(context);
  const a = await api.register('owner-a@example.invalid');
  const b = await api.register('owner-b@example.invalid');
  const owners = [];
  for (const account of [a, a, b]) {
    const spoof = { userId: USER_A, owner: { kind: 'account', id: USER_A }, username: 'marakase' };
    const created = await api.create(account.cookie, spoof);
    const { task, session, auth } = await api.upload(created.token, spoof);
    const expected = { kind: 'account', id: account.user.id };
    assert.deepEqual(verifyToken(session.sessionToken, SECRET, 'session').owner, expected);
    assert.deepEqual(task.owner, expected);
    owners.push(task.owner);
    const denied = await api.request(`/api/projects/${created.project.id}/access`, {}, {
      Cookie: account === a ? b.cookie : a.cookie,
    });
    assert.equal(denied.status, 404);
    api.ready(task);
    const action = await api.request(`/api/pipeline/${task.taskId}/actions`, {
      kind: 'REVISION', requestText: 'Музыку тише и запомни', ...spoof,
    }, auth);
    assert.equal(action.status, 202);
    assert.deepEqual((await action.json()).action.owner, expected);
  }
  assert.deepEqual(owners[0], owners[1]);
  assert.notDeepEqual(owners[0], owners[2]);
});

test('guest owners stay project-scoped, including after account claim', async context => {
  const api = await fixture(context);
  const first = await api.create();
  const second = await api.create();
  const one = await api.upload(first.token);
  const two = await api.upload(second.token);
  const resumable = await api.request('/api/uploads', {
    name: 'resume-before-claim.mp4', size: 127, lastModified: 123,
  }, { Authorization: `Bearer ${first.token}` });
  assert.equal(resumable.status, 201);
  const resumableSession = await resumable.json();
  assert.deepEqual(one.task.owner, { kind: 'guest', id: first.jobId });
  assert.notDeepEqual(one.task.owner, two.task.owner);
  const account = await api.register('claim-owner@example.invalid');
  const claimed = await api.request('/api/projects/claim', { jobToken: first.token }, { Cookie: account.cookie });
  assert.equal(claimed.status, 201);
  const claimedToken = (await claimed.json()).jobToken;
  const resumedByAccount = await api.request('/api/uploads', {
    name: 'resume-before-claim.mp4', size: 127, lastModified: 123,
    resumeSession: resumableSession.sessionToken,
  }, { Authorization: `Bearer ${claimedToken}` });
  assert.equal(resumedByAccount.status, 200);
  assert.equal((await resumedByAccount.json()).resumed, true);
  api.ready(one.task);
  const response = await api.request(`/api/pipeline/${one.task.taskId}/actions`, {
    kind: 'APPROVE', confirmation: 'APPROVE', owner: { kind: 'account', id: account.user.id },
  }, { Authorization: `Bearer ${claimedToken}` });
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).action.owner, one.task.owner);
});

test('claim revokes stale guest capability across every job-token API before S3 side effects', async context => {
  const api = await fixture(context);
  const guest = await api.create();
  const account = await api.register('stale-guest-owner@example.invalid');
  const claimed = await api.request('/api/projects/claim', { jobToken: guest.token }, { Cookie: account.cookie });
  assert.equal(claimed.status, 201);
  const accountToken = (await claimed.json()).jobToken;
  const accountUpload = await api.upload(accountToken);
  api.ready(accountUpload.task);

  const staleAuth = { Authorization: `Bearer ${guest.token}` };
  const before = api.commands.length;
  const attempts = [
    api.request('/api/session', undefined, staleAuth),
    api.request('/api/uploads', { name: 'stale-new.mp4', size: 127 }, staleAuth),
    api.request('/api/uploads', {
      name: 'synthetic.mp4', size: 127, resumeSession: accountUpload.session.sessionToken,
    }, staleAuth),
    api.request(`/api/uploads/${accountUpload.session.uploadId}/chunks/0`, {}, {
      ...staleAuth, 'X-Upload-Session': accountUpload.session.sessionToken,
    }),
    api.request(`/api/uploads/${accountUpload.session.uploadId}/complete`, {}, {
      ...staleAuth, 'X-Upload-Session': accountUpload.session.sessionToken,
    }),
    api.request('/api/pipeline', undefined, staleAuth),
    api.request(`/api/pipeline/${accountUpload.task.taskId}/retry`, {}, staleAuth),
    api.request(`/api/pipeline/${accountUpload.task.taskId}/actions`, {
      kind: 'REVISION', requestText: 'Неавторизованная правка',
    }, staleAuth),
    api.request(`/api/pipeline/${accountUpload.task.taskId}/actions`, {
      kind: 'APPROVE', confirmation: 'APPROVE',
    }, staleAuth),
    api.request(`/api/uploads/${accountUpload.session.uploadId}`, undefined, {
      ...staleAuth, 'X-Upload-Session': accountUpload.session.sessionToken,
    }, 'DELETE'),
    api.request('/api/files', undefined, staleAuth),
  ];
  const responses = await Promise.all(attempts);
  assert.deepEqual(responses.map((response) => response.status), Array(responses.length).fill(409));
  assert.equal(api.commands.length, before);
});

test('owner lookup failure denies a job capability before any S3 access', async context => {
  const api = await fixture(context);
  const guest = await api.create();
  api.store.findProjectByJobId = async () => { throw new Error('synthetic database outage'); };
  const before = api.commands.length;
  const response = await api.request('/api/session', undefined, {
    Authorization: `Bearer ${guest.token}`,
  });
  assert.equal(response.status, 500);
  assert.equal(api.commands.length, before);
});

test('legacy queue owner fallback stays guest; unknown or swapped source task fails closed', async context => {
  const api = await fixture(context);
  const created = await api.create();
  const { task, auth } = await api.upload(created.token);
  const key = `.queue/${task.jobId}/${task.taskId}.json`;
  delete task.owner;
  api.objects.set(key, task);
  api.ready(task);
  const legacy = await api.request(`/api/pipeline/${task.taskId}/actions`, { kind: 'REVISION', requestText: 'Текст ниже' }, auth);
  assert.equal(legacy.status, 202);
  assert.deepEqual((await legacy.json()).action.owner, { kind: 'guest', id: task.jobId });
  for (const value of [undefined, { ...task, jobId: 'web-wrong-owner' }, { ...task, owner: null }]) {
    if (value === undefined) api.objects.delete(key); else api.objects.set(key, value);
    const beforeWrites = api.commands.filter(c => c === 'PutObjectCommand').length;
    const denied = await api.request(`/api/pipeline/${task.taskId}/actions`, { kind: 'REVISION', requestText: 'Текст ниже' }, auth);
    assert.equal(denied.status, 409);
    assert.equal(api.commands.filter(c => c === 'PutObjectCommand').length, beforeWrites);
  }
});

test('invalid signed session owner is rejected before storage side effects', async context => {
  const api = await fixture(context);
  const jobId = 'web-invalid-owner';
  const token = signToken({ kind: 'job', jobId, source: 'web', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
  for (const owner of [null, { kind: 'guest', id: 'web-another-owner' }, { kind: 'account', id: '../someone' }]) {
    const session = signToken({ kind: 'session', jobId, sessionId: 'upload-invalid-owner', owner,
      name: 'source.mp4', size: 127, chunkSize: 1024, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
    const before = api.commands.length;
    const response = await api.request('/api/uploads/upload-invalid-owner/complete', {}, {
      Authorization: `Bearer ${token}`, 'X-Upload-Session': session,
    });
    assert.equal(response.status, 409);
    assert.equal(api.commands.length, before);
  }
});
