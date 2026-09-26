import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevEvaluationReceiptSchema,
  JevEvaluationRequestSchema,
  JevEvidenceError,
  usableJevInference,
} from './evidence'
import { decodeJevResolution, JevResolutionSchema, JevResolutionStatus } from './resolution'

export enum JevCandidatePlanStatus {
  Requested = 'REQUESTED',
  Excluded = 'EXCLUDED',
}

export enum JevCandidateResultStatus {
  Resolved = 'RESOLVED',
  Excluded = 'EXCLUDED',
  Unattempted = 'UNATTEMPTED',
}

export enum JevSourceExclusion {
  NotReady = 'not-ready',
  Freshness = 'freshness',
}

export enum JevEntryExclusion {
  Spread = 'spread',
  DisplayedSize = 'displayed-size',
}

export enum JevBatchPlanVersion {
  V1 = 'bayn.jev-batch-plan.v1',
  V2 = 'bayn.jev-batch-plan.v2',
  V3 = 'bayn.jev-batch-plan.v3',
}

const CandidatePlanSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal(JevCandidatePlanStatus.Requested),
    symbol: SymbolSchema,
    request: JevEvaluationRequestSchema,
  }),
  Schema.Struct({
    status: Schema.Literal(JevCandidatePlanStatus.Excluded),
    symbol: SymbolSchema,
    reason: Schema.Union([Schema.Enum(JevSourceExclusion), Schema.Enum(JevEntryExclusion)]),
    message: Schema.NonEmptyString,
  }),
])

const PlanMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Enum(JevBatchPlanVersion),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  observationHash: Sha256Schema,
  protocolHash: Sha256Schema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  benchmarkSymbol: SymbolSchema,
  questionSetHash: Sha256Schema,
  candidates: Schema.Array(CandidatePlanSchema),
})

export const JevBatchPlanSchema = Schema.Struct({ ...PlanMaterialSchema.fields, batchId: Sha256Schema })
export type JevBatchPlan = typeof JevBatchPlanSchema.Type

const CandidateResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal(JevCandidateResultStatus.Excluded), symbol: SymbolSchema }),
  Schema.Struct({
    status: Schema.Literal(JevCandidateResultStatus.Unattempted),
    symbol: SymbolSchema,
    requestId: Sha256Schema,
  }),
  Schema.Struct({
    status: Schema.Literal(JevCandidateResultStatus.Resolved),
    symbol: SymbolSchema,
    requestId: Sha256Schema,
    receipt: Schema.NullOr(JevEvaluationReceiptSchema),
    resolution: JevResolutionSchema,
  }),
])
const ResultMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-batch-result.v1'),
  batchId: Sha256Schema,
  completedAt: UtcInstantSchema,
  candidates: Schema.Array(CandidateResultSchema),
})
export const JevBatchResultSchema = Schema.Struct({ ...ResultMaterialSchema.fields, resultHash: Sha256Schema })
export type JevBatchResult = typeof JevBatchResultSchema.Type

const invalid = (message: string) => Result.fail(new JevEvidenceError({ message }))
const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(
    Result.mapError(() => new JevEvidenceError({ message: 'Jev batch evidence cannot be hashed' })),
  )

export const makeJevBatchPlan = (input: unknown) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(
      PlanMaterialSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => new JevEvidenceError({ message: 'Jev batch plan is malformed' })))
    const lifetime = Date.parse(material.expiresAt) - Date.parse(material.observedAt)
    if (lifetime <= 0 || lifetime > 10_000 || material.candidates.length === 0)
      return yield* invalid('Jev batch requires candidates and a bounded validity window')
    let previous = ''
    for (const candidate of material.candidates) {
      if (candidate.symbol <= previous || candidate.symbol === material.benchmarkSymbol)
        return yield* invalid('Jev batch candidates must be unique, sorted and distinct from the benchmark')
      previous = candidate.symbol
      if (candidate.status === JevCandidatePlanStatus.Excluded) {
        if (
          material.schemaVersion === JevBatchPlanVersion.V1 &&
          (candidate.reason === JevEntryExclusion.Spread || candidate.reason === JevEntryExclusion.DisplayedSize)
        )
          return yield* invalid('Version-one Jev batches cannot contain entry-quote exclusions')
        continue
      }
      const request = yield* decodeJevEvaluationRequest(candidate.request)
      if (
        request.symbol !== candidate.symbol ||
        request.cycleId !== material.cycleId ||
        request.authorityGenerationHash !== material.authorityGenerationHash ||
        request.snapshotId !== material.snapshotId ||
        request.observedAt !== material.observedAt ||
        request.expiresAt !== material.expiresAt ||
        (yield* hash({ model: request.request.model, questions: request.request.questions })) !==
          material.questionSetHash
      )
        return yield* invalid('Jev batch mixes candidate identity, observation, deadline or question set')
    }
    return { ...material, batchId: yield* hash(material) }
  })

