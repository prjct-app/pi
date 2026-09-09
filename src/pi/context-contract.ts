import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import Schema from '../typebox-schema.ts';
import { ContentReferenceSchema } from '../workspace/reference-schemas.ts';

// Pi validates and normalizes this schema before invoking the tool. No second
// input parser or prepareArguments hook is required.
export const ContextParameters = Type.Object({
  action: StringEnum(['lookup', 'discover']),
  query: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
  maxBytes: Type.Integer({ minimum: 1, maximum: 50 * 1024 }),
}, { additionalProperties: false });

export type ContextRequest = Type.Static<typeof ContextParameters>;

export const ContextLookupResponseSchema = Type.Object({
  status: Type.String({ enum: ['ok', 'partial', 'abstained'] }),
  items: Type.Array(Type.Object({
    kind: Type.String({ enum: ['purpose', 'stack', 'architecture', 'design', 'work', 'method', 'history'] }),
    summary: Type.String({ minLength: 1, maxLength: 4096 }),
    standing: Type.String({ enum: ['candidate', 'supported', 'needs_review', 'contradicted', 'superseded'] }),
    sources: Type.Array(ContentReferenceSchema, { minItems: 1, maxItems: 16 }),
  }, { additionalProperties: false }), { maxItems: 32 }),
  gaps: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
  /** Current process-state revision, so a follow-up mutation can name expectedRevision without another discover. */
  stateRevision: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

const responseValidator = Schema.Compile(ContextLookupResponseSchema);

export const validateContextResponse = (request: ContextRequest, input: unknown): Type.Static<typeof ContextLookupResponseSchema> => {
  if (request.action !== 'lookup' || !responseValidator.Check(input)) {
    throw Object.assign(new Error('Invalid context lookup response.'), { code: 'INVALID_RESULT' });
  }
  if (input.status !== 'ok' && input.gaps.length === 0) {
    throw Object.assign(new Error('Incomplete context requires a coverage explanation.'), { code: 'INVALID_RESULT' });
  }
  if (input.status === 'ok' && input.items.length === 0) {
    throw Object.assign(new Error('Successful context lookup requires at least one attributable item.'), { code: 'INVALID_RESULT' });
  }
  const serialized = JSON.stringify(input);
  if (serialized === undefined) {
    throw Object.assign(new Error('Context response must be serializable JSON.'), { code: 'INVALID_RESULT' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > request.maxBytes) {
    throw Object.assign(new Error('Context response exceeds the requested byte budget.'), { code: 'OUTPUT_LIMIT' });
  }
  return input;
};
