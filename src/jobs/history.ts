import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactSecrets } from '../knowledge/redact.ts';

// Mechanical git history: what shipped (tags, changelog), where the churn is,
// what moves together, and what the recent commit stream is about. Read-only
// git, async, bounded. Absent history yields an honest empty report.

const execFileAsync = promisify(execFile);
const RS = '\x1f';

export type HistoryCommit = Readonly<{ sha: string; author: string; date: string; subject: string; files: readonly string[] }>;
export type ProjectHistory = Readonly<{
  head: string;
  branch: string;
  commitCount: number;
  firstDate?: string;
  lastDate?: string;
  contributors: ReadonlyArray<{ name: string; commits: number }>;
  hotspots: ReadonlyArray<{ path: string; touches: number }>;
  releases: ReadonlyArray<{ tag: string; date: string }>;
  commitsSinceRelease: number;
  themes: ReadonlyArray<{ type: string; count: number }>;
  scopes: ReadonlyArray<{ scope: string; count: number }>;
  recent: ReadonlyArray<{ sha: string; date: string; subject: string }>;
  changelogHeadings: readonly string[];
}>;

const git = async (cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) });
    return stdout.trim();
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    return undefined;
  }
};

export const gitHead = async (cwd: string, signal?: AbortSignal): Promise<string> => (await git(cwd, ['rev-parse', 'HEAD'], signal)) ?? 'none';

const parseLog = (raw: string): HistoryCommit[] => {
  const commits: HistoryCommit[] = [];
  for (const block of raw.split('\x1e')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const [header, ...rest] = trimmed.split('\n');
    const [sha, author, date, subject] = (header ?? '').split(RS);
    if (!sha) continue;
    commits.push({ sha, author: author ?? '', date: date ?? '', subject: redactSecrets(subject ?? '').slice(0, 200),
      files: rest.map(line => line.trim()).filter(Boolean) });
  }
  return commits;
};

const top = <T extends string>(counts: Map<T, number>, limit: number): Array<{ key: T; count: number }> =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit).map(([key, count]) => ({ key, count }));

export type HistoryOptions = Readonly<{ maxCommits?: number; known?: ReadonlySet<string>; changelog?: string; signal?: AbortSignal }>;

