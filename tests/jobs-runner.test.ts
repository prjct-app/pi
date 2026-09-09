import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { JobRunner, formatJobs, type RunnerEvent, type Service } from '../src/jobs/runner.ts';
import { tmpdir } from './test-paths.ts';

const fakeService = (id: string, options: { dependsOn?: string[]; stale?: boolean; fail?: boolean; delayMs?: number; log?: string[] } = {}): Service => ({
  id, kind: 'mechanical', dependsOn: options.dependsOn ?? [],
  stale: async () => options.stale ?? true,
  run: async ctx => {
    options.log?.push(`start:${id}`);
    for (let i = 0; i < 3; i += 1) {
      ctx.signal.throwIfAborted();
      ctx.onProgress(i + 1, 3);
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }
    if (options.fail) throw new Error(`${id} exploded`);
    options.log?.push(`end:${id}`);
    return { summary: `${id} ok`, freshness: { v: '1' } };
  },
});

test('jobs run in dependency order, persist their outcome, and stale-only enqueue skips current services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-jobs-'));
  try {
    const log: string[] = [];
    const events: RunnerEvent[] = [];
    const runner = new JobRunner({ path: join(root, 'work', 'jobs.json'), onEvent: event => events.push(event), services: [
      fakeService('stack', { dependsOn: ['index'], log }),
      fakeService('index', { log }),
      fakeService('history', { log, stale: false }),
    ] });
    const queued = await runner.enqueue(['stack', 'history'], 'init');
    assert.deepEqual(queued.sort(), ['index', 'stack']); // history is current, index is a stale dependency
    runner.start();
    await runner.idle();
    assert.deepEqual(log, ['start:index', 'end:index', 'start:stack', 'end:stack']);
    const file = JSON.parse(await readFile(join(root, 'work', 'jobs.json'), 'utf8')) as { jobs: Record<string, { status: string; summary?: string; durationMs?: number; freshness?: Record<string, string> }> };
    assert.equal(file.jobs.index?.status, 'done');
    assert.equal(file.jobs.stack?.status, 'done');
    assert.equal(file.jobs.stack?.summary, 'stack ok');
    assert.deepEqual(file.jobs.stack?.freshness, { v: '1' });
    assert.equal(typeof file.jobs.index?.durationMs, 'number');
    assert.equal(file.jobs.history, undefined);
    assert.equal(events.filter(event => event.type === 'progress').length, 6);
    assert.deepEqual(events.at(-1), { type: 'idle', ran: 2, ids: ['index', 'stack'] });
    assert.match(formatJobs(file as never, ['index', 'stack', 'history']).join('\n'), /index\s+done/);
    // Forcing re-queues a current service; a plain enqueue of a done one is a no-op until it is stale.
    assert.deepEqual(await runner.enqueue(['history'], 'run', { force: true }), ['history']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed service fails its dependents but not independent ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-jobs-fail-'));
  try {
    const runner = new JobRunner({ path: join(root, 'jobs.json'), services: [
      fakeService('index', { fail: true }),
      fakeService('stack', { dependsOn: ['index'] }),
      fakeService('history'),
    ] });
    await runner.enqueue(['index', 'stack', 'history'], 'init');
    runner.start();
    await runner.idle();
    const file = await runner.read();
    assert.equal(file.jobs.index?.status, 'failed');
    assert.match(file.jobs.index?.error ?? '', /exploded/);
    assert.equal(file.jobs.stack?.status, 'failed');
    assert.match(file.jobs.stack?.error ?? '', /dependency/);
    assert.equal(file.jobs.history?.status, 'done');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stop interrupts the running job; resume re-queues it and jobs owned by dead processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-jobs-stop-'));
  try {
    const path = join(root, 'jobs.json');
    const runner = new JobRunner({ path, services: [fakeService('index', { delayMs: 40 }), fakeService('history', { delayMs: 40 })] });
    await runner.enqueue(['index', 'history'], 'init');
    runner.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    await runner.stop();
    let file = await runner.read();
    assert.equal(file.jobs.index?.status, 'interrupted');
    assert.equal(file.jobs.history?.status, 'queued');
    // Simulate a crashed sibling process that died mid-run.
    file.jobs.history = { ...file.jobs.history!, status: 'running', pid: 999999 };
    await writeFile(path, JSON.stringify(file));
    assert.deepEqual((await runner.resume()).sort(), ['history', 'index']);
    runner.start();
    await runner.idle();
    file = await runner.read();
    assert.equal(file.jobs.index?.status, 'done');
    assert.equal(file.jobs.history?.status, 'done');
    assert.equal(file.jobs.index?.attempt, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale queue lock is broken instead of blocking forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-jobs-lock-'));
  try {
    const path = join(root, 'jobs.json');
    await writeFile(`${path}.lock`, '1');
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    const runner = new JobRunner({ path, services: [fakeService('index')] });
    assert.deepEqual(await runner.enqueue(['index'], 'init'), ['index']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
