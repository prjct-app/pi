import Type from 'typebox';
import Schema from '../typebox-schema.ts';
import { ContentReferenceSchema as reference, IdentifierSchema as id, PageCursorSchema, RevisionSchema as revision } from '../workspace/reference-schemas.ts';
import { MutationResultSchema } from '../workspace/mutation-result.ts';

const text = Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' });
const refs = Type.Array(reference, { maxItems: 32 });
const texts = Type.Array(text, { maxItems: 32 });
const ids = Type.Array(id, { maxItems: 64, uniqueItems: true });
const nullableRef = Type.Union([reference, Type.Null()]);
const grantStanding = Type.String({ enum: ['none', 'valid', 'uncertain', 'released', 'revoked'] });
const scope = Type.Object({ projectId: Type.Optional(id), workId: Type.Optional(id), taskId: Type.Optional(id), checkoutId: Type.Optional(id) },
  { additionalProperties: false });
const header = { status: Type.String({ enum: ['ok', 'partial', 'unavailable', 'unknown'] }), scope, gaps: texts,
  mutation: Type.Optional(MutationResultSchema), next: Type.Optional(PageCursorSchema) };

// Native-facing data declarations, not a tool runner or input-validation layer.
// State views are bounded projections, never the private persistence format.
export const stateResultSchemas = {
  prjct_work: Type.Object({ ...header, action: Type.String({ enum: ['list', 'inspect', 'create', 'select', 'link', 'transition'] }),
    items: Type.Array(Type.Object({ reference, projectId: id, title: text,
      disposition: Type.String({ enum: ['open', 'paused', 'completed', 'abandoned', 'archived'] }),
      activeSpecification: nullableRef, activePlan: nullableRef, tasks: refs, nextAction: text,
    }, { additionalProperties: false }), { maxItems: 32 }),
  }, { additionalProperties: false }),
  prjct_plan: Type.Object({ ...header, action: Type.String({ enum: ['inspect', 'draft', 'adopt'] }),
    items: Type.Array(Type.Object({ reference, kind: Type.String({ enum: ['spec', 'plan'] }),
      standing: Type.String({ enum: ['draft', 'active', 'superseded'] }), specification: nullableRef,
      tasks: Type.Array(Type.Object({ taskId: id, definitionRevision: revision }, { additionalProperties: false }), { maxItems: 64 }), criterionIds: ids, nextAction: text,
    }, { additionalProperties: false }), { maxItems: 32 }),
  }, { additionalProperties: false }),
  prjct_task: Type.Object({ ...header, action: Type.String({ enum: ['inspect', 'define', 'link', 'claim', 'transition', 'frontier'] }),
    items: Type.Array(Type.Object({ reference, workId: id, taskId: id,
      disposition: Type.String({ enum: ['not_started', 'in_progress', 'awaiting_input', 'ready_for_verification', 'completed', 'cancelled'] }),
      definition: nullableRef, criterionIds: ids, blockers: refs,
      attemptId: Type.Union([id, Type.Null()]), grantStanding, nextAction: text,
    }, { additionalProperties: false }), { maxItems: 32 }),
  }, { additionalProperties: false }),
  prjct_checkpoint: Type.Object({ ...header, action: Type.Literal('record'),
    recorded: Type.Object({ kind: Type.String({ enum: ['reuse_assessment', 'progress', 'assessment', 'decision_reference', 'work_assessment'] }),
      reference, nextAction: text,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  prjct_reconcile: Type.Object({ ...header, action: Type.String({ enum: ['inspect', 'continue'] }),
    predecessorAttemptId: Type.Union([id, Type.Null()]), writerStanding: grantStanding,
    observedEffects: Type.Array(Type.Object({ id, outcome: Type.String({ enum: ['committed', 'not_committed', 'unknown'] }) },
      { additionalProperties: false }), { maxItems: 32 }),
    requiredConfirmation: Type.Boolean(), unknowns: texts, nextAction: text,
  }, { additionalProperties: false }),
  prjct_knowledge: Type.Object({ ...header, action: Type.String({ enum: ['inspect', 'propose', 'resolve', 'replan', 'consolidate'] }),
    items: Type.Array(Type.Object({ reference, statement: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }),
      standing: Type.String({ enum: ['candidate', 'supported', 'needs_review', 'contradicted', 'superseded'] }),
      supports: refs, nextAction: text,
    }, { additionalProperties: false }), { maxItems: 32 }),
  }, { additionalProperties: false }),
  prjct_artifact: Type.Object({ ...header, action: Type.String({ enum: ['stage', 'publish', 'inspect', 'list', 'prepare_export'] }),
    items: Type.Array(Type.Object({ reference,
      kind: Type.String({ enum: ['research', 'spec', 'plan', 'prototype', 'questionnaire', 'analysis', 'handoff', 'evidence', 'note'] }),
      stagedBlobId: Type.Union([id, Type.Null()]), readLocator: Type.Union([text, Type.Null()]),
      exportIntent: Type.Union([text, Type.Null()]), nextAction: text,
    }, { additionalProperties: false }), { maxItems: 32 }),
  }, { additionalProperties: false }),
  prjct_refresh: Type.Object({ ...header, action: Type.String({ enum: ['inspect', 'apply'] }),
    freshness: Type.String({ enum: ['current', 'partial', 'unavailable'] }),
    observedRevision: Type.Optional(revision), configRevision: Type.Optional(revision),
    currentComponents: ids, pendingComponents: ids, lastAttemptFailures: ids, nextAction: text,
  }, { additionalProperties: false }),
};
const validators = Object.fromEntries(Object.entries(stateResultSchemas).map(([name, schema]) => [name, Schema.Compile(schema)]));

export type ResultRequest = Readonly<{ action: string; maxBytes: number; maxItems?: number; operationId?: string;
  projectId?: string; workId?: string; taskId?: string; checkoutId?: string }>;
export const validateStateResult = (name: string, request: ResultRequest, result: unknown): void => {
  const validator = validators[name];
  if (!validator || !validator.Check(result)) {
    throw Object.assign(new Error('Invalid state result projection.'), { code: 'INVALID_RESULT' });
  }
  if (result.action !== request.action) {
    throw Object.assign(new Error('State result does not match the requested action.'), { code: 'SCOPE_MISMATCH' });
  }
  for (const key of ['projectId', 'workId', 'taskId', 'checkoutId'] as const) {
    if (request[key] !== undefined && result.scope[key] !== request[key]) {
      throw Object.assign(new Error('State result does not match the requested scope.'), { code: 'SCOPE_MISMATCH' });
    }
  }
  if (request.operationId && result.mutation && result.mutation.operationId !== request.operationId) {
    throw Object.assign(new Error('Acknowledgement does not match the requested operation.'), { code: 'SCOPE_MISMATCH' });
  }
  if (request.maxItems !== undefined && 'items' in result && Array.isArray(result.items) && result.items.length > request.maxItems) {
    throw Object.assign(new Error('State result exceeds the requested item count.'), { code: 'OUTPUT_LIMIT' });
  }
  if (result.status === 'ok' && result.gaps.length > 0) {
    throw Object.assign(new Error('Successful state results cannot hide coverage gaps.'), { code: 'INVALID_RESULT' });
  }
  if (result.status !== 'ok' && result.gaps.length === 0) {
    throw Object.assign(new Error('Incomplete state coverage requires an explanation.'), { code: 'INVALID_RESULT' });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) {
    throw Object.assign(new Error('State result exceeds the requested byte budget.'), { code: 'OUTPUT_LIMIT' });
  }
};
