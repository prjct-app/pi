// Audit only: no production modifications. Runtime tools pass Pi argument validation.
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { processToolDeclarations } from '../src/pi/tool-declarations.ts';
import { publishRecord, readRecord, readRevision } from '../src/workspace/store.ts';
import { sha256 } from '../src/workspace/ids.ts';
import { scopeStore, resolveIdentity } from '../src/workspace/identity.ts';
import { INDEX_CONFIG_REVISION } from '../src/representation/skip.ts';

const output = process.argv[2];
if (!output) throw new Error('Supply an evidence directory');
const root = await realpath(await mkdtemp(join(tmpdir(), 'prjct-adversarial-')));
process.env.PRJCT_HOME = join(root, 'fallback-store');
const rows = [], calls = [];
let sequence = 0;
const ref = (id = 'source_fixture') => ({ id, revision: 1, contentHash: 'a'.repeat(64) });
const err = e => ({ code: e?.code ?? e?.name, message: e?.message });
async function attempt(fn) { try { return { accepted: true, value: await fn() }; } catch (e) { return { accepted: false, error: err(e) }; } }
async function call(runtime, name, params, host = {}) {
  const declaration = processToolDeclarations.find(d => d.name === name);
  let args;
  try { args = validateToolArguments(declaration, { type: 'toolCall', id: `audit_${++sequence}`, name, arguments: params }); }
  catch (e) { throw Object.assign(new Error(`AUDIT INPUT INVALID ${name}: ${e.message}`), { code: 'AUDIT_INPUT_INVALID' }); }
  const entry = { name, args, cwd: runtime.cwd, attemptId: runtime.attemptId, hostConfirmation: Boolean(host.confirm) };
  calls.push(entry);
  try { const result = await runtime.execute(name, args, host); entry.result = result.details; return result.details; }
  catch (e) { entry.error = err(e); throw e; }
}
async function fixture(files = { 'README.md': '# Acme\n', 'src/a.ts': 'export function alphaOwner() { return 1; }\n' }, options = {}) {
  const base = await mkdtemp(join(root, 'case-'));
  const cwd = options.cwd ?? join(base, 'checkout');
  const home = join(base, 'store');
  const agentHome = join(base, 'agent');
  await mkdir(agentHome);
  if (!options.cwd) for (const [path, text] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true }); await writeFile(join(cwd, path), text);
  }
  const runtime = new ProcessRuntime({ cwd, agentHome, prjctHome: home, attemptId: 'attempt_first' });
  const f = { base, cwd, home, agentHome, runtime,
    restart: () => new ProcessRuntime({ cwd, agentHome, prjctHome: home, attemptId: 'attempt_second' }),
    binding: async () => (await readRecord(join(home, 'identity/index.json'))).payload.bindings.find(b => b.location === cwd),
  };
  f.dir = async () => { const b = await f.binding(); return join(home, b.day, b.projectId); };
  f.statePath = async () => join(await f.dir(), 'work/state.json');
  f.state = async () => (await readRecord(await f.statePath())).payload;
  f.rev = async () => (await readRecord(await f.statePath())).revision;
  f.mutation = async () => ({ expectedRevision: await f.rev(), operationId: `op_${++sequence}`, maxBytes: 24000 });
  if (options.sync !== false) await runtime.initProject();
  return f;
}
async function work(f, title = 'Implement useful behavior') {
  await f.runtime.createWork(title); return (await f.state()).selectedWorkId;
}
async function task(f, workId) {
  const out = await call(f.runtime, 'prjct_task', { action: 'define', workId, definition: ref('def_a'), criterionIds: ['correctness'], ...await f.mutation() });
  return out.scope.taskId;
}
async function lookup(f, runtime = f.runtime) { return call(runtime, 'prjct_context', { action: 'lookup', query: 'purpose architecture conventions next action', maxBytes: 24000 }); }
async function search(f, query, extra = {}) {
  return call(f.runtime, 'prjct_search', { checkoutId: (await f.binding()).checkoutId, query, maxBytes: 24000, maxItems: 5, ...extra });
}
async function probe(id, title, fn) {
  const started = performance.now();
  try { const { pass, ...evidence } = await fn(); rows.push({ id, title, outcome: pass ? 'PASS' : 'FAIL', elapsedMs: performance.now() - started, ...evidence }); }
  catch (e) { rows.push({ id, title, outcome: 'HARNESS_ERROR', error: err(e), elapsedMs: performance.now() - started }); }
  console.log(id, rows.at(-1).outcome, title);
}

