import type { ProcessRuntime } from '../pi/process-runtime.ts';
import { extractBrief, runModelJob } from './model-job.ts';
import type { Service } from './runner.ts';

// The service catalog of one bound project. Mechanical services run inside the
// host process (chunked, yielding); model services run in a child Pi with a
// clean context, read-only tools and a bounded protocol, using the session's
// model. Their briefs are served by prjct_context lookup, never injected.
export const MECHANICAL_SERVICES = ['index', 'stack', 'history'] as const;
export const MODEL_SERVICES = ['purpose', 'patterns'] as const;
export const SERVICE_ORDER = [...MECHANICAL_SERVICES, ...MODEL_SERVICES] as const;
export type ServiceId = typeof SERVICE_ORDER[number];

export type ModelServiceOptions = Readonly<{ extensionPath: string; model?: string; thinking?: string }>;

const MODEL_TOOLS = ['read', 'prjct_context', 'prjct_search', 'prjct_knowledge'];

export type AnalysisFacts = Readonly<{ projectId: string; checkoutId: string; docFiles: readonly string[]; entryPoints: readonly string[]; testCommand?: string }>;
type BriefSpec = Readonly<{ heading: string; maxBytes: number; prompt: (facts: AnalysisFacts) => string }>;

const factsLine = (facts: AnalysisFacts): string =>
  `Facts: projectId ${facts.projectId}; checkoutId ${facts.checkoutId} (use it verbatim in prjct_search). ` +
  `Documentation files present: ${facts.docFiles.length ? facts.docFiles.join(', ') : 'none'}. ` +
  `Entry points present: ${facts.entryPoints.length ? facts.entryPoints.join(', ') : 'none detected'}. ` +
  'Read only paths listed here or returned by prjct_search; never guess paths. ' +
  'Every prjct_context lookup and every committed mutation returns stateRevision; each resolve must use the most recent stateRevision you have seen (the previous resolve advances it) and a new operationId. ' +
  'Output control: prjct_search results carry an outline (declarations with line numbers); read a file in full only when its outline is not enough. ' +
  'Do not restate these instructions, do not summarize tool results back, keep reasoning to one line per step; your only prose is the final brief. ';

export const BRIEFS: Record<typeof MODEL_SERVICES[number], BriefSpec> = {
  purpose: {
    heading: 'Purpose', maxBytes: 2048,
    prompt: facts => 'prjct purpose service. ONE bounded pass; no bash, no grep. ' + factsLine(facts) +
      '1) prjct_context lookup once with query "stack history". ' +
      '2) Read natively at most 4 files: the documentation files listed above, else the entry points. ' +
      '3) prjct_knowledge propose at most 3 claims (purpose, architecture) with supports = src_ ids of files you read; then one prjct_context lookup with query = a path you read (it returns obs_ ids and stateRevision) and resolve/confirm each claim with those evidenceIds and that stateRevision. ' +
      '4) End your final message with ONLY a markdown brief that starts with "# Purpose" and is under 2000 bytes: what the project is for, who uses it, the main components (cite paths), and what remains unknown.',
  },
  patterns: {
    heading: 'Patterns', maxBytes: 4096,
    prompt: facts => 'prjct patterns service. ONE bounded pass; no bash, no grep. ' + factsLine(facts) +
      '1) prjct_context lookup once with query "stack purpose". ' +
      '2) prjct_search at most 4 queries (entry points, tests, error handling, configuration), then read natively at most 6 source files from the search results, preferring one representative test' + (facts.testCommand ? ` (the project verifies with \`${facts.testCommand}\`)` : '') + '. ' +
      '3) prjct_knowledge propose at most 4 claims (conventions, design, testing) with supports = src_ ids of files you read; then one prjct_context lookup with query = a path you read (it returns obs_ ids and stateRevision) and resolve/confirm each claim with those evidenceIds and that stateRevision. ' +
      '4) End your final message with ONLY a markdown brief that starts with "# Patterns" and is under 4000 bytes, with sections Conventions, Design, Testing, Pitfalls; every point cites a path. Do not write generic framework advice.',
  },
};

export const createServices = (runtime: ProcessRuntime, model?: ModelServiceOptions): Service[] => {
  const services: Service[] = [
    {
      id: 'index', kind: 'mechanical', dependsOn: [],
      stale: () => runtime.indexStale(),
      run: async ctx => {
        const result = await runtime.syncProject(ctx.signal, ctx.onProgress);
        return { summary: `${result.indexedFiles} files${result.rebuilt ? ' rebuilt' : ' current'}`, freshness: { manifestHash: result.manifestHash } };
      },
    },
    {
      id: 'stack', kind: 'mechanical', dependsOn: ['index'],
      stale: () => runtime.stackStale(),
      run: ctx => runtime.buildStackDoc(ctx.signal),
    },
    {
      id: 'history', kind: 'mechanical', dependsOn: [],
      stale: () => runtime.historyStale(),
      run: ctx => runtime.buildHistory(ctx.signal),
    },
  ];
  if (!model) return services;
  for (const id of MODEL_SERVICES) {
    const spec = BRIEFS[id];
    services.push({
      id, kind: 'model', dependsOn: ['index', 'stack'],
      // Briefs are re-synthesized only on request (/prjct analyze, /prjct run); sources
      // drifting mark them needs_review in lookup instead of spending a model pass.
      stale: async () => !(await runtime.readContextDoc(id)),
      run: async ctx => {
        const facts = await runtime.analysisFacts();
        const result = await runModelJob({
          cwd: runtime.cwd, extensionPath: model.extensionPath, prompt: spec.prompt(facts), tools: MODEL_TOOLS,
          ...(model.model ? { model: model.model } : {}), ...(model.thinking ? { thinking: model.thinking } : {}),
          env: { PRJCT_JOB: id, ...(runtime.prjctRoot ? { PRJCT_HOME: runtime.prjctRoot } : {}) },
          signal: ctx.signal, onTurn: (turns, toolCalls) => ctx.onProgress(toolCalls, Math.max(toolCalls, 12)),
          ...(await runtime.jobLogPath(id) ? { logPath: (await runtime.jobLogPath(id))! } : {}),
        });
        const brief = extractBrief(result.text, spec.heading, spec.maxBytes);
        if (!brief) {
          const log = await runtime.jobLogPath(id);
          throw new Error(`child pi exited ${result.exitCode} without a brief${result.errorMessage ? `: ${result.errorMessage}` : ''}${result.stderr.trim() ? ` (${result.stderr.trim().split('\n').at(-1)})` : ''}${log ? `; log ${log}` : ''}`);
        }
        const manifestHash = (await runtime.indexManifestHash()) ?? 'none';
        const freshness = { manifestHash, ...(model.model ? { model: model.model } : {}) };
        const written = await runtime.writeContextDoc(id, brief, freshness, ctx.signal);
        const cost = result.usage.cost ? `, $${result.usage.cost.toFixed(4)}` : '';
        return { summary: `${result.turns} turns, ${result.toolCalls} tool calls, ${written.bytes} bytes${cost}`, freshness };
      },
    });
  }
  return services;
};
