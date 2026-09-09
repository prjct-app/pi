import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type ProjectProfile = Readonly<{
  ecosystem: string;
  languages: Record<string, number>;
  frameworks: string[];
  tools: string[];
  scripts: Record<string, string>;
  topDirs: string[];
  hasTests: boolean;
  manifests: string[];
  docs: Readonly<{
    title?: string;
    readme: boolean; context: boolean; contextMap: boolean; agents: boolean;
    adrCount: number; docFiles: number; headings: string[];
  }>;
  tests: Readonly<{
    framework: string;
    command?: string;
    pattern?: string;
    example?: string;
  }>;
}>;

type ProfileSource = Readonly<{ relativePath: string; content?: string }>;

// Contents come from the collected sources when present; disk is the fallback
// for callers that only know paths (and for manifests outside the index rules).
const makeReaders = (root: string, files: readonly ProfileSource[]) => {
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  const readText = async (name: string): Promise<string | undefined> => {
    const known = byPath.get(name);
    if (known?.content !== undefined) return known.content;
    return readFile(join(root, name), 'utf8').catch(() => undefined);
  };
  const exists = async (name: string): Promise<boolean> => {
    if (byPath.has(name)) return true;
    return stat(join(root, name)).then(info => info.isFile(), () => false);
  };
  const readJson = async (name: string): Promise<Record<string, unknown> | undefined> => {
    const text = await readText(name);
    if (text === undefined) return undefined;
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; }
  };
  return { readText, exists, readJson };
};

