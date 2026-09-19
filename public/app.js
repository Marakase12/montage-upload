const dropzone = document.querySelector('#dropzone');
const fileInput = document.querySelector('#fileInput');
const extraFileInput = document.querySelector('#extraFileInput');
const uploadList = document.querySelector('#uploadList');
const emptyQueue = document.querySelector('#emptyQueue');
const template = document.querySelector('#uploadTemplate');
const clearFinished = document.querySelector('#clearFinished');
const refreshFiles = document.querySelector('#refreshFiles');
const filesList = document.querySelector('#filesList');
const filesSection = document.querySelector('#filesSection');
const destinationPath = document.querySelector('#destinationPath');
const serverState = document.querySelector('#serverState');
const limitValue = document.querySelector('#limitValue');
const chunkValue = document.querySelector('#chunkValue');
const storageValue = document.querySelector('#storageValue');
const retentionValue = document.querySelector('#retentionValue');
const accessBanner = document.querySelector('#accessBanner');
const accessTitle = document.querySelector('#accessTitle');
const accessText = document.querySelector('#accessText');
const tokenToggle = document.querySelector('#tokenToggle');
const tokenBox = document.querySelector('#tokenBox');
const tokenInput = document.querySelector('#tokenInput');
const saveToken = document.querySelector('#saveToken');
const orderSection = document.querySelector('#orderSection');
const orderForm = document.querySelector('#orderForm');
const orderSubmit = document.querySelector('#orderSubmit');
const orderStatus = document.querySelector('#orderStatus');
const projectConsent = document.querySelector('#projectConsent');
const customerName = document.querySelector('#customerName');
const customerContact = document.querySelector('#customerContact');
const projectType = document.querySelector('#projectType');
const projectComment = document.querySelector('#projectComment');
const processingMode = document.querySelector('#processingMode');
const processingRequest = document.querySelector('#processingRequest');
const faceTrackingEnabled = document.querySelector('#faceTrackingEnabled');
const subtitlesEnabled = document.querySelector('#subtitlesEnabled');
const hookEnabled = document.querySelector('#hookEnabled');
const pipelineSection = document.querySelector('#pipelineSection');
const pipelineList = document.querySelector('#pipelineList');
const refreshPipeline = document.querySelector('#refreshPipeline');
const queueSection = document.querySelector('.queue-section');

const tasks = new Set();
const config = window.MONTAGE_UPLOAD_CONFIG ?? {};
const apiBase = String(config.apiBase ?? '').replace(/\/$/, '');
const manualTokenEnabled = config.allowManualToken === true
  || ['localhost', '127.0.0.1'].includes(window.location.hostname);
const url = new URL(window.location.href);
const linkToken = url.searchParams.get('token') ?? '';
let uploadToken = linkToken
  || sessionStorage.getItem('montage-upload-link-token')
  || localStorage.getItem('montage-upload-token')
  || '';
