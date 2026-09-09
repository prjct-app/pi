import Type from 'typebox';
import Schema from '../typebox-schema.ts';
import { ContentReferenceSchema, IdentifierSchema, RevisionSchema } from './reference-schemas.ts';
import type { MutationIdentity } from './mutation-preconditions.ts';

const correlation = { operationId: IdentifierSchema, scopeId: IdentifierSchema };
export const MutationResultSchema = Type.Union([
  Type.Object({ ...correlation, outcome: Type.Literal('committed'), receipt: ContentReferenceSchema,
    replayed: Type.Boolean(), stateRevision: RevisionSchema,
  }, { additionalProperties: false }),
  Type.Object({ ...correlation, outcome: Type.String({ enum: ['not_committed', 'unknown'] }),
    reason: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
  }, { additionalProperties: false }),
]);
export type MutationResult = Type.Static<typeof MutationResultSchema>;
const validator = Schema.Compile(MutationResultSchema);

// Acknowledges prjct-owned state only, not native execution or external delivery.
// A committed receipt can describe a partial refresh; it is not overall success.
// The durable owner must resolve the receipt and actual outcome before returning it.
export const validateMutationResult = (identity: MutationIdentity, maxBytes: number, result: unknown): void => {
  if (!validator.Check(result)) throw Object.assign(new Error('Invalid process-state acknowledgement.'), { code: 'INVALID_RESULT' });
  if (result.operationId !== identity.operationId || result.scopeId !== identity.scopeId) {
    throw Object.assign(new Error('Acknowledgement does not match the requested operation scope.'), { code: 'SCOPE_MISMATCH' });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    throw Object.assign(new Error('Acknowledgement exceeds the requested byte budget.'), { code: 'OUTPUT_LIMIT' });
  }
};
