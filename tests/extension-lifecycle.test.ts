import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { tmpdir } from './test-paths.ts';
import extension from '../src/extension.ts';

const host = () => {
  const handlers = new Map<string, Array<(event: never, ctx: never) => Promise<unknown> | unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  const entries: Array<{ type: string; data: unknown }> = [];
  let active: string[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) => commands.set(name, options),
    on: (name: string, handler: (event: never, ctx: never) => Promise<unknown> | unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    sendMessage: () => undefined,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, entries };
};

test('native lifecycle hooks emit one bounded re-anchor per invalidation and persist context-only pointers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-extension-lifecycle-'));
  const cwd = join(root, 'checkout');
  const agentHome = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentHome); await writeFile(join(cwd, 'README.md'), '# Lifecycle\n');
  const previous = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentHome; process.env.PRJCT_HOME = join(root, 'store');
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  const stub = host(); extension(stub.pi);
  const notices: string[] = [];
  const ctx = { cwd, hasUI: false, mode: 'print', signal: undefined, model: undefined,
    sessionManager: { getSessionId: () => 'session_lifecycle', getBranch: () => [] },
    ui: { notify: (text: string) => notices.push(text), setStatus: () => undefined, confirm: async () => false } } as never;
  await stub.commands.get('prjct')!.handler('init', ctx);
  await stub.commands.get('prjct')!.handler('work Lifecycle integrity', ctx);

  const call = async (name: string, event: unknown = {}) => {
    const handler = stub.handlers.get(name)?.[0];
    assert.ok(handler, `${name} handler is registered`);
    return handler!(event as never, ctx);
  };
  const blockedWrite = await call('tool_call', { toolCallId: 'native_write', toolName: 'write', input: { path: 'README.md', content: 'changed' } }) as { block?: boolean; reason?: string };
  assert.equal(blockedWrite.block, true); assert.match(blockedWrite.reason ?? '', /write.*task|task grant/i);

  await call('session_start', { reason: 'resume', previousSessionFile: '/old/session.jsonl' });
  const first = await call('before_agent_start', { prompt: 'continue' }) as { message?: { content?: string } } | undefined;
  assert.match(first?.message?.content ?? '', /stale re-anchor after resume/);
  assert.match(first?.message?.content ?? '', /No task or writer grant was restored/);
  assert.ok(Buffer.byteLength(first?.message?.content ?? '', 'utf8') <= 2048);
  assert.equal(await call('before_agent_start', { prompt: 'warm' }), undefined, 'warm turns inject no bytes');

  await call('agent_settled');
  assert.ok(stub.entries.some(entry => entry.type === 'prjct_binding' && (entry.data as { workId?: string }).workId));
  await call('session_compact', { reason: 'manual', willRetry: false });
  const compact = await call('before_agent_start', { prompt: 'after compact' }) as { message?: { content?: string } } | undefined;
  assert.match(compact?.message?.content ?? '', /after compact/);
  assert.equal(await call('before_agent_start', { prompt: 'warm again' }), undefined);
  await call('session_shutdown', { reason: 'quit' });
});
