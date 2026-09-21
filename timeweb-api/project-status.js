import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const MAX_TASKS = 20;
const MAX_ENRICHED_PROJECTS = 20;
const MAX_CACHE_ENTRIES = 400;
const CACHE_MS = 10_000;
const SUMMARY_DEADLINE_MS = 8_000;
const RESULT_STATES = new Set(['READY_FOR_REVIEW', 'APPROVED']);
const KNOWN_STATES = new Set(['QUEUED', 'PROCESSING', ...RESULT_STATES, 'LONG_CANDIDATES_READY', 'FAILED']);

function missingObject(error) {
  return ['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(error?.name)
    || error?.$metadata?.httpStatusCode === 404;
}

function timestamp(value) {
  const result = new Date(value ?? '').getTime();
  return Number.isFinite(result) ? result : null;
}

function unknownSummary(detail = 'Откройте проект, чтобы обновить статус') {
  return {
    state: 'UNKNOWN', percent: null, detail,
    taskCount: null, readyCount: 0, failedCount: 0, candidateCount: 0,
    updatedAt: null, retention: { state: 'UNKNOWN', expiresAt: null },
    incomplete: true,
  };
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function checkResultAvailability({
  s3, bucket, status, jobId, retentionHours = 24, now = Date.now(),
  statusModifiedAt, signal = AbortSignal.timeout(5_000),
}) {
  const response = (state, expiresAt = null) => ({
    state, expiresAt,
    reason: ({
      AVAILABLE: '',
      MISSING: 'Файл результата недоступен. Скачивание и просмотр сейчас невозможны',
      EXPIRED: 'Срок временного хранения результата истёк',
      UNKNOWN: 'Не удалось проверить файл результата. Попробуйте обновить страницу',
    })[state],
  });
  const suffix = status.resultAttemptId == null ? ''
    : /^[a-f0-9]{32}$/.test(String(status.resultAttemptId)) ? `-${status.resultAttemptId}` : null;
  const expectedKey = `.results/${jobId}/${status.taskId}${suffix}.mp4`;
  if (status.jobId !== jobId
      || !/^[A-Za-z0-9_-]{8,100}$/.test(String(jobId ?? ''))
      || !/^[A-Za-z0-9_-]{8,100}$/.test(String(status.taskId ?? ''))
      || suffix === null || status.resultKey !== expectedKey) return response('MISSING');
  const retentionMs = retentionHours * 60 * 60 * 1000;
  const statusTime = timestamp(statusModifiedAt) ?? timestamp(status.updatedAt);
  if (statusTime !== null && statusTime + retentionMs <= now) {
    return response('EXPIRED', new Date(statusTime + retentionMs).toISOString());
  }
  try {
    signal.throwIfAborted();
    const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: expectedKey }), {
      abortSignal: signal,
    });
    if (!Number.isFinite(Number(result.ContentLength))) return response('UNKNOWN');
    if (Number(result.ContentLength) <= 0) return response('MISSING');
    const modifiedAt = timestamp(result.LastModified);
    if (modifiedAt === null) return response('UNKNOWN');
    const expiresAt = new Date(modifiedAt + retentionMs).toISOString();
    return response(modifiedAt + retentionMs <= now ? 'EXPIRED' : 'AVAILABLE', expiresAt);
  } catch (error) {
    return response(missingObject(error) ? 'MISSING' : 'UNKNOWN');
  }
}

