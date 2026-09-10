import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { newId } from '../src/workspace/ids.ts';
import { readRecord } from '../src/workspace/store.ts';
import { hasVerificationPair, type VerificationObservation } from '../src/work/verification-pair.ts';
import { tmpdir } from './test-paths.ts';

// Native bash executes only disposable fixture scripts. A separate control file
// allows ordering tests without changing the indexed source tree between runs.
const setup = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-verification-pair-'));
  const cwd = join(root, 'checkout'), agentHome = join(root, 'agent'), prjctHome = join(root, 'store');
  await mkdir(cwd); await mkdir(agentHome);
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = join(root, 'exit-code');
  const script = `process.exit(Number(require('node:fs').readFileSync(${JSON.stringify(control)}, 'utf8')));\n`;
  await writeFile(join(cwd, 'verify.cjs'), script);
  await writeFile(join(cwd, 'other.cjs'), script);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }));
  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome, attemptId: 'pair_attempt', sessionId: 'pair_session' });
  await runtime.initProject();
  await runtime.createWork('Verify the same command');
  const identity = await runtime.identity();
  const statePath = join(prjctHome, identity.day, identity.projectId, 'work/state.json');
  const record = async () => (await readRecord(statePath))!;
  const state = async () => (await record()).payload as {
    selectedWorkId: string;
    observations: Array<{ id: string; verification?: boolean; execution?: { command?: string } }>;
  };
  const workId = (await state()).selectedWorkId;
  const mutation = async () => ({ operationId: newId('op'), expectedRevision: (await record()).revision, maxBytes: 8192 });
  await runtime.execute('prjct_task', { action: 'define', workId, taskId: 'task_pair',
    definition: { id: 'definition_pair', revision: 1, contentHash: 'a'.repeat(64) }, criterionIds: ['paired'], ...await mutation() });
  await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 'task_pair', checkoutId: identity.checkoutId,
    access: 'write', ...await mutation() }, { confirm: async () => true });
  const progress = async (methodId: string, stage: string, evidenceIds: string[] = []) =>
    runtime.execute('prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId: 'task_pair',
      methodId, stage, evidenceIds, summary: stage, nextAction: 'Continue verification', ...await mutation() }, { confirm: async () => true });
  const run = async (command: string, exitCode: number) => {
    await writeFile(control, String(exitCode));
    const beforeHash = await runtime.sourceSnapshot();
    const toolCallId = newId('native_run');
    const execution = await createBashTool(cwd).execute(toolCallId, { command }).then(
      result => ({ outcome: 'succeeded' as const, summary: JSON.stringify(result) }),
      error => ({ outcome: 'failed' as const, summary: String(error) }),
    );
    assert.equal(execution.outcome, exitCode === 0 ? 'succeeded' : 'failed', 'The fixture must actually execute with the intended outcome');
    await runtime.recordObservation(execution.summary, { toolName: 'bash', toolCallId, command, beforeHash, outcome: execution.outcome });
    return (await state()).observations.at(-1)!.id;
  };
  const prepareGreen = async (methodId: 'tdd' | 'diagnosing-bugs', redId: string) => {
    if (methodId === 'tdd') {
      // Scripted host input for this fixture; not a model-provided approval.
      await runtime.recordObservation('Fixture user confirms the public seam', { toolName: 'user_input', toolCallId: newId('input'), outcome: 'succeeded' });
      await progress(methodId, 'seam_confirmed', [(await state()).observations.at(-1)!.id]);
      await progress(methodId, 'test_authored');
      await progress(methodId, 'red_observed', [redId]);
      await progress(methodId, 'green_pending');
    } else {
      await progress(methodId, 'loop_built');
      await progress(methodId, 'reproduced', [redId]);
      for (const stage of ['minimized', 'hypotheses_ranked', 'instrumented']) await progress(methodId, stage);
    }
  };
  return { cwd, runtime, statePath, record, state, run, progress, prepareGreen };
};

const pairingError = { code: 'UNVERIFIABLE_EVIDENCE', message: /same command.*after.*failure/i };

test('diagnosis rejects an unrelated successful command without committing a fixed checkpoint', async t => {
  const fixture = await setup(t);
  const red = await fixture.run('node verify.cjs', 1);
  await fixture.prepareGreen('diagnosing-bugs', red);
  const unrelated = await fixture.run('node other.cjs', 0);
  const revision = (await fixture.record()).revision;
  await assert.rejects(fixture.progress('diagnosing-bugs', 'fixed', [unrelated]), pairingError);
  assert.equal((await fixture.record()).revision, revision);
});

