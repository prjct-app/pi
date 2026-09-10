import Type from 'typebox';

// Shared value contracts for internal references, not aliases, URLs or paths.

// Hard ceiling for every prjct-produced result. pi's own output guard truncates
// payloads around 50KB with a '[Full output: ...]' notice; prjct must never
// emit anything near that, so all tool budgets cap well below it.
export const MAX_RESULT_BYTES = 32 * 1024;
export const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
});

export const RevisionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const ContentReferenceSchema = Type.Object({
  id: IdentifierSchema,
  revision: RevisionSchema,
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
}, { additionalProperties: false });

export type ContentReference = Type.Static<typeof ContentReferenceSchema>;

// Query/scope-bound snapshot plus stable row identity, not an offset into a moving
// collection. A changed or unavailable snapshot must produce STALE_CURSOR.
export const PageCursorSchema = Type.Object({
  snapshot: ContentReferenceSchema, afterId: IdentifierSchema,
}, { additionalProperties: false });
