import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { SearchParameters } from '../src/knowledge/search-contract.ts';

const tool = { name: 'prjct_search', description: 'Find applicable source and retained knowledge references.', parameters: SearchParameters };

test('search requires a bounded explicit query and rejects model-supplied authority through native Pi validation', () => {
  assert.throws(() => validateToolArguments(tool, {
    type: 'toolCall', id: 'invalid_search', name: 'prjct_search',
    arguments: { checkoutId: 'checkout_a', query: 'existing global refresh owner', maxItems: 8, maxBytes: 4096, approved: true },
  }));
});

test('search can explicitly request the next snapshot-bound page', () => {
  const input = { checkoutId: 'checkout_a', query: 'refresh', maxItems: 8, maxBytes: 2048,
    cursor: { snapshot: { id: 'search_snapshot', revision: 2, contentHash: 'a'.repeat(64) }, afterId: 'source_a' } };
  assert.deepEqual(validateToolArguments(tool, { type: 'toolCall', id: 'page_call', name: 'prjct_search', arguments: input }), input);
});
