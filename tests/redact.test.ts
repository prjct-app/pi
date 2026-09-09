import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from './test-paths.ts';
import { redactSecrets, containsSecretShape } from '../src/knowledge/redact.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { readRecord } from '../src/workspace/store.ts';

test('secret shapes are redacted, diagnostic signal survives', () => {
  const input = [
    'export OPENAI_API_KEY=sk-proj-abc123def456ghi',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIs.token payload',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    '"client_secret": "shh-do-not-store"',
    'postgres://user:hunter2@db.internal:5432/app',
    '-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBg\n-----END PRIVATE KEY-----',
    'Error: connection refused on port 5432 after 3 retries',
  ].join('\n');
  const out = redactSecrets(input);
  assert.ok(!out.includes('sk-proj-abc123def456ghi'));
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIs'));
  assert.ok(!out.includes('ghp_abcdef'));
  assert.ok(!out.includes('shh-do-not-store'));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('MIIEvwIBADANBg'));
  assert.match(out, /connection refused on port 5432/);
  assert.equal(containsSecretShape(input), true);
  assert.equal(containsSecretShape('nothing sensitive here'), false);
});

test('persisted observations never contain secret material, from any host path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-redact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'client'), agentHome = join(root, 'agent'), prjctHome = join(root, 'store');
  await mkdir(cwd); await mkdir(agentHome);
  await writeFile(join(cwd, 'README.md'), '# redaction fixture\n');
  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome, sessionId: 's', attemptId: 'a' });
  await runtime.initProject();
  await runtime.recordObservation('bash failed: export STRIPE_SECRET_KEY=sk-live-abc123456789 && curl failed with 401', {
    toolCallId: 't1', toolName: 'bash', command: 'export STRIPE_SECRET_KEY=sk-live-abc123456789 && curl https://api.stripe.com', outcome: 'failed',
  });
  const id = await runtime.identity();
  const state = (await readRecord(join(prjctHome, id.day, id.projectId, 'work/state.json')))!.payload as { observations: Array<{ summary: string; execution?: { command?: string } }> };
  const raw = await readFile(join(prjctHome, id.day, id.projectId, 'work/state.json'), 'utf8');
  assert.ok(!raw.includes('sk-live-abc123456789'), 'secret must not reach disk in summary or command');
  assert.match(state.observations[0]!.summary, /401/);
  assert.match(state.observations[0]!.summary, /<REDACTED>/);
});
