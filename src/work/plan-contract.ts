import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { ContentReferenceSchema, IdentifierSchema, RevisionSchema, MAX_RESULT_BYTES } from '../workspace/reference-schemas.ts';

const scope = { workId: IdentifierSchema, maxBytes: Type.Integer({ minimum: 1, maximum: MAX_RESULT_BYTES }) };
const mutation = { operationId: IdentifierSchema, expectedRevision: RevisionSchema };

// Content is authored/read with native Pi tools. Adoption names immutable content
// and exact task definitions; it neither executes the plan nor supplies consent.
export const PlanParameters = Type.Union([
  Type.Object({ action: StringEnum(['inspect']), revision: ContentReferenceSchema, ...scope,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['draft']), kind: StringEnum(['spec']), content: ContentReferenceSchema,
    criterionIds: Type.Array(IdentifierSchema, { minItems: 1, maxItems: 64, uniqueItems: true }), ...scope, ...mutation,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['draft']), kind: StringEnum(['plan']), content: ContentReferenceSchema,
    specification: ContentReferenceSchema,
    tasks: Type.Array(Type.Object({ taskId: IdentifierSchema, definitionRevision: RevisionSchema },
      { additionalProperties: false }), { minItems: 1, maxItems: 64, uniqueItems: true }), ...scope, ...mutation,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['adopt']), candidate: ContentReferenceSchema, ...scope, ...mutation,
  }, { additionalProperties: false }),
], { type: 'object' });

export type PlanRequest = Type.Static<typeof PlanParameters>;
