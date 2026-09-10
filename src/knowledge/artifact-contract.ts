import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { ContentReferenceSchema, IdentifierSchema, PageCursorSchema, MAX_RESULT_BYTES } from '../workspace/reference-schemas.ts';

const scope = { projectId: IdentifierSchema, workId: Type.Optional(IdentifierSchema),
  maxBytes: Type.Integer({ minimum: 1, maximum: MAX_RESULT_BYTES }) };
const kind = StringEnum(['research', 'spec', 'plan', 'prototype', 'questionnaire', 'analysis', 'handoff', 'evidence', 'note']);
const publication = { action: StringEnum(['publish']), operationId: IdentifierSchema, kind,
  previous: Type.Optional(ContentReferenceSchema), ...scope };

// stage returns a managed locator for native authoring. publish only accepts that
// opaque staging reference or bounded inline text, never an arbitrary source path.
// prepare_export records intent; it is not a client/tracker/cloud write operation.
export const ArtifactParameters = Type.Union([
  Type.Object({ action: StringEnum(['stage']), operationId: IdentifierSchema, kind, ...scope }, { additionalProperties: false }),
  Type.Object({ ...publication, content: Type.String({ minLength: 1, maxLength: 65536 }) }, { additionalProperties: false }),
  Type.Object({ ...publication, stagedBlobId: IdentifierSchema,
    expectedContentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['inspect']), revision: ContentReferenceSchema, ...scope }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['list']), maxItems: Type.Integer({ minimum: 1, maximum: 32 }),
    cursor: Type.Optional(PageCursorSchema), ...scope }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['prepare_export']), operationId: IdentifierSchema, revision: ContentReferenceSchema,
    targetDescription: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }), ...scope,
  }, { additionalProperties: false }),
], { type: 'object' });

export type ArtifactRequest = Type.Static<typeof ArtifactParameters>;
