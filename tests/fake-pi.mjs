#!/usr/bin/env node
// Stand-in for a child `pi --mode json -p` process. Emits the JSON events the
// model-job runner consumes and records the arguments it was launched with,
// so tests can assert the child is bounded (tools, extension, model) without
// a real model. FAKE_PI_MODE=fail exits non-zero; =empty answers nothing.
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? '';
const heading = /# Patterns/.test(prompt) ? 'Patterns' : /# Purpose/.test(prompt) ? 'Purpose' : 'Brief';
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const mode = process.env.FAKE_PI_MODE ?? 'ok';
emit({ type: 'agent_start' });
emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'prjct_context', args: { action: 'lookup' } });
emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'prjct_context', isError: false, result: {} });
emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 100, output: 5, cost: { total: 0.001 } }, stopReason: 'toolUse' } });
if (mode === 'fail') { process.stderr.write('fixture provider failure\n'); process.exit(3); }
const body = mode === 'empty' ? '' :
  `Some preamble the runner must drop.\n\n# ${heading}\n\nFixture ${heading.toLowerCase()} brief for ${process.env.PRJCT_JOB ?? 'no-job'}.\n` +
  `- tools: ${flag('--tools') ?? 'none'}\n- model: ${flag('--model') ?? 'session'}\n- thinking: ${flag('--thinking') ?? 'unset'}\n` +
  `- extension: ${flag('-e') ? 'loaded' : 'missing'}; no-extensions: ${args.includes('--no-extensions')}\n- cwd: ${process.cwd()}\n`;
emit({ type: 'message_end', message: { role: 'assistant', content: body ? [{ type: 'text', text: body }] : [], usage: { input: 200, output: 60, cost: { total: 0.002 } }, stopReason: 'stop' } });
emit({ type: 'agent_end', messages: [] });
