import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { collectHistory, gitHead, renderHistory } from '../src/jobs/history.ts';
import { tmpdir } from './test-paths.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'f@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

test('git history yields releases, hotspots, conventional themes and a bounded brief', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-history-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/app.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'README.md'), '# App\n');
    await writeFile(join(root, 'secret.env'), 'TOKEN=abc\n');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'feat(app): initial app');
    git(root, 'tag', 'v0.1.0');
    for (let i = 0; i < 3; i += 1) {
      await writeFile(join(root, 'src/app.ts'), `export const a = ${i + 2};\n`);
      git(root, 'add', '.'); git(root, 'commit', '-q', '-m', `fix(app): bump ${i} token=sk-ant-api03-${'x'.repeat(40)}`);
    }
    await writeFile(join(root, 'README.md'), '# App\n\nMore.\n');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'docs: describe');
    const head = await gitHead(root);
    assert.match(head, /^[0-9a-f]{40}$/);
    const history = await collectHistory(root, { known: new Set(['src/app.ts', 'README.md']), changelog: '# Changelog\n## 0.1.0\n- initial\n' });
    assert.ok(history);
    assert.equal(history.head, head);
    assert.equal(history.branch, 'main');
    assert.equal(history.commitCount, 5);
    assert.deepEqual(history.releases.map(item => item.tag), ['v0.1.0']);
    assert.equal(history.commitsSinceRelease, 4);
    assert.equal(history.hotspots[0]?.path, 'src/app.ts');
    assert.equal(history.hotspots[0]?.touches, 4);
    assert.equal(history.hotspots.some(item => item.path === 'secret.env'), false); // unknown to the index, excluded
    assert.deepEqual(history.themes.map(item => item.type), ['fix', 'docs', 'feat']);
    assert.deepEqual(history.scopes, [{ scope: 'app', count: 4 }]);
    assert.equal(history.contributors[0]?.name, 'Fixture Author');
    assert.deepEqual(history.changelogHeadings, ['Changelog', '0.1.0']);
    assert.equal(history.recent.some(item => item.subject.includes('sk-ant-api03')), false); // redacted
    const brief = renderHistory(history);
    assert.ok(Buffer.byteLength(brief, 'utf8') <= 4096);
    assert.match(brief, /## Releases\n- v0\.1\.0/);
    assert.match(brief, /## Hotspots[\s\S]*src\/app\.ts \(4\)/);
    assert.match(brief, /fix 3, docs 1, feat 1/);
    const tiny = renderHistory(history, 300);
    assert.ok(Buffer.byteLength(tiny, 'utf8') <= 300);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a checkout without git history reports honestly instead of failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-nogit-'));
  try {
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    assert.equal(await collectHistory(root), undefined);
    assert.equal(await gitHead(root), 'none');
    assert.match(renderHistory(undefined), /No git history/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
