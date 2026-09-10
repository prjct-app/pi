import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';
import { tmpdir } from './test-paths.ts';

const worker = (agentHome: string, prjctHome: string, checkout: string, barrier: string, sessionId: string, writerId: string) =>
  new Promise<{ ok: boolean; sessionId: string; writerId: string; code?: string; message?: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types', new URL('./concurrent-evidence-worker.ts', import.meta.url).pathname,
      agentHome, prjctHome, checkout, barrier, sessionId, writerId,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      if (status !== 0) return reject(new Error(`Evidence worker exited ${status}: ${stderr}`));
      resolve(JSON.parse(stdout.trim()));
    });
  });

const waitFor = async (path: string) => {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    try { await access(path); return; } catch { await delay(2); }
  }
  throw new Error(`Timed out waiting for ${path}`);
};

test('concurrent sessions retain evidence in day-grouped session journals visible to prjct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-concurrent-evidence-'));
  try {
    const agentHome = join(root, 'agent-home');
    const prjctHome = join(root, 'prjct-home');
    const checkout = join(root, 'checkout');
    const barrier = join(root, 'barrier');
    await Promise.all([mkdir(agentHome), mkdir(checkout), mkdir(barrier)]);
    await writeFile(join(checkout, 'README.md'), '# concurrent evidence\n');

    const setup = new ProcessRuntime({ agentHome, prjctHome, cwd: checkout, sessionId: 'setup', attemptId: 'attempt_setup' });
    await setup.initProject();
    const ids = await setup.identity();
    const writers = [
      { sessionId: 'session_alpha', writerId: 'alpha_one' },
      { sessionId: 'session_alpha', writerId: 'alpha_two' },
      { sessionId: 'session_beta', writerId: 'beta_one' },
      { sessionId: 'session_beta', writerId: 'beta_two' },
    ];
    const pending = writers.map(({ sessionId, writerId }) => worker(agentHome, prjctHome, checkout, barrier, sessionId, writerId));
    await Promise.all(writers.map(({ writerId }) => waitFor(join(barrier, `${writerId}.ready`))));
    await writeFile(join(barrier, 'start'), '');

    const outcomes = await Promise.all(pending);
    assert.deepEqual(outcomes, writers.map(writer => ({ ok: true, ...writer })));

    const sessionRoot = join(prjctHome, ids.day, ids.projectId, 'work', 'sessions');
    const days = await readdir(sessionRoot);
    assert.equal(days.length, 1);
    assert.match(days[0]!, /^\d{8}$/);
    const dayRoot = join(sessionRoot, days[0]!);
    const sessionDirectories = await readdir(dayRoot);
    assert.equal(sessionDirectories.length, 2);
    const journalPaths = (await Promise.all(sessionDirectories.map(async directory => {
      const files = (await readdir(join(dayRoot, directory))).filter(file => /^writer_[a-f0-9]{16}\.json$/.test(file));
      assert.equal(files.length, 2);
      return files.map(file => join(dayRoot, directory, file));
    }))).flat();
    const payloads = await Promise.all(journalPaths.map(async path =>
      (await readRecord(path))?.payload as { sessionId: string; actorId: string; observations: Array<{ summary: string }> }));
    assert.deepEqual(payloads.map(payload => payload.sessionId).sort(), writers.map(writer => writer.sessionId).sort());
    assert.deepEqual(payloads.map(payload => payload.actorId).sort(), writers.map(writer => `actor_${writer.writerId}`).sort());
    assert.deepEqual(payloads.flatMap(payload => payload.observations.map(observation => observation.summary)).sort(),
      writers.map(writer => `concurrent evidence from ${writer.writerId}`).sort());

    await setup.execute('prjct_work', {
      action: 'create', projectId: ids.projectId, operationId: 'concurrent_observation_work',
      title: 'Keep journals separate', origin: { id: 'origin_concurrency', revision: 1, contentHash: 'a'.repeat(64) }, maxBytes: 4096,
    });
    for (const { writerId } of writers) {
      const lookup = await setup.execute('prjct_context', { action: 'lookup', query: `evidence ${writerId}`, maxBytes: 4096 });
      assert.match(JSON.stringify(lookup.details), new RegExp(`concurrent evidence from ${writerId}`));
    }

    const state = await readRecord(join(prjctHome, ids.day, ids.projectId, 'work', 'state.json'));
    assert.deepEqual((state?.payload as { observations: unknown[] }).observations, [], 'central mutations must not copy journal entries back into the contended record');
    // Journal records are valid envelopes, not raw append fragments.
    for (const path of journalPaths) {
      const raw = await readFile(path, 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
