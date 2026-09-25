import { Clock, Context, Effect } from 'effect'

import type { OperationalError } from '../errors'
import { decodeJevBatchPlan, JevCandidatePlanStatus, type JevBatchPlan, type JevBatchResult } from './batch'
import { evaluateJevOnce } from './evaluation'

export interface JevBatchEvidence {
  readonly plan: JevBatchPlan
  readonly result: JevBatchResult | null
}

export class JevBatchStore extends Context.Service<
  JevBatchStore,
  {
    readonly read: (batchId: string) => Effect.Effect<JevBatchEvidence | null, OperationalError>
    readonly pending: (
      cycleId: string,
      authorityGenerationHash: string,
    ) => Effect.Effect<readonly string[], OperationalError>
    readonly begin: (plan: JevBatchPlan) => Effect.Effect<JevBatchEvidence, OperationalError>
    readonly finish: (batchId: string) => Effect.Effect<JevBatchEvidence, OperationalError>
  }
>()('@proompteng/bayn/JevBatchStore') {}

export const evaluateJevBatch = (input: unknown) =>
  Effect.gen(function* () {
    const plan = yield* Effect.fromResult(decodeJevBatchPlan(input))
    const store = yield* JevBatchStore
    const saved = yield* store.begin(plan)
    if (saved.result !== null) return saved
    if ((yield* Clock.currentTimeMillis) < Date.parse(plan.expiresAt)) {
      yield* Effect.forEach(
        plan.candidates,
        (candidate) =>
          candidate.status === JevCandidatePlanStatus.Excluded
            ? Effect.void
            : evaluateJevOnce(candidate.request).pipe(
                Effect.asVoid,
                Effect.catchTag('JevEvidenceError', () => Effect.void),
              ),
        { concurrency: plan.candidates.length, discard: true },
      )
    }
    return yield* store.finish(plan.batchId)
  })

export const recoverJevBatch = (batchId: string) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    return yield* store.finish(batchId)
  })

export const recoverPendingJevBatches = (cycleId: string, authorityGenerationHash: string) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    const pending = yield* store.pending(cycleId, authorityGenerationHash)
    const recovered = yield* Effect.forEach(pending, (batchId) => store.finish(batchId))
    return recovered.every((batch) => batch.result !== null)
  })
