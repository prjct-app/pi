import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SKIP_DIRS } from './skip.ts';

export type SourceFile = Readonly<{ relativePath: string; contentHash: string }>;
export type SourceInspection = Readonly<{ files: readonly SourceFile[]; manifestHash: string }>;

const walk = async (root: string, dir: string): Promise<SourceFile[]> => {
  const files: SourceFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) {
      files.push({
        relativePath: relative(root, path),
        contentHash: createHash('sha256').update(await readFile(path)).digest('hex'),
      });
    }
  }
  return files;
};

// Mechanical listing/hashing only. Does not index, refresh, or write the checkout.
export const inspectSources = async (root: string): Promise<SourceInspection> => {
  const files = (await walk(root, root)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifestHash = createHash('sha256').update(files.map(item => `${item.relativePath}:${item.contentHash}`).join('\n')).digest('hex');
  return { files, manifestHash };
};
