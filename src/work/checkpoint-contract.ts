import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';

import { ContentReferenceSchema, IdentifierSchema, RevisionSchema } from '../workspace/reference-schemas.ts';
const shortText = Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' });
const evidenceIds = Type.Array(IdentifierSchema, { maxItems: 64, uniqueItems: true });

export const ReuseCheckpointSchema = Type.Object({
  action: Type.Literal('record'),
  taskId: IdentifierSchema,
  operationId: IdentifierSchema,
  expectedRevision: RevisionSchema,
  kind: Type.Literal('reuse_assessment'),
  data: Type.Object({
    behavior: shortText,
    approach: Type.String({ enum: ['reuse', 'extend', 'new', 'unresolved'] }),
    reviewedScope: shortText,
    existing: Type.Array(Type.Object({
      owner: shortText,
      capability: shortText,
      evidenceIds: Type.Array(IdentifierSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    }, { additionalProperties: false }), { maxItems: 32 }),
    examinedEvidenceIds: evidenceIds,
    rationale: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }),
    unresolvedQuestions: Type.Array(shortText, { maxItems: 32 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type ReuseCheckpoint = Type.Static<typeof ReuseCheckpointSchema>;

// Domain consistency only. Pi owns structural argument validation. Existence,
// provenance and applicability of evidence require the future durable owner;
// identifying an evidence ID here does not establish any of those properties.
export const assertReuseAssessment = ({ data }: ReuseCheckpoint): void => {
  if (['reuse', 'extend'].includes(data.approach) && data.existing.length === 0) {
    throw Object.assign(new Error('Reuse or extension requires an existing owner.'), { code: 'INVALID_REUSE_ASSESSMENT' });
  }
  if (data.approach === 'new' && data.examinedEvidenceIds.length === 0) {
    throw Object.assign(new Error('New behavior requires inspection evidence.'), { code: 'INVALID_REUSE_ASSESSMENT' });
  }
};

const recordScope = { action: StringEnum(['record']), workId: IdentifierSchema, taskId: IdentifierSchema,
  operationId: IdentifierSchema, expectedRevision: RevisionSchema,
  maxBytes: Type.Integer({ minimum: 1, maximum: 50 * 1024 }) };

const workRecordScope = Type.Omit(Type.Object(recordScope), ['taskId']).properties;

export const CheckpointParameters = Type.Union([
  Type.Object({ ...ReuseCheckpointSchema.properties, ...recordScope }, { additionalProperties: false }),
  Type.Object({ ...recordScope, kind: StringEnum(['progress']), methodId: IdentifierSchema, stage: IdentifierSchema,
    summary: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }), evidenceIds,
    nextAction: shortText,
  }, { additionalProperties: false }),
  Type.Object({ ...recordScope, kind: StringEnum(['assessment']), planRevision: RevisionSchema, definitionRevision: RevisionSchema,
    judgments: Type.Array(Type.Object({ criterionId: IdentifierSchema, conclusion: StringEnum(['satisfied', 'unsatisfied', 'unknown']),
      evidenceIds, rationale: shortText,
    }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
  Type.Object({ ...recordScope, kind: StringEnum(['decision_reference']), questionId: IdentifierSchema,
    observationId: IdentifierSchema, subject: shortText,
  }, { additionalProperties: false }),
  Type.Object({ ...workRecordScope, kind: StringEnum(['work_assessment']),
    specificationRevision: RevisionSchema, planRevision: RevisionSchema,
    taskAssessments: Type.Array(ContentReferenceSchema, { maxItems: 64, uniqueItems: true }),
    judgments: Type.Array(Type.Object({ criterionId: IdentifierSchema, conclusion: StringEnum(['satisfied', 'unsatisfied', 'unknown']),
      evidenceIds, rationale: shortText,
    }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
], { type: 'object' });
