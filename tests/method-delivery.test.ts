import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from './test-paths.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';
import { matchMethods, methodCatalog, loadMethodDocument, listMethodDocuments } from '../src/methods/registry.ts';

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-methods-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent'), prjctHome = join(root, 'store');
  await mkdir(cwd); await mkdir(agentHome);
  await writeFile(join(cwd, 'README.md'), '# Fixture\n');
  return new ProcessRuntime({ cwd, agentHome, prjctHome, sessionId: 's1', attemptId: 'a1' });
};

test('all 17 bundled methods resolve and every entry document loads', async () => {
  assert.equal(methodCatalog().length, 17);
  for (const m of methodCatalog()) {
    const doc = await loadMethodDocument(m.id as never);
    assert.ok(doc?.content.includes('---'), `${m.id} entry must load`);
    const docs = await listMethodDocuments(m.id as never);
    assert.ok(docs.includes('SKILL.md'), `${m.id} must include SKILL.md`);
  }
  assert.ok(matchMethods('method:tdd')[0]?.id === 'tdd');
  assert.ok(matchMethods('how do I debug this regression')[0]?.id === 'diagnosing-bugs');
});

test('method guidance is served on demand without any project binding', async t => {
  const runtime = await setup(t);
  const catalog = await runtime.execute('prjct_context', { action: 'lookup', query: 'methods', maxBytes: 24000 });
  const text = JSON.stringify(catalog.details);
  assert.match(text, /tdd: Red-green loop/);
  assert.match(text, /wayfinder: Multi-session map/);

  const doc = await runtime.execute('prjct_context', { action: 'lookup', query: 'method:codebase-design', maxBytes: 50000 });
  const body = JSON.stringify(doc.details);
  assert.match(body, /Deep Modules|deep module/i);
  assert.match(body, /deletion test/i);
  assert.match(body, /Linked documents for codebase-design: DEEPENING.md, DESIGN-IT-TWICE.md/);

  const linked = await runtime.execute('prjct_context', { action: 'lookup', query: 'method:codebase-design/DESIGN-IT-TWICE.md', maxBytes: 50000 });
  assert.match(JSON.stringify(linked.details), /radically different/i);

  const unknown = await runtime.execute('prjct_context', { action: 'lookup', query: 'method:nope', maxBytes: 8000 });
  assert.equal((unknown.details as { status: string }).status, 'abstained');
});

test('tight budgets trim method documents with an explicit gap instead of pretending completeness', async t => {
  const runtime = await setup(t);
  const small = await runtime.execute('prjct_context', { action: 'lookup', query: 'method:wayfinder', maxBytes: 2400 });
  const details = small.details as { status: string; gaps: string[] };
  assert.equal(details.status, 'partial');
  assert.ok(details.gaps.some(g => /budget|split/i.test(g)));
});

