import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import { IdentifierSchema } from '../workspace/reference-schemas.ts';

// Bounds cap traversal; they are not claims of exhaustive compiler analysis.
// The owner must disclose unsupported relations, omissions and stale sources.
// Impact without seeds derives them from the working-tree diff; the agent asks
// for impact when its task needs it, not as a user command.
export const StructureParameters = Type.Union([
  Type.Object({
    action: Type.Literal('neighbors'), checkoutId: IdentifierSchema,
    seeds: Type.Array(IdentifierSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    relations: Type.Array(StringEnum(['imports', 'calls', 'references', 'contains', 'cochange']),
      { minItems: 1, maxItems: 5, uniqueItems: true }),
    maxDepth: Type.Integer({ minimum: 1, maximum: 8 }),
    maxItems: Type.Integer({ minimum: 1, maximum: 128 }),
    maxBytes: Type.Integer({ minimum: 1, maximum: 50 * 1024 }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('impact'), checkoutId: IdentifierSchema,
    seeds: Type.Array(IdentifierSchema, { maxItems: 32, uniqueItems: true }),
    relations: Type.Array(StringEnum(['imports', 'calls', 'references', 'contains', 'cochange']),
      { minItems: 1, maxItems: 5, uniqueItems: true }),
    maxDepth: Type.Integer({ minimum: 1, maximum: 8 }),
    maxItems: Type.Integer({ minimum: 1, maximum: 128 }),
    maxBytes: Type.Integer({ minimum: 1, maximum: 50 * 1024 }),
  }, { additionalProperties: false }),
], { type: 'object' });

export type StructureRequest = Type.Static<typeof StructureParameters>;
