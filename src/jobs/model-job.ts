import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

// Model services run in a child Pi process with a clean context, only the
// prjct extension, read-only tools and a bounded protocol. This mirrors Pi's
// own subagent example, so it works for npm installs and compiled binaries.

export type ModelJobRequest = Readonly<{
  cwd: string;
  extensionPath: string;
  prompt: string;
  tools: readonly string[];
  model?: string;
  thinking?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onTurn?: (turns: number, toolCalls: number) => void;
  /** Raw child event stream is appended here for diagnosis (/prjct status shows the path on failure). */
  logPath?: string;
}>;

export type ModelJobResult = Readonly<{
  exitCode: number;
  text: string;
  turns: number;
  toolCalls: number;
  usage: { input: number; output: number; cost: number };
  stderr: string;
  errorMessage?: string;
}>;

// Resolve how to launch pi: the running script (npm install), the executable
// itself (Bun-compiled or SEA binary), or `pi` on PATH. PRJCT_PI_COMMAND
// overrides for tests and unusual hosts.
export const piInvocation = (args: readonly string[]): { command: string; args: string[] } => {
  const override = process.env.PRJCT_PI_COMMAND;
  if (override) {
    const [command = 'pi', ...prefix] = override.split(' ').filter(Boolean);
    return { command, args: [...prefix, ...args] };
  }
  const script = process.argv[1];
  const isBunVirtual = script?.startsWith('/$bunfs/root/');
  if (script && !isBunVirtual && existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args: [...args] };
  return { command: 'pi', args: [...args] };
};

export const modelJobArgs = (request: ModelJobRequest): string[] => [
  '--mode', 'json', '-p', '--no-session',
  '--no-extensions', '-e', request.extensionPath,
  '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  '--tools', request.tools.join(','),
  ...(request.model ? ['--model', request.model] : []),
  '--thinking', request.thinking ?? 'low',
  request.prompt,
];

export const runModelJob = (request: ModelJobRequest): Promise<ModelJobResult> => new Promise(resolve => {
  const invocation = piInvocation(modelJobArgs(request));
  const result = { exitCode: 0, text: '', turns: 0, toolCalls: 0, usage: { input: 0, output: 0, cost: 0 }, stderr: '' } as { -readonly [K in keyof ModelJobResult]: ModelJobResult[K] };
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...request.env },
  });
  let log: ReturnType<typeof createWriteStream> | undefined;
  if (request.logPath) {
    try { mkdirSync(dirname(request.logPath), { recursive: true }); log = createWriteStream(request.logPath, { flags: 'w' }); log.on('error', () => undefined); } catch { log = undefined; }
  }
  let buffer = '';
  const onLine = (line: string) => {
    if (!line.trim()) return;
    let event: { type?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }>; usage?: { input?: number; output?: number; cost?: { total?: number } }; errorMessage?: string } };
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'tool_execution_start') { result.toolCalls += 1; request.onTurn?.(result.turns, result.toolCalls); }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      result.turns += 1;
      const text = (event.message.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
      if (text.trim()) result.text = text;
      const usage = event.message.usage;
      if (usage) { result.usage.input += usage.input ?? 0; result.usage.output += usage.output ?? 0; result.usage.cost += usage.cost?.total ?? 0; }
      if (event.message.errorMessage) result.errorMessage = event.message.errorMessage;
      request.onTurn?.(result.turns, result.toolCalls);
    }
  };
  child.stdout.on('data', chunk => {
    log?.write(chunk);
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  child.stderr.on('data', chunk => { log?.write(`{"type":"stderr","text":${JSON.stringify(String(chunk))}}\n`); result.stderr = (result.stderr + String(chunk)).slice(-4000); });
  child.on('error', error => { result.stderr += String((error as Error).message); result.exitCode = 1; log?.end(); resolve(result); });
  child.on('close', code => { if (buffer.trim()) onLine(buffer); result.exitCode = code ?? 0; log?.end(); resolve(result); });
  const kill = () => {
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
  };
  if (request.signal?.aborted) kill();
  else request.signal?.addEventListener('abort', kill, { once: true });
});

// Keep only the brief the protocol asked for, bounded and headed.
export const extractBrief = (text: string, heading: string, maxBytes: number): string => {
  const marker = `# ${heading}`;
  const start = text.lastIndexOf(marker);
  let brief = (start >= 0 ? text.slice(start) : text).trim();
  if (!brief) return '';
  if (!brief.startsWith(marker)) brief = `${marker}\n\n${brief}`;
  while (Buffer.byteLength(brief, 'utf8') > maxBytes) {
    const cut = brief.lastIndexOf('\n');
    brief = cut > marker.length ? brief.slice(0, cut) : brief.slice(0, maxBytes);
  }
  return `${brief}\n`;
};
