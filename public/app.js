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
const settingsDialog = document.querySelector('#settingsDialog');
const previewDialog = document.querySelector('#previewDialog');
const previewVideo = document.querySelector('#previewVideo');
const revisionDialog = document.querySelector('#revisionDialog');
const revisionText = document.querySelector('#revisionText');
const revisionStatus = document.querySelector('#revisionStatus');
const revisionSubmit = document.querySelector('#revisionSubmit');
const revisionContext = document.querySelector('#revisionContext');
const approvalDialog = document.querySelector('#approvalDialog');
const approvalCopy = document.querySelector('#approvalCopy');
const approvalStatus = document.querySelector('#approvalStatus');
const approvalCancel = document.querySelector('#approvalCancel');
const approvalConfirm = document.querySelector('#approvalConfirm');
const workspace = document.querySelector('#workspace');
const projectShell = document.querySelector('#projectShell');
const projectContext = document.querySelector('#projectContext');
const projectContextTitle = document.querySelector('#projectContextTitle');
const projectContextMeta = document.querySelector('#projectContextMeta');
const backToProjects = document.querySelector('#backToProjects');
const addFilesButton = document.querySelector('#addFilesButton');
const accountDashboard = document.querySelector('#accountDashboard');
const accountMessage = document.querySelector('#accountMessage');
const projectsList = document.querySelector('#projectsList');
const projectsEmpty = document.querySelector('#projectsEmpty');
const projectSkeletons = document.querySelector('#projectSkeletons');
const accountNav = document.querySelector('#accountNav');
const projectsNav = document.querySelector('#projectsNav');
const newProjectNav = document.querySelector('#newProjectNav');
const newProjectButton = document.querySelector('#newProjectButton');
const emptyNewProjectButton = document.querySelector('#emptyNewProjectButton');
const brandButton = document.querySelector('#brandButton');
const loginButton = document.querySelector('#loginButton');
const accountMenu = document.querySelector('#accountMenu');
const accountMenuButton = document.querySelector('#accountMenuButton');
const accountPopover = document.querySelector('#accountPopover');
const userAvatar = document.querySelector('#userAvatar');
const userLabel = document.querySelector('#userLabel');
const userEmail = document.querySelector('#userEmail');
const logoutButton = document.querySelector('#logoutButton');
const logoutStatus = document.querySelector('#logoutStatus');
const authDialog = document.querySelector('#authDialog');
const authTitle = document.querySelector('#authTitle');
const authIntro = document.querySelector('#authIntro');
const authForm = document.querySelector('#authForm');
const authNameField = document.querySelector('#authNameField');
const authName = document.querySelector('#authName');
const authEmail = document.querySelector('#authEmail');
const authPassword = document.querySelector('#authPassword');
const authPasswordConfirmField = document.querySelector('#authPasswordConfirmField');
const authPasswordConfirm = document.querySelector('#authPasswordConfirm');
const authStatus = document.querySelector('#authStatus');
const authSubmit = document.querySelector('#authSubmit');
let revisionTask = null;
let approvalTask = null;

const tasks = new Set();
const config = window.MONTAGE_UPLOAD_CONFIG ?? {};
const apiBase = String(config.apiBase ?? '').replace(/\/$/, '');
const apiOrigin = new URL(apiBase || window.location.origin, window.location.href).origin;
const accountIsSameOrigin = apiOrigin === window.location.origin;
const pendingClaimStorageKey = 'montage-pending-claim-token';
const manualTokenEnabled = config.allowManualToken === true
  || ['localhost', '127.0.0.1'].includes(window.location.hostname);
