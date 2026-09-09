import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contentRef, newId, sha256 } from '../workspace/ids.ts';
import { assertStoreOutsideSource, bindIdentity, projectKey, resolveIdentity, scopeStore, type IdentityResolution } from '../workspace/identity.ts';
import { checkMutationPreconditions } from '../workspace/mutation-preconditions.ts';
import { publishRecord, readRecord, readRecordCached, readRevision, type Durability } from '../workspace/store.ts';
import { observeEvidence } from '../knowledge/evidence.ts';
import { redactSecrets } from '../knowledge/redact.ts';
import { outlineOf } from '../knowledge/digest.ts';
import { validateSearchResult } from '../knowledge/search-result.ts';
import { reverseImports } from '../representation/imports.ts';
import { scoreLexical, symbolMatchesQuery, tokenizeQuery } from '../representation/lexical.ts';
import { assertRefreshPreconditions } from '../representation/refresh-contract.ts';
import { describeRefresh } from '../representation/refresh-view.ts';
import { INDEX_CONFIG_REVISION } from '../representation/skip.ts';
import { validateStructureResult } from '../representation/structure-result.ts';
import {
  buildProjectIndex, diffHashes, reviveProjectIndex, sourceId, updateProjectIndex,
  type BuildOptions, type CollectedSources, type ProjectIndex,
} from '../representation/sync.ts';
import { readdir, rm } from 'node:fs/promises';
import { SourceCache, type SourceSnapshot } from '../representation/source-cache.ts';
import { collectHistory, gitHead, renderHistory, type ProjectHistory } from '../jobs/history.ts';
import { renderStack } from '../jobs/stack.ts';
import { assertMethodProgress, METHOD_STAGES } from '../work/method-progress.ts';
import { assertReuseAssessment } from '../work/checkpoint-contract.ts';
import { listMethodDocuments, loadMethodDocument, matchMethods, methodCatalog } from '../methods/registry.ts';
import { reconstructBinding } from '../work/session-binding.ts';
import { assessCompletion, type CompletionSnapshot } from '../work/completion.ts';
import { assertTaskTransition, type TransitionState } from '../work/transition-preconditions.ts';
import { validateContextResponse } from './context-contract.ts';
import { validateDiscoveryResponse } from './discovery-result.ts';
import { validateStateResult } from './state-result-contracts.ts';

export type ProcessRuntimeOptions = Readonly<{ agentHome: string; cwd: string; actorId?: string; attemptId?: string; sessionId?: string; prjctHome?: string }>;

type Ref = { id: string; revision: number; contentHash: string };
type WorkRow = { id: string; projectId: string; title: string; disposition: 'open' | 'paused' | 'completed' | 'abandoned' | 'archived';
  origins: Ref[]; activeSpecification: Ref | null; activePlan: Ref | null; taskIds: string[]; nextAction: string };
type TaskRow = { id: string; workId: string; disposition: 'not_started' | 'in_progress' | 'awaiting_input' | 'ready_for_verification' | 'completed' | 'cancelled';
  definition: Ref | null; criterionIds: string[]; blockers: Ref[]; attemptId: string | null; checkoutId?: string;
  grantStanding: 'none' | 'valid' | 'uncertain' | 'released' | 'revoked'; access: 'read' | 'write';
  definitionRevision: number; planRevision: number; nextAction: string };
type ClaimRow = { id: string; statement: string; standing: 'candidate' | 'supported' | 'needs_review' | 'contradicted' | 'superseded';
  supports: Ref[]; nextAction: string };
type ArtifactRow = { id: string; kind: string; content?: string; workId?: string; previous?: Ref; stagedBlobId: string | null; exportIntent: string | null; nextAction: string };
type CheckpointRow = { id: string; workId: string; taskId?: string; kind: string; nextAction: string; data?: unknown };
type PlanRow = { id: string; workId: string; kind: 'spec' | 'plan'; standing: 'draft' | 'active' | 'superseded';
  revision: number; content: Ref | null;
  specification: Ref | null; tasks: Array<{ taskId: string; definitionRevision: number }>; criterionIds: string[]; nextAction: string };
type GrantRow = { attemptId: string; generation: number; standing: 'valid' | 'uncertain' | 'released' | 'revoked' };
type EdgeRow = { from: string; to: string; relation: string };
export type HostExecution = { toolCallId: string; toolName: string; command?: string; outcome: 'succeeded' | 'failed' | 'unknown'; beforeHash?: string; sourcePaths?: string[] };
type ObservationRow = { id: string; provenance: 'native_observation' | 'agent_report'; summary: string; supports: Ref[];
  attemptId?: string; workId?: string; taskId?: string; execution?: HostExecution; verification?: boolean };
type Document = { projectId: string; checkoutId: string; location: string; day: string; revision: number;
  works: WorkRow[]; tasks: TaskRow[]; claims: ClaimRow[]; artifacts: ArtifactRow[];
  checkpoints: CheckpointRow[]; plans: PlanRow[]; selectedWorkId: string | null; selections?: Record<string, string | null>;
  edges: EdgeRow[]; observations: ObservationRow[];
  grants: { tasks: Record<string, GrantRow>; writer: (GrantRow & { checkoutId: string }) | null };
  exportIntents?: Array<{ revision: Ref; description: string; operationId: string }>;
  operations: Record<string, { actorId: string; requestHash: string; receipt: Ref; result?: ToolResult }>;
  refresh?: { revision: number; configRevision: number; components: Array<{ id: string; appliedRevision?: number; appliedConfigRevision?: number; lastAttempt: 'not_run' | 'succeeded' | 'failed' | 'cancelled' }> };
};

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: unknown };
// Current checkout state as evidence sees it: manifest hash plus per-source hashes keyed by src_ id.
type CurrentSources = Readonly<{ manifestHash: string; hashes: Record<string, string>; byId: Map<string, string> }>;
// Index metadata without the heavy lexical/graph parts (manifest.json only).
type IndexManifest = Readonly<Omit<ProjectIndex, 'lexical' | 'imports' | 'symbols' | 'cochange'> & { parts?: Record<string, Ref> }>;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const dayToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const jsonResult = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const DISCOVERABLE = ['prjct_search', 'prjct_structure', 'prjct_refresh', 'prjct_work', 'prjct_plan',
  'prjct_task', 'prjct_checkpoint', 'prjct_reconcile', 'prjct_knowledge', 'prjct_artifact'] as const;

const matchDiscover = (query: string): string[] => {
  const q = query.toLowerCase();
  const hits = new Set<string>();
  if (/work|ticket|objective|select/.test(q)) hits.add('prjct_work');
  if (/task|claim|block/.test(q)) hits.add('prjct_task');
  if (/plan|spec|scope/.test(q)) hits.add('prjct_plan');
  if (/progress|tdd|checkpoint|method/.test(q)) hits.add('prjct_checkpoint');
  if (/interrupt|continue|reconcil|resume/.test(q)) hits.add('prjct_reconcile');
  if (/search|find|retriev/.test(q)) hits.add('prjct_search');
  if (/structure|impact|import|call/.test(q)) hits.add('prjct_structure');
  if (/refresh|index|stale|delet|sync/.test(q)) hits.add('prjct_refresh');
  if (/claim|knowledge|understand/.test(q)) hits.add('prjct_knowledge');
  if (/artifact|export|publish|handoff/.test(q)) hits.add('prjct_artifact');
  return [...hits].filter((name): name is typeof DISCOVERABLE[number] => (DISCOVERABLE as readonly string[]).includes(name));
};

const MAX_OBSERVATIONS = 200;
const MAX_HOT_RECEIPTS = 100;

export class ProcessRuntime {
  readonly agentHome: string;
  readonly cwd: string;
  readonly actorId: string;
  readonly prjctRoot: string;
  readonly attemptId: string;
  readonly sessionId: string;
  private selection: string | null | undefined;
  private sourceCache: SourceCache | undefined;
  private identityPromise: Promise<IdentityResolution> | undefined;
  private currentCache: { generation: number; current: CurrentSources } | undefined;
  private walkShare = new AsyncLocalStorage<{ snapshot?: Promise<SourceSnapshot> }>();
  private indexCache: { manifestHash: string; index: ProjectIndex } | undefined;
  private transaction = new AsyncLocalStorage<{ params: Record<string, unknown>; hash: string; pending?: Document; baseRevision?: number; files?: Array<{ path: string; content: string; overwrite?: boolean }>; confirm?: (message: string) => Promise<boolean> }>();
  constructor(options: ProcessRuntimeOptions) {
    this.agentHome = options.agentHome;
    this.cwd = options.cwd;
    this.actorId = options.actorId ?? 'actor_session';
    this.attemptId = options.attemptId ?? newId('attempt');
    this.sessionId = options.sessionId ?? this.attemptId;
    this.prjctRoot = options.prjctHome ?? process.env.PRJCT_HOME ?? join(homedir(), '.prjct');
  }