test('TDD rejects switching the configured project test between red and green', async t => {
  const fixture = await setup(t);
  const red = await fixture.run('node verify.cjs', 1);
  await fixture.prepareGreen('tdd', red);
  await writeFile(join(fixture.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node other.cjs' } }));
  await fixture.runtime.syncProject();
  const green = await fixture.run('node other.cjs', 0);
  assert.equal((await fixture.state()).observations.find(row => row.id === green)?.verification, true);
  await assert.rejects(fixture.progress('tdd', 'green_observed', [green]), pairingError);
});

for (const methodId of ['tdd', 'diagnosing-bugs'] as const) {
  const greenStage = methodId === 'tdd' ? 'green_observed' : 'fixed';
  test(`${methodId} rejects reusing a successful run that preceded the reproduced failure`, async t => {
    const fixture = await setup(t);
    const oldGreen = await fixture.run('node verify.cjs', 0);
    const red = await fixture.run('node verify.cjs', 1);
    await fixture.prepareGreen(methodId, red);
    await assert.rejects(fixture.progress(methodId, greenStage, [oldGreen]), pairingError);
  });

  test(`${methodId} accepts a later matching run after source changes, ignoring only outer command whitespace`, async t => {
    const fixture = await setup(t);
    const red = await fixture.run('node verify.cjs', 1);
    await fixture.prepareGreen(methodId, red);
    await writeFile(join(fixture.cwd, 'fix.js'), 'export const fixed = true;\n');
    await fixture.runtime.syncProject();
    const green = await fixture.run('  node verify.cjs  ', 0);
    await fixture.progress(methodId, greenStage, [green]);
  });
}

test('changing the indexed test substrate between RED and GREEN invalidates the pair', async t => {
  const fixture = await setup(t);
  const red = await fixture.run('node verify.cjs', 1);
  await fixture.prepareGreen('tdd', red);
  await writeFile(join(fixture.cwd, 'verify.cjs'), 'process.exit(0);\n');
  await fixture.runtime.syncProject();
  const green = await fixture.run('node verify.cjs', 0);
  await assert.rejects(fixture.progress('tdd', 'green_observed', [green]), pairingError);
});

test('redacted commands with different original values cannot form a verification pair', async t => {
  const fixture = await setup(t);
  const red = await fixture.run('FIXTURE_TOKEN=fixture_red node verify.cjs', 1);
  await fixture.prepareGreen('diagnosing-bugs', red);
  const green = await fixture.run('FIXTURE_TOKEN=fixture_green node verify.cjs', 0);
  const rows = (await fixture.state()).observations;
  assert.equal(rows.find(row => row.id === red)?.execution?.command, rows.find(row => row.id === green)?.execution?.command);
  await assert.rejects(fixture.progress('diagnosing-bugs', 'fixed', [green]), pairingError);
  const persisted = await readFile(fixture.statePath, 'utf8');
  assert.doesNotMatch(persisted, /fixture_red|fixture_green/);
});

test('diagnosis can pair matching redacted commands without retaining their original value', async t => {
  const fixture = await setup(t);
  const command = 'FIXTURE_TOKEN=fixture_private node verify.cjs';
  const red = await fixture.run(command, 1);
  await fixture.prepareGreen('diagnosing-bugs', red);
  const green = await fixture.run(command, 0);
  await fixture.progress('diagnosing-bugs', 'fixed', [green]);
  assert.doesNotMatch(await readFile(fixture.statePath, 'utf8'), /fixture_private/);
});

test('the pure pairing gate fails closed for legacy, cross-scope, and reused-call observations', () => {
  const row = (id: string, outcome: 'failed' | 'succeeded', extra: Partial<VerificationObservation> = {}): VerificationObservation => ({
    id, provenance: 'native_observation', workId: 'work_a', taskId: 'task_a', attemptId: 'attempt_a', sessionId: 'session_a',
    checkoutId: 'checkout_a', commandIdentity: 'command_a', verificationSubstrate: 'substrate_a', execution: { toolCallId: `call_${id}`, toolName: 'bash', outcome }, ...extra,
  });
  const legacy: VerificationObservation[] = [
    { id: 'red', provenance: 'native_observation', workId: 'work_a', taskId: 'task_a', execution: { toolCallId: 'call_red', toolName: 'bash', outcome: 'failed' } },
    { id: 'green', provenance: 'native_observation', workId: 'work_a', taskId: 'task_a', execution: { toolCallId: 'call_green', toolName: 'bash', outcome: 'succeeded' } },
  ];
  assert.equal(hasVerificationPair(legacy, ['red'], ['green']), false, 'identity-less legacy evidence cannot match redacted display strings');
  const crossScope = [row('red', 'failed'), row('green', 'succeeded', { taskId: 'task_b' })];
  assert.equal(hasVerificationPair(crossScope, ['red'], ['green']), false);
  const wrongAttempt = [row('red', 'failed'), row('green', 'succeeded', { attemptId: 'attempt_b' })];
  assert.equal(hasVerificationPair(wrongAttempt, ['red'], ['green']), false);
  const changedSubstrate = [row('red', 'failed'), row('green', 'succeeded', { verificationSubstrate: 'substrate_b' })];
  assert.equal(hasVerificationPair(changedSubstrate, ['red'], ['green']), false);
  const sameCall = [row('red', 'failed', { execution: { toolCallId: 'same', toolName: 'bash', outcome: 'failed' } }),
    row('green', 'succeeded', { execution: { toolCallId: 'same', toolName: 'bash', outcome: 'succeeded' } })];
  assert.equal(hasVerificationPair(sameCall, ['red'], ['green']), false);
  const missingScope: VerificationObservation[] = [
    { id: 'red', provenance: 'native_observation', taskId: 'task_a', commandIdentity: 'command_a', execution: { toolCallId: 'call_red', toolName: 'bash', outcome: 'failed' } },
    { id: 'green', provenance: 'native_observation', taskId: 'task_a', commandIdentity: 'command_a', execution: { toolCallId: 'call_green', toolName: 'bash', outcome: 'succeeded' } },
  ];
  assert.equal(hasVerificationPair(missingScope, ['red'], ['green']), false);
});
