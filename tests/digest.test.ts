import assert from 'node:assert/strict';
import test from 'node:test';
import { digestToolResult, foldLines, normalizeTerminal, outlineOf, windowLines } from '../src/knowledge/digest.ts';

const result = (text: string) => ({ content: [{ type: 'text', text }], details: {} });

test('a read observation records shape, never the file content the agent already holds', () => {
  const content = 'import x from "y";\n' + 'export const a = 1;\n'.repeat(200);
  const digest = digestToolResult('read', result(content), { path: 'src/big.ts' });
  assert.match(digest.text, /^src\/big\.ts 202 lines, \d+ B; starts: import x from "y";$/);
  assert.equal(digest.text.includes('export const a'), false);
  assert.equal(digest.lines, 202);
  assert.ok(digest.text.length < 120);
  const missing = digestToolResult('read', result("ENOENT: no such file or directory, access '/x/README.md'"), { path: 'README.md' });
  assert.match(missing.text, /ENOENT/);
});

test('terminal noise is normalized: ANSI colors stripped, carriage-return frames collapsed', () => {
  const text = '[31m[1merror[0m: boom\nprogress 10%\rprogress 50%\rprogress 100%\n';
  assert.equal(normalizeTerminal(text), 'error: boom\nprogress 100%\n');
});

test('repeated and templated lines fold with counts and sample values, only when shorter', () => {
  const folded = foldLines(['same', 'same', 'same', 'compiling module core::task_1 (incremental) 12ms', 'compiling module core::task_2 (incremental) 15ms', 'compiling module core::task_3 (incremental) 9ms', 'compiling module core::task_4 (incremental) 11ms', 'done']);
  assert.equal(folded[0], 'same [×3]');
  assert.match(folded[1] ?? '', /^compiling module core::task_\{\} \(incremental\) \{\}ms \[×4: \(1,12\) \(2,15\) \(3,9\) …\]$/);
  assert.equal(folded[2], 'done');
  assert.deepEqual(foldLines(['a', 'b']), ['a', 'b']);
  assert.deepEqual(foldLines(['x 1', 'x 2']), ['x 1', 'x 2'], 'two templated lines are not worth a fold');
});

test('windowing keeps head, tail and every failure line and marks what it dropped', () => {
  const lines = ['$ npm test', 'info: starting', ...Array.from({ length: 200 }, (_, i) => `ok ${i + 1} - case ${i + 1} passes fine`), 'not ok 201 - the important failure', 'assertion failed at file.ts:10', 'summary: 201 tests', '1 failing', 'exit code 1'];
  const windowed = windowLines(lines, 600);
  const text = windowed.join('\n');
  assert.ok(text.length <= 600, `budget: ${text.length}`);
  assert.match(text, /^\$ npm test\ninfo: starting\n/);
  assert.match(text, /\[… \d+ lines omitted …\]/);
  assert.match(text, /not ok 201 - the important failure/);
  assert.match(text, /assertion failed at file\.ts:10/);
  assert.match(text, /exit code 1$/);
  assert.deepEqual(windowLines(['a', 'b'], 100), ['a', 'b'], 'under budget nothing changes');
});

test('a bash digest fits the budget and a big passing run collapses to its shape', () => {
  const output = Array.from({ length: 500 }, (_, i) => `ok ${i + 1} - test ${i + 1}`).join('\n') + '\n# tests 500\n# pass 500\n# fail 0\n';
  const digest = digestToolResult('bash', result(output), { command: 'npm test' });
  assert.ok(Buffer.byteLength(digest.text) <= 700);
  assert.match(digest.text, /# fail 0/);
  assert.equal(digest.lines, 504);
  assert.equal(digestToolResult('bash', result(''), {}).text, '(no output)');
});

test('an outline lists declarations with line numbers across languages, bounded', () => {
  const ts = 'import a from "b";\n\nexport type Job = { id: string };\nexport async function runJob(id: string, opts: Options): Promise<void> {\n  const x = 1;\n}\nclass Helper {\n}\nexport default class Runner extends Base {\n}\n';
  const outline = outlineOf(ts);
  assert.deepEqual(outline.split('\n'), ['L3 export type Job = { id: string };', 'L4 export async function runJob(id: string, opts: Options): Promise<void>', 'L7 class Helper', 'L9 export default class Runner extends Base']);
  assert.deepEqual(outlineOf('def main():\n  pass\nclass Thing:\n  pass\n').split('\n'), ['L1 def main():', 'L3 class Thing:']);
  assert.match(outlineOf('func (s *Server) Start() error {\n}\n'), /^L1 func \(s \*Server\) Start\(\) error$/);
  const many = Array.from({ length: 50 }, (_, i) => `export function f${i}() {}`).join('\n');
  assert.equal(outlineOf(many).split('\n').length, 14);
});
