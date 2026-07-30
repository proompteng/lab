import { Effect, Result } from 'effect'

import { CapitalGrantLifecycleStore } from '../db/execution-store'
import type { WriterFence } from '../execution/writer-fence'
import type { ExecutionPrepareFailure } from './failure'
import type { ExecutionPrepareReceipt } from './model'
import {
  authenticateExecutionPrepareDiscovery,
  makeExecutionPrepareReceipt,
  validateExecutionPrepareInput,
  type PrevalidatedExecutionPrepareInput,
  type ValidatedExecutionPrepareInput,
} from './validation'
import type { ExecutionCandidateDiscoveryReceipt } from '../execution-candidate-discovery'

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
          cause,
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
  trustedDiscoveryReceipt: ExecutionCandidateDiscoveryReceipt,
): Effect.Effect<ExecutionPrepareReceipt, ExecutionPrepareFailure, CapitalGrantLifecycleStore | WriterFence> =>
  Effect.gen(function* () {
    const prevalidated = yield* Effect.fromResult(validateExecutionPrepareInput(request, runtime))
    const validated = yield* Effect.fromResult(
      authenticateExecutionPrepareDiscovery(prevalidated, trustedDiscoveryReceipt),
    )
    return yield* prepareValidatedExecution(validated)
  })

export const authenticateValidatedExecutionPrepare = (
  prevalidated: PrevalidatedExecutionPrepareInput,
  trustedDiscoveryReceipt: ExecutionCandidateDiscoveryReceipt,
): Effect.Effect<ValidatedExecutionPrepareInput, ExecutionPrepareFailure> =>
  Effect.fromResult(authenticateExecutionPrepareDiscovery(prevalidated, trustedDiscoveryReceipt))