// Mechanical profile only: manifests, scripts, file census. It names what the
// repo declares; purpose, patterns and architecture remain agent-synthesized
// claims with evidence, never conclusions drawn from file counts alone.
export const detectProfile = async (root: string, files: readonly ProfileSource[]): Promise<ProjectProfile> => {
  const { readText, exists, readJson } = makeReaders(root, files);
  const languages: Record<string, number> = Object.create(null);
  for (const file of files) {
    const match = file.relativePath.match(/\.([a-z0-9]+)$/i);
    if (match) languages[match[1]!.toLowerCase()] = (languages[match[1]!.toLowerCase()] ?? 0) + 1;
  }

  const topDirs = [...new Set(files.map(file => file.relativePath.split('/')[0]!).filter(part => !part.includes('.')))].sort().slice(0, 12);

  const manifests: string[] = [];
  const frameworks = new Set<string>();
  const tools = new Set<string>();
  const scripts: Record<string, string> = {};
  let ecosystem = 'unknown';

  const pkg = await readJson('package.json');
  if (pkg) {
    manifests.push('package.json');
    ecosystem = 'node';
    const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
    const names = Object.keys(deps ?? {});
    for (const [name, framework] of [
      ['next', 'next'], ['react', 'react'], ['vue', 'vue'], ['svelte', 'svelte'], ['@angular/core', 'angular'],
      ['express', 'express'], ['fastify', 'fastify'], ['hono', 'hono'], ['@nestjs/core', 'nestjs'],
      ['vitest', 'vitest'], ['jest', 'jest'], ['mocha', 'mocha'], ['playwright', 'playwright'],
      ['typescript', 'typescript'], ['drizzle-orm', 'drizzle'], ['prisma', 'prisma'], ['zod', 'zod'], ['typebox', 'typebox'],
    ] as const) {
      if (names.includes(name)) tools.add(framework);
    }
    if (names.some(name => name.startsWith('@earendil-works/'))) frameworks.add('pi-extension');
    const pkgScripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const name of ['test', 'build', 'lint', 'typecheck', 'check', 'dev']) {
      if (pkgScripts[name]) scripts[name] = pkgScripts[name]!;
    }
  }
  if (await exists('tsconfig.json')) { manifests.push('tsconfig.json'); tools.add('typescript'); }
  const [hasCargo = false, hasGo = false, hasPyproject = false, hasRequirements = false, hasSwift = false, hasGemfile = false, hasContextMap = false] = await Promise.all(
    ['Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Package.swift', 'Gemfile', 'CONTEXT-MAP.md'].map(exists));
  if (hasCargo) { manifests.push('Cargo.toml'); ecosystem = ecosystem === 'unknown' ? 'rust' : ecosystem; }
  if (hasGo) { manifests.push('go.mod'); ecosystem = ecosystem === 'unknown' ? 'go' : ecosystem; }
  if (hasPyproject || hasRequirements) {
    if (hasPyproject) manifests.push('pyproject.toml');
    if (hasRequirements) manifests.push('requirements.txt');
    ecosystem = ecosystem === 'unknown' ? 'python' : ecosystem;
    if (hasPyproject) {
      const text = (await readText('pyproject.toml')) ?? '';
      if (text.includes('fastapi')) frameworks.add('fastapi');
      if (text.includes('django')) frameworks.add('django');
      if (text.includes('pytest')) tools.add('pytest');
    }
  }
  if (hasSwift) { manifests.push('Package.swift'); ecosystem = ecosystem === 'unknown' ? 'swift' : ecosystem; }
  if (hasGemfile) { manifests.push('Gemfile'); ecosystem = ecosystem === 'unknown' ? 'ruby' : ecosystem; }

  const hasTests = files.some(file => /(^|\/)(tests?|__tests__|spec)\//.test(file.relativePath) || /\.(test|spec)\.[a-z]+$/.test(file.relativePath));

  // Documentation layer — language-agnostic. A docs-only project (pure MD) is
  // understood through its glossary, ADRs and headings, not through manifests.
  const markdown = files.filter(file => /\.mdx?$/i.test(file.relativePath));
  const docFiles = markdown.filter(file => file.relativePath.toLowerCase().startsWith('docs/')).length;
  const adrCount = markdown.filter(file => /(^|\/)docs\/adr\//i.test(file.relativePath)).length;
  const headings: string[] = [];
  let title: string | undefined;
  const readHeadings = async (name: string): Promise<boolean> => {
    const file = markdown.find(item => item.relativePath.toLowerCase() === name.toLowerCase());
    if (!file) return false;
    const text = (await readText(file.relativePath)) ?? '';
    const found = text.split('\n').map(line => line.trim()).filter(line => /^#{1,2}\s/.test(line)).map(line => line.replace(/^#{1,2}\s+/, ''));
    if (!title && found[0]) title = found[0];
    headings.push(...found.slice(0, 6));
    return true;
  };
  const readme = await readHeadings('README.md');
  const context = await readHeadings('CONTEXT.md');
  const contextMap = hasContextMap;
  const agents = await readHeadings('AGENTS.md');
  const docs = { ...(title ? { title } : {}), readme, context, contextMap, agents, adrCount, docFiles, headings: headings.slice(0, 12) };
  if (ecosystem === 'unknown' && markdown.length && (languages.md ?? 0) + (languages.mdx ?? 0) >= Math.max(1, files.length / 2)) {
    ecosystem = 'documentation';
  }

  // Test convention — the one thing a task brief must answer without asking:
  // framework, exact command, file pattern, and a real example to imitate.
  const testFiles = files.filter(file => /\.(test|spec)\.[a-z]+$/.test(file.relativePath)
    || /(^|\/)(tests?|__tests__|spec)\//.test(file.relativePath));
  const example = testFiles[0]?.relativePath;
  const testScript = scripts.test ?? scripts.check;
  let framework = 'unknown';
  if (testScript) {
    if (/vitest/.test(testScript)) framework = 'vitest';
    else if (/jest/.test(testScript)) framework = 'jest';
    else if (/\bnode\b[^;&\n]*\s--test\b|node:test/.test(testScript)) framework = 'node:test';
    else if (/pytest/.test(testScript)) framework = 'pytest';
    else if (/cargo\s+test/.test(testScript)) framework = 'cargo';
    else if (/go\s+test/.test(testScript)) framework = 'go';
    else framework = testScript.split(' ')[0] ?? 'unknown';
  } else if (testFiles.some(file => file.relativePath.endsWith('.py'))) framework = 'pytest';
  else if (testFiles.some(file => /_test\.go$/.test(file.relativePath))) framework = 'go';
  else if (hasCargo) framework = 'cargo';
  else if (hasSwift) framework = 'swift';
  else if (testFiles.length) {
    const examples = await Promise.all(testFiles.slice(0, 8).map(file => readText(file.relativePath).then(text => text ?? '')));
    if (examples.some(text => /['"]node:test['"]/.test(text))) framework = 'node:test';
  }
  const pattern = testFiles.length
    ? (testFiles.every(file => /\.test\.tsx?$/.test(file.relativePath)) ? '**/*.test.ts'
      : testFiles.every(file => /_test\.go$/.test(file.relativePath)) ? '**/*_test.go'
      : testFiles.every(file => /^tests?\//.test(file.relativePath)) ? 'tests/**'
      : testFiles.every(file => /__tests__\//.test(file.relativePath)) ? '__tests__/**'
      : example)
    : undefined;
  const tests = { framework,
    ...(testScript ? { command: testScript } : framework !== 'unknown' && !testScript
      ? { command: framework === 'cargo' ? 'cargo test' : framework === 'go' ? 'go test ./...' : framework === 'swift' ? 'swift test' : framework === 'pytest' ? 'pytest' : 'node --test' }
      : {}),
    ...(pattern ? { pattern } : {}),
    ...(example ? { example } : {}) };

  return { ecosystem, languages, frameworks: [...frameworks], tools: [...tools], scripts, topDirs, hasTests, manifests, docs, tests };
};
