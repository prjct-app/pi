import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { ContentReferenceSchema, IdentifierSchema, PageCursorSchema, RevisionSchema } from '../workspace/reference-schemas.ts';

const scope = { workId: IdentifierSchema, maxBytes: Type.Integer({ minimum: 1, maximum: 50 * 1024 }) };
const mutation = { operationId: IdentifierSchema, expectedRevision: RevisionSchema };

// The host binds attempts and grants. A model can request a claim, not provide
// its actor, grant validity, a force flag or an embedded completion snapshot.
export const TaskParameters = Type.Union([
  Type.Object({ action: StringEnum(['inspect']), taskId: IdentifierSchema,
    view: StringEnum(['progress', 'frontier', 'history']), maxItems: Type.Integer({ minimum: 1, maximum: 32 }),
    cursor: Type.Optional(PageCursorSchema), ...scope,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['frontier']), maxItems: Type.Integer({ minimum: 1, maximum: 32 }),
    ...scope,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['define']), taskId: Type.Optional(IdentifierSchema), definition: ContentReferenceSchema,
    criterionIds: Type.Array(IdentifierSchema, { minItems: 1, maxItems: 64, uniqueItems: true }), ...scope, ...mutation,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['link']), taskId: IdentifierSchema,
    target: Type.Object({ workId: IdentifierSchema, taskId: IdentifierSchema }, { additionalProperties: false }),
    relation: StringEnum(['blocks', 'contains', 'related', 'discovered-from', 'supersedes', 'split-from', 'merged-from']),
    ...scope, ...mutation,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['claim']), taskId: IdentifierSchema, checkoutId: IdentifierSchema,
    access: StringEnum(['read', 'write']), ...scope, ...mutation,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['transition']), taskId: IdentifierSchema,
    transition: StringEnum(['pause', 'yield', 'cancel', 'reopen']),
    reason: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }), ...scope, ...mutation,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['transition']), taskId: IdentifierSchema, transition: StringEnum(['complete']),
    assessmentId: IdentifierSchema, ...scope, ...mutation,
  }, { additionalProperties: false }),
], { type: 'object' });

export type TaskRequest = Type.Static<typeof TaskParameters>;
