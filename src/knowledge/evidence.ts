import type { ContentReference } from '../workspace/reference-schemas.ts';

export type EvidenceOrigin = 'host_observation' | 'tool_payload' | 'agent_report';
export type EvidenceRecord = Readonly<{
  id: string; provenance: 'native_observation' | 'agent_report'; origin: EvidenceOrigin;
  supports?: readonly ContentReference[];
}>;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

// Host-attributed capture only. A tool argument cannot mint native provenance
// or a verified standing. Existence of supports is not semantic correctness.
export const observeEvidence = (input: EvidenceRecord): EvidenceRecord => {
  if (input.provenance === 'native_observation' && input.origin !== 'host_observation') {
    fail('UNVERIFIABLE_ORIGIN', 'Native observation provenance is host-derived.');
  }
  if (input.provenance === 'native_observation' && input.supports === undefined) {
    fail('UNKNOWN_EVIDENCE_SCOPE', 'Native observations require known content support.');
  }
  return input;
};

export type ClaimSupport = Readonly<{ id: string; standing: 'candidate' | 'supported' | 'needs_review' | 'contradicted' | 'superseded';
  supports: readonly ContentReference[] }>;

export const applySupportChange = (claims: readonly ClaimSupport[], changed: readonly ContentReference[]): readonly ClaimSupport[] =>
  claims.map(claim => claim.supports.some(support => changed.some(item => item.id === support.id &&
    (item.revision !== support.revision || item.contentHash !== support.contentHash)))
    ? { ...claim, standing: 'needs_review' } : claim);
