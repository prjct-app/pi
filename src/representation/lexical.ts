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

export type LexicalPosting = Readonly<{ path: string; tf: number }>;
export type LexicalIndex = Readonly<{
  documents: Record<string, { length: number }>;
  invertedIndex: Record<string, LexicalPosting[]>;
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

const emptyInverted = (): Record<string, LexicalPosting[]> => Object.create(null) as Record<string, LexicalPosting[]>;

const termFrequencies = (tokens: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
};

export const buildLexicalIndex = (files: ReadonlyArray<{ path: string; content: string }>): LexicalIndex => {
  const documents: Record<string, { length: number }> = Object.create(null);
  const invertedIndex = emptyInverted();
  let totalLength = 0;

  for (const file of files) {
    const tokens = tokenizeFile(file.content, file.path);
    if (tokens.length === 0) continue;
    documents[file.path] = { length: tokens.length };
    totalLength += tokens.length;
    for (const [token, tf] of termFrequencies(tokens)) {
      const postings = invertedIndex[token] ?? [];
      postings.push({ path: file.path, tf });
      invertedIndex[token] = postings;
    }
  }

  const totalDocs = Object.keys(documents).length;
  return { documents, invertedIndex, avgDocLength: totalDocs > 0 ? totalLength / totalDocs : 0, totalDocs };
};

export const reviveLexicalIndex = (value: LexicalIndex): LexicalIndex => {
  const invertedIndex = emptyInverted();
  for (const [token, postings] of Object.entries(value.invertedIndex ?? {})) invertedIndex[token] = postings;
  return { ...value, invertedIndex };
};

const idf = (docFrequency: number, totalDocs: number): number =>
  Math.log((totalDocs - docFrequency + 0.5) / (docFrequency + 0.5) + 1);

export const scoreLexical = (query: string, index: LexicalIndex): Array<{ path: string; score: number }> => {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0 || index.totalDocs === 0) return [];
  const scores = new Map<string, number>();
  for (const token of queryTokens) {
    const postings = Object.hasOwn(index.invertedIndex, token) ? index.invertedIndex[token] : undefined;
    if (!postings) continue;
    const tokenIdf = idf(postings.length, index.totalDocs);
    for (const posting of postings) {
      const doc = index.documents[posting.path];
      if (!doc) continue;
      const numerator = posting.tf * (BM25_K1 + 1);
      const denominator = posting.tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / (index.avgDocLength || 1)));
      scores.set(posting.path, (scores.get(posting.path) ?? 0) + tokenIdf * (numerator / denominator));
    }
  }
  return [...scores.entries()].map(([path, score]) => ({ path, score })).sort((left, right) => right.score - left.score);
};
