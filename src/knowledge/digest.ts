// Tool-output digests for evidence records. prjct owns what it puts into the
// agent's context, so compression happens at the source instead of on the
// wire (the llmtrim approach applied to our own outputs): a read observation
// never echoes file content the agent already holds; command output is
// normalized (ANSI, carriage-return frames), folded (repeated and templated
// lines), then windowed to failures plus head and tail with explicit elision
// markers. Every step is deterministic and never inflates the text.

export type ToolResultLike = Readonly<{ content?: ReadonlyArray<{ type?: string; text?: string }>; details?: unknown } | undefined>;
export type Digest = Readonly<{ text: string; lines: number; bytes: number }>;

const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_]/g;
const FAILURE = /\b(error|errors|fail|failed|failing|failure|fatal|panic|panicked|exception|traceback|abort|not ok|assert|assertion|denied|refused|timeout|timed out|cannot|unhandled|segfault|exit code [1-9])\b|✗|✖|❌/i;
const VOLATILE = /\d{4}-\d{2}-\d{2}T[\d:.+Z-]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b0x[0-9a-f]+\b|\b[0-9a-f]{7,64}\b|\d+(?:\.\d+)?/gi;

/** Strip terminal control sequences and keep only the last carriage-return frame of each line. */
export const normalizeTerminal = (text: string): string =>
  text.replace(ANSI, '').split('\n').map(line => {
    const frame = line.lastIndexOf('\r');
    return (frame >= 0 ? line.slice(frame + 1) : line).replace(/[ \t]+$/, '');
  }).join('\n');

const template = (line: string): string => line.replace(VOLATILE, '{}').replace(/\s+/g, ' ').trim();

/**
 * Fold consecutive repeats losslessly in spirit: identical lines become one line with
 * `[×N]`; lines sharing a template (numbers, hashes, timestamps masked) become the
 * template with the first three value tuples and a count. Applied only when shorter.
 */
export const foldLines = (lines: readonly string[]): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j += 1;
    if (j - i >= 2) { out.push(`${line} [×${j - i}]`); i = j; continue; }
    const key = template(line);
    if (key.includes('{}')) {
      let k = i + 1;
      while (k < lines.length && template(lines[k]!) === key) k += 1;
      if (k - i >= 3) {
        const samples = lines.slice(i, i + 3).map(item => `(${[...item.matchAll(VOLATILE)].map(match => match[0]).join(',')})`).join(' ');
        const folded = `${key} [×${k - i}: ${samples}${k - i > 3 ? ' …' : ''}]`;
        if (folded.length < lines.slice(i, k).join('\n').length) { out.push(folded); i = k; continue; }
      }
    }
    out.push(line); i += 1;
  }
  return out;
};

/**
 * Keep the head, the tail and every failure line within a character budget;
 * dropped runs become `[… N lines omitted …]` markers, emitted only when shorter
 * than what they hide.
 */
export const windowLines = (lines: readonly string[], budget: number, head = 2, tail = 3): string[] => {
  const total = lines.join('\n').length;
  if (total <= budget) return [...lines];
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(head, lines.length); i += 1) keep.add(i);
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i += 1) keep.add(i);
  let used = [...keep].reduce((sum, i) => sum + lines[i]!.length + 1, 0);
  for (let i = 0; i < lines.length && used < budget; i += 1) {
    if (keep.has(i) || !FAILURE.test(lines[i]!)) continue;
    keep.add(i); used += lines[i]!.length + 1;
  }
  const out: string[] = [];
  let omitted = 0;
  const flush = () => { if (omitted > 0) { out.push(`[… ${omitted} lines omitted …]`); omitted = 0; } };
  for (let i = 0; i < lines.length; i += 1) {
    if (keep.has(i)) { flush(); out.push(lines[i]!); } else omitted += 1;
  }
  flush();
  const joined = out.join('\n');
  if (joined.length > budget) {
    // Still over budget: trim kept lines individually, longest first, keeping the marker shape.
    return out.map(line => line.length > 160 ? `${line.slice(0, 157)}…` : line);
  }
  return out;
};

const textOf = (result: ToolResultLike): string =>
  (result?.content ?? []).filter(part => part.type === 'text' || part.text !== undefined).map(part => part.text ?? '').join('\n');

/** Compress a native tool result into an evidence digest that never repeats file content. */
export const digestToolResult = (toolName: string, result: ToolResultLike, options: { budget?: number; path?: string; command?: string } = {}): Digest => {
  const budget = options.budget ?? 700;
  const raw = textOf(result);
  const normalized = normalizeTerminal(raw);
  const allLines = normalized.split('\n');
  const lines = allLines.filter(line => line.trim().length > 0);
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (toolName === 'read') {
    const first = lines[0]?.trim().slice(0, 120) ?? '';
    const error = FAILURE.test(first) ? ` ${first}` : '';
    const text = `${options.path ?? ''} ${allLines.length} lines, ${bytes} B${error ? error : first ? `; starts: ${first}` : ''}`.trim();
    return { text: text.slice(0, budget), lines: allLines.length, bytes };
  }
  const folded = foldLines(lines);
  const windowed = windowLines(folded, budget);
  const text = windowed.join('\n').slice(0, budget);
  return { text: text || '(no output)', lines: allLines.length, bytes };
};

/** Signature-level outline of a source file: exported and top-level declarations with line numbers. */
export const outlineOf = (content: string, maxLines = 14, maxChars = 900): string => {
  const patterns = [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|abstract class)\s+[\w$]+/,
    /^\s*(?:async\s+)?(?:function|class|interface|enum)\s+[\w$]+/,
    /^\s*(?:def|class)\s+\w+/, // python
    /^\s*func\s+(?:\([^)]*\)\s*)?\w+/, // go
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|impl)\s+\w+/, // rust
    /^\s*(?:module|class|def)\s+\w+/, // ruby
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:function|class|interface|trait)\s+\w+/, // php/java-ish
  ];
  const out: string[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < maxLines; i += 1) {
    const line = lines[i]!;
    if (!patterns.some(pattern => pattern.test(line))) continue;
    const signature = line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ');
    out.push(`L${i + 1} ${signature.slice(0, 110)}`);
  }
  const joined = out.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
};
