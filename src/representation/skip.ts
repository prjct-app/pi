export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', '.vercel', '.parcel-cache', '__pycache__', '.pytest_cache',
  'target', 'vendor', '.venv', 'venv', '.prjct', '.worktrees', '.pi',
]);

export const INDEX_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.md', '.mdx', '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.rb', '.php', '.cs', '.vue', '.svelte', '.json', '.toml',
]);

export const MAX_INDEX_FILE_BYTES = 256 * 1024;
export const MAX_INDEX_FILES = 8000;
export const INDEX_CONFIG_REVISION = 7;
