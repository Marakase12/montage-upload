import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from '../server.js';
import { cleanupRetentionHours, reportStorageRetention, StorageCleanupReportError } from '../storage-cleanup.js';

const now = Date.parse('2026-09-22T12:00:00Z');
const old = new Date(now - 48 * 3_600_000);
const recent = new Date(now - 60_000);
const adminSecret = 'new-admin-secret-only-for-local-tests';

function storage({ objects = [{ Contents: [] }], uploads = [{ Uploads: [] }] } = {}) {
  const commands = [];
  const indices = { ListObjectsV2Command: 0, ListMultipartUploadsCommand: 0 };
  return {
    commands,
    s3: { async send(command, options) {
      const name = command.constructor.name;
      assert.ok(Object.hasOwn(indices, name), `Unexpected storage mutation: ${name}`);
      assert.ok(options.abortSignal instanceof AbortSignal);
      assert.equal(command.input.Bucket, 'test-bucket');
      commands.push(command);
      const pages = name === 'ListObjectsV2Command' ? objects : uploads;
      return pages[indices[name]++] ?? pages.at(-1);
    } },
  };
}

function report(fixture, options = {}) {
  return reportStorageRetention({ s3: fixture.s3, bucket: 'test-bucket', now, ...options });
}

async function startApp(context, { env = {}, s3, accountStore = null } = {}) {
  const app = createApp({
    env: { NODE_ENV: 'test', ADMIN_SECRET: adminSecret, S3_BUCKET: 'test-bucket', TOKEN_SECRET: 'local-test-only', ...env },
    s3,
    accountStore,
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('retention report only counts aged files; important state and all uploads remain untouched', async () => {
  const stateKeys = ['.queue/', '.status/', '.actions/', '.workers/', '.briefs/'].map((prefix) => `${prefix}private-state.json`);
  const f = storage({
    objects: [{ Contents: [
      { Key: 'web-project01/private-source.mp4', LastModified: old, Size: 100 },
      { Key: '.results/web-project01/task-result01.mp4', LastModified: old, Size: 200 },
      { Key: 'web-project01/recent.mp4', LastModified: recent, Size: 300 },
      { Key: 'web-project01/exact-cutoff.mp4', LastModified: new Date(now - 24 * 3_600_000), Size: 10 },
      ...stateKeys.map((Key) => ({ Key, LastModified: old, Size: 50 })),
      { Key: 'unknown-private-backup.zip', LastModified: old, Size: 99 },
      { Key: '.unrecognized/metadata.json', LastModified: old, Size: 99 },
      { Key: 'web-project01/missing-date.mp4', Size: 33 },
      { Key: 'web-project01/missing-size.mp4', LastModified: old },
    ] }],
    uploads: [{ Uploads: [
      { Key: 'web-project01/active.mp4', UploadId: 'private-active-upload', Initiated: recent },
      { Key: 'web-project01/slow.mp4', UploadId: 'private-slow-upload', Initiated: old },
    ] }],
  });
  const result = await report(f);
  assert.equal(result.dryRun, true);
  assert.equal(result.deletionEnabled, false);
  assert.deepEqual(result.objects.candidates, { count: 3, bytes: 300, unknownSizeCount: 1 });
  assert.equal(result.objects.skippedImportantState, 5);
  assert.equal(result.objects.skippedUnknown, 2);
  assert.equal(result.objects.skippedInvalidMetadata, 1);
  assert.equal(result.objects.notExpired, 2);
  assert.equal(result.multipartUploads.retained, 2);
  assert.equal(result.multipartUploads.olderThanCutoff, 1);
  assert.equal(result.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /private|web-project01|task-result01|test-bucket/);
  assert.deepEqual(f.commands.map((command) => command.constructor.name), ['ListObjectsV2Command', 'ListMultipartUploadsCommand']);
});

test('invalid retention or page bounds fail before any S3 request', async () => {
  assert.equal(cleanupRetentionHours(), 24);
  assert.equal(cleanupRetentionHours(' 48 '), 48);
  for (const retentionHours of [0, -1, 1.5, NaN, Infinity, null, true, '', 'abc', '24junk', '1e3', '0', '8761', 8761]) {
    const f = storage();
    await assert.rejects(report(f, { retentionHours }), StorageCleanupReportError);
    assert.equal(f.commands.length, 0);
  }
  for (const maxPages of [0, -1, 1.5, 11, '2']) {
    const f = storage();
    await assert.rejects(report(f, { maxPages }), StorageCleanupReportError);
    assert.equal(f.commands.length, 0);
  }
});

test('pagination carries both multipart markers and does not double-count overlapping pages', async () => {
  const firstObject = { Key: 'web-project01/source-1.mp4', LastModified: old, Size: 10 };
  const firstUpload = { Key: 'web-project01/source-1.mp4', UploadId: 'upload-one', Initiated: old };
  const f = storage({
    objects: [
      { Contents: [firstObject], IsTruncated: true, NextContinuationToken: 'cursor-one' },
      { Contents: [firstObject, { Key: 'web-project01/source-2.mp4', LastModified: old, Size: 20 }], IsTruncated: false },
    ],
    uploads: [
      { Uploads: [firstUpload], IsTruncated: true, NextKeyMarker: firstUpload.Key, NextUploadIdMarker: firstUpload.UploadId },
      { Uploads: [firstUpload, { ...firstUpload, UploadId: 'upload-two' }], IsTruncated: false },
    ],
  });
  const result = await report(f);
  assert.equal(result.objects.candidates.count, 2);
  assert.equal(result.objects.candidates.bytes, 30);
  assert.equal(result.objects.duplicateRecords, 1);
  assert.equal(result.multipartUploads.retained, 2);
  assert.equal(result.multipartUploads.duplicateRecords, 1);
  assert.equal(result.truncated, false);
  assert.equal(f.commands[1].input.ContinuationToken, 'cursor-one');
  assert.equal(f.commands[3].input.KeyMarker, firstUpload.Key);
  assert.equal(f.commands[3].input.UploadIdMarker, firstUpload.UploadId);
});

test('page limit yields explicit partial totals for objects and multipart uploads', async () => {
  const f = storage({
    objects: [{ Contents: [], IsTruncated: true, NextContinuationToken: 'more-objects' }],
    uploads: [{ Uploads: [], IsTruncated: true, NextKeyMarker: 'more-uploads', NextUploadIdMarker: 'more-ids' }],
  });
  const result = await report(f, { maxPages: 1 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.pagination.objects, { pages: 1, truncated: true, reason: 'page_limit' });
  assert.deepEqual(result.pagination.multipartUploads, { pages: 1, truncated: true, reason: 'page_limit' });
  assert.equal(f.commands.length, 2);
});

test('missing or repeated pagination cursors terminate safely instead of looping', async () => {
  for (const repeat of [false, true]) {
    const f = storage({
      objects: [{ Contents: [], IsTruncated: true, ...(repeat ? { NextContinuationToken: 'repeat-objects' } : {}) }],
      uploads: [{ Uploads: [], IsTruncated: true, ...(repeat ? { NextKeyMarker: 'repeat-uploads', NextUploadIdMarker: 'repeat-id' } : {}) }],
    });
    const result = await report(f);
    assert.equal(result.truncated, true);
    const reason = repeat ? 'repeated_cursor' : 'missing_cursor';
    assert.equal(result.pagination.objects.reason, reason);
    assert.equal(result.pagination.multipartUploads.reason, reason);
    assert.equal(f.commands.length, repeat ? 4 : 2);
    assert.doesNotMatch(JSON.stringify(result), /repeat-objects|repeat-uploads|repeat-id/);
  }
});

test('oversized provider pages are capped and marked incomplete', async () => {
  const f = storage({
    objects: [{ Contents: Array.from({ length: 1001 }, (_, index) => ({ Key: `web-project01/file-${index}.mp4`, LastModified: old, Size: 1 })) }],
    uploads: [{ Uploads: Array.from({ length: 1001 }, (_, index) => ({ Key: 'web-project01/file.mp4', UploadId: `id-${index}`, Initiated: recent })) }],
  });
  const result = await report(f);
  assert.equal(result.objects.scanned, 1000);
  assert.equal(result.multipartUploads.retained, 1000);
  assert.equal(result.pagination.objects.reason, 'oversized_page');
  assert.equal(result.pagination.multipartUploads.reason, 'oversized_page');
  assert.equal(result.truncated, true);
});

test('provider failures are sanitized and cannot result in mutations', async () => {
  const s3 = { async send() { throw new Error('private-object-key credentials=do-not-expose'); } };
  await assert.rejects(reportStorageRetention({ s3, bucket: 'test-bucket', now }), (error) => {
    assert.ok(error instanceof StorageCleanupReportError);
    assert.doesNotMatch(error.message, /private-object-key|credentials/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('malformed listing cannot masquerade as a complete empty inventory', async () => {
  for (const malformed of [null, [], { IsTruncated: 'false' }, { Contents: {} }, { Uploads: 'private-data' }]) {
    const s3 = { async send(command) {
      assert.equal(command.constructor.name, 'ListObjectsV2Command');
      return malformed;
    } };
    await assert.rejects(reportStorageRetention({ s3, bucket: 'test-bucket', now }), StorageCleanupReportError);
  }
});

test('app creation/startup have no automatic deletion or multipart abort schedule', async (context) => {
  const f = storage();
  await startApp(context, { s3: f.s3 });
  assert.equal(f.commands.length, 0);
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const startup = source.slice(source.indexOf('if (process.argv[1]'));
  assert.ok(startup.includes('app.listen('));
  assert.doesNotMatch(startup, /cleanupExpiredObjects|reportStorageRetention|DeleteObjectsCommand|AbortMultipartUploadCommand|setInterval\s*\(/);
  assert.doesNotMatch(source, /DeleteObjectsCommand|cleanupExpiredObjects/);
});

test('admin cleanup always reports only, even when body requests destructive execution', async (context) => {
  const f = storage({
    objects: [{ Contents: [{ Key: 'web-project01/old-source.mp4', LastModified: new Date(0), Size: 44 }] }],
    uploads: [{ Uploads: [{ Key: 'web-project01/active.mp4', UploadId: 'active-id', Initiated: new Date(0) }] }],
  });
  const base = await startApp(context, { s3: f.s3 });
  const response = await fetch(`${base}/api/admin/cleanup`, {
    method: 'POST', headers: { 'X-Admin-Secret': adminSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: false, execute: true, delete: true, abortUploads: true, retentionHours: 0 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.dryRun, true);
  assert.equal(result.deletionEnabled, false);
  assert.equal(result.retentionHours, 24);
  assert.equal(result.objects.candidates.count, 1);
  assert.equal(result.multipartUploads.retained, 1);
  assert.deepEqual(f.commands.map((command) => command.constructor.name), ['ListObjectsV2Command', 'ListMultipartUploadsCommand']);
});

test('admin cleanup rejects invalid configured retention without contacting storage', async (context) => {
  const f = storage();
  const base = await startApp(context, { env: { RETENTION_HOURS: '24junk' }, s3: f.s3 });
  const response = await fetch(`${base}/api/admin/cleanup`, { method: 'POST', headers: { 'X-Admin-Secret': adminSecret } });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /RETENTION_HOURS/);
  assert.equal(f.commands.length, 0);
});

test('admin auth-check proves old/wrong/missing rejected and new accepted without storage or database calls', async (context) => {
  const f = storage();
  let accountCalls = 0;
  const accountStore = {
    async readiness() { accountCalls++; throw new Error('Unexpected DB call'); },
    async findActiveSession() { accountCalls++; throw new Error('Unexpected DB call'); },
  };
  const base = await startApp(context, { s3: f.s3, accountStore });
  for (const supplied of [null, '', 'old-admin-secret-only-for-local-tests', 'x'.repeat(adminSecret.length)]) {
    const response = await fetch(`${base}/api/admin/auth-check`, { headers: supplied === null ? {} : { 'X-Admin-Secret': supplied } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const accepted = await fetch(`${base}/api/admin/auth-check`, { headers: { 'X-Admin-Secret': adminSecret } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await accepted.json(), { ok: true });
  for (const endpoint of ['cleanup', 'configure-cors']) {
    const response = await fetch(`${base}/api/admin/${endpoint}`, { method: 'POST', headers: { 'X-Admin-Secret': 'old-admin-secret' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.commands.length, 0);
  assert.equal(accountCalls, 0);
});

test('admin auth-check remains closed when ADMIN_SECRET is unconfigured', async (context) => {
  const f = storage();
  const base = await startApp(context, { env: { ADMIN_SECRET: '' }, s3: f.s3 });
  for (const supplied of ['', adminSecret]) {
    const response = await fetch(`${base}/api/admin/auth-check`, { headers: { 'X-Admin-Secret': supplied } });
    assert.equal(response.status, 401);
  }
  assert.equal(f.commands.length, 0);
});
