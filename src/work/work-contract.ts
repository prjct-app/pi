import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { ContentReferenceSchema, IdentifierSchema, PageCursorSchema, RevisionSchema } from '../workspace/reference-schemas.ts';

const resultBudget = Type.Integer({ minimum: 1, maximum: 50 * 1024 });
const mutation = { operationId: IdentifierSchema, expectedRevision: RevisionSchema };

// Operation alternatives are one native JSON Schema, not a process-owned parser.
// Revision comparison, work completion and branch binding belong to Work/Pi,
// respectively; passing this declaration alone performs none of those effects.
export const WorkParameters = Type.Union([
  Type.Object({ action: StringEnum(['list']), projectId: IdentifierSchema, cursor: Type.Optional(PageCursorSchema),
    maxItems: Type.Integer({ minimum: 1, maximum: 32 }), maxBytes: resultBudget,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['inspect']), workId: IdentifierSchema, maxBytes: resultBudget,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['create']), projectId: IdentifierSchema, operationId: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 256, pattern: '\\S' }),
    origin: ContentReferenceSchema, maxBytes: resultBudget,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['select']), workId: IdentifierSchema, checkoutId: IdentifierSchema,
    ...mutation, maxBytes: resultBudget,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['link']), workId: IdentifierSchema, origin: ContentReferenceSchema,
    ...mutation, maxBytes: resultBudget,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['transition']), workId: IdentifierSchema,
    disposition: StringEnum(['open', 'paused', 'abandoned', 'archived']),
    reason: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
    ...mutation, maxBytes: resultBudget,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['transition']), workId: IdentifierSchema,
    disposition: StringEnum(['completed']), assessmentId: IdentifierSchema,
    reason: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
    ...mutation, maxBytes: resultBudget,
  }, { additionalProperties: false }),
], { type: 'object' });

export type WorkRequest = Type.Static<typeof WorkParameters>;
