import { observeNative } from './native-observation.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessRuntime } from '../src/pi/process-runtime.ts';
import { projectKey, scopeStore } from '../src/workspace/identity.ts';
import { readRecord } from '../src/workspace/store.ts';

const origin = { id: 'origin_a', revision: 1, contentHash: 'a'.repeat(64) };
const definition = { id: 'def_a', revision: 1, contentHash: 'b'.repeat(64) };

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-page-'));
  const agentHome = join(root, 'agent-home');
  const prjctHome = join(root, 'prjct-home');
  const checkout = join(root, 'checkout');
  await mkdir(agentHome);
  await mkdir(checkout);
  await writeFile(join(checkout, 'main.ts'), 'export const main = 1;\n');
  const runtime = new ProcessRuntime({ agentHome, cwd: checkout, prjctHome, attemptId: 'attempt_one' });
  const ids = async () => {
    const idx = (await readRecord(join(prjctHome, 'identity', 'index.json')))!.payload as { bindings: Array<{ location: string; projectId: string; checkoutId: string; day: string }> };
    const b = idx.bindings.find(item => item.location === checkout)!;
    return { ...b, key: projectKey(b.day, b.projectId) };
  };
  const rev = async () => {
    const { key } = await ids();
    return (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!.revision;
  };
  return { root, checkout, runtime, ids, rev, prjctHome };
};

