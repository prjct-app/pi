import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { ArtifactParameters } from '../src/knowledge/artifact-contract.ts';

const tool = { name: 'prjct_artifact', description: 'Keep immutable internal artifacts and prepare export intent.', parameters: ArtifactParameters };

test('internal artifact publication cannot select an arbitrary client destination', () => {
  assert.throws(() => validateToolArguments(tool, { type: 'toolCall', id: 'artifact_call', name: 'prjct_artifact',
    arguments: { action: 'publish', projectId: 'project_a', operationId: 'operation_a', kind: 'research',
      content: 'Source-backed findings.', destination: '../client/AGENTS.md', maxBytes: 2048 },
  }));
});

test('artifact listing can continue a bounded page against an explicit snapshot', () => {
  const input = { action: 'list', projectId: 'project_a', maxItems: 8, maxBytes: 2048,
    cursor: { snapshot: { id: 'artifact_list', revision: 2, contentHash: 'a'.repeat(64) }, afterId: 'artifact_a' } };
  assert.deepEqual(validateToolArguments(tool, { type: 'toolCall', id: 'page_call', name: 'prjct_artifact', arguments: input }), input);
});
