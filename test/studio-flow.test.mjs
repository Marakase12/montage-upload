import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { freshProcessingOptions, sourceProblem, canStartCreation, projectMatches, previewIdentity } from '../public/studio-state.js';

test('creation requires a nonempty supported video, consent and no in-flight creation', () => {
  const file = { name: 'phone.MOV', type: '', size: 1024 };
  const valid = { file, consent: true, busy: false, maxFileSize: 2048 };
  assert.equal(canStartCreation(valid), true);
  for (const patch of [{ file: null }, { consent: false }, { busy: true }, { maxFileSize: 512 }, { file: { ...file, size: 0 } }, { file: { ...file, name: 'notes.txt' } }]) {
    assert.equal(canStartCreation({ ...valid, ...patch }), false);
  }
  assert.equal(sourceProblem({ name: 'long.mkv', size: 1024 }, 2048), '');
  assert.notEqual(sourceProblem({ name: 'clip.avi', type: 'video/avi', size: 1024 }, 2048), '');
});

test('new project starts from fresh options', () => {
  const first = freshProcessingOptions();
  first.mode = 'long';
  first.aspectRatio = '1:1';
  first.hookEnabled = false;
  first.requestText = 'Предыдущая просьба';
  const second = freshProcessingOptions();
  assert.equal(second.mode, 'short');
  assert.equal(second.aspectRatio, '9:16');
  assert.equal(second.hookEnabled, true);
  assert.equal(second.requestText, '');
});

test('dashboard filters actual states and preview identity ignores expiring signed URLs', () => {
  assert.equal(projectMatches({ title: 'Москва.MOV', state: 'PROCESSING' }, 'моск', 'working'), true);
  assert.equal(projectMatches({ title: 'Москва', state: 'UNKNOWN' }, '', 'ready'), false);
  const task = { taskId: 'one', version: 1, updatedAt: '2026-09-22', resultKey: 'result.mp4' };
  assert.equal(previewIdentity({ ...task, previewUrl: 'first-signature' }), previewIdentity({ ...task, previewUrl: 'second-signature' }));
  assert.notEqual(previewIdentity(task), previewIdentity({ ...task, updatedAt: '2026-09-23' }));
});

