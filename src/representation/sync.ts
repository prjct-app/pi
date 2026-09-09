import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../workspace/ids.ts';
import { resolveImportsOf, type ImportGraph } from './imports.ts';
import { LexicalBuilder, reviveLexicalIndex, type LexicalIndex } from './lexical.ts';
import { detectProfile, type ProjectProfile } from './profile.ts';
import { INDEX_CONFIG_REVISION } from './skip.ts';
import { SourceCache, type CollectedSources, type IndexableFile } from './source-cache.ts';
import { extractSymbols, type SymbolIndex } from './symbols.ts';

export const sourceId = (relativePath: string): string => `src_${sha256(relativePath).slice(0, 12)}`;

export type ProjectIndex = Readonly<{
  checkoutId: string;
  configRevision: number;
  appliedRevision: number;
  manifestHash: string;
  hashes: Record<string, string>;
  lexical: LexicalIndex;
  imports: ImportGraph;
  symbols: SymbolIndex;
  cochange: Record<string, string[]>;
  profile: ProjectProfile;
  indexedFiles: number;
  skippedFiles: number;
  truncated: boolean;
}>;

export type { CollectedSources, IndexableFile };

export { hashText } from './source-cache.ts';

// Full collection with contents. Delegates to a throwaway SourceCache so the
// walk order, hashing and manifest rules live in exactly one place.
export const collectIndexable = async (root: string): Promise<CollectedSources> => new SourceCache(root).collectAll();

export const diffHashes = (previous: Record<string, string>, current: Record<string, string>) => {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    if (!(path in previous)) added.push(path);
    else if (previous[path] !== hash) modified.push(path);
  }
  for (const path of Object.keys(previous)) {
    if (!(path in current)) deleted.push(path);
  }
  return { added, modified, deleted };
};

export const observedRevision = (stored: ProjectIndex | undefined, manifestHash: string): number => {
  if (!stored) return 1;
  if (stored.manifestHash === manifestHash) return stored.appliedRevision;
  return stored.appliedRevision + 1;
};

