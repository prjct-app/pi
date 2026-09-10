// Pair execution identities, never redacted display strings. This establishes
// command equality and observation order, not causality or environment equality.
export type VerificationObservation = Readonly<{
  id: string;
  provenance: string;
  workId?: string;
  taskId?: string;
  commandIdentity?: string;
  execution?: Readonly<{ toolCallId: string; toolName: string; outcome: string }>;
}>;

export const hasVerificationPair = (
  observations: readonly VerificationObservation[],
  failedIds: readonly string[],
  succeededIds: readonly string[],
): boolean => {
  const failed = new Set(failedIds);
  const succeeded = new Set(succeededIds);
  return observations.some((red, redIndex) => failed.has(red.id)
    && red.provenance === 'native_observation' && red.execution?.toolName === 'bash'
    && red.execution.outcome === 'failed' && Boolean(red.commandIdentity)
    && Boolean(red.workId) && Boolean(red.taskId)
    && observations.some((green, greenIndex) => greenIndex > redIndex && succeeded.has(green.id)
      && green.provenance === 'native_observation' && green.execution?.toolName === 'bash'
      && green.execution.outcome === 'succeeded'
      && green.execution.toolCallId !== red.execution!.toolCallId
      && green.workId === red.workId && green.taskId === red.taskId
      && green.commandIdentity === red.commandIdentity));
};
