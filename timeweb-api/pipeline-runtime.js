import crypto from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

export const LEASE_MS = 120_000;
export const WORKER_ONLINE_MS = 60_000;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const ATTEMPT = /^[a-f0-9]{32}$/;
const TERMINAL = new Set(['READY_FOR_REVIEW', 'APPROVED', 'LONG_CANDIDATES_READY', 'FAILED']);
const missing = (error) => ['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(error?.name) || error?.$metadata?.httpStatusCode === 404;
export class PipelineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PipelineError(status, message); };
const timestamp = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function publicPipelineStatus(status) {
  if (!status) return status;
  const { lease, activeActionId, ...safe } = status;
  return safe;
}

// Production transitions share a PostgreSQL transaction-scoped lock across API
// replicas. Durable task state remains in S3. No unverified conditional-S3 writes.
export function createTaskLock(pool, { allowMemory = false } = {}) {
  const waiting = new Map();
  return async (key, callback) => {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`montage-pipeline:${key}`]);
        const result = await callback();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    }
    if (!allowMemory) fail(503, 'Надёжная очередь требует подключённую базу данных');
    // This branch is restricted to injected tests / non-production development.
    const previous = waiting.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    waiting.set(key, current);
    await previous;
    try { return await callback(); }
    finally { release(); if (waiting.get(key) === current) waiting.delete(key); }
  };
}

