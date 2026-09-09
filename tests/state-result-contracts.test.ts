import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStateResult } from '../src/pi/state-result-contracts.ts';

const reference = { id: 'work_a', revision: 2, contentHash: 'a'.repeat(64) };
const workRequest = { action: 'inspect', workId: 'work_a', maxBytes: 2048 };
const workResult = { action: 'inspect', status: 'ok', scope: { workId: 'work_a' }, gaps: [],
  items: [{ reference, projectId: 'project_a', title: 'Reuse refresh', disposition: 'open',
    activeSpecification: null, activePlan: null, tasks: [], nextAction: 'Clarify the requested behavior.' }] };

test('work inspection exposes explicit scope and progress without synthesizing approval', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_work', workRequest, workResult));
  assert.throws(() => validateStateResult('prjct_work', workRequest, { ...workResult, approved: true }), { code: 'INVALID_RESULT' });
});

test('a work result cannot answer a request for a different work', () => {
  assert.throws(() => validateStateResult('prjct_work', workRequest, {
    ...workResult, scope: { workId: 'work_b' }, items: [{ ...workResult.items[0], reference: { ...reference, id: 'work_b' } }],
  }), { code: 'SCOPE_MISMATCH' });
});

const taskRequest = { action: 'inspect', workId: 'work_a', taskId: 'task_a', maxItems: 8, maxBytes: 2048 };
const taskResult = { action: 'inspect', status: 'ok', scope: { workId: 'work_a', taskId: 'task_a' }, gaps: [],
  items: [{ reference: { id: 'task_a', revision: 2, contentHash: 'a'.repeat(64) }, workId: 'work_a', taskId: 'task_a',
    disposition: 'in_progress', definition: null, criterionIds: ['reuse_refresh'], blockers: [], attemptId: 'attempt_b',
    grantStanding: 'valid', nextAction: 'Observe green before completion.' }] };

test('task inspection cannot self-certify completion or inject a force flag', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_task', taskRequest, taskResult));
  assert.throws(() => validateStateResult('prjct_task', taskRequest, { ...taskResult, force: true }), { code: 'INVALID_RESULT' });
});

const planRequest = { action: 'inspect', workId: 'work_a', maxBytes: 2048 };
const planResult = { action: 'inspect', status: 'ok', scope: { workId: 'work_a' }, gaps: [],
  items: [{ reference, kind: 'plan', standing: 'draft', specification: null, tasks: [], criterionIds: ['reuse_refresh'],
    nextAction: 'Adopt only after the user approves this exact revision.' }] };
test('plan inspection names an immutable candidate without granting approval', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_plan', planRequest, planResult));
  assert.throws(() => validateStateResult('prjct_plan', planRequest, { ...planResult, approved: true }), { code: 'INVALID_RESULT' });
});

const reconcileRequest = { action: 'inspect', workId: 'work_a', taskId: 'task_a', maxBytes: 2048 };
const reconcileResult = { action: 'inspect', status: 'partial', scope: { workId: 'work_a', taskId: 'task_a' },
  gaps: ['Predecessor shell effect has no receipt.'], predecessorAttemptId: 'attempt_a', writerStanding: 'uncertain',
  observedEffects: [{ id: 'effect_a', outcome: 'unknown' }], requiredConfirmation: true,
  unknowns: ['Whether the predecessor write landed.'], nextAction: 'Obtain current confirmation before continuing.' };
test('reconciliation cannot treat missing confirmation as consent or proof the predecessor stopped', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_reconcile', reconcileRequest, reconcileResult));
  assert.throws(() => validateStateResult('prjct_reconcile', reconcileRequest, { ...reconcileResult, stopped: true, consent: true }),
    { code: 'INVALID_RESULT' });
});

