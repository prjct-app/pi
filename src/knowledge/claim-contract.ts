import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { ContentReferenceSchema, IdentifierSchema, RevisionSchema, MAX_RESULT_BYTES } from '../workspace/reference-schemas.ts';

const scope = { projectId: IdentifierSchema, workId: Type.Optional(IdentifierSchema),
  maxBytes: Type.Integer({ minimum: 1, maximum: MAX_RESULT_BYTES }) };
const resolution = { claimId: IdentifierSchema, operationId: IdentifierSchema, expectedRevision: RevisionSchema,
  rationale: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }),
  evidenceIds: Type.Array(IdentifierSchema, { minItems: 1, maxItems: 32, uniqueItems: true }) };

// Propositions are agent-authored. Standing and attribution come from the process
// and applicable observations, never caller-supplied verified/approved/origin flags.
export const KnowledgeParameters = Type.Union([
  Type.Object({ action: StringEnum(['inspect']), claimId: IdentifierSchema, ...scope }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['propose']), operationId: IdentifierSchema,
    statement: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }),
    supports: Type.Array(ContentReferenceSchema, { maxItems: 16, uniqueItems: true }),
    gaps: Type.Array(Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }), { maxItems: 16 }), ...scope,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['resolve']), resolution: StringEnum(['confirm', 'contradict']), ...resolution, ...scope,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['resolve']), resolution: StringEnum(['correct', 'supersede']),
    replacement: ContentReferenceSchema, ...resolution, ...scope,
  }, { additionalProperties: false }),
  // Agent-driven ceremonies: recorded when the agent's state or task requires them,
  // never launched as user commands.
  Type.Object({ action: StringEnum(['replan']), operationId: IdentifierSchema,
    statement: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }), ...scope,
  }, { additionalProperties: false }),
  Type.Object({ action: StringEnum(['consolidate']), ...scope }, { additionalProperties: false }),
], { type: 'object' });

export type KnowledgeRequest = Type.Static<typeof KnowledgeParameters>;
