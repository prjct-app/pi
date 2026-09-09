import Type from 'typebox';
import Schema from '../typebox-schema.ts';
import { ContentReferenceSchema, IdentifierSchema, PageCursorSchema, RevisionSchema } from '../workspace/reference-schemas.ts';
import type { SearchRequest } from './search-contract.ts';

const text = Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' });
export const SearchResultSchema = Type.Object({
  status: Type.String({ enum: ['ok', 'partial', 'abstained', 'unavailable'] }),
  checkoutId: IdentifierSchema, workId: Type.Optional(IdentifierSchema),
  observedRevision: Type.Optional(RevisionSchema), configRevision: Type.Optional(RevisionSchema),
  items: Type.Array(Type.Object({
    kind: Type.String({ enum: ['source', 'claim', 'artifact'] }), reference: ContentReferenceSchema,
    summary: Type.String({ minLength: 1, maxLength: 4096 }),
    applicability: Type.String({ enum: ['current', 'stale', 'unknown'] }),
    sources: Type.Array(ContentReferenceSchema, { minItems: 1, maxItems: 16 }),
    reasons: Type.Array(text, { minItems: 1, maxItems: 8 }),
    readPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  }, { additionalProperties: false }), { maxItems: 32 }),
  gaps: Type.Array(text, { maxItems: 32 }), next: Type.Optional(PageCursorSchema),
}, { additionalProperties: false });

export type SearchResult = Type.Static<typeof SearchResultSchema>;
const validator = Schema.Compile(SearchResultSchema);

// Process-owned output only. Input normalization and native execution stay in Pi.
// Ref existence, path safety, ranking and actual applicability remain owner duties.
export const validateSearchResult = (request: SearchRequest, result: unknown): void => {
  if (!validator.Check(result)) throw Object.assign(new Error('Invalid attributable search result.'), { code: 'INVALID_RESULT' });
  if (result.checkoutId !== request.checkoutId || result.workId !== request.workId) {
    throw Object.assign(new Error('Search result does not match the requested scope.'), { code: 'SCOPE_MISMATCH' });
  }
  if (result.status === 'ok' && (result.items.length === 0 || result.items.some(item => item.applicability !== 'current'))) {
    throw Object.assign(new Error('Uncertain search applicability must be disclosed as partial.'), { code: 'INVALID_RESULT' });
  }
  if (result.items.some(item => item.kind === 'source' && item.applicability === 'current') &&
    (result.observedRevision === undefined || result.configRevision === undefined)) {
    throw Object.assign(new Error('Current source hits require an observed representation cutoff.'), { code: 'INVALID_RESULT' });
  }
  if (result.status !== 'ok' && result.gaps.length === 0) {
    throw Object.assign(new Error('Incomplete search coverage requires an explanation.'), { code: 'INVALID_RESULT' });
  }
  if (result.items.length > request.maxItems) {
    throw Object.assign(new Error('Search result exceeds the requested item count.'), { code: 'OUTPUT_LIMIT' });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) {
    throw Object.assign(new Error('Search result exceeds the requested byte budget.'), { code: 'OUTPUT_LIMIT' });
  }
};
