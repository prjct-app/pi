// Pair execution identities, never redacted display strings. The substrate pins
// indexed test/config inputs. New journal observations use a writer-local
// monotonic sequence; legacy central rows fall back to their durable array
// order. Neither establishes causality, unindexed environment equality, or
// flake safety.
export type VerificationObservation = Readonly<{
  id: string;
  provenance: string;
  workId?: string;
  taskId?: string;
  attemptId?: string;
  sessionId?: string;
  checkoutId?: string;
  journalWriterId?: string;
  sessionSequence?: number;
  commandIdentity?: string;
  verificationSubstrate?: string;
  execution?: Readonly<{ toolCallId: string; toolName: string; outcome: string }>;
}>;

export const hasVerificationPair = (
  observations: readonly VerificationObservation[],
  failedIds: readonly string[],
  succeededIds: readonly string[],
): boolean => {
  const failed = new Set(failedIds);
  const succeeded = new Set(succeededIds);
  const orderedAfter = (red: VerificationObservation, green: VerificationObservation, redIndex: number, greenIndex: number) => {
    const legacyOrder = red.sessionSequence === undefined && green.sessionSequence === undefined;
    if (legacyOrder) return greenIndex > redIndex;
    return Number.isSafeInteger(red.sessionSequence) && Number.isSafeInteger(green.sessionSequence)
      && green.sessionSequence! > red.sessionSequence!
      && Boolean(red.attemptId) && green.attemptId === red.attemptId
      && Boolean(red.sessionId) && green.sessionId === red.sessionId
      && Boolean(red.journalWriterId) && green.journalWriterId === red.journalWriterId;
  };
  return observations.some((red, redIndex) => failed.has(red.id)
    && red.provenance === 'native_observation' && red.execution?.toolName === 'bash'
    && red.execution.outcome === 'failed' && Boolean(red.commandIdentity) && Boolean(red.verificationSubstrate)
    && Boolean(red.workId) && Boolean(red.taskId)
    && Boolean(red.attemptId) && Boolean(red.sessionId) && Boolean(red.checkoutId)
    && observations.some((green, greenIndex) => orderedAfter(red, green, redIndex, greenIndex) && succeeded.has(green.id)
      && green.provenance === 'native_observation' && green.execution?.toolName === 'bash'
      && green.execution.outcome === 'succeeded'
      && green.execution.toolCallId !== red.execution!.toolCallId
      && green.workId === red.workId && green.taskId === red.taskId
      && green.attemptId === red.attemptId && green.sessionId === red.sessionId
      && green.checkoutId === red.checkoutId
      && green.commandIdentity === red.commandIdentity
      && green.verificationSubstrate === red.verificationSubstrate));
};
