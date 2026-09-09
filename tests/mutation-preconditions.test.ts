import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMutationPreconditions } from '../src/workspace/mutation-preconditions.ts';

const identity = { scopeId: 'work_a', actorId: 'actor_a', operationId: 'operation_a', requestHash: 'a'.repeat(64) };
const receipt = { id: 'receipt_a', revision: 3, contentHash: 'b'.repeat(64) };

test('an interrupted operation with unknown outcome cannot be blindly applied again', () => {
  assert.throws(() => checkMutationPreconditions(identity, 2, {
    scopeId: 'work_a', revision: 2, prior: { ...identity, outcome: 'unknown' },
  }), { code: 'RECONCILE_REQUIRED' });
});

test('an already committed operation returns its receipt instead of repeating a write', () => {
  assert.deepEqual(checkMutationPreconditions(identity, 2, {
    scopeId: 'work_a', revision: 9, prior: { ...identity, outcome: 'committed', receipt },
  }, AbortSignal.abort()), { kind: 'already_committed', receipt });
});

for (const field of ['scopeId', 'actorId', 'operationId', 'requestHash'] as const) {
  test(`a prior receipt cannot be reused with a conflicting ${field}`, () => {
    assert.throws(() => checkMutationPreconditions(identity, 2, {
      scopeId: 'work_a', revision: 3, prior: { ...identity, [field]: 'other', outcome: 'committed', receipt },
    }), { code: 'OPERATION_CONFLICT' });
  });
}

test('fresh state writes honor the current revision', () => {
  assert.throws(() => checkMutationPreconditions(identity, 2, { scopeId: 'work_a', revision: 3 }), { code: 'STALE_REVISION' });
});

test('even a receipt lookup must match the resolved process scope', () => {
  assert.throws(() => checkMutationPreconditions(identity, 2, {
    scopeId: 'work_b', revision: 3, prior: { ...identity, outcome: 'committed', receipt },
  }), { code: 'SCOPE_MISMATCH' });
});

test('native cancellation prevents a fresh process-state write', () => {
  assert.throws(() => checkMutationPreconditions(identity, 2, { scopeId: 'work_a', revision: 2 }, AbortSignal.abort()),
    { name: 'AbortError' });
});

test('a fresh matching request is eligible for the guarded write, without executing it', () => {
  assert.deepEqual(checkMutationPreconditions(identity, 2, { scopeId: 'work_a', revision: 2 }), { kind: 'proceed' });
});
