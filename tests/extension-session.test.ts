import { sha256 } from '../src/workspace/ids.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import prjctExtension from '../src/extension.ts';

test('the extension can create work through native Pi without writing client sources', { timeout: 20_000 }, async (t) => {
  const scratch = new URL('../.test-data/', import.meta.url);
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(fileURLToPath(new URL('ext-', scratch)));
  const agentDir = join(root, 'agent');
  const checkout = join(root, 'checkout');
  await mkdir(agentDir);
  await mkdir(checkout);
  await writeFile(join(checkout, 'README.md'), '# client\n');
  process.env = { PATH: process.env.PATH ?? '', HOME: root, PI_CODING_AGENT_DIR: agentDir, PRJCT_HOME: join(root, 'prjct'),
    PI_OFFLINE: '1', TERM: 'dumb', LANG: 'C.UTF-8' };
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });

  const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } =
    await import('@earendil-works/pi-ai');
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await import('@earendil-works/pi-coding-agent');
  const faux = fauxProvider({ provider: 'prjct-extension-test', tokensPerSecond: 1_000_000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prjct_work', { action: 'create', projectId: `p_${sha256(checkout).slice(0, 12)}`, operationId: 'operation_a',
      title: 'Reuse existing refresh', origin: { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) }, maxBytes: 2048 }),
      { stopReason: 'toolUse' }),
    fauxAssistantMessage('Scripted offline completion.'),
  ]);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: checkout, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'prjct', factory: prjctExtension }] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: checkout, agentDir, resourceLoader, settingsManager, modelRuntime,
    model: faux.getModel(), sessionManager: SessionManager.inMemory(checkout),
    tools: ['prjct_work'] }));
  // Explicit init is the only path that creates the store.
  const { ProcessRuntime } = await import('../src/pi/process-runtime.ts');
  await new ProcessRuntime({ cwd: checkout, agentHome: agentDir, prjctHome: join(root, 'prjct') }).initProject();
  const results: Array<{ isError: boolean; text: string }> = [];
  session.subscribe((event) => {
    if (event.type === 'tool_execution_end') results.push({ isError: event.isError, text: JSON.stringify(event.result) });
  });
  await session.prompt('Create the scripted work record.');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.isError, false);
  assert.match(results[0]?.text ?? '', /Reuse existing refresh/);
  const client = (await readdir(checkout)).sort();
  assert.deepEqual(client, ['README.md']);
});
