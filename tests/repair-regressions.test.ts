import { validateToolArguments } from '@earendil-works/pi-ai';
import { processToolDeclarations } from '../src/pi/tool-declarations.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from './test-paths.ts';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { contentRef } from '../src/workspace/ids.ts';
import { publishRecord, readRecord } from '../src/workspace/store.ts';
import { INDEX_CONFIG_REVISION } from '../src/representation/skip.ts';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(),'prjct-repair-regression-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const cwd=join(root,'client'), agentHome=join(root,'agent'),prjctHome=join(root,'store');
  await mkdir(cwd);await mkdir(agentHome);await writeFile(join(cwd,'README.md'),'# Scheduling\nWaybill means signed proof of delivery.\n');
  const runtime=new ProcessRuntime({cwd,agentHome,prjctHome,sessionId:'session_a',attemptId:'attempt_a'});
  const execute = runtime.execute.bind(runtime);
  runtime.execute = (name, args, extras) => execute(name, validateToolArguments(processToolDeclarations.find(tool => tool.name === name)!, { type: 'toolCall', id: 'regression_call', name, arguments: args }), extras);
  await runtime.initProject();
  await runtime.initProject();
  await runtime.syncProject();
  const id=await runtime.identity();const statePath=join(prjctHome,id.day,id.projectId,'work/state.json');
  const record=()=>readRecord(statePath);const rev=async()=>(await record())!.revision;
  let n=0;const mutation=async()=>({operationId:`regression_${++n}`,expectedRevision:await rev(),maxBytes:24000});
  return {root,cwd,agentHome,prjctHome,runtime,id,statePath,record,rev,mutation};
}
const origin=contentRef('origin_fixture',1,{request:'repair'});

test('reordered retries replay the same durable result, changed payloads conflict',async t=>{
  const f=await setup(t);const params={action:'create',projectId:f.id.projectId,title:'One work',origin,operationId:'stable',maxBytes:24000};
  const first=await f.runtime.execute('prjct_work',params);
  const reversed=Object.fromEntries(Object.entries(params).reverse());
  assert.deepEqual(await f.runtime.execute('prjct_work',reversed),first);
  await assert.rejects(()=>f.runtime.execute('prjct_work',{...params,title:'Different work'}),{code:'OPERATION_CONFLICT'});
});

test('response failure does not publish process state or change session selection',async t=>{
  const f=await setup(t);await f.runtime.createWork('Existing selection');const before=await readFile(f.statePath,'utf8');
  await assert.rejects(()=>f.runtime.execute('prjct_work',{action:'create',projectId:f.id.projectId,title:'x'.repeat(256),origin,operationId:'overflow',maxBytes:600}),{code:'OUTPUT_LIMIT'});
  assert.equal(await readFile(f.statePath,'utf8'),before);assert.match(await f.runtime.statusText(),/Existing selection/);
});

test('config rebuild advances the applied generation without source changes',async t=>{
  const f=await setup(t);const path=join(f.prjctHome,f.id.day,f.id.projectId,'representation/manifest.json');const record=(await readRecord(path))!;
  const payload=record.payload as {appliedRevision:number;configRevision:number};
  await publishRecord(path,{expectedRevision:record.revision,payload:{...payload,configRevision:INDEX_CONFIG_REVISION-1}});
  await f.runtime.syncProject();const after=(await readRecord(path))!.payload as typeof payload;
  assert.equal(after.appliedRevision,payload.appliedRevision+1);assert.equal(after.configRevision,INDEX_CONFIG_REVISION);
});

