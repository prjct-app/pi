import { StringEnum } from '@earendil-works/pi-ai';
import Type from 'typebox';
import Schema from '../typebox-schema.ts';
import type { ContextRequest } from './context-contract.ts';

const capability = StringEnum(['prjct_search', 'prjct_structure', 'prjct_refresh', 'prjct_work', 'prjct_plan',
  'prjct_task', 'prjct_checkpoint', 'prjct_reconcile', 'prjct_knowledge', 'prjct_artifact']);
export const DiscoveryResultSchema = Type.Object({
  status: StringEnum(['ok', 'partial', 'abstained']),
  checkoutId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' })),
  projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  stateRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  available: Type.Array(capability, { maxItems: 10, uniqueItems: true }),
  activated: Type.Array(capability, { maxItems: 10, uniqueItems: true }),
  gaps: Type.Array(Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }), { maxItems: 16 }),
}, { additionalProperties: false });
export type DiscoveryResult = Type.Static<typeof DiscoveryResultSchema>;
const validator = Schema.Compile(DiscoveryResultSchema);

// Declaration/result consistency only; does not activate or execute a tool.
// Pi's actual active tool state must be consulted by the integration owner.
export const validateDiscoveryResponse = (request: ContextRequest, result: unknown): void => {
  if (request.action !== 'discover' || !validator.Check(result) || result.activated.some(name => !result.available.includes(name))) {
    throw Object.assign(new Error('Invalid capability discovery result.'), { code: 'INVALID_RESULT' });
  }
  if (result.status === 'ok' && result.available.length === 0) {
    throw Object.assign(new Error('Successful discovery requires an offered capability.'), { code: 'INVALID_RESULT' });
  }
  if (result.status !== 'ok' && result.gaps.length === 0) {
    throw Object.assign(new Error('Unresolved discovery requires an explanation.'), { code: 'INVALID_RESULT' });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) {
    throw Object.assign(new Error('Discovery result exceeds the requested byte budget.'), { code: 'OUTPUT_LIMIT' });
  }
};
