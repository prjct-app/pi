import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { KnowledgeParameters } from '../src/knowledge/claim-contract.ts';

const tool = { name: 'prjct_knowledge', description: 'Maintain attributable project understanding and corrections.', parameters: KnowledgeParameters };

test('a proposed understanding cannot declare its own verified standing or user origin', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'knowledge_call', name: 'prjct_knowledge',
    arguments: { action: 'propose', projectId: 'project_a', operationId: 'operation_a', statement: 'Reuse the global refresh owner.',
      supports: [], verified: true, origin: 'user', maxBytes: 2048 },
  }));
});
