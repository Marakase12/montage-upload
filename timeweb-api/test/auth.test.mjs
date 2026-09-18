import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, signToken, verifyToken } from '../server.js';

const secret = 'test-secret-that-is-long-enough';

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
  assert.match(await home.text(), /Montage Drop/);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).retentionHours, 12);
});