  async statusText(): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return 'No work selected. Run /prjct init to connect the project (index, stack and history run in the background); /prjct analyze synthesizes understanding; /prjct work starts work afterwards. Trivial questions do not need this.';
    const state = await this.load(this.keyOf(bound));
    const work = state.works.find(item => item.id === state.selectedWorkId);
    return work
      ? `Selected ${work.id}: ${work.title} (${work.disposition}). Next: ${work.nextAction}`
      : `Bound project ${bound.projectId} has no selected work.`;
  }

  async execute(name: string, params: Record<string, unknown>, extras: { signal?: AbortSignal; activate?: (names: string[]) => void; confirm?: (message: string) => Promise<boolean> } = {}): Promise<ToolResult> {
    const bound = await this.peekBinding();
    const path = bound ? this.statePath(this.keyOf(bound)) : this.locatorPath();
    // One tool call is one host operation: every source check inside it sees the same walk.
    return withFileMutationQueue(path, () => this.shareWalk(() => this.executeQueued(name, params, extras)));
  }

  private async executeQueued(name: string, params: Record<string, unknown>, extras: { signal?: AbortSignal; activate?: (names: string[]) => void; confirm?: (message: string) => Promise<boolean> } = {}): Promise<ToolResult> {
    extras.signal?.throwIfAborted();
    if (params.operationId && Number(params.maxBytes) < 512) fail('OUTPUT_LIMIT', 'Mutation budget must fit an attributable receipt (at least 512 bytes).');
    const operationId = typeof params.operationId === 'string' ? params.operationId : undefined;
    const bound = await this.peekBinding();
    const projectId = bound?.projectId;
    if (projectId && params.projectId !== undefined && params.projectId !== projectId) fail('SCOPE_MISMATCH', `This project is ${projectId}.`);
    const requestHash = sha256(JSON.stringify({ name, params }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
    if (bound && operationId) {
      const state = await this.load(this.keyOf(bound));
      const prior = state.operations[operationId] ?? await this.archivedReceipt(this.keyOf(bound), operationId);
      if (prior) {
        if (prior.requestHash !== requestHash || prior.actorId !== this.actorId) fail('OPERATION_CONFLICT', 'Operation ID was used for a different request.');
        if (!prior.result) fail('RECONCILE_REQUIRED', 'Legacy receipt has no recoverable result. Inspect the stored state.');
        return prior.result!;
      }
      if (name !== 'prjct_refresh' && params.expectedRevision !== undefined && params.expectedRevision !== state.revision) {
        fail('STALE_REVISION', `Current state revision is ${state.revision}.`);
      }
    }
    if (!operationId) return this.dispatch(name, params, extras);
    // Validate the complete response before publishing any process-state mutation.
    const previousSelection = this.selection;
    return this.transaction.run({ params, hash: requestHash, ...(extras.confirm ? { confirm: extras.confirm } : {}) }, async () => {
      const result = await this.dispatch(name, params, extras);
      const frame = this.transaction.getStore()!;
      if (frame.pending) {
        const pending = frame.pending;
        for (const file of frame.files ?? []) {
          extras.signal?.throwIfAborted();
          await mkdir(join(file.path, '..'), { recursive: true });
          await writeFile(file.path, file.content, file.overwrite ? undefined : { flag: 'wx' });
        }
        const prior = pending.operations[operationId]!;
        pending.operations[operationId] = { ...prior, requestHash, result };
        await publishRecord(this.statePath(this.keyOf(pending)), { expectedRevision: frame.baseRevision!, payload: pending, ...(extras.signal ? { signal: extras.signal } : {}) });
      }
      return result;
    }).catch(error => { this.selection = previousSelection; throw error; });
  }

  private async dispatch(name: string, params: Record<string, unknown>, extras: { signal?: AbortSignal; activate?: (names: string[]) => void; confirm?: (message: string) => Promise<boolean> }): Promise<ToolResult> {
    if (name === 'prjct_context') return this.context(params, extras);
    if (name === 'prjct_work') return this.work(params, extras.signal);
    if (name === 'prjct_task') return this.task(params, extras.signal);
    if (name === 'prjct_plan') return this.plan(params, extras.signal);
    if (name === 'prjct_checkpoint') return this.checkpoint(params, extras.signal);
    if (name === 'prjct_reconcile') return this.reconcile(params, extras.signal);
    if (name === 'prjct_knowledge') return this.knowledge(params, extras.signal);
    if (name === 'prjct_artifact') return this.artifact(params, extras.signal);
    if (name === 'prjct_search') return this.search(params);
    if (name === 'prjct_structure') return this.structure(params);
    if (name === 'prjct_refresh') return this.refresh(params, extras.signal);
    return fail('INVALID_RESULT', `Unknown process tool ${name}.`);
  }

  private locatorPath() { return join(this.prjctRoot, 'identity', 'index.json'); }
  private statePath(key: string) { return join(scopeStore(this.prjctRoot, key, 'work'), 'state.json'); }
  private representationPartPath(key: string, part: 'manifest' | 'lexical' | 'graph') {
    return join(scopeStore(this.prjctRoot, key, 'representation'), `${part}.json`);
  }
  private historyPath(key: string) { return join(scopeStore(this.prjctRoot, key, 'representation'), 'history.json'); }
  private contextDocPath(key: string, id: string) { return join(scopeStore(this.prjctRoot, key, 'knowledge'), 'context', `${id}.json`); }
  /** Job queue of the bound project; undefined until /prjct init. */
  async jobsPath(): Promise<string | undefined> {
    const bound = await this.peekBinding();
    return bound ? join(scopeStore(this.prjctRoot, this.keyOf(bound), 'work'), 'jobs.json') : undefined;
  }
  /** Raw event log of the last run of a model service. */
  async jobLogPath(id: string): Promise<string | undefined> {
    const bound = await this.peekBinding();
    return bound ? join(scopeStore(this.prjctRoot, this.keyOf(bound), 'work'), 'jobs', `${id.replace(/[^a-z0-9_-]/gi, '_')}.jsonl`) : undefined;
  }

  async identity() { return this.previewIds(); }

  private async previewIds(): Promise<{ projectId: string; checkoutId: string; day: string }> {
    const bound = await this.peekBinding();
    if (bound) return bound;
    const resolution = await this.resolvedIdentity();
    await assertStoreOutsideSource(resolution.location, this.prjctRoot);
    return { projectId: `p_${sha256(resolution.location).slice(0, 12)}`, checkoutId: `co_${sha256(resolution.location).slice(0, 12)}`, day: dayToday() };
  }

  // Cheap metadata read (profile, hashes, revisions). Legacy manifests without
  // part pins are not an applied index and require an explicit rebuild.
  private async loadManifest(key: string): Promise<IndexManifest | undefined> {
    const manifest = await readRecordCached(this.representationPartPath(key, 'manifest'));
    const meta = manifest?.payload as IndexManifest | undefined;
    if (!manifest || !meta?.parts) return undefined;
    return meta;
  }

  private async loadIndex(key: string): Promise<ProjectIndex | undefined> {
    const manifest = await readRecordCached(this.representationPartPath(key, 'manifest'));
    const pins = (manifest?.payload as { parts?: Record<string, Ref> } | undefined)?.parts;
    if (!manifest || !pins) return undefined; // Legacy index requires explicit rebuild.
    if ((manifest.payload as { configRevision?: number }).configRevision !== INDEX_CONFIG_REVISION) return undefined; // Older encoding: treat as not applied until the next sync rebuilds it.
    if (this.indexCache?.manifestHash === manifest.contentHash) return this.indexCache.index;
    const [lexical, graph] = await Promise.all(['lexical', 'graph'].map(async part => {
      const pin = pins[part];
      if (!pin) return undefined;
      const record = await readRevision(this.representationPartPath(key, part as 'lexical' | 'graph'), pin.revision);
      if (!record || record.contentHash !== pin.contentHash) fail('CORRUPT_STATE', `Missing or inconsistent pinned ${part} revision.`);
      return record;
    }));
    if (!manifest || !lexical || !graph) return undefined;
    const meta = manifest.payload as Omit<ProjectIndex, 'lexical' | 'imports' | 'symbols' | 'cochange'>;
    const graphPayload = graph.payload as { imports: ProjectIndex['imports']; symbols: ProjectIndex['symbols']; cochange: ProjectIndex['cochange'] };
    const index = reviveProjectIndex({
      ...meta,
      lexical: lexical.payload as ProjectIndex['lexical'],
      imports: graphPayload.imports, symbols: graphPayload.symbols, cochange: graphPayload.cochange,
    });
    this.indexCache = { manifestHash: manifest.contentHash, index };
    return index;
  }

  // Versioned per component: unchanged parts keep their file and history; only
  // changed components get a new revision. The manifest moves last.
  private async writeIndex(key: string, index: ProjectIndex, signal?: AbortSignal): Promise<void> {
    const parts: Array<['manifest' | 'lexical' | 'graph', unknown]> = [
      ['lexical', index.lexical],
      ['graph', { imports: index.imports, symbols: index.symbols, cochange: index.cochange }],
      ['manifest', {
        checkoutId: index.checkoutId, configRevision: index.configRevision, appliedRevision: index.appliedRevision,
        manifestHash: index.manifestHash, hashes: index.hashes, profile: index.profile,
        indexedFiles: index.indexedFiles, skippedFiles: index.skippedFiles, truncated: index.truncated,
      }],
    ];
    const pins: Record<string, Ref> = {};
    for (const [part, original] of parts) {
      const payload = part === 'manifest' ? { ...(original as object), parts: pins } : original;
      const path = this.representationPartPath(key, part);
      const current = await readRecord(path);
      const record = current && current.contentHash === sha256(JSON.stringify(payload)) && await readRevision(path, current.revision)
        ? current : await publishRecord(path, { expectedRevision: current?.revision ?? 0, payload, ...(signal ? { signal } : {}) });
      if (part !== 'manifest') pins[part] = { id: part, revision: record.revision, contentHash: record.contentHash };
    }
    // Heavy parts keep only the pinned and the previous revision; the manifest keeps full history.
    for (const part of ['lexical', 'graph'] as const) {
      const pin = pins[part];
      if (!pin) continue;
      const directory = join(scopeStore(this.prjctRoot, key, 'representation'), 'revisions', `${part}.json`);
      const entries = await readdir(directory).catch(() => [] as string[]);
      for (const entry of entries) {
        const revision = Number(entry.replace(/\.json$/, ''));
        if (Number.isInteger(revision) && revision < pin.revision - 1) await rm(join(directory, entry), { force: true }).catch(() => undefined);
      }
    }
  }

  // Connect only: identity, store, and a stat snapshot. Indexing and analysis
  // are services that run afterwards without blocking the session.
  async connectProject(signal?: AbortSignal): Promise<{ text: string; projectId: string; checkoutId: string; candidateFiles: number; alreadyBound: boolean }> {
    signal?.throwIfAborted();
    const resolution = await this.resolvedIdentity();
    await assertStoreOutsideSource(resolution.location, this.prjctRoot);
    const alreadyBound = Boolean(await this.peekBinding());
    const state = await this.bindNew(signal);
    const sources = await this.sources();
    const snapshot = await sources.snapshot({ fresh: true });
    await sources.persist();
    const text = `${alreadyBound ? 'Reconnected' : 'Connected'} project ${state.projectId} for ${resolution.location}: ${snapshot.paths.length} indexable files${snapshot.truncated ? ' (capped)' : ''}.`;
    return { text, projectId: state.projectId, checkoutId: state.checkoutId, candidateFiles: snapshot.paths.length, alreadyBound };
  }

  /** True when no applied index exists or the checkout no longer matches it. */
  async indexStale(): Promise<boolean> {
    const bound = await this.peekBinding();
    if (!bound) return true;
    const stored = await this.loadManifest(this.keyOf(bound));
    if (!stored || stored.configRevision !== INDEX_CONFIG_REVISION) return true;
    const snapshot = await this.freshSnapshot();
    return stored.manifestHash !== snapshot.manifestHash;
  }

  async initProject(signal?: AbortSignal): Promise<{ text: string; projectId: string; checkoutId: string; initialized: boolean; rebuilt: boolean; indexedFiles: number }> {
    signal?.throwIfAborted();
    const resolution = await this.resolvedIdentity();
    await assertStoreOutsideSource(resolution.location, this.prjctRoot);
    await this.bindNew(signal);
    // init is the explicit first pass: create the store, index, and leave the
    // project ready for the agent's initial deep analysis.
    const synced = await this.syncProject(signal);
    return { text: `Initialized project ${synced.projectId} for ${resolution.location}. ${synced.text}`,
      projectId: synced.projectId, checkoutId: synced.checkoutId, initialized: true,
      rebuilt: synced.rebuilt, indexedFiles: synced.indexedFiles };
  }

  async syncProject(signal?: AbortSignal, onProgress?: BuildOptions['onProgress']): Promise<{ text: string; checkoutId: string; projectId: string; rebuilt: boolean; indexedFiles: number; manifestHash: string; retokenized: number }> {
    signal?.throwIfAborted();
    const bound = await this.peekBinding();
    if (!bound) fail('UNAVAILABLE', 'No bound project. Run /prjct init first.');
    const state = await this.bindNew(signal);
    const sources = await this.sources();
    // Metadata is enough to decide; the heavy parts are never parsed here.
    const stored = await this.loadManifest(this.keyOf(state));
    const legacy = !stored ? await readRecord(this.representationPartPath(this.keyOf(state), 'manifest')) : undefined;
    // Contents are read only when a rebuild is due; an unchanged tree costs one stat walk.
    const snapshot = await sources.snapshot({ fresh: true });
    const rebuilt = !stored || stored.manifestHash !== snapshot.manifestHash || stored.configRevision !== INDEX_CONFIG_REVISION;
    const revision = rebuilt ? (stored?.appliedRevision ?? (legacy?.payload as { appliedRevision?: number } | undefined)?.appliedRevision ?? 0) + 1 : stored!.appliedRevision;
    const build = { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress } : {}) };
    // Same encoding and an applied index: re-tokenize only what changed.
    const previous = rebuilt && stored && stored.configRevision === INDEX_CONFIG_REVISION ? await this.loadIndex(this.keyOf(state)).catch(() => undefined) : undefined;
    let collected: CollectedSources = { files: [], hashes: snapshot.hashes, manifestHash: snapshot.manifestHash, skippedFiles: snapshot.skippedFiles, truncated: snapshot.truncated };
    let index: IndexManifest = stored!;
    let retokenized = 0;
    if (rebuilt && previous) {
      const changed = diffHashes(previous.hashes, snapshot.hashes);
      const files = await sources.read([...changed.added, ...changed.modified]);
      const next = await updateProjectIndex({ previous, changed: files, hashes: snapshot.hashes, manifestHash: snapshot.manifestHash, skippedFiles: snapshot.skippedFiles, truncated: snapshot.truncated },
        { checkoutId: state.checkoutId, appliedRevision: revision }, this.cwd, build);
      retokenized = next.retokenized;
      index = next;
      collected = { ...collected, files };
    } else if (rebuilt) {
      collected = await sources.collectAll();
      index = await buildProjectIndex(collected, { checkoutId: state.checkoutId, appliedRevision: revision }, this.cwd, build);
      retokenized = collected.files.length;
    }
    if (rebuilt) {
      await this.writeIndex(this.keyOf(state), index as ProjectIndex, signal);
      const components = ['lexical', 'imports', 'symbols', 'cochange'].map(id => ({
        id, appliedRevision: revision, appliedConfigRevision: INDEX_CONFIG_REVISION, lastAttempt: 'succeeded' as const,
      }));
      await this.save({
        ...state, claims: state.claims.map(claim => claim.standing === 'supported' && claim.supports.some(support => this.staleSupport(support, this.currentOf(collected.hashes, collected.manifestHash))) ? { ...claim, standing: 'needs_review' as const, nextAction: 'Sources changed; inspect before reconfirming.' } : claim), refresh: { revision, configRevision: INDEX_CONFIG_REVISION, components },
      }, state.revision, newId('sync'), signal);
    }
    const diff = stored ? diffHashes(stored.hashes, collected.hashes) : { added: Object.keys(collected.hashes), modified: [], deleted: [] };
    const extra = index.truncated ? ' Index truncated at the file cap.' : '';
    const text = rebuilt
      ? `Indexed ${index.indexedFiles} files (rev ${revision}, ${retokenized} re-tokenized). Added ${diff.added.length}, modified ${diff.modified.length}, deleted ${diff.deleted.length}.${extra} Search uses BM25; structure uses imports. Index freshness is not project understanding.`
      : `Index already current at rev ${revision} (${index.indexedFiles} files). Nothing to rebuild.`;
    return { text, checkoutId: state.checkoutId, projectId: state.projectId, rebuilt, indexedFiles: index.indexedFiles, manifestHash: index.manifestHash, retokenized };
  }

  // ---- Context documents: bounded, agent-facing briefs produced by services. ----

  async readContextDoc(id: string): Promise<{ text: string; freshness: Record<string, string>; updatedAt: string; revision: number } | undefined> {
    const bound = await this.peekBinding();
    if (!bound) return undefined;
    const record = await readRecordCached(this.contextDocPath(this.keyOf(bound), id));
    if (!record) return undefined;
    const payload = record.payload as { text: string; freshness: Record<string, string>; updatedAt: string };
    return { ...payload, revision: record.revision };
  }

  /** Current applied manifest hash, or undefined before the first index. */
  async indexManifestHash(): Promise<string | undefined> {
    const bound = await this.peekBinding();
    return bound ? (await this.loadManifest(this.keyOf(bound)))?.manifestHash : undefined;
  }

  async writeContextDoc(id: string, text: string, freshness: Record<string, string>, signal?: AbortSignal): Promise<{ changed: boolean; bytes: number }> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project. Run /prjct init first.');
    const path = this.contextDocPath(this.keyOf(bound), id);
    const current = await readRecordCached(path);
    const previous = current?.payload as { text?: string } | undefined;
    if (previous?.text === text) return { changed: false, bytes: Buffer.byteLength(text, 'utf8') };
    await publishRecord(path, { expectedRevision: current?.revision ?? 0, payload: { text, freshness, updatedAt: new Date().toISOString() }, ...(signal ? { signal } : {}) });
    return { changed: true, bytes: Buffer.byteLength(text, 'utf8') };
  }

  // Compared against the checkout, not the stored manifest: an edit makes the
  // brief stale immediately, and the dependency on index orders the rebuild.
  async stackStale(): Promise<boolean> {
    const bound = await this.peekBinding();
    if (!bound) return true;
    const doc = await this.readContextDoc('stack');
    if (!doc) return true;
    const snapshot = await this.freshSnapshot();
    return doc.freshness.manifestHash !== snapshot.manifestHash;
  }

  async buildStackDoc(signal?: AbortSignal): Promise<{ summary: string; freshness: Record<string, string> }> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project. Run /prjct init first.');
    const manifest = await this.loadManifest(this.keyOf(bound));
    if (!manifest) return fail('UNAVAILABLE', 'No applied index; the index service must run first.');
    const text = renderStack(manifest.profile, { indexedFiles: manifest.indexedFiles, skippedFiles: manifest.skippedFiles, truncated: manifest.truncated });
    const freshness = { manifestHash: manifest.manifestHash };
    const written = await this.writeContextDoc('stack', text, freshness, signal);
    return { summary: `${manifest.profile.ecosystem}; ${manifest.profile.tests.command ? `verify: ${manifest.profile.tests.command}` : 'no test command'} (${written.bytes} bytes)`, freshness };
  }

  async historyStale(): Promise<boolean> {
    const bound = await this.peekBinding();
    if (!bound) return true;
    const doc = await this.readContextDoc('history');
    if (!doc) return true;
    return doc.freshness.head !== await gitHead(this.cwd);
  }

  async readHistory(): Promise<ProjectHistory | undefined> {
    const bound = await this.peekBinding();
    if (!bound) return undefined;
    return (await readRecordCached(this.historyPath(this.keyOf(bound))))?.payload as ProjectHistory | undefined;
  }

  async buildHistory(signal?: AbortSignal): Promise<{ summary: string; freshness: Record<string, string> }> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project. Run /prjct init first.');
    const sources = await this.sources();
    const snapshot = await sources.snapshot();
    const changelogPath = snapshot.paths.find(path => /^changelog\.mdx?$/i.test(path));
    const changelog = changelogPath ? (await sources.read([changelogPath]))[0]?.content : undefined;
    const history = await collectHistory(this.cwd, { known: new Set(snapshot.paths), ...(changelog ? { changelog } : {}), ...(signal ? { signal } : {}) });
    const freshness = { head: history?.head ?? 'none' };
    if (history) {
      const path = this.historyPath(this.keyOf(bound));
      const current = await readRecordCached(path);
      if (current?.contentHash !== sha256(JSON.stringify(history))) await publishRecord(path, { expectedRevision: current?.revision ?? 0, payload: history, ...(signal ? { signal } : {}) });
    }
    const written = await this.writeContextDoc('history', renderHistory(history), freshness, signal);
    const summary = history
      ? `${history.commitCount} commits, ${history.releases.length} tags, ${history.commitsSinceRelease} since last release (${written.bytes} bytes)`
      : 'no git history';
    return { summary, freshness };
  }

  /** True when a model brief was written against a different index than the current checkout. */
  private async briefStale(id: string): Promise<boolean> {
    const doc = await this.readContextDoc(id);
    if (!doc) return true;
    const snapshot = await this.freshSnapshot();
    return Boolean(doc.freshness.manifestHash) && doc.freshness.manifestHash !== snapshot.manifestHash;
  }

  /** Items for lookup queries that name a service brief (stack, history, purpose, patterns). */
  private async contextDocItems(query: string, projectId: string): Promise<Array<{ kind: 'stack' | 'history' | 'purpose' | 'design'; summary: string; standing: 'supported' | 'needs_review'; sources: Ref[] }>> {
    const q = query.toLowerCase();
    const wanted: Array<{ id: string; kind: 'stack' | 'history' | 'purpose' | 'design'; stale: () => Promise<boolean> }> = [];
    if (/stack|ecosystem|framework|tool|script|command|verify|test|build|lint|language|profile/.test(q)) wanted.push({ id: 'stack', kind: 'stack', stale: () => this.stackStale() });
    if (/history|release|changelog|commit|git|ship|version|tag|hotspot|churn|contributor|recent/.test(q)) wanted.push({ id: 'history', kind: 'history', stale: () => this.historyStale() });
    if (/purpose|what is|overview|about|goal|architecture|component|domain|brief|understand/.test(q)) wanted.push({ id: 'purpose', kind: 'purpose', stale: () => this.briefStale('purpose') });
    if (/pattern|convention|design|style|testing|how to|guideline|pitfall|practice|structure/.test(q)) wanted.push({ id: 'patterns', kind: 'design', stale: () => this.briefStale('patterns') });
    const items: Array<{ kind: 'stack' | 'history' | 'purpose' | 'design'; summary: string; standing: 'supported' | 'needs_review'; sources: Ref[] }> = [];
    for (const entry of wanted) {
      const doc = await this.readContextDoc(entry.id);
      if (!doc) continue;
      const standing = await entry.stale() ? 'needs_review' as const : 'supported' as const;
      const source: Ref = { id: `ctx_${entry.id}`, revision: doc.revision, contentHash: sha256(doc.text) };
      for (let offset = 0, part = 1; offset < doc.text.length; offset += 3800, part += 1) {
        items.push({ kind: entry.kind, summary: `${part > 1 ? `(part ${part}) ` : ''}${doc.text.slice(offset, offset + 3800)}`, standing, sources: [source] });
      }
    }
    return items;
  }

  /** Facts a model service prompt needs so the child never guesses ids or paths. */
  async analysisFacts(): Promise<{ projectId: string; checkoutId: string; docFiles: string[]; entryPoints: string[]; testCommand?: string }> {
    const ids = await this.previewIds();
    const snapshot = await (await this.sources()).snapshot();
    const docFiles = snapshot.paths.filter(path => /^(readme|context|agents|claude|contributing|architecture)\.mdx?$/i.test(path) || /^docs\/(readme|index)\.mdx?$/i.test(path)).slice(0, 6);
    const entryPoints = snapshot.paths.filter(path => /^(src\/|lib\/|app\/)?(index|main|app|server|cli|extension)\.(ts|tsx|js|mjs|py|go|rs|rb|php)$/i.test(path)).slice(0, 6);
    const bound = await this.peekBinding();
    const command = bound ? (await this.loadManifest(this.keyOf(bound)))?.profile.tests.command : undefined;
    return { projectId: ids.projectId, checkoutId: ids.checkoutId, docFiles, entryPoints, ...(command ? { testCommand: command } : {}) };
  }

  /**
   * Portable, agent-agnostic markdown assembled from the briefs (purpose, stack,
   * patterns, history). Returned as text; writing it anywhere is the caller's
   * explicit, opt-in decision.
   */
  async exportBriefs(): Promise<{ text: string; included: string[] } | undefined> {
    const bound = await this.peekBinding();
    if (!bound) return undefined;
    const included: string[] = [];
    const sections: string[] = [];
    for (const id of ['purpose', 'stack', 'patterns', 'history'] as const) {
      const doc = await this.readContextDoc(id);
      if (!doc) continue;
      included.push(id);
      sections.push(doc.text.trim());
    }
    if (!included.length) return { text: '', included };
    const header = `<!-- Generated by prjct for ${bound.projectId} on ${new Date().toISOString().slice(0, 10)}; regenerate with /prjct export. Briefs: ${included.join(', ')}. -->\n\n`;
    return { text: `${header}${sections.join('\n\n')}\n`, included };
  }

  /** One-line understanding status for /prjct status. */
  async understandingText(): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return 'Understanding: no bound project.';
    const state = await this.load(this.keyOf(bound));
    const supported = state.claims.filter(claim => claim.standing === 'supported').length;
    const pending = state.claims.filter(claim => ['candidate', 'needs_review'].includes(claim.standing)).length;
    const briefs = (await Promise.all(['purpose', 'patterns'].map(async id => (await this.readContextDoc(id)) ? id : undefined))).filter(Boolean);
    if (!supported && !pending && !briefs.length) return 'Understanding: not synthesized yet. /prjct analyze runs the purpose and patterns services (bounded, child Pi).';
    return `Understanding: briefs ${briefs.length ? briefs.join(', ') : 'none'}; ${supported} supported claim(s)${pending ? `, ${pending} pending review` : ''}.`;
  }

  private async peekBinding(): Promise<{ projectId: string; checkoutId: string; day: string; initialized?: boolean } | undefined> {
    // Identity lookup must not fail merely because the current cwd is the store
    // itself; only binding/indexing/writing enforce source/store separation.
    const resolution = await this.resolvedIdentity();
    const index = await readRecordCached(this.locatorPath());
    const bindings = (index?.payload as { bindings?: Array<{ location: string; projectId: string; checkoutId: string; day?: string; initialized?: boolean }> } | undefined)?.bindings ?? [];
    const found = bindings.find(item => item.location === resolution.location);
    if (found && !found.day) fail('MIGRATION_REQUIRED', 'Identity binding has no creation bucket.');
    return found ? { ...found, day: found.day! } : undefined;
  }

  private keyOf(scope: { projectId: string; day?: string }): string {
    return projectKey(scope.day ?? dayToday(), scope.projectId);
  }

  private async ensureIgnore(): Promise<void> {
    // No checkout files exist anymore; the store lives entirely under the global
    // prjct home. Kept as a no-op so older call sites stay honest.
  }

  // Identity is a property of the runtime's cwd; observe git once per runtime.
  private resolvedIdentity(): Promise<IdentityResolution> {
    this.identityPromise ??= resolveIdentity({ location: this.cwd, agentHome: this.agentHome })
      .catch(error => { this.identityPromise = undefined; throw error; });
    return this.identityPromise;
  }

  private async sources(): Promise<SourceCache> {
    this.sourceCache ??= new SourceCache(this.cwd);
    const bound = await this.peekBinding();
    if (bound) this.sourceCache.bindPersistence(join(scopeStore(this.prjctRoot, this.keyOf(bound), 'representation'), 'stat-cache.json'), bound.checkoutId);
    return this.sourceCache;
  }

  private currentOf(hashes: Record<string, string>, manifestHash: string): CurrentSources {
    const byId = new Map<string, string>();
    for (const [path, hash] of Object.entries(hashes)) byId.set(sourceId(path), hash);
    return { manifestHash, hashes, byId };
  }

  // Every reader sees a walk that starts now: "did sources change during this
  // call" must never come from an older walk. Within one host operation
  // (shareWalk) the first walk is reused so a batch of checks costs one walk.
  private async freshSnapshot(): Promise<SourceSnapshot> {
    const shared = this.walkShare.getStore();
    if (shared) { shared.snapshot ??= (await this.sources()).snapshot({ fresh: true }); return shared.snapshot; }
    return (await this.sources()).snapshot({ fresh: true });
  }

  /** Run `fn` with one shared stat walk for every source check it performs. */
  shareWalk<T>(fn: () => Promise<T>): Promise<T> { return this.walkShare.run({}, fn); }

  private async currentSources(): Promise<CurrentSources> {
    const snapshot = await this.freshSnapshot();
    if (this.currentCache?.generation === snapshot.generation) return this.currentCache.current;
    const current = this.currentOf(snapshot.hashes, snapshot.manifestHash);
    this.currentCache = { generation: snapshot.generation, current };
    return current;
  }

  /** Persist caches; called at session shutdown. */
  async flush(): Promise<void> { await this.sourceCache?.persist(); }

  /** Start the live source watcher (session_start). Returns false when unsupported. */
  async watchSources(): Promise<boolean> { return (await this.sources()).watch(); }
  unwatchSources(): void { this.sourceCache?.unwatch(); }
  /** Full walk in the background (agent idle): bounds what a missed watcher event could hide. */
  async revalidateSources(): Promise<void> { await (await this.sources()).revalidate(); }

  private async load(key: string): Promise<Document> {
    const staged = this.transaction.getStore()?.pending;
    const record = staged && this.keyOf(staged) === key ? { payload: staged, revision: staged.revision } : await readRecordCached(this.statePath(key));
    if (!record) return fail('UNAVAILABLE', 'Project state is missing.');
    const stored = record.payload as Document;
    if (this.selection === undefined) this.selection = stored.selections?.[this.sessionId] ?? stored.selectedWorkId;
    return {
      ...stored, selectedWorkId: this.selection, revision: record.revision, day: stored.day ?? key.split('/')[0]!,
      edges: stored.edges ?? [], observations: stored.observations ?? [],
      grants: stored.grants ?? { tasks: {}, writer: null },
    };
  }

  private async save(document: Document, expectedRevision: number, operationId: string, signal?: AbortSignal, durability: Durability = 'full'): Promise<Document> {
    const frame = this.transaction.getStore();
    operationId = String(frame?.params.operationId ?? operationId);
    const path = this.statePath(projectKey(document.day, document.projectId));
    const requestHash = frame?.hash ?? sha256(JSON.stringify({ operationId, projectId: document.projectId, revision: expectedRevision }));
    const identity = { scopeId: document.projectId, actorId: this.actorId, operationId, requestHash };
    const prior = document.operations[operationId];
    const decision = checkMutationPreconditions(identity, expectedRevision, {
      scopeId: document.projectId, revision: expectedRevision,
      ...(prior ? { prior: { ...identity, outcome: 'committed' as const, receipt: prior.receipt } } : {}),
    }, signal);
    if (decision.kind === 'already_committed') return this.load(this.keyOf(document));
    const receipt = contentRef(`receipt_${operationId}`, expectedRevision + 1, { operationId });
    const allOperations = { ...document.operations, [operationId]: { actorId: this.actorId, requestHash, receipt } };
    const entries = Object.entries(allOperations);
    let hot = allOperations;
    if (entries.length > MAX_HOT_RECEIPTS) {
      // Keep replay results for recent operations in the hot document; older
      // receipts (which retain requestHash + result) move to the archive record.
      const overflow = entries.slice(0, entries.length - MAX_HOT_RECEIPTS);
      hot = Object.fromEntries(entries.slice(entries.length - MAX_HOT_RECEIPTS));
      const key = this.keyOf(document);
      const archivePath = join(scopeStore(this.prjctRoot, key, 'work'), 'receipts-archive.json');
      const archive = await readRecord(archivePath);
      const archivedPayload = { receipts: { ...((archive?.payload as { receipts?: Record<string, unknown> } | undefined)?.receipts ?? {}), ...Object.fromEntries(overflow) } };
      if (frame) (frame.files ??= []).push({ path: archivePath, content: JSON.stringify({ schemaVersion: 1, revision: (archive?.revision ?? 0) + 1, contentHash: sha256(JSON.stringify(archivedPayload)), payload: archivedPayload }), overwrite: true });
      else await publishRecord(archivePath, { expectedRevision: archive?.revision ?? 0, payload: archivedPayload, ...(signal ? { signal } : {}) });
    }
    const nextDoc: Document = { ...document, selections: { ...document.selections, [this.sessionId]: document.selectedWorkId }, revision: expectedRevision + 1,
      operations: hot };
    if (frame) { frame.baseRevision ??= expectedRevision; frame.pending = nextDoc; }
    else await publishRecord(path, { expectedRevision, payload: nextDoc, durability, ...(signal ? { signal } : {}) });
    this.selection = document.selectedWorkId;
    return nextDoc;
  }

  private async archivedReceipt(key: string, operationId: string) {
    const archivePath = join(scopeStore(this.prjctRoot, key, 'work'), 'receipts-archive.json');
    const archive = await readRecord(archivePath);
    const receipts = (archive?.payload as { receipts?: Record<string, { actorId: string; requestHash: string; receipt: Ref; result?: ToolResult }> } | undefined)?.receipts;
    return receipts?.[operationId];
  }

  private async requireBound(): Promise<Document> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project. Run /prjct init first.');
    return this.load(this.keyOf(bound));
  }

  private async bindNew(signal?: AbortSignal): Promise<Document> {
    signal?.throwIfAborted();
    const resolution = await this.resolvedIdentity();
    await assertStoreOutsideSource(resolution.location, this.prjctRoot);
    const indexPath = this.locatorPath();
    let index = await readRecord(indexPath);
    type Binding = { location: string; projectId: string; checkoutId: string; day: string; initialized?: boolean };
    let bindings = (index?.payload as { bindings?: Binding[] } | undefined)?.bindings ?? [];
    let binding = bindings.find(item => item.location === resolution.location);
    if (!binding) {
      binding = { location: resolution.location, projectId: `p_${sha256(resolution.location).slice(0, 12)}`,
        checkoutId: `co_${sha256(resolution.location).slice(0, 12)}`, day: dayToday(), initialized: false };
      bindings = [...bindings, binding];
      index = await publishRecord(indexPath, { expectedRevision: index?.revision ?? 0, payload: { bindings }, ...(signal ? { signal } : {}) });
    }
    const key = this.keyOf(binding);
    let record = await readRecord(this.statePath(key));
    if (!record) {
      if (binding.initialized !== false) fail('UNAVAILABLE', 'Project state is missing; restore preserved history rather than inventing work.');
      const document: Document = { projectId: binding.projectId, checkoutId: binding.checkoutId, location: binding.location, day: binding.day,
        revision: 1, works: [], tasks: [], claims: [], artifacts: [], checkpoints: [], plans: [], selectedWorkId: null,
        selections: {}, edges: [], observations: [], grants: { tasks: {}, writer: null }, operations: {} };
      record = await publishRecord(this.statePath(key), { expectedRevision: 0, payload: document, ...(signal ? { signal } : {}) });
    }
    if (binding.initialized === false) {
      await publishRecord(indexPath, { expectedRevision: index!.revision, payload: { bindings: bindings.map(item => item.location === binding!.location ? { ...item, initialized: true } : item) }, ...(signal ? { signal } : {}) });
    }
    return this.load(key);
  }

  private workItem(work: WorkRow, tasks: TaskRow[]) {
    return { reference: contentRef(work.id, 1, work), projectId: work.projectId, title: work.title, disposition: work.disposition,
      activeSpecification: work.activeSpecification, activePlan: work.activePlan,
      tasks: tasks.filter(task => task.workId === work.id).map(task => contentRef(task.id, 1, task)), nextAction: work.nextAction };
  }

  private contextResult(request: { action: 'lookup' | 'discover'; query: string; maxBytes: number }, result: { status: 'ok' | 'partial' | 'abstained'; items: Array<{ kind: 'stack' | 'architecture' | 'purpose' | 'design' | 'method' | 'work' | 'history'; summary: string; standing: 'supported' | 'needs_review'; sources: Ref[] }>; gaps: string[]; stateRevision?: number }): ToolResult {
    let trimmed = false;
    while (result.items.length > 32 || (result.items.length && Buffer.byteLength(JSON.stringify(result)) > request.maxBytes)) {
      result.items.pop(); trimmed = true;
      result.status = 'partial';
      if (!result.gaps.includes('Context budget reached; request a narrower query or a larger budget.')) result.gaps.push('Context budget reached; request a narrower query or a larger budget.');
    }
    void trimmed;
    return jsonResult(validateContextResponse(request, result));
  }

  private contextObservations(state: Document, query: string, workId?: string): ObservationRow[] {
    const terms = tokenizeQuery(query);
    const wanted = state.claims.filter(claim => query.includes(claim.id)).flatMap(claim => claim.supports.map(ref => ref.id));
    return state.observations.filter(row => !workId || row.workId === workId).map((row, index) => {
      const text = `${row.id} ${row.execution?.sourcePaths?.join(' ') ?? ''} ${row.summary}`.toLowerCase();
      const score = terms.filter(term => text.includes(term)).length + (row.supports.some(ref => wanted.includes(ref.id)) ? 100 : 0);
      return { row, index, score };
    }).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 5).map(item => item.row);
  }

  private async context(params: Record<string, unknown>, extras: { signal?: AbortSignal; activate?: (names: string[]) => void }) {
    const request = params as { action: 'lookup' | 'discover'; query: string; maxBytes: number };
    if (request.action === 'lookup') {
      // Method guidance is global package content: available without a binding.
      const direct = request.query.trim().match(/^method:([a-z-]+)(?:\/(.+))?$/i);
      const catalogQuery = /^methods?$/i.test(request.query.trim());
      const matched = direct ? matchMethods(`method:${direct[1]}`) : catalogQuery ? [] : [];
      if (catalogQuery || direct) {
        if (catalogQuery) {
          const items = methodCatalog().map(m => ({ kind: 'method' as const, summary: `${m.id}: ${m.summary}`,
            standing: 'supported' as const, sources: [contentRef(`method_${m.id}`, 1, { id: m.id, summary: m.summary })] }));
          const result = { status: items.length ? 'ok' as const : 'abstained' as const, items,
            gaps: items.length ? [] : ['No methods bundled.'] };
          return this.contextResult(request, result);
        }
        const entry = matched[0];
        if (!entry) return this.contextResult(request, { status: 'abstained', items: [], gaps: [`Unknown method ${direct![1]}; query "methods" for the catalog.`] });
        const doc = await loadMethodDocument(entry.id, direct![2]);
        if (!doc) return this.contextResult(request, { status: 'abstained', items: [], gaps: [`Document ${direct![2] ?? entry.entry} not found for method ${entry.id}.`] });
        const docs = await listMethodDocuments(entry.id);
        const paragraphs = doc.content.split(/\n(?=\n|#)/);
        const chunks: string[] = [];
        let current = '';
        for (const part of paragraphs) {
          if (current && Buffer.byteLength(current + part, 'utf8') > 3600) { chunks.push(current); current = part; }
          else current += part;
        }
        if (current) chunks.push(current);
        const reference = contentRef(`method_${entry.id}`, 1, { path: doc.path, content: doc.content });
        const items = chunks.map((chunk, i) => ({ kind: 'method' as const,
          summary: `[${entry.id}/${doc.path} part ${i + 1}/${chunks.length}]\n${chunk}`,
          standing: 'supported' as const, sources: [reference] }));
        const gaps: string[] = [];
        const others = docs.filter(d => d !== doc.path);
        if (others.length) gaps.push(`Linked documents for ${entry.id}: ${others.join(', ')} — request method:${entry.id}/<file>.`);
        if (chunks.length > 1) gaps.push(`Document split into ${chunks.length} parts; raise maxBytes if parts were trimmed.`);
        return this.contextResult(request, { status: 'ok', items, gaps });
      }
    }
    if (request.action === 'discover') {
      const available = matchDiscover(request.query);
      const ids = await this.previewIds();
      const bound = await this.peekBinding();
      const stateRevision = bound ? (await this.load(this.keyOf(bound))).revision : 0;
      const result = available.length
        ? { status: 'ok' as const, checkoutId: ids.checkoutId, projectId: ids.projectId, stateRevision, available, activated: available, gaps: [] }
        : { status: 'abstained' as const, checkoutId: ids.checkoutId, projectId: ids.projectId, stateRevision, available: [], activated: [], gaps: ['No prjct capability matched this query.'] };
      validateDiscoveryResponse(request, result);
      extras.activate?.(result.activated);
      return jsonResult(result);
    }
    const bound = await this.peekBinding();
    if (!bound) {
      const result = { status: 'abstained' as const, items: [], gaps: ['No bound project or selected work. Ask explicitly or run /prjct work.'] };
      return this.contextResult(request, result);
    }
    const state = await this.load(this.keyOf(bound));
    const work = state.works.find(item => item.id === state.selectedWorkId);
    let projectItems: Array<{ kind: 'stack' | 'architecture' | 'purpose' | 'method' | 'history' | 'design'; summary: string; standing: 'supported' | 'needs_review'; sources: Ref[] }> = [];
    let projectGaps: string[] = [];
    // One walk per lookup, shared by the project and work blocks.
    const current = await this.currentSources();
    {
      // Project knowledge remains present alongside a work cycle: answer what the project IS. Mechanical profile plus
      // supported claims; purpose/patterns remain agent-synthesized claims.
      const index = await this.loadManifest(this.keyOf(bound));
      const items: Array<{ kind: 'stack' | 'architecture' | 'purpose' | 'method' | 'history' | 'design'; summary: string; standing: 'supported' | 'needs_review'; sources: Ref[] }> = [];
      const gaps: string[] = [];
      if (index && index.manifestHash !== current.manifestHash) gaps.push('Sources changed; review supported knowledge before applying it.');
      const docItems = await this.contextDocItems(request.query, bound.projectId);
      // The stack brief subsumes the mechanical profile lines: never serve both.
      if (index && !docItems.some(item => item.kind === 'stack')) {
        const profile = index.profile;
        const scriptNames = Object.keys(profile.scripts);
        items.push({ kind: 'stack', standing: 'supported',
          summary: `ecosystem ${profile.ecosystem}; languages ${Object.entries(profile.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ext, count]) => `${ext}:${count}`).join(' ')}; tools ${profile.tools.join(', ') || 'none'}; frameworks ${profile.frameworks.join(', ') || 'none'}; scripts ${scriptNames.join(', ') || 'none'}; top dirs ${profile.topDirs.join(', ') || '.'}`,
          sources: [{ id: `repr_${bound.projectId}`, revision: index.appliedRevision, contentHash: index.manifestHash }] });
        items.push({ kind: 'stack', standing: 'supported',
          summary: `${index.indexedFiles} indexed files; tests ${profile.hasTests ? 'present' : 'not detected'}; manifests ${profile.manifests.join(', ') || 'none'}.`,
          sources: [{ id: `repr_${bound.projectId}`, revision: index.appliedRevision, contentHash: index.manifestHash }] });
        if (profile.tests.framework !== 'unknown' || profile.tests.command) {
          items.push({ kind: 'method', standing: 'supported',
            summary: `verify: ${profile.tests.command ?? profile.tests.framework}${profile.tests.pattern ? `; pattern ${profile.tests.pattern}` : ''}${profile.tests.example ? `; imitate ${profile.tests.example}` : ''}`,
            sources: [{ id: `repr_${bound.projectId}`, revision: index.appliedRevision, contentHash: index.manifestHash }] });
        }
        if (profile.docs.readme || profile.docs.context || profile.docs.docFiles > 0 || profile.docs.adrCount > 0) {
          const parts = [
            profile.docs.title ? `title "${profile.docs.title}"` : null,
            profile.docs.context ? 'CONTEXT.md glossary' : null,
            profile.docs.contextMap ? 'CONTEXT-MAP (multiple contexts)' : null,
            profile.docs.agents ? 'AGENTS.md' : null,
            profile.docs.docFiles ? `${profile.docs.docFiles} docs/` : null,
            profile.docs.adrCount ? `${profile.docs.adrCount} ADRs` : null,
          ].filter(Boolean).join('; ');
          items.push({ kind: 'purpose', standing: 'supported',
            summary: `docs: ${parts}${profile.docs.headings.length ? `. headings: ${profile.docs.headings.slice(0, 6).join(' | ')}` : ''}`,
            sources: [{ id: `repr_${bound.projectId}`, revision: index.appliedRevision, contentHash: index.manifestHash }] });
        }
      } else {
        gaps.push('No applied index; run prjct_refresh to learn the project profile.');
      }
      // A path-like query asks for evidence about that file: observations lead so a small
      // budget still returns their obs_ ids (the confirm step depends on them).
      const pathQuery = /[\/.]\w/.test(request.query);
      const observationItems = !work ? this.contextObservations(state, request.query).map(observation => ({ kind: 'method' as const,
        summary: `observation ${observation.id}: ${observation.execution?.sourcePaths?.join(', ') ?? ''} ${observation.summary.slice(0, 900)}`,
        standing: observation.provenance === 'native_observation' ? 'supported' as const : 'needs_review' as const, sources: observation.supports })) : [];
      if (pathQuery) items.push(...observationItems);
      items.push(...docItems);
      for (const claim of state.claims.filter(item => item.standing === 'supported').slice(0, 8)) {
        items.push({ kind: 'architecture', summary: claim.statement, standing: claim.supports.some(support => this.staleSupport(support, current)) ? 'needs_review' : 'supported',
          sources: claim.supports.length ? claim.supports : [contentRef(claim.id, 1, claim)] });
      }
      if (state.claims.some(claim => ['candidate', 'needs_review'].includes(claim.standing))) gaps.push('Unresolved project knowledge remains. Inspect claims and query lookup by source path or claim ID for earlier native observations.');
      if (index && !state.claims.some(item => item.standing === 'supported')) {
        gaps.push('Understanding not synthesized yet: verify key files with prjct_search, then record purpose/pattern claims via prjct_knowledge propose with linked source ids.');
      }
      if (!pathQuery) items.push(...observationItems);
      if (!state.works.length) gaps.push('No work selected; this is the project profile, not a work brief.');
      const result = { status: gaps.length ? 'partial' as const : 'ok' as const, items, gaps, stateRevision: state.revision };
      if (!work) return this.contextResult(request, result);
      projectItems = items; projectGaps = gaps.filter(gap => !gap.startsWith('No work selected'));
    }
    const items: Array<{ kind: 'work' | 'method' | 'stack' | 'purpose' | 'architecture' | 'history' | 'design'; summary: string; standing: 'supported' | 'needs_review'; sources: Ref[] }> = [
      ...projectItems,
      { kind: 'work' as const, summary: `${work.title}. ${work.nextAction}`,
        standing: 'supported' as const, sources: [contentRef(work.id, 1, work)] },
    ];
    const open = state.tasks.filter(item => item.workId === work.id && !['completed', 'cancelled'].includes(item.disposition));
    for (const task of open.filter(item => this.isBlocked(state, item).length === 0).slice(0, 8)) {
      items.push({ kind: 'work' as const, summary: `ready task ${task.id} (${task.disposition}): ${task.nextAction}`,
        standing: 'supported' as const, sources: [contentRef(task.id, 1, task)] });
    }
    for (const task of open.filter(item => this.isBlocked(state, item).length > 0).slice(0, 8)) {
      items.push({ kind: 'work' as const,
        summary: `blocked task ${task.id} by ${this.isBlocked(state, task).map(item => item.id).join(', ')}`,
        standing: 'supported' as const, sources: [contentRef(task.id, 1, task)] });
    }
    for (const entry of state.checkpoints.filter(entry => entry.workId === work.id).slice(-5)) {
      items.push({ kind: 'method' as const, summary: `journal ${entry.id} (${entry.kind}): ${JSON.stringify(entry.data ?? {}).slice(0, 2800)} Next: ${entry.nextAction}`,
        standing: 'supported' as const, sources: [contentRef(entry.id, 1, entry)] });
    }
    for (const observation of this.contextObservations(state, request.query, work.id)) {
      items.push({ kind: 'work' as const, summary: `observation ${observation.id}: ${observation.execution?.sourcePaths?.join(', ') ?? ''} ${observation.summary.slice(0, 900)}`,
        standing: 'supported' as const, sources: observation.supports.length ? observation.supports : [contentRef(observation.id, 1, observation)] });
    }
    const gaps: string[] = [...projectGaps];
    const index = await this.loadManifest(this.keyOf(bound));
    if (index?.profile.tests.command || (index && index.profile.tests.framework !== 'unknown')) {
      const tests = index.profile.tests;
      items.push({ kind: 'method' as const,
        summary: `verify: ${tests.command ?? tests.framework}${tests.pattern ? `; pattern ${tests.pattern}` : ''}${tests.example ? `; imitate ${tests.example}` : ''}`,
        standing: 'supported' as const,
        sources: [{ id: `repr_${bound.projectId}`, revision: index.appliedRevision, contentHash: index.manifestHash }] });
    }
    if (!index) gaps.push('No applied index; ask for prjct_refresh when the task needs source lookup.');
    else if (index.manifestHash !== current.manifestHash) gaps.push('Sources changed since the last index; ask for prjct_refresh before trusting search.');
    const result = { status: gaps.length ? 'partial' as const : 'ok' as const, items, gaps, stateRevision: state.revision };
    return this.contextResult(request, result);
  }

  private async work(params: Record<string, unknown>, signal?: AbortSignal) {
    const action = String(params.action);
    if (action === 'create') {
      const state = await this.requireBound();
      const workId = newId('work');
      const work: WorkRow = { id: workId, projectId: state.projectId, title: String(params.title), disposition: 'open',
        origins: [params.origin as Ref], activeSpecification: null, activePlan: null, taskIds: [],
        nextAction: 'Define scope or record the next method stage.' };
      const saved = await this.save({ ...state, works: [...state.works, work], selectedWorkId: workId }, state.revision, String(params.operationId), signal);
      const result = { action: 'create', status: 'ok', scope: { projectId: saved.projectId, workId }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.workItem(work, saved.tasks)] };
      validateStateResult('prjct_work', { action: 'create', projectId: saved.projectId, workId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project. Create work first.');
    const state = await this.load(this.keyOf(bound));
    if (action === 'list') {
      let works = state.works;
      let snapshotTasks = state.tasks;
      let snapshot = contentRef(`works_${state.projectId}`, state.revision, state.works);
      if (params.cursor) {
        const cursor = params.cursor as { snapshot: Ref; afterId: string };
        if (cursor.snapshot.id !== `works_${state.projectId}`) fail('STALE_CURSOR', 'The cursor belongs to another listing; restart it.');
        const past = await readRevision(this.statePath(this.keyOf(state)), cursor.snapshot.revision);
        const pastWorks = (past?.payload as Document | undefined)?.works;
        if (!pastWorks || contentRef(`works_${state.projectId}`, cursor.snapshot.revision, pastWorks).contentHash !== cursor.snapshot.contentHash) {
          fail('STALE_CURSOR', 'The work list changed since the cursor was issued; restart the listing.');
        }
        works = pastWorks!;
        snapshotTasks = (past!.payload as Document).tasks;
        snapshot = cursor.snapshot;
        const at = works.findIndex(item => item.id === cursor.afterId);
        if (at < 0) fail('STALE_CURSOR', 'The cursor row is no longer in the snapshot.');
        works = works.slice(at + 1);
      }
      const maxItems = Number(params.maxItems ?? 32);
      const page = works.slice(0, maxItems);
      const items = page.map(work => this.workItem(work, snapshotTasks));
      const next = works.length > page.length && page.length
        ? { snapshot, afterId: page[page.length - 1]!.id }
        : undefined;
      const result = { action: 'list', status: items.length ? 'ok' : 'partial', scope: { projectId: state.projectId },
        gaps: items.length ? [] : ['No work records yet.'], items, ...(next ? { next } : {}) };
      validateStateResult('prjct_work', { action: 'list', projectId: state.projectId, maxBytes: Number(params.maxBytes), maxItems }, result);
      return jsonResult(result);
    }
    const work = state.works.find(item => item.id === params.workId);
    if (!work) return fail('UNAVAILABLE', 'Work was not found.');
    if (action === 'inspect') {
      const result = { action: 'inspect', status: 'ok', scope: { workId: work.id }, gaps: [], items: [this.workItem(work, state.tasks)] };
      validateStateResult('prjct_work', { action: 'inspect', workId: work.id, maxBytes: Number(params.maxBytes) }, result);
      return jsonResult(result);
    }
    if (action === 'select') {
      const saved = await this.save({ ...state, selectedWorkId: work.id, checkoutId: String(params.checkoutId) }, state.revision, String(params.operationId), signal);
      reconstructBinding({ branchId: 'current', pointer: { workId: work.id }, currentGrants: [] });
      const result = { action: 'select', status: 'ok', scope: { workId: work.id, checkoutId: String(params.checkoutId) }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.workItem(work, saved.tasks)] };
      validateStateResult('prjct_work', { action: 'select', workId: work.id, checkoutId: String(params.checkoutId), maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    if (action === 'link') {
      const origin = params.origin as Ref;
      if (work.origins.some(item => item.id === origin.id && item.revision === origin.revision)) {
        fail('INVALID_RESULT', 'This origin is already linked to the work.');
      }
      const updated: WorkRow = { ...work, origins: [...work.origins, origin], nextAction: `Linked origin ${origin.id}.` };
      const works = state.works.map(item => item.id === work.id ? updated : item);
      const saved = await this.save({ ...state, works }, state.revision, String(params.operationId), signal);
      const result = { action: 'link', status: 'ok', scope: { workId: work.id }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.workItem(updated, saved.tasks)] };
      validateStateResult('prjct_work', { action: 'link', workId: work.id, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    if (action === 'transition') {
      const disposition = String(params.disposition) as WorkRow['disposition'];
      const reason = String(params.reason);
      if (work.disposition === 'completed' || work.disposition === 'archived') {
        fail('INVALID_TRANSITION', 'A completed or archived work cannot change disposition here.');
      }
      if (disposition === 'completed') {
        const assessment = state.checkpoints.find(item => item.id === String(params.assessmentId) && item.workId === work.id && item.kind === 'work_assessment');
        if (!assessment) fail('INCOMPLETE_ASSESSMENT', 'Work completion requires a recorded work assessment.');
        await this.assertWorkCompletion(state, work, assessment!);
        const data = assessment!.data as { specificationRevision: number; planRevision: number;
          judgments: Array<{ criterionId: string; conclusion: string }> };
        const activeSpecRevision = work.activeSpecification?.revision ?? 0;
        const activePlanRevision = work.activePlan?.revision ?? 0;
        if (data.specificationRevision !== activeSpecRevision || data.planRevision !== activePlanRevision) {
          fail('INCOMPLETE_ASSESSMENT', 'The work assessment does not cover the active specification and plan revisions.');
        }
        if (data.judgments.some(item => item.conclusion !== 'satisfied')) {
          fail('INCOMPLETE_ASSESSMENT', 'The work assessment has unsatisfied or unknown criteria.');
        }
        const open = state.tasks.filter(item => item.workId === work.id && !['completed', 'cancelled'].includes(item.disposition));
        if (open.length) fail('INVALID_TRANSITION', `Work still has open tasks: ${open.map(item => item.id).join(', ')}.`);
      }
      const updated: WorkRow = { ...work, disposition, nextAction: `${disposition}: ${reason}` };
      const works = state.works.map(item => item.id === work.id ? updated : item);
      const saved = await this.save({ ...state, works }, state.revision, String(params.operationId), signal);
      const result = { action: 'transition', status: 'ok', scope: { workId: work.id }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.workItem(updated, saved.tasks)] };
      validateStateResult('prjct_work', { action: 'transition', workId: work.id, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    return fail('INVALID_RESULT', `Work action ${action} is not implemented in this slice.`);
  }

  async recordObservation(summary: string, execution?: HostExecution): Promise<void> {
    const bound = await this.peekBinding();
    if (!bound) return;
    await withFileMutationQueue(this.statePath(this.keyOf(bound)), () => this.recordObservationQueued(bound, summary, execution));
  }

  private async recordObservationQueued(bound: { projectId: string; checkoutId: string; day: string }, summary: string, execution?: HostExecution): Promise<void> {
    const state = await this.load(this.keyOf(bound));
    const collected = await this.currentSources();
    const index = await this.loadManifest(this.keyOf(bound));
    const candidates = state.tasks.filter(item => item.workId === state.selectedWorkId && item.attemptId === this.attemptId && item.grantStanding === 'valid');
    const task = candidates.length === 1 ? candidates[0] : undefined;
    const command = execution?.command?.trim();
    const verification = Boolean(command && index?.profile.tests.command && command === index.profile.tests.command.trim());
    const supports = execution?.sourcePaths?.length
      ? execution.sourcePaths.filter(path => collected.hashes[path] !== undefined).map(path => ({ id: sourceId(path), revision: index?.appliedRevision ?? 1, contentHash: collected.hashes[path]! }))
      : [{ id: `repr_${bound.projectId}`, revision: index?.appliedRevision ?? 1, contentHash: collected.manifestHash }];
    const redactedExecution = execution ? { ...execution, ...(execution.command ? { command: redactSecrets(execution.command) } : {}) } : undefined;
    const observed = redactedExecution && (!redactedExecution.beforeHash || redactedExecution.beforeHash === collected.manifestHash)
      ? redactedExecution : redactedExecution ? { ...redactedExecution, outcome: 'unknown' as const } : undefined;
    const observation: ObservationRow = { id: newId('obs'), provenance: observed ? 'native_observation' : 'agent_report',
      summary: redactSecrets(summary).slice(0, 4096), supports, attemptId: this.attemptId, ...(state.selectedWorkId ? { workId: state.selectedWorkId } : {}),
      ...(task ? { taskId: task.id } : {}), ...(observed ? { execution: observed } : {}), verification };
    // Retention is reference aware. Never discard evidence pinned by a checkpoint.
    const references = new Set(state.checkpoints.flatMap(entry => {
      const data = entry.data as { evidenceIds?: string[]; judgments?: Array<{ evidenceIds: string[] }> } | undefined;
      return [...(data?.evidenceIds ?? []), ...(data?.judgments?.flatMap(item => item.evidenceIds) ?? [])];
    }));
    const all = [...state.observations, observation];
    const recent = new Set(all.slice(-MAX_OBSERVATIONS).map(item => item.id));
    await this.save({ ...state, observations: all.filter(item => references.has(item.id) || recent.has(item.id)) }, state.revision, newId('obsop'), undefined, 'light');
  }

  async understandingPending(): Promise<boolean> {
    const bound = await this.peekBinding();
    if (!bound) return true;
    const state = await this.load(this.keyOf(bound));
    const current = await this.currentSources();
    return state.claims.some(claim => ['candidate', 'needs_review'].includes(claim.standing)) || !state.claims.some(claim => claim.standing === 'supported' && claim.supports.length && claim.supports.every(ref => !this.staleSupport(ref, current)));
  }

  async sourceSnapshot(): Promise<string> { return (await this.currentSources()).manifestHash; }

  private async requireEvidence(state: Document, ids: string[], scope: { workId?: string; taskId?: string }, verification = false): Promise<ObservationRow[]> {
    if (!ids.length) fail('MISSING_EVIDENCE', 'At least one actual observation is required.');
    const current = await this.currentSources();
    return ids.map(id => {
      const row = state.observations.find(item => item.id === id);
      if (!row) return fail('MISSING_EVIDENCE', `Observation ${id} does not exist.`);
      if (row.provenance !== 'native_observation' || !row.execution || row.execution.outcome === 'unknown') fail('UNVERIFIABLE_EVIDENCE', 'Observation has no attributable execution outcome.');
      if (scope.workId && row.workId !== scope.workId || scope.taskId && row.taskId !== scope.taskId) fail('SCOPE_MISMATCH', 'Observation belongs to another work/task.');
      if (!row.supports.length || row.supports.some(support => this.staleSupport(support, current))) fail('STALE_EVIDENCE', 'Observation no longer covers current source content.');
      if (verification && (!row.verification || row.execution!.outcome !== 'succeeded')) fail('UNVERIFIABLE_EVIDENCE', 'Completion needs a successful project verification command.');
      return row;
    });
  }

  private async assertWorkCompletion(state: Document, work: WorkRow, assessment: CheckpointRow): Promise<void> {
    const data = assessment.data as { specificationRevision: number; planRevision: number; judgments: Array<{ criterionId: string; conclusion: string; evidenceIds: string[] }> };
    if (!data || data.specificationRevision !== (work.activeSpecification?.revision ?? 0) || data.planRevision !== (work.activePlan?.revision ?? 0)) fail('INCOMPLETE_ASSESSMENT', 'Assessment does not cover the active revisions.');
    const criteria = state.plans.find(plan => plan.id === work.activeSpecification?.id)?.criterionIds ?? data.judgments.map(j => j.criterionId);
    if (!criteria.length || new Set(data.judgments.map(j => j.criterionId)).size !== data.judgments.length || criteria.some(id => !data.judgments.some(j => j.criterionId === id && j.conclusion === 'satisfied'))) fail('INCOMPLETE_ASSESSMENT', 'Assessment must cover every criterion without ambiguity.');
    if (state.tasks.some(task => task.workId === work.id && !['completed', 'cancelled'].includes(task.disposition))) fail('INCOMPLETE_ASSESSMENT', 'Open tasks remain.');
    for (const judgment of data.judgments) {
      if (judgment.conclusion !== 'satisfied') fail('INCOMPLETE_ASSESSMENT', 'An assessment criterion is not satisfied.');
      const evidence = await this.requireEvidence(state, judgment.evidenceIds, { workId: work.id });
      if (!evidence.some(row => row.execution?.outcome === 'succeeded')) fail('UNVERIFIABLE_EVIDENCE', 'Satisfied work criteria cannot rely only on failed executions.');
    }
  }

  // A pivot is recorded as a decision claim; affected claims are flagged for review.
  // Downstream re-planning is the agent's job; prjct marks what reality invalidated.
  async replan(note: string): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const state = await this.load(this.keyOf(bound));
    const current = await this.currentSources();
    const flagged = state.claims.filter(claim => claim.standing === 'supported' && claim.supports.some(support => this.staleSupport(support, current)));
    const claims = state.claims.map(claim => flagged.includes(claim)
      ? { ...claim, standing: 'needs_review' as const, nextAction: `Re-evaluate after pivot: ${note}` }
      : claim);
    const pivot: ClaimRow = { id: newId('claim'), statement: `Pivot: ${note}`, standing: 'candidate', supports: [],
      nextAction: 'Re-evaluate the open frontier against this change.' };
    const works = state.works.map(item => item.id === state.selectedWorkId
      ? { ...item, nextAction: `Replan after pivot: ${note}` } : item);
    await this.save({ ...state, claims: [...claims, pivot], works }, state.revision, newId('replan'));
    return `Pivot recorded. ${flagged.length} supported claim(s) now need review. Open tasks keep their definitions; re-check the frontier before continuing.`;
  }

  // Deterministic consolidation: no model call. Stale-supported claims are marked
  // needs_review; the rest is a census, not a rewrite of history.
  async dream(): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const state = await this.load(this.keyOf(bound));
    const current = await this.currentSources();
    const census = { candidate: 0, supported: 0, needs_review: 0, contradicted: 0, superseded: 0 };
    let flagged = 0;
    const claims = state.claims.map(claim => {
      const stale = claim.standing === 'supported' && claim.supports.some(support => this.staleSupport(support, current));
      if (stale) flagged += 1;
      const next = stale ? { ...claim, standing: 'needs_review' as const, nextAction: 'Support no longer matches current sources.' } : claim;
      census[next.standing] += 1;
      return next;
    });
    if (flagged > 0) await this.save({ ...state, claims }, state.revision, newId('dream'));
    return `Consolidation: ${state.claims.length} claims (${census.supported} supported, ${census.candidate} candidate, ${census.needs_review} need review, ${census.contradicted} contradicted, ${census.superseded} superseded). ${flagged} flagged stale against current sources.`;
  }

  // Working-tree impact: what changed since the last sync and what touches it.
  async impact(): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const index = await this.loadIndex(this.keyOf(bound));
    if (!index) return 'No applied index. Run /prjct sync first.';
    const current = await this.currentSources();
    const diff = diffHashes(index.hashes, current.hashes);
    const changed = [...diff.added, ...diff.modified, ...diff.deleted];
    if (!changed.length && !diff.deleted.length) return `No changes since index rev ${index.appliedRevision}.`;
    const reverse = reverseImports(index.imports);
    const touched = new Set<string>();
    const queue = changed.map(path => ({ path, depth: 0 }));
    while (queue.length) {
      const { path, depth } = queue.shift()!;
      if (depth >= 2) continue;
      for (const next of [...(index.imports.forward[path] ?? []), ...(reverse[path] ?? [])]) {
        if (changed.includes(next) || touched.has(next)) continue;
        touched.add(next);
        queue.push({ path: next, depth: depth + 1 });
      }
    }
    const lines = [`Changed since rev ${index.appliedRevision}: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted.`];
    if (changed.length) lines.push(`Touched by imports (depth≤2, advisory): ${touched.size ? [...touched].join(', ') : 'none'}.`);
    const co = new Set(changed.flatMap(path => index.cochange[path] ?? []));
    if (co.size) lines.push(`Historically changed together (correlation): ${[...co].filter(path => !changed.includes(path)).join(', ')}.`);
    lines.push('Run /prjct sync to make the index current.');
    return lines.join('\n');
  }

  async listWorksText(): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return 'No bound project. /prjct init connects the project and queues the index, stack and history services; /prjct work "title" starts a cycle afterwards.';
    const state = await this.load(this.keyOf(bound));
    if (!state.works.length) return 'No work yet. /prjct work "title" starts a cycle.';
    return ['Works:', ...state.works.map(work =>
      `  ${work.id} (${work.disposition})${work.id === state.selectedWorkId ? ' [selected]' : ''} — ${work.title}`)].join('\n');
  }

  async createWork(title: string): Promise<string> {
    const state = await this.requireBound();
    const workId = newId('work');
    const work: WorkRow = { id: workId, projectId: state.projectId, title, disposition: 'open',
      origins: [contentRef(`session_${this.attemptId}`, 1, { title })], activeSpecification: null, activePlan: null,
      taskIds: [], nextAction: 'Define scope or record the next method stage.' };
    await this.save({ ...state, works: [...state.works, work], selectedWorkId: workId }, state.revision, newId('workop'));
    return `Work ${workId} created and selected: ${title}. The agent drives the cycle from here.`;
  }

  private staleSupport(support: Ref, current: CurrentSources): boolean {
    if (support.id.startsWith('repr_')) return support.contentHash !== current.manifestHash;
    if (support.id.startsWith('src_')) return current.byId.get(support.id) !== support.contentHash;
    return false;
  }

  // Ship is the user-launched close: it refuses while tasks are open or the work
  // assessment is missing/stale. Git/PR stay native; prjct only closes the cycle.
  async ship(): Promise<string> {
    const bound = await this.peekBinding();
    if (!bound) return 'Nothing to ship: no bound project.';
    const state = await this.load(this.keyOf(bound));
    const work = state.works.find(item => item.id === state.selectedWorkId);
    if (!work) return 'Nothing to ship: no selected work.';
    if (work.disposition === 'completed') return `Work ${work.id} is already completed.`;
    const open = state.tasks.filter(item => item.workId === work.id && !['completed', 'cancelled'].includes(item.disposition));
    if (open.length) return `Ship refused: open tasks ${open.map(item => item.id).join(', ')}.`;
    const assessment = [...state.checkpoints].reverse().find(item => item.workId === work.id && item.kind === 'work_assessment');
    if (!assessment) return 'Ship refused: no recorded work assessment.';
    try { await this.assertWorkCompletion(state, work, assessment); } catch (error) { return `Ship refused: ${(error as Error).message}`; }
    const data = assessment.data as { specificationRevision: number; planRevision: number;
      judgments: Array<{ criterionId: string; conclusion: string }> };
    const activeSpec = work.activeSpecification?.revision ?? 0;
    const activePlan = work.activePlan?.revision ?? 0;
    if (data.specificationRevision !== activeSpec || data.planRevision !== activePlan) {
      return 'Ship refused: the work assessment does not cover the active spec/plan revisions.';
    }
    if (data.judgments.some(item => item.conclusion !== 'satisfied')) {
      return 'Ship refused: the work assessment has unsatisfied or unknown criteria.';
    }
    const current = await this.currentSources();
    const evidenceIds = data.judgments.flatMap(item => (item as { evidenceIds?: string[] }).evidenceIds ?? []);
    const stale = state.observations.filter(item => evidenceIds.includes(item.id))
      .flatMap(item => item.supports)
      .filter(support => this.staleSupport(support, current));
    if (stale.length) {
      return `Ship refused: evidence was recorded against older sources; re-observe after /prjct sync.`;
    }
    const updated: WorkRow = { ...work, disposition: 'completed', nextAction: 'Shipped. Commit and PR remain native git operations.' };
    await this.save({ ...state, works: state.works.map(item => item.id === work.id ? updated : item) }, state.revision, newId('ship'));
    return `Work ${work.id} completed: ${work.title}. Commit and PR remain native git operations.`;
  }

  private taskItem(task: TaskRow) {
    return { reference: contentRef(task.id, 1, task), workId: task.workId, taskId: task.id, disposition: task.disposition,
      definition: task.definition, criterionIds: task.criterionIds, blockers: task.blockers, attemptId: task.attemptId,
      grantStanding: task.grantStanding, nextAction: task.nextAction };
  }

  private isBlocked(state: Document, task: TaskRow): TaskRow[] {
    return state.edges
      .filter(edge => edge.to === task.id && edge.relation === 'blocks')
      .map(edge => state.tasks.find(item => item.id === edge.from))
      .filter((blocker): blocker is TaskRow => Boolean(blocker) && !['completed', 'cancelled'].includes(blocker!.disposition));
  }

  private async task(params: Record<string, unknown>, signal?: AbortSignal) {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const state = await this.load(this.keyOf(bound));
    const action = String(params.action);
    if (!['inspect', 'frontier'].includes(action) && state.works.find(work => work.id === params.workId)?.disposition !== 'open') fail('INVALID_TRANSITION', 'Task mutation requires open work.');
    if (action === 'define') {
      const work = state.works.find(item => item.id === String(params.workId));
      if (!work) return fail('UNAVAILABLE', 'Work was not found.');
      const taskId = String(params.taskId ?? newId('task'));
      if (state.tasks.some(task => task.id === taskId)) fail('TASK_CONFLICT', 'Task ID already exists.');
      if (work.disposition !== 'open') fail('INVALID_TRANSITION', 'New tasks require open work.');
      const planRevision = work.activePlan?.revision ?? 0;
      const task: TaskRow = { id: taskId, workId: work.id, disposition: 'not_started', definition: params.definition as Ref,
        criterionIds: params.criterionIds as string[], blockers: [], attemptId: null, grantStanding: 'none', access: 'read',
        definitionRevision: (params.definition as Ref).revision, planRevision, nextAction: 'Claim the task before writing sources.' };
      const works = state.works.map(item => item.id === task.workId ? { ...item, taskIds: [...item.taskIds, taskId] } : item);
      const saved = await this.save({ ...state, works, tasks: [...state.tasks, task] }, state.revision, String(params.operationId), signal);
      const result = { action: 'define', status: 'ok', scope: { workId: task.workId, taskId }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.taskItem(task)] };
      validateStateResult('prjct_task', { action: 'define', workId: task.workId, taskId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    if (action === 'frontier') {
      const work = state.works.find(item => item.id === String(params.workId));
      if (!work) return fail('UNAVAILABLE', 'Work was not found.');
      const tasks = state.tasks.filter(item => item.workId === work.id && !['completed', 'cancelled'].includes(item.disposition));
      const ready = tasks.filter(item => this.isBlocked(state, item).length === 0)
        .map(item => ({ ...item, unblocks: state.edges.filter(edge => edge.from === item.id && edge.relation === 'blocks').length }))
        .sort((left, right) => right.unblocks - left.unblocks);
      const blocked = tasks.filter(item => this.isBlocked(state, item).length > 0);
      const items = ready.slice(0, Number(params.maxItems ?? 32)).map(item => this.taskItem(item));
      const gaps = blocked.length
        ? blocked.map(item => `${item.id} is blocked by ${this.isBlocked(state, item).map(blocker => blocker.id).join(', ')}.`)
        : [];
      const result = { action: 'frontier', status: items.length ? (gaps.length ? 'partial' : 'ok') : (tasks.length ? 'partial' : 'partial'),
        scope: { workId: work.id }, gaps: items.length ? gaps : (tasks.length ? gaps : ['No open tasks in this work.']), items };
      if (!items.length && !tasks.length) result.gaps = ['No open tasks in this work.'];
      validateStateResult('prjct_task', { action: 'frontier', workId: work.id, maxBytes: Number(params.maxBytes), maxItems: Number(params.maxItems ?? 32) }, result);
      return jsonResult(result);
    }
    const task = state.tasks.find(item => item.id === params.taskId && item.workId === params.workId);
    if (!task) return fail('UNAVAILABLE', 'Task was not found.');
    if (action === 'inspect') {
      const result = { action: 'inspect', status: 'ok', scope: { workId: task.workId, taskId: task.id }, gaps: [],
        items: [this.taskItem(task)] };
      validateStateResult('prjct_task', { action: 'inspect', workId: task.workId, taskId: task.id, maxBytes: Number(params.maxBytes), maxItems: Number(params.maxItems ?? 8) }, result);
      return jsonResult(result);
    }
    if (action === 'link') {
      const target = params.target as { workId: string; taskId: string };
      const relation = String(params.relation);
      const other = state.tasks.find(item => item.id === target.taskId && item.workId === target.workId);
      if (!other) return fail('UNAVAILABLE', 'Target task was not found.');
      if (state.edges.some(edge => edge.from === task.id && edge.to === other.id && edge.relation === relation)) {
        fail('INVALID_RESULT', 'This relation already exists between the tasks.');
      }
      if (relation === 'blocks') {
        const reaches = (from: string, to: string, visited: Set<string> = new Set()): boolean => {
          if (from === to) return true;
          if (visited.has(from)) return false;
          visited.add(from);
          return state.edges.filter(edge => edge.relation === 'blocks' && edge.from === from).some(edge => reaches(edge.to, to, visited));
        };
        if (reaches(other.id, task.id)) fail('INVALID_RESULT', 'A blocking cycle is not allowed.');
      }
      const edges = [...state.edges, { from: task.id, to: other.id, relation }];
      const blockerRef = relation === 'blocks' ? contentRef(task.id, 1, task) : undefined;
      const tasks = blockerRef
        ? state.tasks.map(item => item.id === other.id ? { ...item, blockers: [...item.blockers, blockerRef] } : item)
        : state.tasks;
      const saved = await this.save({ ...state, edges, tasks }, state.revision, String(params.operationId), signal);
      const updated = saved.tasks.find(item => item.id === task.id)!;
      const result = { action: 'link', status: 'ok', scope: { workId: task.workId, taskId: task.id }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.taskItem(updated)] };
      validateStateResult('prjct_task', { action: 'link', workId: task.workId, taskId: task.id, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    if (action === 'claim') {
      const checkoutId = String(params.checkoutId);
      if (checkoutId !== state.checkoutId) fail('CHECKOUT_MISMATCH', `This checkout is ${state.checkoutId}; the claim names ${checkoutId}.`);
      if (['completed', 'cancelled'].includes(task.disposition)) fail('INVALID_TRANSITION', 'Terminal tasks cannot be claimed.');
      if (this.isBlocked(state, task).length) fail('TASK_BLOCKED', 'Resolve blocking tasks before claiming this task.');
      const access = String(params.access) as 'read' | 'write';
      const existing = state.grants.tasks[task.id];
      if (existing?.standing === 'uncertain') fail('RECONCILE_REQUIRED', 'Task ownership is uncertain.');
      if (existing?.standing === 'valid' && existing.attemptId !== this.attemptId) {
        fail('CLAIM_CONFLICT', 'The task is claimed by another attempt.');
      }
      if (access === 'write') {
        const writer = state.grants.writer;
        if (writer?.standing === 'uncertain') fail('RECONCILE_REQUIRED', 'Writer ownership is uncertain.');
        if (writer?.standing === 'valid' && writer.attemptId !== this.attemptId) {
          fail('CLAIM_CONFLICT', 'The checkout already has a writer from another attempt.');
        }
      }
      const taskGeneration = (existing?.generation ?? 0) + 1;
      const writerGeneration = access === 'write' ? (state.grants.writer?.generation ?? 0) + 1 : (state.grants.writer?.generation ?? 0);
      const grants = {
        tasks: { ...state.grants.tasks, [task.id]: { attemptId: this.attemptId, generation: taskGeneration, standing: 'valid' as const } },
        writer: access === 'write'
          ? { attemptId: this.attemptId, generation: writerGeneration, standing: 'valid' as const, checkoutId }
          : state.grants.writer,
      };
      const verify = (await this.loadManifest(this.keyOf(state)))?.profile.tests.command;
      const updated: TaskRow = { ...task, attemptId: this.attemptId, grantStanding: 'valid', access, checkoutId,
        disposition: task.disposition === 'not_started' ? 'in_progress' : task.disposition,
        nextAction: access === 'write'
          ? `Write sources; verify with ${verify ?? 'the project test command'}; record native evidence before completing.`
          : 'Read-only claim recorded.' };
      const saved = await this.save({ ...state, grants, tasks: state.tasks.map(item => item.id === task.id ? updated : item) },
        state.revision, String(params.operationId), signal);
      const result = { action: 'claim', status: 'ok', scope: { workId: task.workId, taskId: task.id, checkoutId }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.taskItem(updated)] };
      validateStateResult('prjct_task', { action: 'claim', workId: task.workId, taskId: task.id, checkoutId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    if (action === 'transition') {
      const transition = String(params.transition) as 'pause' | 'yield' | 'cancel' | 'reopen' | 'complete';
      const taskGrant = state.grants.tasks[task.id];
      const transitionState: TransitionState = {
        workId: task.workId, taskId: task.id, disposition: task.disposition, access: task.access,
        definitionRevision: task.definitionRevision, planRevision: task.planRevision,
        ...(task.checkoutId ? { checkoutId: task.checkoutId } : {}),
        ...(taskGrant ? { taskGrant: { scopeId: task.id, ...taskGrant } } : {}),
        ...(state.grants.writer ? { writerGrant: { scopeId: state.grants.writer.checkoutId, ...state.grants.writer } } : {}),
      };
      const binding = { workId: task.workId, taskId: task.id, checkoutId: state.checkoutId, attemptId: this.attemptId,
        taskGeneration: taskGrant?.generation ?? 0, writerGeneration: state.grants.writer?.generation ?? 0 };
      let completion: CompletionSnapshot | undefined;
      if (transition === 'complete') {
        const tdd = [...state.checkpoints].reverse().find(row => row.workId === task.workId && row.taskId === task.id && row.kind === 'progress' && (row.data as { methodId?: string } | undefined)?.methodId === 'tdd');
        if (tdd && !['green_observed', 'review_pending'].includes((tdd.data as { stage: string }).stage)) fail('INCOMPLETE_METHOD', 'The recorded TDD method has not reached observed green.');
        const assessment = state.checkpoints.find(item => item.id === String(params.assessmentId) && item.workId === task.workId && item.taskId === task.id && item.kind === 'assessment');
        if (!assessment) fail('INCOMPLETE_ASSESSMENT', 'Completion requires a recorded assessment.');
        const data = assessment!.data as { planRevision: number; definitionRevision: number;
          judgments: Array<{ criterionId: string; conclusion: 'satisfied' | 'unsatisfied' | 'unknown'; evidenceIds: string[] }> };
        const needsVerification = Boolean((await this.loadManifest(this.keyOf(state)))?.profile.tests.command);
        for (const judgment of data.judgments) await this.requireEvidence(state, judgment.evidenceIds, { workId: task.workId, taskId: task.id }, needsVerification);
        const evidence = data.judgments.flatMap(item => item.evidenceIds)
          .map(id => state.observations.find(item => item.id === id))
          .filter((item): item is ObservationRow => Boolean(item))
          .map(item => ({ id: item.id, provenance: item.provenance, supports: item.supports }));
        const current = await this.currentSources();
        const currentSupports: Ref[] = [];
        for (const row of evidence) {
          for (const support of row.supports ?? []) {
            if (support.id.startsWith('repr_')) {
              if (support.contentHash === current.manifestHash) currentSupports.push(support);
              continue;
            }
            if (support.id.startsWith('src_')) {
              if (current.byId.get(support.id) === support.contentHash) currentSupports.push(support);
              continue;
            }
            const rowRef = [...state.works, ...state.tasks, ...state.claims, ...state.plans].find(item => item.id === support.id);
            if (rowRef) {
              const current = contentRef(rowRef.id, 1, rowRef);
              if (current.contentHash === support.contentHash && current.revision === support.revision) currentSupports.push(support);
            }
          }
        }
        completion = {
          scope: { workId: task.workId, taskId: task.id, definitionRevision: task.definitionRevision, planRevision: task.planRevision },
          criteria: task.criterionIds,
          assessment: { scope: { workId: task.workId, taskId: task.id, definitionRevision: data.definitionRevision, planRevision: data.planRevision }, judgments: data.judgments },
          evidence, currentSupports,
        };
        assertTaskTransition(transition, transitionState, binding, completion);
      } else {
        assertTaskTransition(transition, transitionState, binding);
      }
      const releaseGrants = transition === 'yield' || transition === 'cancel' || transition === 'complete';
      const disposition: TaskRow['disposition'] = transition === 'pause' ? 'awaiting_input'
        : transition === 'complete' ? 'completed'
        : transition === 'cancel' ? 'cancelled'
        : transition === 'reopen' ? 'not_started'
        : task.disposition === 'awaiting_input' ? 'in_progress' : task.disposition;
      const grants = releaseGrants
        ? { tasks: { ...state.grants.tasks, [task.id]: { ...(state.grants.tasks[task.id] ?? { attemptId: this.attemptId, generation: 0 }), standing: 'released' as const } },
          writer: state.grants.writer?.attemptId === this.attemptId ? { ...state.grants.writer, standing: 'released' as const } : state.grants.writer }
        : state.grants;
      const updated: TaskRow = { ...task, disposition,
        attemptId: releaseGrants ? null : task.attemptId,
        grantStanding: releaseGrants ? 'released' : task.grantStanding,
        nextAction: transition === 'complete' ? 'Completed with an eligible assessment.'
          : transition === 'reopen' ? 'Reopened; claim again before continuing.'
          : String(params.reason ?? 'Transition recorded.') };
      const saved = await this.save({ ...state, grants, tasks: state.tasks.map(item => item.id === task.id ? updated : item) },
        state.revision, String(params.operationId), signal);
      const result = { action: 'transition', status: 'ok', scope: { workId: task.workId, taskId: task.id }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.taskItem(updated)] };
      validateStateResult('prjct_task', { action: 'transition', workId: task.workId, taskId: task.id, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    return fail('INVALID_RESULT', `Task action ${action} is not implemented in this slice.`);
  }

  private planRef(row: PlanRow) {
    return contentRef(row.id, row.revision, { workId: row.workId, kind: row.kind, content: row.content, specification: row.specification, tasks: row.tasks, criterionIds: row.criterionIds });
  }

  private planItem(row: PlanRow) {
    return { reference: this.planRef(row), kind: row.kind, standing: row.standing, specification: row.specification,
      tasks: row.tasks, criterionIds: row.criterionIds, nextAction: row.nextAction };
  }

  private async plan(params: Record<string, unknown>, signal?: AbortSignal) {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const state = await this.load(this.keyOf(bound));
    if (params.action === 'draft') {
      if (!state.works.some(work => work.id === params.workId)) fail('UNAVAILABLE', 'Plan work does not exist.');
      const id = newId('plan');
      const row: PlanRow = { id, workId: String(params.workId), kind: params.kind as 'spec' | 'plan', standing: 'draft',
        revision: 1 + Math.max(0, ...state.plans.filter(plan => plan.workId === params.workId && plan.kind === params.kind).map(plan => plan.revision)), content: (params.content as Ref | undefined) ?? null,
        specification: (params.specification as Ref | undefined) ?? null, tasks: (params.tasks as Array<{ taskId: string; definitionRevision: number }> | undefined) ?? [],
        criterionIds: (params.criterionIds as string[] | undefined) ?? [],
        nextAction: 'Adoption requires current user confirmation; this draft is not active.' };
      const saved = await this.save({ ...state, plans: [...state.plans, row] }, state.revision, String(params.operationId), signal);
      const result = { action: 'draft', status: 'ok', scope: { workId: row.workId }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.planItem(row)] };
      validateStateResult('prjct_plan', { action: 'draft', workId: row.workId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    const work = state.works.find(item => item.id === String(params.workId));
    if (!work) return fail('UNAVAILABLE', 'Work was not found.');
    if (params.action === 'inspect') {
      const ref = params.revision as Ref;
      const row = state.plans.find(item => item.id === ref.id && item.workId === work.id);
      if (!row) return fail('UNAVAILABLE', 'Plan revision was not found.');
      if (row.revision !== ref.revision || this.planRef(row).contentHash !== ref.contentHash) {
        fail('STALE_REVISION', 'The pinned plan revision no longer matches the stored draft.');
      }
      const result = { action: 'inspect', status: 'ok', scope: { workId: work.id }, gaps: [], items: [this.planItem(row)] };
      validateStateResult('prjct_plan', { action: 'inspect', workId: work.id, maxBytes: Number(params.maxBytes) }, result);
      return jsonResult(result);
    }
    if (params.action === 'adopt') {
      const candidate = params.candidate as Ref;
      const row = state.plans.find(item => item.id === candidate.id && item.workId === work.id);
      if (!row) return fail('UNAVAILABLE', 'Adoption candidate was not found.');
      if (row.revision !== candidate.revision || this.planRef(row).contentHash !== candidate.contentHash) {
        fail('STALE_REVISION', 'The adoption candidate changed after it was pinned.');
      }
      if (row.standing === 'superseded') fail('INVALID_TRANSITION', 'A superseded plan cannot be adopted.');
      if (!await this.transaction.getStore()?.confirm?.(`Adopt exact candidate ${JSON.stringify(params.candidate)} for work ${work.id}?`)) fail('CONFIRMATION_REQUIRED', 'Plan adoption requires current host confirmation.');
      const plans = state.plans.map(item => item.workId === work.id && item.kind === row.kind && item.standing === 'active'
        ? { ...item, standing: 'superseded' as const, nextAction: `Superseded by ${row.id}.` }
        : item.id === row.id ? { ...row, standing: 'active' as const, nextAction: 'Active revision.' } : item);
      const activeRow = plans.find(item => item.id === row.id)!;
      const reference = this.planRef(activeRow);
      const updated: WorkRow = row.kind === 'spec'
        ? { ...work, activeSpecification: reference, nextAction: `Adopted spec ${row.id} r${row.revision}.` }
        : { ...work, activePlan: reference, nextAction: `Adopted plan ${row.id} r${row.revision}.` };
      const works = state.works.map(item => item.id === work.id ? updated : item);
      const saved = await this.save({ ...state, plans, works }, state.revision, String(params.operationId), signal);
      const adopted = saved.plans.find(item => item.id === row.id)!;
      const result = { action: 'adopt', status: 'ok', scope: { workId: work.id }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.planItem(adopted)] };
      validateStateResult('prjct_plan', { action: 'adopt', workId: work.id, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    return fail('INVALID_RESULT', 'Plan action is not implemented in this slice.');
  }

  private async checkpoint(params: Record<string, unknown>, signal?: AbortSignal) {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const state = await this.load(this.keyOf(bound));
    if (!state.works.some(work => work.id === params.workId) || params.taskId && !state.tasks.some(task => task.id === params.taskId && task.workId === params.workId)) fail('SCOPE_MISMATCH', 'Checkpoint scope does not exist in this work.');
    const evidenceProvenance = (id: string): 'native_observation' | 'agent_report' =>
      state.observations.find(item => item.id === id)?.provenance ?? 'agent_report';
    if (params.kind === 'progress' && (params.evidenceIds as string[]).length) await this.requireEvidence(state, params.evidenceIds as string[], { workId: String(params.workId), taskId: String(params.taskId) });
    if (params.kind === 'decision_reference') await this.requireEvidence(state, [String(params.observationId)], { workId: String(params.workId), taskId: String(params.taskId) });
    if (params.kind === 'progress') {
      const methodId = String(params.methodId);
      const stage = String(params.stage);
      const evidenceIds = (params.evidenceIds as string[] | undefined) ?? [];
      const evidenceRows = evidenceIds.map(id => state.observations.find(item => item.id === id)).filter((row): row is ObservationRow => Boolean(row));
      const evidence = evidenceIds.map(id => ({ id, provenance: evidenceProvenance(id) }));
      const known = methodId as keyof typeof METHOD_STAGES;
      const stages = METHOD_STAGES[known];
      if (!stages) fail('INVALID_STAGE', `Unknown methodId ${methodId}. Query "methods" for the catalog and stage vocabulary.`);
      const previous = [...state.checkpoints].reverse().find(row => row.workId === params.workId && row.taskId === params.taskId && row.kind === 'progress' && (row.data as { methodId?: string } | undefined)?.methodId === methodId);
      const from = (previous?.data as { stage?: string } | undefined)?.stage ?? stages[0]!;
      assertMethodProgress({ methodId: known, from, to: stage, evidence });
      const userInput = evidenceRows.some(row => row.execution?.toolName === 'user_input');
      if (methodId === 'tdd') {
        if (stage === 'seam_confirmed' && !userInput) fail('UNVERIFIABLE_EVIDENCE', 'Public test seams require a current user confirmation observation.');
        if (stage === 'red_observed' || stage === 'green_observed') {
          const rows = await this.requireEvidence(state, evidenceIds, { workId: String(params.workId), taskId: String(params.taskId) });
          const outcome = stage === 'red_observed' ? 'failed' : 'succeeded';
          if (!rows.some(row => row.verification && row.execution?.outcome === outcome)) fail('UNVERIFIABLE_EVIDENCE', `No project verification with the required ${outcome} outcome.`);
        }
      }
      // Human decisions require a real user observation captured from Pi input,
      // not a source read or an agent report.
      if ((methodId === 'grilling' && stage === 'decision_recorded') || (methodId === 'to-spec' && stage === 'seams_confirmed')) {
        if (!userInput) fail('UNVERIFIABLE_EVIDENCE', 'A recorded human decision requires a native user-input observation from this work.');
      }
      // A handoff is ready only when its portable artifact actually exists.
      if (methodId === 'handoff' && stage === 'ready'
        && !state.artifacts.some(row => row.kind === 'handoff' && !row.stagedBlobId && (!params.workId || row.workId === params.workId))) {
        fail('UNVERIFIABLE_EVIDENCE', 'Handoff readiness requires a published handoff artifact for this work.');
      }
      // A diagnosis fix needs an executed loop: a prior reproduced failure and a
      // succeeding verification command. A source read is not a loop.
      if (methodId === 'diagnosing-bugs' && stage === 'fixed') {
        const reproduced = state.checkpoints.some(row => row.workId === params.workId && row.taskId === params.taskId && row.kind === 'progress'
          && (row.data as { methodId?: string; stage?: string } | undefined)?.methodId === 'diagnosing-bugs'
          && (row.data as { stage?: string } | undefined)?.stage === 'reproduced'
          && ((row.data as { evidenceIds?: string[] } | undefined)?.evidenceIds ?? []).some(id => {
            const obs = state.observations.find(item => item.id === id);
            return obs?.execution?.toolName === 'bash' && obs.execution.outcome === 'failed';
          }));
        if (!reproduced) fail('UNVERIFIABLE_EVIDENCE', 'Fix requires a prior reproduced stage backed by a failed native command observation.');
        if (!evidenceRows.some(row => row.execution?.toolName === 'bash' && row.execution.outcome === 'succeeded')) {
          fail('UNVERIFIABLE_EVIDENCE', 'Fix requires a succeeding native command observation; a read is not a feedback loop.');
        }
      }
    }
    if (params.kind === 'reuse_assessment') {
      const data = params.data as Parameters<typeof assertReuseAssessment>[0]['data'];
      assertReuseAssessment({ data } as Parameters<typeof assertReuseAssessment>[0]);
      await this.requireEvidence(state, data.examinedEvidenceIds, { workId: String(params.workId), taskId: String(params.taskId) });
      for (const existing of data.existing) await this.requireEvidence(state, existing.evidenceIds, { workId: String(params.workId), taskId: String(params.taskId) });
    }
    const id = newId('chk');
    const kind = String(params.kind);
    const data = kind === 'assessment'
      ? { planRevision: Number(params.planRevision), definitionRevision: Number(params.definitionRevision),
          judgments: params.judgments as unknown[] }
      : kind === 'work_assessment'
        ? { specificationRevision: Number(params.specificationRevision), planRevision: Number(params.planRevision),
            taskAssessments: params.taskAssessments ?? [], judgments: params.judgments as unknown[] }
        : kind === 'progress'
          ? { methodId: String(params.methodId), stage: String(params.stage), summary: String(params.summary),
              evidenceIds: (params.evidenceIds as string[] | undefined) ?? [] }
          : kind === 'decision_reference'
            ? { questionId: String(params.questionId), observationId: String(params.observationId), subject: String(params.subject) }
            : kind === 'reuse_assessment' ? params.data : undefined;
    if (kind === 'work_assessment') {
      for (const judgment of params.judgments as Array<{ evidenceIds: string[] }>) await this.requireEvidence(state, judgment.evidenceIds, { workId: String(params.workId) });
    }
    if (kind === 'assessment') {
      const judgments = params.judgments as Array<{ conclusion: string; evidenceIds: string[] }>;
      for (const judgment of judgments) {
        for (const evidenceId of judgment.evidenceIds) {
          if (!state.observations.some(item => item.id === evidenceId)) {
            fail('MISSING_EVIDENCE', `Evidence ${evidenceId} is not a recorded observation.`);
          }
        }
      }
      const task = state.tasks.find(item => item.id === String(params.taskId) && item.workId === String(params.workId));
      if (task && (task.definitionRevision !== Number(params.definitionRevision) || task.planRevision !== Number(params.planRevision))) {
        fail('STALE_REVISION', 'The assessment scope does not match the task definition and plan revisions.');
      }
    }
    const row: CheckpointRow = { id, workId: String(params.workId), ...(params.taskId ? { taskId: String(params.taskId) } : {}),
      kind, nextAction: String(params.nextAction ?? 'Continue from the recorded stage.'),
      ...(data !== undefined ? { data } : {}) };
    const saved = await this.save({ ...state, checkpoints: [...state.checkpoints, row] }, state.revision, String(params.operationId), signal);
    const result = { action: 'record', status: 'ok', scope: { workId: row.workId, ...(row.taskId ? { taskId: row.taskId } : {}) }, gaps: [],
      mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
        receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
      recorded: { kind: row.kind, reference: contentRef(id, 1, row), nextAction: row.nextAction } };
    validateStateResult('prjct_checkpoint', { action: 'record', workId: row.workId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId),
      ...(row.taskId ? { taskId: row.taskId } : {}) }, result);
    return jsonResult(result);
  }

  private async reconcile(params: Record<string, unknown>, signal?: AbortSignal) {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'No bound project.');
    const state = await this.load(this.keyOf(bound));
    const task = state.tasks.find(item => item.id === params.taskId && item.workId === params.workId);
    if (params.action === 'inspect') {
      const index = await this.loadManifest(this.keyOf(bound));
      const current = await this.currentSources();
      const diff = index ? diffHashes(index.hashes, current.hashes) : { added: [], modified: [], deleted: [] };
      const changed = [...diff.added, ...diff.modified, ...diff.deleted];
      const observedEffects = changed.slice(0, 32).map(path => ({
        id: sourceId(path), outcome: 'unknown' as const,
      }));
      const result = { action: 'inspect', status: 'partial', scope: { workId: String(params.workId), taskId: String(params.taskId) },
        gaps: ['Continuation requires current user confirmation; /resume is not consent.'],
        predecessorAttemptId: task?.attemptId ?? null, writerStanding: task?.grantStanding === 'valid' ? 'valid' : 'none',
        observedEffects, requiredConfirmation: true,
        unknowns: changed.length
          ? [`${changed.length} file(s) changed since the last sync; whether a predecessor write landed is unknown for each.`]
          : ['Whether a predecessor write landed.'],
        nextAction: 'Obtain current confirmation before continue.' };
      validateStateResult('prjct_reconcile', { action: 'inspect', workId: String(params.workId), taskId: String(params.taskId), maxBytes: Number(params.maxBytes) }, result);
      return jsonResult(result);
    }
    if (params.action === 'continue') {
      if (!task) return fail('UNAVAILABLE', 'Task was not found.');
      const predecessorId = String(params.predecessorAttemptId);
      const grant = state.grants.tasks[task.id];
      const knownPredecessor = task.attemptId ?? grant?.attemptId ?? null;
      if (knownPredecessor && knownPredecessor !== predecessorId) {
        fail('SCOPE_MISMATCH', 'The named predecessor does not hold this task.');
      }
      const observationIds = params.observationIds as string[];
      for (const id of observationIds) {
        if (!state.observations.some(item => item.id === id)) {
          fail('MISSING_EVIDENCE', `Observation ${id} is not recorded; absence is not proof the predecessor stopped.`);
        }
      }
      if (!await this.transaction.getStore()?.confirm?.(`Take over task ${String(params.taskId)} from ${String(params.predecessorAttemptId)}? Confirm that the predecessor has stopped; unknown effects will remain unknown.`)) fail('CONFIRMATION_REQUIRED', 'Continuation requires current host confirmation that the predecessor has stopped.');
      const generation = (grant?.generation ?? 0) + 1;
      const grants = {
        tasks: { ...state.grants.tasks, [task.id]: { attemptId: this.attemptId, generation, standing: 'valid' as const } },
        writer: state.grants.writer?.attemptId === predecessorId
          ? { ...state.grants.writer, attemptId: this.attemptId, generation: state.grants.writer.generation + 1 }
          : state.grants.writer,
      };
      const updated: TaskRow = { ...task, attemptId: this.attemptId, grantStanding: 'valid',
        disposition: task.disposition === 'awaiting_input' ? 'in_progress' : task.disposition,
        nextAction: `Continued after ${predecessorId}; prior effects remain recorded, not replayed.` };
      const saved = await this.save({ ...state, grants, tasks: state.tasks.map(item => item.id === task.id ? updated : item) },
        state.revision, String(params.operationId), signal);
      const result = { action: 'continue', status: 'ok', scope: { workId: task.workId, taskId: task.id }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        predecessorAttemptId: predecessorId, writerStanding: 'valid',
        observedEffects: observationIds.map(id => ({ id, outcome: 'unknown' as const })),
        requiredConfirmation: false, unknowns: ['Predecessor effects remain unknown until individually verified.'], nextAction: updated.nextAction };
      validateStateResult('prjct_reconcile', { action: 'continue', workId: task.workId, taskId: task.id, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    return fail('INVALID_RESULT', 'Reconcile action is not implemented in this slice.');
  }

  private claimItem(row: ClaimRow) {
    return { reference: contentRef(row.id, 1, row), statement: row.statement, standing: row.standing, supports: row.supports, nextAction: row.nextAction };
  }

  private async knowledge(params: Record<string, unknown>, signal?: AbortSignal) {
    const bound = await this.peekBinding();
    if (params.action === 'replan') {
      if (!bound) return fail('UNAVAILABLE', 'No bound project.');
      const before = await this.load(this.keyOf(bound));
      const text = await this.replan(String(params.statement));
      const after = await this.load(this.keyOf(bound));
      const flagged = after.claims.filter(claim => claim.standing === 'needs_review' &&
        !before.claims.some(item => item.id === claim.id && item.standing === 'needs_review'));
      const pivot = after.claims[after.claims.length - 1]!;
      const result = { action: 'replan', status: 'ok' as const, scope: { projectId: after.projectId }, gaps: [],
        items: [pivot, ...flagged].map(item => this.claimItem(item)) };
      void text;
      validateStateResult('prjct_knowledge', { action: 'replan', projectId: after.projectId, maxBytes: Number(params.maxBytes) }, result);
      return jsonResult(result);
    }
    if (params.action === 'consolidate') {
      if (!bound) return fail('UNAVAILABLE', 'No bound project.');
      await this.dream();
      const after = await this.load(this.keyOf(bound));
      const review = after.claims.filter(claim => claim.standing === 'needs_review');
      const result = { action: 'consolidate', status: 'ok' as const, scope: { projectId: after.projectId }, gaps: [],
        items: review.slice(0, 32).map(item => this.claimItem(item)) };
      validateStateResult('prjct_knowledge', { action: 'consolidate', projectId: after.projectId, maxBytes: Number(params.maxBytes) }, result);
      return jsonResult(result);
    }
    if (params.action === 'inspect') {
      if (!bound) return fail('UNAVAILABLE', 'No bound project.');
      const state = await this.load(this.keyOf(bound));
      const claim = state.claims.find(item => item.id === params.claimId);
      if (!claim) return fail('UNAVAILABLE', 'Claim was not found.');
      const result = { action: 'inspect', status: 'ok', scope: { projectId: state.projectId }, gaps: [], items: [this.claimItem(claim)] };
      validateStateResult('prjct_knowledge', { action: 'inspect', projectId: state.projectId, maxBytes: Number(params.maxBytes) }, result);
      return jsonResult(result);
    }
    if (params.action === 'resolve') {
      if (!bound) return fail('UNAVAILABLE', 'No bound project.');
      const state = await this.load(this.keyOf(bound));
      const claim = state.claims.find(item => item.id === params.claimId);
      if (!claim) return fail('UNAVAILABLE', 'Claim was not found.');
      const evidence = await this.requireEvidence(state, (params.evidenceIds as string[]) ?? [], {});
      if (evidence.some(row => row.execution?.outcome !== 'succeeded')) fail('UNVERIFIABLE_EVIDENCE', 'Knowledge resolution needs successful source inspection.');
      const resolution = String(params.resolution);
      if (resolution === 'confirm') {
        const current = await this.currentSources();
        if (claim.supports.some(support => !/^(src_|repr_)/.test(support.id) || this.staleSupport(support, current))) fail('STALE_EVIDENCE', 'Claim support is missing or no longer current.');
      }
      const replacement = params.replacement as Ref | undefined;
      if ((resolution === 'correct' || resolution === 'supersede') && replacement) {
        if (!state.claims.some(item => item.id === replacement.id) && !state.artifacts.some(item => item.id === replacement.id)) {
          fail('UNAVAILABLE', 'The replacement reference does not identify a stored claim or artifact.');
        }
      }
      const standing: ClaimRow['standing'] = resolution === 'confirm' ? 'supported'
        : resolution === 'contradict' ? 'contradicted'
        : 'superseded';
      const supports = resolution === 'confirm'
        ? [...claim.supports, ...((params.evidenceIds as string[]) ?? []).flatMap(id => {
            const observation = state.observations.find(item => item.id === id);
            return observation?.supports ?? [];
          })]
        : claim.supports;
      const updated: ClaimRow = { ...claim, standing,
        supports: [...new Map(supports.map(item => [`${item.id}:${item.revision}`, item])).values()],
        nextAction: `${resolution}: ${String(params.rationale)}` };
      const saved = await this.save({ ...state, claims: state.claims.map(item => item.id === claim.id ? updated : item) },
        state.revision, String(params.operationId), signal);
      const result = { action: 'resolve', status: 'ok', scope: { projectId: saved.projectId }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.claimItem(updated)] };
      validateStateResult('prjct_knowledge', { action: 'resolve', projectId: saved.projectId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    const state = await this.requireBound();
    if (params.action === 'propose') {
      observeEvidence({ id: newId('ev'), provenance: 'agent_report', origin: 'tool_payload', supports: params.supports as Ref[] });
      const id = newId('claim');
      const row: ClaimRow = { id, statement: String(params.statement), standing: 'candidate', supports: (params.supports as Ref[]) ?? [],
        nextAction: 'Inspect current support before resolving.' };
      const saved = await this.save({ ...state, claims: [...state.claims, row] }, state.revision, String(params.operationId), signal);
      const result = { action: 'propose', status: 'ok', scope: { projectId: saved.projectId }, gaps: [],
        mutation: { operationId: String(params.operationId), scopeId: saved.projectId, outcome: 'committed',
          receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision },
        items: [this.claimItem(row)] };
      validateStateResult('prjct_knowledge', { action: 'propose', projectId: saved.projectId, maxBytes: Number(params.maxBytes), operationId: String(params.operationId) }, result);
      return jsonResult(result);
    }
    return fail('INVALID_RESULT', 'Knowledge action is not implemented in this slice.');
  }

  private async artifact(params: Record<string, unknown>, signal?: AbortSignal) {
    const bound = await this.peekBinding();
    if (!bound) return fail('UNAVAILABLE', 'Bind the project before using artifacts.');
    const state = await this.load(this.keyOf(bound));
    const pathFor = (id: string) => join(scopeStore(this.prjctRoot, this.keyOf(state), 'artifacts'), id, 'content.txt');
    if (params.workId && !state.works.some(work => work.id === params.workId)) fail('SCOPE_MISMATCH', 'Artifact work does not exist.');
    const item = (row: ArtifactRow) => ({ reference: contentRef(row.id, 1, row), kind: row.kind, stagedBlobId: row.stagedBlobId,
      readLocator: pathFor(row.id), exportIntent: row.exportIntent, nextAction: row.nextAction });
    let rows: ArtifactRow[] = [];
    let next: { snapshot: Ref; afterId: string } | undefined;
    let saved = state;
    if (params.action === 'stage' || params.action === 'publish') {
      if ('destination' in params) fail('INVALID_RESULT', 'Artifact publication cannot write to a client destination.');
      if (params.previous) {
        const pin = params.previous as Ref;
        const prior = state.artifacts.find(row => row.id === pin.id);
        if (!prior || contentRef(prior.id, 1, prior).contentHash !== pin.contentHash || pin.revision !== 1) fail('STALE_REVISION', 'Previous artifact revision is not available.');
      }
      const id = newId('art');
      let content = typeof params.content === 'string' ? params.content : '';
      if (params.stagedBlobId) {
        const staged = state.artifacts.find(row => row.stagedBlobId === params.stagedBlobId);
        if (!staged) fail('UNAVAILABLE', 'Staged blob is not managed by this project.');
        content = await readFile(pathFor(staged!.id), 'utf8');
        if (sha256(content) !== params.expectedContentHash) fail('STALE_REVISION', 'Staged content changed.');
      }
      const row: ArtifactRow = { id, kind: String(params.kind), content, ...(params.workId ? { workId: String(params.workId) } : {}), ...(params.previous ? { previous: params.previous as Ref } : {}), stagedBlobId: params.action === 'stage' ? id : null,
        exportIntent: null, nextAction: params.action === 'stage' ? 'Author the managed file with native tools, then publish its exact hash.' : 'Read the managed content path; exports require separate authorization.' };
      const frame = this.transaction.getStore();
      if (!frame) fail('INVALID_RESULT', 'Artifact writes require a process transaction.');
      (frame!.files ??= []).push({ path: pathFor(id), content });
      saved = await this.save({ ...state, artifacts: [...state.artifacts, row] }, state.revision, String(params.operationId), signal);
      rows = [row];
    } else if (params.action === 'inspect' || params.action === 'prepare_export') {
      const pin = params.revision as Ref;
      const row = state.artifacts.find(item => item.id === pin.id);
      if (!row) fail('UNAVAILABLE', 'Artifact not found.');
      if (pin.revision !== 1 || pin.contentHash !== contentRef(row!.id, 1, row).contentHash) fail('STALE_REVISION', 'Artifact revision does not match.');
      if (params.workId && row!.workId !== params.workId) fail('SCOPE_MISMATCH', 'Artifact belongs to another work.');
      if (!row!.stagedBlobId) {
        const content = await readFile(pathFor(row!.id), 'utf8');
        if (content !== row!.content) fail('CORRUPT_STATE', 'Published artifact content changed outside its revision.');
      }
      rows = [row!];
      if (params.action === 'prepare_export') saved = await this.save({ ...state, exportIntents: [...(state.exportIntents ?? []), { revision: pin, description: String(params.targetDescription), operationId: String(params.operationId) }] }, state.revision, String(params.operationId), signal);
    } else if (params.action === 'list') {
      const select = (items: ArtifactRow[]) => items.filter(row => !params.workId || row.workId === params.workId);
      let all = select(state.artifacts);
      let snapshot = contentRef(`artifacts_${state.projectId}_${sha256(String(params.workId ?? '')).slice(0, 8)}`, state.revision, all);
      const cursor = params.cursor as { snapshot: Ref; afterId: string } | undefined;
      if (cursor) {
        const past = await readRevision(this.statePath(this.keyOf(state)), cursor.snapshot.revision);
        if (!past || cursor.snapshot.id !== snapshot.id) fail('STALE_CURSOR', 'Artifact cursor scope is unavailable.');
        all = select((past!.payload as Document).artifacts);
        if (contentRef(snapshot.id, cursor.snapshot.revision, all).contentHash !== cursor.snapshot.contentHash) fail('STALE_CURSOR', 'Artifact cursor content changed.');
        const at = all.findIndex(row => row.id === cursor.afterId);
        if (at < 0) fail('STALE_CURSOR', 'Artifact cursor position is unavailable.');
        all = all.slice(at + 1); snapshot = cursor.snapshot;
      }
      rows = all.slice(0, Number(params.maxItems ?? 32));
      if (rows.length < all.length && rows.length) next = { snapshot, afterId: rows[rows.length - 1]!.id };

    } else fail('INVALID_RESULT', 'Unknown artifact action.');
    const items = rows.map(item);
    if (params.action === 'prepare_export') for (const row of items) row.exportIntent = String(params.targetDescription);
    const result = { action: String(params.action), status: items.length ? 'ok' : 'partial', scope: { projectId: state.projectId },
      gaps: items.length ? [] : ['No artifacts published.'], items, ...(next ? { next } : {}),
      ...(saved !== state ? { mutation: { operationId: String(params.operationId), scopeId: state.projectId, outcome: 'committed', receipt: saved.operations[String(params.operationId)]!.receipt, replayed: false, stateRevision: saved.revision } } : {}) };
    validateStateResult('prjct_artifact', { action: String(params.action), projectId: state.projectId, maxBytes: Number(params.maxBytes) }, result);
    return jsonResult(result);
  }

  private async search(params: Record<string, unknown>) {
    const request = params as { checkoutId: string; query: string; maxItems: number; maxBytes: number; workId?: string;
      kinds?: Array<'source' | 'claim' | 'artifact'> };
    const ids = await this.previewIds();
    if (request.checkoutId !== ids.checkoutId) fail('CHECKOUT_MISMATCH', `This checkout is ${ids.checkoutId}; search named ${request.checkoutId}. Use the id from prjct_context discover.`);
    const kinds = request.kinds ?? ['source', 'claim', 'artifact'];
    const bound = await this.peekBinding();
    const stored = bound ? await this.loadIndex(this.keyOf(bound)) : undefined;
    const current = stored ? await this.currentSources() : undefined;
    const fresh = Boolean(stored && current && stored.manifestHash === current.manifestHash && stored.configRevision === INDEX_CONFIG_REVISION);
    const items: Array<{
      kind: 'source' | 'claim' | 'artifact'; reference: Ref; summary: string; applicability: 'current' | 'stale' | 'unknown';
      sources: Ref[]; reasons: string[]; readPath?: string;
    }> = [];
    const gaps: string[] = [];

    if (kinds.includes('claim') && bound) {
      const state = await this.load(this.keyOf(bound));
      const needle = request.query.toLowerCase();
      for (const claim of state.claims) {
        if (!claim.statement.toLowerCase().includes(needle)) continue;
        items.push({
          kind: 'claim', reference: contentRef(claim.id, 1, claim), summary: claim.statement, applicability: claim.standing === 'supported' && fresh ? 'current' : 'unknown',
          sources: claim.supports.length ? claim.supports : [contentRef(claim.id, 1, claim)],
          reasons: [`Knowledge standing: ${claim.standing}.`, 'Matches the requested statement.'],
        });
      }
    }

    if (kinds.includes('artifact') && bound) {
      const state = await this.load(this.keyOf(bound));
      for (const row of state.artifacts) {
        if (row.stagedBlobId || request.workId && row.workId !== request.workId || !row.content?.toLowerCase().includes(request.query.toLowerCase())) continue;
        const reference = contentRef(row.id, 1, row);
        items.push({ kind: 'artifact', reference, summary: row.content.slice(0, 4096), applicability: 'current', sources: [reference],
          reasons: ['Matches published artifact content.'], readPath: join(scopeStore(this.prjctRoot, this.keyOf(state), 'artifacts'), row.id, 'content.txt') });
      }
    }

    if (kinds.includes('source')) {
      if (!stored) gaps.push('No applied source index. Run /prjct sync.');
      else {
        if (!fresh) gaps.push('Working tree changed since the last /prjct sync.');
        const lexicalHits: Array<{ path: string; score: number; symbol?: string }> = scoreLexical(request.query, stored.lexical)
          .map(hit => {
            const declared = (stored.symbols[hit.path] ?? []).find(name => symbolMatchesQuery(name, request.query));
            return declared ? { ...hit, score: hit.score * 2, symbol: declared } : { ...hit };
          })
          .sort((left, right) => right.score - left.score);
        // Graph retrieval: top lexical seeds expand through imports and cochange
        // with decayed scores. Reasons disclose which signal surfaced each file.
        const reverse = reverseImports(stored.imports);
        const scores = new Map<string, { score: number; symbol?: string; via?: string }>();
        for (const hit of lexicalHits) {
          const entry: { score: number; symbol?: string } = { score: hit.score };
          if (hit.symbol !== undefined) entry.symbol = hit.symbol;
          scores.set(hit.path, entry);
        }
        for (const seed of lexicalHits.slice(0, 10)) {
          for (const neighbor of [...(stored.imports.forward[seed.path] ?? []), ...(reverse[seed.path] ?? [])]) {
            const current = scores.get(neighbor);
            const candidate = seed.score * 0.5;
            if (!current || current.score < candidate) scores.set(neighbor, { score: candidate, via: `imports ${seed.path}` });
          }
          for (const neighbor of stored.cochange[seed.path] ?? []) {
            const current = scores.get(neighbor);
            const candidate = seed.score * 0.3;
            if (!current || current.score < candidate) scores.set(neighbor, { score: candidate, via: `cochanges with ${seed.path}` });
          }
        }
        const hits = [...scores.entries()].map(([path, entry]) => ({ path, ...entry }))
          .sort((left, right) => right.score - left.score);
        const hitIds = new Set(hits.slice(0, request.maxItems).map(hit => sourceId(hit.path)));
        // Outlines let the agent answer from signatures instead of reading whole files;
        // only the top hits carry one, and short, so search stays cheaper than a read.
        const outlines: Record<string, string> = Object.create(null);
        for (const file of await (await this.sources()).read(hits.slice(0, Math.min(3, request.maxItems)).map(hit => hit.path))) {
          const outline = outlineOf(file.content, 8, 480);
          if (outline) outlines[file.relativePath] = outline;
        }
        for (const hit of hits) {
          const contentHash = stored.hashes[hit.path];
          if (!contentHash) continue;
          const reference = { id: sourceId(hit.path), revision: stored.appliedRevision, contentHash };
          const reasons = hit.via ? [`Graph neighbor: ${hit.via}.`] : ['BM25 lexical match on the applied index.'];
          if (hit.symbol) reasons.push(`Declares symbol ${hit.symbol}.`);
          items.push({
            kind: 'source', reference, summary: hit.path, applicability: fresh ? 'current' : 'stale',
            ...(outlines[hit.path] ? { outline: outlines[hit.path]! } : {}),
            sources: [reference], reasons, readPath: hit.path,
          });
        }
        // Guard: claims already linked to a matched source surface next to the file.
        if (hitIds.size && bound) {
          const state = await this.load(this.keyOf(bound));
          for (const claim of state.claims) {
            if (items.some(item => item.kind === 'claim' && item.reference.id === claim.id)) continue;
            if (!claim.supports.some(support => hitIds.has(support.id))) continue;
            items.push({
              kind: 'claim', reference: contentRef(claim.id, 1, claim), summary: claim.statement, applicability: claim.standing === 'supported' && fresh ? 'current' : 'unknown',
              sources: claim.supports.length ? claim.supports : [contentRef(claim.id, 1, claim)],
              reasons: [`Knowledge standing: ${claim.standing}.`, 'Linked to a matched source file.'],
            });
          }
        }
      }
    }

    // Snapshot-bound pagination over the full candidate list.
    let pageItems = items;
    let next: { snapshot: Ref; afterId: string } | undefined;
    const knowledgeState = bound ? await this.load(this.keyOf(bound)) : undefined;
    const queryHash = sha256(JSON.stringify({ query: request.query, kinds, workId: request.workId ?? null, claims: knowledgeState?.claims, artifacts: knowledgeState?.artifacts }));
    const snapshot: Ref | undefined = stored
      ? { id: `search_${request.checkoutId}_${queryHash.slice(0, 16)}`, revision: stored.appliedRevision, contentHash: stored.manifestHash }
      : knowledgeState ? contentRef(`search_${request.checkoutId}_${queryHash.slice(0, 16)}`, knowledgeState.revision, { claims: knowledgeState.claims, artifacts: knowledgeState.artifacts }) : undefined;
    const cursor = (params as { cursor?: { snapshot: Ref; afterId: string } }).cursor;
    if (cursor) {
      if (!snapshot || cursor.snapshot.id !== snapshot.id || cursor.snapshot.revision !== snapshot.revision ||
        cursor.snapshot.contentHash !== snapshot.contentHash) {
        fail('STALE_CURSOR', 'The index changed since the cursor was issued; restart the search.');
      }
      const at = items.findIndex(item => item.reference.id === cursor.afterId);
      if (at < 0) fail('STALE_CURSOR', 'The cursor row is no longer in this result snapshot.');
      pageItems = items.slice(at + 1);
    }
    if (pageItems.length > request.maxItems) {
      const page = pageItems.slice(0, request.maxItems);
      next = { snapshot: snapshot!, afterId: page[page.length - 1]!.reference.id };
      pageItems = page;
    }

    const status = pageItems.length === 0 ? 'abstained' as const
      : pageItems.some(item => item.applicability !== 'current') ? 'partial' as const
      : 'ok' as const;
    if (status !== 'ok' && gaps.length === 0) gaps.push('No attributable hits. Use native grep/find/read.');
    const result = {
      status, checkoutId: request.checkoutId, ...(request.workId ? { workId: request.workId } : {}),
      ...(stored ? { observedRevision: stored.appliedRevision, configRevision: stored.configRevision } : {}),
      items: pageItems, gaps, ...(next ? { next } : {}),
    };
    while (pageItems.length && Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) {
      pageItems.pop();
      if (pageItems.length && snapshot) result.next = { snapshot, afterId: pageItems[pageItems.length - 1]!.reference.id };
      else delete result.next;
    }
    if (!pageItems.length && items.length) fail('OUTPUT_LIMIT', 'Budget cannot fit one attributable search result. Increase maxBytes.');
    validateSearchResult(request, result);
    return jsonResult(result);
  }

  private async structure(params: Record<string, unknown>) {
    const request = params as { action: 'neighbors' | 'impact'; checkoutId: string; seeds: string[]; relations: string[];
      maxDepth: number; maxItems: number; maxBytes: number };
    const ids = await this.previewIds();
    if (request.checkoutId !== ids.checkoutId) fail('CHECKOUT_MISMATCH', `This checkout is ${ids.checkoutId}; structure named ${request.checkoutId}. Use the id from prjct_context discover.`);
    const bound = await this.peekBinding();
    const stored = bound ? await this.loadIndex(this.keyOf(bound)) : undefined;
    if (!stored) {
      const result = { action: request.action, status: 'partial' as const, checkoutId: request.checkoutId, freshness: 'unknown' as const,
        certainty: 'advisory' as const, edges: [], gaps: ['No applied import graph. Run /prjct sync.'] };
      validateStructureResult(request, result);
      return jsonResult(result);
    }
    const current = await this.currentSources();
    const fresh = stored.manifestHash === current.manifestHash && stored.configRevision === INDEX_CONFIG_REVISION;
    const byId = new Map(Object.keys(stored.hashes).map(path => [sourceId(path), path]));
    // Impact without seeds derives them from the working-tree diff.
    const diff = diffHashes(stored.hashes, current.hashes);
    const derived = request.action === 'impact' && request.seeds.length === 0;
    const seedPaths = derived
      ? [...diff.added, ...diff.modified, ...diff.deleted]
      : request.seeds.map(seed => byId.get(seed)).filter((path): path is string => Boolean(path));
    const gaps: string[] = [];
    if (derived && seedPaths.length === 0 && diff.deleted.length === 0) gaps.push('No working-tree changes since the last sync.');
    if (derived && diff.deleted.length) gaps.push(`Deleted since last sync: ${diff.deleted.join(', ')}.`);
    if (!derived && seedPaths.length !== request.seeds.length) gaps.push('One or more seeds are not in the applied index; use source ids from prjct_search.');
    const unsupported = request.relations.filter(relation => !['imports', 'cochange'].includes(relation));
    if (unsupported.length) gaps.push(`Only imports and cochange are applied; ${unsupported.join(', ')} unavailable.`);
    const edges: Array<{ id: string; from: string; to: string; relation: 'imports' | 'cochange'; basis: 'extracted' | 'cochange'; distance: number; sources: Ref[] }> = [];
    const nodePaths = new Set(seedPaths);
    const seen = new Set<string>();
    if (request.relations.includes('imports')) {
      const reverse = reverseImports(stored.imports);
      const queue = seedPaths.map(path => ({ path, depth: 0 }));
      const visited = new Set(seedPaths);
      while (queue.length && edges.length < request.maxItems) {
        const current = queue.shift()!;
        if (current.depth >= request.maxDepth) continue;
        const nexts = [...(stored.imports.forward[current.path] ?? []), ...(reverse[current.path] ?? [])];
        for (const next of nexts) {
          if (edges.length >= request.maxItems) break;
          const forward = (stored.imports.forward[current.path] ?? []).includes(next);
          const fromPath = forward ? current.path : next;
          const toPath = forward ? next : current.path;
          const key = `${fromPath}->${toPath}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const distance = current.depth + 1;
          if (distance > request.maxDepth) continue;
          const fromHash = stored.hashes[fromPath];
          const toHash = stored.hashes[toPath];
          if (!fromHash || !toHash) continue;
          const fromId = sourceId(fromPath);
          const toId = sourceId(toPath);
          edges.push({
            id: `e_${sha256(key).slice(0, 12)}`, from: fromId, to: toId, relation: 'imports', basis: 'extracted', distance,
            sources: [
              { id: fromId, revision: stored.appliedRevision, contentHash: fromHash },
              { id: toId, revision: stored.appliedRevision, contentHash: toHash },
            ],
          });
          nodePaths.add(next);
          if (!visited.has(next)) {
            visited.add(next);
            queue.push({ path: next, depth: distance });
          }
        }
      }
    }
    if (request.relations.includes('cochange')) {
      for (const seed of seedPaths) {
        for (const next of stored.cochange[seed] ?? []) {
          if (edges.length >= request.maxItems) break;
          const key = `co:${seed}->${next}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const fromHash = stored.hashes[seed];
          const toHash = stored.hashes[next];
          if (!fromHash || !toHash) continue;
          const fromId = sourceId(seed);
          const toId = sourceId(next);
          edges.push({
            id: `e_${sha256(key).slice(0, 12)}`, from: fromId, to: toId, relation: 'cochange', basis: 'cochange', distance: 1,
            sources: [
              { id: fromId, revision: stored.appliedRevision, contentHash: fromHash },
              { id: toId, revision: stored.appliedRevision, contentHash: toHash },
            ],
          });
          nodePaths.add(next);
        }
      }
    }
    const nodes = [...nodePaths].map(path => ({ id: sourceId(path), path }));
    const freshness = fresh ? 'current' as const : 'stale' as const;
    const status = !fresh || gaps.length ? 'partial' as const : edges.length ? 'ok' as const : 'partial' as const;
    if (status !== 'ok' && gaps.length === 0) gaps.push('No extracted import edges for these seeds.');
    const result = {
      action: request.action, status, checkoutId: request.checkoutId,
      observedRevision: stored.appliedRevision, configRevision: stored.configRevision,
      freshness, certainty: 'advisory' as const, edges, nodes, gaps,
    };
    while (edges.length && Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) edges.pop();
    validateStructureResult(request, result);
    return jsonResult(result);
  }

  private async refresh(params: Record<string, unknown>, signal?: AbortSignal) {
    const ids = await this.previewIds();
    if (String(params.checkoutId) !== ids.checkoutId) fail('CHECKOUT_MISMATCH', `This checkout is ${ids.checkoutId}; refresh named ${String(params.checkoutId)}. Use the id from prjct_context discover.`);
    const current = await this.currentSources();
    const bound = await this.peekBinding();
    const stored = bound ? await this.loadIndex(this.keyOf(bound)) : undefined;
    const legacy = bound && !stored ? await readRecord(this.representationPartPath(this.keyOf(bound), 'manifest')) : undefined;
    const rebuilt = !stored || stored.manifestHash !== current.manifestHash || stored.configRevision !== INDEX_CONFIG_REVISION;
    const revision = rebuilt ? (stored?.appliedRevision ?? (legacy?.payload as { appliedRevision?: number } | undefined)?.appliedRevision ?? 0) + 1 : stored!.appliedRevision;
    const observed = { checkoutId: ids.checkoutId, revision, configRevision: INDEX_CONFIG_REVISION };
    const required = ['lexical', 'imports', 'symbols', 'cochange'];
    if (params.action === 'apply') {
      assertRefreshPreconditions({
        action: 'apply', checkoutId: String(params.checkoutId), operationId: String(params.operationId),
        expectedRevision: Number(params.expectedRevision), expectedConfigRevision: Number(params.expectedConfigRevision),
      }, observed);
      // Build the deterministic receipt before any binding/index/state publication.
      // A too-small budget must not leave an applied refresh behind an error.
      const result = { action: 'apply', status: 'ok', scope: { checkoutId: ids.checkoutId }, gaps: [],
        freshness: 'current', observedRevision: observed.revision, configRevision: INDEX_CONFIG_REVISION,
        currentComponents: required, pendingComponents: [], lastAttemptFailures: [], nextAction: 'Index freshness is not project understanding.' };
      validateStateResult('prjct_refresh', { action: 'apply', checkoutId: ids.checkoutId, maxBytes: Number(params.maxBytes) }, result);
      if (!bound) return fail('UNAVAILABLE', 'No bound project. Run /prjct init first.');
      const state = await this.load(this.keyOf(bound));
      const collected: CollectedSources | undefined = rebuilt ? await (await this.sources()).collectAll() : undefined;
      const next = collected ? await buildProjectIndex(collected, { checkoutId: state.checkoutId, appliedRevision: revision }, this.cwd) : stored!;
      if (rebuilt) await this.writeIndex(this.keyOf(state), next, signal);
      const after = collected ? this.currentOf(collected.hashes, collected.manifestHash) : current;
      const components = required.map(id => ({ id, appliedRevision: next.appliedRevision, appliedConfigRevision: INDEX_CONFIG_REVISION, lastAttempt: 'succeeded' as const }));
      await this.save({ ...state, claims: state.claims.map(claim => claim.standing === 'supported' && claim.supports.some(support => this.staleSupport(support, after)) ? { ...claim, standing: 'needs_review' as const, nextAction: 'Sources changed; inspect before reconfirming.' } : claim),
        refresh: { revision: next.appliedRevision, configRevision: INDEX_CONFIG_REVISION, components } }, state.revision, String(params.operationId), signal);
      return jsonResult(result);
    }
    const components = stored && !rebuilt
      ? required.map(id => ({ id, checkoutId: ids.checkoutId, appliedRevision: stored.appliedRevision,
        appliedConfigRevision: INDEX_CONFIG_REVISION, lastAttempt: 'succeeded' as const }))
      : [];
    const view = describeRefresh(observed, required, components);
    const status = view.freshness === 'current' ? 'ok' : view.freshness === 'unavailable' ? 'unavailable' : 'partial';
    const result = { action: 'inspect', status, scope: { checkoutId: ids.checkoutId },
      gaps: view.pendingComponents.map(id => `${id} is not current.`),
      freshness: view.freshness, observedRevision: observed.revision, configRevision: INDEX_CONFIG_REVISION,
      currentComponents: view.currentComponents, pendingComponents: view.pendingComponents,
      lastAttemptFailures: view.lastAttemptFailures, nextAction: 'Index freshness is not project understanding.' };
    validateStateResult('prjct_refresh', { action: 'inspect', checkoutId: ids.checkoutId, maxBytes: Number(params.maxBytes) }, result);
    return jsonResult(result);
  }
}
