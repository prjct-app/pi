import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { inspectSources } from '../src/representation/source-inspect.ts';

test('a deletion-only change is visible in the next mechanical inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-src-'));
  try {
    const file = join(root, 'keep.ts');
    const gone = join(root, 'obsolete.ts');
    await writeFile(file, 'export const keep = 1;\n');
    await writeFile(gone, 'export const obsolete = 1;\n');
    const before = await inspectSources(root);
    assert.equal(before.files.some(item => item.relativePath === 'obsolete.ts'), true);
    await unlink(gone);
    const after = await inspectSources(root);
    assert.equal(after.files.some(item => item.relativePath === 'obsolete.ts'), false);
    assert.equal(after.files.some(item => item.relativePath === 'keep.ts'), true);
    assert.notEqual(after.manifestHash, before.manifestHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untracked working-tree files are observed; HEAD is not the freshness certificate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-untracked-'));
  try {
    await writeFile(join(root, 'untracked.md'), 'draft\n');
    const inspection = await inspectSources(root);
    assert.equal(inspection.files.some(item => item.relativePath === 'untracked.md'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
