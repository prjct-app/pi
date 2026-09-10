import { observeNative } from './native-observation.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { projectKey, scopeStore } from '../src/workspace/identity.ts';
import { publishRecord, readRecord } from '../src/workspace/store.ts';

const origin = { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) };
const definition = { id: 'def_a', revision: 1, contentHash: 'b'.repeat(64) };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-imp-'));
  const agentHome = join(root, 'agent-home');
  const prjctHome = join(root, 'prjct-home');
  const checkout = join(root, 'checkout');
  await mkdir(agentHome);
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [] }\n');
  await writeFile(join(checkout, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return queryUsers()[0] }\n");
  const runtime = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_one' });
  const ids = async () => {
    const idx = (await readRecord(join(prjctHome, 'identity', 'index.json')))!.payload as { bindings: Array<{ location: string; projectId: string; checkoutId: string; day: string }> };
    const b = idx.bindings.find(item => item.location === checkout)!;
    return { ...b, key: projectKey(b.day, b.projectId) };
  };
  const rev = async () => {
    const { key } = await ids();
    return (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!.revision;
  };
  return { root, checkout, runtime, ids, rev, prjctHome };
};

test('I-1: errors carry the expected checkoutId and current revision', async () => {
  const { root, runtime, ids } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    const { checkoutId } = await ids();
    await assert.rejects(async () => runtime.execute('prjct_search', {
      checkoutId: 'co_wrong', query: 'x', maxItems: 4, maxBytes: 2048,
    }), (error: { code: string; message: string }) => {
      assert.equal(error.code, 'CHECKOUT_MISMATCH');
      assert.match(error.message, new RegExp(checkoutId));
      return true;
    });
    const path = join(root, 'record.json');
    await publishRecord(path, { expectedRevision: 0, payload: { v: 1 } });
    await assert.rejects(async () => publishRecord(path, { expectedRevision: 0, payload: { v: 2 } }),
      (error: { code: string; message: string }) => {
        assert.equal(error.code, 'STALE_REVISION');
        assert.match(error.message, /current revision is 1/);
        return true;
      });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-2: observations are capped instead of growing unbounded', async () => {
  const { root, checkout, runtime, ids, prjctHome } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    for (let index = 0; index < 205; index += 1) await runtime.recordObservation(`bash completed: step ${index}`);
    const { key } = await ids();
    const state = (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!;
    const observations = (state.payload as { observations: Array<{ summary: string }> }).observations;
    assert.equal(observations.length, 200);
    assert.match(observations[observations.length - 1]!.summary, /step 204/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-3: a file declaring the exact symbol outranks BM25 ties and discloses why', async () => {
  const { root, checkout, runtime, ids, prjctHome } = await setup();
  try {
    await writeFile(join(checkout, 'src/notes.md'), 'getUserById is mentioned in prose only.\n');
    await runtime.initProject();
    await runtime.syncProject();
    const { checkoutId } = await ids();
    const found = await runtime.execute('prjct_search', { checkoutId, query: 'getUserById', maxItems: 4, maxBytes: 4096 });
    const items = (found.details as { items: Array<{ summary: string; reasons: string[] }> }).items;
    assert.equal(items[0]?.summary, 'src/users.ts');
    assert.equal(items[0]?.reasons.some(reason => reason.includes('Declares symbol getUserById')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-7: ship refuses when assessment evidence predates a source change', async () => {
  const { root, checkout, runtime, ids, rev, prjctHome } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    const work = await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_w', title: 'Ship gate', origin, maxBytes: 2048 });
    const workId = (work.details as { scope: { workId: string } }).scope.workId;
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['c1'], operationId: 'op_d', expectedRevision: await rev(), taskId: 't1', maxBytes: 4096 });
    const { checkoutId } = await ids();
    await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 't1', checkoutId, access: 'write', operationId: 'op_c', expectedRevision: await rev(), maxBytes: 4096 }, { confirm: async () => true });
    await observeNative(runtime);
    const state = (await readRecord(join(scopeStore(prjctHome, (await ids()).key, 'work'), 'state.json')))!;
    const obsId = (state.payload as { observations: Array<{ id: string }> }).observations[0]!.id;
    const assessment = await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, taskId: 't1', kind: 'assessment', planRevision: 0, definitionRevision: 1,
      judgments: [{ criterionId: 'c1', conclusion: 'satisfied', evidenceIds: [obsId], rationale: 'pass' }],
      operationId: 'op_a', expectedRevision: await rev(), maxBytes: 4096,
    });
    const assessmentRef = (assessment.details as { recorded: { reference: { id: string; revision: number; contentHash: string } } }).recorded.reference;
    await runtime.execute('prjct_task', { action: 'transition', workId, taskId: 't1', transition: 'complete', assessmentId: assessmentRef.id,
      operationId: 'op_done', expectedRevision: await rev(), maxBytes: 4096 });
    await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, kind: 'work_assessment', specificationRevision: 0, planRevision: 0,
      taskAssessments: [assessmentRef], judgments: [{ criterionId: 'c1', conclusion: 'satisfied', evidenceIds: [obsId], rationale: 'pass' }],
      operationId: 'op_wa', expectedRevision: await rev(), maxBytes: 4096,
    });
    assert.match(await runtime.ship(), /completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-7b: ship refuses after sources change post-assessment', async () => {
  const { root, checkout, runtime, ids, rev, prjctHome } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    const work = await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_w', title: 'Ship gate 2', origin, maxBytes: 2048 });
    const workId = (work.details as { scope: { workId: string } }).scope.workId;
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['c1'], operationId: 'op_d', expectedRevision: await rev(), taskId: 't1', maxBytes: 4096 });
    const { checkoutId } = await ids();
    await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 't1', checkoutId, access: 'write', operationId: 'op_c', expectedRevision: await rev(), maxBytes: 4096 }, { confirm: async () => true });
    await observeNative(runtime);
    const state = (await readRecord(join(scopeStore(prjctHome, (await ids()).key, 'work'), 'state.json')))!;
    const obsId = (state.payload as { observations: Array<{ id: string }> }).observations[0]!.id;
    const assessment = await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, taskId: 't1', kind: 'assessment', planRevision: 0, definitionRevision: 1,
      judgments: [{ criterionId: 'c1', conclusion: 'satisfied', evidenceIds: [obsId], rationale: 'pass' }],
      operationId: 'op_a', expectedRevision: await rev(), maxBytes: 4096,
    });
    const assessmentRef = (assessment.details as { recorded: { reference: { id: string; revision: number; contentHash: string } } }).recorded.reference;
    await runtime.execute('prjct_task', { action: 'transition', workId, taskId: 't1', transition: 'complete',
      assessmentId: assessmentRef.id, operationId: 'op_done', expectedRevision: await rev(), maxBytes: 4096 });
    await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, kind: 'work_assessment', specificationRevision: 0, planRevision: 0,
      taskAssessments: [assessmentRef], judgments: [{ criterionId: 'c1', conclusion: 'satisfied', evidenceIds: [obsId], rationale: 'pass' }],
      operationId: 'op_wa', expectedRevision: await rev(), maxBytes: 4096,
    });
    await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [9] }\n');
    assert.match(await runtime.ship(), /Ship refused: .*current source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
