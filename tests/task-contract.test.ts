import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { TaskParameters } from '../src/work/task-contract.ts';

const tool = { name: 'prjct_task', description: 'Maintain stable tasks, attempts and explicit transitions.', parameters: TaskParameters };

test('task completion requires an assessment reference instead of a self-certified snapshot', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'task_call', name: 'prjct_task',
    arguments: { action: 'transition', transition: 'complete', taskId: 'task_a', workId: 'work_a', operationId: 'operation_a',
      expectedRevision: 2, maxBytes: 2048, assessment: { verified: true, evidence: [] } },
  }));
});

test('task history can continue a bounded page against an explicit snapshot', () => {
  const input = { action: 'inspect', workId: 'work_a', taskId: 'task_a', view: 'history', maxItems: 8, maxBytes: 2048,
    cursor: { snapshot: { id: 'task_history', revision: 2, contentHash: 'a'.repeat(64) }, afterId: 'checkpoint_a' } };
  assert.deepEqual(validateToolArguments(tool, { type: 'toolCall', id: 'page_call', name: 'prjct_task', arguments: input }), input);
});
