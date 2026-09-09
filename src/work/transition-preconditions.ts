import { assessCompletion, type CompletionSnapshot } from './completion.ts';

export type TaskDisposition = 'not_started' | 'in_progress' | 'awaiting_input' | 'ready_for_verification' | 'completed' | 'cancelled';
export type TaskTransition = 'pause' | 'yield' | 'cancel' | 'reopen' | 'complete';
export type ProcessGrant = Readonly<{ scopeId: string; attemptId: string; generation: number; standing: 'valid' | 'uncertain' | 'released' | 'revoked' }>;
export type TransitionState = Readonly<{
  workId: string; taskId: string; disposition: TaskDisposition; access: 'read' | 'write';
  definitionRevision: number; planRevision: number; checkoutId?: string;
  taskGrant?: ProcessGrant; writerGrant?: ProcessGrant;
}>;
export type AttemptBinding = Readonly<{
  workId: string; taskId: string; checkoutId?: string; attemptId?: string; taskGeneration?: number; writerGeneration?: number;
}>;

// The binding is host-derived, not a tool argument. This guards process state;
// it cannot stop an arbitrary native shell process or serve as a filesystem sandbox.
export const assertTaskTransition = (transition: TaskTransition, state: TransitionState,
  binding: AttemptBinding, completion?: CompletionSnapshot): void => {
  if (state.workId !== binding.workId || state.taskId !== binding.taskId) {
    throw Object.assign(new Error('Task transition does not match the selected work/task.'), { code: 'SCOPE_MISMATCH' });
  }
  if (transition === 'reopen') {
    if (!['completed', 'cancelled'].includes(state.disposition)) {
      throw Object.assign(new Error('Only terminal tasks may be reopened.'), { code: 'INVALID_TRANSITION' });
    }
    if ([state.taskGrant, state.writerGrant].some(grant => grant?.standing === 'valid' || grant?.standing === 'uncertain')) {
      throw Object.assign(new Error('Reconcile outstanding grants before reopening.'), { code: 'RECONCILE_REQUIRED' });
    }
    return;
  }
  if (['completed', 'cancelled'].includes(state.disposition) ||
    (state.disposition === 'not_started' && transition !== 'cancel')) {
    throw Object.assign(new Error('This task disposition does not permit the requested transition.'), { code: 'INVALID_TRANSITION' });
  }
  if (transition === 'cancel' && state.disposition === 'not_started') {
    if ([state.taskGrant, state.writerGrant].some(grant => grant?.standing === 'valid' || grant?.standing === 'uncertain')) {
      throw Object.assign(new Error('An unstarted task has outstanding ownership; reconcile first.'), { code: 'RECONCILE_REQUIRED' });
    }
    return;
  }
  if (state.taskGrant?.standing === 'uncertain' || (state.access === 'write' && state.writerGrant?.standing === 'uncertain')) {
    throw Object.assign(new Error('Reconcile uncertain ownership before a task transition.'), { code: 'RECONCILE_REQUIRED' });
  }
  if (state.taskGrant && state.taskGrant.scopeId !== state.taskId) {
    throw Object.assign(new Error('The task grant belongs to another task.'), { code: 'SCOPE_MISMATCH' });
  }
  if (state.access === 'write' && (!state.checkoutId || state.checkoutId !== binding.checkoutId ||
    (state.writerGrant && state.writerGrant.scopeId !== state.checkoutId))) {
    throw Object.assign(new Error('The writer scope does not match the active checkout.'), { code: 'SCOPE_MISMATCH' });
  }
  if (!state.taskGrant || state.taskGrant.standing !== 'valid' || state.taskGrant.attemptId !== binding.attemptId || state.taskGrant.generation !== binding.taskGeneration) {
    throw Object.assign(new Error('The attempt no longer holds the task grant.'), { code: 'STALE_GRANT' });
  }
  if (state.access === 'write' && (!state.writerGrant || state.writerGrant.standing !== 'valid' ||
    state.writerGrant.attemptId !== binding.attemptId || state.writerGrant.generation !== binding.writerGeneration)) {
    throw Object.assign(new Error('The attempt no longer holds the checkout writer grant.'), { code: 'STALE_GRANT' });
  }
  if (transition === 'complete') {
    if (!['in_progress', 'ready_for_verification'].includes(state.disposition)) {
      throw Object.assign(new Error('This task disposition cannot transition directly to completion.'), { code: 'INVALID_TRANSITION' });
    }
    if (!completion || completion.scope.workId !== state.workId || completion.scope.taskId !== state.taskId || completion.scope.definitionRevision !== state.definitionRevision ||
      completion.scope.planRevision !== state.planRevision || assessCompletion(completion).status !== 'eligible') {
      throw Object.assign(new Error('Task completion requires a current, applicable assessment.'), { code: 'INCOMPLETE_ASSESSMENT' });
    }
  }
};
