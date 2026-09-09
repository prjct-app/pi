import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { buildImportGraph } from '../src/representation/imports.ts';
import { scoreLexical } from '../src/representation/lexical.ts';
import { buildProjectIndex, collectIndexable, diffHashes, updateProjectIndex } from '../src/representation/sync.ts';
import { SourceCache } from '../src/representation/source-cache.ts';

test('collectIndexable sees untracked sources and drops deletions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-idx-'));
  try {
    await writeFile(join(root, 'keep.ts'), 'export const keep = 1;\n');
    await writeFile(join(root, 'gone.ts'), 'export const gone = 1;\n');
    const before = await collectIndexable(root);
    assert.equal(before.hashes['gone.ts'] !== undefined, true);
    await unlink(join(root, 'gone.ts'));
    await writeFile(join(root, 'fresh.ts'), 'export const fresh = 1;\n');
    const after = await collectIndexable(root);
    const diff = diffHashes(before.hashes, after.hashes);
    assert.deepEqual(diff.deleted, ['gone.ts']);
    assert.equal(diff.added.includes('fresh.ts'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('built index answers BM25 and resolved relative imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-bidx-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/db.ts'), 'export function queryUsers() { return [] }\n');
    await writeFile(join(root, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return queryUsers()[0] }\n");
    const collected = await collectIndexable(root);
    const index = await buildProjectIndex(collected, { checkoutId: 'co_test', appliedRevision: 1 });
    assert.equal(scoreLexical('getUserById', index.lexical)[0]?.path, 'src/users.ts');
    const graph = buildImportGraph(collected.files.map(file => ({ path: file.relativePath, content: file.content })));
    assert.deepEqual(graph.forward['src/users.ts'], ['src/db.ts']);
    assert.equal(index.symbols['src/users.ts']?.includes('getUserById'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an incremental update re-tokenizes only changed files and matches a from-scratch build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-incr-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/db.ts'), 'export function queryUsers() { return [] }\n');
    await writeFile(join(root, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return queryUsers()[0] }\n");
    await writeFile(join(root, 'src/legacy.ts'), "import { queryUsers } from './db.ts'\nexport function legacy() { return queryUsers() }\n");
    const cache = new SourceCache(root);
    const first = await buildProjectIndex(await cache.collectAll(), { checkoutId: 'co_test', appliedRevision: 1 });

    await writeFile(join(root, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserByEmail() { return queryUsers()[1] }\n");
    await writeFile(join(root, 'src/orders.ts'), "import { getUserByEmail } from './users.ts'\nexport function listOrders() { return getUserByEmail() }\n");
    await unlink(join(root, 'src/legacy.ts'));
    const snapshot = await cache.snapshot({ fresh: true });
    const changed = diffHashes(first.hashes, snapshot.hashes);
    assert.deepEqual(changed, { added: ['src/orders.ts'], modified: ['src/users.ts'], deleted: ['src/legacy.ts'] });
    const updated = await updateProjectIndex({ previous: first, changed: await cache.read([...changed.added, ...changed.modified]), hashes: snapshot.hashes, manifestHash: snapshot.manifestHash, skippedFiles: snapshot.skippedFiles, truncated: snapshot.truncated }, { checkoutId: 'co_test', appliedRevision: 2 });
    assert.equal(updated.retokenized, 2);
    const scratch = await buildProjectIndex(await new SourceCache(root).collectAll(), { checkoutId: 'co_test', appliedRevision: 2 });
    assert.deepEqual(updated.hashes, scratch.hashes);
    assert.equal(updated.manifestHash, scratch.manifestHash);
    assert.deepEqual(updated.imports.forward, scratch.imports.forward);
    assert.deepEqual(updated.symbols, scratch.symbols);
    assert.equal(updated.indexedFiles, 3);
    for (const query of ['getUserByEmail', 'listOrders', 'queryUsers', 'legacy', 'getUserById']) {
      const a = scoreLexical(query, updated.lexical).map(hit => [hit.path, hit.score.toFixed(9)]);
      const b = scoreLexical(query, scratch.lexical).map(hit => [hit.path, hit.score.toFixed(9)]);
      assert.deepEqual(a, b, query);
    }
    assert.equal(updated.imports.forward['src/orders.ts']?.[0], 'src/users.ts');
    assert.equal(updated.imports.forward['src/legacy.ts'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
