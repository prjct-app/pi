import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Persistent job queue for prjct services. Jobs run one at a time inside the
// hosting process; the queue file is shared across processes (two Pi sessions
// on one project), so claims go through a lock and a liveness check on the
// owning pid. Nothing here talks to a model or the UI: the host wires events.

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
export type JobRow = {
  id: string; status: JobStatus; attempt: number; reason: string; queuedAt: string;
  startedAt?: string; finishedAt?: string; durationMs?: number; pid?: number;
  summary?: string; error?: string; freshness?: Record<string, string>;
};
export type JobsFile = { jobs: Record<string, JobRow> };

export type ServiceRunContext = Readonly<{ signal: AbortSignal; onProgress: (done: number, total: number) => void }>;
export type ServiceOutcome = Readonly<{ summary: string; freshness: Record<string, string> }>;
export type Service = Readonly<{
  id: string;
  kind: 'mechanical' | 'model';
  dependsOn: readonly string[];
  /** True when the stored output no longer matches the checkout. Missing output counts as stale. */
  stale: () => Promise<boolean>;
  run: (ctx: ServiceRunContext) => Promise<ServiceOutcome>;
}>;

export type RunnerEvent =
  | { type: 'started'; id: string }
  | { type: 'progress'; id: string; done: number; total: number }
  | { type: 'finished'; id: string; summary: string; durationMs: number }
  | { type: 'failed'; id: string; error: string }
  | { type: 'idle'; ran: number; ids: string[] };

const LOCK_STALE_MS = 30_000;
const now = (): string => new Date().toISOString();

const isAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const withLock = async <T>(path: string, task: () => Promise<T>): Promise<T> => {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lock, 'wx');
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) { await unlink(lock).catch(() => undefined); continue; }
      if (attempt > 200) throw Object.assign(new Error('Job queue is locked by another process.'), { code: 'STORE_LOCKED' });
      await new Promise(resolve => setTimeout(resolve, 10 + Math.min(attempt, 20) * 5));
    }
  }
  try { return await task(); } finally { await unlink(lock).catch(() => undefined); }
};

const readJobs = async (path: string): Promise<JobsFile> => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<JobsFile>;
    return { jobs: parsed.jobs ?? {} };
  } catch { return { jobs: {} }; }
};

const writeJobs = async (path: string, file: JobsFile): Promise<void> => {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(file), { flag: 'wx' });
  await rename(tmp, path);
};

export class JobRunner {
  readonly path: string;
  private readonly services: Map<string, Service>;
  private readonly onEvent: (event: RunnerEvent) => void;
  private loop: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private currentId: string | undefined;

  constructor(options: { path: string; services: readonly Service[]; onEvent?: (event: RunnerEvent) => void }) {
    this.path = options.path;
    this.services = new Map(options.services.map(service => [service.id, service]));
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  get active(): boolean { return this.loop !== undefined; }
  get running(): string | undefined { return this.currentId; }
  serviceIds(): string[] { return [...this.services.keys()]; }

  read(): Promise<JobsFile> { return readJobs(this.path); }

  /**
   * Queue the named services when their output is stale or missing, plus any
   * stale dependency. `force` queues them even when current. Returns what was queued.
   */
  async enqueue(ids: readonly string[], reason: string, options: { force?: boolean } = {}): Promise<string[]> {
    const wanted = new Set<string>();
    const visit = async (id: string, forced: boolean): Promise<void> => {
      const service = this.services.get(id);
      if (!service || wanted.has(id)) return;
      for (const dep of service.dependsOn) await visit(dep, false);
      if (forced || await service.stale()) wanted.add(id);
    };
    for (const id of ids) await visit(id, options.force ?? false);
    return withLock(this.path, async () => {
      const file = await readJobs(this.path);
      const queued: string[] = [];
      for (const id of wanted) {
        const row = file.jobs[id];
        if (row && (row.status === 'queued' || (row.status === 'running' && isAlive(row.pid)))) continue;
        file.jobs[id] = { id, status: 'queued', attempt: (row?.attempt ?? 0) + 1, reason, queuedAt: now() };
        queued.push(id);
      }
      if (queued.length) await writeJobs(this.path, file);
      return queued;
    });
  }

  /** Queue every mechanical service whose stored output is stale. Model services only run on request. */
  async enqueueStale(reason: string): Promise<string[]> {
    const stale: string[] = [];
    for (const service of this.services.values()) if (service.kind === 'mechanical' && await service.stale()) stale.push(service.id);
    return stale.length ? this.enqueue(stale, reason) : [];
  }

  /** Re-queue jobs left interrupted (or running by a dead process). */
  async resume(): Promise<string[]> {
    return withLock(this.path, async () => {
      const file = await readJobs(this.path);
      const resumed: string[] = [];
      for (const row of Object.values(file.jobs)) {
        if (row.status === 'interrupted' || (row.status === 'running' && !isAlive(row.pid))) {
          file.jobs[row.id] = { id: row.id, status: 'queued', attempt: row.attempt, reason: 'resume', queuedAt: now() };
          resumed.push(row.id);
        }
      }
      if (resumed.length) await writeJobs(this.path, file);
      return resumed;
    });
  }

  start(): void {
    if (this.loop) return;
    this.controller = new AbortController();
    this.loop = this.drain(this.controller.signal).catch(() => undefined).finally(() => { this.loop = undefined; this.controller = undefined; });
  }

  /** Wait for the queue to drain (tests and headless hosts). */
  async idle(): Promise<void> { await this.loop; }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
  }