test('adoption preserves exact content references across later supersession',async t=>{
  const f=await setup(t);await f.runtime.createWork('Plan continuity');const w=((await f.record())!.payload as {selectedWorkId:string}).selectedWorkId;
  const first=await f.runtime.execute('prjct_plan',{action:'draft',kind:'spec',workId:w,content:origin,criterionIds:['correct'],...await f.mutation()});
  const pin=(first.details as {items:Array<{reference:typeof origin}>}).items[0]!.reference;
  await assert.rejects(async()=>f.runtime.execute('prjct_plan',{action:'adopt',workId:w,candidate:pin,...await f.mutation()}),{code:'CONFIRMATION_REQUIRED'});
  await f.runtime.execute('prjct_plan',{action:'adopt',workId:w,candidate:pin,...await f.mutation()},{confirm:async()=>true});
  await f.runtime.execute('prjct_plan',{action:'inspect',workId:w,revision:pin,maxBytes:24000});
  const second=await f.runtime.execute('prjct_plan',{action:'draft',kind:'spec',workId:w,content:origin,criterionIds:['new_correct'],...await f.mutation()});
  const next=(second.details as {items:Array<{reference:typeof origin}>}).items[0]!.reference;assert.equal(next.revision,pin.revision+1);
  await f.runtime.execute('prjct_plan',{action:'adopt',workId:w,candidate:next,...await f.mutation()},{confirm:async()=>true});
  await f.runtime.execute('prjct_plan',{action:'inspect',workId:w,revision:pin,maxBytes:24000});
});

test('same session restores its own work despite another session becoming most recent',async t=>{
  const f=await setup(t);await f.runtime.createWork('Work A');
  const other=new ProcessRuntime({cwd:f.cwd,agentHome:f.agentHome,prjctHome:f.prjctHome,sessionId:'session_b',attemptId:'attempt_b'});
  await other.createWork('Work B');
  const restored=new ProcessRuntime({cwd:f.cwd,agentHome:f.agentHome,prjctHome:f.prjctHome,sessionId:'session_a',attemptId:'fresh_attempt'});
  assert.match(await restored.statusText(),/Work A/);assert.match(await other.statusText(),/Work B/);
});

test('concurrent host observations are retained through the native Pi file queue',async t=>{
  const f=await setup(t);await f.runtime.createWork('Concurrent event capture');
  await Promise.all(Array.from({length:12},(_,i)=>f.runtime.recordObservation(`Host event ${i}`,{toolCallId:`event_${i}`,toolName:'read',outcome:'succeeded'})));
  const rows=((await f.record())!.payload as {observations:unknown[]}).observations;assert.equal(rows.length,12);
});

test('artifact staging publishes exact content, inspect locates it, and export is not a destination write',async t=>{
  const f=await setup(t);const staged=await f.runtime.execute('prjct_artifact',{action:'stage',projectId:f.id.projectId,kind:'handoff',operationId:'stage',maxBytes:24000});
  type Item={reference:typeof origin;readLocator:string;stagedBlobId:string};
  const draft=(staged.details as {items:Item[]}).items[0]!;await writeFile(draft.readLocator,'Keep this exact handoff.');
  const {sha256}=await import('../src/workspace/ids.ts');
  await assert.rejects(()=>f.runtime.execute('prjct_artifact',{action:'publish',projectId:f.id.projectId,kind:'handoff',stagedBlobId:draft.stagedBlobId,expectedContentHash:'a'.repeat(64),operationId:'stale_blob',maxBytes:24000}),{code:'STALE_REVISION'});
  const published=await f.runtime.execute('prjct_artifact',{action:'publish',projectId:f.id.projectId,kind:'handoff',stagedBlobId:draft.stagedBlobId,expectedContentHash:sha256('Keep this exact handoff.'),operationId:'publish',maxBytes:24000});
  const item=(published.details as {items:Item[]}).items[0]!;assert.equal(await readFile(item.readLocator,'utf8'),'Keep this exact handoff.');
  await f.runtime.execute('prjct_artifact',{action:'inspect',projectId:f.id.projectId,revision:item.reference,maxBytes:24000});
  await f.runtime.execute('prjct_artifact',{action:'prepare_export',projectId:f.id.projectId,revision:item.reference,targetDescription:'Only an intent, never a write',operationId:'intent',maxBytes:24000});
});

