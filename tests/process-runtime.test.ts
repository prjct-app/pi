import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';

const snapshot = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  const walk = async (dir: string, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
    }
  };
  await walk(root);
  return names.sort();
};

test('creating work persists in the global prjct home and writes nothing into the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-rt-'));
  try {
    const agentHome = join(root, 'agent-home');
    const prjctHome = join(root, 'prjct-home');
    const checkout = join(root, 'checkout');
    await mkdir(agentHome);
    await mkdir(checkout);
    await writeFile(join(checkout, 'README.md'), '# client\n');
    const before = await snapshot(checkout);
    const runtime = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome });
    await runtime.initProject();
    const created = await runtime.execute('prjct_work', {
      action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'operation_a',
      title: 'Reuse existing refresh', origin: { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) }, maxBytes: 2048,
    });
    const details = created.details as { items: Array<{ title: string }>; scope: { workId: string } };
    assert.equal(details.items[0]?.title, 'Reuse existing refresh');
    const lookup = await runtime.execute('prjct_context', { action: 'lookup', query: 'current work', maxBytes: 2048 });
    assert.match(JSON.stringify(lookup.details), /Reuse existing refresh/);
    assert.deepEqual(await snapshot(checkout), before);
    assert.equal((await snapshot(prjctHome)).some(name => /^\d{8}\/p_/.test(name) && name.includes('work/')), true);
    assert.equal((await snapshot(agentHome)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
