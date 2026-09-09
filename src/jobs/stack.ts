import type { ProjectProfile } from '../representation/profile.ts';

// Agent-facing stack brief rendered from the mechanical profile. Names what the
// repository declares; it never infers purpose or architecture.
export const renderStack = (profile: ProjectProfile, facts: { indexedFiles: number; skippedFiles: number; truncated: boolean }, maxBytes = 3072): string => {
  const languages = Object.entries(profile.languages).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ext, count]) => `${ext} (${count})`);
  const lines: string[] = ['# Stack', ''];
  lines.push(`Ecosystem: ${profile.ecosystem}. Languages by file count: ${languages.join(', ') || 'none'}.`);
  lines.push(`Indexed ${facts.indexedFiles} files (${facts.skippedFiles} skipped${facts.truncated ? ', capped' : ''}).`);
  if (profile.manifests.length) lines.push(`Manifests: ${profile.manifests.join(', ')}.`);
  if (profile.frameworks.length) lines.push(`Frameworks: ${profile.frameworks.join(', ')}.`);
  if (profile.tools.length) lines.push(`Tools: ${profile.tools.join(', ')}.`);
  if (profile.topDirs.length) lines.push(`Top-level directories: ${profile.topDirs.join(', ')}.`);
  const scripts = Object.entries(profile.scripts);
  if (scripts.length) lines.push('', '## Commands', ...scripts.map(([name, command]) => `- ${name}: \`${command}\``));
  lines.push('', '## Verification');
  lines.push(`- framework: ${profile.tests.framework}`);
  if (profile.tests.command) lines.push(`- run: \`${profile.tests.command}\``);
  if (profile.tests.pattern) lines.push(`- test files: ${profile.tests.pattern}`);
  if (profile.tests.example) lines.push(`- example to imitate: ${profile.tests.example}`);
  if (!profile.hasTests) lines.push('- no test files detected');
  const docs = profile.docs;
  const docParts = [
    docs.title ? `title "${docs.title}"` : null,
    docs.readme ? 'README.md' : null, docs.context ? 'CONTEXT.md glossary' : null, docs.contextMap ? 'CONTEXT-MAP.md' : null,
    docs.agents ? 'AGENTS.md' : null, docs.docFiles ? `${docs.docFiles} files under docs/` : null, docs.adrCount ? `${docs.adrCount} ADRs` : null,
  ].filter(Boolean);
  if (docParts.length) lines.push('', '## Documentation', `- ${docParts.join('; ')}`);
  if (docs.headings.length) lines.push(`- headings: ${docs.headings.slice(0, 8).join(' | ')}`);
  let text = lines.join('\n') + '\n';
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const cut = text.lastIndexOf('\n- ');
    if (cut < 0) { text = text.slice(0, maxBytes); break; }
    text = text.slice(0, cut) + '\n';
  }
  return text;
};
