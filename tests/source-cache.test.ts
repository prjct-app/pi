import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { INDEX_EXTENSIONS, MAX_INDEX_FILE_BYTES, SKIP_DIRS, isSkippedFile } from '../src/representation/skip.ts';
import { SourceCache } from '../src/representation/source-cache.ts';
import { collectIndexable } from '../src/representation/sync.ts';
import { tmpdir } from './test-paths.ts';

// The historical full walk (pre source-cache). Kept verbatim so hash, order and
// manifest equivalence is asserted against the algorithm every stored
// src_/repr_ support was produced with.
const legacyCollect = async (root: string) => {
  const files: Array<{ relativePath: string; contentHash: string }> = [];
  let skipped = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      if (isSkippedFile(entry.name) || (!INDEX_EXTENSIONS.has(extname(entry.name).toLowerCase()) && !['Gemfile', 'requirements.txt', 'go.mod'].includes(entry.name))) { skipped += 1; continue; }
      const info = await stat(path);
      if (info.size > MAX_INDEX_FILE_BYTES) { skipped += 1; continue; }
      const buffer = await readFile(path);
      if (buffer.includes(0)) { skipped += 1; continue; }
      files.push({ relativePath: relative(root, path).split('\\').join('/'), contentHash: createHash('sha256').update(buffer.toString('utf8')).digest('hex') });
    }
  };
  await walk(root);
  const order = files.map(file => file.relativePath);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hashes: Record<string, string> = Object.create(null);
  for (const file of files) hashes[file.relativePath] = file.contentHash;
  const manifestHash = createHash('sha256').update(files.map(file => `${file.relativePath}:${file.contentHash}`).join('\n')).digest('hex');
  return { hashes, manifestHash, order, skipped };
};

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-scache-'));
  await mkdir(join(root, 'src/deep'), { recursive: true });
  await mkdir(join(root, 'node_modules/dep'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '# Fixture\n');
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(root, 'go.mod'), 'module fixture\n');
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/deep/z.ts'), 'export const z = 26;\n');
  await writeFile(join(root, 'src/b.tsx'), 'export const b = 2;\n');
  await writeFile(join(root, 'src.ts'), 'export const top = 0;\n'); // sorts next to the src/ directory
  await writeFile(join(root, 'docs/guide.md'), '# Guide\n');
  await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, 'src/binary.ts'), Buffer.from([0x65, 0x00, 0x66]));
  await writeFile(join(root, 'src/huge.ts'), 'x'.repeat(MAX_INDEX_FILE_BYTES + 1));
  await writeFile(join(root, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  await mkdir(join(root, '.claude/worktrees/x'), { recursive: true });
  await writeFile(join(root, '.claude/worktrees/x/scratch.ts'), 'export const scratch = 1;\n');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(root, 'bundle.min.js'), 'var a=1;\n');
  await writeFile(join(root, 'bundle.js.map'), '{}\n');
  return root;
};

