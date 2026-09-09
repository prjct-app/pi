const BM25_K1 = 1.2;
const BM25_B = 0.75;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'from', 'by', 'as', 'or', 'and', 'but', 'if',
  'not', 'no', 'so', 'up', 'out', 'this', 'that', 'it', 'its', 'all', 'any',
  'import', 'export', 'default', 'const', 'let', 'var', 'function', 'class', 'interface',
  'type', 'return', 'new', 'true', 'false', 'null', 'undefined', 'void', 'async', 'await',
  'static', 'public', 'private', 'protected', 'readonly', 'string', 'number', 'boolean',
  'object', 'array',
]);

// Compact on-disk shape: paths are interned once and postings are flat
// [docId, tf, docId, tf, ...] arrays per token. Deleted documents leave a
// tombstone (empty path) so incremental updates never renumber survivors.
export type LexicalIndex = Readonly<{
  v: 2;
  paths: string[];
  docLengths: number[];
  postings: Record<string, number[]>;
  avgDocLength: number;
  totalDocs: number;
}>;

export const splitIdentifier = (identifier: string): string[] => identifier
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .replace(/[-_./]/g, ' ')
  .toLowerCase()
  .split(/[^\p{L}\p{N}]+/u)
  .filter(word => word.length > 1);

const keepToken = (token: string): boolean => token.length > 1 && !STOP_WORDS.has(token) && /^[\p{L}][\p{L}\p{N}]*$/u.test(token);

export const tokenizeFile = (content: string, filePath: string): string[] => {
  // General text coverage is the baseline; declarations/path tokens add ranking signals.
  const tokens: string[] = content.normalize('NFC').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const pathParts = filePath.replace(/\.[^.]+$/, '').split(/[/\\]/).filter(Boolean);
  for (const part of pathParts) tokens.push(...splitIdentifier(part));

  const exportPatterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+default\s+(?:class|function)\s+(\w+)/g,
  ];
  for (const pattern of exportPatterns) {
    for (const match of content.matchAll(pattern)) if (match[1]) tokens.push(...splitIdentifier(match[1]));
  }

  const declPatterns = [
    /(?:async\s+)?function\s+(\w+)/g,
    /class\s+(\w+)/g,
    /interface\s+(\w+)/g,
    /type\s+(\w+)\s*=/g,
  ];
  for (const pattern of declPatterns) {
    for (const match of content.matchAll(pattern)) if (match[1]) tokens.push(...splitIdentifier(match[1]));
  }

  for (const match of content.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const source = match[1];
    if (!source) continue;
    if (source.startsWith('.') || source.startsWith('@/')) tokens.push(...splitIdentifier(source));
    else {
      const pkg = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
      if (pkg) tokens.push(...splitIdentifier(pkg));
    }
  }

  for (const match of content.matchAll(/\/\/\s*(.+)/g)) {
    const words = match[1]?.toLowerCase().split(/\s+/).filter(word => word.length > 2) ?? [];
    tokens.push(...words);
  }
  for (const match of content.matchAll(/\/\*\*?([\s\S]*?)\*\//g)) {
    const words = (match[1] ?? '').replace(/@\w+/g, '').replace(/\*/g, '').toLowerCase()
      .split(/\s+/).filter(word => word.length > 2 && /^[a-z]+$/.test(word));
    tokens.push(...words);
  }

  return tokens.filter(keepToken);
};

export const tokenizeQuery = (query: string): string[] => query
  .split(/\s+/)
  .flatMap(word => splitIdentifier(word))
  .filter(keepToken);

// Symbol boost: both sides pass the same splitter and stop-word filter.
export const symbolMatchesQuery = (symbolName: string, query: string): boolean => {
  const queryTokens = new Set(tokenizeQuery(query));
  const parts = splitIdentifier(symbolName).filter(keepToken);
  return parts.length > 0 && parts.every(part => queryTokens.has(part));
};

const emptyPostings = (): Record<string, number[]> => Object.create(null) as Record<string, number[]>;

const termFrequencies = (tokens: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
};

