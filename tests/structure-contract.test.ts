import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { StructureParameters } from '../src/representation/structure-contract.ts';

const tool = { name: 'prjct_structure', description: 'Inspect supported relationships and advisory impact.', parameters: StructureParameters };

test('an impact query cannot silently request a refresh or unbounded traversal', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'structure_call', name: 'prjct_structure',
    arguments: { action: 'impact', checkoutId: 'checkout_a', seeds: ['symbol_refresh'], relations: ['calls'],
      maxDepth: 99, maxItems: 32, maxBytes: 2048, refresh: true },
  }));
});
