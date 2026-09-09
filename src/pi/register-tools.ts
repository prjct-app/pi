import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { processToolDeclarations } from './tool-declarations.ts';
import { ProcessRuntime } from './process-runtime.ts';

export const processToolNames = processToolDeclarations.map(item => item.name);

export const createProcessTools = (home: () => string, activate?: (names: string[]) => void, attemptId?: () => string, runtimeFor?: (cwd: string, sessionId: string) => ProcessRuntime) =>
  processToolDeclarations.map(declaration => defineTool({
    ...declaration,
    execute: async (_id, params, signal, _update, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const runtime = runtimeFor?.(ctx.cwd, sessionId) ?? new ProcessRuntime({ agentHome: home(), cwd: ctx.cwd, sessionId,
        ...(attemptId ? { attemptId: attemptId() } : {}) });
      return runtime.execute(declaration.name, params as Record<string, unknown>, {
        ...(signal ? { signal } : {}),
        ...(activate ? { activate } : {}),
        confirm: async (message: string) => ctx.hasUI ? ctx.ui.confirm('prjct confirmation', message, signal ? { signal } : {}) : false,
      });
    },
  } as ToolDefinition));
