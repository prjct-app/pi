import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReuseAssessment, type ReuseCheckpoint } from '../src/work/checkpoint-contract.ts';

// Synthetic contract fixture inspired by the user's report, not an inspection of
// their site. These IDs must still resolve to attributable evidence at runtime.
const refreshAssessment = {
  action: 'record', taskId: 'task_a', operationId: 'operation_a', expectedRevision: 4,
  kind: 'reuse_assessment', data: {
    behavior: 'Refresh cockpit data', approach: 'extend',
    reviewedScope: 'Shared header control, refresh controller, polling subscriptions and cockpit data dependencies',
    existing: [{ owner: 'Global refresh controller', capability: 'Single refresh control with shared data invalidation',
      evidenceIds: ['evidence_header', 'evidence_controller'] }],
    examinedEvidenceIds: ['evidence_header', 'evidence_controller', 'evidence_polling'],
    rationale: 'Integrate the cockpit data subscription with the existing refresh owner instead of adding another control.',
    unresolvedQuestions: ['Confirm whether all cockpit cache entries participate in invalidation.'],
  },
} satisfies ReuseCheckpoint;

test('an extension assessment may preserve an unresolved integration question', () => {
  assert.doesNotThrow(() => assertReuseAssessment(refreshAssessment));
});

test('reuse or extension cannot be declared without identifying any existing owner', () => {
  assert.throws(() => assertReuseAssessment({ ...refreshAssessment,
    data: { ...refreshAssessment.data, existing: [] },
  }), { code: 'INVALID_REUSE_ASSESSMENT' });
});

test('choosing new behavior requires inspection evidence rather than assuming no reusable flow exists', () => {
  assert.throws(() => assertReuseAssessment({ ...refreshAssessment,
    data: { ...refreshAssessment.data, approach: 'new', existing: [], examinedEvidenceIds: [],
      rationale: 'No reusable control found.', unresolvedQuestions: [] },
  }), { code: 'INVALID_REUSE_ASSESSMENT' });
});

test('partial method progress can retain green-pending work without pretending the task is complete', async () => {
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const { CheckpointParameters } = await import('../src/work/checkpoint-contract.ts');
  const input = { action: 'record', kind: 'progress', workId: 'work_a', taskId: 'task_a', operationId: 'operation_a',
    expectedRevision: 2, maxBytes: 2048, methodId: 'tdd', stage: 'green_pending',
    summary: 'Implementation changed after the observed red run.', evidenceIds: ['red_observation'],
    nextAction: 'Run the relevant checks with native Pi tools before assessing completion.' };
  assert.deepEqual(validateToolArguments({ name: 'prjct_checkpoint', description: 'Preserve method progress.', parameters: CheckpointParameters },
    { type: 'toolCall', id: 'checkpoint_call', name: 'prjct_checkpoint', arguments: input }), input);
});

test('an assessment request can state that green is unknown without declaring native provenance', async () => {
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const { CheckpointParameters } = await import('../src/work/checkpoint-contract.ts');
  const input = { action: 'record', kind: 'assessment', workId: 'work_a', taskId: 'task_a', operationId: 'operation_a',
    expectedRevision: 2, maxBytes: 2048, planRevision: 3, definitionRevision: 2,
    judgments: [{ criterionId: 'green', conclusion: 'unknown', evidenceIds: [], rationale: 'No current green observation is available.' }] };
  assert.deepEqual(validateToolArguments({ name: 'prjct_checkpoint', description: 'Preserve attributed assessment.', parameters: CheckpointParameters },
    { type: 'toolCall', id: 'assessment_call', name: 'prjct_checkpoint', arguments: input }), input);
});

test('a decision checkpoint retains the question and an observation reference, not a forged answer', async () => {
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const { CheckpointParameters } = await import('../src/work/checkpoint-contract.ts');
  const input = { action: 'record', kind: 'decision_reference', workId: 'work_a', taskId: 'task_a',
    operationId: 'operation_a', expectedRevision: 2, maxBytes: 2048,
    questionId: 'reuse_scope', observationId: 'interaction_a', subject: 'Use the existing global refresh control.' };
  assert.deepEqual(validateToolArguments({ name: 'prjct_checkpoint', description: 'Retain a scoped decision reference.', parameters: CheckpointParameters },
    { type: 'toolCall', id: 'decision_call', name: 'prjct_checkpoint', arguments: input }), input);
});

test('a work-level assessment is not forced into an invented task identity', async () => {
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const { CheckpointParameters } = await import('../src/work/checkpoint-contract.ts');
  const input = { action: 'record', kind: 'work_assessment', workId: 'work_a', operationId: 'operation_a',
    expectedRevision: 2, maxBytes: 2048, specificationRevision: 2, planRevision: 3,
    taskAssessments: [{ id: 'assessment_a', revision: 1, contentHash: 'a'.repeat(64) }],
    judgments: [{ criterionId: 'reuse_refresh', conclusion: 'unknown', evidenceIds: [], rationale: 'Review is pending.' }] };
  assert.deepEqual(validateToolArguments({ name: 'prjct_checkpoint', description: 'Retain work assessment.', parameters: CheckpointParameters },
    { type: 'toolCall', id: 'work_assessment_call', name: 'prjct_checkpoint', arguments: input }), input);
});
