import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { processToolDeclarations } from '../src/pi/tool-declarations.ts';
import { MAX_RESULT_BYTES } from '../src/workspace/reference-schemas.ts';

// prjct must never emit payloads that trip pi's ~50KB output guard: every
// caller-tunable result budget caps well below it, and the runtime enforces
// the same request budget when serializing results.
test('no prjct tool schema allows a result budget above the pi-safe ceiling', () => {
  for (const declaration of processToolDeclarations) {
    const maxima = [...JSON.stringify(declaration.parameters).matchAll(/"maximum":(\d+)/g)]
      .map(match => Number(match[1]))
      .filter(value => value !== Number.MAX_SAFE_INTEGER); // revision bounds are not output budgets
    for (const max of maxima) assert.ok(max <= MAX_RESULT_BYTES, `${declaration.name} allows ${max} > ${MAX_RESULT_BYTES}`);
  }
});

test('prjct_context accepts the ceiling and rejects anything above it', () => {
  const tool = processToolDeclarations.find(item => item.name === 'prjct_context')!;
  const call = (maxBytes: number) => validateToolArguments(tool, { type: 'toolCall', id: 'budget_call', name: 'prjct_context',
    arguments: { action: 'lookup', query: 'stack', maxBytes } });
  assert.equal(call(MAX_RESULT_BYTES).maxBytes, MAX_RESULT_BYTES);
  assert.throws(() => call(MAX_RESULT_BYTES + 1));
});
