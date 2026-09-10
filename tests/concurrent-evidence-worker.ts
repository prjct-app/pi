import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';

const [agentHome, prjctHome, checkout, barrier, sessionId, writerId] = process.argv.slice(2);
if (!agentHome || !prjctHome || !checkout || !barrier || !sessionId || !writerId) throw new Error('Missing worker argument.');

const runtime = new ProcessRuntime({ agentHome, prjctHome, cwd: checkout, actorId: `actor_${writerId}`,
  sessionId, attemptId: `attempt_${writerId}` });
await writeFile(join(barrier, `${writerId}.ready`), '');
while (true) {
  try { await access(join(barrier, 'start')); break; }
  catch { await delay(2); }
}
try {
  await runtime.recordObservation(`concurrent evidence from ${writerId}`);
  console.log(JSON.stringify({ ok: true, sessionId, writerId }));
} catch (error) {
  const failure = error as Error & { code?: string };
  console.log(JSON.stringify({ ok: false, sessionId, writerId, code: failure.code, message: failure.message }));
}
