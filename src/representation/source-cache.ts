import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { INDEX_CONFIG_REVISION, INDEX_EXTENSIONS, MAX_INDEX_FILE_BYTES, MAX_INDEX_FILES, SKIP_DIRS, isSkippedFile } from './skip.ts';

// Stat-validated cache of the indexable sources of one checkout. Hashes are
// recomputed only for files whose size or mtime changed. Without a watcher a
// snapshot costs one stat walk; with the recursive watcher live, a snapshot
// re-stats only the paths that produced events since the last one, after a
// short quiet period so in-flight events land first. Hash and ordering rules
// are byte-identical to the historical full walk, so stored src_/repr_
// supports stay valid.

export type IndexableFile = Readonly<{ relativePath: string; contentHash: string; content: string }>;

export type CollectedSources = Readonly<{
  files: readonly IndexableFile[];
  hashes: Record<string, string>;
  manifestHash: string;
  skippedFiles: number;
  truncated: boolean;
}>;

export type SourceSnapshot = Readonly<{
  hashes: Record<string, string>;
  manifestHash: string;
  /** Indexable paths in walk order (capped at MAX_INDEX_FILES). */
  paths: readonly string[];
  skippedFiles: number;
  truncated: boolean;
  generation: number;
  /** How the snapshot was produced: a full walk or the live watcher. */
  via: 'walk' | 'watch';
}>;

type Entry = { size: number; mtimeMs: number; hash: string | null; checkedAt: number };
type Candidate = { relativePath: string; absolutePath: string; segments: string[] };

const INDEX_FILENAMES = new Set(['Gemfile', 'requirements.txt', 'go.mod']);
// Files modified within this window of the hash time may have changed again
// without a visible mtime tick (coarse filesystem timestamps): re-hash them.
const RACY_WINDOW_MS = 2000;
const IO_CONCURRENCY = 64;
// Watcher events on macOS arrive ~12 ms after the write; a snapshot waits until
// no event has arrived for this long (bounded) before trusting the live state.
const SETTLE_MS = 30;
const SETTLE_MAX_MS = 150;
// FSEvents streams start asynchronously (hundreds of ms); a walk only makes the
// cache live once the watcher has been running long enough to be trusted.
const WATCH_WARMUP_MS = 1000;

export const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');
export const isIndexableName = (name: string): boolean =>
  !isSkippedFile(name) && (INDEX_EXTENSIONS.has(extname(name).toLowerCase()) || INDEX_FILENAMES.has(name));
const inSkippedDir = (relativePath: string): boolean => relativePath.split('/').some(segment => SKIP_DIRS.has(segment));
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const compareSegments = (left: string[], right: string[]): number => {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const order = left[i]!.localeCompare(right[i]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
};

const manifestOf = (hashes: Record<string, string>): string =>
  hashText(Object.keys(hashes).sort((a, b) => a.localeCompare(b)).map(path => `${path}:${hashes[path]}`).join('\n'));

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve));
    this.active += 1;
    try { return await task(); } finally { this.active -= 1; this.queue.shift()?.(); }
  }
}

export type SourceCacheOptions = Readonly<{ persistPath?: string; checkoutId?: string; ttlMs?: number }>;

export class SourceCache {
  readonly root: string;
  private readonly entries = new Map<string, Entry>();
  private readonly knownDirs = new Set<string>();
  private readonly ttlMs: number;
  private persistPath: string | undefined;
  private checkoutId: string | undefined;
  private loaded = false;
  private last: { snapshot: SourceSnapshot; builtAt: number } | undefined;
  private inFlight: Promise<SourceSnapshot> | undefined;
  private generation = 0;
  private dirty = false;
  private skippedFiles = 0;
  private readonly io = new Semaphore(IO_CONCURRENCY);
  // Live watcher state.
  private watcher: FSWatcher | undefined;
  private watchStartedAt = 0;
  private walkedSinceWatch = false;
  private needsFullWalk = false;
  private dirtyPaths = new Set<string>();
  private lastEventAt = 0;
  private applying: Promise<void> | undefined;
  // Assembled view of `entries`, rebuilt lazily after mutations.
  private assembled: { sorted: string[]; snapshot: SourceSnapshot } | undefined;
  private pathSetChanged = true;
  private hashesChanged = true;

