import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ProcessRuntime, type HostExecution } from './pi/process-runtime.ts';
import { createProcessTools, processToolNames } from './pi/register-tools.ts';
import { newId } from './workspace/ids.ts';
import { redactSecrets } from './knowledge/redact.ts';
import { digestToolResult } from './knowledge/digest.ts';
import { JobRunner, formatJobs, type RunnerEvent } from './jobs/runner.ts';
import { MECHANICAL_SERVICES, MODEL_SERVICES, SERVICE_ORDER, createServices } from './jobs/services.ts';

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

// Registers process tools and /prjct. Does not inject context or create a store at
// load. Durable process state lives in the global prjct home, never the client checkout.
export default function prjctExtension(pi: ExtensionAPI) {
  let attempt = newId('attempt');
  const runtimes = new Map<string, ProcessRuntime>();
  const runners = new Map<string, JobRunner>();
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

  // One runner per bound project (keyed by its queue file). UI feedback goes
  // through the context that started it; nothing enters the model's context.
  const runnerFor = async (owner: ProcessRuntime, ctx: Pick<ExtensionContext, 'hasUI' | 'ui' | 'model' | 'mode'>): Promise<JobRunner | undefined> => {
    const path = await owner.jobsPath();
    if (!path) return undefined;
    let runner = runners.get(path);
    if (runner) return runner;
    // Model services always use the session's model (provider/id), thinking low.
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const services = createServices(owner, { extensionPath, ...(model ? { model } : {}) });
    const status = (text: string | undefined) => { if (ctx.hasUI) ctx.ui.setStatus('prjct', text); };
    let lastProgress = 0;
    const onEvent = (event: RunnerEvent) => {
      if (event.type === 'started') {
        status(`prjct ${event.id}…`);
        if (headless(ctx)) report(ctx, `prjct ${event.id}…`, 'info');
      } else if (event.type === 'progress') {
        const nowMs = Date.now();
        if (nowMs - lastProgress > 200) { lastProgress = nowMs; status(`prjct ${event.id} ${event.done}/${event.total}`); }
      } else if (event.type === 'finished') {
        pi.appendEntry('prjct_job', { id: event.id, status: 'done', summary: event.summary, durationMs: event.durationMs });
        if (headless(ctx)) report(ctx, `prjct ${event.id} done (${(event.durationMs / 1000).toFixed(1)}s): ${event.summary}`, 'info');
        // A model brief is new knowledge the agent may want: one line, next turn, no interruption.
        if ((MODEL_SERVICES as readonly string[]).includes(event.id)) {
          void pi.sendMessage({ customType: 'prjct', content: `prjct: the ${event.id} brief is ready; prjct_context lookup "${event.id}" serves it.`, display: true }, { deliverAs: 'nextTurn' });
        }
      } else if (event.type === 'failed') {
        pi.appendEntry('prjct_job', { id: event.id, status: 'failed', error: event.error });
        report(ctx, `prjct ${event.id} failed: ${event.error}`, 'warning');
      } else if (event.type === 'idle') {
        status(undefined);
        if (event.ran > 0 && (ctx.hasUI || headless(ctx))) report(ctx, `prjct: ${event.ran} service(s) finished: ${event.ids.join(', ')}. /prjct status`, 'info');
      }
    };
    runner = new JobRunner({ path, services, onEvent });
    runners.set(path, runner);
    return runner;
  };
  const stopRunners = async () => {
    await Promise.allSettled([...runners.values()].map(runner => runner.stop()));
    runners.clear();
  };

  const commandHandler = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]['handler']>[1]) => {
    const sub = (args ?? '').trim();
    const [head = '', ...rest] = sub.split(/\s+/);
    const owner = runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt);
    const usage = 'Usage: /prjct | init | sync | status | run <service> | analyze | export <path> | work [title] | ship. init connects the project and queues the index, stack and history services; analyze runs the purpose and patterns services in a child Pi; export writes the briefs as one portable markdown file.';
    if (head === 'init' || head === 'sync') {
      const connected = head === 'init' ? await owner.connectProject(ctx.signal) : undefined;
      const runner = await runnerFor(owner, ctx);
      if (!runner) { report(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const queued = await owner.shareWalk(() => head === 'init' ? runner.enqueue([...MECHANICAL_SERVICES], 'init') : runner.enqueueStale('sync'));
      // A re-run never re-creates: it refreshes only the services whose inputs changed.
      const refreshing = head === 'sync' || connected?.alreadyBound;
      const tail = queued.length ? `${refreshing ? 'Refreshing out-of-date services' : 'Queued'}: ${queued.join(', ')}. /prjct status follows progress.` : 'All services are current.';
      const initialization = connected ? `${connected.alreadyBound ? 'Project already initialized.' : 'Project initialized.'} ${connected.text} ` : '';
      report(ctx, `${initialization}${tail}`, 'info');
      runner.start();
      // Headless hosts (print/JSON) have no later turn to observe progress: finish here.
      if (!ctx.hasUI) await runner.idle();
      return;
    }
    if (head === 'status') {
      const runner = await runnerFor(owner, ctx);
      if (!runner) { report(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const lines = [await owner.statusText(), 'Services:', ...formatJobs(await runner.read(), SERVICE_ORDER), await owner.understandingText()];
      report(ctx, lines.join('\n'), 'info');
      return;
    }
    if (head === 'run') {
      const id = rest[0] ?? '';
      if (!(SERVICE_ORDER as readonly string[]).includes(id)) { report(ctx, `Unknown service "${id}". Services: ${SERVICE_ORDER.join(', ')}.`, 'error'); return; }
      const runner = await runnerFor(owner, ctx);
      if (!runner) { report(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const queued = await owner.shareWalk(() => runner.enqueue([id], 'run', { force: true }));
      report(ctx, queued.length ? `Queued: ${queued.join(', ')}.` : `${id} is already queued or running.`, 'info');
      runner.start();
      if (!ctx.hasUI) await runner.idle();
      return;
    }
    if (head === 'analyze') {
      const runner = await runnerFor(owner, ctx);
      if (!runner) { report(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      const queued = await owner.shareWalk(() => runner.enqueue([...MODEL_SERVICES], 'analyze', { force: true }));
      report(ctx, queued.length ? `Queued: ${queued.join(', ')} (child Pi, ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'default model'}, thinking low). /prjct status follows progress.` : 'Analysis services are already queued or running.', 'info');
      runner.start();
      if (!ctx.hasUI) await runner.idle();
      return;
    }
    if (head === 'export') {
      const target = rest[0];
      if (!target) { report(ctx, 'Usage: /prjct export <path> [--force]. Writes the purpose, stack, patterns and history briefs as one markdown file (for AGENTS.md-style consumers).', 'error'); return; }
      const exported = await owner.exportBriefs();
      if (!exported) { report(ctx, 'No bound project. Run /prjct init first.', 'error'); return; }
      if (!exported.included.length) { report(ctx, 'Nothing to export yet: run /prjct init (stack, history) and /prjct analyze (purpose, patterns) first.', 'error'); return; }
      const destination = resolve(ctx.cwd, target);
      const { writeFile, stat } = await import('node:fs/promises');
      const exists = await stat(destination).then(() => true, () => false);
      if (exists && !rest.includes('--force')) { report(ctx, `${destination} exists; add --force to overwrite.`, 'error'); return; }
      await writeFile(destination, exported.text, 'utf8');
      report(ctx, `Exported ${exported.included.join(', ')} to ${destination} (${Buffer.byteLength(exported.text, 'utf8')} bytes).`, 'info');
      return;
    }
    if (head === 'work') {
      const title = sub.slice('work'.length).trim();
      report(ctx, title ? await owner.createWork(title) : await owner.listWorksText(), 'info');
      return;
    }
    if (head === 'ship') {
      report(ctx, await owner.ship(), 'info');
      return;
    }
    if (!sub) report(ctx, await owner.statusText(), 'info');
    else report(ctx, usage, 'error');
  };
  pi.registerCommand('prjct', {
    description: 'init (connect + background index/stack/history) | sync | status | run <service> | analyze (purpose + patterns in a child Pi) | export <path> | work [title] | ship.',
    handler: commandHandler,
  });

  pi.on('session_start', async (_event, ctx) => {
    await stopRunners();
    attempt = newId('attempt');
    runtimes.clear(); executions.clear();
    const active = pi.getActiveTools();
    const prjctActive = active.filter(name => processToolNames.includes(name));
    const others = active.filter(name => !processToolNames.includes(name));
    const allOn = prjctActive.length === 0 || processToolNames.every(name => prjctActive.includes(name));
    const next = allOn ? [...others, 'prjct_context'] : [...others, ...prjctActive];
    if (!next.includes('prjct_context')) next.push('prjct_context');
    pi.setActiveTools(next);
    // Resume work a previous session left queued or interrupted; never start new work here.
    if (isChildJob()) return;
    try {
      const owner = runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt);
      // Live source watcher: hooks and lookups re-stat only what changed.
      await owner.watchSources().catch(() => false);
      const runner = await runnerFor(owner, ctx);
      if (!runner) return;
      await runner.resume();
      const file = await runner.read();
      if (Object.values(file.jobs).some(row => row.status === 'queued')) runner.start();
    } catch { /* Unbound or unreadable project: nothing to resume. */ }
  });

  // Real user input is native evidence for human-in-the-loop methods (grilling
  // decisions, takeover consent). Commands and extension-injected messages are not.
  pi.on('input', async (event, ctx) => {
    if (event.source !== 'interactive') return { action: 'continue' as const };
    const text = event.text.trim();
    if (!text || text.startsWith('/')) return { action: 'continue' as const };
    const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
    try {
      await owner.recordObservation(`user_input: ${redactSecrets(text.slice(0, 1800))}`, {
        toolCallId: `input_${Date.now()}`, toolName: 'user_input', outcome: 'succeeded',
      });
    } catch { /* Uninitialized projects do not record. */ }
    return { action: 'continue' as const };
  });
  // While the agent is idle a full walk is free: it corrects anything the watcher missed.
  pi.on('agent_settled', (_event, ctx) => {
    if (isChildJob()) return;
    const owner = runtimes.get(`${ctx.sessionManager?.getSessionId() ?? attempt}:${ctx.cwd}`);
    void owner?.revalidateSources().catch(() => undefined);
  });
  pi.on('session_shutdown', async () => {
    for (const owner of runtimes.values()) owner.unwatchSources();
    await stopRunners();
    await Promise.allSettled([...runtimes.values()].map(owner => owner.flush()));
    runtimes.clear(); executions.clear();
  });
  // Capture native input and the pre-execution source snapshot. Pi still owns all execution.
  pi.on('tool_execution_start', async (event, ctx) => {
    if (!['bash', 'read'].includes(event.toolName)) return;
    const owner = runtime(ctx.cwd, ctx.sessionManager.getSessionId());
    const args = event.args as { command?: string; path?: string };
    const captured: HostExecution = { toolCallId: event.toolCallId, toolName: event.toolName, outcome: 'unknown',
      ...(args.command ? { command: args.command } : {}),
      ...(args.path ? { sourcePaths: [relative(ctx.cwd, resolve(ctx.cwd, args.path)).replaceAll('\\', '/')] } : {}) };
    try { captured.beforeHash = await owner.sourceSnapshot(); } catch { /* End capture stays unknown. */ }
    executions.set(event.toolCallId, { owner, captured });
  });
  pi.on('tool_execution_end', async (event, ctx) => {
    const entry = executions.get(event.toolCallId);
    if (!entry) return;
    executions.delete(event.toolCallId);
    try {
      // Digest, never echo: the agent already holds the tool output; evidence needs its shape.
      const digest = digestToolResult(event.toolName, event.result as Parameters<typeof digestToolResult>[1],
        { ...(entry.captured.sourcePaths?.[0] ? { path: entry.captured.sourcePaths[0] } : {}), ...(entry.captured.command ? { command: entry.captured.command } : {}) });
      const text = redactSecrets(digest.text);
      await entry.owner.recordObservation(`${event.toolName} ${event.isError ? 'failed' : 'completed'}: ${text}`, {
        ...entry.captured, outcome: ctx.signal?.aborted || !entry.captured.beforeHash ? 'unknown' : event.isError ? 'failed' : 'succeeded',
      });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`prjct could not retain evidence: ${(error as Error).message}`, 'warning');
      else console.error(`prjct evidence unavailable: ${(error as Error).message}`);
    }
  });
}
