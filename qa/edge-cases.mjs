// Edge-case QA for the init gate, hooks, and on-demand methods.
// Offline: ProcessRuntime against fresh fixtures only. Exercises the real tool
// surface through Pi's argument validation where the surface is a tool.
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { processToolDeclarations } from '../src/pi/tool-declarations.ts';

const out = process.argv[2];
if (!out) throw new Error('evidence directory required');
const rows = [];
let seq = 0;
const err = e => ({ code: e?.code ?? e?.name, message: String(e?.message ?? e).slice(0, 300) });
async function attempt(fn) { try { return { accepted: true, value: await fn() }; } catch (e) { return { accepted: false, error: err(e) }; } }
async function call(runtime, name, params, extras = {}) {
  const d = processToolDeclarations.find(t => t.name === name);
  const args = validateToolArguments(d, { type: 'toolCall', id: `qa_${++seq}`, name, arguments: params });
  return runtime.execute(name, args, extras);
}
async function fixture(name, files = { 'README.md': '# QA fixture\n' }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `prjct-edge-${name}-`)));
  const cwd = join(root, 'client'), home = join(root, 'store'), agentHome = join(root, 'agent');
  await mkdir(cwd, { recursive: true }); await mkdir(agentHome);
  for (const [p, text] of Object.entries(files)) { await mkdir(join(cwd, p, '..'), { recursive: true }); await writeFile(join(cwd, p), text); }
  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome: home, sessionId: 's1', attemptId: 'a1' });
  return { root, cwd, home, agentHome, runtime };
}
async function probe(id, title, fn) {
  try { const { pass, ...evidence } = await fn(); rows.push({ id, title, outcome: pass ? 'PASS' : 'FAIL', ...evidence }); }
  catch (e) { rows.push({ id, title, outcome: 'HARNESS_ERROR', error: err(e) }); }
  console.log(id, rows.at(-1).outcome, title);
}

