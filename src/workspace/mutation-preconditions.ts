import type { ContentReference } from './reference-schemas.ts';

export type MutationIdentity = Readonly<{ scopeId: string; actorId: string; operationId: string; requestHash: string }>;
export type PriorMutation = Readonly<MutationIdentity & {
  outcome: 'pending' | 'unknown' | 'committed';
  receipt?: ContentReference;
}>;
export type MutationState = Readonly<{ scopeId: string; revision: number; prior?: PriorMutation }>;
export type MutationDecision = Readonly<{ kind: 'proceed' } | { kind: 'already_committed'; receipt: ContentReference }>;

// A process-state precondition, not an executor, dispatcher or retry loop. The
// future file transaction calls it against locked durable state. Identity/actor
// come from the host; models cannot submit these records as trusted arguments.
export const checkMutationPreconditions = (identity: MutationIdentity, expectedRevision: number,
  state: MutationState, signal?: AbortSignal): MutationDecision => {
  if (state.scopeId !== identity.scopeId) throw Object.assign(new Error('Mutation state belongs to another scope.'), { code: 'SCOPE_MISMATCH' });
  if (state.prior && (['scopeId', 'actorId', 'operationId', 'requestHash'] as const).some(key => state.prior![key] !== identity[key])) {
    throw Object.assign(new Error('Operation identity conflicts with its recorded state.'), { code: 'OPERATION_CONFLICT' });
  }
  if (state.prior?.outcome === 'unknown' || state.prior?.outcome === 'pending') {
    throw Object.assign(new Error('Reconcile the existing operation before another state write.'), { code: 'RECONCILE_REQUIRED' });
  }
  if (state.prior?.outcome === 'committed') {
    if (!state.prior.receipt) throw Object.assign(new Error('Committed state is missing its receipt.'), { code: 'CORRUPT_STATE' });
    return { kind: 'already_committed', receipt: state.prior.receipt };
  }
  signal?.throwIfAborted();
  if (state.revision !== expectedRevision) {
    throw Object.assign(new Error(`Process state changed before the write; current revision is ${state.revision}.`), { code: 'STALE_REVISION' });
  }
  return { kind: 'proceed' };
};
