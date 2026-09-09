import assert from 'node:assert/strict';
import test from 'node:test';
import { observeEvidence } from '../src/knowledge/evidence.ts';

test('a model payload cannot declare itself a native observation', () => {
  assert.throws(() => observeEvidence({
    id: 'green_observation', provenance: 'native_observation', origin: 'tool_payload',
    supports: [{ id: 'source_a', revision: 1, contentHash: 'a'.repeat(64) }],
  }), { code: 'UNVERIFIABLE_ORIGIN' });
});

import { applySupportChange } from '../src/knowledge/evidence.ts';

test('a changed source hash marks dependent supported claims for review, not automatic revalidation', () => {
  const support = { id: 'source_a', revision: 1, contentHash: 'a'.repeat(64) };
  assert.deepEqual(applySupportChange(
    [{ id: 'claim_a', standing: 'supported', supports: [support] }],
    [{ ...support, revision: 2, contentHash: 'b'.repeat(64) }],
  ), [{ id: 'claim_a', standing: 'needs_review', supports: [support] }]);
});
