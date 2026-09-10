import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { IdentifierSchema, RevisionSchema, MAX_RESULT_BYTES } from '../workspace/reference-schemas.ts';

const scope = { workId: IdentifierSchema, taskId: IdentifierSchema,
  maxBytes: Type.Integer({ minimum: 1, maximum: MAX_RESULT_BYTES }) };

// Observation references are inputs to reconciliation, not proof of consent or
// cessation. The process must obtain current confirmation through existing Pi UI.
export const ReconcileParameters = Type.Union([
  Type.Object({ action: StringEnum(['inspect']), ...scope }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['continue']), predecessorAttemptId: IdentifierSchema,
    operationId: IdentifierSchema, expectedRevision: RevisionSchema,
    observationIds: Type.Array(IdentifierSchema, { minItems: 1, maxItems: 32, uniqueItems: true }), ...scope,
  }, { additionalProperties: false }),
], { type: 'object' });

export type ReconcileRequest = Type.Static<typeof ReconcileParameters>;
