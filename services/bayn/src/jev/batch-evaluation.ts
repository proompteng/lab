import { Clock, Context, Data, Effect } from 'effect'

import type { OperationalError } from '../errors'
import {
  decodeJevBatchPlan,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
} from './batch'
import { evaluateClaimedJevOnce, type JevDispatch } from './evaluation'
import { JevEvidenceError } from './evidence'
import type { JevObservation } from './observation'
import { utcInstantFromEpochMillis } from '../time'

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
    readonly complete: (
      plan: JevBatchPlan,
      observation: JevObservation,
      result: JevBatchResult,
    ) => Effect.Effect<JevBatchEvidence, OperationalError>
  }
>()('@proompteng/bayn/JevBatchStore') {}

export const evaluateJevBatch = (input: unknown, observation: JevObservation) =>
  Effect.gen(function* () {
    // Keep the admitted source private while provider I/O yields to other actors.
    const sourceObservation = structuredClone(observation)
    const plan = yield* Effect.fromResult(decodeJevBatchPlan(input))
    const store = yield* JevBatchStore
    const saved = yield* store.begin(plan, sourceObservation)
    if (saved.result !== null) return { plan: saved.plan, result: saved.result }
    const evaluations = yield* Effect.forEach(
      saved.dispatches,
      (dispatch) =>
        evaluateClaimedJevOnce(dispatch).pipe(Effect.catchTag('JevEvidenceError', () => Effect.succeed(null))),
      { concurrency: Math.max(1, saved.dispatches.length) },
    )
    const completed = evaluations.filter((evaluation) => evaluation !== null)
    const requested = saved.plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
    if (completed.length !== requested.length) return yield* store.finish(plan.batchId)
    const byRequest = new Map(completed.map((evaluation) => [evaluation.request.requestId, evaluation]))
    const candidates: JevBatchResult['candidates'][number][] = []
    for (const candidate of saved.plan.candidates) {
      if (candidate.status === JevCandidatePlanStatus.Excluded) {
        candidates.push({ symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded })
        continue
      }
      const evaluation = byRequest.get(candidate.request.requestId)
      if (evaluation === undefined)
        return yield* new JevEvidenceError({ message: 'Completed evaluations do not cover the admitted batch' })
      candidates.push({
        symbol: candidate.symbol,
        status: JevCandidateResultStatus.Resolved,
        requestId: candidate.request.requestId,
        receipt: evaluation.receipt,
        resolution: evaluation.resolution,
      })
    }
    const result = yield* Effect.fromResult(
      makeJevBatchResult(saved.plan, {
        schemaVersion: 'bayn.jev-batch-result.v1',
        batchId: saved.plan.batchId,
        completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
        candidates,
      }),
    )
    return yield* store.complete(saved.plan, sourceObservation, result)
  })

export const recoverPendingJevBatches = (cycleId: string, authorityGenerationHash: string) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    const pending = yield* store.pending(cycleId, authorityGenerationHash)
    const recovered = yield* Effect.forEach(pending, (batchId) => store.finish(batchId))
    return recovered.every((batch) => batch.result !== null)
  })
