import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { processToolDeclarations } from '../src/pi/tool-declarations.ts';

const reference = { id: 'artifact_a', revision: 2, contentHash: 'a'.repeat(64) };
const mutation = { operationId: 'operation_a', expectedRevision: 2, maxBytes: 2048 };
// Literal contract examples, not fixtures generated from the schemas under test.
// This exercises declarations, not persistence, retrieval quality or live consent.
const cases: Array<[string, Record<string, unknown>]> = [
  ['prjct_context', { action: 'lookup', query: 'Existing refresh owner', maxBytes: 2048 }],
  ['prjct_context', { action: 'discover', query: 'Retain interrupted TDD progress', maxBytes: 2048 }],
  ['prjct_search', { checkoutId: 'checkout_a', query: 'Existing refresh owner', maxItems: 8, maxBytes: 2048 }],
  ['prjct_structure', { action: 'impact', checkoutId: 'checkout_a', seeds: ['symbol_refresh'], relations: ['calls'], maxDepth: 2, maxItems: 8, maxBytes: 2048 }],
  ['prjct_refresh', { action: 'inspect', checkoutId: 'checkout_a', maxBytes: 2048 }],
  ['prjct_refresh', { action: 'apply', checkoutId: 'checkout_a', expectedConfigRevision: 1, ...mutation }],
  ['prjct_work', { action: 'create', projectId: 'project_a', operationId: 'operation_a', title: 'Reuse existing refresh', origin: reference, maxBytes: 2048 }],
  ['prjct_work', { action: 'list', projectId: 'project_a', maxItems: 8, maxBytes: 2048 }],
  ['prjct_work', { action: 'inspect', workId: 'work_a', maxBytes: 2048 }],
  ['prjct_work', { action: 'select', workId: 'work_a', checkoutId: 'checkout_a', ...mutation }],
  ['prjct_work', { action: 'link', workId: 'work_a', origin: reference, ...mutation }],
  ['prjct_work', { action: 'transition', workId: 'work_a', disposition: 'paused', reason: 'Awaiting a scoped decision.', ...mutation }],
  ['prjct_work', { action: 'transition', workId: 'work_a', disposition: 'completed', reason: 'Assessment retained.', assessmentId: 'assessment_a', ...mutation }],
  ['prjct_plan', { action: 'inspect', workId: 'work_a', revision: reference, maxBytes: 2048 }],
  ['prjct_plan', { action: 'draft', kind: 'spec', workId: 'work_a', content: reference, criterionIds: ['reuse_refresh'], ...mutation }],
  ['prjct_plan', { action: 'draft', kind: 'plan', workId: 'work_a', content: reference, specification: reference,
    tasks: [{ taskId: 'task_a', definitionRevision: 1 }], ...mutation }],
  ['prjct_plan', { action: 'adopt', workId: 'work_a', candidate: reference, ...mutation }],
  ['prjct_task', { action: 'inspect', workId: 'work_a', taskId: 'task_a', view: 'progress', maxItems: 8, maxBytes: 2048 }],
  ['prjct_task', { action: 'define', workId: 'work_a', definition: reference, criterionIds: ['reuse_refresh'], ...mutation }],
  ['prjct_task', { action: 'link', workId: 'work_a', taskId: 'task_a', target: { workId: 'work_a', taskId: 'task_b' }, relation: 'blocks', ...mutation }],
  ['prjct_task', { action: 'claim', workId: 'work_a', taskId: 'task_a', checkoutId: 'checkout_a', access: 'write', ...mutation }],
  ['prjct_task', { action: 'transition', workId: 'work_a', taskId: 'task_a', transition: 'pause', reason: 'Green pending.', ...mutation }],
  ['prjct_task', { action: 'transition', workId: 'work_a', taskId: 'task_a', transition: 'complete', assessmentId: 'assessment_a', ...mutation }],
  ['prjct_checkpoint', { action: 'record', kind: 'progress', workId: 'work_a', taskId: 'task_a', methodId: 'tdd', stage: 'green_pending',
    summary: 'Red observed; source changed.', evidenceIds: ['red_observation'], nextAction: 'Run native checks.', ...mutation }],
  ['prjct_reconcile', { action: 'inspect', workId: 'work_a', taskId: 'task_a', maxBytes: 2048 }],
  ['prjct_reconcile', { action: 'continue', workId: 'work_a', taskId: 'task_a', predecessorAttemptId: 'attempt_a', observationIds: ['observation_a'], ...mutation }],
  ['prjct_knowledge', { action: 'propose', projectId: 'project_a', operationId: 'operation_a', statement: 'Reuse the global refresh owner.',
    supports: [reference], gaps: [], maxBytes: 2048 }],
  ['prjct_knowledge', { action: 'inspect', projectId: 'project_a', claimId: 'claim_a', maxBytes: 2048 }],
  ['prjct_knowledge', { action: 'resolve', projectId: 'project_a', claimId: 'claim_a', resolution: 'confirm', rationale: 'Evaluate current support.', evidenceIds: ['observation_a'], ...mutation }],
  ['prjct_knowledge', { action: 'resolve', projectId: 'project_a', claimId: 'claim_a', resolution: 'correct', replacement: reference,
    rationale: 'Prior claim omitted a dependent view.', evidenceIds: ['observation_a'], ...mutation }],
  ['prjct_artifact', { action: 'stage', projectId: 'project_a', operationId: 'operation_a', kind: 'research', maxBytes: 2048 }],
  ['prjct_artifact', { action: 'publish', projectId: 'project_a', operationId: 'operation_a', kind: 'research', content: 'Findings with sources.', maxBytes: 2048 }],
  ['prjct_artifact', { action: 'publish', projectId: 'project_a', operationId: 'operation_a', kind: 'prototype', stagedBlobId: 'blob_a', expectedContentHash: 'a'.repeat(64), maxBytes: 2048 }],
  ['prjct_artifact', { action: 'inspect', projectId: 'project_a', revision: reference, maxBytes: 2048 }],
  ['prjct_artifact', { action: 'list', projectId: 'project_a', maxItems: 8, maxBytes: 2048 }],
  ['prjct_artifact', { action: 'prepare_export', projectId: 'project_a', operationId: 'operation_a', revision: reference,
    targetDescription: 'Existing issue discussion, subject to current user authorization.', maxBytes: 2048 }],
];

for (const [name, input] of cases) {
  test(`${name} accepts its ${input.action ?? 'query'} contract example through native Pi validation`, () => {
    const declaration = processToolDeclarations.find(item => item.name === name);
    assert.ok(declaration);
    assert.deepEqual(validateToolArguments(declaration, { type: 'toolCall', id: 'contract_call', name, arguments: input }), input);
  });
  test(`${name} ${input.action ?? 'query'} does not accept a model-supplied authority field`, () => {
    const declaration = processToolDeclarations.find(item => item.name === name);
    assert.ok(declaration);
    assert.throws(() => validateToolArguments(declaration,
      { type: 'toolCall', id: 'contract_call', name, arguments: { ...input, approved: true } }));
  });
}
