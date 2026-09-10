import Type from 'typebox';

import { IdentifierSchema, RevisionSchema, MAX_RESULT_BYTES } from '../workspace/reference-schemas.ts';

export const RefreshInspectSchema = Type.Object({
  action: Type.Literal('inspect'),
  checkoutId: IdentifierSchema,
}, { additionalProperties: false });

export const RefreshApplySchema = Type.Object({
  action: Type.Literal('apply'),
  checkoutId: IdentifierSchema,
  operationId: IdentifierSchema,
  expectedRevision: RevisionSchema,
  expectedConfigRevision: RevisionSchema,
}, { additionalProperties: false });

const resultBudget = Type.Integer({ minimum: 1, maximum: MAX_RESULT_BYTES });
export const RefreshParameters = Type.Union([
  Type.Object({ ...RefreshInspectSchema.properties, maxBytes: resultBudget }, { additionalProperties: false }),
  Type.Object({ ...RefreshApplySchema.properties, maxBytes: resultBudget }, { additionalProperties: false }),
], { type: 'object' });

export type RefreshRequest = Type.Static<typeof RefreshInspectSchema> | Type.Static<typeof RefreshApplySchema>;
export type ObservedRefreshState = {
  checkoutId: string;
  revision: number;
  configRevision: number;
};

export const assertRefreshPreconditions = (request: RefreshRequest, current: ObservedRefreshState): void => {
  if (request.checkoutId !== current.checkoutId) {
    throw Object.assign(new Error(`Refresh state belongs to ${current.checkoutId}, not ${request.checkoutId}.`), { code: 'CHECKOUT_MISMATCH' });
  }
  if (request.action === 'apply' && request.expectedConfigRevision !== current.configRevision) {
    throw Object.assign(new Error(`Extractor configuration changed; inspect before applying refresh. Current config revision is ${current.configRevision}.`), { code: 'STALE_CONFIG' });
  }
  if (request.action === 'apply' && request.expectedRevision !== current.revision) {
    throw Object.assign(new Error(`Observed source revision changed; inspect before applying refresh. Current revision is ${current.revision}.`), { code: 'STALE_REVISION' });
  }
};