// Lists only this owner's project prefixes. It never scans the whole bucket,
// signs URLs or trusts a status file to point to another project's result.
export function createProjectStatusReader({ s3, bucket, retentionHours = 24, now = Date.now }) {
  const cache = new Map();
  const retentionMs = retentionHours * 60 * 60 * 1000;

  async function inspect(project, signal) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(project.jobId)) return unknownSummary();
    const send = (command) => {
      signal.throwIfAborted();
      return s3.send(command, { abortSignal: signal });
    };
    const statusPrefix = `.status/${project.jobId}/`;
    const listed = await send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: statusPrefix, MaxKeys: MAX_TASKS,
    }));
    const objects = (listed.Contents ?? []).filter((item) => item.Key?.startsWith(statusPrefix));
    if (listed.IsTruncated || objects.length > MAX_TASKS) {
      return unknownSummary('В проекте много файлов — откройте его для подробного статуса');
    }
    if (!objects.length) {
      const source = await send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: `${project.jobId}/`, MaxKeys: MAX_TASKS,
      }));
      if (source.IsTruncated) return unknownSummary('Откройте проект для подробного списка файлов');
      const uploaded = (source.Contents ?? [])
        .filter((item) => item.Key?.startsWith(`${project.jobId}/`))
        .sort((a, b) => (timestamp(b.LastModified) ?? 0) - (timestamp(a.LastModified) ?? 0))[0];
      const modifiedAt = timestamp(uploaded?.LastModified);
      const expiresAt = modifiedAt === null ? null : new Date(modifiedAt + retentionMs).toISOString();
      const expired = uploaded
        ? modifiedAt !== null && modifiedAt + retentionMs <= now()
        : timestamp(project.createdAt) !== null && timestamp(project.createdAt) + retentionMs <= now();
      return {
        state: expired ? 'EXPIRED' : uploaded ? 'UPLOADED' : 'CREATED',
        percent: expired ? null : 0,
        detail: expired ? 'Временные файлы больше недоступны' : uploaded
          ? 'Файл принят; готовность обработки ещё не подтверждена' : 'Видео ещё не загружено',
        taskCount: 0, readyCount: 0, failedCount: 0, candidateCount: 0,
        updatedAt: modifiedAt === null ? null : new Date(modifiedAt).toISOString(),
        retention: { state: expired ? 'EXPIRED' : uploaded ? 'ACTIVE' : 'NONE', expiresAt },
      };
    }

    const tasks = [];
    for (const object of objects) {
      const data = await send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      if (Number(data.ContentLength) > 64 * 1024) throw new Error('Oversized project status');
      const task = JSON.parse(await data.Body.transformToString('utf-8'));
      if (task.jobId !== project.jobId
          || !/^[A-Za-z0-9_-]{8,100}$/.test(String(task.taskId ?? ''))
          || object.Key !== `${statusPrefix}${task.taskId}.json`
          || !KNOWN_STATES.has(task.state)) {
        throw new Error('Invalid project status');
      }
      const storedAt = timestamp(object.LastModified) ?? timestamp(task.updatedAt);
      const expires = storedAt === null ? null : storedAt + retentionMs;
      let state = task.state;
      let detail = cleanText(task.detail);
      let retention = expires !== null && expires <= now() ? 'EXPIRED' : 'ACTIVE';
      let resultExpires = expires;
      if (retention === 'EXPIRED') {
        state = 'EXPIRED';
        detail = 'Срок временного хранения истёк';
      } else if (RESULT_STATES.has(state)) {
        const result = await checkResultAvailability({
          s3, bucket, status: task, jobId: project.jobId,
          retentionHours, now: now(), statusModifiedAt: object.LastModified, signal,
        });
        if (result.state === 'UNKNOWN') throw new Error('Result availability unknown');
        resultExpires = timestamp(result.expiresAt);
        if (result.state !== 'AVAILABLE') {
          state = result.state === 'EXPIRED' ? 'EXPIRED' : 'UNAVAILABLE';
          retention = result.state;
        }
        if (state === 'UNAVAILABLE') detail = 'Файл результата недоступен — готовность не подтверждена';
        if (state === 'EXPIRED') detail = 'Срок временного хранения результата истёк';
      }
      tasks.push({
        state, detail, retention, expires: resultExpires,
        percent: Math.max(0, Math.min(100, Number(task.percent) || 0)),
        updatedAt: timestamp(task.updatedAt) ?? storedAt,
        candidateCount: state === 'LONG_CANDIDATES_READY' && Array.isArray(task.candidates)
          ? task.candidates.length : 0,
      });
    }
    return aggregateProjectTasks(tasks);
  }

  async function read(project, signal) {
    const cached = cache.get(project.jobId);
    if (cached && now() - cached.cachedAt < CACHE_MS) return cached.summary;
    let summary;
    try {
      summary = bucket ? await inspect(project, signal) : unknownSummary('Хранилище временно недоступно');
    } catch {
      // Storage/network failure is not a processing failure or a successful result.
      return unknownSummary('Не удалось проверить статус. Попробуйте обновить страницу');
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(project.jobId, { summary, cachedAt: now() });
    return summary;
  }

  return {
    async enrich(projects, { all = false } = {}) {
      const signal = AbortSignal.timeout(SUMMARY_DEADLINE_MS);
      const output = projects.map((project) => {
        const cached = cache.get(project.jobId);
        const summary = cached && now() - cached.cachedAt < CACHE_MS
          ? cached.summary : unknownSummary();
        return { ...project, summary, state: summary.state, percent: summary.percent, detail: summary.detail };
      });
      let cursor = 0;
      const count = all ? projects.length : Math.min(projects.length, MAX_ENRICHED_PROJECTS);
      await Promise.all(Array.from({ length: Math.min(4, count) }, async () => {
        while (cursor < count) {
          const index = cursor++;
          const summary = await read(projects[index], signal);
          output[index] = {
            ...projects[index], summary, state: summary.state,
            percent: summary.percent, detail: summary.detail,
          };
        }
      }));
      return output;
    },
  };
}

