import { Clock, Context, Data, Effect, Exit } from 'effect'

import type { OperationalError } from '../errors'
import {
  decodeJevBatchPlan,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
} from './batch'
import { JevEvaluationStore, type JevDispatch, type JevEvaluationRecord } from './evaluation'
import { evaluateClaimedEntryInferences } from './entry-inference-batch'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'
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
    const requested = saved.plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
    if (saved.dispatches.length !== requested.length) return yield* store.finish(plan.batchId)
    const completions = yield* evaluateClaimedEntryInferences(saved.dispatches).pipe(
      Effect.catchTags({
        EntryInferenceError: () => Effect.succeed(null),
        JevContractError: () => Effect.succeed(null),
      }),
    )
    if (completions === null) return yield* store.finish(plan.batchId)
    const byRequest = new Map(completions.map((completion) => [completion.handoff.requestId, completion]))
    const records: JevEvaluationRecord[] = []
    return yield* Effect.gen(function* () {
      const candidates: JevBatchResult['candidates'][number][] = []
      for (const candidate of saved.plan.candidates) {
        if (candidate.status === JevCandidatePlanStatus.Excluded) {
          candidates.push({ symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded })
          continue
        }
        const request = candidate.request
        const completion = byRequest.get(request.requestId)
        const dispatch = saved.dispatches.find((item) => item.request.requestId === request.requestId)
        if (completion === undefined || dispatch === undefined)
          return yield* new JevEvidenceError({ message: 'Completed evaluations do not cover the admitted batch' })
        const receipt = yield* Effect.fromResult(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: request.requestId,
            startedAt: dispatch.claimedAt,
            completedAt: completion.completedAt,
            outcome: { status: JevOutcome.Completed, completion },
          }),
        )
        const resolution = yield* Effect.fromResult(
          makeJevResolution(request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
        records.push({ request, receipt })
        candidates.push({
          symbol: candidate.symbol,
          status: JevCandidateResultStatus.Resolved,
          requestId: request.requestId,
          receipt,
          resolution,
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
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && records.length > 0
          ? Effect.flatMap(JevEvaluationStore, (evaluations) => evaluations.recordAll(records)).pipe(Effect.asVoid)
          : Effect.void,
      ),
    )
  })

export const recoverPendingJevBatches = (cycleId: string, authorityGenerationHash: string) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    const pending = yield* store.pending(cycleId, authorityGenerationHash)
    const recovered = yield* Effect.forEach(pending, (batchId) => store.finish(batchId))
    return recovered.every((batch) => batch.result !== null)
  })