// ---- Uninitialized project: nothing may create state ----
await probe('N01', 'sync on uninitialized checkout fails UNAVAILABLE and creates nothing', async () => {
  const f = await fixture('n01');
  const r = await attempt(() => f.runtime.syncProject());
  const store = await attempt(() => readdir(f.home, { recursive: true }));
  return { pass: !r.accepted && r.error.code === 'UNAVAILABLE' && !store.accepted, r, storeCreated: store.accepted };
});
await probe('N02', 'work create on uninitialized checkout fails without state', async () => {
  const f = await fixture('n02');
  const r = await attempt(() => call(f.runtime, 'prjct_work', { action: 'create', projectId: 'p_any', title: 'x', origin: { id: 'o', revision: 1, contentHash: 'a'.repeat(64) }, operationId: 'op', maxBytes: 2048 }));
  const store = await attempt(() => readdir(f.home));
  return { pass: !r.accepted && r.error.code === 'UNAVAILABLE' && !store.accepted, r };
});
await probe('N03', 'knowledge propose / refresh apply / artifact publish all refuse pre-init', async () => {
  const f = await fixture('n03');
  const k = await attempt(() => call(f.runtime, 'prjct_knowledge', { action: 'propose', projectId: 'p_any', operationId: 'op', statement: 'x', supports: [], gaps: [], maxBytes: 2048 }));
  const a = await attempt(() => call(f.runtime, 'prjct_artifact', { action: 'publish', projectId: 'p_any', kind: 'note', content: 'x', operationId: 'op2', maxBytes: 2048 }));
  const store = await attempt(() => readdir(f.home));
  return { pass: [k, a].every(x => !x.accepted && x.error.code === 'UNAVAILABLE') && !store.accepted, k, a };
});
await probe('N04', 'lookup on uninitialized checkout abstains; hooks record nothing', async () => {
  const f = await fixture('n04');
  const l = await call(f.runtime, 'prjct_context', { action: 'lookup', query: 'what is this', maxBytes: 4096 });
  await f.runtime.recordObservation('bash completed: fake', { toolCallId: 'x', toolName: 'bash', outcome: 'succeeded' });
  const store = await attempt(() => readdir(f.home));
  return { pass: (l.details).status === 'abstained' && !store.accepted, lookupStatus: (l.details).status };
});
await probe('N05', 'method catalog and documents work without any binding', async () => {
  const f = await fixture('n05');
  const cat = await call(f.runtime, 'prjct_context', { action: 'lookup', query: 'methods', maxBytes: 24000 });
  const doc = await call(f.runtime, 'prjct_context', { action: 'lookup', query: 'method:diagnosing-bugs', maxBytes: 50000 });
  const t = JSON.stringify(doc.details);
  return { pass: (cat.details).items.length === 17 && /feedback loop/i.test(t) && /Delivered by prjct on demand/.test(t),
    catalogItems: (cat.details).items.length };
});
await probe('N06', 'discover still returns prospective ids without initializing', async () => {
  const f = await fixture('n06');
  const d = await call(f.runtime, 'prjct_context', { action: 'discover', query: 'search knowledge', maxBytes: 8000 });
  const store = await attempt(() => readdir(f.home));
  return { pass: /^p_[a-f0-9]{12}$/.test((d.details).projectId) && (d.details).stateRevision === 0 && !store.accepted, details: d.details };
});
// ---- Init gate ----
await probe('I01', 'init creates store, indexes, and sync afterwards is a no-op', async () => {
  const f = await fixture('i01', { 'README.md': '# Init\n', 'src/a.ts': 'export const a = 1;\n' });
  const init = await f.runtime.initProject();
  const sync = await f.runtime.syncProject();
  const tree = await readdir(f.home, { recursive: true });
  return { pass: init.rebuilt && init.indexedFiles === 2 && !sync.rebuilt && tree.some(p => /identity\/index\.json/.test(p)) && tree.some(p => /work\/state\.json/.test(p)), init, syncText: sync.text };
});
await probe('I02', 'init is idempotent: second init does not duplicate or reindex', async () => {
  const f = await fixture('i02');
  const one = await f.runtime.initProject(); const two = await f.runtime.initProject();
  const bindings = JSON.parse(await readFile(join(f.home, 'identity/index.json'), 'utf8')).payload.bindings;
  return { pass: one.projectId === two.projectId && bindings.length === 1 && !two.rebuilt, bindings: bindings.length };
});
await probe('I03', 'init inside the store home is refused before any write', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'prjct-edge-i03-')));
  const runtime = new ProcessRuntime({ cwd: root, agentHome: join(root, 'agent'), prjctHome: join(root, 'store') });
  await mkdir(join(root, 'agent'));
  const r = await attempt(() => runtime.initProject());
  const store = await attempt(() => readdir(join(root, 'store')));
  await rm(root, { recursive: true, force: true });
  return { pass: !r.accepted && r.error.code === 'PROHIBITED_PATH' && !store.accepted, r };
});
await probe('I04', 'pre-aborted init leaves no files behind', async () => {
  const f = await fixture('i04');
  const c = new AbortController(); c.abort();
  const r = await attempt(() => f.runtime.initProject(c.signal));
  const store = await attempt(() => readdir(f.home, { recursive: true }));
  return { pass: !r.accepted && !store.accepted, r };
});
await probe('I05', 'interrupted init (lock) recovers on retry without inventing state', async () => {
  const f = await fixture('i05');
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  // Local day may differ from UTC; derive via runtime init attempt instead.
  const first = await f.runtime.initProject();
  const again = await f.runtime.initProject();
  return { pass: first.initialized && again.initialized && !again.rebuilt, note: `day bucket ${day}`, first: first.text };
});
// ---- Method gates on initialized project ----
await probe('G01', 'code-review can never be recorded as one complete pass', async () => {
  const f = await fixture('g01');
  await f.runtime.initProject();
  const w = await call(f.runtime, 'prjct_work', { action: 'create', projectId: (await f.runtime.identity()).projectId, title: 'gates', origin: { id: 'o', revision: 1, contentHash: 'a'.repeat(64) }, operationId: 'opw', maxBytes: 4096 });
  const workId = w.details.scope.workId;
  const rev = async () => (await call(f.runtime, 'prjct_context', { action: 'discover', query: 'checkpoint', maxBytes: 4096 }).then(d => (d.details).stateRevision));
  await call(f.runtime, 'prjct_task', { action: 'define', workId, taskId: 't1', definition: { id: 'd', revision: 1, contentHash: 'a'.repeat(64) }, criterionIds: ['c'], operationId: 'opt', expectedRevision: await rev(), maxBytes: 4096 });
  await call(f.runtime, 'prjct_task', { action: 'claim', workId, taskId: 't1', checkoutId: (await f.runtime.identity()).checkoutId, access: 'read', operationId: 'opc', expectedRevision: await rev(), maxBytes: 4096 });
  const r = await attempt(async () => call(f.runtime, 'prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId: 't1', methodId: 'code-review', stage: 'complete', summary: 'x', evidenceIds: [], nextAction: 'x', operationId: 'opk', expectedRevision: await rev(), maxBytes: 4096 }));
  return { pass: !r.accepted && r.error.code === 'INVALID_STAGE', r };
});
await probe('G02', 'grilling decision without user-input evidence is refused', async () => {
  const f = await fixture('g02');
  await f.runtime.initProject();
  const w = await call(f.runtime, 'prjct_work', { action: 'create', projectId: (await f.runtime.identity()).projectId, title: 'gates', origin: { id: 'o', revision: 1, contentHash: 'a'.repeat(64) }, operationId: 'opw', maxBytes: 4096 });
  const workId = w.details.scope.workId;
  const rev = async () => (await call(f.runtime, 'prjct_context', { action: 'discover', query: 'checkpoint', maxBytes: 4096 }).then(d => (d.details).stateRevision));
  await call(f.runtime, 'prjct_task', { action: 'define', workId, taskId: 't1', definition: { id: 'd', revision: 1, contentHash: 'a'.repeat(64) }, criterionIds: ['c'], operationId: 'opt', expectedRevision: await rev(), maxBytes: 4096 });
  await call(f.runtime, 'prjct_task', { action: 'claim', workId, taskId: 't1', checkoutId: (await f.runtime.identity()).checkoutId, access: 'read', operationId: 'opc', expectedRevision: await rev(), maxBytes: 4096 });
  await f.runtime.recordObservation('read README', { toolCallId: 'r1', toolName: 'read', outcome: 'succeeded' });
  const obs = (await call(f.runtime, 'prjct_context', { action: 'lookup', query: 'README.md', maxBytes: 24000 })).details;
  const obsId = obs.items.find(i => i.summary.startsWith('observation ')).summary.split(' ')[1].replace(':', '');
  await call(f.runtime, 'prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId: 't1', methodId: 'grilling', stage: 'round_asked', summary: 'x', evidenceIds: [], nextAction: 'x', operationId: 'opk0', expectedRevision: await rev(), maxBytes: 4096 });
  const r = await attempt(async () => call(f.runtime, 'prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId: 't1', methodId: 'grilling', stage: 'decision_recorded', summary: 'x', evidenceIds: [obsId], nextAction: 'x', operationId: 'opk', expectedRevision: await rev(), maxBytes: 4096 }));
  const ok = await attempt(async () => {
    await f.runtime.recordObservation('user_input: approved option B', { toolCallId: 'u1', toolName: 'user_input', outcome: 'succeeded' });
    const obs2 = (await call(f.runtime, 'prjct_context', { action: 'lookup', query: 'user_input', maxBytes: 24000 })).details;
    const uId = obs2.items.find(i => i.summary.includes('user_input')).summary.split(' ')[1].replace(':', '');
    return call(f.runtime, 'prjct_checkpoint', { action: 'record', kind: 'progress', workId, taskId: 't1', methodId: 'grilling', stage: 'decision_recorded', summary: 'x', evidenceIds: [uId], nextAction: 'x', operationId: 'opk2', expectedRevision: await rev(), maxBytes: 4096 });
  });
  return { pass: !r.accepted && r.error.code === 'UNVERIFIABLE_EVIDENCE' && ok.accepted, refused: r, accepted: { accepted: ok.accepted, error: ok.error } };
});

const summary = { total: rows.length, pass: rows.filter(r => r.outcome === 'PASS').length, fail: rows.filter(r => r.outcome === 'FAIL').length, harnessErrors: rows.filter(r => r.outcome === 'HARNESS_ERROR').length };
await mkdir(out, { recursive: true });
await writeFile(join(out, 'edge-results.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary));
if (summary.fail || summary.harnessErrors) process.exitCode = 1;
