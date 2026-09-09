import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCompletion } from '../src/work/completion.ts';

const scope = { workId: 'work_a', taskId: 'task_refresh', definitionRevision: 2, planRevision: 3 };

test('a task cannot become eligible for completion merely because execution stopped', () => {
  assert.deepEqual(assessCompletion({ scope, criteria: ['reuse_existing_refresh'] }), {
    status: 'not_eligible', reasons: ['MISSING_ASSESSMENT'],
  });
});

for (const [field, value] of [['workId', 'other_work'], ['taskId', 'other_task'], ['definitionRevision', 1], ['planRevision', 1]] as const) {
  test(`a completion assessment cannot be reused across a changed ${field}`, () => {
    assert.deepEqual(assessCompletion({ scope, criteria: ['reuse_existing_refresh'],
      assessment: { scope: { ...scope, [field]: value }, judgments: [] },
    }), { status: 'not_eligible', reasons: ['ASSESSMENT_SCOPE_CHANGED'] });
  });
}

test('a recorded red result cannot close work when the green criterion is unassessed', () => {
  assert.deepEqual(assessCompletion({ scope, criteria: ['red', 'green'], assessment: { scope,
    judgments: [{ criterionId: 'red', conclusion: 'satisfied', evidenceIds: ['red_observation'] }],
  } }), { status: 'not_eligible', reasons: ['UNASSESSED:green'] });
});

for (const conclusion of ['unknown', 'unsatisfied'] as const) {
  test(`a ${conclusion} criterion remains open even when an assessment record exists`, () => {
    assert.deepEqual(assessCompletion({ scope, criteria: ['green'], assessment: { scope,
      judgments: [{ criterionId: 'green', conclusion, evidenceIds: ['green_observation'] }],
    } }), { status: 'not_eligible', reasons: [`${conclusion.toUpperCase()}:green`] });
  });
}

test('an empty criterion list cannot make a task vacuously complete', () => {
  assert.deepEqual(assessCompletion({ scope, criteria: [], assessment: { scope, judgments: [] } }), {
    status: 'not_eligible', reasons: ['NO_CRITERIA'],
  });
});

test('saying a criterion passed does not substitute for a resolvable evidence record', () => {
  assert.deepEqual(assessCompletion({ scope, criteria: ['green'], assessment: { scope,
    judgments: [{ criterionId: 'green', conclusion: 'satisfied', evidenceIds: ['missing_green'] }],
  }, evidence: [] }), { status: 'not_eligible', reasons: ['MISSING_EVIDENCE:missing_green'] });
});

test('a satisfied judgment without evidence cannot close its criterion', () => {
  assert.deepEqual(assessCompletion({ scope, criteria: ['green'], assessment: { scope,
    judgments: [{ criterionId: 'green', conclusion: 'satisfied', evidenceIds: [] }],
  }, evidence: [] }), { status: 'not_eligible', reasons: ['NO_OBSERVATION:green'] });
});

test('an agent report alone cannot be promoted to observed completion evidence', () => {
  assert.deepEqual(assessCompletion({ scope, criteria: ['green'], assessment: { scope,
    judgments: [{ criterionId: 'green', conclusion: 'satisfied', evidenceIds: ['green_report'] }],
  }, evidence: [{ id: 'green_report', provenance: 'agent_report' }] }), {
    status: 'not_eligible', reasons: ['NO_OBSERVATION:green'],
  });
});

const supportedCompletion = {
  scope, criteria: ['green'], assessment: { scope,
    judgments: [{ criterionId: 'green', conclusion: 'satisfied' as const, evidenceIds: ['green_observation'] }],
  }, evidence: [{ id: 'green_observation', provenance: 'native_observation' as const,
    supports: [{ id: 'source_cockpit', revision: 7, contentHash: 'a'.repeat(64) }],
  }], currentSupports: [{ id: 'source_cockpit', revision: 7, contentHash: 'a'.repeat(64) }],
};

test('a current scoped assessment with observed support passes eligibility without claiming semantic proof', () => {
  assert.deepEqual(assessCompletion(supportedCompletion), { status: 'eligible', reasons: [] });
});

test('a later code change invalidates completion evidence even if the task and plan did not change', () => {
  assert.deepEqual(assessCompletion({ ...supportedCompletion,
    currentSupports: [{ id: 'source_cockpit', revision: 8, contentHash: 'b'.repeat(64) }],
  }), { status: 'not_eligible', reasons: ['STALE_EVIDENCE:green_observation'] });
});

test('an observation with unrecorded applicability cannot be assumed current', () => {
  assert.deepEqual(assessCompletion({ ...supportedCompletion,
    evidence: [{ id: 'green_observation', provenance: 'native_observation' }],
  }), { status: 'not_eligible', reasons: ['UNKNOWN_EVIDENCE_SCOPE:green_observation'] });
});

test('duplicate judgments cannot be silently collapsed into completion', () => {
  assert.deepEqual(assessCompletion({ ...supportedCompletion, assessment: { scope,
    judgments: [...supportedCompletion.assessment.judgments, ...supportedCompletion.assessment.judgments],
  } }), { status: 'not_eligible', reasons: ['AMBIGUOUS_ASSESSMENT'] });
});

test('a team peer result cannot satisfy a completion criterion', () => {
  assert.deepEqual(assessCompletion({
    scope, criteria: ['green'], assessment: { scope,
      judgments: [{ criterionId: 'green', conclusion: 'satisfied', evidenceIds: ['team_result'] }],
    }, evidence: [{ id: 'team_result', provenance: 'agent_report' }],
  }), { status: 'not_eligible', reasons: ['NO_OBSERVATION:green'] });
});