test('snapshot reproduces the legacy walk: hashes, manifest, order and skip rules', async () => {
  const root = await fixture();
  try {
    const legacy = await legacyCollect(root);
    const cache = new SourceCache(root);
    const snapshot = await cache.snapshot();
    assert.deepEqual(snapshot.hashes, legacy.hashes);
    assert.equal(snapshot.manifestHash, legacy.manifestHash);
    assert.deepEqual([...snapshot.paths], legacy.order);
    assert.equal(snapshot.skippedFiles, legacy.skipped);
    assert.equal(snapshot.hashes['src/binary.ts'], undefined);
    assert.equal(snapshot.hashes['src/huge.ts'], undefined);
    assert.equal(snapshot.hashes['node_modules/dep/index.js'], undefined);
    assert.equal(snapshot.hashes['go.mod'] !== undefined, true);
    for (const skipped of ['.claude/worktrees/x/scratch.ts', 'package-lock.json', 'bundle.min.js', 'bundle.js.map']) assert.equal(snapshot.hashes[skipped], undefined, skipped);
    assert.equal(snapshot.hashes['package.json'] !== undefined, true, 'manifests stay indexed');
    const collected = await collectIndexable(root);
    assert.deepEqual(collected.hashes, legacy.hashes);
    assert.equal(collected.manifestHash, legacy.manifestHash);
    assert.equal(collected.files.find(file => file.relativePath === 'src/a.ts')?.content, 'export const a = 1;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changes are detected immediately: same-size edit, add, delete, rename, and mtime-only touch keeps the hash', async () => {
  const root = await fixture();
  try {
    const cache = new SourceCache(root);
    const first = await cache.snapshot();
    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n'); // same byte length
    const second = await cache.snapshot({ fresh: true });
    assert.notEqual(second.hashes['src/a.ts'], first.hashes['src/a.ts']);
    assert.notEqual(second.manifestHash, first.manifestHash);

    await writeFile(join(root, 'src/new.ts'), 'export const fresh = 1;\n');
    await unlink(join(root, 'docs/guide.md'));
    await rename(join(root, 'src/b.tsx'), join(root, 'src/c.tsx'));
    const third = await cache.snapshot({ fresh: true });
    assert.equal(third.hashes['src/new.ts'] !== undefined, true);
    assert.equal(third.hashes['docs/guide.md'], undefined);
    assert.equal(third.hashes['src/b.tsx'], undefined);
    assert.equal(third.hashes['src/c.tsx'], second.hashes['src/b.tsx']);
    assert.deepEqual(third.hashes, (await legacyCollect(root)).hashes);

    const past = new Date(Date.now() - 60_000);
    await utimes(join(root, 'src/c.tsx'), past, past);
    const fourth = await cache.snapshot({ fresh: true });
    assert.equal(fourth.hashes['src/c.tsx'], third.hashes['src/c.tsx']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fresh snapshot starts after the in-flight walk, so it sees edits made during that walk', async () => {
  const root = await fixture();
  try {
    const cache = new SourceCache(root);
    const inFlight = cache.snapshot();
    await writeFile(join(root, 'src/a.ts'), 'export const a = 3;\n');
    const fresh = await cache.snapshot({ fresh: true });
    await inFlight;
    assert.equal(fresh.hashes['src/a.ts'], (await legacyCollect(root)).hashes['src/a.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hashOf re-stats only the named paths and refuses skipped or non-indexable ones', async () => {
  const root = await fixture();
  try {
    const cache = new SourceCache(root);
    const before = await cache.snapshot();
    await writeFile(join(root, 'src/a.ts'), 'export const a = 4;\n');
    const named = await cache.hashOf(['src/a.ts', 'image.png', 'node_modules/dep/index.js', 'missing.ts', 'src/binary.ts']);
    assert.notEqual(named['src/a.ts'], before.hashes['src/a.ts']);
    assert.equal(named['image.png'], undefined);
    assert.equal(named['node_modules/dep/index.js'], undefined);
    assert.equal(named['missing.ts'], undefined);
    assert.equal(named['src/binary.ts'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persisted stat cache is reused across processes and ignored for another checkout', async () => {
  const root = await fixture();
  const store = await mkdtemp(join(tmpdir(), 'prjct-scache-store-'));
  try {
    const persistPath = join(store, 'representation', 'stat-cache.json');
    const first = new SourceCache(root, { persistPath, checkoutId: 'co_one' });
    const expected = await first.collectAll();
    const raw = JSON.parse(await readFile(persistPath, 'utf8')) as { entries: Array<[string, number, number, string | null]>; checkoutId: string };
    assert.equal(raw.checkoutId, 'co_one');
    // Binary files stay cached as skipped (null hash) so they are not re-read every walk.
    assert.equal(raw.entries.filter(entry => entry[3] !== null).length, Object.keys(expected.hashes).length);
    assert.equal(raw.entries.some(entry => entry[0] === 'src/binary.ts' && entry[3] === null), true);

    const second = new SourceCache(root, { persistPath, checkoutId: 'co_one' });
    const warm = await second.snapshot();
    assert.deepEqual(warm.hashes, expected.hashes);
    assert.equal(warm.manifestHash, expected.manifestHash);

    const other = new SourceCache(root, { persistPath, checkoutId: 'co_other' });
    const cold = await other.snapshot();
    assert.deepEqual(cold.hashes, expected.hashes);

    // No file inside the checkout is ever written by the cache.
    const entries = (await readdir(root)).sort();
    assert.equal(entries.includes('stat-cache.json'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
