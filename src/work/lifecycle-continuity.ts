export type ReanchorReason = 'startup' | 'reload' | 'new' | 'resume' | 'fork' | 'compact' | 'tree';

const clipUtf8 = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle) + suffix, 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd() + suffix;
};

// A lifecycle invalidation permits exactly one bounded context re-anchor. Warm
// turns consume no bytes. Authority is intentionally excluded from this text.
export class LifecycleContinuity {
  private pending: ReanchorReason | undefined;

  mark(reason: ReanchorReason): void { this.pending = reason; }
  isPending(): boolean { return this.pending !== undefined; }

  consume(summary: string, maxBytes = 2048): string | undefined {
    const reason = this.pending;
    if (!reason) return undefined;
    this.pending = undefined;
    const prefix = `[prjct stale re-anchor after ${reason}] `;
    const suffix = '\nThis is context only. No task or writer grant was restored; revalidate current checkout and attempt before mutation.';
    const summaryBudget = Math.max(1, maxBytes - Buffer.byteLength(prefix + suffix, 'utf8'));
    return `${prefix}${clipUtf8(summary, summaryBudget)}${suffix}`;
  }
}
