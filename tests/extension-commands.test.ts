import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import prjctExtension from '../src/extension.ts';
import { SERVICE_ORDER } from '../src/jobs/services.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { fileURLToPath } from 'node:url';
import { tmpdir } from './test-paths.ts';

// A stub host: enough of ExtensionAPI and the command context for /prjct to run
// headless. The real Pi session path is covered by extension-session.test.ts.
const stubHost = () => {
  type CommandOptions = {
    handler: (args: string, ctx: unknown) => Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  };
  const commands = new Map<string, CommandOptions>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const sent: Array<{ text: string; options: unknown }> = [];
  const messages: Array<{ message: Record<string, unknown>; options: unknown }> = [];
  const entries: unknown[] = [];
  let active: string[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, options: CommandOptions) => commands.set(name, options),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendUserMessage: (text: string, options: unknown) => sent.push({ text, options }),
    sendMessage: async (message: Record<string, unknown>, options: unknown) => { messages.push({ message, options }); },
    appendEntry: (_type: string, data: unknown) => entries.push(data),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers, sent, messages, entries };
};

const stubCtx = (cwd: string, notices: string[]) => ({
  cwd, hasUI: false, signal: undefined, model: { provider: 'faux', id: 'brief-model' },
  sessionManager: { getSessionId: () => 'cmd_session', getBranch: () => [] },
  ui: { notify: (text: string) => notices.push(text), setStatus: () => undefined, confirm: async () => true },
});

test('headless commands keep the user informed: every command and job lifecycle event reaches stderr', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-headless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentHome);
  await writeFile(join(cwd, 'README.md'), '# Client\n');
  const previousEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentHome;
  process.env.PRJCT_HOME = join(root, 'store');
  process.env.PRJCT_PI_COMMAND = `${process.execPath} ${fileURLToPath(new URL('./fake-pi.mjs', import.meta.url))}`;
  t.after(() => { process.env = previousEnv; });

  const host = stubHost();
  prjctExtension(host.pi);
  const notices: string[] = [];
  const ctx = { ...stubCtx(cwd, notices), mode: 'print' as const };
  const run = (args: string) => host.commands.get('prjct')!.handler(args, ctx);

  const errLines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { errLines.push(values.map(String).join(' ')); };
  t.after(() => { console.error = originalConsoleError; });
  const errText = () => errLines.join('\n');

  await run('status');
  assert.match(errLines.at(-1) ?? '', /No bound project\. Run \/prjct init first\./);
  assert.equal(notices.length, 0, 'headless mode never calls the no-op UI');

  await run('init');
  assert.match(errText(), /Project initialized\. Connected project p_[0-9a-f]+ .*Queued: index, stack, history\./);
  assert.match(errText(), /prjct index…/);
  assert.match(errText(), /prjct index done \([\d.]+s\):/);
  assert.match(errText(), /prjct: 3 service\(s\) finished: index, stack, history\. \/prjct status/);

  await run('status');
  assert.match(errLines.at(-1) ?? '', /index\s+done/);

  // Re-init after an edit refreshes only what changed; it never re-creates.
  await writeFile(join(cwd, 'NOTES.md'), '# Notes\n');
  await run('init');
  assert.match(errText(), /Project already initialized\. Reconnected project p_[0-9a-f]+ .*Refreshing out-of-date services: index, stack\. \/prjct status follows progress\./);
  assert.match(errText(), /prjct: 2 service\(s\) finished: index, stack\. \/prjct status/);

  // A failing service is reported where the user can see it, not only appended.
  process.env.FAKE_PI_MODE = 'fail';
  await run('analyze');
  assert.match(errText(), /prjct purpose failed: child pi exited 3/);
  assert.match(errText(), /prjct patterns failed: child pi exited 3/);
  delete process.env.FAKE_PI_MODE;

  await run('run nope');
  assert.match(errLines.at(-1) ?? '', /Unknown service "nope"/);
  await run('export');
  assert.match(errLines.at(-1) ?? '', /^Usage: \/prjct export <path>/);
  await run('work');
  assert.match(errLines.at(-1) ?? '', /No work yet\. \/prjct work "title" starts a cycle\./);
  await run('ship');
  assert.ok((errLines.at(-1) ?? '').length > 0, 'ship always answers');
  await run('bogus');
  assert.match(errLines.at(-1) ?? '', /^Usage:/);
  assert.equal(notices.length, 0, 'no headless feedback was lost to the no-op UI');

  for (const handler of host.handlers.get('session_shutdown') ?? []) await handler({}, ctx);
});

