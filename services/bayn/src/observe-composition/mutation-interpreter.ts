import { Effect } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import { AuthorityRestrictionStore } from '../db/execution-store'
import { MutationEventType, MutationStore, type MutationEvent } from '../execution/mutations'
import type { ExecutionProgram } from '../execution/runtime-program'
import { WriterFence } from '../execution/writer-fence'
import { CycleRunnerError } from '../cycle-runner'
import { currentUtcInstant } from '../time'
import { decideMutationIntentSettlement, type MutationIntentExecutionResult } from './mutation-decisions'
import { Pipeable } from '../pipeable'

export type PaperMutationExecutor<E, R> = {
  readonly submit?: (intentId: string, consistencyDelayMs: number) => Effect.Effect<MutationEvent, E, R>
  readonly recover: (intentId: string, operation: MutationOperation) => Effect.Effect<MutationEvent, E, R>
}

export const mutationConsistencyDelayMs = 1_000

export interface MutationRunnerErrorInput {
  readonly message: string
  readonly cause?: unknown
  readonly failure?: CycleRunnerError['failure']
}

export const mutationRunnerError = (input: MutationRunnerErrorInput): CycleRunnerError =>
  new CycleRunnerError({
    operation: 'recover-cycle',
    failure: input.failure ?? 'operational',
    message: input.message,
    cause: input.cause,
  })

const restrictMutationAuthorityDataFirst = (
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
          mutationRunnerError({
            message: 'authority restriction failed after a bound PAPER cycle failure',
            cause: { subject, reason, cause },
            failure: 'store',
          }),
        ),
      )
  })

export const restrictMutationAuthority = Pipeable.dual(2, restrictMutationAuthorityDataFirst)

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
    const existing = yield* store.latest(intentId, operation).pipe(
      Effect.mapError((cause) =>
        mutationRunnerError({
          message: `durable ${operation.toLowerCase()} recovery read failed`,
          cause,
          failure: 'store',
        }),
      ),
    )
    let event: MutationEvent
    if (existing === undefined) {
      if (action !== 'SUBMIT') {
        return yield* mutationRunnerError({
          message: `lookup-only PAPER recovery lost its durable ${operation.toLowerCase()} evidence`,
          cause: { intentId, action, operation },
          failure: 'contract',
        })
      }
      if (submitExpiresAt === undefined) {
        return yield* mutationRunnerError({
          message: 'fresh PAPER submit is missing its immutable submission cutoff',
          cause: undefined,
          failure: 'contract',
        })
      }
      const submitObservedAt = yield* now
      if (submitObservedAt >= submitExpiresAt) {
        return yield* mutationRunnerError({
          message: 'fresh PAPER submit crossed its immutable submission cutoff before broker I/O',
          cause: { intentId, submitObservedAt, submitExpiresAt },
          failure: 'contract',
        })
      }
      if (executor.submit === undefined) {
        return yield* mutationRunnerError({
          message: 'fresh PAPER submit is unavailable under OBSERVE recovery-only authority',
          cause: undefined,
          failure: 'contract',
        })
      }
      event = yield* executor
        .submit(intentId, mutationConsistencyDelayMs)
        .pipe(Effect.mapError((cause) => mutationRunnerError({ message: 'guarded PAPER submit failed', cause })))
    } else if (operation === MutationOperation.Submit && submitDoesNotRequireRecovery(existing.eventType)) {
      event = existing
    } else {
      event = yield* executor
        .recover(intentId, operation)
        .pipe(
          Effect.mapError((cause) =>
            mutationRunnerError({ message: `lookup-only PAPER ${operation.toLowerCase()} recovery failed`, cause }),
          ),
        )
    }
    const settlement = decideMutationIntentSettlement(event.eventType)
    if (settlement._tag === 'Unresolved') {
      return yield* mutationRunnerError({
        message: `guarded PAPER submit remains unresolved at ${settlement.eventType}`,
        cause: event,
        failure: 'operational',
      })
    }
    return { settlement, consistencyDelayMs: event.consistencyDelayMs, operation }
  })

const executeMutationIntentDataFirst = (
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

export const executeMutationIntent = Pipeable.by<
  (
    intentId: string,
    action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL' | 'SUBMIT',
    submitExpiresAt?: string,
  ) => (executionProgram: ExecutionProgram) => ReturnType<typeof executeMutationIntentDataFirst>,
  typeof executeMutationIntentDataFirst
>((arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null, executeMutationIntentDataFirst)
