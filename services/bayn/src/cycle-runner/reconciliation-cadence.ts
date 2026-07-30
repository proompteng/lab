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
