const dropzone = document.querySelector('#dropzone');
const fileInput = document.querySelector('#fileInput');
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
    accessTitle.textContent = 'Защищённая ссылка активна';
    accessText.textContent = 'Файлы будут доступны только исполнителю заказа.';
  } else if (state === 'locked') {
    accessTitle.textContent = 'Нужна персональная ссылка';
    accessText.textContent = 'Вернитесь в Telegram и нажмите кнопку «Загрузить большой файл».';
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
  const response = await fetch(`${apiBase}${url}`, {
    ...options,
    headers: requestHeaders(options.headers ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Ошибка сервера: ${response.status}`);
  return payload;
}

function fileKind(name) {
  const extension = name.split('.').pop()?.toUpperCase();
  return extension?.slice(0, 5) || 'FILE';
}

function updateEmptyState() {
  emptyQueue.hidden = tasks.size > 0;
}

function setCardState(task, state, message) {
  task.state = state;
  task.card.classList.toggle('complete', state === 'complete');
  task.card.classList.toggle('error', state === 'error');
  task.status.textContent = message;
  if (state === 'complete') task.cancelButton.textContent = '✓';
  if (state === 'error') task.cancelButton.textContent = '↻';
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
    setCardState(task, 'uploading', 'Подготавливаем загрузку…');
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

    const result = await api(`/api/uploads/${encodeURIComponent(session.uploadId)}/complete`, {
      method: 'POST',
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
    setCardState(task, 'complete', `Готово · ${result.name}`);
    await loadFiles();
  } catch (error) {
    if (error.name === 'AbortError' || task.cancelled) {
      setCardState(task, 'cancelled', 'Загрузка отменена');
    } else {
      setCardState(task, 'error', error.message);
    }
  }
}

function createTask(file) {
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
    if (task.state === 'complete' || task.state === 'cancelled') {
      tasks.delete(task);
      card.remove();
      updateEmptyState();
      return;
    }
    if (task.state === 'error') {
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
  uploadFile(task);
}

function addFiles(fileList) {
  [...fileList].forEach(createTask);
  fileInput.value = '';
}

async function checkHealth() {
  try {
    const health = await api('/api/health');
    serverProtected = health.protected;
    serverState.className = 'server-state online';
    serverState.querySelector('span:last-child').textContent = 'Сервер готов';
    limitValue.textContent = formatBytes(health.maxFileSize);
    chunkValue.textContent = formatBytes(health.chunkSize);
    storageValue.textContent = health.cloud ? 'CLOUD' : 'LOCAL';
    retentionValue.textContent = `${health.retentionHours ?? 24} ч`;
    if (serverProtected && !uploadToken) {
      setAccessState('locked');
      fileInput.disabled = true;
      dropzone.classList.add('locked');
      dropzone.setAttribute('aria-disabled', 'true');
      if (manualTokenEnabled) tokenBox.hidden = false;
      filesSection.hidden = true;
    } else {
      setAccessState('ready');
      fileInput.disabled = false;
      dropzone.classList.remove('locked');
      dropzone.removeAttribute('aria-disabled');
      filesSection.hidden = false;
    }
  } catch (error) {
    serverState.className = 'server-state offline';
    serverState.querySelector('span:last-child').textContent = error.message;
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

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => addFiles(fileInput.files));

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
dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

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
  if (!serverProtected || uploadToken) await loadFiles();
}

initialize();
