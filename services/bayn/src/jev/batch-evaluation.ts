import { Clock, Context, Data, Effect, Exit } from 'effect'

import type { OperationalError } from '../errors'
import { freezeEvidence } from '../immutable-evidence'
import {
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
} from './batch'
import { JevEvaluationStore, type JevDispatch, type JevEvaluationRecord } from './evaluation'
import { evaluateClaimedEntryInferences, type EntryInferenceEvaluationOptions } from './entry-inference-batch'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { JevEvidenceError } from './evidence'
import { utcInstantFromEpochMillis } from '../time'
import type { MarketSnapshotReference } from '../market-data/intraday/model'
import { isPreparedJevBatch, type PreparedJevBatch } from './trading-signals'

export interface JevBatchEvidence {
  readonly plan: JevBatchPlan
  readonly result: JevBatchResult | null
}

const batchPreparations = new WeakMap<JevBatchEvidence, PreparedJevBatch>()

export const retainJevBatchPreparation = (evidence: JevBatchEvidence, prepared: PreparedJevBatch) => {
  if (isPreparedJevBatch(prepared) && evidence.plan.batchId === prepared.plan.batchId)
    batchPreparations.set(evidence, prepared)
  return evidence
}

export const retainedJevBatchPreparation = (evidence: JevBatchEvidence) => batchPreparations.get(evidence)

const ClaimedJevSourceTypeId: unique symbol = Symbol('ClaimedJevSource')
export type ClaimedJevSource = { readonly [ClaimedJevSourceTypeId]: true }

const claimedSources = new WeakMap<object, { readonly plan: JevBatchPlan; readonly seal: string }>()
const verifiedCompletions = new WeakMap<JevBatchResult, JevBatchPlan>()

export const makeClaimedJevSource = (plan: JevBatchPlan, seal: string): ClaimedJevSource => {
  const source = Object.freeze<ClaimedJevSource>({ [ClaimedJevSourceTypeId]: true })
  claimedSources.set(source, { plan: freezeEvidence(plan), seal })
  return source
}

export const readClaimedJevSource = (input: unknown) =>
  typeof input === 'object' && input !== null ? claimedSources.get(input) : undefined

export const isVerifiedJevCompletion = (plan: JevBatchPlan, result: JevBatchResult) =>
  verifiedCompletions.get(result) === plan

export interface JevBatchAdmission extends JevBatchEvidence {
  /** Null means admitted for durable inference; an empty array retains claimed-work recovery. */
  readonly dispatches: readonly JevDispatch[] | null
}

export type JevBatchEvaluationOptions = EntryInferenceEvaluationOptions

export type JevBatchAdmissionOptions = JevBatchEvaluationOptions &
  (
    | { readonly deferProviderDispatch: true; readonly sourceReference: MarketSnapshotReference }
    | { readonly deferProviderDispatch?: never }
  )

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
      batch: PreparedJevBatch,
      options?: JevBatchAdmissionOptions,
    ) => Effect.Effect<JevBatchAdmission, OperationalError | JevBatchExpired>
    readonly finish: (batchId: string) => Effect.Effect<JevBatchEvidence, OperationalError>
    readonly complete: (
      plan: JevBatchPlan,
      observation: unknown,
      result: JevBatchResult,
    ) => Effect.Effect<JevBatchEvidence, OperationalError>
  }
>()('@proompteng/bayn/JevBatchStore') {}

export const evaluateJevBatch = (batch: PreparedJevBatch, options: JevBatchEvaluationOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    const saved = yield* store.begin(batch, options)
    if (saved.result !== null) return { plan: saved.plan, result: saved.result }
    return yield* evaluateAdmittedJevBatch(saved, batch.source.payload, options)
  })

/** The same admitted cohort is used by local replay and the provider-only durable worker. */
export const evaluateAdmittedJevBatch = (
  saved: JevBatchAdmission,
  observation: unknown,
  options: JevBatchEvaluationOptions = {},
) =>
  Effect.gen(function* () {
    const store = yield* JevBatchStore
    if (saved.result !== null) return { plan: saved.plan, result: saved.result }
    const dispatches = saved.dispatches
    if (dispatches === null) return { plan: saved.plan, result: null }
    const requested = saved.plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
    if (dispatches.length !== requested.length) return yield* store.finish(saved.plan.batchId)
    const completions = yield* evaluateClaimedEntryInferences(dispatches, options).pipe(
      Effect.catchTag('EntryInferenceError', () => Effect.succeed(null)),
    )
    if (completions === null) return yield* store.finish(saved.plan.batchId)
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
        const dispatch = dispatches.find((item) => item.request.requestId === request.requestId)
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
      if (readClaimedJevSource(observation)?.plan === saved.plan)
        verifiedCompletions.set(freezeEvidence(result), saved.plan)
      return yield* store.complete(saved.plan, observation, result)
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
    return recovered.filter((batch) => batch.result === null).map((batch) => batch.plan)
  })
