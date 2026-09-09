import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ProcessRuntime, type HostExecution } from './pi/process-runtime.ts';
import { createProcessTools, processToolNames } from './pi/register-tools.ts';
import { newId } from './workspace/ids.ts';
import { redactSecrets } from './knowledge/redact.ts';

const agentHome = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');

// Registers process tools and /prjct. Does not inject context or create a store at
// load. Durable process state lives in the global prjct home, never the client checkout.
export default function prjctExtension(pi: ExtensionAPI) {
  let attempt = newId('attempt');
  const runtimes = new Map<string, ProcessRuntime>();
  const runtime = (cwd: string, sessionId = attempt) => {
    const key = `${sessionId}:${cwd}`;
    let owner = runtimes.get(key);
    if (!owner) { owner = new ProcessRuntime({ agentHome: agentHome(), cwd, attemptId: attempt, sessionId }); runtimes.set(key, owner); }
    return owner;
  };
  let synthesisQueued = false;
  let settleSynthesis: (() => void) | undefined;
  const executions = new Map<string, { owner: ProcessRuntime; captured: HostExecution }>();
  const activate = (names: string[]) => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  };
  for (const tool of createProcessTools(agentHome, activate, () => attempt, runtime)) pi.registerTool(tool);

  const commandHandler = async (args: string, ctx: Parameters<Parameters<typeof pi.registerCommand>[1]['handler']>[1]) => {
      const sub = (args ?? '').trim();
      const head = sub.split(/\s+/)[0] ?? '';
      const runIndexAndSynthesize = async (run: (owner: ProcessRuntime, signal?: AbortSignal) => Promise<{ text: string; rebuilt: boolean }>) => {
        const owner = runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt);
        const startedAttempt = attempt;
        const result = await run(owner, ctx.signal);
        if (attempt !== startedAttempt || ctx.signal?.aborted) return;
        ctx.ui.notify(result.text, 'info');
        const pending = result.rebuilt || await owner.understandingPending();
        if (attempt !== startedAttempt || ctx.signal?.aborted) return;
        if (pending && !synthesisQueued) {
          synthesisQueued = true;
          const settled = ctx.hasUI ? undefined : new Promise<void>(resolve => { settleSynthesis = resolve; });
          // Pi is the motor: prjct collected mechanical facts; the session's model
          // generates the understanding and records it as evidenced claims.
          pi.sendUserMessage(
            'prjct needs project understanding. ONE pass, no repeated discovery: ' +
            '1) prjct_context discover (query: "knowledge search") once — it returns projectId and stateRevision. ' +
            '2) prjct_context lookup once for the mechanical profile and existing claims. ' +
            '3) read the 3-6 key files natively (README/CONTEXT/main entry points); each read becomes an obs_ observation visible in a later lookup. ' +
            '4) prjct_knowledge propose each claim (purpose, architecture, conventions) with supports = src_ ids from search or reads — propose needs no expectedRevision. ' +
            '5) one more prjct_context lookup (query by a file you read) to get obs_ ids, then prjct_knowledge resolve/confirm each claim with evidenceIds = those obs_ ids and expectedRevision = the stateRevision from each mutation result you just received (every committed mutation returns stateRevision — use it, do not re-discover). ' +
            'Do not write generic framework advice; every claim needs evidence from this checkout. Cover purpose, architecture, conventions and examples; report missing coverage explicitly in gaps.',
            { deliverAs: 'followUp' },
          );
          // Print/RPC must not dispose the session while Pi is still running the
          // queued synthesis. Delegate settlement to Pi, never run our own loop.
          if (settled) {
            // waitForIdle may still report idle before sendUserMessage starts its
            // asynchronous prompt. The native settlement event covers that gap.
            const abort = () => settleSynthesis?.();
            ctx.signal?.addEventListener('abort', abort, { once: true });
            try { await settled; } finally { ctx.signal?.removeEventListener('abort', abort); }
          }
        }
      };
      if (head === 'init') {
        await runIndexAndSynthesize((owner, signal) => owner.initProject(signal));
        return;
      }
      if (head === 'sync') {
        await runIndexAndSynthesize((owner, signal) => owner.syncProject(signal));
        return;
      }
      if (head === 'work') {
        const title = sub.slice('work'.length).trim();
        if (title) {
          ctx.ui.notify(await runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt).createWork(title), 'info');
        } else {
          ctx.ui.notify(await runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt).listWorksText(), 'info');
        }
        return;
      }
      if (head === 'ship') {
        ctx.ui.notify(await runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt).ship(), 'info');
        return;
      }
      if (!sub) ctx.ui.notify(await runtime(ctx.cwd, ctx.sessionManager?.getSessionId() ?? attempt).statusText(), 'info');
      else ctx.ui.notify('Usage: /prjct (or /p) | init | sync | work [title] | ship. init creates the store and runs the first index+analysis; sync/work/ship require it.', 'error');
  };
  for (const name of ['prjct', 'p'] as const) pi.registerCommand(name, {
    description: 'init (first index + analysis) | sync | work [title] | ship. The agent drives the rest through tools.',
    handler: commandHandler,
  });

  pi.on('session_start', async () => {
    attempt = newId('attempt');
    settleSynthesis?.(); settleSynthesis = undefined;
    runtimes.clear(); executions.clear(); synthesisQueued = false;
    const active = pi.getActiveTools();
    const prjctActive = active.filter(name => processToolNames.includes(name));
    const others = active.filter(name => !processToolNames.includes(name));
    const allOn = prjctActive.length === 0 || processToolNames.every(name => prjctActive.includes(name));
    const next = allOn ? [...others, 'prjct_context'] : [...others, ...prjctActive];
    if (!next.includes('prjct_context')) next.push('prjct_context');
    pi.setActiveTools(next);
  });

  pi.on('agent_settled', () => { synthesisQueued = false; settleSynthesis?.(); settleSynthesis = undefined; });
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
  pi.on('session_shutdown', () => { settleSynthesis?.(); settleSynthesis = undefined; runtimes.clear(); executions.clear(); });
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
      const text = redactSecrets(JSON.stringify(event.result ?? {}).slice(0, 3800));
      await entry.owner.recordObservation(`${event.toolName} ${event.isError ? 'failed' : 'completed'}: ${text}`, {
        ...entry.captured, outcome: ctx.signal?.aborted || !entry.captured.beforeHash ? 'unknown' : event.isError ? 'failed' : 'succeeded',
      });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`prjct could not retain evidence: ${(error as Error).message}`, 'warning');
      else console.error(`prjct evidence unavailable: ${(error as Error).message}`);
    }
  });
}
