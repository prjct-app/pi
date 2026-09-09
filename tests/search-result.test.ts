import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSearchResult } from '../src/knowledge/search-result.ts';

const request = { checkoutId: 'checkout_a', query: 'refresh owner', maxItems: 8, maxBytes: 2048 };

test('a search hit without source provenance cannot be presented as an applicable reference', () => {
  assert.throws(() => validateSearchResult(request, { status: 'ok', checkoutId: 'checkout_a',
    observedRevision: 2, configRevision: 1, items: [{ kind: 'source', summary: 'Use the global owner.', applicability: 'current',
      reasons: ['Matches requested behavior.'] }], gaps: [],
  }), { code: 'INVALID_RESULT' });
});

const reference = { id: 'source_refresh', revision: 2, contentHash: 'a'.repeat(64) };
const result = { status: 'ok', checkoutId: 'checkout_a', observedRevision: 2, configRevision: 1,
  items: [{ kind: 'source', reference, summary: 'GlobalRefreshProvider owns refresh.', applicability: 'current',
    sources: [reference], reasons: ['Existing owner for the requested behavior.'] }], gaps: [] };

test('the full search payload including provenance must fit the requested byte budget', () => {
  assert.throws(() => validateSearchResult({ ...request, maxBytes: 200 }, result), { code: 'OUTPUT_LIMIT' });
});

test('a search result from another checkout cannot answer this request', () => {
  assert.throws(() => validateSearchResult(request, { ...result, checkoutId: 'checkout_b' }), { code: 'SCOPE_MISMATCH' });
});

test('search cannot overrun the requested item count even when bytes remain', () => {
  assert.throws(() => validateSearchResult({ ...request, maxItems: 1 }, { ...result, items: [result.items[0], result.items[0]] }),
    { code: 'OUTPUT_LIMIT' });
});

test('search abstention explains the missing coverage rather than silently returning nothing', () => {
  assert.throws(() => validateSearchResult(request, { status: 'abstained', checkoutId: 'checkout_a', items: [], gaps: [] }),
    { code: 'INVALID_RESULT' });
});

test('stale search hits cannot masquerade as an unqualified current result', () => {
  assert.throws(() => validateSearchResult(request, { ...result,
    items: [{ ...result.items[0], applicability: 'stale' }],
  }), { code: 'INVALID_RESULT' });
});

test('an empty search cannot be reported as successful attributable retrieval', () => {
  assert.throws(() => validateSearchResult(request, { ...result, items: [] }), { code: 'INVALID_RESULT' });
});

test('current source hits require an observed representation cutoff', () => {
  const { observedRevision: _revision, configRevision: _config, ...withoutCutoff } = result;
  assert.throws(() => validateSearchResult(request, withoutCutoff), { code: 'INVALID_RESULT' });
});