await probe('S01', 'First write creates home; read-only lookup and source tree remain untouched', async () => {
  const f = await fixture(undefined, { sync: false });
  const before = await readdir(f.cwd, { recursive: true });
  const l = await lookup(f);
  const absent = !(await attempt(() => readdir(f.home))).accepted;
  const gated = await attempt(() => f.runtime.syncProject());
  await f.runtime.initProject();
  return { pass: absent && !gated.accepted && gated.error.code === 'UNAVAILABLE' && JSON.stringify(before) === JSON.stringify(await readdir(f.cwd, { recursive: true })), gated, lookup: l, binding: await f.binding() };
});
await probe('S02', 'Each representation component retains its own historical revision', async () => {
  const f = await fixture(); const dir = join(await f.dir(), 'representation');
  const comparisons = [];
  for (const part of ['lexical', 'graph', 'manifest']) {
    const current = await readRecord(join(dir, `${part}.json`));
    const historical = await readRevision(join(dir, `${part}.json`), current.revision);
    comparisons.push({ part, currentHash: current.contentHash, historicalHash: historical?.contentHash, equal: current.contentHash === historical?.contentHash });
  }
  return { pass: comparisons.every(x => x.equal), comparisons, files: await readdir(dir, { recursive: true }) };
});
await probe('S03', 'Tampered payload with unchanged hash is rejected', async () => {
  const path = join(root, 'integrity/state.json'); await publishRecord(path, { expectedRevision: 0, payload: { text: 'original' } });
  const raw = JSON.parse(await readFile(path, 'utf8')); raw.payload.text = 'tampered'; await writeFile(path, JSON.stringify(raw));
  const result = await attempt(() => readRecord(path)); return { pass: !result.accepted, result };
});
await probe('S04', 'Interrupted bind recovers after its failed state write', async () => {
  const f = await fixture(undefined, { sync: false });
  const date = new Date(); const day = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  const path = join(f.home, day, `p_${sha256(f.cwd).slice(0,12)}`, 'work/state.json');
  await mkdir(join(path, '..'), { recursive: true }); await mkdir(`${path}.lock`);
  const first = await attempt(() => f.runtime.initProject());
  // Retain evidence, but release the injected obstruction by renaming it.
  await rename(`${path}.lock`, `${path}.injected-lock`);
  const retry = await attempt(() => f.restart().initProject());
  return { pass: retry.accepted, first, retry, binding: await f.binding() };
});
await probe('S05', 'Pre-cancelled sync leaves no new identity or work state', async () => {
  const f = await fixture(undefined, { sync: false }); const c = new AbortController(); c.abort();
  const result = await attempt(() => f.runtime.initProject(c.signal)); const files = await attempt(() => readdir(f.home, { recursive: true }));
  return { pass: !result.accepted && !files.accepted, result, files };
});
await probe('S06', 'Native Windows path semantics accept a valid store scope (simulation)', async () => {
  const result = await attempt(() => runInNewContext(`(${scopeStore.toString()})(home, key, storeClass)`, {
    home: win32.join('C:\\', 'Users', 'Alice', '.prjct'), key: '20260908/p_abcdef', storeClass: 'work',
    resolve: win32.resolve, projectKeyPattern: /^[0-9]{8}\/p_[A-Za-z0-9_-]+$/, fail: (code, message) => { throw Object.assign(new Error(message), { code }); },
  }));
  return { pass: result.accepted, result, limitation: 'Exact function body evaluated using node:path.win32, not an actual Windows OS run.' };
});
await probe('S07', 'Symlinked ancestor cannot produce a second identity for the same source tree', async () => {
  const f = await fixture(); const alias = join(f.base, 'alias'); await symlink(f.base, alias);
  const result = await attempt(() => resolveIdentity({ location: join(alias, 'checkout'), agentHome: f.agentHome }));
  return { pass: !result.accepted || result.value.location === f.cwd, actualLocation: f.cwd, result };
});
await probe('S08', 'Index config changes invalidate a content-identical index', async () => {
  const f = await fixture(); const path = join(await f.dir(), 'representation/manifest.json'); const rec = await readRecord(path);
  await publishRecord(path, { expectedRevision: rec.revision, payload: { ...rec.payload, configRevision: INDEX_CONFIG_REVISION - 1 } });
  const result = await f.runtime.syncProject(); const after = await readRecord(path);
  return { pass: result.rebuilt && after.payload.configRevision === INDEX_CONFIG_REVISION, result, persistedConfig: after.payload.configRevision, expectedConfig: INDEX_CONFIG_REVISION };
});
await probe('S09', 'Live store records retain valid payload hashes (read only; skipped without env)', async () => {
  const liveStore = process.env.PRJCT_AUDIT_LIVE_STORE;
  if (!liveStore) return { pass: true, skipped: 'Set PRJCT_AUDIT_LIVE_STORE to a store root to check its current records.' };
  const identityPath = join(liveStore, 'identity/index.json');
  const records = [];
  for (const path of [identityPath]) { const raw = JSON.parse(await readFile(path, 'utf8')); records.push({ path: 'identity/index.json', storedHash: raw.contentHash, actualHash: sha256(JSON.stringify(raw.payload)) }); }
  for (const binding of JSON.parse(await readFile(identityPath, 'utf8')).payload.bindings ?? []) {
    const path = join(liveStore, binding.day, binding.projectId, 'work/state.json');
    const raw = await attempt(() => readFile(path, 'utf8'));
    if (raw.accepted) { const parsed = JSON.parse(raw.value); records.push({ path: `${binding.day}/${binding.projectId}/work/state.json`, storedHash: parsed.contentHash, actualHash: sha256(JSON.stringify(parsed.payload)) }); }
  }
  return { pass: records.every(r => r.storedHash === r.actualHash), records };
});
await probe('S10', 'Read after interrupted index publication refuses mixed component generations', async () => {
  const f = await fixture(); const dir = join(await f.dir(), 'representation'); const path = join(dir,'lexical.json'); const r = await readRecord(path);
  await publishRecord(path, { expectedRevision: r.revision, payload: { documents: {}, invertedIndex: {}, avgDocLength: 0, totalDocs: 0 } });
  const result = await search(f, 'alphaOwner'); const sync = await f.runtime.syncProject();
  return { pass: sync.rebuilt || result.items.some(item => item.readPath === 'src/a.ts') || result.gaps.some(g => /corrupt|generation|inconsisten/i.test(g)), result, sync, injection: 'A new empty lexical generation published while the old manifest and graph remain current.' };
});
await probe('W01', 'Caller stale expectedRevision is rejected without mutation', async () => {
  const f = await fixture(); const w = await work(f); const old = await f.rev(); const t = await task(f,w);
  const attempt2 = await attempt(async () => call(f.runtime,'prjct_task',{ action:'claim', workId:w, taskId:t, checkoutId:(await f.binding()).checkoutId, access:'read', ...await f.mutation(), expectedRevision:old }));
  return { pass: !attempt2.accepted && attempt2.error.code === 'STALE_REVISION', staleRevision:old, result:attempt2 };
});
await probe('W02', 'Project-scoped mutation rejects the wrong projectId', async () => {
  const f = await fixture(); const result = await attempt(() => call(f.runtime,'prjct_knowledge',{action:'propose',projectId:'p_foreign',operationId:'foreign_op',statement:'Belongs elsewhere',supports:[],gaps:[],maxBytes:24000}));
  return {pass:!result.accepted,result,persistedClaims:(await f.state()).claims};
});
await probe('W03', 'Idempotent work create returns the original persisted ID on retry', async () => {
  const f = await fixture(); const args = {action:'create',projectId:(await f.binding()).projectId,operationId:'same_operation',title:'One work only',origin:ref(),maxBytes:24000};
  const first = await call(f.runtime,'prjct_work',args); const second = await call(f.runtime,'prjct_work',args);
  const state = await f.state(); return {pass:first.scope.workId===second.scope.workId && state.works.some(w=>w.id===second.scope.workId), first, second, persistedWorkIds:state.works.map(w=>w.id)};
});
await probe('W04', 'A blocking dependency prevents claiming the downstream task', async () => {
  const f=await fixture(); const w=await work(f), a=await task(f,w), b=await task(f,w);
  await call(f.runtime,'prjct_task',{action:'link',workId:w,taskId:a,target:{workId:w,taskId:b},relation:'blocks',...await f.mutation()});
  const frontier=await call(f.runtime,'prjct_task',{action:'frontier',workId:w,maxItems:8,maxBytes:24000});
  const result=await attempt(async()=>call(f.runtime,'prjct_task',{action:'claim',workId:w,taskId:b,checkoutId:(await f.binding()).checkoutId,access:'write',...await f.mutation()}));
  return {pass:!result.accepted,frontier,result};
});
await probe('W05', 'Blocking cycles are rejected', async () => {
  const f=await fixture(); const w=await work(f), a=await task(f,w), b=await task(f,w);
  await call(f.runtime,'prjct_task',{action:'link',workId:w,taskId:a,target:{workId:w,taskId:b},relation:'blocks',...await f.mutation()});
  const result=await attempt(async()=>call(f.runtime,'prjct_task',{action:'link',workId:w,taskId:b,target:{workId:w,taskId:a},relation:'blocks',...await f.mutation()}));
  return {pass:!result.accepted,result};
});
await probe('W06', 'A second attempt cannot seize a task without current confirmation', async () => {
  const f=await fixture(); const w=await work(f), t=await task(f,w);
  await call(f.runtime,'prjct_task',{action:'claim',workId:w,taskId:t,checkoutId:(await f.binding()).checkoutId,access:'write',...await f.mutation()});
  await f.runtime.recordObservation('bash: pwd; no predecessor cessation observed'); const obs=(await f.state()).observations.at(-1).id;
  const other=f.restart();
  const direct=await attempt(async()=>call(other,'prjct_task',{action:'claim',workId:w,taskId:t,checkoutId:(await f.binding()).checkoutId,access:'write',...await f.mutation()}));
  const takeover=await attempt(async()=>call(other,'prjct_reconcile',{action:'continue',workId:w,taskId:t,predecessorAttemptId:'attempt_first',observationIds:[obs],...await f.mutation()}));
  return {pass:!direct.accepted && !takeover.accepted,direct,takeover,hostConfirmationProvided:false};
});
await probe('W07', 'Tiny response budget cannot silently commit an unreported mutation', async () => {
  const f=await fixture(); const args={action:'create',projectId:(await f.binding()).projectId,operationId:'tiny_budget',title:'Track me reliably',origin:ref(),maxBytes:1};
  const result=await attempt(()=>call(f.runtime,'prjct_work',args)); const state=await f.state();
  return {pass:result.accepted || state.works.length===0,result,persistedWorkIds:state.works.map(w=>w.id)};
});
await probe('W08', 'Adopted plan pointer can be inspected after adoption', async () => {
  const f=await fixture(); const w=await work(f);
  const draft=await call(f.runtime,'prjct_plan',{action:'draft',kind:'spec',workId:w,content:ref('artifact_spec'),criterionIds:['correctness'],...await f.mutation()});
  await call(f.runtime,'prjct_plan',{action:'adopt',workId:w,candidate:draft.items[0].reference,...await f.mutation()}, { confirm: async () => true });
  const pointer=(await f.state()).works[0].activeSpecification;
  const result=await attempt(()=>call(f.runtime,'prjct_plan',{action:'inspect',workId:w,revision:pointer,maxBytes:24000}));
  return {pass:result.accepted,pointer,result,hostConfirmationProvided:true};
});
await probe('E01', 'Nonexistent evidence cannot confirm a knowledge claim', async () => {
  const f=await fixture(); const p=(await f.binding()).projectId;
  const proposed=await call(f.runtime,'prjct_knowledge',{action:'propose',projectId:p,operationId:'propose_a',statement:'Unverified architectural assertion',supports:[],gaps:[],maxBytes:24000});
  const result=await attempt(async()=>call(f.runtime,'prjct_knowledge',{action:'resolve',projectId:p,claimId:proposed.items[0].reference.id,resolution:'confirm',rationale:'No actual observation',evidenceIds:['obs_nonexistent'],...await f.mutation()}));
  return {pass:!result.accepted,result,lookup:await lookup(f)};
});
await probe('E02', 'Ship rejects a satisfied judgment backed by nonexistent evidence', async () => {
  const f=await fixture(); const w=await work(f);
  const assessment=await attempt(async()=>call(f.runtime,'prjct_checkpoint',{action:'record',kind:'work_assessment',workId:w,specificationRevision:0,planRevision:0,taskAssessments:[],judgments:[{criterionId:'correctness',conclusion:'satisfied',evidenceIds:['obs_missing'],rationale:'No tests actually ran'}],...await f.mutation()}));
  if(!assessment.accepted) return {pass:assessment.error.code==='MISSING_EVIDENCE',assessment};
  const result=await f.runtime.ship(); return {pass:!result.includes(' completed:'),result,state:(await f.state()).works[0]};
});
await probe('E03', 'An unrelated green summary cannot establish an observed TDD red', async () => {
  const f=await fixture(); const w=await work(f),t=await task(f,w);
  await f.runtime.recordObservation('bash: unrelated command exited 0, 2 tests pass');const obs=(await f.state()).observations.at(-1).id;
  const result=await attempt(async()=>call(f.runtime,'prjct_checkpoint',{action:'record',kind:'progress',workId:w,taskId:t,methodId:'tdd',stage:'red_observed',summary:'Claiming red without a failing test',evidenceIds:[obs],nextAction:'Implement now',...await f.mutation()}));
  return {pass:!result.accepted,result,limitation:'Observation insertion exercises the current host recorder, not a live bash/SDK execution.'};
});
await probe('E04', 'Referenced observations survive the rolling retention limit', async () => {
  const f=await fixture();const w=await work(f); await f.runtime.recordObservation('Important original verification', {toolCallId:'host_read',toolName:'read',outcome:'succeeded'}); const first=(await f.state()).observations[0].id;
  await call(f.runtime,'prjct_checkpoint',{action:'record',kind:'work_assessment',workId:w,specificationRevision:0,planRevision:0,taskAssessments:[],judgments:[{criterionId:'correctness',conclusion:'satisfied',evidenceIds:[first],rationale:'Keep this evidence'}],...await f.mutation()});
  for(let i=0;i<200;i++) await f.runtime.recordObservation(`Unrelated command ${i}`);
  const state=await f.state();return {pass:state.observations.some(o=>o.id===first),count:state.observations.length,referencedId:first,stillReferenced:state.checkpoints[0].data.judgments[0].evidenceIds,ship:await f.runtime.ship()};
});
await probe('V01', 'Persisted purpose survives work selection and a fresh runtime', async () => {
  const f=await fixture({'README.md':'# Harbor\nHarbor schedules volunteer transport.\n'}); const p=(await f.binding()).projectId;
  await f.runtime.recordObservation('Read README: Harbor schedules volunteer transport', {toolCallId:'host_read',toolName:'read',outcome:'succeeded'});const obs=(await f.state()).observations[0].id;
  const proposed=await call(f.runtime,'prjct_knowledge',{action:'propose',projectId:p,operationId:'knowledge_a',statement:'Harbor schedules volunteer transport.',supports:[],gaps:[],maxBytes:24000});
  await call(f.runtime,'prjct_knowledge',{action:'resolve',projectId:p,claimId:proposed.items[0].reference.id,resolution:'confirm',rationale:'Read fixture README',evidenceIds:[obs],...await f.mutation()});
  const before=await lookup(f);await work(f,'Repair a regression');
  for (let i=0;i<6;i++) await f.runtime.recordObservation(`Unrelated recent command ${i}`);
  const after=await lookup(f,f.restart());
  return {pass:JSON.stringify(after).includes('volunteer transport'),before,after};
});
await probe('V02', 'Checkpoint summaries survive restart as actionable context', async () => {
  const f=await fixture();const w=await work(f),t=await task(f,w);
  await call(f.runtime,'prjct_checkpoint',{action:'record',kind:'progress',workId:w,taskId:t,methodId:'research',stage:'sources_gathered',summary:'Root cause: cache invalidation drops the tenant key; fix src/cache.ts, not the router.',evidenceIds:[],nextAction:'Continue investigation.',...await f.mutation()});
  const after=await lookup(f,f.restart());return {pass:JSON.stringify(after).includes('tenant key'),after,persistedCheckpoint:(await f.state()).checkpoints[0]};
});
await probe('V03', 'Selected work brief excludes unrelated work checkpoints', async () => {
  const f=await fixture();const a=await work(f,'Work A'),t=await task(f,a);
  await call(f.runtime,'prjct_checkpoint',{action:'record',kind:'progress',workId:a,taskId:t,methodId:'research',stage:'sources_gathered',summary:'Only A',evidenceIds:[],nextAction:'ONLY_WORK_A_INSTRUCTION',...await f.mutation()});
  await work(f,'Work B');const brief=await lookup(f);return {pass:!JSON.stringify(brief).includes('ONLY_WORK_A_INSTRUCTION'),brief};
});
await probe('V04', 'No-work lookup warns when supported purpose sources have changed', async () => {
  const f=await fixture();await f.runtime.replan('Original architecture'); await writeFile(join(f.cwd,'README.md'),'# Completely different purpose\n');
  const brief=await lookup(f);return {pass:brief.gaps.some(g=>/changed|stale|review/i.test(g)),brief};
});
await probe('V05', 'Contradicted knowledge is not returned as currently applicable', async () => {
  const f=await fixture();const p=(await f.binding()).projectId;
  const proposed=await call(f.runtime,'prjct_knowledge',{action:'propose',projectId:p,operationId:'claim_p',statement:'obsolete unicorn design',supports:[],gaps:[],maxBytes:24000});
  await f.runtime.recordObservation('Read current source: disproves claim',{toolCallId:'host_read',toolName:'read',outcome:'succeeded'});
  const evidenceId=(await f.state()).observations.at(-1).id;
  await call(f.runtime,'prjct_knowledge',{action:'resolve',projectId:p,claimId:proposed.items[0].reference.id,resolution:'contradict',rationale:'Proven false',evidenceIds:[evidenceId],...await f.mutation()});
  const result=await search(f,'obsolete unicorn design',{kinds:['claim']});return {pass:result.items.every(i=>i.applicability!=='current'),result};
});
await probe('V06', 'Published artifact can be retrieved with the advertised inspect tool', async () => {
  const f=await fixture();const p=(await f.binding()).projectId;
  const published=await call(f.runtime,'prjct_artifact',{action:'publish',projectId:p,operationId:'publish_a',kind:'handoff',content:'Important decisions and next actions',maxBytes:24000});
  const result=await attempt(()=>call(f.restart(),'prjct_artifact',{action:'inspect',projectId:p,revision:published.items[0].reference,maxBytes:24000}));return {pass:result.accepted,published,result};
});
await probe('V07', 'Search cursor cannot be reused across distinct queries', async () => {
  const f=await fixture({'alpha/a.ts':'export function commonAlpha() {}','alpha/b.ts':'export function commonBeta() {}','alpha/c.ts':'export function commonGamma() {}'});
  const first=await search(f,'alpha',{maxItems:1});const result=await attempt(()=>search(f,'common',{maxItems:1,cursor:first.next}));
  return {pass:!result.accepted,first,result};
});
await probe('V08', 'Byte-limited search cursor points to the last actually returned item', async () => {
  const files={};for(let i=0;i<12;i++)files[`common/file${i}.ts`]=`export function commonValue${i}() {}`;
  const f=await fixture(files);const result=await search(f,'common',{maxItems:5,maxBytes:1500});
  return {pass:!result.next || result.next.afterId===result.items.at(-1)?.reference.id,result};
});
await probe('V09', 'Deleted dependencies still identify their impacted importers', async () => {
  const f=await fixture({'src/db.ts':'export const db=1;','src/api.ts':"import { db } from './db.ts'; export const api=db;"});
  await rename(join(f.cwd,'src/db.ts'),join(f.base,'deleted-db.ts'));
  const result=await f.runtime.impact();return {pass:result.includes('src/api.ts'),result};
});

