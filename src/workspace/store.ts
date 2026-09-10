import { link, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { newId, sha256 } from './ids.ts';

export type StoreRecord = Readonly<{ revision: number; payload: unknown; contentHash: string }>;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const parseRecord = (raw: string): StoreRecord | undefined => {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('CORRUPT_STATE', 'Invalid record envelope.');
  const record = parsed as { schemaVersion?: unknown; revision?: unknown; payload?: unknown; contentHash?: unknown };
  if (record.schemaVersion !== 1) throw Object.assign(new Error('Store record schema is not supported.'), { code: 'UNSUPPORTED_SCHEMA' });
  const revision = record.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return fail('CORRUPT_STATE', 'Invalid record revision.');
  const contentHash = sha256(JSON.stringify(record.payload));
  if (record.contentHash !== contentHash) fail('CORRUPT_STATE', 'Payload hash mismatch; preserve the record and use explicit recovery.');
  return { revision, payload: record.payload, contentHash };
};

// Read-only. Missing or unreadable records stay missing; this never mkdir's.
export const readRecord = async (path: string): Promise<StoreRecord | undefined> => {
  try {
    return parseRecord(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if ((error as { code?: string }).code) throw error;
    throw Object.assign(new Error('Store record is unreadable.'), { code: 'CORRUPT_STATE' });
  }
};

// Stat-validated read cache for hot records (identity index, state). Every
// publication renames a new inode into place, so (ino, size, mtime) changes on
// each write, including writes by other processes sharing the store.
const recordCache = new Map<string, { ino: number; size: number; mtimeMs: number; record: StoreRecord | undefined }>();
export const readRecordCached = async (path: string): Promise<StoreRecord | undefined> => {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { recordCache.delete(path); return undefined; }
    throw error;
  }
  const cached = recordCache.get(path);
  if (cached && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.record;
  const record = await readRecord(path);
  recordCache.set(path, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, record });
  return record;
};

export const readRevision = async (path: string, revision: number): Promise<StoreRecord | undefined> =>
  readRecord(join(dirname(path), 'revisions', basename(path), `${revision}.json`));

// 'full' fsyncs file and directory (durable process mutations). 'light' fsyncs
// the file only; used for high-frequency evidence appends where losing the last
// entry on power loss is acceptable but corruption is not.
export type Durability = 'full' | 'light';
export type PublishRequest = Readonly<{
  expectedRevision: number; payload: unknown; signal?: AbortSignal; durability?: Durability;
  /** Existing trusted ancestor below which every created component must be a real directory. */
  directoryRoot?: string;
}>;

const STORE_LOCK_STALE_MS = 30_000;
const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // Lack of permission proves a process exists; only ESRCH proves it does not.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const acquireStoreLock = async (path: string) => {
  const lockPath = `${path}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  let recovery;
  try {
    recovery = await open(recoveryPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('STORE_LOCKED', 'Another writer is acquiring or recovering this record.');
    throw error;
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
          await handle.sync();
          return handle;
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const before = await stat(lockPath).catch(() => undefined);
        const raw = await readFile(lockPath, 'utf8').catch(() => '');
        let pid = 0;
        try { pid = Number((JSON.parse(raw) as { pid?: unknown }).pid ?? 0); } catch { /* Legacy/partial lock. */ }
        const stale = Boolean(before && Date.now() - before.mtimeMs >= STORE_LOCK_STALE_MS && !processAlive(pid));
        if (!stale) fail('STORE_LOCKED', 'Another writer holds this record.');
        // Every cooperating acquirer holds the recovery lock, so the pathname
        // cannot be replaced between this inode check and removal.
        const after = await stat(lockPath).catch(() => undefined);
        if (!before || !after || before.ino !== after.ino) fail('STORE_LOCKED', 'The store lock changed during recovery.');
        await unlink(lockPath);
      }
    }
    return fail('STORE_LOCKED', 'Another writer holds this record.');
  } finally {
    await recovery.close();
    await unlink(recoveryPath).catch(() => undefined);
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  // Directory fsync is supported on POSIX; Windows does not expose it here.
  if (process.platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
};

const writeAtomic = async (path: string, text: string, signal?: AbortSignal, durability: Durability = 'full'): Promise<void> => {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${newId('tmp')}`;
  const file = await open(tmp, 'wx');
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    signal?.throwIfAborted();
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(() => undefined); }
  if (durability === 'full') await syncDirectory(path);
};

