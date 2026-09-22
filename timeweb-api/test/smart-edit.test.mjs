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
  requireSmartBridge(4, true);
  requireSmartBridge(3, false);
});