export const collectHistory = async (cwd: string, options: HistoryOptions = {}): Promise<ProjectHistory | undefined> => {
  const head = await git(cwd, ['rev-parse', 'HEAD'], options.signal);
  if (!head) return undefined;
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], options.signal)) ?? 'HEAD';
  const limit = options.maxCommits ?? 500;
  const raw = (await git(cwd, ['log', `--max-count=${limit}`, '--date=iso-strict', `--pretty=format:%x1e%H${RS}%an${RS}%ad${RS}%s`, '--name-only'], options.signal)) ?? '';
  const commits = parseLog(raw);
  const total = Number((await git(cwd, ['rev-list', '--count', 'HEAD'], options.signal)) ?? commits.length);
  const tags = ((await git(cwd, ['tag', '--sort=-creatordate', '--format=%(refname:short)\t%(creatordate:iso-strict)'], options.signal)) ?? '')
    .split('\n').filter(Boolean).map(line => { const [tag = '', date = ''] = line.split('\t'); return { tag, date }; }).slice(0, 20);
  const latestTag = tags[0]?.tag;
  const sinceRelease = latestTag ? Number((await git(cwd, ['rev-list', '--count', `${latestTag}..HEAD`], options.signal)) ?? 0) : commits.length;

  const contributors = new Map<string, number>();
  const touches = new Map<string, number>();
  const types = new Map<string, number>();
  const scopes = new Map<string, number>();
  for (const commit of commits) {
    if (commit.author) contributors.set(commit.author, (contributors.get(commit.author) ?? 0) + 1);
    for (const file of commit.files) {
      if (options.known && !options.known.has(file)) continue;
      touches.set(file, (touches.get(file) ?? 0) + 1);
    }
    const conventional = commit.subject.match(/^(\w+)(?:\(([^)]+)\))?!?:/);
    if (conventional) {
      types.set(conventional[1]!.toLowerCase(), (types.get(conventional[1]!.toLowerCase()) ?? 0) + 1);
      if (conventional[2]) scopes.set(conventional[2], (scopes.get(conventional[2]) ?? 0) + 1);
    } else if (/^merge\b/i.test(commit.subject)) types.set('merge', (types.get('merge') ?? 0) + 1);
    else types.set('other', (types.get('other') ?? 0) + 1);
  }
  const changelogHeadings = (options.changelog ?? '').split('\n').map(line => line.trim())
    .filter(line => /^#{1,3}\s/.test(line)).map(line => line.replace(/^#{1,3}\s+/, '').slice(0, 80)).slice(0, 8);
  return {
    head, branch, commitCount: total,
    ...(commits.at(-1)?.date ? { firstDate: commits.at(-1)!.date } : {}),
    ...(commits[0]?.date ? { lastDate: commits[0]!.date } : {}),
    contributors: top(contributors, 5).map(item => ({ name: item.key, commits: item.count })),
    hotspots: top(touches, 12).map(item => ({ path: item.key, touches: item.count })),
    releases: tags,
    commitsSinceRelease: sinceRelease,
    themes: top(types, 8).map(item => ({ type: item.key, count: item.count })),
    scopes: top(scopes, 8).map(item => ({ scope: item.key, count: item.count })),
    recent: commits.slice(0, 15).map(commit => ({ sha: commit.sha.slice(0, 10), date: commit.date.slice(0, 10), subject: commit.subject })),
    changelogHeadings,
  };
};

const day = (iso?: string): string => (iso ?? '').slice(0, 10) || 'unknown';

// Agent-facing summary, bounded. Facts only; no inferred intent.
export const renderHistory = (history: ProjectHistory | undefined, maxBytes = 4096): string => {
  if (!history) return '# History\n\nNo git history is available for this checkout.\n';
  const lines: string[] = ['# History', ''];
  lines.push(`Branch ${history.branch} at ${history.head.slice(0, 10)}; ${history.commitCount} commits from ${day(history.firstDate)} to ${day(history.lastDate)} (analyzed window: last ${Math.min(history.commitCount, 500)}).`);
  if (history.releases.length) {
    lines.push('', '## Releases', ...history.releases.slice(0, 6).map(release => `- ${release.tag} (${day(release.date)})`));
    lines.push(`- ${history.commitsSinceRelease} commit(s) since ${history.releases[0]!.tag}`);
  } else lines.push('', '## Releases', '- No tags; releases are not marked in git.');
  if (history.changelogHeadings.length) lines.push('', '## Changelog headings', ...history.changelogHeadings.map(heading => `- ${heading}`));
  if (history.themes.length) lines.push('', '## Commit themes (recent window)', `- ${history.themes.map(item => `${item.type} ${item.count}`).join(', ')}`);
  if (history.scopes.length) lines.push(`- scopes: ${history.scopes.map(item => `${item.scope} ${item.count}`).join(', ')}`);
  if (history.hotspots.length) lines.push('', '## Hotspots (files touched most)', ...history.hotspots.slice(0, 10).map(item => `- ${item.path} (${item.touches})`));
  if (history.contributors.length) lines.push('', '## Contributors (recent window)', `- ${history.contributors.map(item => `${item.name} ${item.commits}`).join(', ')}`);
  if (history.recent.length) lines.push('', '## Recent commits', ...history.recent.slice(0, 10).map(item => `- ${item.date} ${item.sha} ${item.subject}`));
  let text = lines.join('\n') + '\n';
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const cut = text.lastIndexOf('\n- ');
    if (cut < 0) { text = text.slice(0, maxBytes); break; }
    text = text.slice(0, cut) + '\n';
  }
  return text;
};
