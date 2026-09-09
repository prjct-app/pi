import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { bindIdentity, scopeStore } from '../src/workspace/identity.ts';
import { resolveIdentity } from '../src/workspace/identity.ts';

test('a source path that is a symlink is refused rather than followed into another tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-link-'));
  try {
    const agentHome = join(root, 'agent-home');
    const real = join(root, 'real');
    const linked = join(root, 'linked');
    await mkdir(agentHome);
    await mkdir(real);
    await symlink(real, linked);
    await assert.rejects(() => resolveIdentity({ location: linked, agentHome }), { code: 'UNSAFE_SYMLINK' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ambiguous identity cannot be bound without a current user choice', async () => {
  assert.throws(() => bindIdentity({
    location: '/tmp/example', projectId: 'project_a', checkoutId: 'checkout_a',
    resolutionStatus: 'ambiguous', expectedRevision: 0, confirmation: false,
  }), { code: 'IDENTITY_AMBIGUITY' });
});

test('a store scope cannot escape the configured agent home', () => {
  const home = '/tmp/prjct-agent-home';
  assert.throws(() => scopeStore(home, '../checkout', 'artifacts'), { code: 'PROHIBITED_PATH' });
});

test('the agent home itself cannot be treated as a source checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-home-'));
  try {
    const agentHome = join(root, 'agent-home');
    await mkdir(agentHome);
    await assert.rejects(() => resolveIdentity({ location: agentHome, agentHome }), { code: 'PROHIBITED_PATH' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
