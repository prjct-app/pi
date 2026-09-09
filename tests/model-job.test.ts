import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractBrief, modelJobArgs, piInvocation, runModelJob } from '../src/jobs/model-job.ts';
import { tmpdir } from './test-paths.ts';

const fakePi = `${process.execPath} ${fileURLToPath(new URL('./fake-pi.mjs', import.meta.url))}`;

test('child pi arguments are bounded: json print mode, only this extension, explicit tools, session model, thinking low', () => {
  const args = modelJobArgs({ cwd: '/x', extensionPath: '/ext/src/extension.ts', prompt: 'do it', tools: ['read', 'prjct_context'], model: 'anthropic/claude-x' });
  assert.deepEqual(args.slice(0, 7), ['--mode', 'json', '-p', '--no-session', '--no-extensions', '-e', '/ext/src/extension.ts']);
  assert.ok(args.includes('--no-skills') && args.includes('--no-context-files'));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'read,prjct_context']);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'anthropic/claude-x']);
  assert.deepEqual(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2), ['--thinking', 'low']);
  assert.equal(args.at(-1), 'do it');
  const previous = process.env.PRJCT_PI_COMMAND;
  process.env.PRJCT_PI_COMMAND = '/opt/tools/node /opt/pi/cli.js';
  try {
    assert.deepEqual(piInvocation(['-p']), { command: '/opt/tools/node', args: ['/opt/pi/cli.js', '-p'] });
  } finally {
    if (previous === undefined) delete process.env.PRJCT_PI_COMMAND; else process.env.PRJCT_PI_COMMAND = previous;
  }
});

test('the runner captures the final assistant text, turns, tool calls and usage, and reports failures honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-model-job-'));
  const previous = { command: process.env.PRJCT_PI_COMMAND, mode: process.env.FAKE_PI_MODE };
  process.env.PRJCT_PI_COMMAND = fakePi;
  try {
    const request = { cwd: root, extensionPath: '/ext.ts', prompt: 'Write the # Purpose brief', tools: ['read'], env: { PRJCT_JOB: 'purpose' }, logPath: join(root, 'jobs', 'purpose.jsonl') };
    const ok = await runModelJob(request);
    const { readFile } = await import('node:fs/promises');
    const logged = (await readFile(join(root, 'jobs', 'purpose.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string });
    assert.deepEqual(logged.map(event => event.type), ['agent_start', 'tool_execution_start', 'tool_execution_end', 'message_end', 'message_end', 'agent_end']);
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.turns, 2);
    assert.equal(ok.toolCalls, 1);
    assert.deepEqual(ok.usage, { input: 300, output: 65, cost: 0.003 });
    assert.match(ok.text, /# Purpose\n\nFixture purpose brief for purpose\./);
    assert.match(ok.text, new RegExp(`cwd: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    process.env.FAKE_PI_MODE = 'fail';
    const failed = await runModelJob(request);
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.text, '');
    assert.match(failed.stderr, /fixture provider failure/);

    process.env.FAKE_PI_MODE = 'empty';
    const empty = await runModelJob(request);
    assert.equal(empty.exitCode, 0);
    assert.equal(empty.text, '');
  } finally {
    if (previous.command === undefined) delete process.env.PRJCT_PI_COMMAND; else process.env.PRJCT_PI_COMMAND = previous.command;
    if (previous.mode === undefined) delete process.env.FAKE_PI_MODE; else process.env.FAKE_PI_MODE = previous.mode;
    await rm(root, { recursive: true, force: true });
  }
});

test('extractBrief keeps only the headed brief and enforces the byte budget', () => {
  assert.equal(extractBrief('chatter\n\n# Purpose\n\nOne.\n- a\n- b\n', 'Purpose', 4096), '# Purpose\n\nOne.\n- a\n- b\n');
  assert.equal(extractBrief('   ', 'Purpose', 4096), '');
  assert.equal(extractBrief('No heading at all.', 'Patterns', 4096), '# Patterns\n\nNo heading at all.\n');
  const long = `# Purpose\n\n${Array.from({ length: 200 }, (_, i) => `- point ${i} ${'x'.repeat(40)}`).join('\n')}\n`;
  const bounded = extractBrief(long, 'Purpose', 1024);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 1024);
  assert.match(bounded, /^# Purpose\n/);
  assert.match(bounded, /\n$/);
});
