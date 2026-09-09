export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', '.vercel', '.parcel-cache', '__pycache__', '.pytest_cache',
  'target', 'vendor', '.venv', 'venv', '.prjct', '.worktrees', '.pi',
  // Agent scratch, editor state and generated output are never project sources.
  '.claude', '.cursor', '.idea', '.vscode', '.svelte-kit', '.output', 'storybook-static',
  '.expo', '.gradle', '.dart_tool', 'Pods', 'DerivedData', '.terraform', '.tox', '.mypy_cache',
]);

// Files with an indexable extension that are generated or lockfiles: they bloat
// the index and never carry conventions worth retrieving.
export const SKIP_FILE_PATTERNS: readonly RegExp[] = [
  /\.min\.(js|css|mjs)$/i, /\.map$/i, /\.snap$/i, /\.lock$/i,
  /^(package-lock|npm-shrinkwrap|composer|Gemfile|Cargo|poetry|flake)\.(json|lock)$/i, /^(pnpm-lock|yarn)\./i,
];
export const isSkippedFile = (name: string): boolean => SKIP_FILE_PATTERNS.some(pattern => pattern.test(name));

export const INDEX_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.md', '.mdx', '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.rb', '.php', '.cs', '.vue', '.svelte', '.json', '.toml',
]);

export const MAX_INDEX_FILE_BYTES = 256 * 1024;
export const MAX_INDEX_FILES = 8000;
export const INDEX_CONFIG_REVISION = 8;
