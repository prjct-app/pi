import { observeNative } from './native-observation.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { projectKey, scopeStore } from '../src/workspace/identity.ts';
import { readRecord } from '../src/workspace/store.ts';

const origin = { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) };
const definition = { id: 'def_a', revision: 1, contentHash: 'b'.repeat(64) };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-cycle-'));
  const agentHome = join(root, 'agent-home');
  const prjctHome = join(root, 'prjct-home');
  const checkout = join(root, 'checkout');
  await mkdir(agentHome);
  await mkdir(checkout);
  await writeFile(join(checkout, 'main.ts'), 'export const main = 1;\n');
  const runtime = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_one' });
  const other = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_two' });
  await runtime.initProject();
  const work = await runtime.execute('prjct_work', {
    action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_work', title: 'Ship the cycle', origin, maxBytes: 2048,
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
  const observations = async () => {
    const { key } = await ids();
    const record = await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json'));
    return ((record!.payload as { observations: Array<{ id: string }> }).observations ?? []);
  };
  return { root, checkout, runtime, other, workId, ids, rev, observations };
};

test('link blocks, frontier ranks ready tasks, claim is atomic across attempts', async () => {
  const { root, runtime, other, workId, ids, rev } = await setup();
  try {
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['crit_a'], operationId: 'op_t1', expectedRevision: await rev(), taskId: 'task_setup', maxBytes: 4096 });
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['crit_a'], operationId: 'op_t2', expectedRevision: await rev(), taskId: 'task_build', maxBytes: 4096 });

    const linked = await runtime.execute('prjct_task', {
      action: 'link', workId, taskId: 'task_setup', target: { workId, taskId: 'task_build' },
      relation: 'blocks', operationId: 'op_link', expectedRevision: await rev(), maxBytes: 4096,
    });
    assert.equal((linked.details as { status: string }).status, 'ok');

    const frontier = await runtime.execute('prjct_task', { action: 'frontier', workId, maxItems: 8, maxBytes: 4096 });
    const view = frontier.details as { items: Array<{ taskId: string }>; gaps: string[] };
    assert.deepEqual(view.items.map(item => item.taskId), ['task_setup']);
    assert.match(view.gaps.join(' '), /task_build is blocked by task_setup/);

    await assert.rejects(async () => runtime.execute('prjct_task', {
      action: 'link', workId, taskId: 'task_build', target: { workId, taskId: 'task_setup' },
      relation: 'blocks', operationId: 'op_cycle', expectedRevision: await rev(), maxBytes: 4096,
    }), { code: 'INVALID_RESULT' });

    const { checkoutId } = await ids();
    const claimed = await runtime.execute('prjct_task', {
      action: 'claim', workId, taskId: 'task_setup', checkoutId,
      access: 'write', operationId: 'op_claim', expectedRevision: await rev(), maxBytes: 4096,
    }, { confirm: async () => true });
    assert.equal((claimed.details as { items: Array<{ grantStanding: string; disposition: string }> }).items[0]?.grantStanding, 'valid');
    assert.equal((claimed.details as { items: Array<{ disposition: string }> }).items[0]?.disposition, 'in_progress');

    await assert.rejects(async () => other.execute('prjct_task', {
      action: 'claim', workId, taskId: 'task_setup', checkoutId,
      access: 'write', operationId: 'op_steal', expectedRevision: await rev(), maxBytes: 4096,
    }, { confirm: async () => true }), { code: 'CLAIM_CONFLICT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completion requires a native observation; a host-recorded bash outcome closes the loop', async () => {
  const { root, runtime, workId, ids, rev, observations } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['crit_green'], operationId: 'op_t', expectedRevision: await rev(), taskId: 'task_test', maxBytes: 4096 });
    const { checkoutId } = await ids();
    await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 'task_test',
      checkoutId, access: 'write', operationId: 'op_c', expectedRevision: await rev(), maxBytes: 4096 }, { confirm: async () => true });

    await assert.rejects(async () => runtime.execute('prjct_checkpoint', {
      action: 'record', workId, taskId: 'task_test', kind: 'assessment', planRevision: 0, definitionRevision: 1,
      judgments: [{ criterionId: 'crit_green', conclusion: 'satisfied', evidenceIds: ['forged'], rationale: 'trust me' }],
      operationId: 'op_a1', expectedRevision: await rev(), maxBytes: 4096,
    }), { code: 'MISSING_EVIDENCE' });

    await observeNative(runtime);
    const obsId = (await observations())[0]?.id;
    assert.ok(obsId);

    const assessment = await runtime.execute('prjct_checkpoint', {
      action: 'record', workId, taskId: 'task_test', kind: 'assessment', planRevision: 0, definitionRevision: 1,
      judgments: [{ criterionId: 'crit_green', conclusion: 'satisfied', evidenceIds: [obsId!], rationale: 'npm test passed' }],
      operationId: 'op_a2', expectedRevision: await rev(), maxBytes: 4096,
    });
    const assessmentId = (assessment.details as { recorded: { reference: { id: string } } }).recorded.reference.id;

    const completed = await runtime.execute('prjct_task', {
      action: 'transition', workId, taskId: 'task_test', transition: 'complete', assessmentId,
      operationId: 'op_done', expectedRevision: await rev(), maxBytes: 4096,
    });
    const item = (completed.details as { items: Array<{ disposition: string; grantStanding: string }> }).items[0];
    assert.equal(item?.disposition, 'completed');
    assert.equal(item?.grantStanding, 'released');

    // A source change after the observation makes the same evidence stale.
    const second = new ProcessRuntime({ agentHome: join(root, 'agent-home'), cwd: join(root, 'checkout'), prjctHome: join(root, 'prjct-home'), attemptId: 'attempt_one' });
    await writeFile(join(root, 'checkout', 'main.ts'), 'export const main = 2;\n');
    await second.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['crit_next'], operationId: 'op_t3', expectedRevision: await rev(), taskId: 'task_next', maxBytes: 4096 });
    await second.execute('prjct_task', { action: 'claim', workId, taskId: 'task_next', checkoutId, access: 'write', operationId: 'op_c2', expectedRevision: await rev(), maxBytes: 4096 }, { confirm: async () => true });
    const staleAssessment = await second.execute('prjct_checkpoint', {
      action: 'record', workId, taskId: 'task_next', kind: 'assessment', planRevision: 0, definitionRevision: 1,
      judgments: [{ criterionId: 'crit_next', conclusion: 'satisfied', evidenceIds: [obsId!], rationale: 'same obs' }],
      operationId: 'op_a3', expectedRevision: await rev(), maxBytes: 4096,
    });
    await assert.rejects(async () => second.execute('prjct_task', {
      action: 'transition', workId, taskId: 'task_next', transition: 'complete',
      assessmentId: (staleAssessment.details as { recorded: { reference: { id: string } } }).recorded.reference.id,
      operationId: 'op_done2', expectedRevision: await rev(), maxBytes: 4096,
    }), { code: 'SCOPE_MISMATCH' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan draft then adopt activates the revision; a stale candidate is rejected', async () => {
  const { root, runtime, workId, rev } = await setup();
  try {
    const drafted = await runtime.execute('prjct_plan', {
      action: 'draft', kind: 'spec', workId, content: definition, criterionIds: ['crit_a'],
      operationId: 'op_d', expectedRevision: await rev(), maxBytes: 4096,
    });
    const reference = (drafted.details as { items: Array<{ reference: { id: string; revision: number; contentHash: string } }> }).items[0]!.reference;
    const adopted = await runtime.execute('prjct_plan', {
      action: 'adopt', workId, candidate: reference, operationId: 'op_adopt', expectedRevision: await rev(), maxBytes: 4096,
    }, { confirm: async () => true });
    assert.equal((adopted.details as { items: Array<{ standing: string }> }).items[0]?.standing, 'active');
    await runtime.initProject();
    const inspected = await runtime.execute('prjct_work', { action: 'inspect', workId, maxBytes: 4096 });
    assert.equal((inspected.details as { items: Array<{ activeSpecification: { id: string } | null }> }).items[0]?.activeSpecification?.id, reference.id);
    await assert.rejects(async () => runtime.execute('prjct_plan', {
      action: 'adopt', workId, candidate: { ...reference, revision: 99 }, operationId: 'op_stale', expectedRevision: await rev(), maxBytes: 4096,
    }), { code: 'STALE_REVISION' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('knowledge resolve confirms a claim; prime and land compose the ceremony', async () => {
  const { root, runtime, workId, rev } = await setup();
  try {
    const proposed = await runtime.execute('prjct_knowledge', {
      action: 'propose', projectId: (await runtime.identity()).projectId, operationId: 'op_k', statement: 'The cycle uses native bash evidence.',
      supports: [], gaps: [], maxBytes: 4096,
    }, { confirm: async () => true });
    const claimId = (proposed.details as { items: Array<{ reference: { id: string } }> }).items[0]!.reference.id;
    const resolved = await runtime.execute('prjct_knowledge', {
      action: 'resolve', projectId: (await runtime.identity()).projectId, claimId, resolution: 'confirm', rationale: 'Observed in session.',
      evidenceIds: [await observeNative(runtime)], operationId: 'op_kr', expectedRevision: await rev(), maxBytes: 4096,
    });
    assert.equal((resolved.details as { items: Array<{ standing: string }> }).items[0]?.standing, 'supported');
    const fetched = await runtime.execute('prjct_knowledge', { action: 'inspect', projectId: (await runtime.identity()).projectId, claimId, maxBytes: 4096 });
    assert.equal((fetched.details as { items: Array<{ standing: string }> }).items[0]?.standing, 'supported');

    const brief = await runtime.execute('prjct_context', { action: 'lookup', query: 'current work', maxBytes: 8192 });
    const briefText = JSON.stringify(brief.details);
    assert.match(briefText, /Ship the cycle/);
    const workBrief = await runtime.execute('prjct_context', { action: 'lookup', query: 'close', maxBytes: 8192 });
    assert.match(JSON.stringify(workBrief.details), /Ship the cycle/);
    void workId;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
