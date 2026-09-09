import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
export type PublishRequest = Readonly<{ expectedRevision: number; payload: unknown; signal?: AbortSignal; durability?: Durability }>;

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

export const publishRecord = async (path: string, request: PublishRequest): Promise<StoreRecord> => {
  request.signal?.throwIfAborted();
  const durability = request.durability ?? 'full';
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try {
    lock = await open(`${path}.lock`, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('STORE_LOCKED', 'Another writer holds this record.');
    throw error;
  }
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
