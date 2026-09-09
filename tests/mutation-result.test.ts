import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMutationResult } from '../src/workspace/mutation-result.ts';

const identity = { scopeId: 'work_a', actorId: 'actor_a', operationId: 'operation_a', requestHash: 'a'.repeat(64) };
const receipt = { id: 'receipt_a', revision: 3, contentHash: 'b'.repeat(64) };

test('an unknown outcome cannot carry a receipt that purports to acknowledge a commit', () => {
  assert.throws(() => validateMutationResult(identity, 2048, { operationId: 'operation_a', scopeId: 'work_a',
    outcome: 'unknown', reason: 'Commit acknowledgement was lost.', receipt,
  }), { code: 'INVALID_RESULT' });
});

test('a receipt from another operation cannot acknowledge the requested mutation', () => {
  assert.throws(() => validateMutationResult(identity, 2048, { operationId: 'operation_b', scopeId: 'work_a',
    outcome: 'committed', receipt, replayed: true, stateRevision: 2,
  }), { code: 'SCOPE_MISMATCH' });
});

test('mutation acknowledgements include their receipt metadata in the byte budget', () => {
  assert.throws(() => validateMutationResult(identity, 64, { operationId: 'operation_a', scopeId: 'work_a',
    outcome: 'committed', receipt, replayed: false, stateRevision: 2,
  }), { code: 'OUTPUT_LIMIT' });
});
