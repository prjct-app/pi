import type { ObservedRefreshState } from './refresh-contract.ts';

export type ComponentRefreshState = Readonly<{
  id: string; checkoutId: string;
  appliedRevision?: number; appliedConfigRevision?: number;
  lastAttempt: 'not_run' | 'succeeded' | 'failed' | 'cancelled';
}>;
export type RefreshView = Readonly<{
  freshness: 'current' | 'partial' | 'unavailable';
  currentComponents: readonly string[]; pendingComponents: readonly string[]; lastAttemptFailures: readonly string[];
}>;

// Describes committed mechanical state relative to the observed manifest, not
// current OS truth or semantic understanding. It does not scan, build or retry.
export const describeRefresh = (observed: ObservedRefreshState, requiredComponents: readonly string[],
  components: readonly ComponentRefreshState[]): RefreshView => {
  if (components.some(item => item.checkoutId !== observed.checkoutId)) {
    throw Object.assign(new Error('Component state belongs to another checkout.'), { code: 'CHECKOUT_MISMATCH' });
  }
  if (new Set(components.map(item => item.id)).size !== components.length || new Set(requiredComponents).size !== requiredComponents.length) {
    throw Object.assign(new Error('Component identities are ambiguous.'), { code: 'AMBIGUOUS_COMPONENT_STATE' });
  }
  const currentComponents: string[] = [];
  const pendingComponents: string[] = [];
  const lastAttemptFailures: string[] = [];
  for (const id of requiredComponents) {
    const component = components.find(item => item.id === id);
    if (component?.appliedRevision === observed.revision && component.appliedConfigRevision === observed.configRevision) {
      currentComponents.push(id);
    } else {
      pendingComponents.push(id);
    }
    if (component?.lastAttempt === 'failed' || component?.lastAttempt === 'cancelled') lastAttemptFailures.push(id);
  }
  return { freshness: currentComponents.length === 0 ? 'unavailable' : pendingComponents.length ? 'partial' : 'current',
    currentComponents, pendingComponents, lastAttemptFailures };
};
