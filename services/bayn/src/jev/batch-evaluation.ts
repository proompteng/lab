import { Context, Data, Effect } from 'effect'

import type { OperationalError } from '../errors'
import { decodeJevBatchPlan, type JevBatchPlan, type JevBatchResult } from './batch'
import { evaluateClaimedJevOnce, type JevDispatch } from './evaluation'
import type { JevObservation } from './observation'

export interface JevBatchEvidence {
  readonly plan: JevBatchPlan
  readonly result: JevBatchResult | null
}

export interface JevBatchAdmission extends JevBatchEvidence {
  readonly dispatches: readonly JevDispatch[]
}

export class JevBatchExpired extends Data.TaggedError('JevBatchExpired')<{
  readonly batchId: string
  readonly cycleId: string
  readonly observedAt: string
  readonly expiresAt: string
  readonly checkedAt: string
}> {}

export class JevBatchStore extends Context.Service<
  JevBatchStore,
  {
    readonly read: (batchId: string) => Effect.Effect<JevBatchEvidence | null, OperationalError>
    readonly pending: (
      cycleId: string,
      authorityGenerationHash?: string,
    ) => Effect.Effect<readonly string[], OperationalError>
    readonly begin: (
      plan: JevBatchPlan,
      observation: JevObservation,
    ) => Effect.Effect<JevBatchAdmission, OperationalError | JevBatchExpired>
    readonly finish: (batchId: string) => Effect.Effect<JevBatchEvidence, OperationalError>
  }
>()('@proompteng/bayn/JevBatchStore') {}

export const evaluateJevBatch = (input: unknown, observation: JevObservation) =>
  Effect.gen(function* () {
    const plan = yield* Effect.fromResult(decodeJevBatchPlan(input))
    const store = yield* JevBatchStore
    const saved = yield* store.begin(plan, observation)
    if (saved.result !== null) return { plan: saved.plan, result: saved.result }
    yield* Effect.forEach(
      saved.dispatches,
      (dispatch) =>
        evaluateClaimedJevOnce(dispatch).pipe(
          Effect.asVoid,
          Effect.catchTag('JevEvidenceError', () => Effect.void),
        ),
      { concurrency: Math.max(1, saved.dispatches.length), discard: true },
    )
    return yield* store.finish(plan.batchId)
  })

export const recoverPendingJevBatches = (cycleId: string, authorityGenerationHash: string) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    const pending = yield* store.pending(cycleId, authorityGenerationHash)
    const recovered = yield* Effect.forEach(pending, (batchId) => store.finish(batchId))
    return recovered.every((batch) => batch.result !== null)
  })
