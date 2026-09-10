import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from './test-paths.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';
import { newId } from '../src/workspace/ids.ts';

test('write authority is exact, UI-confirmed, checkout-bound, and suspended across lifecycle loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-native-integration-'));
  const cwd = join(root, 'checkout');
  const prjctHome = join(root, 'store');
  const agentHome = join(root, 'agent');
  try {
    await mkdir(cwd); await mkdir(agentHome);
    await writeFile(join(cwd, 'main.ts'), 'export const value = 1;\n');
    const runtime = new ProcessRuntime({ cwd, prjctHome, agentHome, attemptId: 'attempt_current', sessionId: 'session_current' });
    await runtime.initProject();
    await runtime.createWork('Protect native writes');
    const identity = await runtime.identity();
    const path = join(prjctHome, identity.day, identity.projectId, 'work/state.json');
    const record = async () => (await readRecord(path))!;
    const state = async () => (await record()).payload as { selectedWorkId: string };
    const mutation = async () => ({ operationId: newId('op'), expectedRevision: (await record()).revision, maxBytes: 4096 });
    const workId = (await state()).selectedWorkId;
    await runtime.execute('prjct_task', { action: 'define', workId, taskId: 'task_write',
      definition: { id: 'definition', revision: 1, contentHash: 'a'.repeat(64) }, criterionIds: ['safe'], ...await mutation() });

    const beforeDeniedClaim = await record();
    await assert.rejects(async () => runtime.execute('prjct_task', { action: 'claim', workId, taskId: 'task_write',
      checkoutId: identity.checkoutId, access: 'write', ...await mutation() }), { code: 'CONFIRMATION_REQUIRED' });
    assert.equal((await record()).contentHash, beforeDeniedClaim.contentHash, 'denied authority must not mutate state');

    const claim = { action: 'claim', workId, taskId: 'task_write', checkoutId: identity.checkoutId,
      access: 'write', ...await mutation() };
    let confirmations = 0;
    const claimed = await runtime.execute('prjct_task', claim, { confirm: async message => { confirmations += 1; return /task_write.*attempt_current/.test(message); } });
    const replayed = await runtime.execute('prjct_task', claim, { confirm: async () => { throw new Error('receipt replay must not request new authority'); } });
    assert.deepEqual(replayed, claimed);
    assert.equal(confirmations, 1, 'the exact authorized operation consumes one confirmation');
    const allowed = await runtime.nativeMutationDecision('main.ts');
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.managed, true);
    assert.equal(allowed.taskId, 'task_write');
    await assert.rejects(() => runtime.nativeMutationDecision('../escape.ts'), { code: 'PROHIBITED_PATH' });

    const beforeWrongSelection = await record();
    await assert.rejects(async () => runtime.execute('prjct_work', { action: 'select', workId, checkoutId: 'checkout_other', ...await mutation() }), { code: 'CHECKOUT_MISMATCH' });
    assert.equal((await record()).contentHash, beforeWrongSelection.contentHash);

    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    await assert.rejects(runtime.suspendAttempt(), { code: 'STORE_LOCKED' });
    assert.equal((await runtime.nativeMutationDecision('main.ts')).allowed, true, 'failed suspension is surfaced so the host can cancel lifecycle loss');
    await unlink(`${path}.lock`);
    await runtime.suspendAttempt();
    const suspended = await runtime.nativeMutationDecision('main.ts');
    assert.equal(suspended.allowed, false);
    assert.equal(suspended.code, 'RECONCILE_REQUIRED');
  } finally { await rm(root, { recursive: true, force: true }); }
});