const url = new URL(window.location.href);
const linkToken = url.searchParams.get('token') ?? '';
const fragmentParameters = new URLSearchParams(url.hash.replace(/^#/, ''));
const fragmentClaimToken = fragmentParameters.get('claim') ?? '';
let pendingClaimToken = fragmentClaimToken
  || sessionStorage.getItem(pendingClaimStorageKey)
  || '';
let uploadToken = linkToken
  || sessionStorage.getItem('montage-upload-link-token')
  || localStorage.getItem('montage-upload-token')
  || '';
let serverProtected = false;
let apiAvailable = false;
let maxFileSize = 1024 * 1024 * 1024;
let pendingTasks = [];
let creatingProject = false;
let authEnabled = false;
let registrationEnabled = true;
let currentUser = null;
let authMode = 'login';
let currentProject = null;
let claimInProgress = false;
if (fragmentClaimToken) sessionStorage.setItem(pendingClaimStorageKey, fragmentClaimToken);
if (linkToken) sessionStorage.setItem('montage-upload-link-token', linkToken);
if (linkToken || fragmentClaimToken) {
  url.searchParams.delete('token');
  if (fragmentClaimToken) url.hash = '';
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
  const { timeoutMs = 30000, projectAuth = true, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${url}`, {
      ...fetchOptions,
      credentials: accountIsSameOrigin ? 'include' : 'omit',
      headers: projectAuth ? requestHeaders(fetchOptions.headers ?? {}) : (fetchOptions.headers ?? {}),
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
      throw new Error(`Сервис не ответил за ${Math.round(timeoutMs / 1000)} сек. Операция не подтверждена.`, { cause: error });
    }
    if (error instanceof TypeError) {
      throw new Error('Нет ответа от сервиса. Проверьте интернет и попробуйте ещё раз.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function accountErrorMessage(error, fallback = 'Не удалось выполнить действие. Попробуйте ещё раз.') {
  if (error?.status === 401) return 'Неверный email или пароль.';
  if (error?.status === 409) return 'Аккаунт с таким email уже существует.';
  if (error?.status === 429) return 'Слишком много попыток. Подождите немного и попробуйте снова.';
  return error?.message || fallback;
}

function setAccountMessage(message, kind = 'error') {
  accountMessage.className = `account-message ${kind}`;
  accountMessage.textContent = message;
  accountMessage.hidden = !message;
}

function accountPortalHref() {
  const target = new URL('/', apiOrigin);
  const tokenToClaim = uploadToken || pendingClaimToken;
  if (tokenToClaim) target.hash = new URLSearchParams({ claim: tokenToClaim }).toString();
  return target.href;
}

async function claimPendingProject() {
  if (!currentUser || !pendingClaimToken) return false;
  if (claimInProgress) return true;
  claimInProgress = true;
  const token = pendingClaimToken;
  setAccountMessage('Добавляем загруженный ролик в ваш аккаунт…', 'info');
  try {
    const result = await api('/api/projects/claim', {
      method: 'POST',
      projectAuth: false,
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobToken: token, title: 'Загруженный ролик' }),
    });
    pendingClaimToken = '';
    sessionStorage.removeItem(pendingClaimStorageKey);
    const title = result.project ? projectName(result.project) : 'Загруженный ролик';
    setAccountMessage(`Готово: «${title}» добавлен в «Мои ролики».`, 'success');
  } catch (error) {
    const message = error.status === 409
      ? 'Этот ролик уже привязан к другому аккаунту. Данные переноса сохранены — можно войти в другой аккаунт и повторить.'
      : `${accountErrorMessage(error, 'Не удалось добавить ролик в аккаунт.')} Данные переноса сохранены, повторим при следующем входе.`;
    setAccountMessage(message, 'error');
  } finally {
    claimInProgress = false;
  }
  return true;
}

async function enterAccountDashboard() {
  showAccountDashboard();
  const claimAttempted = await claimPendingProject();
  await loadAccountProjects({ preserveMessage: claimAttempted });
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  const registering = authMode === 'register';
  authTitle.textContent = registering ? 'Создать аккаунт' : 'Войти в MontageAI';
  authIntro.textContent = registering
    ? 'Сохраняйте историю роликов и открывайте её с телефона или компьютера.'
    : 'Войдите, чтобы видеть свои ролики на любом устройстве.';
  authNameField.hidden = !registering;
  authPasswordConfirmField.hidden = !registering;
  authName.required = registering;
  authPasswordConfirm.required = registering;
  authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  authSubmit.textContent = registering ? 'Создать аккаунт' : 'Войти';
  document.querySelectorAll('[data-auth-mode]').forEach((tab) => {
    const selected = tab.dataset.authMode === authMode;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  authStatus.textContent = '';
  authStatus.className = 'auth-status';
}

function userDisplayName(user) {
  return String(user?.displayName || user?.name || user?.email?.split('@')[0] || 'Профиль');
}

function renderAuthState() {
  if (!authEnabled) {
    accountNav.hidden = true;
    accountMenu.hidden = true;
    loginButton.hidden = true;
    return;
  }

  const signedIn = Boolean(currentUser);
  accountNav.hidden = !signedIn;
  accountMenu.hidden = !signedIn;
  loginButton.hidden = signedIn;
  if (!signedIn) return;

  const name = userDisplayName(currentUser);
  userLabel.textContent = name;
  userEmail.textContent = currentUser.email || '';
  userAvatar.textContent = name.trim().charAt(0).toUpperCase() || 'M';
}

function showGuestStudio() {
  accountDashboard.hidden = true;
  projectShell.hidden = false;
  projectContext.hidden = true;
  workspace.hidden = false;
}

function showAccountDashboard() {
  if (!currentUser) {
    showGuestStudio();
    return;
  }
  accountDashboard.hidden = false;
  projectShell.hidden = true;
  accountPopover.hidden = true;
  accountMenuButton.setAttribute('aria-expanded', 'false');
}

function resetProjectSurface() {
  tasks.clear();
  pendingTasks = [];
  uploadList.replaceChildren();
  pipelineList.replaceChildren();
  filesList.replaceChildren();
  pipelineSection.hidden = true;
  filesSection.hidden = true;
  updateEmptyState();
  orderStatus.textContent = '';
  orderSubmit.hidden = true;
}

async function startNewAccountProject() {
  const uploadInProgress = [...tasks].some((task) => !['complete', 'cancelled', 'error'].includes(task.state));
  if (uploadInProgress) {
    showAccountDashboard();
    setAccountMessage('Текущий файл ещё загружается. Дождитесь окончания передачи, прежде чем создавать новый проект.', 'info');
    return;
  }
  currentProject = null;
  accountMessage.hidden = true;
  uploadToken = '';
  tokenInput.value = '';
  sessionStorage.removeItem('montage-upload-link-token');
  resetProjectSurface();
  accountDashboard.hidden = true;
  projectShell.hidden = false;
  projectContext.hidden = false;
  workspace.hidden = false;
  orderSection.hidden = false;
  addFilesButton.hidden = true;
  projectContextTitle.textContent = 'Новый ролик';
  projectContextMeta.textContent = 'Новый проект';
  projectConsent.checked = false;
  await checkHealth();
  workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function projectIdentifier(project) {
  return String(project?.jobId || project?.id || '');
}

function projectName(project) {
  const raw = project?.title || project?.fileName || project?.name || '';
  if (raw) return String(raw).replace(/\.[a-z0-9]{2,5}$/i, '');
  const id = projectIdentifier(project);
  return id ? `Ролик ${id.slice(-8)}` : 'Новый ролик';
}

function projectState(project) {
  return String(project?.state || project?.status?.state || project?.pipelineState || 'PROJECT').toUpperCase();
}

function projectStateLabel(state) {
  return {
    PROJECT: 'Проект создан',
    NEW: 'Проект создан',
    UPLOADING: 'Загружается',
    QUEUED: 'В очереди',
    PROCESSING: 'Обрабатывается',
    READY_FOR_REVIEW: 'Готов к проверке',
    LONG_CANDIDATES_READY: 'Найдены фрагменты',
    APPROVED: 'Подтверждён',
    FAILED: 'Нужна проверка',
  }[state] || 'Проект';
}

function projectChipClass(state) {
  if (['READY_FOR_REVIEW', 'LONG_CANDIDATES_READY'].includes(state)) return 'ready';
  if (state === 'APPROVED') return 'approved';
  if (state === 'FAILED') return 'failed';
  return '';
}

function formatProjectDate(value) {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) return 'Недавно';
  return parsed.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: parsed.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function renderProjects(projects) {
  projectsList.replaceChildren();
  projectsEmpty.hidden = projects.length > 0;
  projects.forEach((project) => {
    const state = projectState(project);
    const percent = Math.max(0, Math.min(100, Number(project.percent ?? project.status?.percent ?? (state === 'APPROVED' ? 100 : 0)) || 0));
    const card = document.createElement('article');
    card.className = 'project-card';

    const cover = document.createElement('div');
    cover.className = 'project-card-cover';
    const coverIcon = document.createElement('span');
    coverIcon.textContent = state === 'LONG_CANDIDATES_READY' ? '▦' : '▶';
    const modeBadge = document.createElement('span');
    modeBadge.className = 'project-badge';
    modeBadge.textContent = String(project.processing?.mode || project.mode || 'short').toUpperCase();
    cover.append(coverIcon, modeBadge);

    const body = document.createElement('div');
    body.className = 'project-card-body';
    const title = document.createElement('h2');
    title.className = 'project-card-title';
    title.textContent = projectName(project);
    const meta = document.createElement('div');
    meta.className = 'project-card-meta';
    const status = document.createElement('span');
    status.className = `status-chip ${projectChipClass(state)}`.trim();
    status.textContent = projectStateLabel(state);
    const date = document.createElement('span');
    date.textContent = formatProjectDate(project.updatedAt || project.createdAt);
    meta.append(status, date);
    body.append(title, meta);
    if (percent > 0 && percent < 100) {
      const progress = document.createElement('div');
      progress.className = 'project-card-progress';
      const value = document.createElement('span');
      value.style.width = `${percent}%`;
      progress.append(value);
      body.append(progress);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'project-open';
    open.textContent = ['READY_FOR_REVIEW', 'APPROVED', 'LONG_CANDIDATES_READY'].includes(state) ? 'Открыть результат' : 'Открыть проект';
    open.addEventListener('click', () => openAccountProject(project, open));
    body.append(open);
    card.append(cover, body);
    projectsList.append(card);
  });
}

async function loadAccountProjects({ preserveMessage = false } = {}) {
  if (!currentUser || !authEnabled) return;
  projectSkeletons.hidden = false;
  projectsList.hidden = true;
  projectsEmpty.hidden = true;
  if (!preserveMessage) accountMessage.hidden = true;
  try {
    const result = await api('/api/projects', { projectAuth: false, timeoutMs: 15000 });
    const projects = Array.isArray(result) ? result : (result.projects || result.items || []);
    renderProjects(projects);
  } catch (error) {
    setAccountMessage(accountErrorMessage(error, 'Не удалось загрузить список роликов.'), 'error');
  } finally {
    projectSkeletons.hidden = true;
    projectsList.hidden = false;
  }
}

async function openAccountProject(project, control) {
  const jobId = projectIdentifier(project);
  if (!jobId) return;
  control.disabled = true;
  const originalText = control.textContent;
  control.textContent = 'Открываем…';
  try {
    const access = await api(`/api/projects/${encodeURIComponent(jobId)}/access`, {
      method: 'POST',
      projectAuth: false,
      timeoutMs: 15000,
    });
    const token = access.token || access.accessToken;
    if (!token) throw new Error('Сервис не выдал доступ к проекту.');
    uploadToken = token;
    tokenInput.value = token;
    sessionStorage.setItem('montage-upload-link-token', token);
    currentProject = project;
    resetProjectSurface();
    accountDashboard.hidden = true;
    projectShell.hidden = false;
    projectContext.hidden = false;
    workspace.hidden = true;
    addFilesButton.hidden = false;
    projectContextTitle.textContent = projectName(project);
    projectContextMeta.textContent = `${String(project.processing?.mode || project.mode || 'short').toUpperCase()} · ${formatProjectDate(project.createdAt)}`;
    await checkHealth();
    await Promise.allSettled([loadFiles(), loadPipeline()]);
    projectContext.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setAccountMessage(accountErrorMessage(error, 'Не удалось открыть проект.'), 'error');
    control.disabled = false;
    control.textContent = originalText;
  }
}

async function initializeAuth() {
  if (!accountIsSameOrigin) {
    authEnabled = true;
    loginButton.hidden = false;
    loginButton.textContent = uploadToken ? 'Сохранить в кабинет ↗' : 'Личный кабинет ↗';
    loginButton.title = uploadToken
      ? 'Откроется защищённая версия MontageAI, где ролик можно добавить в аккаунт'
      : 'Откроется защищённая версия MontageAI на сервере';
    return;
  }
  try {
    const capabilities = await api('/api/auth/capabilities', { projectAuth: false, timeoutMs: 8000 });
    authEnabled = capabilities.enabled === true || capabilities.authEnabled === true;
    registrationEnabled = capabilities.registrationEnabled !== false && capabilities.registration !== false;
    document.querySelector('#registerTab').hidden = !registrationEnabled;
  } catch (error) {
    if (![404, 501, 503].includes(error.status)) console.warn('Account capabilities unavailable', error);
    authEnabled = false;
  }
  if (!authEnabled) {
    renderAuthState();
    showGuestStudio();
    return;
  }
  try {
    const result = await api('/api/auth/me', { projectAuth: false, timeoutMs: 8000 });
    currentUser = result.user || result.account || null;
  } catch (error) {
    if (![401, 403].includes(error.status)) console.warn('Account session unavailable', error);
    currentUser = null;
  }
  renderAuthState();
  if (currentUser && (pendingClaimToken || !linkToken)) {
    await enterAccountDashboard();
  } else {
    showGuestStudio();
    if (pendingClaimToken && !currentUser) {
      setAuthMode('login');
      authIntro.textContent = 'Войдите или зарегистрируйтесь, чтобы добавить загруженный ролик в «Мои ролики».';
      authDialog.showModal();
      authEmail.focus();
    }
  }
}

function fileKind(name) {
  const extension = name.split('.').pop()?.toUpperCase();
  return extension?.slice(0, 5) || 'FILE';
}

function updateEmptyState() {
  const hasUploads = uploadList.children.length > 0;
  emptyQueue.hidden = hasUploads;
  queueSection.hidden = !hasUploads;
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
        setCardState(task, 'queued', 'Ожидает подключения к Timeweb. Нажмите «Продолжить загрузку».');
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
      card.querySelector('.cancel-button').addEventListener('click', () => {
        card.remove();
        updateEmptyState();
      });
      uploadList.append(card);
      updateEmptyState();
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
      pipelineSection.hidden = true;
      orderSection.hidden = false;
    } else {
      setAccessState('ready');
      fileInput.disabled = false;
      extraFileInput.disabled = false;
      dropzone.classList.remove('locked');
      dropzone.removeAttribute('aria-disabled');
      filesSection.hidden = false;
      orderSection.hidden = true;
      // The processing panel appears only after a real pipeline task exists.
    }
  } catch (error) {
    apiAvailable = false;
    const staticDemo = window.location.hostname.endsWith('.github.io') && !apiBase;
    if (staticDemo) {
      accessBanner.dataset.state = 'preview';
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
    accessBanner.dataset.state = 'error';
    serverState.querySelector('span:last-child').textContent = 'Нет связи с сервером';
    accessTitle.textContent = 'Облако временно недоступно';
    accessText.textContent = 'Файл можно выбрать сейчас. Когда связь восстановится, нажмите «Продолжить загрузку».';
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
    destinationPath.textContent = 'Защищённое хранилище';
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
    QUEUED: 'В очереди',
    PROCESSING: 'Обрабатывается',
    READY_FOR_REVIEW: 'Готов к проверке',
    LONG_CANDIDATES_READY: 'Найдены сильные фрагменты',
    APPROVED: 'Подтверждён',
    FAILED: 'Ошибка обработки',
  }[state] ?? state;
}

async function sendPipelineAction(task, payload, statusNode, controls) {
  controls.forEach((control) => { control.disabled = true; });
  statusNode.className = 'review-status';
  statusNode.textContent = 'Передаём действие в обработку…';
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
    return true;
  } catch (error) {
    statusNode.className = 'review-status error';
    statusNode.textContent = error.message;
    controls.forEach((control) => { control.disabled = false; });
    return false;
  }
}

function appendReviewControls(card, task) {
  if (!['READY_FOR_REVIEW', 'APPROVED'].includes(task.state)) return;
  const actionBusy = ['PENDING', 'PROCESSING'].includes(task.action?.state);
  const panel = document.createElement('div');
  panel.className = 'review-actions';
  const buttons = document.createElement('div');
  buttons.className = 'review-buttons';
  const revise = document.createElement('button');
  revise.type = 'button';
  revise.className = 'secondary-button';
  revise.textContent = 'Изменить';
  revise.disabled = actionBusy;
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'approve-button';
  approve.textContent = 'Подтвердить ролик';
  approve.disabled = actionBusy || task.state === 'APPROVED';
  const status = document.createElement('p');
  status.className = 'review-status';
  if (actionBusy) {
    status.textContent = task.action.kind === 'APPROVE'
      ? '⏳ Фиксирую подтверждённый preview'
      : '⏳ MontageAI применяет правку';
  } else if (task.action?.state === 'FAILED') {
    status.className = 'review-status error';
    status.textContent = task.action.detail || 'Последнее действие не выполнено';
  } else if (task.state === 'APPROVED') {
    status.className = 'review-status success';
    status.textContent = '✅ Final зафиксирован. Публикация не запускалась.';
  }
  revise.addEventListener('click', () => {
    revisionTask = task;
    revisionContext.textContent = task.fileName || task.title || 'Текущая версия ролика';
    revisionText.value = '';
    revisionStatus.textContent = '';
    revisionDialog.showModal();
    revisionText.focus();
  });
  approve.addEventListener('click', () => {
    approvalTask = { task, status, controls: [revise, approve] };
    approvalCopy.textContent = task.fileName
      ? `Мы зафиксируем preview «${task.fileName}» и создадим финальный MP4.`
      : 'Мы зафиксируем выбранный preview и создадим финальный MP4.';
    approvalStatus.textContent = '';
    approvalStatus.className = 'review-status';
    approvalDialog.showModal();
  });
  buttons.append(revise, approve);
  panel.append(buttons, status);
  card.append(panel);
}

async function loadPipeline() {
  if (!uploadToken) return;
  try {
    const result = await api('/api/pipeline');
    pipelineList.replaceChildren();
    if (!result.tasks.length) {
      pipelineSection.hidden = true;
      return;
    }
    pipelineSection.hidden = false;
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
      card.append(header);
      if (task.fileName || task.title) {
        const file = document.createElement('small');
        file.textContent = task.fileName || task.title;
        card.append(file);
      }
      card.append(detail, track, meta);
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
      if (task.previewUrl || task.downloadUrl) {
        const links = document.createElement('div');
        links.className = 'result-links';
        if (task.previewUrl) {
          const preview = document.createElement('button');
          preview.type = 'button';
          preview.className = 'preview-button';
          preview.textContent = 'Смотреть ролик';
          preview.addEventListener('click', () => {
            previewVideo.src = task.previewUrl;
            previewDialog.showModal();
          });
          links.append(preview);
        }
        if (task.downloadUrl) {
          const download = document.createElement('a');
          download.className = 'download-button';
          download.href = task.downloadUrl;
          download.download = `MontageAI_${task.taskId}.mp4`;
          download.textContent = 'Скачать MP4';
          links.append(download);
        }
        card.append(links);
      }
      appendReviewControls(card, task);
      pipelineList.append(card);
    });
  } catch (error) {
    pipelineSection.hidden = false;
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
      orderStatus.textContent = 'Файл выбран. Отметьте согласие на временное хранение — загрузка начнётся автоматически.';
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
      orderSubmit.hidden = false;
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
document.querySelectorAll('.mode-option').forEach((button) => {
  button.addEventListener('click', () => {
    processingMode.value = button.dataset.mode;
    document.querySelectorAll('.mode-option').forEach((option) => {
      const selected = option === button;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-pressed', String(selected));
    });
  });
});
document.querySelector('#openSettings').addEventListener('click', () => settingsDialog.showModal());
document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
previewDialog.addEventListener('close', () => {
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewVideo.load();
});
document.querySelectorAll('[data-suggestion]').forEach((button) => {
  button.addEventListener('click', () => {
    const suggestion = button.dataset.suggestion;
    revisionText.value = revisionText.value.trim()
      ? `${revisionText.value.trim()}, ${suggestion.toLowerCase()}`
      : suggestion;
    revisionText.focus();
  });
});
revisionSubmit.addEventListener('click', async () => {
  const requestText = revisionText.value.trim();
  if (!revisionTask || !requestText) {
    revisionStatus.className = 'review-status error';
    revisionStatus.textContent = 'Напишите, что нужно изменить.';
    return;
  }
  const accepted = await sendPipelineAction(
    revisionTask,
    { kind: 'REVISION', requestText },
    revisionStatus,
    [revisionSubmit, revisionText],
  );
  if (accepted) revisionDialog.close();
});

approvalCancel.addEventListener('click', () => approvalDialog.close());
approvalConfirm.addEventListener('click', async () => {
  if (!approvalTask) return;
  const { task, status, controls } = approvalTask;
  approvalConfirm.disabled = true;
  approvalCancel.disabled = true;
  const accepted = await sendPipelineAction(
    task,
    { kind: 'APPROVE', confirmation: 'APPROVE' },
    approvalStatus,
    [approvalConfirm, approvalCancel, ...controls],
  );
  if (accepted) {
    status.className = 'review-status success';
    status.textContent = 'Подтверждение принято. Создаём финальный MP4.';
    approvalDialog.close();
  }
  approvalConfirm.disabled = false;
  approvalCancel.disabled = false;
});
approvalDialog.addEventListener('close', () => { approvalTask = null; });

document.querySelectorAll('[data-auth-mode]').forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode));
});

loginButton.addEventListener('click', () => {
  if (!accountIsSameOrigin) {
    window.location.assign(accountPortalHref());
    return;
  }
  setAuthMode('login');
  authDialog.showModal();
  authEmail.focus();
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!authEnabled || !accountIsSameOrigin) return;
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (password.length < 10) {
    authStatus.className = 'auth-status error';
    authStatus.textContent = 'Пароль должен содержать минимум 10 символов.';
    return;
  }
  if (authMode === 'register' && password !== authPasswordConfirm.value) {
    authStatus.className = 'auth-status error';
    authStatus.textContent = 'Пароли не совпадают.';
    return;
  }

  authSubmit.disabled = true;
  authStatus.className = 'auth-status';
  authStatus.textContent = authMode === 'register' ? 'Создаём аккаунт…' : 'Входим…';
  try {
    const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const result = await api(endpoint, {
      method: 'POST',
      projectAuth: false,
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        ...(authMode === 'register' ? { displayName: authName.value.trim() } : {}),
      }),
    });
    currentUser = result.user || result.account;
    if (!currentUser) {
      const me = await api('/api/auth/me', { projectAuth: false, timeoutMs: 8000 });
      currentUser = me.user || me.account;
    }
    authForm.reset();
    authDialog.close();
    renderAuthState();
    await enterAccountDashboard();
  } catch (error) {
    authStatus.className = 'auth-status error';
    authStatus.textContent = accountErrorMessage(error);
  } finally {
    authSubmit.disabled = false;
  }
});

accountMenuButton.addEventListener('click', () => {
  const opening = accountPopover.hidden;
  accountPopover.hidden = !opening;
  accountMenuButton.setAttribute('aria-expanded', String(opening));
});

document.addEventListener('click', (event) => {
  if (!accountMenu.hidden && !accountMenu.contains(event.target)) {
    accountPopover.hidden = true;
    accountMenuButton.setAttribute('aria-expanded', 'false');
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  logoutStatus.hidden = true;
  logoutStatus.textContent = '';
  let logoutConfirmed = false;
  try {
    await api('/api/auth/logout', { method: 'POST', projectAuth: false, timeoutMs: 10000 });
    logoutConfirmed = true;
  } catch (error) {
    logoutConfirmed = [401, 403].includes(error.status);
    if (!logoutConfirmed) {
      logoutStatus.textContent = 'Сервис не подтвердил выход. Аккаунт остаётся активным — нажмите ещё раз, чтобы повторить.';
      logoutStatus.hidden = false;
      logoutButton.textContent = 'Повторить выход';
      accountPopover.hidden = false;
      accountMenuButton.setAttribute('aria-expanded', 'true');
    }
  }

  if (logoutConfirmed) {
    currentUser = null;
    currentProject = null;
    uploadToken = '';
    tokenInput.value = '';
    sessionStorage.removeItem('montage-upload-link-token');
    localStorage.removeItem('montage-upload-token');
    resetProjectSurface();
    renderAuthState();
    showGuestStudio();
    await checkHealth();
    logoutButton.textContent = 'Выйти из аккаунта';
  }
  logoutButton.disabled = false;
});

const openNewProject = () => startNewAccountProject().catch((error) => {
  setAccountMessage(accountErrorMessage(error, 'Не удалось открыть новый проект.'), 'error');
});
newProjectNav.addEventListener('click', openNewProject);
newProjectButton.addEventListener('click', openNewProject);
emptyNewProjectButton.addEventListener('click', openNewProject);
projectsNav.addEventListener('click', enterAccountDashboard);
backToProjects.addEventListener('click', enterAccountDashboard);
brandButton.addEventListener('click', async () => {
  if (currentUser) {
    await enterAccountDashboard();
  } else {
    showGuestStudio();
  }
});
addFilesButton.addEventListener('click', () => {
  workspace.hidden = !workspace.hidden;
  addFilesButton.textContent = workspace.hidden ? 'Добавить файл' : 'Скрыть загрузку';
  if (!workspace.hidden) workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

projectConsent.addEventListener('change', async () => {
  if (!projectConsent.checked || !pendingTasks.length || uploadToken || creatingProject) return;
  try {
    await createProject();
    startPendingTasks();
  } catch (error) {
    orderSubmit.hidden = false;
    showPendingConnectionError(error.message);
  }
});

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
    const accountProject = Boolean(currentUser && authEnabled && accountIsSameOrigin);
    const result = await api('/api/jobs', {
      method: 'POST',
      timeoutMs: 15000,
      projectAuth: !accountProject,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quickStart: true,
        title: pendingTasks[0]?.file?.name || 'Новый ролик',
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
    if (!uploadToken) throw new Error('Сервис не выдал доступ к новому проекту.');
    sessionStorage.setItem('montage-upload-link-token', uploadToken);
    if (!accountIsSameOrigin && authEnabled) {
      loginButton.textContent = 'Сохранить в кабинет ↗';
      loginButton.title = 'Откроется защищённая версия MontageAI, где ролик можно добавить в аккаунт';
    }
    if (currentUser) {
      currentProject = result.project || {
        id: result.projectId,
        jobId: result.jobId,
        title: pendingTasks[0]?.file?.name || 'Новый ролик',
        processing: { mode: processingMode.value },
        createdAt: new Date().toISOString(),
      };
      projectContext.hidden = false;
      projectContextTitle.textContent = projectName(currentProject);
      projectContextMeta.textContent = `${processingMode.value.toUpperCase()} · создаётся`;
    }
    orderStatus.className = 'form-status success';
    orderStatus.textContent = 'Проект создан. Открываем загрузку…';
    orderSubmit.hidden = true;
    void Promise.allSettled([checkHealth(), loadFiles(), loadPipeline()]);
    if (!pendingTasks.length) dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    orderStatus.className = 'form-status error';
    orderStatus.textContent = error.message;
    orderSubmit.hidden = false;
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
  await initializeAuth();
  if (!projectShell.hidden && apiAvailable && (!serverProtected || uploadToken)) await loadFiles();
  if (!projectShell.hidden && apiAvailable && (!serverProtected || uploadToken)) await loadPipeline();
  document.body.classList.remove('app-booting');
}

initialize();
setInterval(() => {
  if (uploadToken && !document.hidden) loadPipeline();
}, 5000);