test('malformed envelopes are corrupt rather than nonexistent writable state',async t=>{
  const f=await setup(t);const path=join(f.root,'malformed.json');await writeFile(path,'[]');
  await assert.rejects(()=>readRecord(path),{code:'CORRUPT_STATE'});
  await assert.rejects(()=>publishRecord(path,{expectedRevision:0,payload:{overwrite:true}}),{code:'CORRUPT_STATE'});
  assert.equal(await readFile(path,'utf8'),'[]');
});

test('a runtime override inside the client is rejected before the first write',async t=>{
  const f=await setup(t);const path=join(f.cwd,'deep','private-store');
  const runtime=new ProcessRuntime({cwd:f.cwd,agentHome:f.agentHome,prjctHome:path});
  await assert.rejects(()=>runtime.syncProject(),{code:'UNAVAILABLE'});
  await assert.rejects(()=>readFile(join(path,'identity/index.json')),{code:'ENOENT'});
});

test('refresh retries preserve their first result and an old config cannot appear current',async t=>{
  const f=await setup(t);const path=join(f.prjctHome,f.id.day,f.id.projectId,'representation/manifest.json');const record=(await readRecord(path))!;
  await publishRecord(path,{expectedRevision:record.revision,payload:{...record.payload as object,configRevision:INDEX_CONFIG_REVISION-1}});
  const view=await f.runtime.execute('prjct_refresh',{action:'inspect',checkoutId:f.id.checkoutId,maxBytes:24000});
  const detail=view.details as {freshness:string;observedRevision:number};assert.notEqual(detail.freshness,'current');
  const args={action:'apply',checkoutId:f.id.checkoutId,expectedRevision:detail.observedRevision,expectedConfigRevision:INDEX_CONFIG_REVISION,operationId:'refresh_retry',maxBytes:24000};
  const first=await f.runtime.execute('prjct_refresh',args);const before=await readFile(f.statePath,'utf8');
  assert.deepEqual(await f.runtime.execute('prjct_refresh',args),first);assert.equal(await readFile(f.statePath,'utf8'),before);
  assert.equal(((await readRecord(path))!.payload as {configRevision:number}).configRevision,INDEX_CONFIG_REVISION);
});

test('artifact cursors retain complete old pages while later artifacts are published',async t=>{
  const f=await setup(t);type D={items:Array<{reference:typeof origin}>;next?:unknown};
  for(let n=0;n<3;n++)await f.runtime.execute('prjct_artifact',{action:'publish',projectId:f.id.projectId,kind:'handoff',content:`Handoff ${n}`,operationId:`art_${n}`,maxBytes:24000});
  const args={action:'list',projectId:f.id.projectId,maxItems:1,maxBytes:24000};
  const first=(await f.runtime.execute('prjct_artifact',args)).details as D;assert.ok(first.next);
  await f.runtime.execute('prjct_artifact',{action:'publish',projectId:f.id.projectId,kind:'handoff',content:'Later handoff',operationId:'art_later',maxBytes:24000});
  const second=(await f.runtime.execute('prjct_artifact',{...args,cursor:first.next})).details as D;
  const third=(await f.runtime.execute('prjct_artifact',{...args,cursor:second.next})).details as D;
  assert.equal(new Set([...first.items,...second.items,...third.items].map(i=>i.reference.id)).size,3);assert.equal(third.next,undefined);
});

test('published artifact tampering is detected; export intentions are durable and replayable',async t=>{
  const f=await setup(t);const result=await f.runtime.execute('prjct_artifact',{action:'publish',projectId:f.id.projectId,kind:'handoff',content:'Authoritative handoff',operationId:'artifact',maxBytes:24000});
  const item=(result.details as {items:Array<{reference:typeof origin;readLocator:string}>}).items[0]!;
  const args={action:'prepare_export',projectId:f.id.projectId,revision:item.reference,targetDescription:'User must authorize a destination separately',operationId:'export_intent',maxBytes:24000};
  const first=await f.runtime.execute('prjct_artifact',args);assert.deepEqual(await f.runtime.execute('prjct_artifact',args),first);
  assert.equal(((await f.record())!.payload as {exportIntents:unknown[]}).exportIntents.length,1);
  await writeFile(item.readLocator,'Tampered');
  await assert.rejects(()=>f.runtime.execute('prjct_artifact',{action:'inspect',projectId:f.id.projectId,revision:item.reference,maxBytes:24000}),{code:'CORRUPT_STATE'});
});

