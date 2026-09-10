import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from './test-paths.ts';
import { authorizeNativeMutation, canonicalMutationPath } from '../src/work/native-mutation-policy.ts';

const authority = (overrides: Record<string, unknown> = {}) => ({
  managed: true, checkoutId: 'checkout_a', boundCheckoutId: 'checkout_a', currentAttemptId: 'attempt_a', candidateCount: 1,
  taskId: 'task_a', taskCheckoutId: 'checkout_a', taskAttemptId: 'attempt_a', taskAccess: 'write' as const, taskStanding: 'valid' as const,
  taskGrantAttemptId: 'attempt_a', taskGrantStanding: 'valid' as const,
  writerCheckoutId: 'checkout_a', writerAttemptId: 'attempt_a', writerStanding: 'valid' as const,
  ...overrides,
});

test('unmanaged native writes remain available while managed work requires one exact current authority chain', () => {
  assert.deepEqual(authorizeNativeMutation({ managed: false, currentAttemptId: 'attempt_a', candidateCount: 0 }), { allowed: true, managed: false });
  assert.equal(authorizeNativeMutation(authority()).allowed, true);
  assert.equal(authorizeNativeMutation(authority({ candidateCount: 2 })).code, 'TASK_GRANT_REQUIRED');
  assert.equal(authorizeNativeMutation(authority({ taskAccess: 'read' })).code, 'WRITE_GRANT_REQUIRED');
  assert.equal(authorizeNativeMutation(authority({ writerStanding: 'uncertain' })).code, 'RECONCILE_REQUIRED');
  assert.equal(authorizeNativeMutation(authority({ taskGrantAttemptId: 'attempt_old' })).code, 'ATTEMPT_MISMATCH');
  assert.equal(authorizeNativeMutation(authority({ writerCheckoutId: 'checkout_b' })).code, 'CHECKOUT_MISMATCH');
});

test('mutation paths cannot escape through traversal or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-native-gate-'));
  const checkout = join(root, 'checkout');
  const outside = join(root, 'outside');
  try {
    await mkdir(checkout); await mkdir(outside);
    await writeFile(join(checkout, 'inside.ts'), 'ok');
    assert.equal(await canonicalMutationPath(checkout, 'inside.ts'), join(checkout, 'inside.ts'));
    assert.equal(await canonicalMutationPath(checkout, 'new/deep.ts'), join(checkout, 'new/deep.ts'));
    await assert.rejects(() => canonicalMutationPath(checkout, '../outside/escape.ts'), { code: 'PROHIBITED_PATH' });
    await symlink(outside, join(checkout, 'alias'));
    await assert.rejects(() => canonicalMutationPath(checkout, 'alias/escape.ts'), { code: 'PROHIBITED_PATH' });
    await symlink(join(checkout, 'inside.ts'), join(checkout, 'file-link'));
    await assert.rejects(() => canonicalMutationPath(checkout, 'file-link'), { code: 'UNSAFE_SYMLINK' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
