export type BindingPointer = Readonly<{ workId: string; taskId?: string; attemptId?: string; writerGeneration?: number }>;
export type BindingGrant = Readonly<{ scopeId: string; attemptId: string; generation: number; standing: 'valid' | 'uncertain' | 'released' | 'revoked' }>;
export type ReconstructedBinding = Readonly<{ workId: string; taskId?: string; grantStanding: 'none' | 'valid' | 'uncertain'; reason?: string }>;

// Branch pointers are context hints. Current durable grants decide authority.
export const reconstructBinding = (input: Readonly<{
  branchId: string; pointer: BindingPointer; currentGrants: readonly BindingGrant[];
}>): ReconstructedBinding => {
  const current = input.currentGrants.find(grant => grant.attemptId === input.pointer.attemptId
    && grant.generation === input.pointer.writerGeneration && grant.standing === 'valid');
  const base = { workId: input.pointer.workId, ...(input.pointer.taskId ? { taskId: input.pointer.taskId } : {}) };
  if (!current) return { ...base, grantStanding: 'none', reason: 'STALE_GRANT' };
  return { ...base, grantStanding: 'valid' };
};
