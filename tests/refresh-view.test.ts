import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRefresh } from '../src/representation/refresh-view.ts';

const observed = { checkoutId: 'checkout_a', revision: 8, configRevision: 2 };

test('one applied component cannot acknowledge an unapplied failed component as current', () => {
  assert.deepEqual(describeRefresh(observed, ['lexical', 'symbols'], [
    { id: 'lexical', checkoutId: 'checkout_a', appliedRevision: 8, appliedConfigRevision: 2, lastAttempt: 'succeeded' },
    { id: 'symbols', checkoutId: 'checkout_a', appliedRevision: 7, appliedConfigRevision: 2, lastAttempt: 'failed' },
  ]), { freshness: 'partial', currentComponents: ['lexical'], pendingComponents: ['symbols'], lastAttemptFailures: ['symbols'] });
});

test('a matching generation from another checkout cannot make this checkout current', () => {
  assert.throws(() => describeRefresh(observed, ['lexical'], [
    { id: 'lexical', checkoutId: 'checkout_b', appliedRevision: 8, appliedConfigRevision: 2, lastAttempt: 'succeeded' },
  ]), { code: 'CHECKOUT_MISMATCH' });
});

test('conflicting component records cannot hide a failure by taking the first match', () => {
  assert.throws(() => describeRefresh(observed, ['lexical'], [
    { id: 'lexical', checkoutId: 'checkout_a', appliedRevision: 8, appliedConfigRevision: 2, lastAttempt: 'succeeded' },
    { id: 'lexical', checkoutId: 'checkout_a', appliedRevision: 7, appliedConfigRevision: 2, lastAttempt: 'failed' },
  ]), { code: 'AMBIGUOUS_COMPONENT_STATE' });
});

test('a configured component absent from the stored results stays pending', () => {
  assert.deepEqual(describeRefresh(observed, ['symbols'], []), {
    freshness: 'unavailable', currentComponents: [], pendingComponents: ['symbols'], lastAttemptFailures: [],
  });
});

test('a failed rebuild does not erase an already current generation or hide the failure', () => {
  assert.deepEqual(describeRefresh(observed, ['symbols'], [
    { id: 'symbols', checkoutId: 'checkout_a', appliedRevision: 8, appliedConfigRevision: 2, lastAttempt: 'failed' },
  ]), { freshness: 'current', currentComponents: ['symbols'], pendingComponents: [], lastAttemptFailures: ['symbols'] });
});
