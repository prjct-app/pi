import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { IdentifierSchema, PageCursorSchema } from '../workspace/reference-schemas.ts';

// Pi owns validation/normalization. Searching never authorizes refresh or analysis.
export const SearchParameters = Type.Object({
  checkoutId: IdentifierSchema, cursor: Type.Optional(PageCursorSchema),
  workId: Type.Optional(IdentifierSchema),
  query: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
  kinds: Type.Optional(Type.Array(StringEnum(['source', 'claim', 'artifact']), { minItems: 1, maxItems: 3, uniqueItems: true })),
  maxItems: Type.Integer({ minimum: 1, maximum: 32 }),
  maxBytes: Type.Integer({ minimum: 1, maximum: 50 * 1024 }),
}, { additionalProperties: false });

export type SearchRequest = Type.Static<typeof SearchParameters>;
