import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRefreshPreconditions, type RefreshRequest } from '../src/representation/refresh-contract.ts';

// Already structurally validated by Pi. These tests exercise domain state checks,
// not another argument parser. Atomic commit/revalidation remains unimplemented.
const apply = { action: 'apply', checkoutId: 'checkout_a', operationId: 'operation_a',
  expectedRevision: 4, expectedConfigRevision: 2 } satisfies RefreshRequest;

test('refresh rejects a stale source revision', () => {
  assert.throws(() => assertRefreshPreconditions(apply, { checkoutId: 'checkout_a', revision: 5, configRevision: 2 }),
    { code: 'STALE_REVISION' });
});

test('equal revisions do not permit refresh against another checkout', () => {
  assert.throws(() => assertRefreshPreconditions(apply, { checkoutId: 'checkout_b', revision: 4, configRevision: 2 }),
    { code: 'CHECKOUT_MISMATCH' });
});

test('changed extractor configuration invalidates refresh independently of source revision', () => {
  assert.throws(() => assertRefreshPreconditions(apply, { checkoutId: 'checkout_a', revision: 4, configRevision: 3 }),
    { code: 'STALE_CONFIG' });
});

test('matching source and configuration state passes refresh preconditions', () => {
  assert.doesNotThrow(() => assertRefreshPreconditions(apply, { checkoutId: 'checkout_a', revision: 4, configRevision: 2 }));
});

test('read-only inspection can inspect the latest revision without a mutation precondition', () => {
  assert.doesNotThrow(() => assertRefreshPreconditions({ action: 'inspect', checkoutId: 'checkout_a' },
    { checkoutId: 'checkout_a', revision: 9, configRevision: 6 }));
});
