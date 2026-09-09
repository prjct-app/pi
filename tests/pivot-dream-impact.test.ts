import { observeNative } from './native-observation.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { sourceId } from '../src/representation/sync.ts';
import { projectKey, scopeStore } from '../src/workspace/identity.ts';
import { readRecord } from '../src/workspace/store.ts';

const origin = { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-pivot-'));
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
  await runtime.initProject();
  await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_w', title: 'Cycle', origin, maxBytes: 2048 });
  await runtime.initProject();
  await runtime.syncProject();
  return { root, checkout, runtime, ids, prjctHome };
};

test('replan records the pivot and flags supported claims whose sources changed', async () => {
  const { root, checkout, runtime, ids, prjctHome } = await setup();
  try {
    // A claim supported by the users.ts source id and its current hash.
    const key = (await ids()).key;
    const indexRecord = await readRecord(join(scopeStore(prjctHome, key, 'representation'), 'manifest.json'));
    const index = indexRecord!.payload as { appliedRevision: number; hashes: Record<string, string> };
    const support = { id: sourceId('src/users.ts'), revision: index.appliedRevision, contentHash: index.hashes['src/users.ts']! };
    await runtime.execute('prjct_knowledge', {
      action: 'propose', projectId: (await runtime.identity()).projectId, operationId: 'op_k', statement: 'users.ts reads through queryUsers.',
      supports: [support], gaps: [], maxBytes: 4096,
    });
    const claims0 = (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!
      .payload as { claims: Array<{ id: string; standing: string }> };
    const claimId = claims0.claims[0]!.id;
    await runtime.execute('prjct_knowledge', {
      action: 'resolve', projectId: (await runtime.identity()).projectId, claimId, resolution: 'confirm', rationale: 'read the file',
      evidenceIds: [await observeNative(runtime)], operationId: 'op_r', expectedRevision: (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!.revision, maxBytes: 4096,
    });

    // Reality changes: users.ts is edited.
    await writeFile(join(checkout, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return null }\n");
    const out = await runtime.replan('users endpoint no longer lists users');
    assert.match(out, /Pivot recorded\. 1 supported claim/);
    const claims1 = (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!
      .payload as { claims: Array<{ statement: string; standing: string }> };
    assert.equal(claims1.claims.find(c => c.statement.includes('queryUsers'))?.standing, 'needs_review');
    assert.equal(claims1.claims.some(c => c.statement.startsWith('Pivot:')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dream is deterministic and only flags; impact lists changed and import-touched files', async () => {
  const { root, checkout, runtime, ids, prjctHome } = await setup();
  try {
    const before = await runtime.dream();
    assert.match(before, /Consolidation: 0 claims/);

    const clean = await runtime.impact();
    assert.match(clean, /No changes since index rev/);

    await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [1] }\n');
    const dirty = await runtime.impact();
    assert.match(dirty, /1 modified/);
    assert.match(dirty, /src\/users\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
