import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

test('context uses native Pi argument validation and normalization without a parallel parser', { timeout: 15_000 }, async (t) => {
  const scratch = new URL('../.test-data/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(fileURLToPath(new URL('sdk-', scratch)));
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  // node:test runs this file in its own child process. Do not inherit real auth,
  // config paths or environment-based provider keys into the SDK fixture.
  process.env = { PATH: process.env.PATH ?? '', HOME: root, PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1', TERM: 'dumb', LANG: 'C.UTF-8' };
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });

  const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } =
    await import('@earendil-works/pi-ai');
  const { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } =
    await import('@earendil-works/pi-coding-agent');
  const { ContextToolContract } = await import('../src/pi/context-tool-contract.ts');
  const faux = fauxProvider({ provider: 'prjct-contract-test', tokensPerSecond: 1_000_000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prjct_context', { action: 'lookup', query: 'Existing refresh owner', maxBytes: '1024' }),
      { stopReason: 'toolUse' }),
    fauxAssistantMessage('Scripted offline completion.'),
  ]);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  let executions = 0;
  const context = defineTool({ ...ContextToolContract, execute: async (_id, params) => {
    assert.equal(params.maxBytes, 1024);
    executions++;
    // Contract fixture only: not a replacement for the unimplemented knowledge owner.
    return { content: [{ type: 'text', text: 'Fixture executor reached.' }], details: {} };
  } });
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime,
    model: faux.getModel(), sessionManager: SessionManager.inMemory(root), tools: ['read', 'prjct_context'], customTools: [context] }));
  const toolResults: Array<{ isError: boolean; text: string }> = [];
  session.subscribe((event) => {
    if (event.type === 'tool_execution_end') toolResults.push({ isError: event.isError, text: JSON.stringify(event.result) });
  });
  await session.prompt('Run the scripted contract probe, without native filesystem tools.');
  assert.equal(faux.state.callCount, 2, 'the real session must consume both scripted model responses');
  assert.equal(executions, 1, 'native-valid arguments must reach execution');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0]?.isError, false);
  assert.match(toolResults[0]?.text ?? '', /Fixture executor reached/);

  await t.test('Pi blocks undeclared authority, forwarding and out-of-budget inputs before execution', async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('prjct_context', { action: 'lookup', query: 'refresh', maxBytes: 1024, approved: true }),
        fauxToolCall('prjct_context', { action: 'discover', query: 'refresh', maxBytes: 1024, tool: 'bash', arguments: {} }),
        fauxToolCall('prjct_context', { action: 'lookup', query: 'refresh', maxBytes: 51201 }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Scripted invalid-input completion.'),
    ]);
    await session!.prompt('Run the scripted invalid-input probes.');
    assert.equal(executions, 1, 'none of the rejected calls may reach the executor');
    assert.equal(toolResults.length, 4);
    assert.deepEqual(toolResults.slice(1).map(result => result.isError), [true, true, true]);
  });

  await t.test('the existing Pi read tool reads an owner fixture without a prjct file-tool replacement', async () => {
    // Synthetic data, not the user's website. The point is native tool reuse,
    // not a claim that this scripted provider understands the project.
    await writeFile(join(root, 'existing-refresh.txt'), 'GlobalRefreshProvider owns triggerRefresh.\n');
    const systemPrompt = session!.agent.state.systemPrompt;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path: 'existing-refresh.txt' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Scripted native read completion.'),
    ]);
    await session!.prompt('Inspect the existing refresh owner with the native read tool.');
    assert.equal(toolResults.at(-1)?.isError, false);
    assert.match(toolResults.at(-1)?.text ?? '', /GlobalRefreshProvider owns triggerRefresh/);
    assert.equal(executions, 1, 'native reads must not route through prjct');
    assert.equal(session!.agent.state.systemPrompt, systemPrompt, 'reading must not add project knowledge to the system prompt');
  });
});
