import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SourceCache, hashText } from '../src/representation/source-cache.ts';
import { tmpdir } from './test-paths.ts';

// The live watcher must reproduce exactly what a full walk would see, without
// walking. Each step compares against a fresh SourceCache walking the same tree.
const walkTruth = async (root: string) => new SourceCache(root).snapshot({ fresh: true });
const countWalks = (cache: SourceCache) => {
  let walks = 0;
  const proto = Object.getPrototypeOf(cache) as { walk: () => Promise<unknown> };
  const original = proto.walk;
  proto.walk = function (this: unknown) { if (this === cache) walks += 1; return original.call(this); };
  return { walks: () => walks, restore: () => { proto.walk = original; } };
};

test('live watcher: edits, adds, deletes, renames and new directories are reflected without another walk', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/deep'), { recursive: true });
  await mkdir(join(root, 'node_modules/dep'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'src/deep/z.ts'), 'export const z = 1;\n');
  await writeFile(join(root, 'README.md'), '# w\n');
  const cache = new SourceCache(root);
  const counter = countWalks(cache);
  t.after(counter.restore);
  assert.equal(cache.watch(), true);
  try {
    // Before the warm-up a walk does not make the cache live; after it, it does.
    const early = await cache.snapshot({ fresh: true });
    assert.equal(early.via, 'walk');
    assert.equal(cache.live, false);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const first = await cache.snapshot({ fresh: true });
    assert.equal(first.via, 'walk');
    assert.equal(cache.live, true);
    const walksAfterFirst = counter.walks();

    const check = async (label: string) => {
      const live = await cache.snapshot({ fresh: true });
      const truth = await walkTruth(root);
      assert.equal(live.via, 'watch', label);
      assert.deepEqual(live.hashes, truth.hashes, label);
      assert.equal(live.manifestHash, truth.manifestHash, label);
      assert.deepEqual([...live.paths], [...truth.paths], label);
      assert.equal(counter.walks(), walksAfterFirst, `${label}: no extra walk`);
      return live;
    };

    await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n');
    const edited = await check('same-size edit');
    assert.equal(edited.hashes['src/a.ts'], hashText('export const a = 2;\n'));

    await writeFile(join(root, 'src/new.ts'), 'export const fresh = 1;\n');
    await check('added file');

    await unlink(join(root, 'src/deep/z.ts'));
    await check('deleted file');

    await rename(join(root, 'src/new.ts'), join(root, 'src/renamed.ts'));
    await check('renamed file');

    await mkdir(join(root, 'lib/inner'), { recursive: true });
    await writeFile(join(root, 'lib/inner/x.ts'), 'export const x = 1;\n');
    await writeFile(join(root, 'lib/index.ts'), 'export * from "./inner/x.ts";\n');
    const grown = await check('new directory subtree');
    assert.equal(grown.hashes['lib/inner/x.ts'] !== undefined, true);

    await rm(join(root, 'lib'), { recursive: true });
    await check('deleted directory subtree');

    await writeFile(join(root, 'node_modules/dep/index.js'), 'ignored\n');
    await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50]));
    await check('ignored paths');

    // A generic revalidation walk is still available and agrees with the live state.
    const revalidated = await cache.revalidate();
    assert.equal(revalidated.via, 'walk');
    assert.equal(revalidated.manifestHash, (await walkTruth(root)).manifestHash);
  } finally {
    cache.unwatch();
  }
  assert.equal(cache.live, false);
});

test('a coalesced child event removes its deleted directory subtree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-watch-coalesced-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib/inner'), { recursive: true });
  await writeFile(join(root, 'lib/index.ts'), 'export * from "./inner/x.ts";\n');
  await writeFile(join(root, 'lib/inner/x.ts'), 'export const x = 1;\n');
  const cache = new SourceCache(root);
  await cache.snapshot({ fresh: true });
  await rm(join(root, 'lib'), { recursive: true });

  // FSEvents can report only one child of a recursively removed directory.
  const internals = cache as unknown as {
    dirtyPaths: Set<string>;
    applyDirty(): Promise<void>;
    assemble(via: 'watch'): { hashes: Record<string, string> };
  };
  internals.dirtyPaths.add('lib/index.ts');
  await internals.applyDirty();
  assert.deepEqual(internals.assemble('watch').hashes, Object.create(null));
});

test('a fresh live snapshot catches a deletion before its watcher event is delivered', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-watch-late-event-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/stale.ts'), 'export const stale = true;\n');
  const cache = new SourceCache(root);
  const counter = countWalks(cache);
  t.after(counter.restore);
  await cache.snapshot({ fresh: true });

  // Reproduce the state seen under concurrent load: the filesystem operation
  // has completed, but FSEvents has not populated dirtyPaths yet.
  const internals = cache as unknown as {
    watcher: { close(): void };
    walkedSinceWatch: boolean;
    needsFullWalk: boolean;
  };
  internals.watcher = { close() {} };
  internals.walkedSinceWatch = true;
  internals.needsFullWalk = false;
  try {
    assert.equal(cache.live, true);
    await unlink(join(root, 'src/stale.ts'));
    const snapshot = await cache.snapshot({ fresh: true });
    assert.equal(snapshot.hashes['src/stale.ts'], undefined);
    assert.equal(counter.walks(), 1, 'late-event recovery does not require another full walk');
  } finally {
    cache.unwatch();
  }
});

test('PRJCT_WATCH=0 keeps the walk-only behaviour', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-nowatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  const previous = process.env.PRJCT_WATCH;
  process.env.PRJCT_WATCH = '0';
  try {
    const cache = new SourceCache(root);
    assert.equal(cache.watch(), false);
    assert.equal((await cache.snapshot({ fresh: true })).via, 'walk');
    assert.equal(cache.live, false);
  } finally {
    if (previous === undefined) delete process.env.PRJCT_WATCH; else process.env.PRJCT_WATCH = previous;
  }
});