export function aggregateProjectTasks(tasks) {
  const readyCount = tasks.filter((task) => RESULT_STATES.has(task.state)).length;
  const failedCount = tasks.filter((task) => task.state === 'FAILED').length;
  const priority = ['PROCESSING', 'QUEUED', 'FAILED', 'UNAVAILABLE', 'EXPIRED', 'LONG_CANDIDATES_READY', 'READY_FOR_REVIEW', 'APPROVED'];
  // Active work wins; mixed failure/ready remains actionable, never "all ready".
  const dominant = priority.map((state) => tasks.find((task) => task.state === state)).find(Boolean);
  if (!dominant) return unknownSummary();
  const unavailable = tasks.some((task) => ['EXPIRED', 'UNAVAILABLE'].includes(task.state));
  const dates = tasks.map((task) => task.updatedAt).filter(Number.isFinite);
  const expiries = tasks.map((task) => task.expires).filter(Number.isFinite);
  const retentionStates = new Set(tasks.map((task) => task.retention));
  let detail = dominant.detail || ({
    PROCESSING: 'Ролик обрабатывается', QUEUED: 'Видео ожидает обработки',
    FAILED: 'Не удалось обработать видео', READY_FOR_REVIEW: 'Ролик готов к просмотру',
    APPROVED: 'Ролик подтверждён', LONG_CANDIDATES_READY: 'Моменты найдены; рендер ещё не запускался',
  }[dominant.state] ?? 'Статус обновлён');
  if (tasks.length > 1) detail = `Готово роликов: ${readyCount} из ${tasks.length}. ${detail}`;
  return {
    state: dominant.state,
    percent: unavailable ? null : Math.round(tasks.reduce((sum, task) => sum + (
      RESULT_STATES.has(task.state) || task.state === 'LONG_CANDIDATES_READY' ? 100 : task.percent
    ), 0) / tasks.length),
    detail, taskCount: tasks.length, readyCount, failedCount,
    candidateCount: tasks.reduce((sum, task) => sum + task.candidateCount, 0),
    updatedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    retention: {
      state: retentionStates.size > 1 ? 'PARTIAL' : [...retentionStates][0],
      expiresAt: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
    },
  };
}
