import { Effect } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import { AuthorityRestrictionStore } from '../db/execution-store'
import { MutationEventType, MutationStore, type MutationEvent } from '../execution/mutations'
import type { ExecutionProgram } from '../execution/runtime-program'
import { WriterFence } from '../execution/writer-fence'
import { CycleRunnerError } from '../cycle-runner'
import { currentUtcInstant } from '../time'
import { decideMutationIntentSettlement, type MutationIntentExecutionResult } from './mutation-decisions'

export type PaperMutationExecutor<E, R> = {
  readonly submit?: (intentId: string, consistencyDelayMs: number) => Effect.Effect<MutationEvent, E, R>
  readonly recover: (intentId: string, operation: MutationOperation) => Effect.Effect<MutationEvent, E, R>
}

export const mutationConsistencyDelayMs = 1_000

export const mutationRunnerError = (
  message: string,
  cause?: unknown,
  failure: CycleRunnerError['failure'] = 'operational',
): CycleRunnerError =>
  new CycleRunnerError({
    operation: 'recover-cycle',
    failure,
    message,
    cause,
  })

export const restrictMutationAuthority = (
  subject: string,
  reason: string,
): Effect.Effect<void, CycleRunnerError, AuthorityRestrictionStore | WriterFence> =>
  Effect.gen(function* () {
    const store = yield* AuthorityRestrictionStore
    const fence = yield* WriterFence
    const updatedAt = yield* currentUtcInstant
    yield* fence
      .transaction(store.restrictAuthority(`${subject} restricted effective authority: ${reason}`, updatedAt))
      .pipe(
        Effect.mapError((cause) =>
          mutationRunnerError(
            'authority restriction failed after a bound PAPER cycle failure',
            { subject, reason, cause },
            'store',
          ),
        ),
      )
  })

export const restrictMutationLoopFailure = (
  error: CycleRunnerError,
): Effect.Effect<void, CycleRunnerError, AuthorityRestrictionStore | WriterFence> =>
  restrictMutationAuthority('PAPER autonomous cycle loop', `${error.operation}: ${error.message}`)

const submitDoesNotRequireRecovery = (eventType: MutationEvent['eventType']): boolean =>
  eventType === MutationEventType.SubmitRejected || eventType === MutationEventType.SubmitDenied

export const executeMutationIntentWithExecutor = <E, R>(
  executor: PaperMutationExecutor<E, R>,
  intentId: string,
  action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT',
  submitExpiresAt?: string,
  now: Effect.Effect<string, never, R> = currentUtcInstant,
): Effect.Effect<MutationIntentExecutionResult, CycleRunnerError, MutationStore | R> =>
  Effect.gen(function* () {
    const store = yield* MutationStore
    const operation = action === 'RECOVER_CANCEL' ? MutationOperation.Cancel : MutationOperation.Submit
    const existing = yield* store
      .latest(intentId, operation)
      .pipe(
        Effect.mapError((cause) =>
          mutationRunnerError(`durable ${operation.toLowerCase()} recovery read failed`, cause, 'store'),
        ),
      )
    let event: MutationEvent
    if (existing === undefined) {
      if (action !== 'SUBMIT') {
        return yield* Effect.fail(
          mutationRunnerError(
            `lookup-only PAPER recovery lost its durable ${operation.toLowerCase()} evidence`,
            { intentId, action, operation },
            'contract',
          ),
        )
      }
      if (submitExpiresAt === undefined) {
        return yield* Effect.fail(
          mutationRunnerError('fresh PAPER submit is missing its immutable submission cutoff', undefined, 'contract'),
        )
      }
      const submitObservedAt = yield* now
      if (submitObservedAt >= submitExpiresAt) {
        return yield* Effect.fail(
          mutationRunnerError(
            'fresh PAPER submit crossed its immutable submission cutoff before broker I/O',
            { intentId, submitObservedAt, submitExpiresAt },
            'contract',
          ),
        )
      }
      if (executor.submit === undefined) {
        return yield* Effect.fail(
          mutationRunnerError(
            'fresh PAPER submit is unavailable under OBSERVE recovery-only authority',
            undefined,
            'contract',
          ),
        )
      }
      event = yield* executor
        .submit(intentId, mutationConsistencyDelayMs)
        .pipe(Effect.mapError((cause) => mutationRunnerError('guarded PAPER submit failed', cause)))
    } else if (operation === MutationOperation.Submit && submitDoesNotRequireRecovery(existing.eventType)) {
      event = existing
    } else {
      event = yield* executor
        .recover(intentId, operation)
        .pipe(
          Effect.mapError((cause) =>
            mutationRunnerError(`lookup-only PAPER ${operation.toLowerCase()} recovery failed`, cause),
          ),
        )
    }
    const settlement = decideMutationIntentSettlement(event.eventType)
    if (settlement._tag === 'Unresolved') {
      return yield* Effect.fail(
        mutationRunnerError(`guarded PAPER submit remains unresolved at ${settlement.eventType}`, event, 'operational'),
      )
    }
    return { settlement, consistencyDelayMs: event.consistencyDelayMs, operation }
  })

export const executeMutationIntent = (
  executionProgram: ExecutionProgram,
  intentId: string,
  action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT',
  submitExpiresAt?: string,
): Effect.Effect<MutationIntentExecutionResult, CycleRunnerError, MutationStore> =>
  executeMutationIntentWithExecutor(
    {
      submit: executionProgram.submit,
      recover: executionProgram.recover,
    },
    intentId,
    action,
    submitExpiresAt,
    currentUtcInstant,
  )
