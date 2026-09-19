import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('основной выбор на iPhone принимает одно видео, остальные файлы выбираются отдельно', () => {
  const video = html.match(/<input\b[^>]*id="fileInput"[^>]*>/)?.[0];
  const extra = html.match(/<input\b[^>]*id="extraFileInput"[^>]*>/)?.[0];
  assert.ok(video);
  assert.ok(extra);
  assert.doesNotMatch(video, /\bmultiple\b/);
  assert.match(video, /accept="video\/\*,\.mp4,\.mov,\.mkv"/);
  assert.match(extra, /\bmultiple\b/);
});
