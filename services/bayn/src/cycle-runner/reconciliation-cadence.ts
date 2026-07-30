import { Result } from 'effect'

import {
  runnerError,
  type CycleRunnerError,
  type IdleReconciliationCadenceDecision,
  type ReconciliationCadenceState,
} from './model'

const nanosPerMillisecond = 1_000_000n

export const validateReconciliationInterval = (
  reconciliationIntervalMs: number,
): Result.Result<number, CycleRunnerError> =>
  Number.isSafeInteger(reconciliationIntervalMs) && reconciliationIntervalMs > 0
    ? Result.succeed(reconciliationIntervalMs)
    : Result.fail(runnerError('configure', 'invalid-config', 'reconciliation interval must be a positive safe integer'))

export const validateCyclePassTimeout = (
  cyclePassTimeoutMs: number,
  reconciliationIntervalMs: number,
): Result.Result<number, CycleRunnerError> =>
  Number.isSafeInteger(cyclePassTimeoutMs) && cyclePassTimeoutMs > 0 && cyclePassTimeoutMs <= reconciliationIntervalMs
    ? Result.succeed(cyclePassTimeoutMs)
    : Result.fail(
        runnerError(
          'configure',
          'invalid-config',
          'cycle pass timeout must be a positive safe integer no longer than the reconciliation interval',
        ),
      )

export const shouldDeferCyclePollForReconciliation = (input: {
  readonly lastAttemptAtNanos: bigint | undefined
  readonly nextPollAtNanos: bigint
  readonly pollStartAtNanos: bigint
  readonly reconciliationAtNanos: bigint
  readonly cyclePassTimeoutNanos: bigint
}): boolean => {
  const pollCoveredByLatestReconciliation =
    input.lastAttemptAtNanos !== undefined && input.nextPollAtNanos <= input.lastAttemptAtNanos
  return (
    !pollCoveredByLatestReconciliation &&
    input.pollStartAtNanos < input.reconciliationAtNanos &&
    input.pollStartAtNanos + input.cyclePassTimeoutNanos > input.reconciliationAtNanos
  )
}

export const decideIdleReconciliationCadence = (
  state: ReconciliationCadenceState,
  nowNanos: bigint,
  reconciliationIntervalMs: number,
): IdleReconciliationCadenceDecision => {
  const lastAttemptAtNanos = state.lastAttemptAtNanos
  if (lastAttemptAtNanos === undefined || nowNanos < lastAttemptAtNanos) return { _tag: 'RECONCILE' }
  const intervalNanos = BigInt(reconciliationIntervalMs) * nanosPerMillisecond
  const elapsedNanos = nowNanos - lastAttemptAtNanos
  return elapsedNanos >= intervalNanos
    ? { _tag: 'RECONCILE' }
    : { _tag: 'WAIT', remainingNanos: intervalNanos - elapsedNanos }
}
