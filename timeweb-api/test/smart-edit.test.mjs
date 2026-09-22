import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSmartProposal, confirmedSmartEditAction, requireSmartBridge } from '../smart-edit.js';
const proposal = { version: 1, id: 'a'.repeat(64), state: 'PROPOSED', requiresConfirmation: true,
  message: 'План', beforeSeconds: 30, afterSeconds: 25,
  changes: [{ intent: 'SOURCE_START_SET_USER', value: '5', title: 'Начать с 5 сек.', reason: 'Быстрее к сути' }] };

test('smart editing requires exact proposal and explicit confirmation, never accepts supplied actions', () => {
  const status = { smartEditProposal: proposal };
  const body = { kind: 'REVISION', smartEditProposalId: proposal.id, confirmation: 'APPLY_SMART_EDIT', actions: [{ intent: 'PUBLISH' }] };
  assert.deepEqual(confirmedSmartEditAction(status, body), { smartEditProposalId: proposal.id, confirmation: 'APPLY_SMART_EDIT' });
  for (const patch of [{ kind: 'APPROVE' }, { confirmation: undefined }, { smartEditProposalId: 'b'.repeat(64) }]) {
    assert.throws(() => confirmedSmartEditAction(status, { ...body, ...patch }));
  }
  assert.throws(() => confirmedSmartEditAction({ smartEditProposal: { ...proposal, state: 'APPLIED' } }, body));
  assert.throws(() => confirmedSmartEditAction({}, body));
});

test('smart plan schema is bounded and strips private worker metadata', () => {
  assert.deepEqual(normalizeSmartProposal({ ...proposal, secret: 'not public' }), proposal);
  for (const patch of [{ afterSeconds: Infinity }, { afterSeconds: 31 }, { beforeSeconds: '30' },
    { requiresConfirmation: false }, { changes: [{ intent: 'PUBLISH', value: '' }] }, { changes: [proposal.changes[0], proposal.changes[0]] },
    { changes: [{ ...proposal.changes[0], value: 'NaN' }] }, { state: 'NO_CHANGES' }, { changes: [] }]) {
    assert.throws(() => normalizeSmartProposal({ ...proposal, ...patch }));
  }
  assert.equal(normalizeSmartProposal(null), null);
  assert.equal(normalizeSmartProposal({ version: 1, state: 'UNAVAILABLE', message: 'Нет плана' }).state, 'UNAVAILABLE');
});

test('legacy worker cannot claim smart editing but ordinary jobs remain compatible', () => {
  assert.throws(() => requireSmartBridge(3, true), { status: 426 });
  assert.throws(() => requireSmartBridge(4, true), { status: 426 });
  requireSmartBridge(5, true);
  requireSmartBridge(3, false);
});

const speechCut = { id: 'repeat-1-3-4', sourceStart: 4.46, sourceEnd: 5.46,
  removedText: 'я я', keptText: 'я', reason: 'Повторная попытка начать фразу' };
const speechPlan = { ...proposal, version: 2, changes: [{ intent: 'REMOVE_SPEECH_RETAKES', value: '',
  title: 'Убрать повторы', reason: 'Сохранить последнюю фразу', cuts: [speechCut] }] };

test('v2 exposes grounded cut descriptions but confirmation still sends only proposal identity', () => {
  assert.deepEqual(normalizeSmartProposal(speechPlan), speechPlan);
  const action = confirmedSmartEditAction({ smartEditProposal: speechPlan }, { kind: 'REVISION',
    smartEditProposalId: speechPlan.id, confirmation: 'APPLY_SMART_EDIT', smartEditProposalVersion: 2, cuts: [{ sourceStart: 0, sourceEnd: 29 }] });
  assert.deepEqual(action, { smartEditProposalId: speechPlan.id, confirmation: 'APPLY_SMART_EDIT' });
  assert.throws(() => normalizeSmartProposal({ ...speechPlan, version: 1 }));
  assert.throws(() => confirmedSmartEditAction({ smartEditProposal: speechPlan }, { kind: 'REVISION',
    smartEditProposalId: speechPlan.id, confirmation: 'APPLY_SMART_EDIT' }), { status: 409 });
});

test('v2 rejects unsafe, overlapping, oversized or nonfinite speech cuts', () => {
  for (const cuts of [[], [speechCut, speechCut], Array(21).fill(speechCut),
    [{ ...speechCut, sourceStart: NaN }], [{ ...speechCut, sourceEnd: Infinity }],
    [{ ...speechCut, sourceEnd: speechCut.sourceStart }], [{ ...speechCut, sourceStart: -1 }],
    [{ ...speechCut, sourceStart: false }], [{ ...speechCut, sourceEnd: 20 }],
    [{ ...speechCut, removedText: '' }], [{ ...speechCut, keptText: 'x'.repeat(301) }]]) {
    assert.throws(() => normalizeSmartProposal({ ...speechPlan, changes: [{ ...speechPlan.changes[0], cuts }] }));
  }
  assert.throws(() => normalizeSmartProposal({ ...speechPlan, beforeSeconds: 3, afterSeconds: 2 }));
});
