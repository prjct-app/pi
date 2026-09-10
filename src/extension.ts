import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isToolCallEventType, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AGENT_OUTPUT_INSTRUCTION } from './agent-output.ts';
import { ProcessRuntime, type HostExecution } from './pi/process-runtime.ts';
import { createProcessTools, processToolNames } from './pi/register-tools.ts';
import { newId } from './workspace/ids.ts';
import { redactSecrets } from './knowledge/redact.ts';
import { digestToolResult } from './knowledge/digest.ts';
import { JobRunner, formatJobs, type RunnerEvent } from './jobs/runner.ts';
import { MECHANICAL_SERVICES, MODEL_SERVICES, SERVICE_ORDER, createServices } from './jobs/services.ts';
import { canonicalMutationPath } from './work/native-mutation-policy.ts';
import { LifecycleContinuity } from './work/lifecycle-continuity.ts';
import type { BindingPointer } from './work/session-binding.ts';

const agentHome = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
// This file is the extension entry; child Pi processes load it explicitly.
const extensionPath = fileURLToPath(import.meta.url);
// Inside a child job the extension must not schedule further jobs.
const isChildJob = (): boolean => Boolean(process.env.PRJCT_JOB);

// Headless hosts (print/JSON) give extensions a no-op UI. Command and job
// feedback still reaches the user on stderr, keeping stdout clean for print
// output and JSON event consumers.
const headless = (ctx: { mode?: string }): boolean => ctx.mode === 'print' || ctx.mode === 'json';
const report = (ctx: { mode?: string; ui: { notify: (text: string, type: 'info' | 'warning' | 'error') => void } }, text: string, type: 'info' | 'warning' | 'error'): void => {
  if (headless(ctx)) console.error(text);
  else ctx.ui.notify(text, type);
};

// Subcommands offered to the TUI when completing `/prjct <args>`. Keep in sync
// with commandHandler below.
const SUBCOMMANDS = ['init', 'sync', 'status', 'run', 'analyze', 'export', 'work', 'ship'] as const;

