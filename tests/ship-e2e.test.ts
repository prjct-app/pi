import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from './test-paths.ts';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';
import { sha256 } from '../src/workspace/ids.ts';

// Full ship cycle against real native bash: init → work → spec adopt (host
// confirm) → task → TDD red/green with the project's real test command →
// assessments → ship. Pi-side TUI approval is exercised as the host confirm
// callback; interactive prompt rendering itself remains manual verification.
test('ship end-to-end: red-green-verified work closes; unverified work is refused', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-ship-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent'), prjctHome = join(root, 'store');
  await mkdir(cwd); await mkdir(agentHome);
  const source = 'export const MINIMUM_NOTICE_MINUTES = 60;\nexport function reserveSeat(n) { return n >= MINIMUM_NOTICE_MINUTES; }\n';
  await writeFile(join(cwd, 'src.js'), source);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'env -u NODE_TEST_CONTEXT node --test check.test.mjs' } }));
  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome, sessionId: 'ship_session', attemptId: 'ship_attempt' });
  await runtime.initProject();
  const id = await runtime.identity();
  const statePath = join(prjctHome, id.day, id.projectId, 'work/state.json');
  const rev = async () => (await readRecord(statePath))!.revision;
  const stateDoc = async () => (await readRecord(statePath))!.payload as {
    observations: Array<{ id: string; execution?: { outcome: string } }>;
    works: Array<{ id: string; disposition: string }>; selectedWorkId: string;
  };
  const mutation = async () => ({ expectedRevision: await rev(), operationId: `ship_${Math.random().toString(36).slice(2)}`, maxBytes: 24000 });
  const bash = async (command: string, label: string) => {
    const beforeHash = await runtime.sourceSnapshot();
    let text: string; let outcome: 'succeeded' | 'failed';
    try { text = JSON.stringify(await createBashTool(cwd).execute(label, { command })); outcome = 'succeeded'; }
    catch (error) { text = String((error as Error).message ?? error); outcome = 'failed'; }
    await runtime.recordObservation(`bash ${label}: ${text.slice(0, 1500)}`,
      { toolCallId: label, toolName: 'bash', command, outcome, beforeHash });
    return (await stateDoc()).observations.at(-1)!.id;
  };
  const confirm = async () => true;

  // Work + spec adopted with host confirmation.
  await runtime.createWork('Fix notice boundary');
  const workId = (await stateDoc()).selectedWorkId;
  const srcRef = { id: `src_${sha256('src.js').slice(0, 12)}`, revision: 1, contentHash: sha256(source) };
  const spec = await runtime.execute('prjct_plan', { action: 'draft', kind: 'spec', workId, content: srcRef, criterionIds: ['boundary_correct'], ...await mutation() });
  const specRef = (spec.details as { items: Array<{ reference: unknown }> }).items[0]!.reference;
  await runtime.execute('prjct_plan', { action: 'adopt', workId, candidate: specRef, ...await mutation() }, { confirm });

  // Task, claimed for write.
  await runtime.execute('prjct_task', { action: 'define', workId, taskId: 'task_fix', definition: srcRef, criterionIds: ['boundary_correct'], ...await mutation() });
  await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 'task_fix', checkoutId: id.checkoutId, access: 'write', ...await mutation() });

  // TDD: seam confirmed by user, failing test authored and observed red.
  const seamObs = await bash('true', 'noop'); // placeholder replaced by user evidence below
  void seamObs;
  await runtime.recordObservation('user_input: seam is reserveSeat boundary behavior', { toolCallId: 'u1', toolName: 'user_input', outcome: 'succeeded' });
  const userObs = (await stateDoc()).observations.at(-1)!.id;
  const progress = async (stage: string, evidenceIds: string[]) =>
    runtime.execute('prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId: 'task_fix', methodId: 'tdd', stage,
      summary: stage, evidenceIds, nextAction: 'next', ...await mutation() });
  await progress('seam_confirmed', [userObs]);

  await writeFile(join(cwd, 'check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { reserveSeat } from './src.js';\ntest('89 minutes rejected', () => assert.equal(reserveSeat(89), false));\n");
  // The import above is .ts — node --test with strip-types handles it via the project's runtime only if enabled; keep the fixture plain JS-compatible.
  await progress('test_authored', []);
  // The project test command detected from package.json is `node --test check.test.mjs`; run exactly that.
  const redObs = await bash('env -u NODE_TEST_CONTEXT node --test check.test.mjs', 'red_run_project');
  await progress('red_observed', [redObs]);

  // Ship must refuse before green.
  const earlyAssessment = await runtime.execute('prjct_checkpoint', { action: 'record', kind: 'assessment', workId, taskId: 'task_fix',
    planRevision: 0, definitionRevision: 1,
    judgments: [{ criterionId: 'boundary_correct', conclusion: 'satisfied', evidenceIds: [redObs], rationale: 'red observed only' }], ...await mutation() });
  const earlyId = (earlyAssessment.details as { recorded: { reference: { id: string } } }).recorded.reference.id;
  await assert.rejects(async () => runtime.execute('prjct_task', { action: 'transition', workId, taskId: 'task_fix', transition: 'complete', assessmentId: earlyId, ...await mutation() }), { code: 'INCOMPLETE_METHOD' }); // TDD gate fires before evidence review: red-only cannot complete

  // Apply the fix (native write), observe green with the exact project command.
  await writeFile(join(cwd, 'src.js'), source.replace('= 60', '= 90'));
  await runtime.syncProject(); // evidence must be against current sources
  await progress('green_pending', []);
  const greenObs = await bash('env -u NODE_TEST_CONTEXT node --test check.test.mjs', 'green_run');
  await progress('green_observed', [greenObs]);

  const assessment = await runtime.execute('prjct_checkpoint', { action: 'record', kind: 'assessment', workId, taskId: 'task_fix',
    planRevision: 0, definitionRevision: 1,
    judgments: [{ criterionId: 'boundary_correct', conclusion: 'satisfied', evidenceIds: [greenObs], rationale: 'green at boundary' }], ...await mutation() });
  const assessmentId = (assessment.details as { recorded: { reference: { id: string } } }).recorded.reference.id;
  await runtime.execute('prjct_task', { action: 'transition', workId, taskId: 'task_fix', transition: 'complete', assessmentId, ...await mutation() });

  const workAssessment = await runtime.execute('prjct_checkpoint', { action: 'record', kind: 'work_assessment', workId,
    specificationRevision: 1, planRevision: 0, taskAssessments: [],
    judgments: [{ criterionId: 'boundary_correct', conclusion: 'satisfied', evidenceIds: [greenObs], rationale: 'verified' }], ...await mutation() });
  void workAssessment;
  const shipText = await runtime.ship();
  assert.match(shipText, /completed/);
  assert.equal((await stateDoc()).works.find(w => w.id === workId)!.disposition, 'completed');
});
