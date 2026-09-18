import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadServer } from '../server.mjs';

async function withServer(options, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'montage-upload-'));
  const app = createUploadServer({
    uploadDir: directory,
    chunkSize: 5,
    maxFileSize: 1024,
    ...options,
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback({ baseUrl, directory });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('загружает файл частями и собирает исходные байты', async () => {
  await withServer({}, async ({ baseUrl, directory }) => {
    const source = Buffer.from('large-file-payload');
    const initResponse = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'voice sample.wav',
        size: source.length,
        type: 'audio/wav',
        lastModified: 123,
      }),
    });
    assert.equal(initResponse.status, 201);
    const session = await initResponse.json();
    assert.equal(session.totalChunks, 4);

    for (let index = 0; index < session.totalChunks; index += 1) {
      const start = index * session.chunkSize;
      const chunk = source.subarray(start, Math.min(start + session.chunkSize, source.length));
      const response = await fetch(
        `${baseUrl}/api/uploads/${session.uploadId}/chunks/${index}`,
        { method: 'PUT', body: chunk },
      );
      assert.equal(response.status, 200);
    }

    const completeResponse = await fetch(
      `${baseUrl}/api/uploads/${session.uploadId}/complete`,
      { method: 'POST' },
    );
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();
    assert.equal(completed.status, 'completed');
    assert.deepEqual(await readFile(path.join(directory, completed.name)), source);
  });
});

test('продолжает незавершённую загрузку по метаданным файла', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const input = { name: 'clip.mp4', size: 12, type: 'video/mp4', lastModified: 456 };
    const first = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((response) => response.json());

    await fetch(`${baseUrl}/api/uploads/${first.uploadId}/chunks/0`, {
      method: 'PUT',
      body: Buffer.from('12345'),
    });

    const secondResponse = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.uploadId, first.uploadId);
    assert.equal(second.resumed, true);
    assert.deepEqual(second.receivedChunks, [0]);
  });
});

test('отклоняет неподдерживаемый формат и слишком большой файл', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const unsupported = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'danger.exe', size: 10 }),
    });
    assert.equal(unsupported.status, 415);

    const oversized = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'huge.mp4', size: 2048 }),
    });
    assert.equal(oversized.status, 413);
  });
});

test('защищает API ключом, когда он настроен', async () => {
  await withServer({ uploadToken: 'secret' }, async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/api/files`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/api/files`, {
      headers: { Authorization: 'Bearer secret' },
    });
    assert.equal(authorized.status, 200);
  });
});