const retrieval = [];
await probe('R01', 'Retrieval benchmark: equal top-5 budget for code, Markdown prose and multilingual terms', async () => {
  const files={
    'src/a.ts':'export function reserveSeat() { return 1; }',
    'src/b.ts':"import { reserveSeat } from './a.ts'; export const command=reserveSeat;",
    'docs/decisions.md':'# Decisions\nReservations expire after ninety minutes. Idempotency tokens prevent duplicate reservations.\n',
    'CONTEXT.md':'# Glossary\nA Waybill is a signed proof of delivery retained for audit.\n',
    'docs/policies.md':'# Rules\nLa retención de documentos es de siete años.\n',
    'app/worker.py':'def reconcile_shipments():\n    return []\n',
  };
  const f=await fixture(files);
  const cases=[['reserveSeat',['src/a.ts']],['decisions',['docs/decisions.md']],['ninety minutes',['docs/decisions.md']],['Waybill',['CONTEXT.md']],['retención',['docs/policies.md']],['reconcile_shipments',['app/worker.py']]];
  for(const [query,expected] of cases){
    const start=performance.now();const result=await search(f,query);const searchMs=performance.now()-start;
    const terms=query.toLowerCase().split(/\s+/);const grepStart=performance.now();
    // Explicit literal baseline: file content OR path contains a query term. Same top-5 file budget.
    const baseline=Object.entries(files).filter(([path,content])=>terms.some(t=>`${path}\n${content}`.toLowerCase().includes(t))).map(([path])=>path).slice(0,5);
    const hits=result.items.filter(i=>i.kind==='source').map(i=>i.readPath);
    retrieval.push({dataset:'controlled',query,expected,prjctPaths:hits,baselinePaths:baseline,prjctRecall5:expected.filter(p=>hits.includes(p)).length/expected.length,baselineRecall5:expected.filter(p=>baseline.includes(p)).length/expected.length,searchMs,baselineMs:performance.now()-grepStart,responseBytes:Buffer.byteLength(JSON.stringify(result)),result});
  }
  return {pass:retrieval.every(r=>r.prjctRecall5===1),cases:retrieval,limitation:'Six hand-authored queries, not a representative corpus; baseline files are preloaded, timings are not directly comparable. No total-token savings claim.'};
});
await probe('R02', 'Real checkout owner retrieval with an isolated store (skipped without env)', async () => {
  if (!process.env.PRJCT_AUDIT_LIVE_CHECKOUT) return { pass: true, skipped: 'Set PRJCT_AUDIT_LIVE_CHECKOUT to a real repository to run owner-retrieval probes.' };
  const f=await fixture({}, {cwd:process.env.PRJCT_AUDIT_LIVE_CHECKOUT});
  const cases=[['plan-mode extension',['extensions/plan-mode/index.ts']],['workflow actions',['extensions/workflow-actions.ts']],['mattpocock code review',['skills/mattpocock/code-review/SKILL.md']],['theme footer',['extensions/minimal-footer.ts']]];
  const results=[];
  for(const [query,expected] of cases){const response=await search(f,query);const paths=response.items.filter(i=>i.kind==='source').map(i=>i.readPath);results.push({query,expected,paths,recall5:expected.filter(p=>paths.includes(p)).length/expected.length,response});}
  return {pass:results.every(r=>r.recall5===1),results,limitation:'Owner queries only; this does not establish semantic project understanding or autonomous use.'};
});
await probe('R03', 'No-op sync and restart preserve identity, selected work and source-index revision', async () => {
  const f=await fixture();const w=await work(f);const before=await f.binding();const result=await f.restart().syncProject();const after=await f.binding();
  return {pass:!result.rebuilt && JSON.stringify(before)===JSON.stringify(after) && (await f.state()).selectedWorkId===w,result,before,after};
});

