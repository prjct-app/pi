import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from './test-paths.ts';
import { join } from 'node:path';
import test from 'node:test';
import { readRecord, readRevision } from '../src/workspace/store.ts';

test('reading a missing store record does not create directories or files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-store-'));
  try {
    assert.equal(await readRecord(join(root, 'missing.json')), undefined);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { utimes, writeFile } from 'node:fs/promises';
import { publishImmutableFile, publishRecord } from '../src/workspace/store.ts';

test('an orphaned immutable body is reusable only when retry content is identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-immutable-'));
  try {
    const path = join(root, 'body.md');
    await publishImmutableFile(path, 'exact body');
    await publishImmutableFile(path, 'exact body');
    await assert.rejects(publishImmutableFile(path, 'different body'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'IMMUTABLE_CONFLICT');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a leftover temporary file is not treated as the published record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-tmp-'));
  try {
    const path = join(root, 'state.json');
    await writeFile(`${path}.tmp`, '{"revision":9,"payload":{"forged":true}}');
    assert.equal(await readRecord(path), undefined);
    await publishRecord(path, { expectedRevision: 0, payload: { ok: true } });
    const published = await readRecord(path);
    assert.equal(published?.revision, 1);
    assert.deepEqual(published?.payload, { ok: true });
    assert.equal(published?.contentHash.length, 64);
    assert.equal((await readdir(root)).includes('state.json.tmp'), true); // Preserve pre-existing recovery evidence.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a trusted publication root rejects symlinked descendant directories', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-store-symlink-'));
  try {
    const trusted = join(root, 'work');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(trusted), mkdir(outside)]);
    await symlink(outside, join(trusted, 'sessions'), 'dir');
    await assert.rejects(() => publishRecord(join(trusted, 'sessions', '20260909', 'writer.json'), {
      expectedRevision: 0, payload: { escaped: true }, directoryRoot: trusted,
    }), { code: 'UNSAFE_SYMLINK' });
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a trusted publication root rejects a symlinked revisions directory', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-store-revisions-symlink-'));
  try {
    const trusted = join(root, 'work');
    const outside = join(root, 'outside');
    const recordDirectory = join(trusted, 'sessions', '20260909');
    await Promise.all([mkdir(recordDirectory, { recursive: true }), mkdir(outside)]);
    await symlink(outside, join(recordDirectory, 'revisions'), 'dir');
    await assert.rejects(() => publishRecord(join(recordDirectory, 'writer.json'), {
      expectedRevision: 0, payload: { escaped: true }, directoryRoot: trusted,
    }), { code: 'UNSAFE_SYMLINK' });
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale expected revision cannot overwrite a published record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-stale-'));
  try {
    const path = join(root, 'state.json');
    await publishRecord(path, { expectedRevision: 0, payload: { v: 1 } });
    await assert.rejects(() => publishRecord(path, { expectedRevision: 0, payload: { v: 2 } }), { code: 'STALE_REVISION' });
    const stored = await readRecord(path);
    assert.equal(stored?.revision, 1);
    assert.deepEqual(stored?.payload, { v: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native cancellation prevents publishing a new record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-abort-'));
  try {
    const path = join(root, 'state.json');
    await assert.rejects(() => publishRecord(path, { expectedRevision: 0, payload: { v: 1 }, signal: AbortSignal.abort() }),
      { name: 'AbortError' });
    assert.equal(await readRecord(path), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('truncated JSON is corrupt rather than silently repaired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-bad-'));
  try {
    const path = join(root, 'state.json');
    await writeFile(path, '{"revision":1');
    await assert.rejects(() => readRecord(path), { code: 'CORRUPT_STATE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { spawn } from 'node:child_process';

const worker = (path: string, payload: string) => new Promise<{ status: number | null; stdout: string }>(resolve => {
  const child = spawn(process.execPath, ['--experimental-strip-types', new URL('./store-worker.ts', import.meta.url).pathname, path, payload],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.on('close', status => resolve({ status, stdout }));
});

test('two processes cannot both commit the first revision of the same record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-race-'));
  try {
    const path = join(root, 'state.json');
    const [first, second] = await Promise.all([worker(path, 'a'), worker(path, 'b')]);
    const outcomes = [first, second].map(item => JSON.parse(item.stdout) as { ok: boolean; code?: string; published?: { payload: string } });
    assert.equal(outcomes.filter(item => item.ok).length, 1);
    assert.equal(outcomes.filter(item => item.code === 'STALE_REVISION' || item.code === 'STORE_LOCKED').length, 1);
    const stored = await readRecord(path);
    assert.equal(stored?.revision, 1);
    assert.ok(stored?.payload === 'a' || stored?.payload === 'b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two stale-lock recoverers cannot remove a newly acquired lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-recovery-race-'));
  try {
    const path = join(root, 'state.json');
    const lock = `${path}.lock`;
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, createdAt: 0 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const [first, second] = await Promise.all([worker(path, 'a'), worker(path, 'b')]);
    const outcomes = [first, second].map(item => JSON.parse(item.stdout) as { ok: boolean; code?: string });
    assert.equal(outcomes.filter(item => item.ok).length, 1);
    assert.equal(outcomes.filter(item => item.code === 'STALE_REVISION' || item.code === 'STORE_LOCKED').length, 1);
    assert.equal((await readRecord(path))?.revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown record schema is not loaded as current state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-schema-'));
  try {
    const path = join(root, 'state.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 99, revision: 1, payload: { ok: true } }));
    await assert.rejects(() => readRecord(path), { code: 'UNSUPPORTED_SCHEMA' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishing a document keeps prior revisions instead of overwriting history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-hist-'));
  try {
    const path = join(root, 'state.json');
    await publishRecord(path, { expectedRevision: 0, payload: { v: 1 } });
    await publishRecord(path, { expectedRevision: 1, payload: { v: 2 } });
    const current = await readRecord(path);
    const first = await readRevision(path, 1);
    const second = await readRevision(path, 2);
    assert.deepEqual(first?.payload, { v: 1 });
    assert.deepEqual(second?.payload, { v: 2 });
    assert.deepEqual(current?.payload, { v: 2 });
    assert.equal(current?.revision, 2);
    assert.notEqual(first?.contentHash, second?.contentHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale lock from a dead process is recovered without weakening revision checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-stale-lock-'));
  try {
    const path = join(root, 'state.json');
    const lock = `${path}.lock`;
    await writeFile(lock, JSON.stringify({ pid: 999_999_999, createdAt: 0 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const published = await publishRecord(path, { expectedRevision: 0, payload: { recovered: true } });
    assert.equal(published.revision, 1);
    assert.deepEqual((await readRecord(path))?.payload, { recovered: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('light durability still keeps history, the lock, and the revision check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prjct-light-'));
  try {
    const path = join(root, 'state.json');
    await publishRecord(path, { expectedRevision: 0, payload: { v: 1 }, durability: 'light' });
    await publishRecord(path, { expectedRevision: 1, payload: { v: 2 }, durability: 'light' });
    assert.deepEqual((await readRevision(path, 1))?.payload, { v: 1 });
    assert.deepEqual((await readRevision(path, 2))?.payload, { v: 2 });
    assert.deepEqual((await readRecord(path))?.payload, { v: 2 });
    await assert.rejects(() => publishRecord(path, { expectedRevision: 1, payload: { v: 3 }, durability: 'light' }), { code: 'STALE_REVISION' });
    await writeFile(`${path}.lock`, '');
    await assert.rejects(() => publishRecord(path, { expectedRevision: 2, payload: { v: 3 }, durability: 'light' }), { code: 'STORE_LOCKED' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
