import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { PlanParameters } from '../src/work/plan-contract.ts';

const tool = { name: 'prjct_plan', description: 'Draft and adopt exact spec/plan revisions.', parameters: PlanParameters };

test('plan adoption cannot replace a pinned candidate with an approved boolean', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'plan_call', name: 'prjct_plan',
    arguments: { action: 'adopt', workId: 'work_a', operationId: 'operation_a', expectedRevision: 2, approved: true, maxBytes: 2048 },
  }));
});
