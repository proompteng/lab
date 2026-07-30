import { Effect, Result } from 'effect'

import { CapitalGrantLifecycleStore } from '../db/execution-store'
import type { WriterFence } from '../execution/writer-fence'
import type { ExecutionPrepareFailure } from './failure'
import type { ExecutionPrepareReceipt } from './model'
import {
  makeExecutionPrepareReceipt,
  validateExecutionPrepareInput,
  type ValidatedExecutionPrepareInput,
} from './validation'

export const prepareValidatedExecution = (
  validated: ValidatedExecutionPrepareInput,
): Effect.Effect<ExecutionPrepareReceipt, ExecutionPrepareFailure, CapitalGrantLifecycleStore | WriterFence> =>
  Effect.gen(function* () {
    const lifecycle = yield* CapitalGrantLifecycleStore
    const generation = yield* lifecycle.prepareCapitalGrant(validated.proof).pipe(
      Effect.mapError(
        (cause): ExecutionPrepareFailure => ({
          _tag: 'ExecutionPrepareStoreRejected',
          operation: cause.operation,
          failure: cause.failure,
        }),
      ),
    )
    const receipt = makeExecutionPrepareReceipt(validated, generation)
    if (Result.isFailure(receipt)) return yield* Effect.fail(receipt.failure)
    return receipt.success
  })

export const prepareExecution = (
  request: unknown,
  runtime: unknown,
): Effect.Effect<ExecutionPrepareReceipt, ExecutionPrepareFailure, CapitalGrantLifecycleStore | WriterFence> =>
  Effect.gen(function* () {
    const validated = yield* Effect.fromResult(validateExecutionPrepareInput(request, runtime))
    return yield* prepareValidatedExecution(validated)
  })
