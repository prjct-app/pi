import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTaskTransition, type TransitionState, type AttemptBinding } from '../src/work/transition-preconditions.ts';

const state: TransitionState = { workId: 'work_a', taskId: 'task_a', disposition: 'in_progress', access: 'write',
  definitionRevision: 2, planRevision: 3, checkoutId: 'checkout_a',
  taskGrant: { scopeId: 'task_a', attemptId: 'attempt_b', generation: 2, standing: 'valid' },
  writerGrant: { scopeId: 'checkout_a', attemptId: 'attempt_b', generation: 4, standing: 'valid' } };
const binding: AttemptBinding = { workId: 'work_a', taskId: 'task_a', checkoutId: 'checkout_a', attemptId: 'attempt_b', taskGeneration: 2, writerGeneration: 4 };

test('a superseded attempt cannot advance process state using its old grant', () => {
  assert.throws(() => assertTaskTransition('complete', state, { ...binding, attemptId: 'attempt_a', taskGeneration: 1 }),
    { code: 'STALE_GRANT' });
});

test('an uncertain writer requires reconciliation rather than assuming the predecessor stopped', () => {
  assert.throws(() => assertTaskTransition('yield', { ...state,
    writerGrant: { scopeId: 'checkout_a', attemptId: 'attempt_b', generation: 4, standing: 'uncertain' },
  }, binding), { code: 'RECONCILE_REQUIRED' });
});

test('a valid task grant does not substitute for the required checkout writer grant', () => {
  assert.throws(() => assertTaskTransition('pause', state, { ...binding, writerGeneration: 3 }), { code: 'STALE_GRANT' });
});

test('the same numeric generation cannot be reused for a different selected task', () => {
  assert.throws(() => assertTaskTransition('pause', state, { ...binding, taskId: 'task_other' }), { code: 'SCOPE_MISMATCH' });
});

test('ownership alone cannot complete a task with no applicable assessment', () => {
  assert.throws(() => assertTaskTransition('complete', state, binding), { code: 'INCOMPLETE_ASSESSMENT' });
});

test('a cancelled task must be reopened, not directly declared completed', () => {
  assert.throws(() => assertTaskTransition('complete', { ...state, disposition: 'cancelled' }, binding), { code: 'INVALID_TRANSITION' });
});

test('reopening is only meaningful for terminal tasks', () => {
  assert.throws(() => assertTaskTransition('reopen', state, binding), { code: 'INVALID_TRANSITION' });
});

test('reopening a terminal task does not require resurrecting a released grant', () => {
  assert.doesNotThrow(() => assertTaskTransition('reopen', { workId: 'work_a', taskId: 'task_a',
    definitionRevision: 2, planRevision: 3, disposition: 'completed', access: 'read',
  }, { workId: 'work_a', taskId: 'task_a' }));
});


test('a writer grant from another checkout cannot authorize a source-writing task transition', () => {
  assert.throws(() => assertTaskTransition('pause', { ...state,
    writerGrant: { scopeId: 'checkout_b', attemptId: 'attempt_b', generation: 4, standing: 'valid' },
  }, binding), { code: 'SCOPE_MISMATCH' });
});

for (const transition of ['pause', 'yield', 'cancel'] as const) {
  test(`${transition} cannot silently modify a terminal task`, () => {
    assert.throws(() => assertTaskTransition(transition, { ...state, disposition: 'completed' }, binding), { code: 'INVALID_TRANSITION' });
  });
}

test('cancelling an unstarted unclaimed task does not invent an execution attempt', () => {
  assert.doesNotThrow(() => assertTaskTransition('cancel', { workId: 'work_a', taskId: 'task_a',
    definitionRevision: 2, planRevision: 3, disposition: 'not_started', access: 'read',
  }, { workId: 'work_a', taskId: 'task_a' }));
});

const scope = { workId: 'work_a', taskId: 'task_a', definitionRevision: 2, planRevision: 3 };
const supported = {
  scope, criteria: ['green'], assessment: { scope,
    judgments: [{ criterionId: 'green', conclusion: 'satisfied' as const, evidenceIds: ['observation_a'] }],
  }, evidence: [{ id: 'observation_a', provenance: 'native_observation' as const,
    supports: [{ id: 'source_a', revision: 1, contentHash: 'a'.repeat(64) }],
  }], currentSupports: [{ id: 'source_a', revision: 1, contentHash: 'a'.repeat(64) }],
};

test('a valid assessment for an identically named task in another work cannot complete this task', () => {
  const otherScope = { ...scope, workId: 'work_b' };
  assert.throws(() => assertTaskTransition('complete', state, binding, { ...supported,
    scope: otherScope, assessment: { ...supported.assessment, scope: otherScope },
  }), { code: 'INCOMPLETE_ASSESSMENT' });
});

test('current paired ownership and an applicable assessment permit the completion transition', () => {
  assert.doesNotThrow(() => assertTaskTransition('complete', state, binding, supported));
});

test('read-only task progress does not require acquiring a checkout writer grant', () => {
  assert.doesNotThrow(() => assertTaskTransition('pause', { ...state, access: 'read' },
    { workId: 'work_a', taskId: 'task_a', attemptId: 'attempt_b', taskGeneration: 2 }));
});
