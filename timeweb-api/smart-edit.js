import { PipelineError } from './pipeline-runtime.js';

const fail = (status, message) => { throw new PipelineError(status, message); };
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function normalizeSmartProposal(value) {
  if (value == null) return null;
  if (value.version !== 1 || value.state === undefined) fail(400, 'Некорректный план умного монтажа');
  if (value.state === 'UNAVAILABLE') return { version: 1, state: value.state, message: text(value.message, 500) };
  if (!['PROPOSED', 'NO_CHANGES', 'APPLIED'].includes(value.state)
      || !/^[a-f0-9]{64}$/.test(value.id) || value.requiresConfirmation !== true
      || !Number.isFinite(value.beforeSeconds) || !Number.isFinite(value.afterSeconds)
      || value.afterSeconds <= 0 || value.afterSeconds > value.beforeSeconds
      || !Array.isArray(value.changes) || value.changes.length > 2
      || (value.state !== 'NO_CHANGES' && !value.changes.length)
      || (value.state === 'NO_CHANGES' && value.changes.length)) fail(400, 'Некорректный план умного монтажа');
  const intents = new Set();
  const changes = value.changes.map((change) => {
    if (!['SOURCE_START_SET_USER', 'REMOVE_ALL_PAUSES'].includes(change?.intent) || intents.has(change.intent)) fail(400, 'Недопустимое действие умного монтажа');
    intents.add(change.intent);
    if (typeof change.value !== 'string' || change.value.length > 64) fail(400, 'Некорректный параметр умного монтажа');
    if (change.intent === 'REMOVE_ALL_PAUSES' ? change.value !== '' : !/^\d+(?:\.\d+)?$/.test(change.value) || !Number.isFinite(Number(change.value))) fail(400, 'Некорректный параметр умного монтажа');
    return { intent: change.intent, value: change.value, title: text(change.title, 120), reason: text(change.reason, 300) };
  });
  return { version: 1, id: value.id, state: value.state, message: text(value.message, 500),
    beforeSeconds: value.beforeSeconds, afterSeconds: value.afterSeconds, changes, requiresConfirmation: true };
}

export function confirmedSmartEditAction(status, body) {
  if (!body.smartEditProposalId) return {};
  if (body.kind !== 'REVISION' || body.confirmation !== 'APPLY_SMART_EDIT') fail(400, 'Сначала подтвердите план умного монтажа');
  const proposal = normalizeSmartProposal(status.smartEditProposal);
  if (!proposal || proposal.id !== body.smartEditProposalId || proposal.state !== 'PROPOSED') fail(409, 'Этот план больше не актуален. Обновите проект');
  // Actions come from the worker's bound artifact, never from client-supplied text/JSON.
  return { smartEditProposalId: proposal.id, confirmation: 'APPLY_SMART_EDIT' };
}

export function requireSmartBridge(version, required) {
  if (required && (!Number.isInteger(version) || version < 4)) fail(426, 'Умный монтаж требует обновления обработчика до версии 4');
}
