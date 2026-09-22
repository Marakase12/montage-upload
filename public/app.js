import { freshProcessingOptions, sourceProblem, canStartCreation, projectMatches, previewIdentity, canApplySmartEdit } from './studio-state.js?v=studio-20260922-smart-edit-v2';

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
const aspectInputs = ['#aspect916', '#aspect11', '#aspect169'].map((id) => document.querySelector(id));
const processingRequest = document.querySelector('#processingRequest');
const faceTrackingEnabled = document.querySelector('#faceTrackingEnabled');
const subtitlesEnabled = document.querySelector('#subtitlesEnabled');
const hookEnabled = document.querySelector('#hookEnabled');
const smartEditEnabled = document.querySelector('#smartEditEnabled');
const smartPending = new Set();
const selectedSource = document.querySelector('#selectedSource');
const selectedSourceVideo = document.querySelector('#selectedSourceVideo');
const selectedSourceName = document.querySelector('#selectedSourceName');
const selectedSourceMeta = document.querySelector('#selectedSourceMeta');
const sourceEmpty = document.querySelector('#sourceEmpty');
const modeHint = document.querySelector('#modeHint');
const pipelineNotice = document.querySelector('#pipelineNotice');
const workerNotice = document.querySelector('#workerNotice');
const retryStates = new Map();
let workerStatus = null;
let healthRefreshPending = false;
const previewDownload = document.querySelector('#previewDownload');
const previewApprove = document.querySelector('#previewApprove');
const previewState = document.querySelector('#previewState');
const previewTaskTitle = document.querySelector('#previewTaskTitle');
const previewRefresh = document.querySelector('#previewRefresh');
const projectSearch = document.querySelector('#projectSearch');
const projectCount = document.querySelector('#projectCount');
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
let selectedFile = null;
let sourceObjectUrl = '';
let projectCache = [];
let projectsLoading = false;
let projectFilter = 'all';
let pipelineLoading = false;
let lastPipelineTasks = [];
let activePreviewTask = null;
let activePreviewIdentity = '';
let previewRevisionPending = false;
const revisionDrafts = new Map();

const tasks = new Set();
const config = window.MONTAGE_UPLOAD_CONFIG ?? {};
const apiBase = String(config.apiBase ?? '').replace(/\/$/, '');
const apiOrigin = new URL(apiBase || window.location.origin, window.location.href).origin;
const accountIsSameOrigin = apiOrigin === window.location.origin;
const pendingClaimStorageKey = 'montage-pending-claim-token';
const manualTokenEnabled = config.allowManualToken === true
  || (config.allowManualToken !== false && ['localhost', '127.0.0.1'].includes(window.location.hostname));
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
    accessText.textContent = 'Выберите видео, проверьте настройки и нажмите «Начать монтаж».';
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
  delete accountMessage.dataset.refreshError;
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
  const existingProject = Boolean(uploadToken);
  projectContext.hidden = !existingProject;
  workspace.hidden = existingProject;
  backToProjects.hidden = true;
  addFilesButton.hidden = !existingProject;
  const anotherProjectButton = document.querySelector('#anotherProjectButton');
  if (anotherProjectButton) anotherProjectButton.hidden = !existingProject;
  if (existingProject && !currentProject) {
    projectContextTitle.textContent = 'Ваш проект';
    projectContextMeta.textContent = 'Последний открытый ролик';
  }
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
  retryStates.clear();
  clearSelectedSource();
  if (previewDialog.open) previewDialog.close();
  lastPipelineTasks = [];
  tasks.clear();
  pendingTasks = [];
  uploadList.replaceChildren();
  pipelineList.replaceChildren();
  filesList.replaceChildren();
  pipelineSection.hidden = true;
  filesSection.hidden = true;
  updateEmptyState();
  orderStatus.textContent = '';
  if (pipelineNotice) pipelineNotice.hidden = true;
  orderSubmit.hidden = false;
  syncCreationState();
}

function updateModeHint() {
  updateSmartEditCard();
  if (modeHint) modeHint.textContent = processingMode.value === 'long'
    ? 'Найдём сильные моменты и объясним выбор. На этом этапе короткие ролики автоматически не создаются.'
    : 'Оформим видео целиком. Начало и конец сохранятся, если вы не попросите иначе.';
}

function resetProcessingOptions() {
  const defaults = freshProcessingOptions();
  processingMode.value = defaults.mode;
  aspectInputs.forEach((input) => { input.checked = input.value === defaults.aspectRatio; });
  processingRequest.value = defaults.requestText;
  faceTrackingEnabled.checked = defaults.faceTrackingEnabled;
  subtitlesEnabled.checked = defaults.subtitlesEnabled;
  hookEnabled.checked = defaults.hookEnabled;
  smartEditEnabled.checked = defaults.smartEditEnabled;
  projectComment.value = '';
  projectConsent.checked = false;
  document.querySelectorAll('.mode-option').forEach((option) => {
    const selected = option.dataset.mode === defaults.mode;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', String(selected));
  });
  updateModeHint();
  updateProcessingSummary();
  syncCreationState();
}