test('profile manifest edits invalidate the index; unknown test files do not imply node:test',async t=>{
  const f=await setup(t);await writeFile(join(f.cwd,'pyproject.toml'),'[project]\nname="scheduling"\n');
  assert.equal((await f.runtime.syncProject()).rebuilt,true);
  await writeFile(join(f.cwd,'pyproject.toml'),'[project]\nname="changed-scheduling"\n');
  assert.equal((await f.runtime.syncProject()).rebuilt,true);
  const {detectProfile}=await import('../src/representation/profile.ts');
  await writeFile(join(f.cwd,'check.test.js'),'customTestRunner("case");');
  const profile=await detectProfile(f.cwd,[{relativePath:'check.test.js'}]);assert.equal(profile.tests.framework,'unknown');assert.equal(profile.tests.command,undefined);
});

test('native source reads can complete documentation tasks, but cannot bypass unfinished TDD',async t=>{
  const f=await setup(t);await f.runtime.createWork('Documentation review');const workId=((await f.record())!.payload as {selectedWorkId:string}).selectedWorkId;
  const taskId='task_docs';await f.runtime.execute('prjct_task',{action:'define',workId,taskId,definition:origin,criterionIds:['reviewed'],...await f.mutation()});
  await f.runtime.execute('prjct_task',{action:'claim',workId,taskId,checkoutId:f.id.checkoutId,access:'read',...await f.mutation()});
  const {createReadTool}=await import('@earendil-works/pi-coding-agent');const beforeHash=await f.runtime.sourceSnapshot();
  const read=await createReadTool(f.cwd).execute('native_read_docs',{path:'README.md'});assert.match(JSON.stringify(read),/Waybill/);
  await f.runtime.recordObservation('Native read of the exact document',{toolCallId:'native_read_docs',toolName:'read',outcome:'succeeded',sourcePaths:['README.md'],beforeHash});
  const obs=((await f.record())!.payload as {observations:Array<{id:string}>}).observations.at(-1)!;
  const assessment=await f.runtime.execute('prjct_checkpoint',{action:'record',kind:'assessment',workId,taskId,definitionRevision:1,planRevision:0,judgments:[{criterionId:'reviewed',conclusion:'satisfied',evidenceIds:[obs.id],rationale:'Native read covers the actual documentation.'}],...await f.mutation()});
  const assessmentId=(assessment.details as {recorded:{reference:typeof origin}}).recorded.reference.id;
  await f.runtime.execute('prjct_task',{action:'transition',workId,taskId,transition:'complete',assessmentId,...await f.mutation()});
  await f.runtime.execute('prjct_task',{action:'transition',workId,taskId,transition:'reopen',reason:'Check a method gate independently',...await f.mutation()});
  await f.runtime.execute('prjct_task',{action:'claim',workId,taskId,checkoutId:f.id.checkoutId,access:'read',...await f.mutation()});
  // TDD stage discipline: test_authored requires a user-confirmed seam first.
  await assert.rejects(async()=>f.runtime.execute('prjct_checkpoint',{action:'record',kind:'progress',workId,taskId,methodId:'tdd',stage:'test_authored',summary:'x',nextAction:'x',evidenceIds:[],...await f.mutation()}),{code:'INVALID_STAGE'});
  await f.runtime.recordObservation('user_input: seam confirmed for README review',{toolCallId:'seam_u1',toolName:'user_input',outcome:'succeeded'});
  const seamObs=((await f.record())!.payload as {observations:Array<{id:string}>}).observations.at(-1)!.id;
  await f.runtime.execute('prjct_checkpoint',{action:'record',kind:'progress',workId,taskId,methodId:'tdd',stage:'seam_confirmed',summary:'Seam confirmed.',nextAction:'Author test.',evidenceIds:[seamObs],...await f.mutation()});
  await f.runtime.execute('prjct_checkpoint',{action:'record',kind:'progress',workId,taskId,methodId:'tdd',stage:'test_authored',summary:'A test exists but no red/green has been observed.',nextAction:'Observe red before green.',evidenceIds:[],...await f.mutation()});
  await assert.rejects(async()=>f.runtime.execute('prjct_task',{action:'transition',workId,taskId,transition:'complete',assessmentId,...await f.mutation()}),{code:'INCOMPLETE_METHOD'});
});

