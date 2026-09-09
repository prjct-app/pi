import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { sourceId } from '../src/representation/sync.ts';

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

test('sync indexes the checkout without writing it; search and imports then work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-sync-'));
  try {
    const agentHome = join(root, 'agent-home');
    const prjctHome = join(root, 'prjct-home');
    const checkout = join(root, 'checkout');
    await mkdir(agentHome);
    await mkdir(join(checkout, 'src'), { recursive: true });
    await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [] }\n');
    await writeFile(join(checkout, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return queryUsers()[0] }\n");
    const before = await snapshot(checkout);
    const runtime = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome });
    const first = await runtime.initProject();
    assert.equal(first.rebuilt, true);
    assert.equal(first.indexedFiles >= 2, true);
    await runtime.syncProject();
    const after = await snapshot(checkout);
    assert.deepEqual(after, before);
    assert.equal((await snapshot(prjctHome)).some(name => /^\d{8}\/p_/.test(name) && name.includes('representation/')), true);
    assert.equal((await snapshot(agentHome)).length, 0);

    const search = await runtime.execute('prjct_search', {
      checkoutId: first.checkoutId, query: 'getUserById', maxItems: 8, maxBytes: 4096,
    });
    const hits = search.details as { items: Array<{ summary: string; kind: string }> };
    assert.equal(hits.items.some(item => item.kind === 'source' && item.summary === 'src/users.ts'), true);

    const structure = await runtime.execute('prjct_structure', {
      action: 'neighbors', checkoutId: first.checkoutId, seeds: [sourceId('src/users.ts')],
      relations: ['imports'], maxDepth: 2, maxItems: 8, maxBytes: 4096,
    });
    const graph = structure.details as { edges: Array<{ from: string; to: string }>; nodes?: Array<{ path: string }> };
    assert.equal(graph.edges.length > 0, true);
    assert.equal(graph.nodes?.some(node => node.path === 'src/db.ts'), true);

    const second = await runtime.syncProject();
    assert.equal(second.rebuilt, false);

    await unlink(join(checkout, 'src/users.ts'));
    const afterDelete = await runtime.syncProject();
    assert.equal(afterDelete.rebuilt, true);
    const gone = await runtime.execute('prjct_search', {
      checkoutId: first.checkoutId, query: 'getUserById', maxItems: 8, maxBytes: 4096,
    });
    const remaining = gone.details as { items: Array<{ summary: string }> };
    assert.equal(remaining.items.some(item => item.summary === 'src/users.ts'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