class Element {
  constructor() {
    this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this.dataset = {}; this.style = {}; this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  async fire(name, event = {}) { return this.listeners.get(name)?.({ preventDefault() {}, ...event }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  querySelector() { return new Element(); }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  set src(value) { this.attributes.set('src', value); }
  get src() { return this.attributes.get('src'); }
  pause() {}
  load() {}
}

function harness() {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  for (const [id, ratio] of [['#aspect916', '9:16'], ['#aspect11', '1:1'], ['#aspect169', '16:9']]) element(id).value = ratio;
  element('#aspect916').checked = true;
  const context = vm.createContext({
    freshProcessingOptions, sourceProblem, canStartCreation, projectMatches, previewIdentity,
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {} },
    window: { location: { origin: 'http://localhost', href: 'http://localhost/', hostname: 'localhost' } },
    URL, URLSearchParams, sessionStorage: storage, localStorage: storage, history: { replaceState() {} },
    performance, setTimeout, clearTimeout, File, console,
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const bootstrapIndex = source.lastIndexOf('\ninitialize();');
  assert.ok(bootstrapIndex > 0);
  vm.runInContext(source.slice(0, bootstrapIndex).replace(/^import[^\n]+\n/, ''), context);
  vm.runInContext(`globalThis.testState = {
    select: handleSelectedFiles, reset: resetProcessingOptions, review: openReview, poll: loadPipeline,
    projects: loadAccountProjects,
    create: createProject, files: loadFiles, retry: retryPipelineTask, worker: updateWorkerState,
    addActiveUpload() { tasks.add({ state: 'uploading' }); },
    setUser(user) { currentUser = user; authEnabled = true; },
    setApi(stub, token = 'test-project') { api = stub; uploadToken = token; },
    get file() { return selectedFile; },
    calls: [],
    installSubmitStubs(fail = false) {
      createProject = async () => { testState.calls.push('create'); if (fail) throw new Error('offline'); };
      addFiles = (files) => { testState.calls.push('queue:' + files[0].name); return []; };
      startPendingTasks = () => { testState.calls.push('upload'); };
    }
  };`, context);
  return { element, state: context.testState };
}

test('actual selection and consent handlers never create or upload; explicit submit does', async () => {
  const { element, state } = harness();
  state.installSubmitStubs();
  const file = new File(['video'], 'phone.mp4', { type: 'video/mp4' });
  state.select([file]);
  assert.equal(state.file, file);
  assert.deepEqual([...state.calls], []);
  assert.equal(element('#orderSubmit').disabled, true);
  await element('#orderForm').fire('submit');
  assert.deepEqual([...state.calls], []);
  element('#projectConsent').checked = true;
  await element('#projectConsent').fire('change');
  assert.deepEqual([...state.calls], []);
  assert.equal(element('#orderSubmit').disabled, false);
  await element('#orderForm').fire('submit');
  assert.deepEqual([...state.calls], ['create', 'queue:phone.mp4', 'upload']);
  assert.equal(state.file, null);
});

test('failed project creation retains selected source and does not start transfer', async () => {
  const { element, state } = harness();
  state.installSubmitStubs(true);
  const file = new File(['video'], 'phone.mp4', { type: 'video/mp4' });
  state.select([file]);
  element('#projectConsent').checked = true;
  await element('#orderForm').fire('submit');
  assert.equal(state.file, file);
  assert.deepEqual([...state.calls], ['create']);
});

test('actual new-project reset clears earlier requests and resets mode and switches', () => {
  const { element, state } = harness();
  element('#processingRequest').value = 'Удалить хук';
  element('#processingMode').value = 'long';
  element('#hookEnabled').checked = false;
  element('#aspect916').checked = false;
  element('#aspect11').checked = true;
  state.reset();
  assert.equal(element('#processingRequest').value, '');
  assert.equal(element('#processingMode').value, 'short');
  assert.equal(element('#hookEnabled').checked, true);
  assert.equal(element('#projectConsent').checked, false);
  assert.equal(element('#aspect916').checked, true);
  assert.equal(element('#aspect11').checked, false);
  assert.match(element('#processingSummary').textContent, /субтитры с подсветкой/);
});

test('visible option summary reflects changed switches without creating a project', async () => {
  const { element, state } = harness();
  state.installSubmitStubs();
  state.reset();
  for (const selector of ['#subtitlesEnabled', '#hookEnabled', '#faceTrackingEnabled']) {
    element(selector).checked = false;
    await element(selector).fire('change');
  }
  assert.match(element('#processingSummary').textContent, /Без субтитров/);
  assert.deepEqual([...state.calls], []);
});

test('all three format choices reach project creation without starting on change', async () => {
  for (const [id, ratio, size] of [['#aspect916', '9:16', '1080 × 1920'], ['#aspect11', '1:1', '1080 × 1080'], ['#aspect169', '16:9', '1920 × 1080']]) {
    const { element, state } = harness();
    let request;
    state.setApi(async (path, options) => {
      request = { path, body: JSON.parse(options.body) };
      throw new Error('stop after captured request');
    }, '');
    for (const input of ['#aspect916', '#aspect11', '#aspect169']) element(input).checked = input === id;
    await element(id).fire('change');
    assert.equal(request, undefined);
    assert.match(element('#formatHint').textContent, new RegExp(size));
    assert.ok(element('#processingSummary').textContent.includes(ratio));
    await assert.rejects(state.create(), /stop after captured request/);
    assert.equal(request.body.processing.aspectRatio, ratio);
  }
});

test('polling preserves playback and draft, refresh is explicit, and offline status stays visible', async () => {
  const { element, state } = harness();
  const task = { taskId: 'clip', state: 'READY_FOR_REVIEW', percent: 100, version: 1, updatedAt: '2026-09-22', previewUrl: 'first.mp4', downloadUrl: 'first-download.mp4' };
  state.review(task);
  element('#revisionText').value = 'Субтитры ниже';
  state.setApi(async () => ({ tasks: [{ ...task, previewUrl: 'rotated-url.mp4' }] }));
  await state.poll();
  assert.equal(element('#previewVideo').src, 'first.mp4');
  assert.equal(element('#revisionText').value, 'Субтитры ниже');
  assert.equal(element('#previewRefresh').hidden, true);
  state.setApi(async () => ({ tasks: [{ ...task, updatedAt: '2026-09-23', previewUrl: 'new-version.mp4' }] }));
  await state.poll();
  assert.equal(element('#previewVideo').src, 'first.mp4');
  assert.equal(element('#previewRefresh').hidden, false);
  assert.equal(element('#previewApprove').disabled, true);
  await element('#previewRefresh').fire('click');
  assert.equal(element('#previewVideo').src, 'new-version.mp4');
  assert.equal(element('#previewApprove').disabled, false);
  const lastCard = element('#pipelineList').children[0];
  state.setApi(async () => { throw new Error('offline'); });
  await state.poll();
  assert.equal(element('#pipelineList').children[0], lastCard);
  assert.equal(element('#pipelineNotice').hidden, false);
  assert.equal(element('#revisionText').value, 'Субтитры ниже');
});

test('dashboard refresh preserves unchanged cards and ignores a response after session changes', async () => {
  const { element, state } = harness();
  state.setUser({ id: 'owner' });
  const projects = [{ jobId: 'example-job', title: 'Ролик', state: 'PROCESSING', percent: 40 }];
  state.setApi(async () => ({ projects }));
  await state.projects({ background: true });
  const card = element('#projectsList').children[0];
  await state.projects({ background: true });
  assert.equal(element('#projectsList').children[0], card);
  state.setApi(async () => { throw new Error('temporary offline'); });
  await state.projects({ background: true });
  assert.equal(element('#projectsList').children[0], card);
  assert.equal(element('#accountMessage').dataset.refreshError, 'true');
  state.setApi(async () => ({ projects }));
  await state.projects({ background: true });
  assert.equal(element('#accountMessage').hidden, true);
  let respond;
  state.setApi(() => new Promise((resolve) => { respond = resolve; }));
  const pending = state.projects({ background: true });
  state.setUser(null);
  respond({ projects: [{ ...projects[0], title: 'Must not appear' }] });
  await pending;
  assert.equal(element('#projectsList').children[0], card);
});

test('expired account session never creates a guest project on repeated attempts', async () => {
  const { element, state } = harness();
  state.setUser({ id: 'owner' });
  const paths = [];
  state.setApi(async (path) => {
    paths.push(path);
    const error = new Error('Session expired');
    error.status = 401;
    throw error;
  }, '');
  const file = new File(['video'], 'phone.mp4', { type: 'video/mp4' });
  state.select([file]);
  await assert.rejects(state.create(), /Сессия истекла/);
  await assert.rejects(state.create(), /Сессия истекла/);
  assert.deepEqual(paths, ['/api/projects', '/api/projects']);
  assert.equal(state.file, file);
  assert.equal(element('#loginButton').hidden, false);
});

test('logout cannot silently abandon an in-flight upload', async () => {
  const { element, state } = harness();
  let requests = 0;
  state.setApi(async () => { requests += 1; });
  state.addActiveUpload();
  await element('#logoutButton').fire('click');
  assert.equal(requests, 0);
  assert.equal(element('#logoutStatus').hidden, false);
  assert.match(element('#logoutStatus').textContent, /Файл ещё загружается/);
});

test('late file-list response cannot replace files of a different project', async () => {
  const { element, state } = harness();
  let respond;
  state.setApi(() => new Promise((resolve) => { respond = resolve; }), 'old-project');
  const pending = state.files();
  const latest = new Element();
  element('#filesList').append(latest);
  state.setApi(async () => ({ files: [] }), 'new-project');
  respond({ files: [{ name: 'old-file', size: 99 }] });
  await pending;
  assert.equal(element('#filesList').children[0], latest);
});

test('worker availability is distinct from reachable upload API', () => {
  const { element, state } = harness();
  state.worker({ state: 'OFFLINE' });
  assert.equal(element('#workerNotice').hidden, false);
  assert.match(element('#workerNotice').textContent, /в пределах срока хранения/);
  state.worker({ state: 'ONLINE', phase: 'busy' });
  assert.equal(element('#workerNotice').hidden, true);
  state.worker(undefined);
  assert.match(element('#workerNotice').textContent, /не подтверждена/);
});

test('retry is explicit, scoped to failed recoverable task and guarded from double click', async () => {
  const { state } = harness();
  let finish;
  const writes = [];
  state.setApi(async (path, options) => {
    if (!options?.method) return { tasks: [] };
    writes.push(path);
    return new Promise((resolve) => { finish = resolve; });
  });
  const task = { taskId: 'failed-task', state: 'FAILED', retryable: true };
  assert.equal(await state.retry({ ...task, retryable: false }), false);
  assert.equal(await state.retry({ ...task, state: 'READY_FOR_REVIEW' }), false);
  const pending = state.retry(task);
  assert.equal(await state.retry(task), false);
  assert.deepEqual(writes, ['/api/pipeline/failed-task/retry']);
  finish({ ok: true, status: { state: 'QUEUED' } });
  assert.equal(await pending, true);
});

test('retry does not report success for ambiguous response or stale project', async () => {
  const { state } = harness();
  const task = { taskId: 'failed-task', state: 'FAILED', retryable: true };
  state.setApi(async () => ({}));
  assert.equal(await state.retry(task), false);
  let finish;
  state.setApi(() => new Promise((resolve) => { finish = resolve; }), 'old-project');
  const pending = state.retry(task);
  state.setApi(async () => ({ tasks: [] }), 'new-project');
  finish({ ok: true, status: { state: 'QUEUED' } });
  assert.equal(await pending, false);
});