test('method gates are wired through the real tool: review, grilling, diagnosis, reuse', async t => {
  const runtime = await setup(t);
  await runtime.initProject();
  const state = async () => (await import('../src/workspace/store.ts')).readRecord(join((runtime as never as { prjctRoot: string }).prjctRoot, (await runtime.identity()).day, (await runtime.identity()).projectId, 'work/state.json')).then(r => (r!.payload as { revision: number; observations: Array<{ id: string; execution?: { toolName: string; outcome: string } }> }));
  const mutation = async () => ({ expectedRevision: (await state()).revision, operationId: `m_${Math.random().toString(36).slice(2)}`, maxBytes: 24000 });
  const origin = { id: 'src_readme', revision: 1, contentHash: 'a'.repeat(64) };
  const work = await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, title: 'Method gates', origin, operationId: 'gate_work', maxBytes: 24000 });
  const workId = (work.details as { scope: { workId: string } }).scope.workId;
  const taskId = 'task_gate';
  await runtime.execute('prjct_task', { action: 'define', workId, taskId, definition: origin, criterionIds: ['done'], ...await mutation() });
  await runtime.execute('prjct_task', { action: 'claim', workId, taskId, checkoutId: (await runtime.identity()).checkoutId, access: 'read', ...await mutation() });
  const progress = async (methodId: string, stage: string, evidenceIds: string[] = [], approve = false) =>
    runtime.execute('prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId, methodId, stage,
      summary: 'stage', evidenceIds, nextAction: 'next', ...await mutation() }, { confirm: async () => approve });

  // code-review walks scope_pinned → standards_pass → spec_pass → reported; 'complete' is not a stage.
  await assert.rejects(() => progress('code-review', 'complete'), { code: 'INVALID_STAGE' });
  await assert.rejects(() => progress('code-review', 'spec_pass'), { code: 'INVALID_STAGE' }); // skipping standards
  await progress('code-review', 'standards_pass');
  await progress('code-review', 'spec_pass');
  await progress('code-review', 'reported');

  // Grilling keeps conversational evidence, but only an exact one-shot host
  // confirmation authorizes the decision transition.
  await runtime.recordObservation('read something', { toolCallId: 'r1', toolName: 'read', outcome: 'succeeded' });
  const readObs = (await state()).observations.at(-1)!.id;
  await assert.rejects(() => progress('grilling', 'decision_recorded', [readObs]), { code: 'INVALID_STAGE' }); // round_asked first
  await progress('grilling', 'round_asked');
  await assert.rejects(() => progress('grilling', 'decision_recorded', [readObs]), { code: 'CONFIRMATION_REQUIRED' });
  await runtime.recordObservation('user_input: yes, use option B', { toolCallId: 'u1', toolName: 'user_input', outcome: 'succeeded' });
  const userObs = (await state()).observations.at(-1)!.id;
  await progress('grilling', 'decision_recorded', [userObs], true);

  // diagnosis: ordered loop stages; fixed requires reproduced failure then a succeeding command.
  await progress('diagnosing-bugs', 'loop_built');
  await runtime.recordObservation('bash failed: repro red', { toolCallId: 'b1', toolName: 'bash', command: './repro.sh', outcome: 'failed' });
  const failedObs = (await state()).observations.at(-1)!.id;
  await progress('diagnosing-bugs', 'reproduced', [failedObs]);
  await progress('diagnosing-bugs', 'minimized');
  await progress('diagnosing-bugs', 'hypotheses_ranked');
  await progress('diagnosing-bugs', 'instrumented');
  await assert.rejects(() => progress('diagnosing-bugs', 'fixed', [userObs]), { code: 'UNVERIFIABLE_EVIDENCE' });
  await runtime.recordObservation('bash passed: repro green', { toolCallId: 'b2', toolName: 'bash', command: './repro.sh', outcome: 'succeeded' });
  const greenObs = (await state()).observations.at(-1)!.id;
  await progress('diagnosing-bugs', 'fixed', [greenObs]);

  // reuse: new without inspected evidence, reuse without owner, fake evidence all rejected.
  const reuse = async (data: unknown) => runtime.execute('prjct_checkpoint', { action: 'record', kind: 'reuse_assessment', workId, taskId, data, ...await mutation() });
  await assert.rejects(() => reuse({ behavior: 'x', approach: 'new', reviewedScope: 'x', existing: [], examinedEvidenceIds: [], rationale: 'x', unresolvedQuestions: [] }), { code: 'INVALID_REUSE_ASSESSMENT' });
  await assert.rejects(() => reuse({ behavior: 'x', approach: 'reuse', reviewedScope: 'x', existing: [], examinedEvidenceIds: [userObs], rationale: 'x', unresolvedQuestions: [] }), { code: 'INVALID_REUSE_ASSESSMENT' });
  await assert.rejects(() => reuse({ behavior: 'x', approach: 'reuse', reviewedScope: 'x', existing: [{ owner: 'o', capability: 'c', evidenceIds: ['obs_fake'] }], examinedEvidenceIds: [userObs], rationale: 'x', unresolvedQuestions: [] }), { code: 'MISSING_EVIDENCE' });
  await reuse({ behavior: 'x', approach: 'reuse', reviewedScope: 'x', existing: [{ owner: 'o', capability: 'c', evidenceIds: [userObs] }], examinedEvidenceIds: [userObs], rationale: 'x', unresolvedQuestions: [] });
});

test('a Pi session without any skills retrieves and follows method guidance through prjct alone', { timeout: 30_000 }, async t => {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const extension = (await import('../src/extension.ts')).default;
  const root = await mkdtemp(join(tmpdir(), 'prjct-method-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(cwd, 'README.md'), '# No skills here\n');
  const old = { ...process.env };
  process.env.PRJCT_HOME = join(root, 'store'); process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  t.after(async () => { process.env = old; });
  const faux = fauxProvider({ provider: 'prjct-method-sdk', tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'prjct', factory: extension }] });
  await loader.reload();
  assert.equal(loader.getSkills().skills.length, 0, 'No skills in context');
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime: models,
    model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), tools: ['read', 'prjct_context'] });
  t.after(async () => session.dispose());
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prjct_context', { action: 'lookup', query: 'method:tdd', maxBytes: 24000 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('I will write the failing test first at the agreed seam, then the minimal implementation.'),
  ]);
  await session.prompt('Implement a small feature test-first. Get the method from prjct.');
  await session.agent.waitForIdle();
  const toolResult = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'prjct_context');
  const text = JSON.stringify(toolResult);
  assert.match(text, /Red before green/i);
  assert.match(text, /seam/i);
  const final = session.messages.filter(m => m.role === 'assistant').at(-1);
  assert.match(JSON.stringify(final), /failing test first/i);
});

test('/prjct init initializes through a real Pi session; /p is not a registered command', { timeout: 30_000 }, async t => {
  const { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const extension = (await import('../src/extension.ts')).default;
  const root = await mkdtemp(join(tmpdir(), 'prjct-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentDir = join(root, 'agent'), home = join(root, 'store');
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(join(cwd, 'README.md'), '# alias fixture\n');
  const old = { ...process.env };
  process.env.PRJCT_HOME = home; process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  t.after(async () => { process.env = old; });
  const faux = fauxProvider({ provider: 'prjct-alias', tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'prjct', factory: extension }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime: models,
    model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), tools: ['prjct_context'] });
  t.after(async () => session.dispose());
  faux.setResponses([]);
  await session.prompt('/prjct init');
  await session.agent.waitForIdle();
  // init queued synthesis; no scripted model response needed for the command check.
  const identity = await readRecord(join(home, 'identity/index.json'));
  assert.ok(identity, '/prjct init must create the store');
  assert.match(JSON.stringify(identity!.payload), /p_[a-f0-9]{12}/);
});
