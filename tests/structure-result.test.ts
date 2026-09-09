import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStructureResult } from '../src/representation/structure-result.ts';
import type { StructureRequest } from '../src/representation/structure-contract.ts';

const request: StructureRequest = { action: 'impact', checkoutId: 'checkout_a', seeds: ['refresh'],
  relations: ['calls'], maxDepth: 2, maxItems: 8, maxBytes: 2048 };
const reference = { id: 'source_refresh', revision: 2, contentHash: 'a'.repeat(64) };
const result = { action: 'impact', status: 'ok', checkoutId: 'checkout_a', observedRevision: 2, configRevision: 1,
  freshness: 'current', certainty: 'advisory',
  edges: [{ id: 'edge_a', from: 'screen', to: 'refresh', relation: 'calls', basis: 'extracted',
    distance: 1, sources: [reference] }], gaps: [] };

test('structural impact cannot claim exhaustive certainty from a bounded query', () => {
  assert.throws(() => validateStructureResult(request, { ...result, certainty: 'exhaustive' }), { code: 'INVALID_RESULT' });
});

test('a structure result cannot switch the requested checkout', () => {
  assert.throws(() => validateStructureResult(request, { ...result, checkoutId: 'checkout_b' }), { code: 'SCOPE_MISMATCH' });
});

test('a structure response cannot exceed the requested traversal depth', () => {
  assert.throws(() => validateStructureResult(request, { ...result, edges: [{ ...result.edges[0], distance: 3 }] }),
    { code: 'OUTPUT_LIMIT' });
});

test('provenance is included in the structure response byte budget', () => {
  assert.throws(() => validateStructureResult({ ...request, maxBytes: 64 }, result), { code: 'OUTPUT_LIMIT' });
});

test('a bounded impact response cannot silently add extra edges beyond the requested count', () => {
  assert.throws(() => validateStructureResult({ ...request, maxItems: 1 }, {
    ...result, edges: [result.edges[0], { ...result.edges[0], id: 'edge_b', from: 'other_screen' }],
  }), { code: 'OUTPUT_LIMIT' });
});

test('an impact query does not receive an unrequested cochange signal', () => {
  assert.throws(() => validateStructureResult(request, { ...result,
    edges: [{ ...result.edges[0], relation: 'cochange', basis: 'cochange' }],
  }), { code: 'SCOPE_MISMATCH' });
});

test('a stale representation cannot present an unqualified successful impact result', () => {
  assert.throws(() => validateStructureResult(request, { ...result, freshness: 'stale' }), { code: 'INVALID_RESULT' });
});

test('partial impact coverage identifies its omissions', () => {
  assert.throws(() => validateStructureResult(request, { ...result, status: 'partial' }), { code: 'INVALID_RESULT' });
});

test('current structure data requires an observed source/configuration cutoff', () => {
  const { observedRevision: _revision, configRevision: _config, ...withoutCutoff } = result;
  assert.throws(() => validateStructureResult(request, withoutCutoff), { code: 'INVALID_RESULT' });
});
