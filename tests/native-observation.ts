import { createBashTool } from '@earendil-works/pi-coding-agent';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';

// Real SDK execution, not a string promoted to native provenance. These probes
// test attribution; the SDK session tests separately cover project verification.
export async function observeNative(runtime: ProcessRuntime): Promise<string> {
  const beforeHash = await runtime.sourceSnapshot();
  const command = `node -e "require('node:assert/strict').equal(1 + 1, 2)"`;
  const result = await createBashTool(runtime.cwd).execute('native_fixture_probe', { command });
  const observationId = await runtime.recordObservation(JSON.stringify(result), {
    toolCallId: 'native_fixture_probe', toolName: 'bash', command, outcome: 'succeeded', beforeHash,
  });
  if (!observationId) throw new Error('Bound runtime did not retain native evidence.');
  return observationId;
}
