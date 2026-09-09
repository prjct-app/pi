import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { sha256 } from '../workspace/ids.ts';
import { buildImportGraph, type ImportGraph } from './imports.ts';
import { buildLexicalIndex, reviveLexicalIndex, type LexicalIndex } from './lexical.ts';
import { detectProfile, type ProjectProfile } from './profile.ts';
import { INDEX_CONFIG_REVISION, INDEX_EXTENSIONS, MAX_INDEX_FILE_BYTES, MAX_INDEX_FILES, SKIP_DIRS } from './skip.ts';
import { buildSymbolIndex, type SymbolIndex } from './symbols.ts';

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

export type IndexableFile = Readonly<{ relativePath: string; contentHash: string; content: string }>;

export type CollectedSources = Readonly<{
  files: readonly IndexableFile[];
  hashes: Record<string, string>;
  manifestHash: string;
  skippedFiles: number;
  truncated: boolean;
}>;

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

const walk = async (root: string, dir: string, files: IndexableFile[], skipped: { count: number }): Promise<void> => {
  if (files.length >= MAX_INDEX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= MAX_INDEX_FILES) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path, files, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!INDEX_EXTENSIONS.has(extension) && !['Gemfile', 'requirements.txt', 'go.mod'].includes(entry.name)) {
      skipped.count += 1;
      continue;
    }
    try {
      const info = await stat(path);
      if (info.size > MAX_INDEX_FILE_BYTES) {
        skipped.count += 1;
        continue;
      }
      const buffer = await readFile(path);
      if (buffer.includes(0)) {
        skipped.count += 1;
        continue;
      }
      const content = buffer.toString('utf8');
      const relativePath = relative(root, path).split('\\').join('/');
      files.push({ relativePath, contentHash: hashText(content), content });
    } catch {
      skipped.count += 1;
    }
  }
};

export const collectIndexable = async (root: string): Promise<CollectedSources> => {
  const files: IndexableFile[] = [];
  const skipped = { count: 0 };
  await walk(root, root, files, skipped);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const truncated = files.length >= MAX_INDEX_FILES;
  const hashes: Record<string, string> = Object.create(null);
  for (const file of files) hashes[file.relativePath] = file.contentHash;
  const manifestHash = hashText(files.map(file => `${file.relativePath}:${file.contentHash}`).join('\n'));
  return { files, hashes, manifestHash, skippedFiles: skipped.count, truncated };
};

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
export const buildCochange = (root: string, known: ReadonlySet<string>, limit = 200): Record<string, string[]> => {
  let log: string;
  try {
    log = execFileSync('git', ['log', `--max-count=${limit}`, '--name-only', '--pretty=format:--commit--'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
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

export const buildProjectIndex = async (
  collected: CollectedSources,
  meta: { checkoutId: string; appliedRevision: number },
  root?: string,
): Promise<ProjectIndex> => {
  const files = collected.files.map(file => ({ path: file.relativePath, content: file.content }));
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
    lexical: buildLexicalIndex(files),
    imports: buildImportGraph(files),
    symbols: buildSymbolIndex(files),
    cochange: root ? buildCochange(root, new Set(files.map(file => file.path))) : Object.create(null),
    profile,
    indexedFiles: collected.files.length,
    skippedFiles: collected.skippedFiles,
    truncated: collected.truncated,
  };
};

export const reviveProjectIndex = (value: ProjectIndex): ProjectIndex => ({
  ...value,
  lexical: reviveLexicalIndex(value.lexical),
});
