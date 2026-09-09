import { createBashTool } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';

// Real SDK execution, not a string promoted to native provenance. These probes
// test attribution; the SDK session tests separately cover project verification.
export async function observeNative(runtime: ProcessRuntime): Promise<string> {
  const beforeHash = await runtime.sourceSnapshot();
  const command = `node -e "require('node:assert/strict').equal(1 + 1, 2)"`;
  const result = await createBashTool(runtime.cwd).execute('native_fixture_probe', { command });
  await runtime.recordObservation(JSON.stringify(result), { toolCallId: 'native_fixture_probe', toolName: 'bash', command, outcome: 'succeeded', beforeHash });
  const binding = await runtime.identity();
  const record = await readRecord(join(runtime.prjctRoot, binding.day, binding.projectId, 'work/state.json'));
  return (record!.payload as { observations: Array<{ id: string }> }).observations.at(-1)!.id;
}