function selectedAspectRatio() {
  return aspectInputs.find((input) => input.checked)?.value || '9:16';
}

function updateSmartEditCard() {
  const isLong = processingMode.value === 'long';
  smartEditEnabled.disabled = isLong;
  document.querySelector('#smartEditCard').classList.toggle('is-off', isLong || !smartEditEnabled.checked);
  document.querySelector('#smartEditState').textContent = isLong ? 'Для режима «Оформить целиком»'
    : smartEditEnabled.checked ? 'Включён · решение за вами' : 'Выключен · без дополнительных предложений';
  document.querySelector('#smartEditHelp').textContent = isLong
    ? 'В LONG сначала предложим сильные фрагменты. Умный монтаж целого ролика доступен в соседнем режиме.'
    : smartEditEnabled.checked ? 'Найду случайные повторы речи, затянутые паузы и сильное начало. Покажу план — сокращу только после вашего «Применить».'
      : 'Оформим видео целиком, без дополнительных предложений по сокращению. Режим можно включить перед загрузкой.';
  document.querySelector('.smart-edit-promise').textContent = isLong ? 'Для LONG подбор моментов работает отдельно.'
    : smartEditEnabled.checked ? '↳ План появится в чате проекта. Без скрытых сокращений.' : '↳ Полная длительность исходника сохраняется.';
}
smartEditEnabled.addEventListener('change', updateSmartEditCard);

function appendSmartEditChat(card, task) {
  const plan = task.smartEditProposal;
  if (!plan) return;
  const chat = document.createElement('section');
  chat.className = 'smart-edit-chat';
  chat.setAttribute('aria-label', 'Чат с монтажным ассистентом');
  const header = document.createElement('div');
  header.className = 'smart-chat-heading';
  header.textContent = '✳  Монтажный ассистент';
  const bubble = document.createElement('div');
  bubble.className = 'smart-chat-bubble';
  const message = document.createElement('p');
  message.textContent = plan.state === 'APPLIED' ? 'Готово. Применил подтверждённый вами план. Новый результат доступен в этом проекте.' : plan.message;
  bubble.append(message);
  const changes = document.createElement('ul');
  for (const change of plan.changes || []) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = change.title;
    const reason = document.createElement('span');
    reason.textContent = change.reason;
    item.append(title, reason);
    if (Array.isArray(change.cuts)) {
      const cuts = document.createElement('ul');
      cuts.className = 'smart-speech-cuts';
      for (const cut of change.cuts) {
        const detail = document.createElement('li');
        const range = document.createElement('strong');
        range.textContent = `${cut.sourceStart.toFixed(2)}–${cut.sourceEnd.toFixed(2)} с исходника`;
        const quote = document.createElement('span');
        quote.textContent = `Убрать «${cut.removedText}» → оставить «${cut.keptText}»`;
        const why = document.createElement('span');
        why.textContent = cut.reason;
        detail.append(range, quote, why);
        cuts.append(detail);
      }
      item.append(cuts);
    }
    changes.append(item);
  }
  if (changes.children.length) bubble.append(changes);
  if (Number.isFinite(plan.beforeSeconds) && Number.isFinite(plan.afterSeconds)) {
    const duration = document.createElement('p');
    duration.className = 'smart-duration';
    duration.textContent = `${plan.state === 'APPLIED' ? 'Длительность' : 'По плану'}: ${plan.beforeSeconds.toFixed(1)} → ${plan.afterSeconds.toFixed(1)} сек.`;
    bubble.append(duration);
  }
  if (plan.state === 'PROPOSED') {
    const consent = document.createElement('p');
    consent.className = 'smart-consent';
    consent.textContent = 'Нажатие «Применить план» разрешает только перечисленные правки. Это не публикация.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary-button smart-apply';
    button.textContent = 'Применить план';
    button.disabled = !canApplySmartEdit(task) || smartPending.has(plan.id);
    const feedback = document.createElement('p');
    feedback.className = 'review-status';
    feedback.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      if (smartPending.has(plan.id) || !canApplySmartEdit(task)) return;
      smartPending.add(plan.id);
      try {
        await sendPipelineAction(task, { kind: 'REVISION', smartEditProposalId: plan.id, confirmation: 'APPLY_SMART_EDIT',
          ...(plan.version === 2 ? { smartEditProposalVersion: 2 } : {}) }, feedback, [button]);
      } finally { smartPending.delete(plan.id); }
    });
    bubble.append(consent, button, feedback);
  }
  chat.append(header, bubble);
  card.append(chat);
}

