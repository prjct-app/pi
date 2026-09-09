import type { ContentReference } from '../workspace/reference-schemas.ts';

export type CompletionScope = Readonly<{ workId: string; taskId: string; definitionRevision: number; planRevision: number }>;
export type CompletionAssessment = Readonly<{
  scope: CompletionScope;
  judgments: readonly Readonly<{ criterionId: string; conclusion: 'satisfied' | 'unsatisfied' | 'unknown'; evidenceIds: readonly string[] }>[];
}>;
export type CompletionEvidence = Readonly<{
  id: string;
  provenance: 'native_observation' | 'agent_report';
  supports?: readonly ContentReference[];
}>;
export type CompletionSnapshot = Readonly<{
  scope: CompletionScope;
  criteria: readonly string[];
  assessment?: CompletionAssessment;
  evidence?: readonly CompletionEvidence[];
  currentSupports?: readonly ContentReference[];
}>;
export type CompletionReadiness = Readonly<{ status: 'eligible' | 'not_eligible'; reasons: readonly string[] }>;

// A process gate, not a judge of model competence or a task executor. The owning
// Work operation will supply durable records; wire callers provide references,
// not a model-authored snapshot. Eligibility does not itself complete the task.
export const assessCompletion = (snapshot: CompletionSnapshot): CompletionReadiness => {
  if (!snapshot.assessment) return { status: 'not_eligible', reasons: ['MISSING_ASSESSMENT'] };
  const assessed = snapshot.assessment.scope;
  if (assessed.workId !== snapshot.scope.workId || assessed.taskId !== snapshot.scope.taskId || assessed.definitionRevision !== snapshot.scope.definitionRevision ||
    assessed.planRevision !== snapshot.scope.planRevision) {
    return { status: 'not_eligible', reasons: ['ASSESSMENT_SCOPE_CHANGED'] };
  }
  if (snapshot.criteria.length === 0) return { status: 'not_eligible', reasons: ['NO_CRITERIA'] };
  const judgedIds = snapshot.assessment.judgments.map(item => item.criterionId);
  if (new Set(judgedIds).size !== judgedIds.length) return { status: 'not_eligible', reasons: ['AMBIGUOUS_ASSESSMENT'] };
  const unassessed = snapshot.criteria.filter(id => !snapshot.assessment!.judgments.some(item => item.criterionId === id));
  if (unassessed.length) return { status: 'not_eligible', reasons: unassessed.map(id => `UNASSESSED:${id}`) };
  const unmet = snapshot.assessment.judgments.filter(item => snapshot.criteria.includes(item.criterionId) && item.conclusion !== 'satisfied');
  if (unmet.length) return { status: 'not_eligible', reasons: unmet.map(item => `${item.conclusion.toUpperCase()}:${item.criterionId}`) };
  const evidenceIds = snapshot.assessment.judgments.flatMap(item => item.evidenceIds);
  const missingEvidence = evidenceIds.filter(id => !snapshot.evidence?.some(item => item.id === id));
  if (missingEvidence.length) return { status: 'not_eligible', reasons: missingEvidence.map(id => `MISSING_EVIDENCE:${id}`) };
  const withoutObservations = snapshot.assessment.judgments.filter(judgment => !judgment.evidenceIds.some(id =>
    snapshot.evidence?.some(item => item.id === id && item.provenance === 'native_observation')));
  if (withoutObservations.length) {
    return { status: 'not_eligible', reasons: withoutObservations.map(item => `NO_OBSERVATION:${item.criterionId}`) };
  }
  const unknownScope = snapshot.evidence?.filter(item => evidenceIds.includes(item.id) && item.supports === undefined) ?? [];
  if (unknownScope.length) return { status: 'not_eligible', reasons: unknownScope.map(item => `UNKNOWN_EVIDENCE_SCOPE:${item.id}`) };
  const staleEvidence = snapshot.evidence?.filter(item => evidenceIds.includes(item.id) && item.supports?.some(support =>
    !snapshot.currentSupports?.some(current => current.id === support.id && current.revision === support.revision &&
      current.contentHash === support.contentHash))) ?? [];
  if (staleEvidence.length) return { status: 'not_eligible', reasons: staleEvidence.map(item => `STALE_EVIDENCE:${item.id}`) };
  return { status: 'eligible', reasons: [] };
};