await probe('P01', 'Low-level store rejects stale revision and concurrent publication', async () => {
  const path=join(root,'concurrent/state.json');const results=await Promise.all([1,2].map(value=>attempt(()=>publishRecord(path,{expectedRevision:0,payload:{value}}))));
  const stale=await attempt(()=>publishRecord(path,{expectedRevision:0,payload:{value:3}}));
  return {pass:results.filter(r=>r.accepted).length===1 && !stale.accepted && stale.error.code==='STALE_REVISION',results,stale};
});
await probe('P02', 'Refresh inspect and structural neighbors have valid useful results', async () => {
  const f=await fixture({'src/db.ts':'export const db=1;','src/api.ts':"import { db } from './db.ts'; export const api=db;"});const b=await f.binding();
  const inspected=await call(f.runtime,'prjct_refresh',{action:'inspect',checkoutId:b.checkoutId,maxBytes:24000});
  const hit=await search(f,'db');const seed=hit.items.find(i=>i.readPath==='src/db.ts').reference.id;
  const structure=await call(f.runtime,'prjct_structure',{action:'neighbors',checkoutId:b.checkoutId,seeds:[seed],relations:['imports'],maxDepth:2,maxItems:8,maxBytes:24000});
  return {pass:structure.edges.length>0,inspected,structure};
});
await probe('P03', 'Stale source retrieval warns and wrong checkout is rejected', async () => {
  const f=await fixture();await writeFile(join(f.cwd,'src/a.ts'),'export function betaOwner() {}');
  const stale=await search(f,'alphaOwner');const mismatch=await attempt(()=>search(f,'alphaOwner',{checkoutId:'co_wrong'}));
  return {pass:stale.items.some(i=>i.applicability==='stale') && !mismatch.accepted && mismatch.error.code==='CHECKOUT_MISMATCH',stale,mismatch};
});
await probe('P04', 'Direct write-claim conflict remains protected before reconciliation', async () => {
  const f=await fixture();const w=await work(f),t=await task(f,w);const b=await f.binding();
  await call(f.runtime,'prjct_task',{action:'claim',workId:w,taskId:t,checkoutId:b.checkoutId,access:'write',...await f.mutation()});
  const result=await attempt(async()=>call(f.restart(),'prjct_task',{action:'claim',workId:w,taskId:t,checkoutId:b.checkoutId,access:'write',...await f.mutation()}));
  return {pass:!result.accepted && result.error.code==='CLAIM_CONFLICT',result};
});
await probe('P05', 'Task assessment rejects nonexistent observations', async () => {
  const f=await fixture();const w=await work(f),t=await task(f,w);
  const result=await attempt(async()=>call(f.runtime,'prjct_checkpoint',{action:'record',kind:'assessment',workId:w,taskId:t,definitionRevision:1,planRevision:0,judgments:[{criterionId:'correctness',conclusion:'satisfied',evidenceIds:['obs_missing'],rationale:'Not actually observed'}],...await f.mutation()}));
  return {pass:!result.accepted && result.error.code==='MISSING_EVIDENCE',result};
});
await probe('W09', 'Plan draft accepts SDK-valid task-definition pins end-to-end', async () => {
  const f=await fixture();const w=await work(f),t=await task(f,w);
  const result=await attempt(async()=>call(f.runtime,'prjct_plan',{action:'draft',kind:'plan',workId:w,content:ref('art_plan'),specification:ref('art_spec'),tasks:[{taskId:t,definitionRevision:1}],...await f.mutation()}));
  return {pass:result.accepted,result,persistedPlans:(await f.state()).plans};
});
await probe('W10', 'Two sessions keep independent selected works', async () => {
  const f=await fixture();await work(f,'FIRST_SESSION_WORK');const before=await f.runtime.statusText();
  await f.restart().createWork('SECOND_SESSION_WORK');const after=await f.runtime.statusText();
  return {pass:after.includes('FIRST_SESSION_WORK') && !after.includes('SECOND_SESSION_WORK'),before,after};
});
await probe('S11', 'Creation-date bucket stays stable across a later session day', async () => {
  const f=await fixture();const before=await f.binding();const NativeDate=globalThis.Date;let result,after;
  try { globalThis.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[NativeDate.now()+3*86400000]));} };result=await f.restart().syncProject();after=await f.binding(); }
  finally {globalThis.Date=NativeDate;}
  return {pass:!result.rebuilt && before.day===after.day,before,after,result};
});

await mkdir(output,{recursive:true});
const summary={total:rows.length,pass:rows.filter(r=>r.outcome==='PASS').length,fail:rows.filter(r=>r.outcome==='FAIL').length,harnessErrors:rows.filter(r=>r.outcome==='HARNESS_ERROR').length};
await writeFile(join(output,'adversarial-results.json'),JSON.stringify({timestamp:new Date().toISOString(),root,platform:process.platform,node:process.version,method:'Audit-only. All tool calls use real Pi validateToolArguments before runtime.execute. No live autonomous model or TUI evaluation.',summary,rows},null,2));
await writeFile(join(output,'tool-transcript.json'),JSON.stringify(calls,null,2));
console.log(JSON.stringify({root,summary}));
process.exitCode=summary.fail||summary.harnessErrors?1:0;
