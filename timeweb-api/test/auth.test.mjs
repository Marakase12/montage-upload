import assert from 'node:assert/strict';
import test from 'node:test';
import { signToken, verifyToken } from '../server.js';

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
