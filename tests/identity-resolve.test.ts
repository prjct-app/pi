import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { resolveIdentity } from '../src/workspace/identity.ts';

const snapshot = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  const walk = async (dir: string, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
    }
  };
  await walk(root);
  return names.sort();
};

test('resolving a source location does not create a prjct store or client files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-id-'));
  try {
    const agentHome = join(root, 'agent-home');
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    await writeFile(join(checkout, 'README.md'), '# demo\n');
    await mkdir(agentHome);
    const before = await snapshot(root);
    const result = await resolveIdentity({ location: checkout, agentHome });
    assert.equal(result.status, 'unmatched');
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { spawnSync } from 'node:child_process';

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};

test('git remotes and worktree metadata are observations, not project identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-git-'));
  try {
    const agentHome = join(root, 'agent-home');
    const checkout = join(root, 'checkout');
    await mkdir(agentHome);
    await mkdir(checkout);
    git(checkout, ['init']);
    git(checkout, ['remote', 'add', 'origin', 'https://example.invalid/demo.git']);
    const result = await resolveIdentity({ location: checkout, agentHome });
    assert.equal(result.status, 'unmatched');
    assert.ok(result.observations.git);
    assert.equal(result.observations.git.remotes.includes('https://example.invalid/demo.git'), true);
    assert.equal(result.observations.git.isWorktree, false);
    assert.notEqual(result.observations.git.workTree, result.observations.git.commonDir);
    assert.equal(result.projectId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a linked worktree is a distinct checkout observation sharing git history evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-wt-'));
  try {
    const agentHome = join(root, 'agent-home');
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    await mkdir(agentHome);
    await mkdir(main);
    git(main, ['init']);
    git(main, ['-c', 'user.email=dev@example.invalid', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'init']);
    git(main, ['worktree', 'add', linked]);
    const primary = await resolveIdentity({ location: main, agentHome });
    const worktree = await resolveIdentity({ location: linked, agentHome });
    assert.equal(primary.observations.git?.isWorktree, false);
    assert.equal(worktree.observations.git?.isWorktree, true);
    assert.equal(worktree.observations.git?.commonDir, primary.observations.git?.commonDir);
    assert.notEqual(worktree.observations.git?.workTree, primary.observations.git?.workTree);
    assert.deepEqual(await snapshot(agentHome), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing source location is unavailable rather than auto-created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-miss-'));
  try {
    const agentHome = join(root, 'agent-home');
    await mkdir(agentHome);
    await assert.rejects(() => resolveIdentity({ location: join(root, 'gone'), agentHome }), { code: 'CHECKOUT_MISSING' });
    assert.deepEqual(await snapshot(agentHome), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