  private async claim(signal: AbortSignal): Promise<JobRow | undefined> {
    if (signal.aborted) return undefined;
    return withLock(this.path, async () => {
      const file = await readJobs(this.path);
      const rows = Object.values(file.jobs);
      for (const row of rows) {
        if (row.status !== 'queued') continue;
        const service = this.services.get(row.id);
        if (!service) continue;
        const deps = service.dependsOn.map(id => file.jobs[id]);
        if (deps.some(dep => dep && dep.status === 'failed')) {
          file.jobs[row.id] = { ...row, status: 'failed', finishedAt: now(), error: 'A dependency failed.' };
          continue;
        }
        const blocked = service.dependsOn.some(id => { const dep = file.jobs[id]; return dep && dep.status !== 'done'; });
        if (blocked) continue;
        const claimed: JobRow = { ...row, status: 'running', startedAt: now(), pid: process.pid };
        file.jobs[row.id] = claimed;
        await writeJobs(this.path, file);
        return claimed;
      }
      await writeJobs(this.path, file);
      return undefined;
    });
  }

  private async settle(id: string, patch: Partial<JobRow>): Promise<void> {
    await withLock(this.path, async () => {
      const file = await readJobs(this.path);
      const row = file.jobs[id];
      if (!row) return;
      file.jobs[id] = { ...row, ...patch };
      await writeJobs(this.path, file);
    });
  }

  private async drain(signal: AbortSignal): Promise<void> {
    let ran = 0;
    const ids: string[] = [];
    while (!signal.aborted) {
      const row = await this.claim(signal);
      if (!row) break;
      const service = this.services.get(row.id)!;
      this.currentId = row.id;
      this.onEvent({ type: 'started', id: row.id });
      const started = Date.now();
      try {
        const outcome = await service.run({ signal, onProgress: (done, total) => this.onEvent({ type: 'progress', id: row.id, done, total }) });
        const durationMs = Date.now() - started;
        await this.settle(row.id, { status: 'done', finishedAt: now(), durationMs, summary: outcome.summary, freshness: outcome.freshness, error: undefined as unknown as string });
        ran += 1;
        ids.push(row.id);
        this.onEvent({ type: 'finished', id: row.id, summary: outcome.summary, durationMs });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        if (signal.aborted) { await this.settle(row.id, { status: 'interrupted', finishedAt: now() }); break; }
        await this.settle(row.id, { status: 'failed', finishedAt: now(), durationMs: Date.now() - started, error: message });
        this.onEvent({ type: 'failed', id: row.id, error: message });
      } finally {
        this.currentId = undefined;
      }
    }
    this.onEvent({ type: 'idle', ran, ids });
  }
}

export const formatJobs = (file: JobsFile, order: readonly string[]): string[] => {
  const rows = order.map(id => file.jobs[id]).filter((row): row is JobRow => Boolean(row));
  if (!rows.length) return ['  (no services have run yet)'];
  const width = Math.max(...rows.map(row => row.id.length));
  return rows.map(row => {
    const duration = row.durationMs !== undefined ? `${(row.durationMs / 1000).toFixed(1)}s` : '';
    const detail = row.status === 'failed' ? row.error ?? '' : row.status === 'done' ? row.summary ?? '' : row.reason;
    return `  ${row.id.padEnd(width)}  ${row.status.padEnd(11)} ${duration.padStart(6)}  ${detail.slice(0, 96)}`;
  });
};