function updateProcessingSummary() {
  const summary = document.querySelector('#processingSummary');
  if (!summary) return;
  const enabled = [
    subtitlesEnabled.checked && 'субтитры с подсветкой',
    hookEnabled.checked && 'верхний заголовок',
    faceTrackingEnabled.checked && 'слежение за лицом',
  ].filter(Boolean);
  const ratio = selectedAspectRatio();
  const dimensions = { '9:16': '1080 × 1920', '1:1': '1080 × 1080', '16:9': '1920 × 1080' };
  const hint = document.querySelector('#formatHint');
  if (hint) hint.textContent = `${dimensions[ratio]} · видео без растягивания`;
  summary.textContent = `Формат ${ratio}. ` + (enabled.length
    ? `Включено: ${enabled.join(', ')}.`
    : 'Без субтитров, верхнего заголовка и слежения за лицом.');
}

function syncCreationState() {
  orderSubmit.disabled = !canStartCreation({ file: selectedFile, consent: projectConsent.checked, busy: creatingProject, maxFileSize });
  orderSubmit.textContent = creatingProject ? 'Создаём проект…' : 'Начать монтаж';
  fileInput.disabled = creatingProject;
  aspectInputs.forEach((input) => { input.disabled = creatingProject; });
  const remove = document.querySelector('#removeSourceButton');
  if (remove) remove.disabled = creatingProject;
  const note = document.querySelector('.action-note');
  if (note) {
    note.hidden = Boolean(selectedFile && projectConsent.checked);
    note.textContent = selectedFile ? 'Подтвердите временное хранение, чтобы начать.' : 'Сначала выберите исходное видео.';
  }
}

function clearSelectedSource() {
  selectedFile = null;
  if (selectedSourceVideo) {
    selectedSourceVideo.pause();
    selectedSourceVideo.removeAttribute('src');
    selectedSourceVideo.load();
    selectedSourceVideo.hidden = true;
  }
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = '';
  if (selectedSource) selectedSource.hidden = true;
  if (sourceEmpty) sourceEmpty.hidden = false;
  fileInput.value = '';
  syncCreationState();
}

