import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { buildImportGraph } from '../src/representation/imports.ts';
import { scoreLexical } from '../src/representation/lexical.ts';
import { buildProjectIndex, collectIndexable, diffHashes } from '../src/representation/sync.ts';

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