test('identity lookup remains safe when cwd contains the runtime home',async t=>{
  const root=await mkdtemp(join(tmpdir(),'prjct-store-under-cwd-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const agentHome=join(root,'agent');await mkdir(agentHome);const cwd=root;const prjctHome=join(root,'private-store');
  const runtime=new ProcessRuntime({cwd,agentHome,prjctHome,sessionId:'nested',attemptId:'nested_attempt'});
  await runtime.execute('prjct_context',{action:'lookup',query:'no binding',maxBytes:24000});
  await assert.rejects(()=>runtime.syncProject(),{code:'UNAVAILABLE'});
  await assert.rejects(()=>runtime.initProject(),{code:'PROHIBITED_PATH'});
  assert.equal(await readFile(join(prjctHome,'identity/index.json')).catch(e=>e.code),'ENOENT');
});

test('sync does not create a store before explicit init',async t=>{
  const root=await mkdtemp(join(tmpdir(),'prjct-init-gate-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const agentHome=join(root,'agent');const prjctHome=join(root,'store');const cwd=join(root,'client');await mkdir(agentHome);await mkdir(cwd,{recursive:true});
  await writeFile(join(cwd,'README.md'),'# Init gated project\n');
  const runtime=new ProcessRuntime({cwd,agentHome,prjctHome});
  await assert.rejects(()=>runtime.syncProject(),{code:'UNAVAILABLE'});
  const init=await runtime.initProject();
  assert.equal(init.initialized,true);
  assert.equal(init.rebuilt,true);
  assert.match(init.text,/Initialized project/);
  assert.match(init.text,/Indexed 1 files/);
  assert.equal(await readFile(join(cwd,'README.md'),'utf8'),'# Init gated project\n');
  const synced=await runtime.syncProject();
  assert.equal(synced.rebuilt,false);
});

test('old receipts archive out of the hot document and still replay exactly',async t=>{
  const f=await setup(t);
  const results=[] as unknown[];
  for(let n=0;n<105;n++){
    const title=`Operation work ${n}`;
    results.push(await f.runtime.execute('prjct_work',{action:'create',projectId:f.id.projectId,title,origin,operationId:`grow_${n}`,maxBytes:24000}));
  }
  const record=await f.record();const doc=record!.payload as {operations:Record<string,unknown>;works:unknown[]};
  assert.ok(Object.keys(doc.operations).length<=100,'hot document must stay bounded');
  assert.equal(doc.works.length,105);
  const replay=await f.runtime.execute('prjct_work',{action:'create',projectId:f.id.projectId,title:'Operation work 0',origin,operationId:'grow_0',maxBytes:24000});
  assert.deepEqual(replay.details,results[0] && (results[0] as {details:unknown}).details,'archived receipt replays the original result');
  const archive=await readRecord(join(f.prjctHome,f.id.day,f.id.projectId,'work/receipts-archive.json'));
  assert.ok(archive,'archive record exists');
  const archived=(archive!.payload as {receipts:Record<string,{result?:unknown}>}).receipts;
  assert.ok(archived['grow_0']?.result,'archived receipt retains the original result');
});
