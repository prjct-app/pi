import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructBinding } from '../src/work/session-binding.ts';

test('tree navigation restores a binding hint without resurrecting a writer grant', () => {
  const binding = reconstructBinding({
    branchId: 'branch_a',
    pointer: { workId: 'work_a', taskId: 'task_a', attemptId: 'attempt_old', writerGeneration: 3 },
    currentGrants: [{ scopeId: 'checkout_a', attemptId: 'attempt_new', generation: 4, standing: 'valid' }],
  });
  assert.deepEqual(binding, { workId: 'work_a', taskId: 'task_a', grantStanding: 'none', reason: 'STALE_GRANT' });
});

test('repeating a review with unchanged receipts does not discard the prior valid pass', () => {
  const first = reconstructBinding({
    branchId: 'branch_a',
    pointer: { workId: 'work_a', taskId: 'task_a', attemptId: 'attempt_new', writerGeneration: 4 },
    currentGrants: [{ scopeId: 'checkout_a', attemptId: 'attempt_new', generation: 4, standing: 'valid' }],
  });
  const second = reconstructBinding({
    branchId: 'branch_a',
    pointer: { workId: 'work_a', taskId: 'task_a', attemptId: 'attempt_new', writerGeneration: 4 },
    currentGrants: [{ scopeId: 'checkout_a', attemptId: 'attempt_new', generation: 4, standing: 'valid' }],
  });
  assert.deepEqual(second, first);
  assert.equal(second.grantStanding, 'valid');
});
