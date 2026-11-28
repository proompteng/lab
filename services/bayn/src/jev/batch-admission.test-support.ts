import { Effect, Result } from 'effect'

import { operationalError } from '../errors'
import { decodeJevBatchPlan } from './batch'
import { evaluateJevBatch, type JevBatchAdmissionOptions, type JevBatchStore } from './batch-evaluation'
import { JevContractError } from './contract'
import { ownJevObservation, type JevObservation } from './observation'
import { prepareJevTradingSignalBatch } from './trading-signals'

export const verifyJevBatchAdmission = (input: unknown, observation: JevObservation) =>
  Result.gen(function* () {
    const plan = yield* decodeJevBatchPlan(input)
    const source = yield* ownJevObservation(observation)
    const batch = yield* prepareJevTradingSignalBatch(source, plan.expiresAt, plan.schemaVersion)
    if (batch.plan.batchId !== plan.batchId)
      return yield* Result.fail(
        new JevContractError({ message: 'Jev batch requests or candidate universe differ from the reproduced source' }),
      )
    return batch
  })

const verify = (plan: unknown, observation: JevObservation) =>
  Effect.suspend(() => Effect.fromResult(verifyJevBatchAdmission(plan, observation))).pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'database',
        operation: 'jev-batch',
        message: 'Jev batch evidence could not be durably verified',
        cause,
      }),
    ),
  )

export const beginRecordedJevBatch = (
  store: Pick<JevBatchStore['Service'], 'begin'>,
  plan: unknown,
  observation: JevObservation,
  options?: JevBatchAdmissionOptions,
) => verify(plan, observation).pipe(Effect.flatMap((batch) => store.begin(batch, options)))

export const evaluateRecordedJevBatch = (
  plan: unknown,
  observation: JevObservation,
  options?: JevBatchAdmissionOptions,
) => verify(plan, observation).pipe(Effect.flatMap((batch) => evaluateJevBatch(batch, options)))
