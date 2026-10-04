import { Result } from 'effect'

import {
  runnerError,
  type CycleRunnerError,
  type IdleReconciliationCadenceDecision,
  type ReconciliationCadenceState,
} from './model'
import { Pipeable } from '../../pipeable'

const nanosPerMillisecond = 1_000_000n

export const validateReconciliationInterval = (
  reconciliationIntervalMs: number,
): Result.Result<number, CycleRunnerError> =>
  Number.isSafeInteger(reconciliationIntervalMs) && reconciliationIntervalMs > 0
    ? Result.succeed(reconciliationIntervalMs)
    : Result.fail(
        runnerError({
          operation: 'configure',
          failure: 'invalid-config',
          message: 'reconciliation interval must be a positive safe integer',
        }),
      )

const validateCyclePassTimeoutDataFirst = (
  cyclePassTimeoutMs: number,
  reconciliationIntervalMs: number,
): Result.Result<number, CycleRunnerError> =>
  Number.isSafeInteger(cyclePassTimeoutMs) && cyclePassTimeoutMs > 0 && cyclePassTimeoutMs <= reconciliationIntervalMs
    ? Result.succeed(cyclePassTimeoutMs)
    : Result.fail(
        runnerError({
          operation: 'configure',
          failure: 'invalid-config',
          message: 'cycle pass timeout must be a positive safe integer no longer than the reconciliation interval',
        }),
      )

export const validateCyclePassTimeout = Pipeable.dual(2, validateCyclePassTimeoutDataFirst)

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

const decideIdleReconciliationCadenceDataFirst = (
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

export const decideIdleReconciliationCadence = Pipeable.dual(3, decideIdleReconciliationCadenceDataFirst)
