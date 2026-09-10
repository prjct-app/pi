export type BindingPointer = Readonly<{
  workId: string;
  taskId?: string;
  branchId?: string;
  checkoutId?: string;
  attemptId?: string;
  taskGeneration?: number;
  writerGeneration?: number;
}>;
export type BindingGrant = Readonly<{ scopeId: string; attemptId: string; generation: number; standing: 'valid' | 'uncertain' | 'released' | 'revoked' }>;
export type ReconstructedBinding = Readonly<{ workId: string; taskId?: string; checkoutId?: string; grantStanding: 'none' | 'valid' | 'uncertain'; reason?: string }>;

// Branch pointers are context hints. They can select work, but current durable
// grants decide authority and must match every host-owned dimension exactly.
export const reconstructBinding = (input: Readonly<{
  branchId: string;
  currentAttemptId: string;
  currentCheckoutId: string;
  pointer: BindingPointer;
  currentGrants: readonly BindingGrant[];
}>): ReconstructedBinding => {
  const base = { workId: input.pointer.workId, ...(input.pointer.taskId ? { taskId: input.pointer.taskId } : {}),
    ...(input.pointer.checkoutId ? { checkoutId: input.pointer.checkoutId } : {}) };
  if (!input.pointer.branchId || input.pointer.branchId !== input.branchId) {
    return { ...base, grantStanding: 'none', reason: 'BRANCH_MISMATCH' };
  }
  if (!input.pointer.checkoutId || input.pointer.checkoutId !== input.currentCheckoutId) {
    return { ...base, grantStanding: 'none', reason: 'CHECKOUT_MISMATCH' };
  }
  if (!input.pointer.attemptId || input.pointer.attemptId !== input.currentAttemptId) {
    return { ...base, grantStanding: 'none', reason: 'STALE_ATTEMPT' };
  }
  const expected = [
    { scopeId: input.currentCheckoutId, generation: input.pointer.writerGeneration },
    ...(input.pointer.taskId ? [{ scopeId: input.pointer.taskId, generation: input.pointer.taskGeneration }] : []),
  ];
  if (expected.some(item => !Number.isSafeInteger(item.generation))) {
    return { ...base, grantStanding: 'none', reason: 'STALE_GRANT' };
  }
  const grants = expected.map(item => input.currentGrants.find(grant => grant.scopeId === item.scopeId
    && grant.attemptId === input.currentAttemptId && grant.generation === item.generation));
  if (grants.some(grant => !grant || ['released', 'revoked'].includes(grant.standing))) {
    return { ...base, grantStanding: 'none', reason: 'STALE_GRANT' };
  }
  if (grants.some(grant => grant?.standing === 'uncertain')) {
    return { ...base, grantStanding: 'uncertain', reason: 'UNCERTAIN_GRANT' };
  }
  return { ...base, grantStanding: 'valid' };
};
