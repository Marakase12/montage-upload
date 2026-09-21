// Explicitly invoked release probe. Never approves/publishes or logs access URLs/tokens.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [apiBase, sourcePath, outputPath] = process.argv.slice(2);
if (!apiBase || new URL(apiBase).protocol !== 'https:' || !sourcePath || !outputPath) {
  throw new Error('Usage: node scripts/pipeline-smoke.mjs https://api synthetic.mp4 downloaded.mp4');
}
const origin = new URL(apiBase).origin;
const bytes = await readFile(sourcePath);
assert.ok(bytes.length > 0 && bytes.length < 20 * 1024 * 1024, 'Use a small synthetic video');

async function json(endpoint, options = {}, expected = 200) {
  const response = await fetch(`${origin}${endpoint}`, {
    ...options, headers: { Origin: origin, ...options.headers }, signal: AbortSignal.timeout(25000),
  });
  assert.equal(response.status, expected, `${endpoint}: HTTP ${response.status}`);
  return response.json();
}

try {
  const job = await json('/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quickStart: true, projectType: 'release-smoke',
      title: 'Synthetic release verification',
      comment: 'Synthetic speech and color only. No private user media. Never approve or publish.',
      processing: { mode: 'short', aspectRatio: '1:1', faceTrackingEnabled: false, subtitlesEnabled: true, hookEnabled: false } }),
  }, 201);
  const auth = { Authorization: `Bearer ${job.token}` };
  const upload = await json('/api/uploads', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: path.basename(sourcePath), type: 'video/mp4', size: bytes.length }),
  }, 201);
  assert.equal(upload.totalChunks, 1);
  const sessionAuth = { ...auth, 'X-Upload-Session': upload.sessionToken };
  const part = await json(`/api/uploads/${upload.uploadId}/chunks/0`, { method: 'POST', headers: sessionAuth });
  const sent = await fetch(part.uploadUrl, { method: 'PUT', body: bytes, signal: AbortSignal.timeout(30000) });
  assert.equal(sent.status, 200, 'Synthetic source upload failed');
  const completed = await json(`/api/uploads/${upload.uploadId}/complete`, {
    method: 'POST', headers: { ...sessionAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ parts: [] }),
  });
  assert.equal(completed.pipelineQueued, true);
  console.log('Synthetic source uploaded; pipeline queued.');
  let lastState = '';
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const { tasks, worker } = await json('/api/pipeline', { headers: auth });
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    const state = `${task.state} ${task.percent}% ${task.stage} · worker ${worker?.state || 'UNKNOWN'}`;
    if (state !== lastState) { console.log(state); lastState = state; }
    assert.notEqual(task.state, 'FAILED', `Synthetic pipeline failed at ${task.stage}`);
    if (task.state === 'READY_FOR_REVIEW') {
      assert.ok(task.downloadUrl && task.resultAvailability === 'AVAILABLE');
      const result = await fetch(task.downloadUrl, { signal: AbortSignal.timeout(30000) });
      assert.equal(result.status, 200);
      const output = Buffer.from(await result.arrayBuffer());
      assert.ok(output.length > 1024, 'Downloaded preview is empty');
      await writeFile(outputPath, output, { flag: 'wx' });
      console.log(`PASS: downloaded ${output.length} verified-present bytes; approval not requested.`);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error('Timed out waiting for synthetic result; no approval or publication requested');
} catch (error) {
  // Built-in assertion messages use only fixed labels/statuses, never response bodies/secrets.
  console.error(error instanceof assert.AssertionError ? error.message : 'Pipeline smoke failed; inspect service status safely.');
  process.exitCode = 1;
}
