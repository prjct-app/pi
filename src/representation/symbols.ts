export type SymbolIndex = Record<string, string[]>;

const NAME_PATTERNS = [
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  /export\s+class\s+(\w+)/g,
  /export\s+interface\s+(\w+)/g,
  /export\s+type\s+(\w+)/g,
  /export\s+(?:const|let|var)\s+(\w+)/g,
  /(?:async\s+)?function\s+(\w+)/g,
  /class\s+(\w+)/g,
];

export const extractSymbols = (content: string): string[] => {
  const names = new Set<string>();
  for (const pattern of NAME_PATTERNS) {
    for (const match of content.matchAll(pattern)) if (match[1]) names.add(match[1]);
  }
  return [...names];
};

export const buildSymbolIndex = (files: ReadonlyArray<{ path: string; content: string }>): SymbolIndex => {
  const symbols: SymbolIndex = Object.create(null);
  for (const file of files) {
    const names = extractSymbols(file.content);
    if (names.length) symbols[file.path] = names;
  }
  return symbols;
};
