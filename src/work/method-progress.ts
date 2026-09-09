export type MethodId = 'tdd' | 'to-spec' | 'research' | 'code-review' | 'handoff' | 'diagnosing-bugs' | 'grilling';
export type MethodEvidence = Readonly<{ id: string; provenance: 'native_observation' | 'agent_report' }>;
export type MethodProgress = Readonly<{
  methodId: MethodId; from: string; to: string; evidence?: readonly MethodEvidence[];
  handoffArtifact?: boolean;
}>;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

// Ordered stage vocabularies per method. Skipping a stage is never allowed;
// a stage may be re-recorded (same stage) to update its notes. Evidence gates
// that need store access (user input, command outcomes, artifacts) live in the
// runtime; this module owns vocabulary and ordering.
export const METHOD_STAGES: Record<MethodId, readonly string[]> = {
  tdd: ['seam_pending', 'seam_confirmed', 'test_authored', 'red_observed', 'green_pending', 'green_observed', 'review_pending'],
  'diagnosing-bugs': ['symptom_recorded', 'loop_built', 'reproduced', 'minimized', 'hypotheses_ranked', 'instrumented', 'fixed', 'cleaned_up'],
  research: ['question_recorded', 'sources_gathered', 'synthesized', 'complete'],
  'code-review': ['scope_pinned', 'standards_pass', 'spec_pass', 'reported'],
  grilling: ['tree_mapped', 'round_asked', 'decision_recorded', 'settled'],
  handoff: ['context_gathered', 'artifact_staged', 'ready'],
  'to-spec': ['synthesized', 'seams_confirmed', 'adopted'],
};

// Records method stage changes. Does not run tests, skills or agents.
export const assertMethodProgress = (progress: MethodProgress): void => {
  const stages = METHOD_STAGES[progress.methodId];
  if (!stages) fail('INVALID_STAGE', `Unknown method ${progress.methodId}.`);
  const from = stages.indexOf(progress.from);
  const to = stages.indexOf(progress.to);
  if (to < 0) fail('INVALID_STAGE', `Unknown stage "${progress.to}" for ${progress.methodId}. Known stages: ${stages.join(', ')}.`);
  if (from >= 0 && to > from + 1) fail('INVALID_STAGE', `${progress.methodId} cannot skip stages (${progress.from} → ${progress.to}).`);

  if (progress.methodId === 'tdd') {
    if (progress.to === 'red_observed' && !progress.evidence?.some(item => item.provenance === 'native_observation')) {
      fail('INVALID_STAGE', 'Red requires a native test observation.');
    }
    if (progress.to === 'green_observed' && (progress.from !== 'green_pending' || !progress.evidence?.some(item => item.provenance === 'native_observation'))) {
      fail('INVALID_STAGE', 'Green requires a native observation after red.');
    }
  }
  if (progress.methodId === 'code-review' && progress.to === 'reported'
    && progress.from !== 'spec_pass' && progress.from !== 'reported') {
    fail('INVALID_STAGE', 'Review is reported only after standards and spec passes.');
  }
  if (progress.methodId === 'grilling' && progress.to === 'decision_recorded'
    && !progress.evidence?.some(item => item.provenance === 'native_observation')) {
    fail('INVALID_STAGE', 'A settled grilling decision requires a current user observation.');
  }
  if (progress.methodId === 'research' && progress.to === 'complete'
    && !progress.evidence?.some(item => item.provenance === 'native_observation')) {
    fail('INVALID_STAGE', 'Research completion requires attributable observations, not search hits alone.');
  }
  if (progress.methodId === 'diagnosing-bugs' && progress.to === 'fixed'
    && !progress.evidence?.some(item => item.provenance === 'native_observation')) {
    fail('INVALID_STAGE', 'A fix requires a reproduced native loop, not speculation.');
  }
};
