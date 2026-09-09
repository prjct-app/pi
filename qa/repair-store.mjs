// Explicit, backup-checked repair of known current envelopes. Never alters old
// history or invents missing component revisions. Not run at extension startup.
import { readFile, writeFile, mkdir, open, rename, link, unlink, realpath } from 'node:fs/promises';
import { dirname, basename, join, resolve, relative } from 'node:path';
import { sha256, newId } from '../src/workspace/ids.ts';
import { readRecord } from '../src/workspace/store.ts';

export async function repairStore(home, backupRoot) {
  home = await realpath(home);
  const backupHome = await realpath(join(backupRoot, 'store'));
  const changes = [];
  async function recover(path, transform) {
    const rel = relative(home, path);
    if (rel.startsWith('..')) throw new Error('Repair path escapes store');
    const original = await readFile(path, 'utf8');
    const backup = await readFile(join(backupHome, rel), 'utf8');
    if (original !== backup) throw new Error(`Changed since backup; refusing ${rel}`);
    const lock = await open(`${path}.lock`, 'wx');
    try {
      if (await readFile(path, 'utf8') !== original) throw new Error('Concurrent edit detected');
      const old = JSON.parse(original);
      if (old.schemaVersion !== 1 || !Number.isSafeInteger(old.revision)) throw new Error('Unknown envelope');
      const payload = transform(structuredClone(old.payload));
      const revision = old.revision + 1;
      if (typeof payload.revision === 'number') payload.revision = revision;
      const contentHash = sha256(JSON.stringify(payload));
      const envelope = { schemaVersion: 1, revision, contentHash, payload };
      const history = join(dirname(path), 'revisions', basename(path), `${revision}.json`);
      await mkdir(dirname(history), { recursive: true });
      const temp = `${path}.${newId('repair')}`;
      const file = await open(temp, 'wx');
      try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
      try { await link(temp, history); await rename(temp, path); } finally { await unlink(temp).catch(() => undefined); }
      if (process.platform !== 'win32') { const dir = await open(dirname(path),'r'); try { await dir.sync(); } finally { await dir.close(); } }
      const verified = await readRecord(path);
      if (verified.contentHash !== contentHash) throw new Error('Repair verification failed');
      changes.push({ path, oldRevision: old.revision, revision, originalBytesHash: sha256(original), oldDeclaredHash: old.contentHash, contentHash });
    } finally { await lock.close(); await unlink(`${path}.lock`); }
  }
  const identityPath = join(home, 'identity/index.json');
  const identity = JSON.parse(await readFile(identityPath,'utf8'));
  for (const binding of identity.payload.bindings) {
    if (!/^p_[a-f0-9]{12}$/.test(binding.projectId) || !/^\d{8}$/.test(binding.day)) throw new Error('Unrecognized binding; repair needs explicit mapping');
    const statePath = join(home,binding.day,binding.projectId,'work/state.json');
    await recover(statePath, state => {
      state.projectId = binding.projectId;
      state.day = binding.day;
      state.location = binding.location;
      for (const work of state.works) work.projectId = binding.projectId;
      state.selections ??= {};
      // Prior summary-only observations remain preserved but never gain new authority.
      for (const observation of state.observations ?? []) if (!observation.execution) observation.provenance = 'agent_report';
      return state;
    });
  }
  await recover(identityPath, payload => ({ ...payload, bindings: payload.bindings.map(b => ({ ...b, initialized: true })) }));
  const report = { timestamp: new Date().toISOString(), home, backupRoot, changes,
    limitations: ['Shared pre-repair representation histories are irrecoverable from this store alone.', 'Old history is preserved unchanged; new history is namespaced by record filename.', 'Legacy receipts without original results require inspection, not blind retry.', 'Run explicit sync to rebuild the legacy index with pinned generations.'] };
  await writeFile(join(backupRoot,'repair-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: repair-store.mjs <home> <complete-backup-root>');
  console.log(JSON.stringify(await repairStore(process.argv[2],process.argv[3]),null,2));
}