let serverProtected = false;
let apiAvailable = false;
let maxFileSize = 1024 * 1024 * 1024;
let pendingTasks = [];
let creatingProject = false;
if (linkToken) {
  sessionStorage.setItem('montage-upload-link-token', linkToken);
  url.searchParams.delete('token');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
tokenInput.value = uploadToken;
tokenToggle.hidden = !manualTokenEnabled;

function setAccessState(state) {
  accessBanner.dataset.state = state;
  if (state === 'ready') {
    accessTitle.textContent = 'Проект готов к загрузке';
    accessText.textContent = 'Можно загружать файлы. Другие пользователи их не увидят.';
  } else if (state === 'locked') {
    accessTitle.textContent = 'Начните новый проект';
    accessText.textContent = 'Выберите файл — защищённый проект создастся автоматически.';
  }
}

function uploadStateKey(file) {
  return `montage-upload:${file.name}:${file.size}:${file.lastModified}`;
}

function readUploadState(file) {
  try {
    return JSON.parse(localStorage.getItem(uploadStateKey(file)) ?? 'null');
  } catch {
    return null;
  }
}

function saveUploadState(file, value) {
  localStorage.setItem(uploadStateKey(file), JSON.stringify(value));
}

function clearUploadState(file) {
  localStorage.removeItem(uploadStateKey(file));
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const digits = index > 2 ? 1 : 0;
  return `${(value / (1024 ** index)).toFixed(digits)} ${units[index]}`;
}

function requestHeaders(extra = {}) {
  return uploadToken
    ? { ...extra, Authorization: `Bearer ${uploadToken}` }
    : extra;
}

async function api(url, options = {}) {
  const { timeoutMs = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${url}`, {
      ...fetchOptions,
      headers: requestHeaders(fetchOptions.headers ?? {}),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error ?? `Ошибка сервера: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timeweb API не ответил за ${Math.round(timeoutMs / 1000)} сек. Операция не подтверждена.`, { cause: error });
    }
    if (error instanceof TypeError) {
      throw new Error('Нет ответа от Timeweb API. Возможна проблема сервиса или сети; попробуйте ещё раз позже.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function fileKind(name) {
  const extension = name.split('.').pop()?.toUpperCase();
  return extension?.slice(0, 5) || 'FILE';
}

function updateEmptyState() {
  emptyQueue.hidden = uploadList.children.length > 0;
}

function setCardState(task, state, message) {
  task.state = state;
  task.card.classList.toggle('complete', state === 'complete');
  task.card.classList.toggle('error', state === 'error');
  task.card.classList.toggle('waiting', ['queued', 'connecting'].includes(state));
  task.status.textContent = message;
  task.cancelButton.textContent = state === 'complete' ? '✓' : state === 'error' ? '↻' : '×';
  task.cancelButton.setAttribute('aria-label', state === 'error' ? 'Повторить загрузку' : 'Убрать файл из очереди');
}

function renderProgress(task, uploadedBytes) {
  const ratio = Math.min(1, uploadedBytes / task.file.size);
  const percent = Math.round(ratio * 100);
  task.progress.style.width = `${percent}%`;
  task.percent.textContent = `${percent}%`;

  const elapsed = Math.max((performance.now() - task.startedAt) / 1000, 0.25);
  const speed = Math.max(0, uploadedBytes - task.initialUploaded) / elapsed;
  const remaining = speed > 0 ? (task.file.size - uploadedBytes) / speed : 0;
  const eta = remaining > 60 ? `${Math.ceil(remaining / 60)} мин` : `${Math.ceil(remaining)} сек`;
  task.speed.textContent = speed > 0 ? `${formatBytes(speed)}/с · осталось ${eta}` : '';
}

async function retry(task, operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (task.cancelled) throw new DOMException('Загрузка отменена', 'AbortError');
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        setCardState(task, 'uploading', `Повторная попытка ${attempt}/${attempts - 1}…`);
        await new Promise((resolve) => setTimeout(resolve, 700 * (2 ** (attempt - 1))));
      }
    }
  }
  throw lastError;
}

async function uploadFile(task) {
  try {
    setCardState(task, 'connecting', 'Подключаемся к Timeweb… файл пока не отправлен');
    const previousState = readUploadState(task.file);
    const session = await api('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: task.file.name,
        size: task.file.size,
        type: task.file.type,
        lastModified: task.file.lastModified,
        resumeSession: previousState?.sessionToken,
        receivedChunks: previousState?.receivedChunks ?? [],
      }),
    });

    task.uploadId = session.uploadId;
    task.sessionToken = session.sessionToken ?? previousState?.sessionToken ?? '';
    task.controller = new AbortController();
    const received = new Set(session.receivedChunks ?? []);
    const uploadedParts = new Map(
      (previousState?.parts ?? []).map((part) => [part.partNumber - 1, part]),
    );
    task.initialUploaded = [...received].reduce((sum, index) => {
      const start = index * session.chunkSize;
      return sum + Math.min(session.chunkSize, task.file.size - start);
    }, 0);
    task.startedAt = performance.now();
    let uploaded = task.initialUploaded;
    renderProgress(task, uploaded);
    setCardState(task, 'uploading', session.resumed ? 'Продолжаем загрузку…' : 'Загружаем…');

    for (let index = 0; index < session.totalChunks; index += 1) {
      if (received.has(index)) continue;
      const start = index * session.chunkSize;
      const end = Math.min(start + session.chunkSize, task.file.size);
      const chunk = task.file.slice(start, end);

      const partResult = await retry(task, async () => {
        if (session.provider === 's3-direct') {
          const signed = await api(
            `/api/uploads/${encodeURIComponent(session.uploadId)}/chunks/${index}`,
            {
              method: 'POST',
              headers: task.sessionToken ? { 'X-Upload-Session': task.sessionToken } : {},
            },
          );
          const response = await fetch(signed.uploadUrl, {
            method: 'PUT',
            body: chunk,
            signal: task.controller.signal,
          });
          if (!response.ok) throw new Error(`Хранилище отклонило часть ${index + 1}`);
          return { etag: response.headers.get('ETag') };
        }

        const response = await fetch(
          `${apiBase}/api/uploads/${encodeURIComponent(session.uploadId)}/chunks/${index}`,
          {
            method: 'PUT',
            headers: requestHeaders({
              'Content-Type': 'application/octet-stream',
              ...(task.sessionToken ? { 'X-Upload-Session': task.sessionToken } : {}),
            }),
            body: chunk,
            signal: task.controller.signal,
          },
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error ?? `Ошибка части ${index + 1}`);
        }
        return response.json().catch(() => ({}));
      });

      if (partResult?.etag) {
        uploadedParts.set(index, { partNumber: index + 1, etag: partResult.etag });
      }
      received.add(index);
      if (task.sessionToken) {
        saveUploadState(task.file, {
          sessionToken: task.sessionToken,
          receivedChunks: [...received].sort((a, b) => a - b),
          parts: [...uploadedParts.values()].sort((a, b) => a.partNumber - b.partNumber),
        });
      }
      uploaded += chunk.size;
      renderProgress(task, uploaded);
      task.status.textContent = `Часть ${index + 1} из ${session.totalChunks}`;
    }

    setCardState(task, 'finalizing', 'Передача завершена · проверяем файл и запускаем обработку…');
    const result = await api(`/api/uploads/${encodeURIComponent(session.uploadId)}/complete`, {
      method: 'POST',
      timeoutMs: 120000,
      headers: {
        'Content-Type': 'application/json',
        ...(task.sessionToken ? { 'X-Upload-Session': task.sessionToken } : {}),
      },
      body: JSON.stringify({
        parts: [...uploadedParts.values()].sort((a, b) => a.partNumber - b.partNumber),
      }),
    });
    clearUploadState(task.file);
    renderProgress(task, task.file.size);
    task.speed.textContent = formatBytes(task.file.size);
    setCardState(task, 'complete', result.pipelineQueued
      ? 'Загружено · видео в очереди обработки, статус появится ниже'
      : `Загружено · ${result.name}`);
    await loadFiles();
    await loadPipeline();
  } catch (error) {
    if (error.name === 'AbortError' || task.cancelled) {
      setCardState(task, 'cancelled', 'Загрузка отменена');
    } else {
      setCardState(task, 'error', error instanceof TypeError
        ? 'Нет связи с облачным хранилищем. Подтверждённые части сохранены — нажмите ↻.'
        : error.message);
    }
  }
}

function createTask(file, startImmediately = true) {
  const card = template.content.firstElementChild.cloneNode(true);
  const task = {
    file,
    card,
    state: 'queued',
    uploadId: null,
    cancelled: false,
    controller: null,
    startedAt: performance.now(),
    initialUploaded: 0,
    progress: card.querySelector('.progress-value'),
    percent: card.querySelector('.file-percent'),
    status: card.querySelector('.file-status'),
    speed: card.querySelector('.file-speed'),
    cancelButton: card.querySelector('.cancel-button'),
  };

  card.querySelector('.file-badge').textContent = fileKind(file.name);
  card.querySelector('.file-name').textContent = file.name;
  card.querySelector('.file-meta').textContent = `${formatBytes(file.size)} · ${file.type || 'неизвестный формат'}`;

  task.cancelButton.addEventListener('click', async () => {
    if (['complete', 'cancelled', 'queued'].includes(task.state)) {
      tasks.delete(task);
      pendingTasks = pendingTasks.filter((pending) => pending !== task);
      card.remove();
      updateEmptyState();
      return;
    }
    if (task.state === 'error') {
      if (!uploadToken) {
        setCardState(task, 'queued', 'Ожидает подключения к Timeweb. Нажмите «Продолжить к загрузке».');
        if (!pendingTasks.includes(task)) pendingTasks.push(task);
        orderSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      task.cancelled = false;
      task.startedAt = performance.now();
      task.initialUploaded = 0;
      task.cancelButton.textContent = '×';
      uploadFile(task);
      return;
    }

    task.cancelled = true;
    task.controller?.abort();
    if (task.uploadId) {
      api(`/api/uploads/${encodeURIComponent(task.uploadId)}`, {
        method: 'DELETE',
        headers: task.sessionToken ? { 'X-Upload-Session': task.sessionToken } : {},
      }).catch(() => {});
    }
  });

  tasks.add(task);
  uploadList.append(card);
  updateEmptyState();
  if (startImmediately) uploadFile(task);
  else setCardState(task, 'queued', 'Файл выбран · ожидает создания проекта, ещё не отправлен');
  return task;
}

function addFiles(fileList, startImmediately = true) {
  const added = [];
  [...fileList].forEach((file) => {
    if (file.size > maxFileSize) {
      const card = template.content.firstElementChild.cloneNode(true);
      card.classList.add('error');
      card.querySelector('.file-badge').textContent = fileKind(file.name);
      card.querySelector('.file-name').textContent = file.name;
      card.querySelector('.file-meta').textContent = formatBytes(file.size);
      card.querySelector('.file-status').textContent = `Файл больше лимита ${formatBytes(maxFileSize)}`;
      card.querySelector('.file-percent').textContent = '—';
      card.querySelector('.cancel-button').addEventListener('click', () => card.remove());
      uploadList.append(card);
      emptyQueue.hidden = true;
      return;
    }
    added.push(createTask(file, startImmediately));
  });
  fileInput.value = '';
  extraFileInput.value = '';
  return added;
}

function startPendingTasks() {
  if (!uploadToken) return;
  const ready = pendingTasks;
  pendingTasks = [];
  ready.filter((task) => tasks.has(task) && !task.cancelled).forEach((task) => uploadFile(task));
  if (ready.length) queueSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showPendingConnectionError(message) {
  pendingTasks.forEach((task) => {
    if (tasks.has(task) && !task.cancelled) {
      setCardState(task, 'error', `Файл не отправлен · ${message}`);
    }
  });
}

async function checkHealth() {
  try {
    const health = await api('/api/health', { timeoutMs: 8000 });
    apiAvailable = true;
    serverProtected = health.protected;
    serverState.className = 'server-state online';
    serverState.querySelector('span:last-child').textContent = 'Сервер готов';
    limitValue.textContent = formatBytes(health.maxFileSize);
    maxFileSize = health.maxFileSize;
    chunkValue.textContent = formatBytes(health.chunkSize);
    storageValue.textContent = health.cloud ? 'TIMEWEB' : 'LOCAL';
    retentionValue.textContent = `${health.retentionHours ?? 24} ч`;
    let tokenReady = !serverProtected;
    if (serverProtected && uploadToken) {
      try {
        await api('/api/session');
        tokenReady = true;
      } catch (error) {
        if (![401, 403].includes(error.status)) throw error;
        uploadToken = '';
        tokenInput.value = '';
        sessionStorage.removeItem('montage-upload-link-token');
        localStorage.removeItem('montage-upload-token');
      }
    }
    if (!tokenReady) {
      setAccessState('locked');
      fileInput.disabled = false;
      extraFileInput.disabled = false;
      dropzone.classList.remove('locked');
      dropzone.removeAttribute('aria-disabled');
      if (manualTokenEnabled) tokenBox.hidden = false;
      filesSection.hidden = true;
      orderSection.hidden = false;
    } else {
      setAccessState('ready');
      fileInput.disabled = false;
      extraFileInput.disabled = false;
      dropzone.classList.remove('locked');
      dropzone.removeAttribute('aria-disabled');
      filesSection.hidden = false;
      orderSection.hidden = true;
      pipelineSection.hidden = false;
    }
  } catch (error) {
    apiAvailable = false;
    const staticDemo = window.location.hostname.endsWith('.github.io') && !apiBase;
    if (staticDemo) {
      serverState.className = 'server-state preview';
      serverState.querySelector('span:last-child').textContent = 'Демо интерфейса';
      accessTitle.textContent = 'Публичное демо MontageAI';
      accessText.textContent = 'Дизайн доступен для просмотра. Облачная обработка подключается отдельно.';
      orderSubmit.disabled = true;
      orderSubmit.textContent = 'Обработка скоро будет доступна';
      orderStatus.className = 'form-status';
      orderStatus.textContent = 'Для запуска видео нужен адрес Timeweb backend.';
      fileInput.disabled = true;
      extraFileInput.disabled = true;
      dropzone.classList.add('locked');
      dropzone.setAttribute('aria-disabled', 'true');
      filesSection.hidden = true;
      pipelineSection.hidden = true;
      return;
    }
    serverState.className = 'server-state offline';
    serverState.querySelector('span:last-child').textContent = 'Нет связи с сервером';
    accessTitle.textContent = 'Облако временно недоступно';
    accessText.textContent = 'Файл можно выбрать сейчас. Когда связь восстановится, нажмите «Продолжить к загрузке».';
    orderStatus.className = 'form-status error';
    orderStatus.textContent = error.message;
    fileInput.disabled = false;
    extraFileInput.disabled = false;
    dropzone.classList.remove('locked');
    dropzone.removeAttribute('aria-disabled');
  }
}

async function loadFiles() {
  try {
    const result = await api('/api/files');
    destinationPath.textContent = result.uploadDir;
    filesList.replaceChildren();
    if (!result.files.length) {
      const empty = document.createElement('p');
      empty.className = 'files-empty';
      empty.textContent = 'Пока нет загруженных файлов.';
      filesList.append(empty);
      return;
    }
    result.files.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'stored-file';
      const name = document.createElement('strong');
      name.textContent = file.name;
      const meta = document.createElement('span');
      meta.textContent = `${formatBytes(file.size)} · ${new Date(file.modifiedAt).toLocaleString('ru-RU')}`;
      item.append(name, meta);
      filesList.append(item);
    });
  } catch (error) {
    filesList.textContent = error.message;
  }
}

function pipelineStateLabel(state) {
  return {
    QUEUED: 'Ожидает локальную машину',
    PROCESSING: 'Обрабатывается',
    READY_FOR_REVIEW: 'Готов к проверке',
    LONG_CANDIDATES_READY: 'Кандидаты LONG готовы',
    APPROVED: 'Подтверждён',
    FAILED: 'Ошибка обработки',
  }[state] ?? state;
}

async function sendPipelineAction(task, payload, statusNode, controls) {
  controls.forEach((control) => { control.disabled = true; });
  statusNode.className = 'review-status';
  statusNode.textContent = 'Передаю действие локальной машине…';
  try {
    await api(`/api/pipeline/${encodeURIComponent(task.taskId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    statusNode.className = 'review-status success';
    statusNode.textContent = payload.kind === 'APPROVE'
      ? 'Подтверждение принято. Проверяю и фиксирую final.mp4…'
      : 'Правка принята. Новый preview появится здесь автоматически.';
    await loadPipeline();
  } catch (error) {
    statusNode.className = 'review-status error';
    statusNode.textContent = error.message;
    controls.forEach((control) => { control.disabled = false; });
  }
}

function appendReviewControls(card, task) {
  if (!['READY_FOR_REVIEW', 'APPROVED'].includes(task.state)) return;
  const actionBusy = ['PENDING', 'PROCESSING'].includes(task.action?.state);
  const panel = document.createElement('div');
  panel.className = 'review-actions';
  const heading = document.createElement('strong');
  heading.textContent = 'Управление роликом';
  const textarea = document.createElement('textarea');
  textarea.maxLength = 500;
  textarea.rows = 3;
  textarea.placeholder = 'Например: сделай музыку тише, текст ниже и переделай хук';
  textarea.disabled = actionBusy;
  const buttons = document.createElement('div');
  buttons.className = 'review-buttons';
  const revise = document.createElement('button');
  revise.type = 'button';
  revise.className = 'secondary-button';
  revise.textContent = 'Применить правку';
  revise.disabled = actionBusy;
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'approve-button';
  approve.textContent = 'Всё хорошо — подтвердить';
  approve.disabled = actionBusy || task.state === 'APPROVED';
  const status = document.createElement('p');
  status.className = 'review-status';
  if (actionBusy) {
    status.textContent = task.action.kind === 'APPROVE'
      ? '⏳ Фиксирую подтверждённый preview'
      : '⏳ Локальная машина применяет правку';
  } else if (task.action?.state === 'FAILED') {
    status.className = 'review-status error';
    status.textContent = task.action.detail || 'Последнее действие не выполнено';
  } else if (task.state === 'APPROVED') {
    status.className = 'review-status success';
    status.textContent = '✅ Final зафиксирован. Публикация не запускалась.';
  }
  revise.addEventListener('click', () => {
    const requestText = textarea.value.trim();
    if (!requestText) {
      status.className = 'review-status error';
      status.textContent = 'Сначала напиши, что изменить.';
      return;
    }
    sendPipelineAction(task, { kind: 'REVISION', requestText }, status, [textarea, revise, approve]);
  });
  approve.addEventListener('click', () => {
    const confirmed = window.confirm(
      'Подтвердить именно этот preview? Будет создан final.mp4. Публикация не запускается.',
    );
    if (!confirmed) return;
    sendPipelineAction(
      task,
      { kind: 'APPROVE', confirmation: 'APPROVE' },
      status,
      [textarea, revise, approve],
    );
  });
  buttons.append(revise, approve);
  panel.append(heading, textarea, buttons, status);
  card.append(panel);
}

async function loadPipeline() {
  if (!uploadToken) return;
  try {
    const result = await api('/api/pipeline');
    pipelineList.replaceChildren();
    if (!result.tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'files-empty';
      empty.textContent = 'После загрузки видео здесь появятся стадии обработки.';
      pipelineList.append(empty);
      return;
    }
    result.tasks.forEach((task) => {
      const card = document.createElement('article');
      card.className = `pipeline-card state-${String(task.state).toLowerCase()}`;
      const header = document.createElement('div');
      header.className = 'pipeline-card-header';
      const title = document.createElement('strong');
      title.textContent = pipelineStateLabel(task.state);
      const percent = document.createElement('span');
      percent.textContent = `${Math.round(Number(task.percent) || 0)}%`;
      header.append(title, percent);
      const detail = document.createElement('p');
      detail.textContent = task.detail || 'Ожидаем обновление';
      const track = document.createElement('div');
      track.className = 'progress-track';
      const value = document.createElement('div');
      value.className = 'progress-value';
      value.style.width = `${Math.max(0, Math.min(100, Number(task.percent) || 0))}%`;
      track.append(value);
      const meta = document.createElement('small');
      meta.textContent = task.updatedAt
        ? `Обновлено ${new Date(task.updatedAt).toLocaleString('ru-RU')}`
        : '';
      card.append(header, detail, track, meta);
      if (Array.isArray(task.candidates) && task.candidates.length) {
        const candidates = document.createElement('div');
        candidates.className = 'candidate-list';
        task.candidates.forEach((candidate) => {
          const item = document.createElement('div');
          const heading = document.createElement('strong');
          const start = Number(candidate.sourceStart || 0).toFixed(1);
          const end = Number(candidate.sourceEnd || 0).toFixed(1);
          heading.textContent = `${candidate.candidateId || '—'}. ${candidate.title || 'Фрагмент'}`;
          const description = document.createElement('span');
          description.textContent = `${start}–${end} сек. · ${candidate.score || '—'}/100${candidate.reason ? ` · ${candidate.reason}` : ''}`;
          item.append(heading, description);
          candidates.append(item);
        });
        card.append(candidates);
      }
      if (task.previewUrl) {
        const preview = document.createElement('a');
        preview.className = 'preview-button';
        preview.href = task.previewUrl;
        preview.target = '_blank';
        preview.rel = 'noopener';
        preview.textContent = 'Открыть готовый preview';
        card.append(preview);
      }
      appendReviewControls(card, task);
      pipelineList.append(card);
    });
  } catch (error) {
    pipelineList.textContent = error.message;
  }
}

async function handleSelectedFiles(fileList) {
  const selectedFiles = [...fileList];
  if (!selectedFiles.length) return;

  if (!uploadToken) {
    pendingTasks.push(...addFiles(selectedFiles, false));
    if (!projectConsent.checked) {
      orderStatus.className = 'form-status error';
      orderStatus.textContent = 'Файл выбран. Подтвердите временное хранение и нажмите «Продолжить к загрузке».';
      orderSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (creatingProject) return;

    try {
      await createProject();
      startPendingTasks();
    } catch (error) {
      orderStatus.className = 'form-status error';
      orderStatus.textContent = error.message;
      showPendingConnectionError(error.message);
      return;
    }
    return;
  }

  addFiles(selectedFiles);
  queueSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

fileInput.addEventListener('change', () => handleSelectedFiles(fileInput.files));
extraFileInput.addEventListener('change', () => handleSelectedFiles(extraFileInput.files));

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
  });
}
dropzone.addEventListener('drop', (event) => handleSelectedFiles(event.dataTransfer.files));

clearFinished.addEventListener('click', () => {
  [...tasks].forEach((task) => {
    if (['complete', 'cancelled'].includes(task.state)) {
      tasks.delete(task);
      task.card.remove();
    }
  });
  updateEmptyState();
});

refreshFiles.addEventListener('click', loadFiles);
refreshPipeline.addEventListener('click', loadPipeline);
async function createProject() {
  if (uploadToken) return;
  if (creatingProject) return;
  creatingProject = true;
  orderSubmit.disabled = true;
  orderStatus.className = 'form-status';
  orderStatus.textContent = 'Создаём защищённый проект…';
  try {
    const result = await api('/api/jobs', {
      method: 'POST',
      timeoutMs: 15000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quickStart: true,
        customerName: customerName.value,
        contact: customerContact.value,
        projectType: projectType.value,
        comment: projectComment.value,
        processing: {
          mode: processingMode.value,
          faceTrackingEnabled: faceTrackingEnabled.checked,
          subtitlesEnabled: subtitlesEnabled.checked,
          hookEnabled: hookEnabled.checked,
          requestText: processingRequest.value,
        },
      }),
    });
    uploadToken = result.token;
    sessionStorage.setItem('montage-upload-link-token', uploadToken);
    orderStatus.className = 'form-status success';
    orderStatus.textContent = 'Проект создан. Открываем загрузку…';
    void Promise.allSettled([checkHealth(), loadFiles(), loadPipeline()]);
    if (!pendingTasks.length) dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    orderStatus.className = 'form-status error';
    orderStatus.textContent = error.message;
    throw error;
  } finally {
    creatingProject = false;
    orderSubmit.disabled = false;
  }
}

orderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (creatingProject) return;
  try {
    await createProject();
    startPendingTasks();
  } catch {
    // createProject already shows a user-friendly error.
    showPendingConnectionError(orderStatus.textContent);
  }
});
tokenToggle.addEventListener('click', () => { tokenBox.hidden = !tokenBox.hidden; });
saveToken.addEventListener('click', async () => {
  uploadToken = tokenInput.value.trim();
  if (uploadToken) localStorage.setItem('montage-upload-token', uploadToken);
  else localStorage.removeItem('montage-upload-token');
  tokenBox.hidden = true;
  await checkHealth();
  await loadFiles();
});

async function initialize() {
  updateEmptyState();
  await checkHealth();
  if (apiAvailable && (!serverProtected || uploadToken)) await loadFiles();
  if (apiAvailable && (!serverProtected || uploadToken)) await loadPipeline();
}

initialize();
setInterval(() => {
  if (uploadToken && !document.hidden) loadPipeline();
}, 5000);