async function startNewAccountProject() {
  const uploadInProgress = [...tasks].some((task) => ['connecting', 'uploading', 'finalizing'].includes(task.state));
  if (uploadInProgress || creatingProject) {
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
  resetProcessingOptions();
  accountDashboard.hidden = true;
  projectShell.hidden = false;
  projectContext.hidden = false;
  workspace.hidden = false;
  orderSection.hidden = false;
  addFilesButton.hidden = true;
  const anotherProjectButton = document.querySelector('#anotherProjectButton');
  if (anotherProjectButton) anotherProjectButton.hidden = true;
  projectContextTitle.textContent = 'Новый ролик';
  projectContextMeta.textContent = 'Новый проект';
  backToProjects.hidden = !currentUser;
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
  return String(project?.state || project?.status?.state || project?.pipelineState || 'UNKNOWN').toUpperCase();
}

function projectStateLabel(state) {
  return {
    PROJECT: 'Проект создан',
    CREATED: 'Видео ещё не добавлено',
    UPLOADED: 'Видео загружено',
    EXPIRED: 'Срок хранения истёк',
    UNAVAILABLE: 'Файл недоступен',
    UNKNOWN: 'Статус уточняется',
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
  const visible = projects.filter((project) => projectMatches(project, projectSearch?.value, projectFilter));
  if (projectCount) projectCount.textContent = projects.length ? String(projects.length) : '';
  if (projects.length && !visible.length) {
    const empty = document.createElement('p');
    empty.className = 'project-empty-search';
    empty.textContent = 'Здесь пока нет роликов. Попробуйте другой фильтр или название.';
    projectsList.append(empty);
  }
  visible.forEach((project) => {
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
    modeBadge.textContent = (project.processing?.mode || project.mode) === 'long' ? 'Нарезка' : 'Целиком';
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
    date.textContent = formatProjectDate(project.summary?.updatedAt || project.updatedAt || project.createdAt);
    meta.append(status, date);
    body.append(title, meta);
    if (project.detail) {
      const detail = document.createElement('p');
      detail.className = 'project-card-detail';
      detail.textContent = project.detail;
      body.append(detail);
    }
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

async function loadAccountProjects({ preserveMessage = false, background = false } = {}) {
  if (!currentUser || !authEnabled || projectsLoading) return;
  projectsLoading = true;
  const requestedUser = currentUser;
  if (!background) {
    projectSkeletons.hidden = false;
    projectsList.hidden = true;
    projectsEmpty.hidden = true;
  }
  if (!preserveMessage) accountMessage.hidden = true;
  try {
    const result = await api('/api/projects', { projectAuth: false, timeoutMs: 15000 });
    if (requestedUser !== currentUser) return;
    if (accountMessage.dataset.refreshError) setAccountMessage('');
    const projects = Array.isArray(result) ? result : (result.projects || result.items || []);
    const changed = JSON.stringify(projects) !== JSON.stringify(projectCache);
    projectCache = projects;
    if (!background || changed) renderProjects(projectCache);
  } catch (error) {
    if (requestedUser === currentUser) {
      setAccountMessage(accountErrorMessage(error, 'Не удалось обновить список роликов. Последний статус сохранён.'), 'error');
      accountMessage.dataset.refreshError = 'true';
    }
  } finally {
    projectsLoading = false;
    projectSkeletons.hidden = true;
    projectsList.hidden = false;
  }
}

async function openAccountProject(project, control) {
  const jobId = projectIdentifier(project);
  if (!jobId) return;
  if (creatingProject || [...tasks].some((task) => ['connecting', 'uploading', 'finalizing'].includes(task.state))) {
    setAccountMessage('Видео ещё передаётся. Дождитесь завершения загрузки, прежде чем открывать другой проект.', 'info');
    return;
  }
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
    currentProject = access.project || project;
    resetProjectSurface();
    accountDashboard.hidden = true;
    projectShell.hidden = false;
    projectContext.hidden = false;
    workspace.hidden = true;
    addFilesButton.hidden = false;
    const anotherProjectButton = document.querySelector('#anotherProjectButton');
    if (anotherProjectButton) anotherProjectButton.hidden = false;
    projectContextTitle.textContent = projectName(project);
    projectContextMeta.textContent = `${String(project.processing?.mode || project.mode || 'short').toUpperCase()} · ${project.processing?.aspectRatio || '9:16'} · ${formatProjectDate(project.createdAt)}`;
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
    updateWorkerState(health.worker);
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
      orderSection.hidden = Boolean(uploadToken);
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
    accessText.textContent = 'Видео останется выбранным. Проверьте связь и снова нажмите «Начать монтаж».';
    orderStatus.className = 'form-status error';
    orderStatus.textContent = error.message;
    fileInput.disabled = false;
    extraFileInput.disabled = false;
    dropzone.classList.remove('locked');
    dropzone.removeAttribute('aria-disabled');
  } finally {
    syncCreationState();
  }
}

async function loadFiles() {
  const requestedToken = uploadToken;
  try {
    const result = await api('/api/files');
    if (requestedToken !== uploadToken) return;
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
    if (requestedToken !== uploadToken) return;
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

function updateWorkerState(worker) {
  workerStatus = worker || { state: 'UNKNOWN', phase: null };
  const online = workerStatus.state === 'ONLINE';
  serverState.className = `server-state ${online ? 'online' : 'waiting'}`;
  serverState.querySelector('span:last-child').textContent = online
    ? (workerStatus.phase === 'busy' ? 'Обработчик занят' : 'Готов к монтажу')
    : 'Загрузка доступна';
  serverState.setAttribute('aria-label', online ? 'Сервер и обработчик на связи' : 'Сервер на связи, обработчик пока не подтвердил доступность');
  if (workerNotice) {
    workerNotice.hidden = online;
    workerNotice.textContent = workerStatus.state === 'OFFLINE'
      ? 'Обработчик сейчас не в сети. Видео можно загрузить: оно будет ждать в очереди до подключения, в пределах срока хранения файлов.'
      : 'Сервер доступен. Связь с обработчиком пока не подтверждена — загруженное видео будет ждать в очереди.';
  }
}

async function refreshWorkerHealth() {
  if (healthRefreshPending) return;
  healthRefreshPending = true;
  try {
    const health = await api('/api/health', { timeoutMs: 8000 });
    updateWorkerState(health.worker);
  } catch {
    updateWorkerState({ state: 'UNKNOWN' });
    serverState.className = 'server-state offline';
    serverState.querySelector('span:last-child').textContent = 'Проверяем связь';
    if (workerNotice) workerNotice.textContent = 'Не удаётся обновить связь с сервисом. Это не подтверждает ошибку обработки; проверим ещё раз автоматически.';
  } finally { healthRefreshPending = false; }
}

async function retryPipelineTask(task) {
  const requestedToken = uploadToken;
  if (!requestedToken || task.state !== 'FAILED' || task.retryable !== true || retryStates.get(task.taskId)?.pending) return false;
  const state = { pending: true, message: 'Передаём запрос на повтор…', error: false };
  retryStates.set(task.taskId, state);
  try {
    const result = await api(`/api/pipeline/${encodeURIComponent(task.taskId)}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!result.ok || !['QUEUED', 'PROCESSING'].includes(result.status?.state)) throw new Error('Сервис не подтвердил повтор. Обновите статус перед следующей попыткой.');
    if (requestedToken !== uploadToken) return false;
    state.message = 'Повтор принят. Загрузка исходника заново не нужна.';
    await loadPipeline();
    return true;
  } catch (error) {
    if (requestedToken !== uploadToken) return false;
    state.message = error.message;
    state.error = true;
    return false;
  } finally {
    state.pending = false;
    if (state.button) state.button.disabled = false;
    if (state.node) {
      state.node.textContent = state.message;
      state.node.className = `review-status${state.error ? ' error' : ''}`;
    }
  }
}

async function sendPipelineAction(task, payload, statusNode, controls) {
  controls.forEach((control) => { control.disabled = true; });
  statusNode.className = 'review-status';
  statusNode.textContent = 'Передаём действие в обработку…';
  try {
    const result = await api(`/api/pipeline/${encodeURIComponent(task.taskId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (result.action) {
      task.action = result.action;
      if (activePreviewTask?.taskId === task.taskId) syncReview({ ...activePreviewTask, action: result.action });
    }
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
  if (task.resultAvailability && task.resultAvailability !== 'AVAILABLE') return;
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
    openReview(task, true);
  });
  approve.addEventListener('click', () => {
    openApproval(task, status, [revise, approve]);
  });
  buttons.append(revise, approve);
  panel.append(buttons, status);
  card.append(panel);
}

function openApproval(task, status, controls = []) {
  approvalTask = { task, status, controls };
  approvalCopy.textContent = task.fileName
    ? `Зафиксируем текущую версию «${task.fileName}» и создадим финальный MP4.`
    : 'Зафиксируем текущую версию и создадим финальный MP4.';
  approvalStatus.textContent = '';
  approvalStatus.className = 'review-status';
  approvalConfirm.disabled = false;
  approvalCancel.disabled = false;
  if (!approvalDialog.open) approvalDialog.showModal();
}

function syncReview(task) {
  activePreviewTask = task;
  revisionTask = task;
  const resultUnavailable = task.resultAvailability && task.resultAvailability !== 'AVAILABLE';
  const ready = !resultUnavailable && ['READY_FOR_REVIEW', 'APPROVED'].includes(task.state);
  const busy = ['PENDING', 'PROCESSING'].includes(task.action?.state);
  revisionDialog.hidden = !ready && !busy;
  revisionSubmit.disabled = !ready || busy || previewRevisionPending;
  revisionText.disabled = previewRevisionPending;
  if (previewTaskTitle) previewTaskTitle.textContent = task.fileName || task.title || 'Ваш ролик';
  revisionContext.textContent = busy ? 'Применяем изменения. Можно подготовить следующую правку.' : 'Опишите изменения своими словами.';
  if (previewState) previewState.textContent = resultUnavailable
    ? (task.resultUnavailableReason || 'Результат сейчас недоступен')
    : busy ? 'Применяем изменения…' : pipelineStateLabel(task.state);
  if (previewApprove) {
    previewApprove.hidden = !ready;
    previewApprove.disabled = busy || task.state === 'APPROVED' || previewIdentity(task) !== activePreviewIdentity;
    previewApprove.textContent = task.state === 'APPROVED' ? 'Финальная версия подтверждена' : 'Подтвердить ролик';
  }
  if (previewDownload) {
    previewDownload.hidden = !task.downloadUrl;
    if (task.downloadUrl) {
      previewDownload.href = task.downloadUrl;
      previewDownload.download = `MontageAI_${task.taskId}.mp4`;
    } else previewDownload.removeAttribute('href');
  }
  if (previewRefresh) previewRefresh.hidden = !task.previewUrl || previewIdentity(task) === activePreviewIdentity;
  if (task.action?.state === 'FAILED') {
    revisionStatus.className = 'review-status error';
    revisionStatus.textContent = task.action.detail || 'Не удалось применить изменение. Текущая версия сохранена.';
  } else if (busy) {
    revisionStatus.className = 'review-status';
    revisionStatus.textContent = task.action.kind === 'APPROVE' ? 'Проверяем и сохраняем финальную версию…' : 'Правка в работе. Новую версию можно будет открыть здесь.';
  } else if (previewRefresh && !previewRefresh.hidden) {
    revisionStatus.className = 'review-status success';
    revisionStatus.textContent = 'Новая версия готова. Нажмите «Обновить видео», когда закончите просмотр.';
  }
}

function openReview(task, focusRevision = false) {
  if (revisionTask) revisionDrafts.set(revisionTask.taskId, revisionText.value);
  const changed = activePreviewTask?.taskId !== task.taskId || !previewVideo.getAttribute('src');
  if (changed) {
    revisionText.value = revisionDrafts.get(task.taskId) || '';
    revisionStatus.textContent = '';
    if (task.previewUrl) previewVideo.src = task.previewUrl;
    activePreviewIdentity = previewIdentity(task);
  }
  syncReview(task);
  if (!previewDialog.open) previewDialog.showModal();
  if (focusRevision) revisionText.focus();
}

async function loadPipeline() {
  if (!uploadToken || pipelineLoading === uploadToken) return;
  const requestedToken = uploadToken;
  pipelineLoading = requestedToken;
  try {
    const result = await api('/api/pipeline');
    if (requestedToken !== uploadToken) return;
    if (result.worker) updateWorkerState(result.worker);
    lastPipelineTasks = result.tasks;
    if (pipelineNotice) pipelineNotice.hidden = true;
    if (activePreviewTask && previewDialog.open) {
      const latest = result.tasks.find((task) => task.taskId === activePreviewTask.taskId);
      if (latest) syncReview(latest);
    }
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
      title.textContent = task.resultAvailability && task.resultAvailability !== 'AVAILABLE'
        ? ({ EXPIRED: 'Срок хранения истёк', MISSING: 'Файл недоступен', UNKNOWN: 'Проверяем доступность результата' }[task.resultAvailability] || 'Результат недоступен')
        : pipelineStateLabel(task.state);
      const percent = document.createElement('span');
      const resultUnavailable = task.resultAvailability && task.resultAvailability !== 'AVAILABLE';
      percent.textContent = resultUnavailable ? '' : `${Math.round(Number(task.percent) || 0)}%`;
      header.append(title, percent);
      const detail = document.createElement('p');
      detail.textContent = task.resultUnavailableReason || task.detail || 'Ожидаем обновление';
      if (task.state === 'QUEUED' && workerStatus?.state === 'OFFLINE') {
        detail.textContent = 'Видео сохранено. Ожидаем подключения обработчика; повторно загружать файл не нужно. Срок хранения ограничен.';
      }
      const track = document.createElement('div');
      track.className = 'progress-track';
      track.hidden = Boolean(resultUnavailable);
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', 'Обработка ролика');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Number(task.percent) || 0))));
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
      if (task.state === 'FAILED') {
        const retryNote = document.createElement('p');
        retryNote.className = 'review-status';
        if (task.retryable === true) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'secondary-button';
          retry.textContent = 'Повторить обработку';
          const saved = retryStates.get(task.taskId);
          retry.disabled = saved?.pending === true;
          retryNote.textContent = saved?.message || 'Используем сохранённый исходник и проверенные этапы обработки.';
          if (saved) { saved.node = retryNote; saved.button = retry; }
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            const pending = retryPipelineTask(task);
            const current = retryStates.get(task.taskId);
            if (current) { current.node = retryNote; current.button = retry; retryNote.textContent = current.message; }
            await pending;
            retry.disabled = false;
          });
          card.append(retry, retryNote);
        } else if (task.retryReason) {
          retryNote.textContent = ({
            SOURCE_EXPIRED: 'Срок хранения исходника истёк. Для нового монтажа загрузите видео снова.',
            SOURCE_MISSING: 'Сохранённый исходник недоступен. Для нового монтажа загрузите видео снова.',
            SOURCE_UNKNOWN: 'Не удалось проверить исходник. Обновите статус чуть позже.',
            ACTION_REQUIRES_REVIEW: 'Эта ошибка связана с правкой или подтверждением. Повтор требует проверки текущего результата.',
            NOT_FAILED: 'Повтор сейчас не требуется.',
          })[task.retryReason] || 'Повтор сейчас недоступен. Попробуйте обновить статус позже.';
          card.append(retryNote);
        }
      }
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
      appendSmartEditChat(card, task);
      if (task.previewUrl || task.downloadUrl) {
        const links = document.createElement('div');
        links.className = 'result-links';
        if (task.previewUrl) {
          const preview = document.createElement('button');
          preview.type = 'button';
          preview.className = 'preview-button';
          preview.textContent = 'Смотреть и редактировать';
          preview.addEventListener('click', () => openReview(task));
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
    if (requestedToken !== uploadToken) return;
    pipelineSection.hidden = false;
    if (pipelineNotice) {
      pipelineNotice.hidden = false;
      pipelineNotice.textContent = `${error.message} Последний полученный статус сохранён; попробуем обновить автоматически.`;
    } else if (!pipelineList.children.length) pipelineList.textContent = error.message;
  } finally {
    if (pipelineLoading === requestedToken) pipelineLoading = false;
  }
}

function handleSelectedFiles(fileList) {
  const selectedFiles = [...fileList];
  if (!selectedFiles.length || creatingProject) return;
  const file = selectedFiles[0];
  const problem = sourceProblem(file, maxFileSize);
  if (problem) {
    orderStatus.className = 'form-status error';
    orderStatus.textContent = file.size > maxFileSize ? `Видео больше лимита ${formatBytes(maxFileSize)}.` : problem;
    fileInput.value = '';
    return;
  }
  clearSelectedSource();
  selectedFile = file;
  if (selectedSource) selectedSource.hidden = false;
  if (sourceEmpty) sourceEmpty.hidden = true;
  if (selectedSourceName) selectedSourceName.textContent = file.name;
  if (selectedSourceMeta) selectedSourceMeta.textContent = `${formatBytes(file.size)} · ${fileKind(file.name)} · ещё не отправлено`;
  if (selectedSourceVideo) {
    sourceObjectUrl = URL.createObjectURL(file);
    selectedSourceVideo.src = sourceObjectUrl;
    selectedSourceVideo.hidden = false;
  }
  orderStatus.className = 'form-status';
  orderStatus.textContent = selectedFiles.length > 1
    ? 'Для одного проекта выбрано первое видео. Остальные можно оформить отдельными проектами.'
    : 'Видео выбрано. Проверьте пожелания и нажмите «Начать монтаж».';
  orderSubmit.hidden = false;
  syncCreationState();
}

fileInput.addEventListener('change', () => handleSelectedFiles(fileInput.files));
extraFileInput.addEventListener('change', () => {
  if (!extraFileInput.files.length) return;
  if (uploadToken) {
    addFiles(extraFileInput.files);
    queueSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    pendingTasks.push(...addFiles(extraFileInput.files, false));
    orderStatus.textContent = 'Дополнительные материалы выбраны. Они отправятся после нажатия «Начать монтаж».';
  }
});
document.querySelector('#removeSourceButton')?.addEventListener('click', () => {
  clearSelectedSource();
  orderStatus.textContent = '';
});
selectedSourceVideo?.addEventListener('loadedmetadata', () => {
  if (!selectedFile || !selectedSourceMeta || !Number.isFinite(selectedSourceVideo.duration)) return;
  const seconds = Math.round(selectedSourceVideo.duration);
  selectedSourceMeta.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · ${formatBytes(selectedFile.size)} · ${fileKind(selectedFile.name)}`;
});
selectedSourceVideo?.addEventListener('error', () => {
  selectedSourceVideo.hidden = true;
  if (selectedFile && selectedSourceMeta) selectedSourceMeta.textContent = `${formatBytes(selectedFile.size)} · ${fileKind(selectedFile.name)} · предпросмотр недоступен в браузере, файл можно отправить`;
});
document.querySelectorAll('.mode-option').forEach((button) => {
  button.addEventListener('click', () => {
    processingMode.value = button.dataset.mode;
    document.querySelectorAll('.mode-option').forEach((option) => {
      const selected = option === button;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-pressed', String(selected));
    });
    updateModeHint();
  });
});
document.querySelector('#openSettings').addEventListener('click', () => settingsDialog.showModal());
[faceTrackingEnabled, subtitlesEnabled, hookEnabled, ...aspectInputs].forEach((option) => {
  option.addEventListener('change', updateProcessingSummary);
});
document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
previewDialog.addEventListener('close', () => {
  if (revisionTask) revisionDrafts.set(revisionTask.taskId, revisionText.value);
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewVideo.load();
});
revisionText.addEventListener('input', () => {
  if (revisionTask) revisionDrafts.set(revisionTask.taskId, revisionText.value);
});
previewRefresh?.addEventListener('click', () => {
  if (!activePreviewTask?.previewUrl) return;
  previewVideo.src = activePreviewTask.previewUrl;
  activePreviewIdentity = previewIdentity(activePreviewTask);
  previewRefresh.hidden = true;
  revisionStatus.textContent = 'Открыта актуальная версия.';
  syncReview(activePreviewTask);
});
previewVideo.addEventListener('error', () => {
  if (!previewDialog.open) return;
  if (previewState) previewState.textContent = 'Не удалось открыть видео. Обновите ссылку или скачайте файл.';
  if (previewRefresh) previewRefresh.hidden = false;
});
previewApprove?.addEventListener('click', () => {
  if (activePreviewTask && !previewApprove.disabled) openApproval(activePreviewTask, revisionStatus, [previewApprove, revisionSubmit]);
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
  if (previewRevisionPending || revisionSubmit.disabled) return;
  previewRevisionPending = true;
  const submittedTask = revisionTask;
  const accepted = await sendPipelineAction(
    revisionTask,
    { kind: 'REVISION', requestText },
    revisionStatus,
    [revisionSubmit, revisionText],
  );
  previewRevisionPending = false;
  if (accepted) {
    revisionDrafts.delete(submittedTask.taskId);
    if (revisionTask?.taskId === submittedTask.taskId) revisionText.value = '';
  }
  if (activePreviewTask) syncReview(activePreviewTask);
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
    if (selectedFile && !pendingClaimToken) {
      showGuestStudio();
      backToProjects.hidden = false;
      syncCreationState();
    } else await enterAccountDashboard();
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
  if (creatingProject || [...tasks].some((task) => ['connecting', 'uploading', 'finalizing'].includes(task.state))) {
    logoutStatus.textContent = 'Файл ещё загружается. Дождитесь завершения или отмените загрузку перед выходом.';
    logoutStatus.hidden = false;
    return;
  }
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
document.querySelector('#anotherProjectButton')?.addEventListener('click', openNewProject);
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
  extraFileInput.click();
});

projectConsent.addEventListener('change', syncCreationState);
projectSearch?.addEventListener('input', () => renderProjects(projectCache));
document.querySelectorAll('[data-project-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    projectFilter = button.dataset.projectFilter;
    document.querySelectorAll('[data-project-filter]').forEach((option) => {
      const active = option === button;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', String(active));
    });
    renderProjects(projectCache);
  });
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
  syncCreationState();
  orderStatus.className = 'form-status';
  orderStatus.textContent = 'Создаём защищённый проект…';
  try {
    const accountProject = Boolean(currentUser && authEnabled && accountIsSameOrigin);
    if (processingMode.value !== 'long' && smartEditEnabled.checked) {
      const capability = await api('/api/health', { timeoutMs: 8000 });
      if (capability.smartEditProposalsVersion !== 1 || capability.speechCleanupProposalsVersion !== 1) throw new Error('Обновление умного монтажа ещё не подключено на сервере. Попробуйте позже или выключите эту опцию для обычного монтажа.');
    }
    const result = await api(accountProject ? '/api/projects' : '/api/jobs', {
      method: 'POST',
      timeoutMs: 15000,
      projectAuth: !accountProject,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quickStart: true,
        title: selectedFile?.name || 'Новый ролик',
        customerName: customerName.value,
        contact: customerContact.value,
        projectType: projectType.value,
        comment: projectComment.value,
        processing: {
          mode: processingMode.value,
          aspectRatio: selectedAspectRatio(),
          faceTrackingEnabled: faceTrackingEnabled.checked,
          subtitlesEnabled: subtitlesEnabled.checked,
          hookEnabled: hookEnabled.checked,
          smartEditEnabled: processingMode.value !== 'long' && smartEditEnabled.checked,
          requestText: processingRequest.value,
        },
      }),
    });
    if (accountProject && !result.project) throw new Error('Сервис не подтвердил сохранение проекта в кабинете. Загрузка не запущена.');
    uploadToken = result.token || result.jobToken;
    if (!uploadToken) throw new Error('Сервис не выдал доступ к новому проекту.');
    sessionStorage.setItem('montage-upload-link-token', uploadToken);
    if (!accountIsSameOrigin && authEnabled) {
      loginButton.textContent = 'Сохранить в кабинет ↗';
      loginButton.title = 'Откроется защищённая версия MontageAI, где ролик можно добавить в аккаунт';
    }
    if (currentUser) {
      currentProject = result.project;
      projectContext.hidden = false;
      projectContextTitle.textContent = projectName(currentProject);
      projectContextMeta.textContent = `${processingMode.value.toUpperCase()} · ${selectedAspectRatio()} · создаётся`;
    }
    orderStatus.className = 'form-status success';
    orderStatus.textContent = 'Проект создан. Открываем загрузку…';
    orderSubmit.hidden = true;
    void Promise.allSettled([checkHealth(), loadFiles(), loadPipeline()]);
    if (!pendingTasks.length) dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    if (error.status === 401 && currentUser) {
      // Keep the account intent: another click must not silently create a guest job.
      loginButton.hidden = false;
      loginButton.textContent = 'Войти снова';
      error.message = 'Сессия истекла. Войдите в аккаунт снова, чтобы сохранить ролик в кабинете. Видео пока не отправлено.';
    }
    orderStatus.className = 'form-status error';
    orderStatus.textContent = error.message;
    orderSubmit.hidden = false;
    throw error;
  } finally {
    creatingProject = false;
    syncCreationState();
  }
}

orderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canStartCreation({ file: selectedFile, consent: projectConsent.checked, busy: creatingProject, maxFileSize })) return;
  const source = selectedFile;
  try {
    await createProject();
    pendingTasks.unshift(...addFiles([source], false));
    startPendingTasks();
    clearSelectedSource();
    workspace.hidden = true;
    projectContext.hidden = false;
    projectContextTitle.textContent = projectName(currentProject || { title: source.name });
    projectContextMeta.textContent = 'Передаём видео · затем начнётся монтаж';
    backToProjects.hidden = !currentUser;
    addFilesButton.hidden = false;
    const anotherProjectButton = document.querySelector('#anotherProjectButton');
    if (anotherProjectButton) anotherProjectButton.hidden = false;
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
  updateModeHint();
  syncCreationState();
  await checkHealth();
  await initializeAuth();
  if (!projectShell.hidden && apiAvailable && (!serverProtected || uploadToken)) await loadFiles();
  if (!projectShell.hidden && apiAvailable && (!serverProtected || uploadToken)) await loadPipeline();
  document.body.classList.remove('app-booting');
}

initialize();
setInterval(() => {
  if (document.hidden) return;
  if (currentUser && !accountDashboard.hidden) {
    loadAccountProjects({ preserveMessage: true, background: true });
  } else if (uploadToken) loadPipeline();
}, 5000);
setInterval(() => { if (!document.hidden) void refreshWorkerHealth(); }, 30000);