// Atomically point `path` at the inode already holding `source` (one write per
// publication: the history file and the current record share their bytes).
const linkAtomic = async (source: string, path: string, signal?: AbortSignal, durability: Durability = 'full'): Promise<void> => {
  signal?.throwIfAborted();
  const tmp = `${path}.${newId('tmp')}`;
  await link(source, tmp);
  try { await rename(tmp, path); } finally { await unlink(tmp).catch(() => undefined); }
  if (durability === 'full') await syncDirectory(path);
};

// A retry may encounter a fully written immutable body whose metadata was not
// published before a crash. Identical bytes are safe to reuse; any difference
// is retained for explicit recovery rather than overwritten.
export const publishImmutableFile = async (path: string, content: string, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  let file;
  try {
    file = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readFile(path, 'utf8').catch(() => undefined) !== content) {
      fail('IMMUTABLE_CONFLICT', 'An interrupted immutable publication has different content; explicit recovery is required.');
    }
    return;
  }
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  signal?.throwIfAborted();
  await syncDirectory(path);
};

const ensureRealDirectoryPath = async (root: string, target: string): Promise<void> => {
  const anchor = resolve(root);
  const destination = resolve(target);
  const suffix = relative(anchor, destination);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    fail('PROHIBITED_PATH', 'Store publication escaped its trusted directory root.');
  }
  const verifyDirectory = async (path: string) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail('UNSAFE_SYMLINK', 'Store publication cannot traverse a symbolic-link directory.');
    if (!info.isDirectory()) fail('PROHIBITED_PATH', 'Store publication requires real directory components.');
  };
  await verifyDirectory(anchor);
  let current = anchor;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    await mkdir(current).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await verifyDirectory(current);
  }
};

export const publishRecord = async (path: string, request: PublishRequest): Promise<StoreRecord> => {
  request.signal?.throwIfAborted();
  const durability = request.durability ?? 'full';
  if (request.directoryRoot) await ensureRealDirectoryPath(request.directoryRoot, dirname(path));
  else await mkdir(dirname(path), { recursive: true });
  const lock = await acquireStoreLock(path);
  try {
    const current = await readRecord(path);
    const revision = current?.revision ?? 0;
    if (revision !== request.expectedRevision) {
      fail('STALE_REVISION', `Store record changed before the write; current revision is ${revision}.`);
    }
    const nextRevision = request.expectedRevision + 1;
    const payloadJson = JSON.stringify(request.payload);
    const contentHash = sha256(payloadJson);
    // Serialized once; parseRecord re-derives the hash from the parsed payload.
    const envelope = `{"schemaVersion":1,"revision":${nextRevision},"contentHash":"${contentHash}","payload":${payloadJson}}`;
    const historyPath = join(dirname(path), 'revisions', basename(path), `${nextRevision}.json`);
    if (request.directoryRoot) await ensureRealDirectoryPath(request.directoryRoot, dirname(historyPath));
    const previousHistory = await readRecord(historyPath);
    if (previousHistory && (previousHistory.contentHash !== contentHash || previousHistory.revision !== nextRevision)) {
      fail('HISTORY_CONFLICT', 'An interrupted publication owns this revision; explicit recovery is required.');
    }
    if (!previousHistory) await writeAtomic(historyPath, envelope, request.signal, durability);
    await linkAtomic(historyPath, path, request.signal, durability);
    return { revision: nextRevision, payload: request.payload, contentHash };
  } finally {
    await lock.close();
    await unlink(`${path}.lock`).catch(() => undefined);
  }
};