const knowledgeRequest = { action: 'inspect', projectId: 'project_a', maxBytes: 2048 };
const knowledgeResult = { action: 'inspect', status: 'ok', scope: { projectId: 'project_a' }, gaps: [],
  items: [{ reference: { id: 'claim_a', revision: 1, contentHash: 'a'.repeat(64) },
    statement: 'Reuse the existing global refresh owner.', standing: 'candidate', supports: [reference],
    nextAction: 'Inspect current support before resolving the claim.' }] };
test('knowledge inspection retains standing without a model-supplied verified flag', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_knowledge', knowledgeRequest, knowledgeResult));
  assert.throws(() => validateStateResult('prjct_knowledge', knowledgeRequest, { ...knowledgeResult, verified: true }),
    { code: 'INVALID_RESULT' });
});

const artifactRequest = { action: 'stage', projectId: 'project_a', maxBytes: 2048, operationId: 'operation_a' };
const artifactResult = { action: 'stage', status: 'ok', scope: { projectId: 'project_a' }, gaps: [],
  mutation: { operationId: 'operation_a', scopeId: 'project_a', outcome: 'committed',
    receipt: { id: 'receipt_a', revision: 1, contentHash: 'b'.repeat(64) }, replayed: false, stateRevision: 1 },
  items: [{ reference: { id: 'blob_a', revision: 1, contentHash: 'b'.repeat(64) }, kind: 'research',
    stagedBlobId: 'blob_a', readLocator: 'prjct://artifact/blob_a', exportIntent: null,
    nextAction: 'Author with native write inside the staged locator.' }] };
test('artifact staging returns a managed locator, not an arbitrary client destination', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_artifact', artifactRequest, artifactResult));
  assert.throws(() => validateStateResult('prjct_artifact', artifactRequest, { ...artifactResult, destination: '../client/AGENTS.md' }),
    { code: 'INVALID_RESULT' });
});

const refreshRequest = { action: 'inspect', checkoutId: 'checkout_a', maxBytes: 2048 };
const refreshResult = { action: 'inspect', status: 'partial', scope: { checkoutId: 'checkout_a' },
  gaps: ['symbols failed to apply.'], freshness: 'partial', observedRevision: 8, configRevision: 2,
  currentComponents: ['lexical'], pendingComponents: ['symbols'], lastAttemptFailures: ['symbols'],
  nextAction: 'Inspect the failed component before applying another refresh.' };
test('refresh inspection can acknowledge a partial mechanical state without claiming understanding', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_refresh', refreshRequest, refreshResult));
  assert.throws(() => validateStateResult('prjct_refresh', refreshRequest, { ...refreshResult, understood: true }),
    { code: 'INVALID_RESULT' });
});

const checkpointRequest = { action: 'record', workId: 'work_a', taskId: 'task_a', maxBytes: 2048, operationId: 'operation_a' };
const checkpointResult = { action: 'record', status: 'ok', scope: { workId: 'work_a', taskId: 'task_a' }, gaps: [],
  mutation: { operationId: 'operation_a', scopeId: 'task_a', outcome: 'committed',
    receipt: { id: 'receipt_b', revision: 3, contentHash: 'c'.repeat(64) }, replayed: false, stateRevision: 3 },
  recorded: { kind: 'progress', reference: { id: 'checkpoint_a', revision: 3, contentHash: 'c'.repeat(64) },
    nextAction: 'Run native checks before recording green.' } };
test('a checkpoint acknowledgement records progress without converting the report into completion', () => {
  assert.doesNotThrow(() => validateStateResult('prjct_checkpoint', checkpointRequest, checkpointResult));
  assert.throws(() => validateStateResult('prjct_checkpoint', checkpointRequest, { ...checkpointResult, completed: true }),
    { code: 'INVALID_RESULT' });
});

test('a successful work projection cannot hide remaining coverage gaps', () => {
  assert.throws(() => validateStateResult('prjct_work', workRequest, { ...workResult, gaps: ['Active plan is unknown.'] }),
    { code: 'INVALID_RESULT' });
});
