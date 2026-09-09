import { sha256 } from '../src/workspace/ids.ts';
import { observeNative } from './native-observation.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { projectKey, scopeStore } from '../src/workspace/identity.ts';
import { readRecord } from '../src/workspace/store.ts';

const origin = { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) };
const definition = { id: 'def_a', revision: 1, contentHash: 'b'.repeat(64) };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-ship-'));
  const agentHome = join(root, 'agent-home');
  const prjctHome = join(root, 'prjct-home');
  const checkout = join(root, 'checkout');
  await mkdir(agentHome);
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [] }\n');
  await writeFile(join(checkout, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return queryUsers()[0] }\n");
  const runtime = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_one' });
  await runtime.initProject();
  await runtime.syncProject();
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

test('replan is an agent tool action that records the pivot and flags stale claims', async () => {
  const { root, checkout, runtime, rev, ids, prjctHome } = await setup();
  try {
    const { sourceId } = await import('../src/representation/sync.ts');
    const support = { id: sourceId('src/users.ts'), revision: 1, contentHash: sha256(await readFile(join(checkout, 'src/users.ts'), 'utf8')) };
    await runtime.execute('prjct_knowledge', { action: 'propose', projectId: (await runtime.identity()).projectId, operationId: 'op_k',
      statement: 'users.ts lists users.', supports: [support], gaps: [], maxBytes: 4096 });
    const { projectId } = await import('../src/workspace/identity.ts').then(() => ({} as { projectId: string }));
    void projectId;
    const state = (await readRecord(join(scopeStore(prjctHome, (await ids()).key, 'work'), 'state.json')))!;
    const claimId = (state.payload as { claims: Array<{ id: string }> }).claims[0]!.id;
    await runtime.execute('prjct_knowledge', { action: 'resolve', projectId: (await runtime.identity()).projectId, claimId, resolution: 'confirm',
      rationale: 'read it', evidenceIds: [await observeNative(runtime)], operationId: 'op_r', expectedRevision: await rev(), maxBytes: 4096 });

    await writeFile(join(checkout, 'src/users.ts'), 'export function getUserById() { return null }\n');
    const replanned = await runtime.execute('prjct_knowledge', {
      action: 'replan', projectId: (await runtime.identity()).projectId, statement: 'auth moved to JWT', operationId: 'op_rp',
      expectedRevision: await rev(), maxBytes: 4096,
    });
    const items = (replanned.details as { items: Array<{ statement: string; standing: string }> }).items;
    assert.equal(items.some(item => item.statement.startsWith('Pivot:')), true);

    const consolidated = await runtime.execute('prjct_knowledge', { action: 'consolidate', projectId: (await runtime.identity()).projectId, maxBytes: 4096 });
    const review = (consolidated.details as { items: Array<{ standing: string }> }).items;
    assert.equal(review.some(item => item.standing === 'needs_review'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('impact without seeds derives them from the working-tree diff', async () => {
  const { root, checkout, runtime, ids } = await setup();
  try {
    await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [1] }\n');
    const { checkoutId } = await ids();
    const impact = await runtime.execute('prjct_structure', {
      action: 'impact', checkoutId, seeds: [], relations: ['imports'], maxDepth: 2, maxItems: 16, maxBytes: 8192,
    });
    const details = impact.details as { edges: Array<{ to: string }>; nodes?: Array<{ path: string }>; gaps: string[] };
    assert.equal(details.nodes?.some(node => node.path === 'src/users.ts'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ship refuses with open tasks and completes the work when the assessment is eligible', async () => {
  const { root, runtime, rev, ids } = await setup();
  try {
    await runtime.initProject();
    const work = await runtime.execute('prjct_work', {
      action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_w', title: 'Ship me', origin, maxBytes: 2048,
    });
    const workId = (work.details as { scope: { workId: string } }).scope.workId;
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['c1'], operationId: 'op_d', expectedRevision: await rev(), taskId: 't1', maxBytes: 4096 });
    assert.match(await runtime.ship(), /Ship refused: open tasks/);

    const { checkoutId } = await ids();
    await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 't1', checkoutId, access: 'write', operationId: 'op_c', expectedRevision: await rev(), maxBytes: 4096 });
    await observeNative(runtime);
    const state = await readRecord(join(scopeStore(runtime.prjctRoot, (await ids()).key, 'work'), 'state.json'));
    const obsId = (state!.payload as { observations: Array<{ id: string }> }).observations[0]!.id;
    const assessment = await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, taskId: 't1', kind: 'assessment', planRevision: 0, definitionRevision: 1,
      judgments: [{ criterionId: 'c1', conclusion: 'satisfied', evidenceIds: [obsId], rationale: 'pass' }],
      operationId: 'op_a', expectedRevision: await rev(), maxBytes: 4096,
    });
    const assessmentId = (assessment.details as { recorded: { reference: { id: string } } }).recorded.reference.id;
    await runtime.execute('prjct_task', { action: 'transition', workId, taskId: 't1', transition: 'complete', assessmentId,
      operationId: 'op_done', expectedRevision: await rev(), maxBytes: 4096 });

    assert.match(await runtime.ship(), /Ship refused: no recorded work assessment/);

    await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, kind: 'work_assessment', specificationRevision: 0, planRevision: 0,
      taskAssessments: [], judgments: [{ criterionId: 'c1', conclusion: 'satisfied', evidenceIds: [obsId], rationale: 'pass' }],
      operationId: 'op_wa', expectedRevision: await rev(), maxBytes: 4096,
    });
    assert.match(await runtime.ship(), /completed/);
    assert.match(await runtime.ship(), /already completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