test('/prjct init connects and runs services without prompting the model; status, run and analyze behave', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-cmd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentHome);
  await writeFile(join(cwd, 'README.md'), '# Client\n');
  await writeFile(join(cwd, 'index.ts'), 'export const x = 1;\n');
  const previousEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentHome;
  process.env.PRJCT_HOME = join(root, 'store');
  process.env.PRJCT_PI_COMMAND = `${process.execPath} ${fileURLToPath(new URL('./fake-pi.mjs', import.meta.url))}`;
  t.after(() => { process.env = previousEnv; });

  const host = stubHost();
  prjctExtension(host.pi);
  assert.deepEqual([...host.commands.keys()], ['prjct'], 'only /prjct is registered; the /p alias is gone');
  const notices: string[] = [];
  const ctx = stubCtx(cwd, notices);
  const run = (args: string) => host.commands.get('prjct')!.handler(args, ctx);

  await run('status');
  assert.match(notices.at(-1) ?? '', /No bound project/);

  await run('init');
  assert.match(notices.at(-1) ?? '', /Project initialized\. Connected project p_[0-9a-f]+ .*2 indexable files\. Queued: index, stack, history\./);
  assert.equal(host.sent.length, 0, 'init must not drive the model');
  assert.equal(host.entries.filter(entry => (entry as { status: string }).status === 'done').length, 3);
  assert.deepEqual((await readdir(cwd)).sort(), ['README.md', 'index.ts']);

  const headlessOutput: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => { headlessOutput.push(values.map(String).join(' ')); };
  const headlessCtx = ctx as typeof ctx & { mode?: string };
  headlessCtx.mode = 'print';
  try { await run('init'); } finally { delete headlessCtx.mode; console.error = originalConsoleError; }
  assert.match(headlessOutput.at(-1) ?? '', /Project already initialized\. Reconnected project p_[0-9a-f]+ .*All services are current\./);

  await run('status');
  const status = notices.at(-1) ?? '';
  assert.match(status, /index\s+done/);
  assert.match(status, /stack\s+done/);
  assert.match(status, /history\s+done/);
  assert.match(status, /Understanding: not synthesized yet/);

  await run('sync');
  assert.match(notices.at(-1) ?? '', /All services are current/);

  await run('run stack');
  assert.match(notices.at(-1) ?? '', /Queued: stack/);
  await run('run nope');
  assert.match(notices.at(-1) ?? '', /Unknown service "nope"/);

  // The runner was created by init with brief-model. A later model switch must
  // apply to newly queued analysis jobs instead of reusing that cached choice.
  ctx.model = { provider: 'faux', id: 'replacement-model' };
  await run('analyze');
  assert.match(notices.at(-1) ?? '', /Queued: purpose, patterns \(child Pi, faux\/replacement-model, thinking low\)/);
  assert.equal(host.sent.length, 0, 'the session model is never prompted');
  assert.equal(host.messages.length, 2, 'one next-turn line per finished brief');
  assert.match(String(host.messages[0]?.message.content ?? ''), /purpose brief is ready/);
  assert.deepEqual(host.messages[0]?.options, { deliverAs: 'nextTurn' });
  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome: join(root, 'store') });
  const purpose = await runtime.readContextDoc('purpose');
  assert.match(purpose?.text ?? '', /^# Purpose\n/);
  assert.match(purpose?.text ?? '', /tools: read,prjct_context,prjct_search,prjct_knowledge/);
  assert.match(purpose?.text ?? '', /model: faux\/replacement-model/);
  assert.match(purpose?.text ?? '', /extension: loaded; no-extensions: true/);
  assert.equal(purpose?.text.includes('preamble'), false, 'only the brief is kept');
  assert.equal(purpose?.freshness.model, 'faux/replacement-model');
  assert.match((await runtime.readContextDoc('patterns'))?.text ?? '', /^# Patterns\n/);
  await run('status');
  assert.match(notices.at(-1) ?? '', /purpose\s+done\s+[\d.]+s\s+2 turns, 1 tool calls/);
  assert.match(notices.at(-1) ?? '', /Understanding: briefs purpose, patterns/);
  const lookup = await runtime.execute('prjct_context', { action: 'lookup', query: 'purpose and design patterns', maxBytes: 24000 });
  const kinds = (lookup.details as { items: Array<{ kind: string }> }).items.map(item => item.kind);
  assert.ok(kinds.includes('purpose') && kinds.includes('design'), kinds.join(','));
  // A failing child leaves an honest failed row and no brief.
  process.env.FAKE_PI_MODE = 'fail';
  await run('run purpose');
  await run('status');
  assert.match(notices.at(-1) ?? '', /purpose\s+failed\s+[\d.]+s\s+child pi exited 3 without a brief \(fixture provider failure\)/);
  delete process.env.FAKE_PI_MODE;

  // Export is explicit, checkout-contained, and fails closed without a UI.
  await run('export');
  assert.match(notices.at(-1) ?? '', /^Usage: \/prjct export <path>/);
  await run('export prjct-briefs.md');
  assert.match(notices.at(-1) ?? '', /current host confirmation is required/);
  const runInteractive = (args: string) => host.commands.get('prjct')!.handler(args, { ...ctx, hasUI: true, mode: 'tui' });
  await runInteractive('export ../escape.md');
  assert.match(notices.at(-1) ?? '', /Export refused: Mutation path escapes/);
  await runInteractive('export prjct-briefs.md');
  assert.match(notices.at(-1) ?? '', /Exported purpose, stack, patterns, history to .*prjct-briefs\.md/);
  const { readFile: readExport } = await import('node:fs/promises');
  const exported = await readExport(join(cwd, 'prjct-briefs.md'), 'utf8');
  assert.match(exported, /^<!-- Generated by prjct for p_[0-9a-f]+ .*Briefs: purpose, stack, patterns, history\. -->\n\n# Purpose\n/);
  assert.match(exported, /\n# Stack\n[\s\S]*\n# Patterns\n[\s\S]*\n# History\n/);
  await runInteractive('export prjct-briefs.md');
  assert.match(notices.at(-1) ?? '', /exists; add --force to overwrite/);
  await runInteractive('export prjct-briefs.md --force');
  assert.match(notices.at(-1) ?? '', /^Exported/);
  assert.deepEqual((await readdir(cwd)).sort(), ['README.md', 'index.ts', 'prjct-briefs.md']);

  await run('bogus');
  assert.match(notices.at(-1) ?? '', /^Usage:/);
  for (const handler of host.handlers.get('session_shutdown') ?? []) await handler({}, ctx);
});

test('/prjct offers argument completions for subcommands and run services', async t => {
  const host = stubHost();
  prjctExtension(host.pi);
  const complete = host.commands.get('prjct')!.getArgumentCompletions!;
  const values = (prefix: string) => (complete(prefix) ?? []).map(item => item.value);
  t.after(async () => { for (const handler of host.handlers.get('session_shutdown') ?? []) await handler({}, undefined); });

  assert.deepEqual(values(''), ['init', 'sync', 'status', 'run', 'analyze', 'export', 'work', 'ship']);
  assert.deepEqual(values('st'), ['status']);
  assert.deepEqual(values('run '), SERVICE_ORDER.map(id => `run ${id}`));
  assert.deepEqual(values('run p'), ['run purpose', 'run patterns']);
  assert.deepEqual(values('work '), []);
  assert.equal(complete('work '), null, 'no suggestions where the command takes free text');
});

test('TUI action results request concise English agent-facing output; headless never triggers a turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-summaries-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentHome);
  await writeFile(join(cwd, 'README.md'), '# Client\n');
  const previousEnv = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = agentHome;
  process.env.PRJCT_HOME = join(root, 'store');
  t.after(() => { process.env = previousEnv; });

  const host = stubHost();
  prjctExtension(host.pi);
  const notices: string[] = [];
  const tui = { ...stubCtx(cwd, notices), hasUI: true, mode: 'tui' as const };
  const run = (args: string) => host.commands.get('prjct')!.handler(args, tui);
  const waitFor = async (cond: () => boolean, ms = 10_000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting for the model handoff');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  // Synchronous outcome (error): immediate handoff with a followUp turn trigger.
  await run('status');
  assert.equal(host.messages.length, 1);
  const first = host.messages[0]!;
  assert.deepEqual(first.options, { deliverAs: 'followUp', triggerTurn: true });
  assert.match(String(first.message.content), /Write prjct output in English for coding agents/);
  assert.match(String(first.message.content), /operational receipt/);
  assert.doesNotMatch(String(first.message.content), /Explain it to the user|same language/i);
  assert.match(String(first.message.content), /No bound project/);
  assert.equal(first.message.display, false, 'raw machine text stays out of the transcript');

  // Queued work ack does not hand off; the runner idle summary does.
  await run('init');
  assert.equal(host.messages.length, 1, 'queued ack is a plain notification');
  await waitFor(() => host.messages.length === 2);
  const idle = host.messages[1]!;
  assert.match(String(idle.message.content), /prjct services finished/);
  assert.match(String(idle.message.content), /index \([\d.]+s\):/);

  // A later synchronous status hands off again.
  await run('status');
  assert.equal(host.messages.length, 3);
  assert.match(String(host.messages[2]!.message.content), /Services:/);

  // Headless mode: same command, no model handoff at all.
  const headlessCtx = { ...stubCtx(cwd, notices), mode: 'print' as const };
  await host.commands.get('prjct')!.handler('status', headlessCtx);
  assert.equal(host.messages.length, 3, 'headless never triggers a model turn');

  for (const handler of host.handlers.get('session_shutdown') ?? []) await handler({}, tui);
});