  constructor(root: string, options: SourceCacheOptions = {}) {
    this.root = root;
    this.ttlMs = options.ttlMs ?? 250;
    this.persistPath = options.persistPath;
    this.checkoutId = options.checkoutId;
  }

  /** Late binding: the store scope is known only after the project is bound. */
  bindPersistence(persistPath: string, checkoutId: string): void {
    if (this.persistPath === persistPath) return;
    this.persistPath = persistPath;
    this.checkoutId = checkoutId;
    this.loaded = false;
  }

  invalidate(): void { this.last = undefined; this.assembled = undefined; }

  get watching(): boolean { return this.watcher !== undefined; }
  /** True when snapshots come from the live watcher instead of walks. */
  get live(): boolean { return this.watcher !== undefined && this.walkedSinceWatch && !this.needsFullWalk; }

  /**
   * Start the recursive watcher. The first snapshot after this is still a full
   * walk; later ones re-stat only what changed. Returns false when the host
   * cannot watch (unsupported platform, limits): walks remain the source of truth.
   */
  watch(): boolean {
    if (this.watcher) return true;
    if (process.env.PRJCT_WATCH === '0') return false;
    try {
      const watcher = watch(this.root, { recursive: true, persistent: false }, (_type, name) => {
        this.lastEventAt = Date.now();
        if (!name) { this.needsFullWalk = true; return; }
        const relativePath = String(name).replaceAll('\\', '/');
        if (inSkippedDir(relativePath)) return;
        this.dirtyPaths.add(relativePath);
      });
      watcher.on('error', () => this.unwatch());
      this.watcher = watcher;
      this.watchStartedAt = Date.now();
      this.walkedSinceWatch = false;
      this.needsFullWalk = false;
      return true;
    } catch {
      this.watcher = undefined;
      return false;
    }
  }

  unwatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.walkedSinceWatch = false;
    this.dirtyPaths.clear();
  }

  /** Full walk on demand (idle revalidation): corrects anything a watcher missed. */
  async revalidate(): Promise<SourceSnapshot> {
    if (this.inFlight) return this.inFlight;
    const walk = this.walk().finally(() => { if (this.inFlight === walk) this.inFlight = undefined; });
    this.inFlight = walk;
    return walk;
  }

  /**
   * Hashes and manifest of the checkout. Without a live watcher: within the TTL
   * the previous snapshot is reused, and `fresh` forces a new walk that starts
   * after any in-flight walk. With a live watcher: `fresh` waits for events to
   * settle, applies changed paths, then validates known paths so a completed
   * deletion cannot be hidden by late watcher delivery.
   */
  async snapshot(options: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<SourceSnapshot> {
    if (this.live) {
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      if (options.fresh) await this.settle();
      await this.applyDirty();
      if (options.fresh && this.live) await this.revalidateKnownEntries();
      if (this.live) return this.assemble('watch');
    }
    if (!options.fresh) {
      // Informational readers may name a tolerance; evidence readers never do.
      const tolerance = options.maxAgeMs ?? this.ttlMs;
      if (this.last && Date.now() - this.last.builtAt < tolerance) return this.last.snapshot;
      if (this.inFlight) return this.inFlight;
    } else if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
    const walk = this.walk().finally(() => { if (this.inFlight === walk) this.inFlight = undefined; });
    this.inFlight = walk;
    return walk;
  }

  /** Current hashes of specific paths, re-stat'ing only those. Missing or non-indexable paths map to undefined. */
  async hashOf(paths: readonly string[]): Promise<Record<string, string | undefined>> {
    await this.ensureLoaded();
    const result: Record<string, string | undefined> = Object.create(null);
    await Promise.all(paths.map(async relativePath => {
      const absolute = join(this.root, relativePath);
      const name = relativePath.split('/').at(-1) ?? relativePath;
      if (!isIndexableName(name) || inSkippedDir(relativePath)) { result[relativePath] = undefined; return; }
      try {
        const info = await stat(absolute);
        if (!info.isFile()) { result[relativePath] = undefined; return; }
        const entry = await this.refresh(relativePath, absolute, info.size, info.mtimeMs);
        result[relativePath] = entry?.hash ?? undefined;
      } catch { result[relativePath] = undefined; }
    }));
    return result;
  }

  /** Contents of specific indexable paths, with hashes consistent with the cache. */
  async read(paths: readonly string[]): Promise<IndexableFile[]> {
    const files: IndexableFile[] = [];
    await Promise.all(paths.map(path => this.io.run(async () => {
      try {
        const buffer = await readFile(join(this.root, path));
        if (buffer.includes(0)) return;
        const content = buffer.toString('utf8');
        files.push({ relativePath: path, contentHash: hashText(content), content });
      } catch { /* Deleted between snapshot and read. */ }
    })));
    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  /** Full collection with contents. Only index builds need this. */
  async collectAll(): Promise<CollectedSources> {
    const snapshot = await this.snapshot({ fresh: true });
    const files = await this.read(snapshot.paths);
    const hashes: Record<string, string> = Object.create(null);
    for (const file of files) hashes[file.relativePath] = file.contentHash;
    await this.persist();
    return { files, hashes, manifestHash: manifestOf(hashes), skippedFiles: snapshot.skippedFiles, truncated: snapshot.truncated };
  }

  async persist(): Promise<void> {
    if (!this.persistPath || !this.dirty) return;
    const payload = { v: INDEX_CONFIG_REVISION, checkoutId: this.checkoutId ?? null, root: this.root,
      entries: [...this.entries].map(([path, entry]) => [path, entry.size, entry.mtimeMs, entry.hash, entry.checkedAt]) };
    const tmp = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(join(this.persistPath, '..'), { recursive: true });
      await writeFile(tmp, JSON.stringify(payload), { flag: 'wx' });
      await rename(tmp, this.persistPath);
      this.dirty = false;
    } catch {
      await unlink(tmp).catch(() => undefined);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persistPath) return;
    try {
      const parsed = JSON.parse(await readFile(this.persistPath, 'utf8')) as
        { v?: number; checkoutId?: string | null; root?: string; entries?: Array<[string, number, number, string | null, number]> };
      if (parsed.v !== INDEX_CONFIG_REVISION || parsed.root !== this.root || (parsed.checkoutId ?? null) !== (this.checkoutId ?? null)) return;
      for (const [path, size, mtimeMs, hash, checkedAt] of parsed.entries ?? []) {
        if (!this.entries.has(path)) this.entries.set(path, { size, mtimeMs, hash, checkedAt: checkedAt ?? 0 });
      }
    } catch { /* No usable cache; stat validation covers every entry anyway. */ }
  }

  // ---- Full walk ----

  private async walk(): Promise<SourceSnapshot> {
    await this.ensureLoaded();
    const watching = this.watcher !== undefined;
    const candidates: Candidate[] = [];
    const skipped = { count: 0 };
    const dirs = new Set<string>();
    await this.walkDir(this.root, [], candidates, skipped, dirs);
    const seen = new Set<string>();
    await Promise.all(candidates.map(candidate => this.io.run(async () => {
      seen.add(candidate.relativePath);
      let info;
      try { info = await stat(candidate.absolutePath); } catch { skipped.count += 1; return; }
      if (!info.isFile()) return;
      if (info.size > MAX_INDEX_FILE_BYTES) { skipped.count += 1; this.entries.delete(candidate.relativePath); return; }
      const entry = await this.refresh(candidate.relativePath, candidate.absolutePath, info.size, info.mtimeMs);
      if (!entry || entry.hash === null) skipped.count += 1;
    })));
    for (const path of [...this.entries.keys()]) if (!seen.has(path)) { this.entries.delete(path); this.dirty = true; }
    this.knownDirs.clear();
    for (const dir of dirs) this.knownDirs.add(dir);
    this.skippedFiles = skipped.count;
    this.pathSetChanged = true;
    // Only a walk completed after the warm-up can vouch for what the watcher will see next.
    if (watching && this.watcher && Date.now() - this.watchStartedAt >= WATCH_WARMUP_MS) { this.walkedSinceWatch = true; this.needsFullWalk = false; }
    const snapshot = this.assemble('walk');
    this.last = { snapshot, builtAt: Date.now() };
    return snapshot;
  }

  private async walkDir(dir: string, segments: string[], out: Candidate[], skipped: { count: number }, dirs: Set<string>): Promise<void> {
    let entries;
    try { entries = await this.io.run(() => readdir(dir, { withFileTypes: true })); } catch { return; }
    dirs.add(segments.join('/'));
    const nested: Promise<void>[] = [];
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { nested.push(this.walkDir(path, [...segments, entry.name], out, skipped, dirs)); continue; }
      if (!entry.isFile()) continue;
      if (!isIndexableName(entry.name)) { skipped.count += 1; continue; }
      out.push({ relativePath: [...segments, entry.name].join('/'), absolutePath: path, segments: [...segments, entry.name] });
    }
    await Promise.all(nested);
  }

  // ---- Live reconciliation ----

  private async settle(): Promise<void> {
    const started = Date.now();
    const deadline = started + SETTLE_MAX_MS;
    let until = Math.max(started, this.lastEventAt) + SETTLE_MS;
    while (Date.now() < until && Date.now() < deadline) {
      await sleep(Math.max(1, until - Date.now()));
      if (this.lastEventAt + SETTLE_MS > until) until = this.lastEventAt + SETTLE_MS;
    }
  }

  private async applyDirty(): Promise<void> {
    if (this.applying) await this.applying;
    while (this.dirtyPaths.size) {
      const batch = this.dirtyPaths;
      this.dirtyPaths = new Set();
      this.applying = (async () => {
        const paths = [...batch];
        await Promise.all(paths.map(path => this.io.run(() => this.reconcile(path))));
        // Recursive watchers may coalesce a removed subtree into an event for
        // only one child. Reconcile that child's ancestors so a missing sibling
        // or directory still removes every cached descendant, without a tree walk.
        const parents = new Set<string>();
        for (const path of paths) {
          let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          while (true) {
            parents.add(parent);
            if (!parent) break;
            parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
          }
        }
        for (const parent of [...parents].sort((left, right) => right.length - left.length)) await this.reconcile(parent);
      })().finally(() => { this.applying = undefined; });
      await this.applying;
    }
  }

  private async revalidateKnownEntries(): Promise<void> {
    // A filesystem operation may resolve before its watcher callback is
    // delivered, especially when many test workers or tools are active. A
    // fresh snapshot cannot treat that temporary silence as proof that cached
    // files still exist. Re-stat known files without walking directories; the
    // watcher remains responsible for discovering additions.
    const paths = [...this.entries.keys()];
    await Promise.all(paths.map(path => this.io.run(() => this.reconcile(path))));
  }

  private async reconcile(relativePath: string): Promise<void> {
    const absolute = join(this.root, relativePath);
    let info;
    try { info = await stat(absolute); } catch { this.forget(relativePath); return; }
    if (info.isDirectory()) { await this.reconcileDir(relativePath, absolute); return; }
    if (!info.isFile()) return;
    const name = relativePath.split('/').at(-1) ?? relativePath;
    if (!isIndexableName(name)) return;
    if (info.size > MAX_INDEX_FILE_BYTES) { this.forget(relativePath); return; }
    const had = this.entries.has(relativePath);
    await this.refresh(relativePath, absolute, info.size, info.mtimeMs);
    if (!had) this.pathSetChanged = true;
  }

  private forget(relativePath: string): void {
    let changed = false;
    if (this.entries.delete(relativePath)) changed = true;
    if (this.knownDirs.has(relativePath)) {
      const prefix = `${relativePath}/`;
      for (const path of [...this.entries.keys()]) if (path.startsWith(prefix)) { this.entries.delete(path); changed = true; }
      for (const dir of [...this.knownDirs]) if (dir === relativePath || dir.startsWith(prefix)) this.knownDirs.delete(dir);
    }
    if (changed) { this.dirty = true; this.pathSetChanged = true; }
  }

  private async reconcileDir(relativePath: string, absolute: string): Promise<void> {
    if (!this.knownDirs.has(relativePath)) {
      // New subtree: walk it fully.
      const candidates: Candidate[] = [];
      const skipped = { count: 0 };
      const dirs = new Set<string>();
      await this.walkDir(absolute, relativePath ? relativePath.split('/') : [], candidates, skipped, dirs);
      for (const dir of dirs) this.knownDirs.add(dir);
      for (const candidate of candidates) await this.reconcile(candidate.relativePath);
      return;
    }
    let names: string[];
    try { names = await readdir(absolute); } catch { this.forget(relativePath); return; }
    const present = new Set(names);
    const prefix = relativePath ? `${relativePath}/` : '';
    for (const path of [...this.entries.keys()]) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes('/') && !present.has(rest)) this.forget(path);
    }
    for (const dir of [...this.knownDirs]) {
      if (!dir.startsWith(prefix) || dir === relativePath) continue;
      const rest = dir.slice(prefix.length);
      if (!rest.includes('/') && !present.has(rest)) this.forget(dir);
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const child = `${prefix}${name}`;
      if (this.knownDirs.has(child)) continue;
      if (this.entries.has(child) || isIndexableName(name)) { await this.reconcile(child); continue; }
      // Unknown non-indexable name: only matters if it is a new directory.
      try { if ((await stat(join(this.root, child))).isDirectory()) await this.reconcileDir(child, join(this.root, child)); } catch { /* vanished */ }
    }
  }

  private assemble(via: 'walk' | 'watch'): SourceSnapshot {
    // Nothing changed since the last assembly: the same snapshot (and generation) stands.
    if (this.assembled && !this.pathSetChanged && !this.hashesChanged) return this.assembled.snapshot;
    this.hashesChanged = false;
    if (this.assembled && !this.pathSetChanged) {
      const hashes: Record<string, string> = Object.create(null);
      for (const path of this.assembled.sorted) hashes[path] = this.entries.get(path)!.hash!;
      this.generation += 1;
      const snapshot: SourceSnapshot = { ...this.assembled.snapshot, hashes, manifestHash: manifestOf(hashes), generation: this.generation, via };
      this.assembled = { sorted: this.assembled.sorted, snapshot };
      return snapshot;
    }
    const indexable: string[] = [];
    for (const [path, entry] of this.entries) if (entry.hash !== null) indexable.push(path);
    indexable.sort((left, right) => compareSegments(left.split('/'), right.split('/')));
    const truncated = indexable.length >= MAX_INDEX_FILES;
    const sorted = indexable.slice(0, MAX_INDEX_FILES);
    const hashes: Record<string, string> = Object.create(null);
    for (const path of sorted) hashes[path] = this.entries.get(path)!.hash!;
    this.generation += 1;
    const snapshot: SourceSnapshot = { hashes, manifestHash: manifestOf(hashes), paths: sorted, skippedFiles: this.skippedFiles, truncated, generation: this.generation, via };
    this.assembled = { sorted, snapshot };
    this.pathSetChanged = false;
    return snapshot;
  }

  private async refresh(relativePath: string, absolutePath: string, size: number, mtimeMs: number): Promise<Entry | undefined> {
    const cached = this.entries.get(relativePath);
    const racy = cached ? mtimeMs >= cached.checkedAt - RACY_WINDOW_MS : true;
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && !racy) return cached;
    try {
      const buffer = await readFile(absolutePath);
      const entry: Entry = { size, mtimeMs, hash: buffer.includes(0) ? null : hashText(buffer.toString('utf8')), checkedAt: Date.now() };
      if (!cached || cached.hash !== entry.hash || cached.size !== size || cached.mtimeMs !== mtimeMs) this.dirty = true;
      if (!cached || cached.hash !== entry.hash) this.hashesChanged = true;
      this.entries.set(relativePath, entry);
      return entry;
    } catch {
      if (this.entries.delete(relativePath)) this.pathSetChanged = true;
      return undefined;
    }
  }
}
