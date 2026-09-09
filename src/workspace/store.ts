import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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

export const readRevision = async (path: string, revision: number): Promise<StoreRecord | undefined> =>
  readRecord(join(dirname(path), 'revisions', basename(path), `${revision}.json`));

export type PublishRequest = Readonly<{ expectedRevision: number; payload: unknown; signal?: AbortSignal }>;

const writeAtomic = async (path: string, value: unknown, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${newId('tmp')}`;
  const file = await open(tmp, 'wx');
  try {
    await file.writeFile(JSON.stringify(value), 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    signal?.throwIfAborted();
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(() => undefined); }
  // Directory fsync is supported on POSIX; Windows does not expose it here.
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
};

export const publishRecord = async (path: string, request: PublishRequest): Promise<StoreRecord> => {
  request.signal?.throwIfAborted();
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
    const contentHash = sha256(JSON.stringify(request.payload));
    const envelope = { schemaVersion: 1 as const, revision: nextRevision, contentHash, payload: request.payload };
    const historyPath = join(dirname(path), 'revisions', basename(path), `${nextRevision}.json`);
    const previousHistory = await readRecord(historyPath);
    if (previousHistory && (previousHistory.contentHash !== contentHash || previousHistory.revision !== nextRevision)) {
      fail('HISTORY_CONFLICT', 'An interrupted publication owns this revision; explicit recovery is required.');
    }
    if (!previousHistory) {
      await mkdir(dirname(historyPath), { recursive: true });
      const staged = `${historyPath}.${newId('tmp')}`;
      await writeAtomic(staged, envelope, request.signal);
      try { await link(staged, historyPath); } finally { await unlink(staged).catch(() => undefined); }
    }
    await writeAtomic(path, envelope, request.signal);
    return { revision: nextRevision, payload: request.payload, contentHash };
  } finally {
    await lock.close();
    await unlink(`${path}.lock`).catch(() => undefined);
  }
};