export const decodeJevBatchPlan = (input: unknown) =>
  Result.gen(function* () {
    const { batchId, ...material } = yield* Schema.decodeUnknownResult(
      JevBatchPlanSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => new JevEvidenceError({ message: 'Stored Jev batch plan is malformed' })))
    const plan = yield* makeJevBatchPlan(material)
    if (plan.batchId !== batchId) return yield* invalid('Stored Jev batch identity differs')
    return plan
  })

export const makeJevBatchResult = (plan: JevBatchPlan, input: unknown) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(
      ResultMaterialSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => new JevEvidenceError({ message: 'Jev batch result is malformed' })))
    if (
      material.batchId !== plan.batchId ||
      material.completedAt < plan.observedAt ||
      material.candidates.length !== plan.candidates.length
    )
      return yield* invalid('Jev batch result must cover its entire plan after observation')
    for (const [index, candidate] of material.candidates.entries()) {
      const planned = plan.candidates[index]
      if (planned === undefined || planned.symbol !== candidate.symbol)
        return yield* invalid('Jev batch result omits, repeats or reorders a planned candidate')
      if (planned.status === JevCandidatePlanStatus.Excluded) {
        if (candidate.status !== JevCandidateResultStatus.Excluded)
          return yield* invalid('An excluded Jev candidate cannot acquire an inference')
        continue
      }
      if (candidate.status === JevCandidateResultStatus.Excluded || candidate.requestId !== planned.request.requestId)
        return yield* invalid('Jev batch result does not bind the planned request')
      if (candidate.status === JevCandidateResultStatus.Unattempted) {
        if (material.completedAt < plan.expiresAt)
          return yield* invalid('An unattempted Jev request cannot finalize before the batch deadline')
        continue
      }
      const receipt =
        candidate.receipt === null ? null : yield* decodeJevEvaluationReceipt(planned.request, candidate.receipt)
      const resolution = yield* decodeJevResolution(planned.request, receipt, candidate.resolution)
      if (
        (receipt !== null && receipt.completedAt > material.completedAt) ||
        (resolution.status === JevResolutionStatus.Abandoned && resolution.abandonedAt > material.completedAt)
      )
        return yield* invalid('Jev batch completion precedes a candidate result or abandonment')
    }
    return { ...material, resultHash: yield* hash(material) }
  })

export const decodeJevBatchResult = (plan: JevBatchPlan, input: unknown) =>
  Result.gen(function* () {
    const { resultHash, ...material } = yield* Schema.decodeUnknownResult(
      JevBatchResultSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => new JevEvidenceError({ message: 'Stored Jev batch result is malformed' })))
    const result = yield* makeJevBatchResult(plan, material)
    if (result.resultHash !== resultHash) return yield* invalid('Stored Jev batch result identity differs')
    return result
  })

export const usableJevBatchInferences = (sourcePlan: JevBatchPlan, sourceResult: JevBatchResult, now: number) =>
  Result.gen(function* () {
    const plan = yield* decodeJevBatchPlan(sourcePlan)
    const result = yield* decodeJevBatchResult(plan, sourceResult)
    if (!Number.isSafeInteger(now) || now < Date.parse(result.completedAt) || now >= Date.parse(plan.expiresAt))
      return yield* invalid('Jev batch decision is outside the complete batch validity window')
    const inferences = []
    for (const [index, candidate] of result.candidates.entries()) {
      const planned = plan.candidates[index]
      if (candidate.status === JevCandidateResultStatus.Excluded) continue
      if (
        planned?.status !== JevCandidatePlanStatus.Requested ||
        candidate.status !== JevCandidateResultStatus.Resolved ||
        candidate.resolution.status !== JevResolutionStatus.Recorded ||
        candidate.receipt === null
      )
        return yield* invalid('Every requested Jev candidate must have a recorded result before selection')
      const inference = yield* usableJevInference(planned.request, candidate.receipt, now)
      inferences.push({ symbol: candidate.symbol, requestId: candidate.requestId, inference })
    }
    if (
      inferences.length === 0 &&
      !plan.candidates.every(
        (candidate) =>
          candidate.status === JevCandidatePlanStatus.Excluded &&
          (candidate.reason === JevEntryExclusion.Spread || candidate.reason === JevEntryExclusion.DisplayedSize),
      )
    )
      return yield* invalid('No Jev candidate has usable inference evidence')
    return inferences
  })
