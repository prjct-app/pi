import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { sourceId } from '../src/representation/sync.ts';
import { projectKey, scopeStore } from '../src/workspace/identity.ts';
import { readRecord } from '../src/workspace/store.ts';

const origin = { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) };
const definition = { id: 'def_a', revision: 1, contentHash: 'b'.repeat(64) };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-rc-'));
  const agentHome = join(root, 'agent-home');
  const prjctHome = join(root, 'prjct-home');
  const checkout = join(root, 'checkout');
  await mkdir(agentHome);
  await mkdir(checkout);
  await writeFile(join(checkout, 'main.ts'), 'export const main = 1;\n');
  const one = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_one' });
  const two = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_two' });
  await one.initProject();
  const work = await one.execute('prjct_work', {
    action: 'create', projectId: (await one.identity()).projectId, operationId: 'op_work', title: 'Cycle', origin, maxBytes: 2048,
  });
  const workId = (work.details as { scope: { workId: string } }).scope.workId;
  const ids = async () => {
    const idx = (await readRecord(join(prjctHome, 'identity', 'index.json')))!.payload as { bindings: Array<{ location: string; projectId: string; checkoutId: string; day: string }> };
    const b = idx.bindings.find(item => item.location === checkout)!;
    return { ...b, key: projectKey(b.day, b.projectId) };
  };
  const rev = async () => {
    const { key } = await ids();
    return (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!.revision;
  };
  return { root, checkout, one, two, workId, ids, rev, prjctHome };
};

test('continue takes over a named predecessor with recorded observations; the old grant goes stale', async () => {
  const { root, checkout, one, two, workId, ids, rev, prjctHome } = await setup();
  try {
    await one.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['crit_a'], operationId: 'op_t', expectedRevision: await rev(), taskId: 'task_a', maxBytes: 4096 });
    const { checkoutId } = await ids();
    await one.execute('prjct_task', { action: 'claim', workId, taskId: 'task_a', checkoutId, access: 'write', operationId: 'op_c', expectedRevision: await rev(), maxBytes: 4096 }, { confirm: async () => true });
    await one.recordObservation('bash completed: build ok');

    const inspection = await two.execute('prjct_reconcile', { action: 'inspect', workId, taskId: 'task_a', maxBytes: 4096 });
    assert.equal((inspection.details as { predecessorAttemptId: string }).predecessorAttemptId, 'attempt_one');

    await assert.rejects(async () => two.execute('prjct_reconcile', {
      action: 'continue', workId, taskId: 'task_a', predecessorAttemptId: 'attempt_one',
      observationIds: ['not_recorded'], operationId: 'op_k1', expectedRevision: await rev(), maxBytes: 4096,
    }), { code: 'MISSING_EVIDENCE' });

    const continued = await two.execute('prjct_reconcile', {
      action: 'continue', workId, taskId: 'task_a', predecessorAttemptId: 'attempt_one',
      observationIds: (await readRecord(join(scopeStore(prjctHome, (await ids()).key, 'work'), 'state.json')))!
        .payload && ((await readRecord(join(scopeStore(prjctHome, (await ids()).key, 'work'), 'state.json')))!.payload as { observations: Array<{ id: string }> }).observations.map(o => o.id),
      operationId: 'op_k2', expectedRevision: await rev(), maxBytes: 4096,
    }, { confirm: async () => true });
    assert.equal((continued.details as { status: string }).status, 'ok');

    await assert.rejects(async () => one.execute('prjct_task', {
      action: 'transition', workId, taskId: 'task_a', transition: 'pause', reason: 'old attempt',
      operationId: 'op_old', expectedRevision: await rev(), maxBytes: 4096,
    }), { code: 'STALE_GRANT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cochange edges come from git history and are labelled correlation, not causality', async () => {
  const { root, checkout, one, workId, ids, prjctHome } = await setup();
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: checkout });
    git(['init']);
    git(['add', 'main.ts']);
    git(['-c', 'user.email=t@x.i', '-c', 'user.name=T', 'commit', '-m', 'one']);
    await writeFile(join(checkout, 'second.ts'), 'export const second = 1;\n');
    git(['add', '.']);
    git(['-c', 'user.email=t@x.i', '-c', 'user.name=T', 'commit', '-m', 'two']);
    await writeFile(join(checkout, 'main.ts'), 'export const main = 2;\n');
    await writeFile(join(checkout, 'second.ts'), 'export const second = 2;\n');
    git(['add', '.']);
    git(['-c', 'user.email=t@x.i', '-c', 'user.name=T', 'commit', '-m', 'pair']);
    await writeFile(join(checkout, 'main.ts'), 'export const main = 3;\n');
    await writeFile(join(checkout, 'second.ts'), 'export const second = 3;\n');
    git(['add', '.']);
    git(['-c', 'user.email=t@x.i', '-c', 'user.name=T', 'commit', '-m', 'pair again']);

    await one.initProject();
    await one.initProject();
    await one.syncProject();
    const { checkoutId } = await ids();
    const structure = await one.execute('prjct_structure', {
      action: 'neighbors', checkoutId, seeds: [sourceId('main.ts')], relations: ['cochange'],
      maxDepth: 2, maxItems: 8, maxBytes: 4096,
    });
    const graph = structure.details as { edges: Array<{ relation: string; basis: string; to: string }>; nodes?: Array<{ path: string }> };
    assert.equal(graph.edges.some(edge => edge.relation === 'cochange' && edge.basis === 'cochange'), true);
    assert.equal(graph.nodes?.some(node => node.path === 'second.ts'), true);
    void workId;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claims linked to a source surface next to its search hit (guard)', async () => {
  const { root, checkout, one, ids, rev, prjctHome } = await setup();
  try {
    await writeFile(join(checkout, 'auth.ts'), 'export function loginUser() { return true }\n');
    await one.initProject();
    await one.syncProject();
    const support = { id: sourceId('auth.ts'), revision: 1, contentHash: 'c'.repeat(64) };
    await one.execute('prjct_knowledge', {
      action: 'propose', projectId: (await one.identity()).projectId, operationId: 'op_k', statement: 'loginUser must never skip MFA.',
      supports: [support], gaps: [], maxBytes: 4096,
    });
    const { checkoutId } = await ids();
    const found = await one.execute('prjct_search', { checkoutId, query: 'loginUser', maxItems: 8, maxBytes: 4096 });
    const items = (found.details as { items: Array<{ kind: string; summary: string }> }).items;
    assert.equal(items.some(item => item.kind === 'source' && item.summary === 'auth.ts'), true);
    assert.equal(items.some(item => item.kind === 'claim' && item.summary.includes('MFA')), true);
    void rev;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
