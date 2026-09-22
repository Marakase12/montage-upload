import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('согласие различает срок доступа и фактическое удаление файлов', () => {
  assert.match(html, /Срок доступа через сервис — <b id="retentionValue">/);
  assert.match(html, /Автоматическое удаление файлов пока отключено/);
  assert.doesNotMatch(html, /Они будут удалены через/);
});

test('личный кабинет содержит вход, регистрацию, проекты и безопасный выход', () => {
  for (const id of [
    'authDialog',
    'authForm',
    'accountDashboard',
    'projectsList',
    'newProjectButton',
    'logoutButton',
    'logoutStatus',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="authPassword"[^>]*minlength="10"/);
  assert.match(html, /id="authPasswordConfirm"[^>]*minlength="10"/);
});

test('frontend использует account API и сохраняет гостевой режим между доменами', () => {
  for (const endpoint of [
    '/api/auth/capabilities',
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/me',
    '/api/auth/logout',
    '/api/projects',
  ]) {
    assert.ok(app.includes(endpoint), `missing ${endpoint}`);
  }
  assert.match(app, /accountIsSameOrigin/);
  assert.match(app, /credentials:\s*accountIsSameOrigin\s*\?\s*'include'\s*:\s*'omit'/);
  assert.doesNotMatch(app, /window\.confirm/);
});

test('approval остаётся отдельным явным действием и не обещает публикацию', () => {
  assert.match(html, /id="approvalDialog"/);
  assert.match(html, /Публикация не запустится/);
  assert.match(app, /confirmation:\s*'APPROVE'/);
});

test('гостевой project token переносится в кабинет только через URL fragment', () => {
  assert.match(app, /montage-pending-claim-token/);
  assert.match(app, /target\.hash\s*=\s*new URLSearchParams\(\{ claim: tokenToClaim \}\)\.toString\(\)/);
  assert.match(app, /fragmentParameters\.get\('claim'\)/);
  assert.match(app, /if \(fragmentClaimToken\) url\.hash = ''/);
  assert.doesNotMatch(app, /searchParams\.set\(['"]claim/);
});

test('pending claim сохраняется до подтверждённого ответа сервера', () => {
  const claimStart = app.indexOf('async function claimPendingProject()');
  const claimEnd = app.indexOf('async function enterAccountDashboard()', claimStart);
  const claim = app.slice(claimStart, claimEnd);
  assert.match(claim, /api\('\/api\/projects\/claim'/);
  assert.match(claim, /body: JSON\.stringify\(\{ jobToken: token/);
  assert.match(claim, /sessionStorage\.removeItem\(pendingClaimStorageKey\)/);
  assert.match(claim, /Данные переноса сохранены/);
  assert.ok(
    claim.indexOf('sessionStorage.removeItem(pendingClaimStorageKey)') < claim.indexOf('} catch (error)'),
    'claim token must only be removed in the success branch',
  );
});

test('авторизованная загрузка требует account endpoint и не понижается до гостевой', () => {
  const createStart = app.indexOf('async function createProject()');
  const createEnd = app.indexOf('orderForm.addEventListener', createStart);
  const create = app.slice(createStart, createEnd);
  assert.match(create, /const accountProject = Boolean\(currentUser/);
  assert.match(create, /api\(accountProject \? '\/api\/projects' : '\/api\/jobs'/);
  assert.match(create, /projectAuth: !accountProject/);
  assert.match(create, /requestText: processingRequest\.value/);
  assert.match(create, /accountProject && !result\.project/);
  assert.doesNotMatch(create, /currentProject = result\.project \|\|/);
});

test('сетевой сбой logout не очищает локальную сессию', () => {
  const logoutStart = app.indexOf("logoutButton.addEventListener('click'");
  const logoutEnd = app.indexOf('const openNewProject', logoutStart);
  const logout = app.slice(logoutStart, logoutEnd);
  assert.match(logout, /let logoutConfirmed = false/);
  assert.match(logout, /logoutConfirmed = \[401, 403\]\.includes\(error\.status\)/);
  assert.match(logout, /Аккаунт остаётся активным/);
  assert.match(logout, /if \(logoutConfirmed\) \{/);
  assert.ok(
    logout.indexOf('if (logoutConfirmed) {') < logout.indexOf('currentUser = null'),
    'local auth may only be cleared after confirmed logout',
  );
});
