import assert from 'node:assert/strict';
import test from 'node:test';
import { reconstructBinding } from '../src/work/session-binding.ts';

const valid = () => reconstructBinding({
  branchId: 'branch_a', currentAttemptId: 'attempt_new', currentCheckoutId: 'checkout_a',
  pointer: { workId: 'work_a', taskId: 'task_a', branchId: 'branch_a', checkoutId: 'checkout_a',
    attemptId: 'attempt_new', taskGeneration: 2, writerGeneration: 4 },
  currentGrants: [
    { scopeId: 'task_a', attemptId: 'attempt_new', generation: 2, standing: 'valid' as const },
    { scopeId: 'checkout_a', attemptId: 'attempt_new', generation: 4, standing: 'valid' as const },
  ],
});

test('tree navigation restores a binding hint without resurrecting another attempt grant', () => {
  const binding = reconstructBinding({
    branchId: 'branch_a', currentAttemptId: 'attempt_new', currentCheckoutId: 'checkout_a',
    pointer: { workId: 'work_a', taskId: 'task_a', branchId: 'branch_a', checkoutId: 'checkout_a',
      attemptId: 'attempt_old', taskGeneration: 2, writerGeneration: 3 },
    currentGrants: [
      { scopeId: 'task_a', attemptId: 'attempt_old', generation: 2, standing: 'valid' },
      { scopeId: 'checkout_a', attemptId: 'attempt_old', generation: 3, standing: 'valid' },
    ],
  });
  assert.deepEqual(binding, { workId: 'work_a', taskId: 'task_a', checkoutId: 'checkout_a', grantStanding: 'none', reason: 'STALE_ATTEMPT' });
});

test('a pointer must match branch, checkout, task scope and both grant generations', () => {
  assert.equal(valid().grantStanding, 'valid');
  const wrongScope = reconstructBinding({
    branchId: 'branch_a', currentAttemptId: 'attempt_new', currentCheckoutId: 'checkout_a',
    pointer: { workId: 'work_a', taskId: 'task_a', branchId: 'branch_a', checkoutId: 'checkout_a',
      attemptId: 'attempt_new', taskGeneration: 2, writerGeneration: 4 },
    currentGrants: [
      { scopeId: 'task_b', attemptId: 'attempt_new', generation: 2, standing: 'valid' },
      { scopeId: 'checkout_a', attemptId: 'attempt_new', generation: 4, standing: 'valid' },
    ],
  });
  assert.equal(wrongScope.grantStanding, 'none');
  assert.equal(wrongScope.reason, 'STALE_GRANT');
});

test('an uncertain durable grant remains uncertain and never becomes valid from a pointer', () => {
  const binding = reconstructBinding({
    branchId: 'branch_a', currentAttemptId: 'attempt_new', currentCheckoutId: 'checkout_a',
    pointer: { workId: 'work_a', taskId: 'task_a', branchId: 'branch_a', checkoutId: 'checkout_a',
      attemptId: 'attempt_new', taskGeneration: 2, writerGeneration: 4 },
    currentGrants: [
      { scopeId: 'task_a', attemptId: 'attempt_new', generation: 2, standing: 'uncertain' },
      { scopeId: 'checkout_a', attemptId: 'attempt_new', generation: 4, standing: 'valid' },
    ],
  });
  assert.equal(binding.grantStanding, 'uncertain');
  assert.equal(binding.reason, 'UNCERTAIN_GRANT');
});

test('identity-less legacy pointers fail closed', () => {
  const binding = reconstructBinding({ branchId: 'branch_a', currentAttemptId: 'attempt_new', currentCheckoutId: 'checkout_a',
    pointer: { workId: 'work_a' }, currentGrants: [] });
  assert.equal(binding.grantStanding, 'none');
});

test('repeating a review with unchanged receipts preserves the prior valid result', () => {
  assert.deepEqual(valid(), valid());
});
