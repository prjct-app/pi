import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { ReconcileParameters } from '../src/work/reconcile-contract.ts';

const tool = { name: 'prjct_reconcile', description: 'Inspect interruption and request deliberate continuation.', parameters: ReconcileParameters };

test('a continuation request cannot authorize takeover with a force or predecessor-stopped flag', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'reconcile_call', name: 'prjct_reconcile',
    arguments: { action: 'continue', workId: 'work_a', taskId: 'task_a', predecessorAttemptId: 'attempt_a',
      operationId: 'operation_a', expectedRevision: 2, observationIds: [], force: true, predecessorStopped: true, maxBytes: 2048 },
  }));
});
