import { posix } from 'node:path';

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

export type ImportGraph = Readonly<{ forward: Record<string, string[]> }>;

const extractImportSources = (content: string): string[] => {
  const sources: string[] = [];
  for (const match of content.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const source = match[1];
    if (source && (source.startsWith('.') || source.startsWith('@/'))) sources.push(source);
  }
  return sources;
};

const resolveImport = (source: string, fromFile: string, files: Set<string>): string | undefined => {
  const base = source.startsWith('@/')
    ? posix.join('src', source.slice(2))
    : posix.normalize(posix.join(posix.dirname(fromFile), source));
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = (base + ext).replace(/^\.\//, '');
    if (files.has(candidate)) return candidate;
  }
  return undefined;
};

export const buildImportGraph = (files: ReadonlyArray<{ path: string; content: string }>): ImportGraph => {
  const known = new Set(files.map(file => file.path));
  const forward: Record<string, string[]> = Object.create(null);
  for (const file of files) {
    const targets = [...new Set(extractImportSources(file.content)
      .map(source => resolveImport(source, file.path, known))
      .filter((path): path is string => Boolean(path)))];
    if (targets.length) forward[file.path] = targets;
  }
  return { forward };
};

export const reverseImports = (graph: ImportGraph): Record<string, string[]> => {
  const reverse: Record<string, string[]> = Object.create(null);
  for (const [from, targets] of Object.entries(graph.forward)) {
    for (const to of targets) {
      const inbound = reverse[to] ?? [];
      inbound.push(from);
      reverse[to] = inbound;
    }
  }
  return reverse;
};
