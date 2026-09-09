import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { WorkParameters } from '../src/work/work-contract.ts';

const tool = { name: 'prjct_work', description: 'Maintain the work objective and explicit selection.', parameters: WorkParameters };

test('changing work disposition requires a pinned revision rather than a model approval flag', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'work_call', name: 'prjct_work',
    arguments: { action: 'transition', workId: 'work_a', operationId: 'operation_a', disposition: 'completed', approved: true, maxBytes: 2048 },
  }));
});

test('work completion must reference an assessment even when the mutation revision is present', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'work_call', name: 'prjct_work',
    arguments: { action: 'transition', workId: 'work_a', operationId: 'operation_a', expectedRevision: 3,
      disposition: 'completed', reason: 'Execution stopped.', maxBytes: 2048 },
  }));
});

test('listing work can continue a bounded page against an explicit snapshot', () => {
  const input = { action: 'list', projectId: 'project_a', maxItems: 8, maxBytes: 2048,
    cursor: { snapshot: { id: 'work_list', revision: 2, contentHash: 'a'.repeat(64) }, afterId: 'work_a' } };
  assert.deepEqual(validateToolArguments(tool, { type: 'toolCall', id: 'page_call', name: 'prjct_work', arguments: input }), input);
});
