import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { JobRunner } from '../src/jobs/runner.ts';
import { SERVICE_ORDER, createServices } from '../src/jobs/services.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';
import { tmpdir } from './test-paths.ts';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

test('init connects without indexing; services then produce the index, stack and history briefs served by lookup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-connect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent'), prjctHome = join(root, 'store');
  await mkdir(join(cwd, 'src'), { recursive: true }); await mkdir(agentHome);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' }, devDependencies: { typescript: '5' } }));
  await writeFile(join(cwd, 'README.md'), '# Fixture\n\n## Purpose\nDispatch rides.\n');
  await writeFile(join(cwd, 'src/app.ts'), "import { helper } from './helper.ts';\nexport function main() { return helper(); }\n");
  await writeFile(join(cwd, 'src/helper.ts'), 'export function helper() { return 1; }\n');
  await writeFile(join(cwd, 'src/app.test.ts'), "import test from 'node:test'; test('x', () => {});\n");
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd, env: gitEnv });
  execFileSync('git', ['add', '.'], { cwd, env: gitEnv });
  execFileSync('git', ['commit', '-q', '-m', 'feat: initial'], { cwd, env: gitEnv });

  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome, sessionId: 'connect_session', attemptId: 'connect_attempt' });
  const connected = await runtime.connectProject();
  assert.match(connected.text, /Connected project p_[0-9a-f]+ for .*: 5 indexable files\./);
  assert.equal(connected.alreadyBound, false);
  const id = await runtime.identity();
  const scope = join(prjctHome, id.day, id.projectId);
  assert.ok(await readRecord(join(scope, 'work/state.json')));
  assert.equal(await readRecord(join(scope, 'representation/manifest.json')), undefined, 'connect must not build the index');
  assert.equal(await runtime.indexStale(), true);
  assert.deepEqual((await readdir(cwd)).sort(), ['.git', 'README.md', 'package.json', 'src']);

  const runner = new JobRunner({ path: (await runtime.jobsPath())!, services: createServices(runtime) });
  assert.deepEqual((await runner.enqueue([...SERVICE_ORDER], 'init')).sort(), ['history', 'index', 'stack']);
  runner.start();
  await runner.idle();
  const jobs = await runner.read();
  assert.deepEqual(Object.values(jobs.jobs).map(row => [row.id, row.status]).sort(), [['history', 'done'], ['index', 'done'], ['stack', 'done']]);
  assert.match(jobs.jobs.index?.summary ?? '', /5 files rebuilt/);
  assert.ok(await readRecord(join(scope, 'representation/manifest.json')));
  assert.ok(await readRecord(join(scope, 'representation/history.json')));

  const stack = await runtime.readContextDoc('stack');
  assert.match(stack?.text ?? '', /Ecosystem: node/);
  assert.match(stack?.text ?? '', /run: `node --test`/);
  assert.match(stack?.text ?? '', /example to imitate: src\/app\.test\.ts/);
  const history = await runtime.readContextDoc('history');
  assert.match(history?.text ?? '', /1 commits/);
  assert.match(history?.text ?? '', /No tags/);

  // Everything is current now; a second pass queues nothing, and the batch of checks costs one walk.
  const { SourceCache } = await import('../src/representation/source-cache.ts');
  let walks = 0; const originalWalk = (SourceCache.prototype as unknown as { walk: () => unknown }).walk;
  (SourceCache.prototype as unknown as { walk: () => unknown }).walk = function (this: unknown) { walks += 1; return originalWalk.call(this); };
  try {
    assert.deepEqual(await runtime.shareWalk(() => runner.enqueueStale('sync')), []);
    assert.equal(walks, 1, 'stale checks inside shareWalk reuse one walk');
    assert.deepEqual(await runner.enqueueStale('sync'), []);
    assert.equal(walks, 3, 'outside shareWalk every check walks');
  } finally { (SourceCache.prototype as unknown as { walk: () => unknown }).walk = originalWalk; }
  assert.equal(await runtime.stackStale(), false);
  assert.equal(await runtime.historyStale(), false);

  // Lookup serves the briefs by topic, attributed to their revision.
  const lookup = await runtime.execute('prjct_context', { action: 'lookup', query: 'stack and release history', maxBytes: 24000 });
  const items = (lookup.details as { items: Array<{ kind: string; summary: string; standing: string; sources: Array<{ id: string }> }> }).items;
  const stackItem = items.find(item => item.kind === 'stack' && item.summary.startsWith('# Stack'));
  const historyItem = items.find(item => item.kind === 'history');
  assert.ok(stackItem); assert.ok(historyItem);
  assert.equal(stackItem.standing, 'supported');
  assert.equal(historyItem.sources[0]?.id, 'ctx_history');
  assert.match(await runtime.understandingText(), /not synthesized yet/);
  // Search hits carry an outline so the agent can skip full reads; the stack brief replaces the profile lines.
  const search = await runtime.execute('prjct_search', { checkoutId: id.checkoutId, query: 'main helper', maxBytes: 8000, maxItems: 5 });
  const hit = (search.details as { items: Array<{ kind: string; summary: string; outline?: string }> }).items.find(item => item.summary === 'src/app.ts');
  assert.match(hit?.outline ?? '', /^L2 export function main\(\)/);
  assert.equal(items.filter(item => item.kind === 'stack').length, 1, 'profile lines are not repeated next to the stack brief');
  // Model prompts are grounded in facts so the child never guesses ids or paths.
  const facts = await runtime.analysisFacts();
  assert.equal(facts.checkoutId, id.checkoutId);
  assert.deepEqual(facts.docFiles, ['README.md']);
  assert.deepEqual(facts.entryPoints, ['src/app.ts']);
  assert.equal(facts.testCommand, 'node --test');
  const { BRIEFS } = await import('../src/jobs/services.ts');
  const prompt = BRIEFS.patterns.prompt(facts);
  assert.match(prompt, new RegExp(`checkoutId ${id.checkoutId}`));
  assert.match(prompt, /Documentation files present: README\.md/);
  assert.match(prompt, /verifies with `node --test`/);
  assert.equal((lookup.details as { stateRevision?: number }).stateRevision !== undefined, true, 'lookup exposes stateRevision');

  // A new commit makes history stale, an edit makes index and stack stale; sync queues exactly those.
  await writeFile(join(cwd, 'src/helper.ts'), 'export function helper() { return 2; }\n');
  execFileSync('git', ['commit', '-q', '-am', 'fix: helper'], { cwd, env: gitEnv });
  assert.deepEqual((await runner.enqueueStale('sync')).sort(), ['history', 'index', 'stack']);
  runner.start();
  await runner.idle();
  assert.equal(await runtime.indexStale(), false);
  assert.match((await runtime.readContextDoc('history'))?.text ?? '', /2 commits/);
  // Reconnecting an already bound project is a no-op on state.
  assert.equal((await runtime.connectProject()).alreadyBound, true);
});