// Correlation, not causality: files that changed together in recent history.
// Read-only git; absent history yields an empty matrix, never a failure.
export const MIN_COCHANGE_OCCURRENCES = 2;
const execFileAsync = promisify(execFile);
export const buildCochange = async (root: string, known: ReadonlySet<string>, limit = 200, signal?: AbortSignal): Promise<Record<string, string[]>> => {
  let log: string;
  try {
    ({ stdout: log } = await execFileAsync('git', ['log', `--max-count=${limit}`, '--name-only', '--pretty=format:--commit--'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) }));
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    return Object.create(null);
  }
  const pairs = new Map<string, number>();
  for (const block of log.split('--commit--')) {
    const files = [...new Set(block.split('\n').map(line => line.trim()).filter(line => line && known.has(line)))];
    for (let left = 0; left < files.length; left += 1) {
      for (let right = left + 1; right < files.length; right += 1) {
        const key = [files[left]!, files[right]!].sort().join('\0');
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const matrix: Record<string, string[]> = Object.create(null);
  for (const [key, count] of pairs) {
    if (count < MIN_COCHANGE_OCCURRENCES) continue;
    const [left, right] = key.split('\0');
    if (!left || !right) continue;
    (matrix[left] ??= []).push(right);
    (matrix[right] ??= []).push(left);
  }
  return matrix;
};

export type BuildOptions = Readonly<{ signal?: AbortSignal; onProgress?: (done: number, total: number) => void; chunkSize?: number }>;
const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

type Sources = ReadonlyArray<{ path: string; content: string }>;

// One pass over the given files, yielding to the event loop between chunks so
// a large checkout never freezes the session that hosts it. With `previous`,
// only the given (changed) files are re-tokenized and `deleted` paths are
// removed; everything else is carried over.
const buildParts = async (
  files: Sources, known: ReadonlySet<string>, options: BuildOptions,
  previous?: { index: ProjectIndex; deleted: readonly string[] },
): Promise<{ lexical: LexicalIndex; forward: Record<string, string[]>; symbols: SymbolIndex; retokenized: number }> => {
  const chunkSize = options.chunkSize ?? 100;
  const lexical = new LexicalBuilder(previous?.index.lexical);
  const forward: Record<string, string[]> = Object.create(null);
  const symbols: SymbolIndex = Object.create(null);
  if (previous) {
    for (const [path, targets] of Object.entries(previous.index.imports.forward)) if (known.has(path)) forward[path] = targets.filter(target => known.has(target));
    for (const [path, names] of Object.entries(previous.index.symbols)) if (known.has(path)) symbols[path] = names;
    for (const path of previous.deleted) { lexical.remove(path); delete forward[path]; delete symbols[path]; }
  }
  for (let start = 0; start < files.length; start += chunkSize) {
    options.signal?.throwIfAborted();
    for (const file of files.slice(start, start + chunkSize)) {
      lexical.add(file.path, file.content);
      const targets = resolveImportsOf(file, known);
      if (targets.length) forward[file.path] = targets; else delete forward[file.path];
      const names = extractSymbols(file.content);
      if (names.length) symbols[file.path] = names; else delete symbols[file.path];
    }
    options.onProgress?.(Math.min(start + chunkSize, files.length), files.length);
    if (start + chunkSize < files.length) await yieldToLoop();
  }
  for (const [path, targets] of Object.entries(forward)) { const kept = targets.filter(target => known.has(target)); if (kept.length) forward[path] = kept; else delete forward[path]; }
  return { lexical: lexical.finish(), forward, symbols, retokenized: files.length };
};

export const buildProjectIndex = async (
  collected: CollectedSources,
  meta: { checkoutId: string; appliedRevision: number },
  root?: string,
  options: BuildOptions = {},
): Promise<ProjectIndex> => {
  const files = collected.files.map(file => ({ path: file.relativePath, content: file.content }));
  const known = new Set(files.map(file => file.path));
  const parts = await buildParts(files, known, options);
  const profile = root ? await detectProfile(root, collected.files) : {
    ecosystem: 'unknown', languages: {} as Record<string, number>, frameworks: [] as string[], tools: [] as string[],
    scripts: {} as Record<string, string>, topDirs: [] as string[], hasTests: false, manifests: [] as string[],
    docs: { readme: false, context: false, contextMap: false, agents: false, adrCount: 0, docFiles: 0, headings: [] as string[] },
    tests: { framework: 'unknown' },
  };
  return {
    checkoutId: meta.checkoutId,
    configRevision: INDEX_CONFIG_REVISION,
    appliedRevision: meta.appliedRevision,
    manifestHash: collected.manifestHash,
    hashes: collected.hashes,
    lexical: parts.lexical,
    imports: { forward: parts.forward },
    symbols: parts.symbols,
    cochange: root ? await buildCochange(root, known, 200, options.signal) : Object.create(null),
    profile,
    indexedFiles: collected.files.length,
    skippedFiles: collected.skippedFiles,
    truncated: collected.truncated,
  };
};

export type IncrementalInput = Readonly<{
  previous: ProjectIndex;
  /** Contents of added and modified files only. */
  changed: readonly IndexableFile[];
  /** Full current hashes and manifest (from the snapshot). */
  hashes: Record<string, string>;
  manifestHash: string;
  skippedFiles: number;
  truncated: boolean;
}>;

// Incremental rebuild: re-tokenize only what changed. The profile is refreshed
// from the current file list (manifests are re-read from disk when not in `changed`).
export const updateProjectIndex = async (
  input: IncrementalInput,
  meta: { checkoutId: string; appliedRevision: number },
  root?: string,
  options: BuildOptions = {},
): Promise<ProjectIndex & { retokenized: number }> => {
  const known = new Set(Object.keys(input.hashes));
  const deleted = Object.keys(input.previous.hashes).filter(path => !known.has(path));
  const files = input.changed.map(file => ({ path: file.relativePath, content: file.content }));
  const parts = await buildParts(files, known, options, { index: input.previous, deleted });
  const byPath = new Map(input.changed.map(file => [file.relativePath, file]));
  const profileSources = [...known].sort((a, b) => a.localeCompare(b)).map(path => byPath.get(path) ?? { relativePath: path });
  const profile = root ? await detectProfile(root, profileSources) : input.previous.profile;
  return {
    checkoutId: meta.checkoutId,
    configRevision: INDEX_CONFIG_REVISION,
    appliedRevision: meta.appliedRevision,
    manifestHash: input.manifestHash,
    hashes: input.hashes,
    lexical: parts.lexical,
    imports: { forward: parts.forward },
    symbols: parts.symbols,
    cochange: root ? await buildCochange(root, known, 200, options.signal) : input.previous.cochange,
    profile,
    indexedFiles: known.size,
    skippedFiles: input.skippedFiles,
    truncated: input.truncated,
    retokenized: parts.retokenized,
  };
};

export const reviveProjectIndex = (value: ProjectIndex): ProjectIndex => ({
  ...value,
  lexical: reviveLexicalIndex(value.lexical),
});