export function createPipelineRuntime({ s3, bucket, withLock, retentionHours = 24, now = Date.now }) {
  const retentionMs = retentionHours * 3_600_000;
  const iso = () => new Date(now()).toISOString();
  const statusKey = (jobId, taskId) => `.status/${jobId}/${taskId}.json`;
  const taskKey = (jobId, taskId) => `.queue/${jobId}/${taskId}.json`;
  const actionKey = (jobId, actionId) => `.actions/${jobId}/${actionId}.json`;
  const send = (command) => s3.send(command, { abortSignal: AbortSignal.timeout(8_000) });
  const validateId = (value) => { if (typeof value !== 'string' || !ID.test(value)) fail(400, 'Некорректный идентификатор'); return value; };
  const withTask = (jobId, taskId, fn) => withLock(`${validateId(jobId)}:${validateId(taskId)}`, fn);
  async function read(key, optional = false) {
    try { const result = await send(new GetObjectCommand({ Bucket: bucket, Key: key })); return JSON.parse(await result.Body.transformToString('utf-8')); }
    catch (error) { if (missing(error)) { if (optional) return null; fail(404, 'Задача не найдена'); } throw error; }
  }
  async function write(key, value) {
    await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json; charset=utf-8' }));
  }
  async function task(jobId, taskId) {
    const value = await read(taskKey(jobId, taskId));
    if (value.jobId !== jobId || value.taskId !== taskId) fail(404, 'Задача не найдена');
    return value;
  }
  async function status(jobId, taskId) {
    const value = await read(statusKey(jobId, taskId), true);
    if (value && (value.jobId !== jobId || value.taskId !== taskId)) fail(404, 'Задача не найдена');
    return value;
  }
  async function hasActions(jobId, taskId) {
    const listed = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `.actions/${jobId}/`, MaxKeys: 1000 }));
    if (listed.IsTruncated) return true;
    for (const object of listed.Contents ?? []) {
      const action = await read(object.Key);
      if (action.taskId === taskId) return true;
    }
    return false;
  }
  async function sourceAvailable(value) {
    const prefix = `${value.jobId}/`;
    if (typeof value.objectKey !== 'string' || !value.objectKey.startsWith(prefix)
        || value.objectKey.slice(prefix.length).includes('/') || value.objectKey.includes('..')) return { ok: false, reason: 'SOURCE_MISSING' };
    const created = timestamp(value.createdAt);
    if (created === null || created + retentionMs <= now()) return { ok: false, reason: 'SOURCE_EXPIRED' };
    try {
      const source = await send(new HeadObjectCommand({ Bucket: bucket, Key: value.objectKey }));
      const stored = timestamp(source.LastModified);
      if (stored === null) return { ok: false, reason: 'SOURCE_UNKNOWN' };
      if (stored + retentionMs <= now()) return { ok: false, reason: 'SOURCE_EXPIRED' };
      if (Number(source.ContentLength) !== Number(value.size) || Number(value.size) <= 0) return { ok: false, reason: 'SOURCE_MISSING' };
      return { ok: true, reason: null };
    } catch (error) { return { ok: false, reason: missing(error) ? 'SOURCE_MISSING' : 'SOURCE_UNKNOWN' }; }
  }
  async function requireSource(value) {
    const result = await sourceAvailable(value);
    if (!result.ok) fail(result.reason === 'SOURCE_EXPIRED' ? 410 : result.reason === 'SOURCE_UNKNOWN' ? 503 : 409,
      result.reason === 'SOURCE_EXPIRED' ? 'Срок хранения исходника истёк. Загрузите видео заново' : 'Исходник недоступен для повтора');
  }
  function leaseLive(value) { return value?.lease && timestamp(value.lease.expiresAt) > now(); }
  function recoverable(value) {
    return value?.state === 'PROCESSING' && value.operationType === 'INITIAL'
      && value.lease && timestamp(value.lease.expiresAt) !== null && !leaseLive(value);
  }
  async function retryInfo(jobId, taskId, current) {
    if (current?.state !== 'FAILED') return { retryable: false, retryReason: 'NOT_FAILED' };
    if ((current.operationType && current.operationType !== 'INITIAL') || await hasActions(jobId, taskId)) return { retryable: false, retryReason: 'ACTION_REQUIRES_REVIEW' };
    const source = await sourceAvailable(await task(jobId, taskId));
    return { retryable: source.ok, retryReason: source.reason };
  }
  async function retry(jobId, taskId) {
    return withTask(jobId, taskId, async () => {
      const current = await status(jobId, taskId);
      if (current?.retryRequestedAt && current.operationType === 'INITIAL' && ['QUEUED', 'PROCESSING'].includes(current.state)) {
        return { ok: true, alreadyQueued: true, status: publicPipelineStatus(current) };
      }
      if (current?.state !== 'FAILED') fail(409, 'Повторить можно только обработку с ошибкой');
      if ((current.operationType && current.operationType !== 'INITIAL') || await hasActions(jobId, taskId)) fail(409, 'Правки и подтверждения не повторяются автоматически');
      await requireSource(await task(jobId, taskId));
      const next = { ...current, state: 'QUEUED', percent: 0, stage: 'cloud_queue', detail: 'Повтор поставлен в очередь', operationType: 'INITIAL',
        lease: null, resultKey: null, resultAttemptId: null, attemptCount: 0, retryRequestedAt: iso(), retryCount: (Number(current.retryCount) || 0) + 1, updatedAt: iso() };
      await write(statusKey(jobId, taskId), next);
      return { ok: true, alreadyQueued: false, status: publicPipelineStatus(next) };
    });
  }
  async function claim(jobId, taskId, workerId) {
    validateId(workerId);
    return withTask(jobId, taskId, async () => {
      const value = await task(jobId, taskId);
      const current = await status(jobId, taskId);
      if (leaseLive(current) && current.lease.workerId === workerId && current.state === 'PROCESSING' && current.operationType === 'INITIAL') {
        return { task: value, leaseToken: current.lease.token, leaseId: current.lease.id, leaseExpiresAt: current.lease.expiresAt };
      }
      if (current && current.state !== 'QUEUED' && !recoverable(current)) fail(409, 'Задача уже выполняется или завершена');
      if (recoverable(current) && Number(current.attemptCount) >= 3) {
        await write(statusKey(jobId, taskId), { ...current, state: 'FAILED', stage: 'recovery_limit',
          detail: 'Не удалось восстановить обработку после трёх попыток. Можно повторить вручную', updatedAt: iso() });
        fail(409, 'Лимит автоматического восстановления исчерпан');
      }
      if (await hasActions(jobId, taskId)) fail(409, 'Задача содержит правки или подтверждение');
      try { await requireSource(value); }
      catch (error) {
        if (error instanceof PipelineError && error.status !== 503) await write(statusKey(jobId, taskId), {
          ...current, version: 1, jobId, taskId, state: 'FAILED', percent: 0, operationType: 'INITIAL',
          stage: 'source_unavailable', detail: error.message, updatedAt: iso(),
        });
        throw error;
      }
      const lease = { id: crypto.randomBytes(16).toString('hex'), token: crypto.randomBytes(32).toString('hex'), workerId,
        expiresAt: new Date(now() + LEASE_MS).toISOString(), renewedAt: iso() };
      const next = { ...current, version: 1, jobId, taskId, state: 'PROCESSING', percent: 1, operationType: 'INITIAL', lease,
        stage: 'download', detail: 'Обработчик забирает исходник', resultKey: null, resultAttemptId: lease.id,
        attemptCount: (Number(current?.attemptCount) || 0) + 1, updatedAt: iso() };
      await write(statusKey(jobId, taskId), next);
      return { task: value, leaseToken: lease.token, leaseId: lease.id, leaseExpiresAt: lease.expiresAt };
    });
  }
  function sameLease(current, body) {
    if (!TOKEN.test(String(body.leaseToken ?? '')) || !ATTEMPT.test(String(body.leaseId ?? ''))) return false;
    return current?.lease?.workerId === body.workerId && current.lease.id === body.leaseId && current.lease.token === body.leaseToken;
  }
  async function authorized(jobId, taskId, current, body, { allowTerminal = false } = {}) {
    validateId(body.workerId);
    if (body.actionId) {
      const action = await read(actionKey(jobId, validateId(body.actionId)));
      if (action.taskId !== taskId || action.workerId !== body.workerId || action.state !== 'PROCESSING'
          || current?.activeActionId !== action.actionId) fail(409, 'Действие больше не принадлежит обработчику');
      return { attemptId: action.kind === 'APPROVE' ? action.resultAttemptId ?? null : action.actionId.replaceAll('-', ''),
        actionKind: action.kind, approvalResultKey: action.resultKey };
    }
    if (!sameLease(current, body) || current.operationType !== 'INITIAL'
        || (!leaseLive(current) && !(allowTerminal && TERMINAL.has(current.state)))) fail(409, 'Аренда задачи истекла или передана другому обработчику');
    return { attemptId: current.lease.id };
  }
  async function update(jobId, taskId, body, values) {
    return withTask(jobId, taskId, async () => {
      const current = await status(jobId, taskId);
      const { attemptId, actionKind, approvalResultKey } = await authorized(jobId, taskId, current, body, { allowTerminal: true });
      if (TERMINAL.has(current.state)) {
        if (current.state === values.state && (current.resultKey ?? null) === (values.resultKey ?? null)) return publicPipelineStatus(current);
        fail(409, 'Завершённый результат нельзя перезаписать устаревшим статусом');
      }
      if (values.state === 'QUEUED') fail(400, 'Обработчик не может самостоятельно переотправить задачу');
      if (values.state === 'APPROVED' && actionKind !== 'APPROVE') fail(409, 'Подтверждение требует отдельного явного действия пользователя');
      const expectedKey = actionKind === 'APPROVE' ? approvalResultKey : `.results/${jobId}/${taskId}-${attemptId}.mp4`;
      if (['READY_FOR_REVIEW', 'APPROVED'].includes(values.state) && !values.resultKey) fail(409, 'Готовый результат должен ссылаться на файл текущей попытки');
      if (values.resultKey && values.resultKey !== expectedKey) fail(409, 'Результат принадлежит другой попытке');
      if (actionKind === 'APPROVE' && values.state === 'APPROVED' && values.resultKey !== approvalResultKey) fail(409, 'Подтверждение должно сохранить выбранный preview');
      const next = { ...current, ...values, resultAttemptId: attemptId, updatedAt: iso() };
      await write(statusKey(jobId, taskId), next);
      return publicPipelineStatus(next);
    });
  }
  async function resultUpload(jobId, taskId, body) {
    return withTask(jobId, taskId, async () => {
      const current = await status(jobId, taskId);
      const { attemptId, actionKind } = await authorized(jobId, taskId, current, body);
      if (actionKind === 'APPROVE') fail(409, 'Подтверждение не может загрузить другой preview');
      if (current.state !== 'PROCESSING') fail(409, 'Задача не ожидает новый результат');
      return `.results/${jobId}/${taskId}-${attemptId}.mp4`;
    });
  }
  async function heartbeat(body) {
    const workerId = validateId(body.workerId);
    let leaseExpiresAt;
    const active = body.activeTask;
    if (active) await withTask(active.jobId, active.taskId, async () => {
      const current = await status(active.jobId, active.taskId);
      if (!sameLease(current, { ...active, workerId }) || !leaseLive(current)) fail(409, 'Аренда задачи потеряна');
      if (current.state === 'PROCESSING' && current.operationType === 'INITIAL') {
        current.lease.expiresAt = new Date(now() + LEASE_MS).toISOString();
        current.lease.renewedAt = iso();
        await write(statusKey(active.jobId, active.taskId), current);
      }
      leaseExpiresAt = current.lease.expiresAt;
    });
    await write(`.workers/${workerId}.json`, { workerId, lastSeenAt: iso(), phase: body.phase === 'busy' ? 'busy' : 'idle' });
    return { ok: true, ...(leaseExpiresAt ? { leaseExpiresAt } : {}) };
  }
  let workerCache = null;
  async function worker() {
    if (workerCache && now() - workerCache.at < 5_000) return workerCache.value;
    try {
      const listed = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: '.workers/', MaxKeys: 1000 }));
      const newest = (listed.Contents ?? []).filter((object) => /^\.workers\/[A-Za-z0-9_-]{8,100}\.json$/.test(object.Key))
        .sort((a, b) => (timestamp(b.LastModified) ?? 0) - (timestamp(a.LastModified) ?? 0))[0];
      const value = newest ? await read(newest.Key) : null;
      const seen = timestamp(value?.lastSeenAt);
      const result = { state: seen !== null && now() - seen < WORKER_ONLINE_MS ? 'ONLINE' : 'OFFLINE',
        lastSeenAt: seen === null ? null : new Date(seen).toISOString(), phase: seen !== null && now() - seen < WORKER_ONLINE_MS ? value.phase : null };
      workerCache = { at: now(), value: result };
      return result;
    } catch { return { state: 'UNKNOWN', lastSeenAt: null, phase: null }; }
  }
  return { withTask, read, write, task, status, recoverable, retryInfo, retry, claim, update, resultUpload, heartbeat, worker, actionKey, statusKey, hasActions };
}
