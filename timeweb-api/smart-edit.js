import { PipelineError } from './pipeline-runtime.js';

const fail = (status, message) => { throw new PipelineError(status, message); };
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function normalizeSmartProposal(value) {
  if (value == null) return null;
  if (![1, 2].includes(value.version) || value.state === undefined) fail(400, 'Некорректный план умного монтажа');
  if (value.state === 'UNAVAILABLE') return { version: value.version, state: value.state, message: text(value.message, 500) };
  if (!['PROPOSED', 'NO_CHANGES', 'APPLIED'].includes(value.state)
      || !/^[a-f0-9]{64}$/.test(value.id) || value.requiresConfirmation !== true
      || !Number.isFinite(value.beforeSeconds) || !Number.isFinite(value.afterSeconds)
      || value.afterSeconds <= 0 || value.afterSeconds > value.beforeSeconds
      || !Array.isArray(value.changes) || value.changes.length > (value.version === 2 ? 3 : 2)
      || (value.state !== 'NO_CHANGES' && !value.changes.length)
      || (value.state === 'NO_CHANGES' && value.changes.length)) fail(400, 'Некорректный план умного монтажа');
  const intents = new Set();
  const changes = value.changes.map((change) => {
    const allowed = ['SOURCE_START_SET_USER', 'REMOVE_ALL_PAUSES', ...(value.version === 2 ? ['REMOVE_SPEECH_RETAKES'] : [])];
    if (!allowed.includes(change?.intent) || intents.has(change.intent)) fail(400, 'Недопустимое действие умного монтажа');
    intents.add(change.intent);
    if (typeof change.value !== 'string' || change.value.length > 64) fail(400, 'Некорректный параметр умного монтажа');
    if (change.intent !== 'SOURCE_START_SET_USER' ? change.value !== '' : !/^\d+(?:\.\d+)?$/.test(change.value) || !Number.isFinite(Number(change.value))) fail(400, 'Некорректный параметр умного монтажа');
    const normalized = { intent: change.intent, value: change.value, title: text(change.title, 120), reason: text(change.reason, 300) };
    if (change.intent === 'REMOVE_SPEECH_RETAKES') normalized.cuts = normalizeSpeechCuts(change.cuts, value.beforeSeconds);
    return normalized;
  });
  return { version: value.version, id: value.id, state: value.state, message: text(value.message, 500),
    beforeSeconds: value.beforeSeconds, afterSeconds: value.afterSeconds, changes, requiresConfirmation: true };
}

function normalizeSpeechCuts(cuts, duration) {
  if (!Array.isArray(cuts) || cuts.length < 1 || cuts.length > 20) fail(400, 'Некорректные сокращения речи');
  const ids = new Set();
  let previousEnd = -1;
  let removed = 0;
  return cuts.map((cut) => {
    if (!cut || !/^repeat-\d+-\d+-\d+$/.test(cut.id) || ids.has(cut.id)
        || !Number.isFinite(cut.sourceStart) || !Number.isFinite(cut.sourceEnd)
        || cut.sourceStart < 0 || cut.sourceStart < previousEnd || cut.sourceEnd <= cut.sourceStart
        || cut.sourceEnd - cut.sourceStart > 8
        || typeof cut.removedText !== 'string' || !cut.removedText.trim() || cut.removedText.length > 500
        || typeof cut.keptText !== 'string' || !cut.keptText.trim() || cut.keptText.length > 300
        || typeof cut.reason !== 'string' || !cut.reason.trim() || cut.reason.length > 300) fail(400, 'Некорректные сокращения речи');
    previousEnd = cut.sourceEnd;
    ids.add(cut.id);
    removed += cut.sourceEnd - cut.sourceStart;
    if (removed > duration * 0.25 + 0.001) fail(400, 'Превышен безопасный объём сокращений речи');
    return { id: cut.id, sourceStart: cut.sourceStart, sourceEnd: cut.sourceEnd,
      removedText: cut.removedText, keptText: cut.keptText, reason: cut.reason };
  });
}

export function confirmedSmartEditAction(status, body) {
  if (!body.smartEditProposalId) return {};
  if (body.kind !== 'REVISION' || body.confirmation !== 'APPLY_SMART_EDIT') fail(400, 'Сначала подтвердите план умного монтажа');
  const proposal = normalizeSmartProposal(status.smartEditProposal);
  if (!proposal || proposal.id !== body.smartEditProposalId || proposal.state !== 'PROPOSED') fail(409, 'Этот план больше не актуален. Обновите проект');
  if (proposal.version === 2 && body.smartEditProposalVersion !== 2) fail(409, 'Обновите страницу, чтобы увидеть все сокращения речи перед подтверждением');
  // Actions come from the worker's bound artifact, never from client-supplied text/JSON.
  return { smartEditProposalId: proposal.id, confirmation: 'APPLY_SMART_EDIT' };
}

export function requireSmartBridge(version, required) {
  if (required && (!Number.isInteger(version) || version < 5)) fail(426, 'Умный монтаж требует обновления обработчика до версии 5');
}
