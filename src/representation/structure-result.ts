import Type from 'typebox';
import Schema from '../typebox-schema.ts';
import { ContentReferenceSchema, IdentifierSchema, RevisionSchema } from '../workspace/reference-schemas.ts';
import type { StructureRequest } from './structure-contract.ts';

const edge = { id: IdentifierSchema, from: IdentifierSchema, to: IdentifierSchema,
  distance: Type.Integer({ minimum: 1, maximum: 8 }),
  sources: Type.Array(ContentReferenceSchema, { minItems: 1, maxItems: 16 }) };
export const StructureResultSchema = Type.Object({
  action: Type.String({ enum: ['neighbors', 'impact'] }),
  status: Type.String({ enum: ['ok', 'partial', 'abstained', 'unavailable'] }),
  checkoutId: IdentifierSchema, observedRevision: Type.Optional(RevisionSchema), configRevision: Type.Optional(RevisionSchema),
  freshness: Type.String({ enum: ['current', 'stale', 'unknown'] }), certainty: Type.Literal('advisory'),
  edges: Type.Array(Type.Union([
    Type.Object({ ...edge, relation: Type.String({ enum: ['imports', 'calls', 'references', 'contains'] }),
      basis: Type.Literal('extracted'),
    }, { additionalProperties: false }),
    Type.Object({ ...edge, relation: Type.Literal('cochange'), basis: Type.Literal('cochange') }, { additionalProperties: false }),
  ]), { maxItems: 128 }),
  nodes: Type.Optional(Type.Array(Type.Object({
    id: IdentifierSchema, path: Type.String({ minLength: 1, maxLength: 1024 }),
  }, { additionalProperties: false }), { maxItems: 128 })),
  gaps: Type.Array(Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }), { maxItems: 32 }),
}, { additionalProperties: false });
export type StructureResult = Type.Static<typeof StructureResultSchema>;
const validator = Schema.Compile(StructureResultSchema);

// Qualified representation data, not a graph extractor or semantic correctness
// judge. The owner must resolve support, coverage and actual traversal scope.
export const validateStructureResult = (request: StructureRequest, result: unknown): void => {
  if (!validator.Check(result)) throw Object.assign(new Error('Invalid advisory structure result.'), { code: 'INVALID_RESULT' });
  if (result.checkoutId !== request.checkoutId || result.action !== request.action) {
    throw Object.assign(new Error('Structure result does not match the requested scope/action.'), { code: 'SCOPE_MISMATCH' });
  }
  if (result.edges.some(item => !request.relations.some(allowed => allowed === item.relation))) {
    throw Object.assign(new Error('Structure result contains an unrequested relation.'), { code: 'SCOPE_MISMATCH' });
  }
  if (result.status === 'ok' && result.freshness !== 'current') {
    throw Object.assign(new Error('Uncertain representation freshness must be disclosed as partial.'), { code: 'INVALID_RESULT' });
  }
  if (result.status !== 'ok' && result.gaps.length === 0) {
    throw Object.assign(new Error('Incomplete structure coverage requires an explanation.'), { code: 'INVALID_RESULT' });
  }
  if (result.freshness === 'current' && (result.observedRevision === undefined || result.configRevision === undefined)) {
    throw Object.assign(new Error('Current structure data requires an observed representation cutoff.'), { code: 'INVALID_RESULT' });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) {
    throw Object.assign(new Error('Structure result exceeds the requested byte budget.'), { code: 'OUTPUT_LIMIT' });
  }
  if (result.edges.length > request.maxItems || result.edges.some(item => item.distance > request.maxDepth)) {
    throw Object.assign(new Error('Structure result exceeds the requested count or depth.'), { code: 'OUTPUT_LIMIT' });
  }
};
