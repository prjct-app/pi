import { processToolNames } from '../src/pi/register-tools.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from './test-paths.ts';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, InMemoryCredentialStore, InMemoryModelsStore, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import extension from '../src/extension.ts';
import { readRecord } from '../src/workspace/store.ts';

// Only the model is scripted. Native read/bash, command dispatch, deferred tool
// activation, observation hooks and separate Pi sessions execute for real.
test('Pi sync synthesizes supported context, records native execution, and a new session recovers it', { timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-sdk-continuity-'));
  const cwd = join(root, 'client'), agentDir = join(root, 'agent'), home = join(root, 'store');
  await mkdir(cwd); await mkdir(agentDir);
  const readme = '# Harbor\nHarbor schedules volunteer transport.\nUse existing route services, not duplicated scheduling logic.\n';
  await writeFile(join(cwd, 'README.md'), readme);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test check.test.mjs' } }));
  await writeFile(join(cwd, 'check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('schedule invariant',()=>assert.equal(2+2,4));\n");
  const oldEnv = { ...process.env };
  process.env.PRJCT_HOME = home; process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  const sessions: AgentSession[] = [];
  t.after(async () => { sessions.forEach(s => s.dispose()); process.env = oldEnv; await rm(root, { recursive: true, force: true }); });
  const faux = fauxProvider({ provider: 'prjct-sdk-continuity', tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  async function session() {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: 'prjct', factory: extension }] });
    await loader.reload();
    const result = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime: models, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), tools: ['read', 'bash', ...processToolNames] });
    sessions.push(result.session); return result.session;
  }
  type Details = { projectId?: string; stateRevision?: number; items?: Array<{ reference?: { id: string; revision: number; contentHash: string }; summary: string; sources: Array<{ id: string; revision: number; contentHash: string }> }> };
  const results = (context: Context, name: string): Details[] => context.messages.flatMap(m => m.role === 'toolResult' && m.toolName === name ? [JSON.parse(m.content.filter(c => c.type === 'text').map(c => c.text).join('')) as Details] : []);
  const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  const synthesis: FauxResponseStep[] = [
    tool('prjct_context', { action: 'discover', query: 'knowledge search', maxBytes: 24000 }),
    tool('read', { path: 'README.md' }),
    tool('prjct_context', { action: 'lookup', query: 'source observations', maxBytes: 24000 }),
    context => {
      const project = results(context, 'prjct_context').find(r => r.projectId)!;
      const brief = results(context, 'prjct_context').at(-1)!;
      const observation = brief.items!.find(i => i.summary.startsWith('observation '))!;
      return tool('prjct_knowledge', { action: 'propose', projectId: project.projectId, operationId: 'sdk_propose', statement: 'Harbor schedules volunteer transport; reuse existing route services.', supports: observation.sources, gaps: [], maxBytes: 24000 });
    },
    tool('prjct_context', { action: 'discover', query: 'knowledge', maxBytes: 24000 }),
    context => {
      const project = results(context, 'prjct_context').at(-1)!;
      const brief = results(context, 'prjct_context').find(r => r.items?.some(i => i.summary.startsWith('observation ')))!;
      const obs = brief.items!.find(i => i.summary.startsWith('observation '))!.summary.split(' ')[1]!.replace(':', '');
      const claim = results(context, 'prjct_knowledge').at(-1)!.items![0]!.reference!;
      return tool('prjct_knowledge', { action: 'resolve', resolution: 'confirm', projectId: project.projectId, claimId: claim.id, rationale: 'Read the actual README.', evidenceIds: [obs], operationId: 'sdk_confirm', expectedRevision: project.stateRevision, maxBytes: 24000 });
    },
    fauxAssistantMessage('Supported source-specific understanding retained.'),
  ];
  const first = await session();
  const errors: string[] = [];
  first.subscribe(e => { if (e.type === 'tool_execution_end' && e.isError) errors.push(JSON.stringify(e.result)); });
  // sync before init must not create the store.
  await first.prompt('/prjct sync'); await first.agent.waitForIdle();
  assert.deepEqual(await readdir(home).catch(() => []), []);
  faux.setResponses([fauxAssistantMessage('Interrupted before synthesis', { stopReason: 'error', errorMessage: 'Fixture provider interruption' })]);
  await first.prompt('/prjct init'); await first.agent.waitForIdle();
  assert.deepEqual(errors, []);
  // init created the store and indexed; the interrupted synthesis stays pending.
  faux.setResponses(synthesis);
  await first.prompt('/prjct sync');
  await first.agent.waitForIdle();
  const pendingAfterSync = faux.getPendingResponseCount();
  assert.ok(pendingAfterSync === 0, `Headless sync should settle Pi's follow-up; pending=${pendingAfterSync}`);
  // Command follow-up is owned by Pi; settle pending continuation, not a custom loop.
  assert.deepEqual(errors, []);
  assert.equal(faux.getPendingResponseCount(), 0, JSON.stringify(first.messages).slice(-6000));
  const index = (await readRecord(join(home, 'identity/index.json')))!.payload as { bindings: Array<{ day: string; projectId: string }> };
  const b = index.bindings[0]!;
  const statePath = join(home, b.day, b.projectId, 'work/state.json');
  const state = () => readRecord(statePath).then(r => r!.payload as { claims: Array<{ standing: string }>; observations: Array<{ id: string; provenance: string; verification: boolean; execution: { command?: string; toolCallId: string; outcome: string } }> });
  assert.equal((await state()).claims[0]?.standing, 'supported');
  await first.prompt('/prjct work repair scheduling');
  faux.setResponses([
    tool('bash', { command: 'node --test check.test.mjs' }),
    ...Array.from({ length: 6 }, () => tool('bash', { command: 'printf unrelated' })),
    fauxAssistantMessage('Native verification and unrelated commands completed.'),
  ]);
  await first.prompt('Run the fixture checks.');
  assert.deepEqual(errors, []);
  const observation = (await state()).observations.find(o => o.execution?.command === 'node --test check.test.mjs');
  assert.equal(observation?.provenance, 'native_observation'); assert.equal(observation?.verification, true);
  assert.equal(observation?.execution.outcome, 'succeeded'); assert.ok(observation?.execution.toolCallId);
  const beforeCount = faux.state.callCount;
  await first.prompt('/prjct sync'); await first.agent.waitForIdle();
  assert.equal(faux.state.callCount, beforeCount, 'Current supported knowledge does not require redundant synthesis');
  const second = await session();
  faux.setResponses([tool('prjct_context', { action: 'lookup', query: 'purpose and active work', maxBytes: 24000 }), fauxAssistantMessage('Recovered without the first session transcript.')]);
  await second.prompt('Continue the existing work without another project explanation.');
  const response = second.messages.find(m => m.role === 'toolResult' && m.toolName === 'prjct_context');
  assert.match(JSON.stringify(response), /volunteer transport/); assert.match(JSON.stringify(response), /repair scheduling/);
  assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), readme);
  assert.deepEqual((await readdir(cwd)).sort(), ['README.md', 'check.test.mjs', 'package.json']);
});
