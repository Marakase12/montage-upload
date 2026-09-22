import assert from 'node:assert/strict';
import test from 'node:test';
import { freshProcessingOptions, canApplySmartEdit } from '../public/studio-state.js';
test('smart advice defaults on but applying edits requires a ready confirmed proposal', () => {
  assert.equal(freshProcessingOptions().smartEditEnabled, true);
  const task = { state: 'READY_FOR_REVIEW', resultAvailability: 'AVAILABLE', smartEditProposal: { state: 'PROPOSED' } };
  assert.equal(canApplySmartEdit(task), true);
  for (const patch of [{ state: 'PROCESSING' }, { resultAvailability: 'UNKNOWN' }, { smartEditProposal: { state: 'APPLIED' } },
    { action: { state: 'PENDING' } }, { action: { state: 'PROCESSING' } }]) {
    assert.equal(canApplySmartEdit({ ...task, ...patch }), false);
  }
});
