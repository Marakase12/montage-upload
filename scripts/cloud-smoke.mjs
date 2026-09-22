import assert from 'node:assert/strict';

const apiBase = String(process.argv[2] || '').replace(/\/$/, '');
const origin = String(process.argv[3] || 'https://marakase12.github.io');

if (!apiBase || new URL(apiBase).protocol !== 'https:') {
  console.error('Usage: npm run smoke:cloud -- https://<api-domain> [https://<site-origin>]');
  process.exit(2);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { Origin: origin, ...options.headers },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.headers.get('access-control-allow-origin'), origin,
    `CORS failed at ${path}`);
  return response;
}

async function json(path, options = {}, expectedStatus = 200) {
  const response = await request(path, options);
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus,
    `${path}: HTTP ${response.status}: ${body.error || 'unknown error'}`);
  return body;
}

try {
  const health = await json('/api/health');
  assert.equal(health.ok, true);
  console.log('1/6 HTTPS health and API CORS: OK');

  const preflight = await request('/api/jobs', {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  console.log('2/6 Browser preflight: OK');

  const job = await json('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quickStart: true,
      projectType: 'smoke-test',
      comment: 'Synthetic text file for upload connectivity test; no user media.',
    }),
  }, 201);
  assert.ok(job.token && job.jobId);
  console.log('3/6 Create isolated project in S3: OK');

  const fileName = `cloud-smoke-${Date.now()}.txt`;
  const bytes = Buffer.from('MontageAI cloud upload smoke test\n', 'utf8');
  const auth = { Authorization: `Bearer ${job.token}` };
  const session = await json('/api/uploads', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fileName, size: bytes.length, type: 'text/plain' }),
  }, 201);
  assert.equal(session.provider, 's3-direct');
  assert.equal(session.totalChunks, 1);
  console.log('4/6 Start multipart upload: OK');

  const sessionHeaders = { ...auth, 'X-Upload-Session': session.sessionToken };
  const part = await json(`/api/uploads/${session.uploadId}/chunks/0`, {
    method: 'POST',
    headers: sessionHeaders,
  });
  assert.ok(part.uploadUrl);
  const storagePreflight = await fetch(part.uploadUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type',
    },
    signal: AbortSignal.timeout(20_000),
  });
  assert.ok([200, 204].includes(storagePreflight.status),
    `S3 preflight: HTTP ${storagePreflight.status}`);
  assert.equal(storagePreflight.headers.get('access-control-allow-origin'), origin,
    'S3 preflight origin is not allowed');
  const allowedMethods = String(storagePreflight.headers.get('access-control-allow-methods') || '')
    .split(',').map((value) => value.trim().toUpperCase());
  assert.ok(allowedMethods.includes('PUT'), 'S3 preflight does not allow PUT');
  const allowedHeaders = String(storagePreflight.headers.get('access-control-allow-headers') || '')
    .split(',').map((value) => value.trim().toLowerCase());
  assert.ok(allowedHeaders.includes('*') || allowedHeaders.includes('content-type'),
    'S3 preflight does not allow Content-Type');
  const uploaded = await fetch(part.uploadUrl, {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(uploaded.status, 200, `S3 upload: HTTP ${uploaded.status}`);
  assert.equal(uploaded.headers.get('access-control-allow-origin'), origin,
    'S3 CORS failed');
  const exposedHeaders = String(uploaded.headers.get('access-control-expose-headers') || '')
    .split(',').map((value) => value.trim().toLowerCase());
  assert.ok(exposedHeaders.includes('*') || exposedHeaders.includes('etag'),
    'S3 does not expose ETag to the browser');
  console.log('5/6 Direct S3 preflight, upload and CORS: OK');

  const completed = await json(`/api/uploads/${session.uploadId}/complete`, {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [] }),
  });
  assert.equal(completed.status, 'completed');
  const files = await json('/api/files', { headers: auth });
  assert.ok(files.files.some((file) => file.name === fileName && file.size === bytes.length));
  console.log('6/6 Complete and list uploaded file: OK');
  console.log('Cloud upload path verified. No user media was sent.');
} catch (error) {
  console.error(`Cloud smoke test failed: ${error.message}`);
  process.exitCode = 1;
}