// Mutable builder used for full and incremental builds. `remove` tombstones a
// document and strips its postings; `add` appends a new docId.
export class LexicalBuilder {
  readonly paths: string[];
  readonly docLengths: number[];
  readonly postings: Record<string, number[]>;
  private readonly docIds = new Map<string, number>();
  private totalLength = 0;

  constructor(previous?: LexicalIndex) {
    this.paths = previous ? [...previous.paths] : [];
    this.docLengths = previous ? [...previous.docLengths] : [];
    this.postings = emptyPostings();
    if (previous) for (const [token, list] of Object.entries(previous.postings)) this.postings[token] = [...list];
    this.paths.forEach((path, id) => { if (path) { this.docIds.set(path, id); this.totalLength += this.docLengths[id] ?? 0; } });
  }

  has(path: string): boolean { return this.docIds.has(path); }

  remove(path: string): void {
    const id = this.docIds.get(path);
    if (id === undefined) return;
    this.docIds.delete(path);
    this.totalLength -= this.docLengths[id] ?? 0;
    this.paths[id] = '';
    this.docLengths[id] = 0;
    for (const [token, list] of Object.entries(this.postings)) {
      const at = list.indexOf(id);
      if (at < 0 || at % 2 !== 0) { // ensure we matched a docId slot, not a tf value
        let found = -1;
        for (let i = 0; i < list.length; i += 2) if (list[i] === id) { found = i; break; }
        if (found < 0) continue;
        list.splice(found, 2);
      } else list.splice(at, 2);
      if (!list.length) delete this.postings[token];
    }
  }

  add(path: string, content: string): void {
    if (this.docIds.has(path)) this.remove(path);
    const tokens = tokenizeFile(content, path);
    if (tokens.length === 0) return;
    const id = this.paths.length;
    this.paths.push(path);
    this.docLengths.push(tokens.length);
    this.docIds.set(path, id);
    this.totalLength += tokens.length;
    for (const [token, tf] of termFrequencies(tokens)) (this.postings[token] ??= []).push(id, tf);
  }

  finish(): LexicalIndex {
    const totalDocs = this.docIds.size;
    return { v: 2, paths: this.paths, docLengths: this.docLengths, postings: this.postings, avgDocLength: totalDocs > 0 ? this.totalLength / totalDocs : 0, totalDocs };
  }
}

export const buildLexicalIndex = (files: ReadonlyArray<{ path: string; content: string }>): LexicalIndex => {
  const builder = new LexicalBuilder();
  for (const file of files) builder.add(file.path, file.content);
  return builder.finish();
};

// Only the compact shape is accepted; older records force a rebuild through
// INDEX_CONFIG_REVISION rather than being interpreted by guesswork.
export const reviveLexicalIndex = (value: LexicalIndex): LexicalIndex => {
  if ((value as { v?: number }).v !== 2 || !Array.isArray(value.paths)) {
    throw Object.assign(new Error('Lexical index uses an unsupported encoding; rebuild the index.'), { code: 'UNSUPPORTED_SCHEMA' });
  }
  const postings = emptyPostings();
  for (const [token, list] of Object.entries(value.postings ?? {})) postings[token] = list;
  return { ...value, postings };
};

const idf = (docFrequency: number, totalDocs: number): number =>
  Math.log((totalDocs - docFrequency + 0.5) / (docFrequency + 0.5) + 1);

export const scoreLexical = (query: string, index: LexicalIndex): Array<{ path: string; score: number }> => {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0 || index.totalDocs === 0) return [];
  const scores = new Map<number, number>();
  for (const token of queryTokens) {
    const list = Object.hasOwn(index.postings, token) ? index.postings[token] : undefined;
    if (!list) continue;
    const tokenIdf = idf(list.length / 2, index.totalDocs);
    for (let i = 0; i < list.length; i += 2) {
      const docId = list[i]!, tf = list[i + 1]!;
      const length = index.docLengths[docId] ?? 0;
      if (!index.paths[docId]) continue;
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (length / (index.avgDocLength || 1)));
      scores.set(docId, (scores.get(docId) ?? 0) + tokenIdf * (numerator / denominator));
    }
  }
  return [...scores.entries()].map(([docId, score]) => ({ path: index.paths[docId]!, score })).sort((left, right) => right.score - left.score);
};
