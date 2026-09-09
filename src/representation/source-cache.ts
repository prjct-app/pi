import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { INDEX_CONFIG_REVISION, INDEX_EXTENSIONS, MAX_INDEX_FILE_BYTES, MAX_INDEX_FILES, SKIP_DIRS, isSkippedFile } from './skip.ts';

// Stat-validated cache of the indexable sources of one checkout. Hashes are
// recomputed only for files whose size or mtime changed, so a snapshot costs
// one stat walk instead of reading and hashing every file. Hash and ordering
// rules are byte-identical to the historical full walk: every manifestHash,
// per-path hash and src_ id stays valid across the upgrade.

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
}>;

type Entry = { size: number; mtimeMs: number; hash: string | null; checkedAt: number };
type Candidate = { relativePath: string; absolutePath: string; segments: string[] };

const INDEX_FILENAMES = new Set(['Gemfile', 'requirements.txt', 'go.mod']);
// Files modified within this window of the hash time may have changed again
// without a visible mtime tick (coarse filesystem timestamps): re-hash them.
const RACY_WINDOW_MS = 2000;
const IO_CONCURRENCY = 64;

export const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');
export const isIndexableName = (name: string): boolean =>
  !isSkippedFile(name) && (INDEX_EXTENSIONS.has(extname(name).toLowerCase()) || INDEX_FILENAMES.has(name));

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
  private readonly ttlMs: number;
  private persistPath: string | undefined;
  private checkoutId: string | undefined;
  private loaded = false;
  private last: { snapshot: SourceSnapshot; builtAt: number } | undefined;
  private inFlight: Promise<SourceSnapshot> | undefined;
  private generation = 0;
  private dirty = false;
  private readonly io = new Semaphore(IO_CONCURRENCY);

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

  invalidate(): void { this.last = undefined; }

  /**
   * Hashes and manifest of the checkout. Within the TTL the previous snapshot
   * is reused; `fresh` forces a new walk that starts after any in-flight walk,
   * so evidence about "what changed during this tool call" never reads a walk
   * that began before the call finished.
   */
  async snapshot(options: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<SourceSnapshot> {
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
      if (!isIndexableName(name) || relativePath.split('/').some(segment => SKIP_DIRS.has(segment))) { result[relativePath] = undefined; return; }
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

  private async walk(): Promise<SourceSnapshot> {
    await this.ensureLoaded();
    const candidates: Candidate[] = [];
    const skipped = { count: 0 };
    await this.walkDir(this.root, [], candidates, skipped);
    candidates.sort((left, right) => compareSegments(left.segments, right.segments));
    const truncated = candidates.length >= MAX_INDEX_FILES;
    const selected = candidates.slice(0, MAX_INDEX_FILES);
    const seen = new Set<string>();
    const hashes: Record<string, string> = Object.create(null);
    const paths: string[] = [];
    await Promise.all(selected.map(candidate => this.io.run(async () => {
      seen.add(candidate.relativePath);
      let info;
      try { info = await stat(candidate.absolutePath); } catch { skipped.count += 1; return; }
      if (!info.isFile()) return;
      if (info.size > MAX_INDEX_FILE_BYTES) { skipped.count += 1; return; }
      const entry = await this.refresh(candidate.relativePath, candidate.absolutePath, info.size, info.mtimeMs);
      if (!entry || entry.hash === null) { skipped.count += 1; return; }
      hashes[candidate.relativePath] = entry.hash;
      paths.push(candidate.relativePath);
    })));
    for (const path of [...this.entries.keys()]) if (!seen.has(path)) { this.entries.delete(path); this.dirty = true; }
    paths.sort((left, right) => compareSegments(left.split('/'), right.split('/')));
    this.generation += 1;
    const snapshot: SourceSnapshot = { hashes, manifestHash: manifestOf(hashes), paths, skippedFiles: skipped.count, truncated, generation: this.generation };
    this.last = { snapshot, builtAt: Date.now() };
    return snapshot;
  }

  private async walkDir(dir: string, segments: string[], out: Candidate[], skipped: { count: number }): Promise<void> {
    let entries;
    try { entries = await this.io.run(() => readdir(dir, { withFileTypes: true })); } catch { return; }
    const nested: Promise<void>[] = [];
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { nested.push(this.walkDir(path, [...segments, entry.name], out, skipped)); continue; }
      if (!entry.isFile()) continue;
      if (!isIndexableName(entry.name)) { skipped.count += 1; continue; }
      out.push({ relativePath: [...segments, entry.name].join('/'), absolutePath: path, segments: [...segments, entry.name] });
    }
    await Promise.all(nested);
  }

  private async refresh(relativePath: string, absolutePath: string, size: number, mtimeMs: number): Promise<Entry | undefined> {
    const cached = this.entries.get(relativePath);
    const racy = cached ? mtimeMs >= cached.checkedAt - RACY_WINDOW_MS : true;
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && !racy) return cached;
    try {
      const buffer = await readFile(absolutePath);
      const entry: Entry = { size, mtimeMs, hash: buffer.includes(0) ? null : hashText(buffer.toString('utf8')), checkedAt: Date.now() };
      if (!cached || cached.hash !== entry.hash || cached.size !== size || cached.mtimeMs !== mtimeMs) this.dirty = true;
      this.entries.set(relativePath, entry);
      return entry;
    } catch {
      this.entries.delete(relativePath);
      return undefined;
    }
  }
}
