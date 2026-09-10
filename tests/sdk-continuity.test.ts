import { processToolNames } from '../src/pi/register-tools.ts';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from './test-paths.ts';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import extension from '../src/extension.ts';
import { readRecord } from '../src/workspace/store.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';

// Only the model is scripted. Native read/bash, command dispatch, deferred tool
// activation, observation hooks and separate Pi sessions execute for real.
test('Pi init connects and indexes headlessly, analyze synthesizes supported context, native execution is recorded, and a new session recovers it', { timeout: 45_000 }, async t => {
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
  const managers: SessionManager[] = [];
  t.after(async () => { sessions.forEach(s => s.dispose()); process.env = oldEnv; await rm(root, { recursive: true, force: true }); });
  const faux = fauxProvider({ provider: 'prjct-sdk-continuity', tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  async function session() {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: 'prjct', factory: extension }] });
    await loader.reload();
    const sessionManager = SessionManager.inMemory(cwd); managers.push(sessionManager);
    const result = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime: models, model: faux.getModel(), sessionManager, tools: ['read', 'edit', 'write', 'bash', ...processToolNames] });
    sessions.push(result.session); return result.session;
  }
  const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  const first = await session();
  const errors: string[] = [];
  first.subscribe(e => { if (e.type === 'tool_execution_end' && e.isError) errors.push(JSON.stringify(e.result)); });
  // sync before init must not create the store.
  await first.prompt('/prjct sync'); await first.agent.waitForIdle();
  assert.deepEqual(await readdir(home).catch(() => []), []);
  // init connects and runs the mechanical services without any model call.
  const callsBeforeInit = faux.state.callCount;
  await first.prompt('/prjct init'); await first.agent.waitForIdle();
  assert.deepEqual(errors, []);
  assert.equal(faux.state.callCount, callsBeforeInit, 'init must not drive the model');
  const bound = (await readRecord(join(home, 'identity/index.json')))!.payload as { bindings: Array<{ day: string; projectId: string }> };
  assert.ok(await readRecord(join(home, bound.bindings[0]!.day, bound.bindings[0]!.projectId, 'representation/manifest.json')), 'headless init finishes the index before returning');
  // analyze runs purpose/patterns in a child Pi (a fixture stand-in here), never in this session.
  process.env.PRJCT_PI_COMMAND = `${process.execPath} ${fileURLToPath(new URL('./fake-pi.mjs', import.meta.url))}`;
  const callsBeforeAnalyze = faux.state.callCount;
  await first.prompt('/prjct analyze'); await first.agent.waitForIdle();
  assert.equal(faux.state.callCount, callsBeforeAnalyze, 'analyze must not prompt the session model');
  assert.deepEqual(errors, []);
  // Command follow-up is owned by Pi; settle pending continuation, not a custom loop.
  assert.deepEqual(errors, []);
  assert.equal(faux.getPendingResponseCount(), 0, JSON.stringify(first.messages).slice(-6000));
  const index = (await readRecord(join(home, 'identity/index.json')))!.payload as { bindings: Array<{ day: string; projectId: string }> };
  const b = index.bindings[0]!;
  const statePath = join(home, b.day, b.projectId, 'work/state.json');
  const observer = new ProcessRuntime({ cwd, agentHome: agentDir, prjctHome: home, sessionId: 'test_observer' });
  const state = async () => ({
    ...((await readRecord(statePath))!.payload as { claims: Array<{ standing: string }> }),
    observations: [...await observer.readObservations()],
  });
  assert.match((await readRecord(join(home, b.day, b.projectId, 'knowledge/context/purpose.json')))?.payload ? JSON.stringify((await readRecord(join(home, b.day, b.projectId, 'knowledge/context/purpose.json')))!.payload) : '', /# Purpose/);
  await first.prompt('/prjct work repair scheduling');
  faux.setResponses([
    tool('edit', { path: 'README.md', edits: [{ oldText: '# Harbor', newText: '# Mutated' }] }),
    fauxAssistantMessage('The managed edit was denied.'),
  ]);
  await first.prompt('Try to edit without a claimed task.');
  faux.setResponses([
    tool('write', { path: 'forbidden.ts', content: 'export const forbidden = true;\n' }),
    fauxAssistantMessage('The managed write was denied.'),
  ]);
  await first.prompt('Try to write without a claimed task.');
  assert.equal(errors.filter(error => /TASK_GRANT_REQUIRED/.test(error)).length, 2, errors.join('\n'));
  assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), readme);
  assert.equal(await readFile(join(cwd, 'forbidden.ts'), 'utf8').catch(() => undefined), undefined);
  errors.length = 0;
  faux.setResponses([
    tool('bash', { command: 'node --test check.test.mjs' }),
    ...Array.from({ length: 6 }, () => tool('bash', { command: 'printf unrelated' })),
    fauxAssistantMessage('Native verification and unrelated commands completed.'),
  ]);
  await first.prompt('Run the fixture checks.');
  assert.deepEqual(errors, []);
  const observation = (await state()).observations.find(o => o.execution?.command === 'node --test check.test.mjs');
  assert.equal(observation?.provenance, 'native_observation'); assert.equal(observation?.verification, true);
  assert.equal(observation?.execution?.outcome, 'succeeded'); assert.ok(observation?.execution?.toolCallId);
  assert.equal(observation?.execution?.coverage, 'partial', 'bash never claims full filesystem/sandbox coverage');
  assert.ok(observation?.attemptId && observation?.sessionId && observation?.checkoutId, 'evidence is bound to host lifecycle identity');
  const beforeCount = faux.state.callCount;
  await first.prompt('/prjct sync'); await first.agent.waitForIdle();
  assert.equal(faux.state.callCount, beforeCount, 'Current supported knowledge does not require redundant synthesis');
  const second = await session();
  faux.setResponses([tool('prjct_context', { action: 'lookup', query: 'purpose and active work', maxBytes: 24000 }), fauxAssistantMessage('Recovered without the first session transcript.')]);
  await second.prompt('Continue the existing work without another project explanation.');
  const response = second.messages.find(m => m.role === 'toolResult' && m.toolName === 'prjct_context');
  assert.match(JSON.stringify(response), /Fixture purpose brief/); assert.match(JSON.stringify(response), /repair scheduling/);
  assert.ok(managers.at(-1)!.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'prjct_binding'),
    'the active branch persists a context-only binding pointer');
  assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), readme);
  assert.deepEqual((await readdir(cwd)).sort(), ['README.md', 'check.test.mjs', 'package.json']);
});