// Registers process tools and /prjct. Does not inject context or create a store at
// load. Durable process state lives in the global prjct home, never the client checkout.
export default function prjctExtension(pi: ExtensionAPI) {
  let attempt = newId('attempt');
  const continuity = new LifecycleContinuity();
  let lastPointer = '';
  const runtimes = new Map<string, ProcessRuntime>();
  // The runner persists per project, but its model selection follows the
  // current session. Services snapshot it only when each model job starts.
  const runners = new Map<string, { runner: JobRunner; selection: { model: string | undefined } }>();
  const runtime = (cwd: string, sessionId = attempt) => {
    const key = `${sessionId}:${cwd}`;
    let owner = runtimes.get(key);
    if (!owner) { owner = new ProcessRuntime({ agentHome: agentHome(), cwd, attemptId: attempt, sessionId }); runtimes.set(key, owner); }
    return owner;
  };
  const executions = new Map<string, { owner: ProcessRuntime; captured: HostExecution }>();
  const activate = (names: string[]) => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  };
  for (const tool of createProcessTools(agentHome, activate, () => attempt, runtime)) pi.registerTool(tool);

  // TUI action results become concise operational receipts for the agent.
  // Headless modes stay plain stderr; no model turn is triggered there.
  const tellModel = (ctx: { hasUI: boolean; mode?: string }, text: string): void => {
    if (!ctx.hasUI || headless(ctx)) return;
    pi.sendMessage({ customType: 'prjct', display: false,
      content: `A prjct action produced this result. ${AGENT_OUTPUT_INSTRUCTION} Return one short operational receipt containing the outcome, material facts, and next executable step. Reply with only that receipt; call no tools.\n${text}` },
      { deliverAs: 'followUp', triggerTurn: true });
  };
  // Every command outcome gets a response; the TUI also gets the model summary.
  const respond = (ctx: { hasUI: boolean; mode?: string; ui: { notify: (text: string, type: 'info' | 'warning' | 'error') => void } },
    text: string, type: 'info' | 'warning' | 'error'): void => {
    report(ctx, text, type);
    tellModel(ctx, text);
  };

  // One runner per bound project (keyed by its queue file). UI feedback goes
  // through the context that started it; nothing enters the model's context.
  const runnerFor = async (owner: ProcessRuntime, ctx: Pick<ExtensionContext, 'hasUI' | 'ui' | 'model' | 'mode'>): Promise<JobRunner | undefined> => {
    const path = await owner.jobsPath();
    if (!path) return undefined;
    // Model services always use the session's current model (provider/id),
    // including after the user switches model while this runner is cached.
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const existing = runners.get(path);
    if (existing) {
      existing.selection.model = model;
      return existing.runner;
    }
    const selection: { model: string | undefined } = { model };
    const services = createServices(owner, { extensionPath, selectModel: () => selection.model });
    const status = (text: string | undefined) => { if (ctx.hasUI) ctx.ui.setStatus('prjct', text); };
    let lastProgress = 0;
    const lastRun = new Map<string, { summary: string; durationMs: number }>();
    const onEvent = (event: RunnerEvent) => {
      if (event.type === 'started') {
        status(`prjct ${event.id}…`);
        if (headless(ctx)) report(ctx, `prjct ${event.id}…`, 'info');
      } else if (event.type === 'progress') {
        const nowMs = Date.now();
        if (nowMs - lastProgress > 200) { lastProgress = nowMs; status(`prjct ${event.id} ${event.done}/${event.total}`); }
      } else if (event.type === 'finished') {
        lastRun.set(event.id, { summary: event.summary, durationMs: event.durationMs });
        pi.appendEntry('prjct_job', { id: event.id, status: 'done', summary: event.summary, durationMs: event.durationMs });
        if (headless(ctx)) report(ctx, `prjct ${event.id} done (${(event.durationMs / 1000).toFixed(1)}s): ${event.summary}`, 'info');
        // A model brief is new knowledge the agent may want: one line, next turn, no interruption.
        if ((MODEL_SERVICES as readonly string[]).includes(event.id)) {
          void pi.sendMessage({ customType: 'prjct', content: `prjct: the ${event.id} brief is ready; prjct_context lookup "${event.id}" serves it.`, display: true }, { deliverAs: 'nextTurn' });
        }
      } else if (event.type === 'failed') {
        pi.appendEntry('prjct_job', { id: event.id, status: 'failed', error: event.error });
        respond(ctx, `prjct ${event.id} failed: ${event.error}`, 'warning');
      } else if (event.type === 'idle') {
        status(undefined);
        if (event.ran > 0 && (ctx.hasUI || headless(ctx))) report(ctx, `prjct: ${event.ran} service(s) finished: ${event.ids.join(', ')}. /prjct status`, 'info');
        if (event.ran > 0) {
          const details = event.ids.map(id => {
            const row = lastRun.get(id);
            return row ? `${id} (${(row.durationMs / 1000).toFixed(1)}s): ${row.summary}` : id;
          }).join('\n');
          lastRun.clear();
          tellModel(ctx, `prjct services finished:\n${details}`);
        }
      }
    };
    const runner = new JobRunner({ path, services, onEvent });
    runners.set(path, { runner, selection });
    return runner;
  };
  const stopRunners = async () => {
    await Promise.allSettled([...runners.values()].map(slot => slot.runner.stop()));
    runners.clear();
  };

  const restorePointer = async (ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>): Promise<void> => {
    const branchId = ctx.sessionManager.getSessionId();
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(row => row.type === 'custom' && row.customType === 'prjct_binding');
    const pointer = entry?.type === 'custom' ? entry.data as BindingPointer | undefined : undefined;
    if (!pointer) return;
    await runtime(ctx.cwd, branchId).restoreSessionPointer(branchId, pointer).catch(() => undefined);
  };
  const persistPointer = async (ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>): Promise<void> => {
    const branchId = ctx.sessionManager.getSessionId();
    const pointer = await runtime(ctx.cwd, branchId).sessionPointer(branchId).catch(() => undefined);
    if (!pointer) return;
    const serialized = JSON.stringify(pointer);
    if (serialized === lastPointer) return;
    lastPointer = serialized;
    // Custom entries are durable branch pointers and never enter model context.
    pi.appendEntry('prjct_binding', pointer);
  };

  const commandHandler = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]['handler']>[1]) => {
    const sub = (args ?? '').trim();
    const [head = '', ...rest] = sub.split(/\s+/);
    const owner = runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt);
    const usage = 'Usage: /prjct | init | sync | status | run <service> | analyze | export <path> | work [title] | ship. init connects the project and queues the index, stack and history services; analyze runs the purpose and patterns services in a child Pi; export writes the briefs as one portable markdown file.';
    if (head === 'init' || head === 'sync') {
      const connected = head === 'init' ? await owner.connectProject(ctx.signal) : undefined;
      const runner = await runnerFor(owner, ctx);
      if (!runner) { respond(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const queued = await owner.shareWalk(() => head === 'init' ? runner.enqueue([...MECHANICAL_SERVICES], 'init') : runner.enqueueStale('sync'));
      // A re-run never re-creates: it refreshes only the services whose inputs changed.
      const refreshing = head === 'sync' || connected?.alreadyBound;
      const tail = queued.length ? `${refreshing ? 'Refreshing out-of-date services' : 'Queued'}: ${queued.join(', ')}. /prjct status follows progress.` : 'All services are current.';
      const initialization = connected ? `${connected.alreadyBound ? 'Project already initialized.' : 'Project initialized.'} ${connected.text} ` : '';
      // Queued work is summarized by the runner's idle event; a no-op answers now.
      if (queued.length) report(ctx, `${initialization}${tail}`, 'info');
      else respond(ctx, `${initialization}${tail}`, 'info');
      runner.start();
      // Headless hosts (print/JSON) have no later turn to observe progress: finish here.
      if (!ctx.hasUI) await runner.idle();
      return;
    }
    if (head === 'status') {
      const runner = await runnerFor(owner, ctx);
      if (!runner) { respond(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const lines = [await owner.statusText(), 'Services:', ...formatJobs(await runner.read(), SERVICE_ORDER), await owner.understandingText()];
      respond(ctx, lines.join('\n'), 'info');
      return;
    }
    if (head === 'run') {
      const id = rest[0] ?? '';
      if (!(SERVICE_ORDER as readonly string[]).includes(id)) { respond(ctx, `Unknown service "${id}". Services: ${SERVICE_ORDER.join(', ')}.`, 'error'); return; }
      const runner = await runnerFor(owner, ctx);
      if (!runner) { respond(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const queued = await owner.shareWalk(() => runner.enqueue([id], 'run', { force: true }));
      if (queued.length) report(ctx, `Queued: ${queued.join(', ')}.`, 'info');
      else respond(ctx, `${id} is already queued or running.`, 'info');
      runner.start();
      if (!ctx.hasUI) await runner.idle();
      return;
    }
    if (head === 'analyze') {
      const runner = await runnerFor(owner, ctx);
      if (!runner) { respond(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const queued = await owner.shareWalk(() => runner.enqueue([...MODEL_SERVICES], 'analyze', { force: true }));
      if (queued.length) report(ctx, `Queued: ${queued.join(', ')} (child Pi, ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'default model'}, thinking low). /prjct status follows progress.`, 'info');
      else respond(ctx, 'Analysis services are already queued or running.', 'info');
      runner.start();
      if (!ctx.hasUI) await runner.idle();
      return;
    }
    if (head === 'export') {
      const target = rest[0];
      if (!target) { respond(ctx, 'Usage: /prjct export <path> [--force]. Writes the purpose, stack, patterns and history briefs as one markdown file (for AGENTS.md-style consumers).', 'error'); return; }
      const exported = await owner.exportBriefs();
      if (!exported) { respond(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      if (!exported.included.length) { respond(ctx, 'Nothing to export yet: run /prjct init (stack, history) and /prjct analyze (purpose, patterns) first.', 'error'); return; }
      let destination: string;
      try { destination = await canonicalMutationPath(ctx.cwd, target); }
      catch (error) { respond(ctx, `Export refused: ${(error as Error).message}`, 'error'); return; }
      const { writeFile, stat } = await import('node:fs/promises');
      const exists = await stat(destination).then(() => true, () => false);
      if (exists && !rest.includes('--force')) { respond(ctx, `${destination} exists; add --force to overwrite.`, 'error'); return; }
      if (!ctx.hasUI || headless(ctx) || !await ctx.ui.confirm('Authorize prjct export', `Write ${Buffer.byteLength(exported.text, 'utf8')} bytes to ${destination}?`)) {
        respond(ctx, 'Export refused: current host confirmation is required and headless execution fails closed.', 'error'); return;
      }
      await withFileMutationQueue(destination, () => writeFile(destination, exported.text, 'utf8'));
      respond(ctx, `Exported ${exported.included.join(', ')} to ${destination} (${Buffer.byteLength(exported.text, 'utf8')} bytes).`, 'info');
      return;
    }
    if (head === 'work') {
      const title = sub.slice('work'.length).trim();
      respond(ctx, title ? await owner.createWork(title) : await owner.listWorksText(), 'info');
      return;
    }
    if (head === 'ship') {
      respond(ctx, await owner.ship(), 'info');
      return;
    }
    if (!sub) respond(ctx, await owner.statusText(), 'info');
    else respond(ctx, usage, 'error');
  };
  pi.registerCommand('prjct', {
    description: 'init (connect + background index/stack/history) | sync | status | run <service> | analyze (purpose + patterns in a child Pi) | export <path> | work [title] | ship.',
    getArgumentCompletions(prefix) {
      const parts = prefix.split(/\s+/);
      let values: readonly string[] = [];
      if (parts.length === 1) values = SUBCOMMANDS;
      else if (parts.length === 2 && parts[0] === 'run') values = SERVICE_ORDER;
      const stem = parts.slice(0, -1).join(' ');
      const items = values
        .filter(value => value.startsWith(parts.at(-1) ?? ''))
        .map(value => ({ value: `${stem ? `${stem} ` : ''}${value}`, label: value }));
      return items.length ? items : null;
    },
    handler: commandHandler,
  });

  pi.on('session_start', async (event, ctx) => {
    await stopRunners();
    attempt = newId('attempt');
    lastPointer = '';
    continuity.mark(event.reason);
    runtimes.clear(); executions.clear();
    const active = pi.getActiveTools();
    const prjctActive = active.filter(name => processToolNames.includes(name));
    const others = active.filter(name => !processToolNames.includes(name));
    const allOn = prjctActive.length === 0 || processToolNames.every(name => prjctActive.includes(name));
    const next = allOn ? [...others, 'prjct_context'] : [...others, ...prjctActive];
    if (!next.includes('prjct_context')) next.push('prjct_context');
    pi.setActiveTools(next);
    if (isChildJob()) return;
    try {
      await restorePointer(ctx);
      const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
      await owner.watchSources().catch(() => false);
      const runner = await runnerFor(owner, ctx);
      if (!runner) return;
      await runner.resume();
      const file = await runner.read();
      if (Object.values(file.jobs).some(row => row.status === 'queued')) runner.start();
    } catch { /* Unbound or unreadable project: nothing to resume. */ }
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (isChildJob() || !continuity.isPending()) return;
    const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
    const summary = await owner.lifecycleSummary().catch(() => undefined);
    if (!summary) { continuity.consume(''); return; }
    const content = continuity.consume(summary);
    if (!content) return;
    return { message: { customType: 'prjct_reanchor', content, display: false } };
  });

  // Input is retained as conversation evidence only. Authority-sensitive state
  // changes use an exact, one-shot host confirmation inside their operation.
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'interactive') return { action: 'continue' as const };
    const text = event.text.trim();
    if (!text || text.startsWith('/')) return { action: 'continue' as const };
    const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
    try {
      await owner.recordObservation(`user_input: ${redactSecrets(text.slice(0, 1800))}`, {
        toolCallId: `input_${Date.now()}`, toolName: 'user_input', outcome: 'succeeded', coverage: 'exact',
      });
    } catch { /* Uninitialized projects do not record. */ }
    return { action: 'continue' as const };
  });

  pi.on('session_before_compact', async (_event, ctx) => {
    try { await runtime(ctx.cwd, ctx.sessionManager.getSessionId()).suspendAttempt(); }
    catch (error) {
      ctx.ui.notify(`prjct blocked compaction: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return { cancel: true };
    }
  });
  pi.on('session_compact', () => { continuity.mark('compact'); lastPointer = ''; });
  pi.on('session_before_tree', async (_event, ctx) => {
    try { await runtime(ctx.cwd, ctx.sessionManager.getSessionId()).suspendAttempt(); }
    catch (error) {
      ctx.ui.notify(`prjct blocked tree navigation: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return { cancel: true };
    }
  });
  pi.on('session_tree', async (_event, ctx) => {
    continuity.mark('tree'); lastPointer = '';
    await restorePointer(ctx);
  });

  // While the agent is idle, persist one branch-local context pointer and use a
  // full walk to correct anything the watcher missed.
  pi.on('agent_settled', async (_event, ctx) => {
    if (isChildJob()) return;
    await persistPointer(ctx);
    const owner = runtimes.get(`${ctx.sessionManager.getSessionId()}:${ctx.cwd}`);
    await owner?.revalidateSources().catch(() => undefined);
  });
  pi.on('session_shutdown', async () => {
    await Promise.allSettled([...runtimes.values()].map(owner => owner.suspendAttempt()));
    for (const owner of runtimes.values()) owner.unwatchSources();
    await stopRunners();
    await Promise.allSettled([...runtimes.values()].map(owner => owner.flush()));
    runtimes.clear(); executions.clear();
  });

  // Only Pi-mediated edit/write calls are intercepted. This is an authority
  // gate, not an OS sandbox; external processes and shell side effects remain
  // outside its control.
  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('edit', event) && !isToolCallEventType('write', event)) return;
    const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
    try {
      const decision = await owner.nativeMutationDecision(event.input.path);
      if (!decision.allowed) return { block: true, terminate: true, reason: `${decision.code}: ${decision.reason}` };
    } catch (error) {
      return { block: true, terminate: true, reason: `${(error as { code?: string }).code ?? 'MUTATION_DENIED'}: ${(error as Error).message}` };
    }
  });

  // Capture native input and a pre-execution source manifest. Bash coverage is
  // explicitly partial because the source cache is not a filesystem sandbox.
  pi.on('tool_execution_start', async (event, ctx) => {
    if (!['bash', 'read', 'edit', 'write'].includes(event.toolName)) return;
    const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
    const args = event.args as { command?: string; path?: string };
    const captured: HostExecution = { toolCallId: event.toolCallId, toolName: event.toolName, outcome: 'unknown',
      coverage: event.toolName === 'bash' ? 'partial' : 'exact',
      ...(args.command ? { command: args.command } : {}),
      ...(args.path ? { sourcePaths: [relative(ctx.cwd, resolve(ctx.cwd, args.path)).replaceAll('\\', '/')] } : {}) };
    try { captured.beforeHash = (await owner.sourceStamp()).manifestHash; } catch { captured.coverage = 'unknown'; }
    executions.set(event.toolCallId, { owner, captured });
  });
  pi.on('tool_execution_end', async (event, ctx) => {
    const entry = executions.get(event.toolCallId);
    if (!entry) return;
    executions.delete(event.toolCallId);
    try {
      const digest = digestToolResult(event.toolName, event.result as Parameters<typeof digestToolResult>[1],
        { ...(entry.captured.sourcePaths?.[0] ? { path: entry.captured.sourcePaths[0] } : {}), ...(entry.captured.command ? { command: entry.captured.command } : {}) });
      const text = redactSecrets(digest.text);
      let outcome: HostExecution['outcome'] = ctx.signal?.aborted || !entry.captured.beforeHash ? 'unknown' : event.isError ? 'failed' : 'succeeded';
      if (outcome === 'succeeded' && ['edit', 'write'].includes(event.toolName) && entry.captured.sourcePaths?.[0]) {
        const standing = await entry.owner.nativeMutationDecision(entry.captured.sourcePaths[0]);
        if (!standing.allowed) outcome = 'unknown';
      }
      await entry.owner.recordObservation(`${event.toolName} ${event.isError ? 'failed' : 'completed'}: ${text}`, {
        ...entry.captured, outcome,
      });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`prjct could not retain evidence: ${(error as Error).message}`, 'warning');
      else console.error(`prjct evidence unavailable: ${(error as Error).message}`);
    }
  });
}