test('I-5: work list pages with a snapshot cursor and rejects a stale one', async () => {
  const { root, runtime, rev } = await setup();
  try {
    for (const title of ['one', 'two', 'three']) {
      await runtime.initProject();
      await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: `op_${title}`, title, origin, maxBytes: 4096 });
    }
    const first = await runtime.execute('prjct_work', { action: 'list', projectId: (await runtime.identity()).projectId, maxItems: 2, maxBytes: 4096 });
    const page1 = first.details as { items: Array<{ title: string }>; next?: { snapshot: unknown; afterId: string } };
    assert.equal(page1.items.length, 2);
    assert.ok(page1.next);
    const second = await runtime.execute('prjct_work', { action: 'list', projectId: (await runtime.identity()).projectId, maxItems: 2, maxBytes: 4096, cursor: page1.next });
    const page2 = second.details as { items: Array<{ title: string }>; next?: unknown };
    assert.equal(page2.items.length, 1);
    assert.equal(page2.next, undefined);
    assert.deepEqual([...page1.items, ...page2.items].map(item => item.title), ['one', 'two', 'three']);
    void rev;

    const forged = { snapshot: { ...(page1.next!.snapshot as object), revision: 999 }, afterId: page1.next!.afterId };
    await assert.rejects(async () => runtime.execute('prjct_work', { action: 'list', projectId: (await runtime.identity()).projectId, maxItems: 2, maxBytes: 4096, cursor: forged }),
      { code: 'STALE_CURSOR' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-5b: search pages with the index snapshot and refuses after a reindex', async () => {
  const { root, checkout, runtime, ids } = await setup();
  try {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(checkout, `handler${index}.ts`), `export function handleRequest${index}() { return ${index} }\n`);
    }
    await runtime.initProject();
    await runtime.initProject();
    await runtime.syncProject();
    const { checkoutId } = await ids();
    const first = await runtime.execute('prjct_search', { checkoutId, query: 'handleRequest', maxItems: 3, maxBytes: 8192 });
    const page1 = first.details as { items: Array<{ summary: string }>; next?: { snapshot: unknown; afterId: string } };
    assert.equal(page1.items.length, 3);
    assert.ok(page1.next);
    const second = await runtime.execute('prjct_search', { checkoutId, query: 'handleRequest', maxItems: 3, maxBytes: 8192, cursor: page1.next });
    const page2 = second.details as { items: Array<{ summary: string }> };
    assert.equal(page2.items.length >= 2, true);
    const all = new Set([...page1.items, ...page2.items].map(item => item.summary));
    assert.equal(all.size, page1.items.length + page2.items.length);

    await writeFile(join(checkout, 'main.ts'), 'export const main = 2;\n');
    await runtime.syncProject();
    await assert.rejects(async () => runtime.execute('prjct_search', { checkoutId, query: 'handleRequest', maxItems: 3, maxBytes: 8192, cursor: page1.next }),
      { code: 'STALE_CURSOR' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-6: reconcile inspect lists files changed since the last sync as unknown effects', async () => {
  const { root, checkout, runtime, rev } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    const work = await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_w', title: 'Cycle', origin, maxBytes: 2048 });
    const workId = (work.details as { scope: { workId: string } }).scope.workId;
    await writeFile(join(checkout, 'main.ts'), 'export const main = 9;\n');
    await writeFile(join(checkout, 'new.ts'), 'export const added = 1;\n');
    const inspection = await runtime.execute('prjct_reconcile', { action: 'inspect', workId, taskId: 't_any', maxBytes: 4096 });
    const details = inspection.details as { observedEffects: Array<{ id: string; outcome: string }>; unknowns: string[] };
    assert.equal(details.observedEffects.length, 2);
    assert.equal(details.observedEffects.every(item => item.outcome === 'unknown'), true);
    assert.match(details.unknowns[0]!, /2 file\(s\) changed/);
    void rev;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I-8: bare work command text lists works with the selected one marked', async () => {
  const { root, runtime } = await setup();
  try {
    assert.match(await runtime.listWorksText(), /No bound project/);
    await runtime.initProject();
    await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_a', title: 'Alpha', origin, maxBytes: 2048 });
    await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_b', title: 'Beta', origin, maxBytes: 2048 });
    const text = await runtime.listWorksText();
    assert.match(text, /Alpha/);
    assert.match(text, /Beta/);
    assert.match(text, /\[selected\] — Beta/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lookup without work answers the project profile instead of abstaining', async () => {
  const { root, checkout, runtime, ids } = await setup();
  try {
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' }, dependencies: { typebox: '1.3.7' } }));
    await mkdir(join(checkout, 'tests'));
    await writeFile(join(checkout, 'tests/main.test.ts'), 'import test from "node:test";\n');
    await runtime.initProject();
    await runtime.syncProject();
    const brief = await runtime.execute('prjct_context', { action: 'lookup', query: 'what is this project', maxBytes: 8192 });
    const text = JSON.stringify(brief.details);
    assert.match(text, /ecosystem node/);
    assert.match(text, /tools typebox/);
    assert.match(text, /scripts test/);
    assert.match(text, /tests present/);
    void ids;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('topic lookup returns only requested project context within a compact budget', async () => {
  const { root, checkout, runtime, ids, prjctHome } = await setup();
  try {
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' }, dependencies: { typebox: '1.3.7' } }));
    await runtime.initProject();
    await runtime.syncProject();
    await runtime.writeContextDoc('purpose', `# Purpose\n\n${'Relevant purpose detail. '.repeat(145)}\n`, {});
    for (let index = 0; index < 5; index += 1) {
      await runtime.recordObservation(`user_input: unrelated retained instruction ${index}`, {
        toolCallId: `user_${index}`, toolName: 'user_input', outcome: 'succeeded',
      });
    }

    const proposed = await runtime.execute('prjct_knowledge', {
      action: 'propose', projectId: (await runtime.identity()).projectId, operationId: 'op_context_claim',
      statement: 'An unrelated architecture claim must not leak into a stack and purpose lookup.',
      supports: [], gaps: [], maxBytes: 4096,
    });
    const claimId = (proposed.details as { items: Array<{ reference: { id: string } }> }).items[0]!.reference.id;
    const { key } = await ids();
    const statePath = join(scopeStore(prjctHome, key, 'work'), 'state.json');
    const state = (await readRecord(statePath))!;
    const observationId = (await runtime.readObservations())[0]!.id;
    await runtime.execute('prjct_knowledge', {
      action: 'resolve', projectId: (await runtime.identity()).projectId, claimId, resolution: 'confirm',
      rationale: 'Fixture setup.', evidenceIds: [observationId], operationId: 'op_context_resolve',
      expectedRevision: state.revision, maxBytes: 4096,
    });
    await runtime.execute('prjct_work', {
      action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_context_work',
      title: 'Unrelated selected work', origin, maxBytes: 4096,
    });

    const result = await runtime.execute('prjct_context', { action: 'lookup', query: 'stack purpose', maxBytes: 24_000 });
    const details = result.details as { status: string; items: Array<{ kind: string; summary: string }>; gaps: string[] };
    assert.deepEqual(details.items.map(item => item.kind), ['stack', 'purpose']);
    assert.equal(details.status, 'partial');
    assert.ok(details.gaps.some(gap => /compacted/.test(gap)));
    assert.equal(JSON.stringify(details).includes('observation '), false);
    assert.equal(JSON.stringify(details).includes('unrelated architecture claim'), false);
    assert.equal(JSON.stringify(details).includes('Unrelated selected work'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(details), 'utf8') <= 4096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a documentation-only project is understood through CONTEXT.md, ADRs and headings', async () => {
  const { root, checkout, runtime, ids } = await setup();
  try {
    await writeFile(join(checkout, 'README.md'), '# Vantyx Cockpit\n\nFleet ops console.\n');
    await writeFile(join(checkout, 'CONTEXT.md'), '# Glossary\n\n## Fleet\n\nA group of vessels.\n');
    await mkdir(join(checkout, 'docs', 'adr'), { recursive: true });
    await writeFile(join(checkout, 'docs', 'adr', '0001-sqlite.md'), '# SQLite for local state\n');
    await writeFile(join(checkout, 'docs', 'adr', '0002-no-cloud.md'), '# No cloud sync\n');
    await runtime.initProject();
    await runtime.syncProject();
    const brief = await runtime.execute('prjct_context', { action: 'lookup', query: 'what is this project', maxBytes: 8192 });
    const text = JSON.stringify(brief.details);
    assert.match(text, /ecosystem documentation/);
    assert.match(text, /Vantyx Cockpit/);
    assert.match(text, /CONTEXT\.md glossary/);
    assert.match(text, /2 ADRs/);
    void ids;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the test convention is in the brief and in the claim hint', async () => {
  const { root, checkout, runtime, ids, rev } = await setup();
  try {
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --experimental-strip-types --test tests/*.test.ts' } }));
    await mkdir(join(checkout, 'tests'));
    await writeFile(join(checkout, 'tests/main.test.ts'), 'import test from "node:test";\n');
    await runtime.initProject();
    await runtime.syncProject();
    const brief = await runtime.execute('prjct_context', { action: 'lookup', query: 'what is this', maxBytes: 8192 });
    assert.match(JSON.stringify(brief.details), /verify: node --experimental-strip-types --test/);
    assert.match(JSON.stringify(brief.details), /imitate tests\/main\.test\.ts/);

    const work = await runtime.execute('prjct_work', { action: 'create', projectId: (await runtime.identity()).projectId, operationId: 'op_w', title: 'T', origin, maxBytes: 2048 });
    const workId = (work.details as { scope: { workId: string } }).scope.workId;
    await runtime.execute('prjct_task', { action: 'define', workId, definition, criterionIds: ['c1'], operationId: 'op_d', expectedRevision: await rev(), taskId: 't1', maxBytes: 4096 });
    const { checkoutId } = await ids();
    const claimed = await runtime.execute('prjct_task', { action: 'claim', workId, taskId: 't1', checkoutId, access: 'write', operationId: 'op_c', expectedRevision: await rev(), maxBytes: 4096 }, { confirm: async () => true });
    assert.match((claimed.details as { items: Array<{ nextAction: string }> }).items[0]!.nextAction, /verify with node --experimental-strip-types --test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lookup nudges synthesis when the index exists but no supported claim does', async () => {
  const { root, checkout, runtime, ids, prjctHome } = await setup();
  try {
    await runtime.initProject();
    await runtime.syncProject();
    const before = await runtime.execute('prjct_context', { action: 'lookup', query: 'what is this', maxBytes: 8192 });
    assert.match(JSON.stringify(before.details), /Understanding not synthesized yet/);
    const proposed = await runtime.execute('prjct_knowledge', { action: 'propose', projectId: (await runtime.identity()).projectId, operationId: 'op_k',
      statement: 'This repo exposes alpha via a.ts.', supports: [], gaps: [], maxBytes: 4096 });
    const claimId = (proposed.details as { items: Array<{ reference: { id: string } }> }).items[0]!.reference.id;
    const { key } = await ids();
    const observationId = await observeNative(runtime);
    const stateRev = (await readRecord(join(scopeStore(prjctHome, key, 'work'), 'state.json')))!.revision;
    await runtime.execute('prjct_knowledge', { action: 'resolve', projectId: (await runtime.identity()).projectId, claimId, resolution: 'confirm',
      rationale: 'verified', evidenceIds: [observationId], operationId: 'op_r', expectedRevision: stateRev, maxBytes: 4096 });
    const after = await runtime.execute('prjct_context', { action: 'lookup', query: 'what is this', maxBytes: 8192 });
    assert.equal(JSON.stringify(after.details).includes('Understanding not synthesized yet'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('graph retrieval expands lexical seeds through imports with disclosed reasons', async () => {
  const { root, checkout, runtime, ids } = await setup();
  try {
    await mkdir(join(checkout, 'src'));
    await writeFile(join(checkout, 'src/db.ts'), 'export function queryUsers() { return [] }\n');
    await writeFile(join(checkout, 'src/users.ts'), "import { queryUsers } from './db.ts'\nexport function getUserById() { return queryUsers()[0] }\n");
    await writeFile(join(checkout, 'src/api.ts'), "import { getUserById } from './users.ts'\nexport function handleGet() { return getUserById() }\n");
    await runtime.initProject();
    await runtime.syncProject();
    const { checkoutId } = await ids();
    const found = await runtime.execute('prjct_search', { checkoutId, query: 'queryUsers', maxItems: 8, maxBytes: 8192 });
    const items = (found.details as { items: Array<{ summary: string; reasons: string[] }> }).items;
    const db = items.find(item => item.summary === 'src/db.ts');
    const users = items.find(item => item.summary === 'src/users.ts');
    const api = items.find(item => item.summary === 'src/api.ts');
    assert.ok(db);
    assert.ok(users);
    assert.ok(api);
    assert.equal(users!.reasons.some(reason => reason.includes('Graph neighbor: imports src/db.ts')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a nonexistent prjct home is created on first write, on any platform path layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-home-create-'));
  try {
    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    await writeFile(join(checkout, 'main.ts'), 'export const main = 1;\n');
    const prjctHome = join(root, 'deep', 'nested', '.prjct');
    const runtime = new ProcessRuntime({ agentHome: join(root, 'agent-home'), cwd: checkout, prjctHome });
    await mkdir(join(root, 'agent-home'));
    const result = await runtime.initProject();
    assert.equal(result.rebuilt, true);
    await runtime.syncProject();
    const { access } = await import('node:fs/promises');
    await access(join(prjctHome, 'identity', 'index.json'));
    const dayDirs = await readdir(prjctHome);
    await access(join(prjctHome, dayDirs.find(d => /^\d{8}$/.test(d))!, result.projectId, 'representation', 'manifest.json'));
    assert.deepEqual(await readdir(checkout), ['main.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
