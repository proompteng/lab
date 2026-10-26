import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import {
  IsoDateSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
import { JevOutcome } from './jev/evidence'
import { decodeHistoricalJevCostEvidence } from './jev/historical-inference-cost-evidence'
import { readSequentialInferenceCostEvidence } from './jev/sequential-inference-cost-evidence'
import { JevFailure, jevModel } from './jev/contract'
import { decisionsModel } from './jev/decisions'
import {
  ChartCheckpointSchema,
  decodeChartCheckpointForSource,
  verifyChartCheckpointHandoff,
} from './jev/chart-checkpoint'

export class InferenceCostError extends Data.TaggedError('InferenceCostError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
export enum InferenceUsageStatus {
  Received = 'RECEIVED_USAGE',
  Rejected = 'REJECTED_RESPONSE_USAGE',
  Unknown = 'UNKNOWN_USAGE',
  NotDispatched = 'NOT_DISPATCHED',
}
export enum InferenceCostCoverage {
  Estimated = 'METERED_ESTIMATE',
  Incomplete = 'INCOMPLETE',
}
export enum InferencePurpose {
  Entry = 'ENTRY',
  Manage = 'MANAGE',
  Other = 'OTHER',
}
export enum InferenceStage {
  Chart = 'CHART',
  Jev = 'JEV',
}

const RateCommon = {
  model: StrictNonEmptyStringSchema,
  currency: Schema.Literal('USD'),
  source: StrictNonEmptyStringSchema,
  effectiveFrom: UtcInstantSchema,
  effectiveUntil: UtcInstantSchema,
  inputMicrosPerMillionTokens: UnsignedMicrosSchema,
  outputMicrosPerMillionTokens: UnsignedMicrosSchema,
}
export const HistoricalInferenceRateSchema = Schema.Struct({ provider: Schema.Literal('typesafe'), ...RateCommon })
export const InferenceRateSchema = Schema.Union([
  HistoricalInferenceRateSchema,
  Schema.Struct({
    provider: Schema.Literal('openai'),
    ...RateCommon,
    cachedInputMicrosPerMillionTokens: UnsignedMicrosSchema,
    cacheWriteInputMicrosPerMillionTokens: UnsignedMicrosSchema,
  }),
])
export const InferenceRateCardSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.inference-rate-card.v1'),
  rates: Schema.Array(InferenceRateSchema),
})
export const InferenceCostRequestSchema = Schema.Struct({
  requestId: Sha256Schema,
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  request: Schema.Unknown,
  receipt: Schema.NullOr(Schema.Unknown),
  resolution: Schema.NullOr(Schema.Unknown),
  handoff: Schema.NullOr(Schema.Unknown),
  chartCheckpoint: Schema.optionalKey(ChartCheckpointSchema),
})
export const InferenceCostEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literals(['bayn.inference-cost-evidence.v2', 'bayn.inference-cost-evidence.v3']),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  requests: Schema.Array(InferenceCostRequestSchema),
})
export type InferenceCostEvidence = typeof InferenceCostEvidenceSchema.Type
const HistoricalCostRequestSchema = Schema.Struct({
  requestId: Sha256Schema,
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  request: Schema.Unknown,
  receipt: Schema.NullOr(Schema.Unknown),
  resolution: Schema.NullOr(Schema.Unknown),
})
const HistoricalCostEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.inference-cost-evidence.v1'),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  requests: Schema.Array(HistoricalCostRequestSchema),
})
const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const MeteredResponse = Schema.Struct({
  model: StrictNonEmptyStringSchema,
  usage: Schema.Struct({ input_tokens: TokenCount, output_tokens: TokenCount }),
})
const PurposeState = Schema.Struct({ task: Schema.Struct({ decisionPurpose: Schema.Enum(InferencePurpose) }) })
const LineCommon = {
  requestId: Sha256Schema,
  cycleId: Sha256Schema,
  receiptHash: Schema.NullOr(Sha256Schema),
  resolutionHash: Schema.NullOr(Sha256Schema),
  model: StrictNonEmptyStringSchema,
  purpose: Schema.Enum(InferencePurpose),
  usageStatus: Schema.Enum(InferenceUsageStatus),
  inputTokens: Schema.NullOr(UnsignedMicrosSchema),
  outputTokens: Schema.NullOr(UnsignedMicrosSchema),
  rateHash: Schema.NullOr(Sha256Schema),
  estimatedCostPicoUsd: Schema.NullOr(UnsignedMicrosSchema),
}
export const HistoricalInferenceCostLineSchema = Schema.Struct(LineCommon)
export const StagedInferenceCostLineSchema = Schema.Struct({
  ...LineCommon,
  stage: Schema.Enum(InferenceStage),
  handoffHash: Schema.NullOr(Sha256Schema),
  cachedInputTokens: Schema.NullOr(UnsignedMicrosSchema),
  cacheWriteInputTokens: Schema.NullOr(UnsignedMicrosSchema),
})
export const CheckpointInferenceCostLineSchema = Schema.Struct({
  ...StagedInferenceCostLineSchema.fields,
  stage: Schema.Literal(InferenceStage.Chart),
  chartClaimHash: Sha256Schema,
  chartTerminalHash: Schema.NullOr(Sha256Schema),
})
export const InferenceCostLineSchema = Schema.Union([
  CheckpointInferenceCostLineSchema,
  StagedInferenceCostLineSchema,
  HistoricalInferenceCostLineSchema,
])
export type InferenceCostLine = typeof InferenceCostLineSchema.Type
export const inferenceStageKey = (line: Pick<InferenceCostLine, 'requestId'> & { readonly stage?: InferenceStage }) =>
  line.stage === InferenceStage.Chart ? `${line.requestId}:CHART` : line.requestId

interface Usage {
  readonly inputTokens: bigint
  readonly outputTokens: bigint
  readonly cachedInputTokens: bigint
  readonly cacheWriteInputTokens: bigint
  readonly status: InferenceUsageStatus.Received | InferenceUsageStatus.Rejected | InferenceUsageStatus.NotDispatched
}
const usage = (
  value: { readonly input_tokens: number; readonly output_tokens: number },
  status: Usage['status'],
): Usage => ({
  inputTokens: BigInt(value.input_tokens),
  outputTokens: BigInt(value.output_tokens),
  cachedInputTokens: 0n,
  cacheWriteInputTokens: 0n,
  status,
})
const notDispatched = (): Usage => usage({ input_tokens: 0, output_tokens: 0 }, InferenceUsageStatus.NotDispatched)
type Stage = {
  readonly stage: InferenceStage | null
  readonly provider: 'openai' | 'typesafe'
  readonly model: string
  readonly usage: Usage | null
  readonly startedAt: string | undefined
  readonly purpose: InferencePurpose
  readonly handoffHash: string | null
  readonly receiptHash: string | null
  readonly resolutionHash: string | null
  readonly chartClaimHash?: string
  readonly chartTerminalHash?: string | null
}
const failure = (message: string) => Result.fail(new InferenceCostError({ message }))

const costStages = (row: typeof InferenceCostRequestSchema.Type) =>
  Result.gen(function* () {
    const version = yield* Schema.decodeUnknownResult(
      Schema.Struct({
        schemaVersion: Schema.Literals(['bayn.jev-evaluation-request.v1', 'bayn.jev-evaluation-request.v2']),
      }),
    )(row.request)
    if (version.schemaVersion === 'bayn.jev-evaluation-request.v1') {
      if (row.chartCheckpoint !== undefined) return yield* failure('Historical requests cannot carry chart checkpoints')
      if (row.handoff !== null)
        return yield* failure('Historical single-provider evidence cannot carry a chart handoff')
      const { request, receipt, resolution } = yield* decodeHistoricalJevCostEvidence(
        row.request,
        row.receipt,
        row.resolution,
      )
      const raw =
        receipt?.outcome.status === 'RECEIVED'
          ? receipt.outcome.inference.response
          : receipt?.outcome.status === 'FAILED' && receipt.outcome.responseHash !== null
            ? receipt.outcome.rejectedResponse
            : null
      const metered = Schema.decodeUnknownResult(MeteredResponse)(raw)
      const counted =
        receipt?.outcome.status === 'FAILED' && receipt.outcome.failure === JevFailure.NotDispatched
          ? notDispatched()
          : Result.isSuccess(metered) && metered.success.model === request.request.model
            ? usage(
                metered.success.usage,
                receipt?.outcome.status === 'RECEIVED' ? InferenceUsageStatus.Received : InferenceUsageStatus.Rejected,
              )
            : null
      const purpose = Schema.decodeUnknownResult(PurposeState)(request.request.state)
      return {
        request,
        receipt,
        resolution,
        handoffAt: null,
        stages: [
          {
            stage: null,
            provider: 'typesafe',
            model: request.request.model,
            usage: counted,
            startedAt:
              receipt?.outcome.status === 'RECEIVED' ? receipt.outcome.inference.startedAt : receipt?.startedAt,
            purpose: Result.isSuccess(purpose) ? purpose.success.task.decisionPurpose : InferencePurpose.Other,
            handoffHash: null,
            receiptHash: receipt?.receiptHash ?? null,
            resolutionHash: resolution?.resolutionHash ?? null,
          } satisfies Stage,
        ],
      }
    }
    const { request, receipt, resolution, handoff, chartRequest } = yield* readSequentialInferenceCostEvidence(row)
    if (
      receipt?.outcome.status === JevOutcome.Completed &&
      (handoff === null || handoff.handoffHash !== receipt.outcome.completion.handoff.handoffHash)
    )
      return yield* failure('Completed inference cost evidence differs from its committed chart handoff')
    const zero = receipt?.outcome.status === JevOutcome.Failed && receipt.outcome.failure === JevFailure.NotDispatched
    const checkpoint =
      row.chartCheckpoint === undefined
        ? undefined
        : yield* decodeChartCheckpointForSource({ ...request, chartRequest }, row.chartCheckpoint)
    if (checkpoint !== undefined && zero)
      return yield* failure('Undispatched evidence cannot omit a committed chart claim')
    if (checkpoint !== undefined && handoff !== null) yield* verifyChartCheckpointHandoff(checkpoint, handoff)
    if (zero && handoff !== null) return yield* failure('Undispatched cost evidence omits a committed chart call')
    let chartUsage: Usage | null = zero ? notDispatched() : null
    let chartStartedAt: string | undefined = receipt?.startedAt
    if (handoff !== null) {
      const disposition = handoff.disposition
      if (disposition.status === 'SOURCE_INFEASIBLE') {
        chartUsage = notDispatched()
        chartStartedAt = undefined
      } else {
        const metering =
          disposition.status === 'VISUAL_FAILED'
            ? disposition.failure.usage
            : disposition.visual.requestHash === handoff.visualRequestHash
              ? disposition.visual.response.usage
              : null
        chartStartedAt = disposition.status === 'VISUAL_FAILED' ? request.observedAt : disposition.visual.startedAt
        if (metering !== null)
          chartUsage = {
            ...usage(
              metering,
              disposition.status === 'VISUAL_FAILED' || disposition.status === 'PREPARATION_FAILED'
                ? InferenceUsageStatus.Rejected
                : InferenceUsageStatus.Received,
            ),
            cachedInputTokens: BigInt(metering.input_tokens_details.cached_tokens),
            cacheWriteInputTokens: BigInt(metering.input_tokens_details.cache_write_tokens),
          }
      }
    }
    if (checkpoint !== undefined) {
      chartStartedAt = checkpoint.claim.claimedAt
      const terminal = checkpoint.terminal
      const metering =
        terminal?.outcome.status === 'RECEIVED'
          ? terminal.outcome.inference.response.usage
          : terminal?.outcome.status === 'FAILED'
            ? terminal.outcome.failure.usage
            : null
      chartUsage =
        metering == null
          ? null
          : {
              ...usage(
                metering,
                terminal?.outcome.status === 'RECEIVED' ? InferenceUsageStatus.Received : InferenceUsageStatus.Rejected,
              ),
              cachedInputTokens: BigInt(metering.input_tokens_details.cached_tokens),
              cacheWriteInputTokens: BigInt(metering.input_tokens_details.cache_write_tokens),
            }
      if (terminal?.outcome.status === 'RECEIVED') chartStartedAt = terminal.outcome.inference.startedAt
    }
    let jevUsage: Usage | null =
      zero || (handoff !== null && handoff.disposition.status !== 'READY') ? notDispatched() : null
    let jevStartedAt: string | undefined = undefined
    if (receipt?.outcome.status === JevOutcome.Completed) {
      const result = receipt.outcome.completion.jev
      if (result.status === 'RECEIVED') {
        jevUsage = usage(result.inference.response.usage, InferenceUsageStatus.Received)
        jevStartedAt = result.inference.startedAt
      } else if (result.status === 'FAILED') {
        jevUsage = result.usage === null ? null : usage(result.usage, InferenceUsageStatus.Rejected)
        jevStartedAt = handoff?.recordedAt
      } else jevUsage = notDispatched()
    }
    const chartIdentity = {
      handoffHash: handoff?.handoffHash ?? null,
      receiptHash: zero ? (receipt?.receiptHash ?? null) : null,
      resolutionHash: zero ? (resolution?.resolutionHash ?? null) : null,
    }
    const jevSkipped = handoff !== null && handoff.disposition.status !== 'READY'
    const stages: readonly Stage[] = [
      {
        ...chartIdentity,
        ...(checkpoint === undefined
          ? {}
          : {
              chartClaimHash: checkpoint.claim.claimHash,
              chartTerminalHash: checkpoint.terminal?.terminalHash ?? null,
              handoffHash: null,
              receiptHash: null,
              resolutionHash: null,
            }),
        stage: InferenceStage.Chart,
        provider: 'openai',
        model: decisionsModel,
        usage: chartUsage,
        startedAt: chartStartedAt,
        purpose: InferencePurpose.Entry,
      },
      {
        stage: InferenceStage.Jev,
        provider: 'typesafe',
        model: jevModel,
        usage: jevUsage,
        startedAt: jevStartedAt,
        purpose: InferencePurpose.Entry,
        handoffHash: handoff?.handoffHash ?? null,
        receiptHash: jevSkipped ? null : (receipt?.receiptHash ?? null),
        resolutionHash: jevSkipped ? null : (resolution?.resolutionHash ?? null),
      },
    ]
    return { request, receipt, resolution, handoffAt: handoff?.recordedAt ?? null, stages }
  }).pipe(
    Result.mapError(
      (cause) => new InferenceCostError({ message: 'Inference cost source graph does not reproduce', cause }),
    ),
  )

export const priceInferenceUsage = (
  input: {
    readonly inputTokens: bigint
    readonly outputTokens: bigint
    readonly cachedInputTokens: bigint
    readonly cacheWriteInputTokens: bigint
  },
  rate: typeof InferenceRateSchema.Type,
) => {
  if (
    input.cachedInputTokens + input.cacheWriteInputTokens > input.inputTokens ||
    input.cachedInputTokens < 0n ||
    input.cacheWriteInputTokens < 0n
  )
    return failure('Cached input usage exceeds total provider input')
  if (rate.provider === 'typesafe' && (input.cachedInputTokens !== 0n || input.cacheWriteInputTokens !== 0n))
    return failure('TypeSafe usage cannot carry OpenAI cache metering')
  return Result.succeed(
    rate.provider === 'typesafe'
      ? input.inputTokens * BigInt(rate.inputMicrosPerMillionTokens) +
          input.outputTokens * BigInt(rate.outputMicrosPerMillionTokens)
      : (input.inputTokens - input.cachedInputTokens - input.cacheWriteInputTokens) *
          BigInt(rate.inputMicrosPerMillionTokens) +
          input.cachedInputTokens * BigInt(rate.cachedInputMicrosPerMillionTokens) +
          input.cacheWriteInputTokens * BigInt(rate.cacheWriteInputMicrosPerMillionTokens) +
          input.outputTokens * BigInt(rate.outputMicrosPerMillionTokens),
  )
}

export interface InferenceCostReport {
  readonly schemaVersion: 'bayn.inference-cost-report.v2'
  readonly accountBindingHash: string
  readonly sessionDate: string
  readonly asOf: string
  readonly evidenceHash: string
  readonly rateCardHash: string
  readonly coverage: InferenceCostCoverage
  readonly invoiceReconciled: false
  readonly requestCount: number
  readonly providerRequestCount: number
  readonly meteredRequestCount: number
  readonly rejectedResponseUsageCount: number
  readonly notDispatchedRequestCount: number
  readonly unknownUsageCount: number
  readonly unpricedUsageCount: number
  readonly inputTokens: string
  readonly outputTokens: string
  readonly knownEstimatedCostPicoUsd: string
  readonly knownEstimatedCostMicros: string
  readonly estimatedTotalCostMicros: string | null
  readonly requests: readonly InferenceCostLine[]
  readonly reportHash: string
}

export type DecodedInferenceCostRequest = typeof InferenceCostRequestSchema.Type & {
  readonly requestSchemaVersion: 'bayn.jev-evaluation-request.v1' | 'bayn.jev-evaluation-request.v2'
  readonly sourceFingerprint: string
  readonly stages: readonly Stage[]
}
export type DecodedInferenceCostEvidence = Omit<InferenceCostEvidence, 'schemaVersion' | 'requests'> & {
  readonly schemaVersion:
    | 'bayn.inference-cost-evidence.v1'
    | 'bayn.inference-cost-evidence.v2'
    | 'bayn.inference-cost-evidence.v3'
  readonly requests: readonly DecodedInferenceCostRequest[]
}

/** Reproduce each immutable source once, while its snapshot cursor is making progress. */
export const decodeInferenceCostRequest = (input: unknown, asOf: string) =>
  Result.gen(function* () {
    const row = yield* Schema.decodeUnknownResult(InferenceCostRequestSchema, strictParseOptions)(input)
    if (
      row.chartCheckpoint !== undefined &&
      (row.chartCheckpoint.claim.claimedAt > asOf ||
        (row.chartCheckpoint.terminal !== null && row.chartCheckpoint.terminal.recordedAt > asOf))
    )
      return yield* failure('Chart checkpoint exceeds the financial snapshot cut')
    const graph = yield* costStages(row)
    const { request, receipt, resolution } = graph
    if (
      request.requestId !== row.requestId ||
      request.cycleId !== row.cycleId ||
      request.authorityGenerationHash !== row.authorityGenerationHash ||
      request.observedAt > asOf
    )
      return yield* failure('Inference request scope differs')
    if (
      (receipt !== null && receipt.completedAt > asOf) ||
      (resolution !== null && 'abandonedAt' in resolution && resolution.abandonedAt > asOf) ||
      (graph.handoffAt !== null && graph.handoffAt > asOf)
    )
      return yield* failure('Inference evidence exceeds its as-of cut')
    return {
      ...row,
      requestSchemaVersion: request.schemaVersion,
      sourceFingerprint: yield* canonicalHashV1Result(row),
      stages: graph.stages,
    } satisfies DecodedInferenceCostRequest
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof InferenceCostError
        ? cause
        : new InferenceCostError({ message: 'Inference cost source is malformed', cause }),
    ),
  )

export const decodeInferenceCostEvidence = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(
      Schema.Union([InferenceCostEvidenceSchema, HistoricalCostEvidenceSchema]),
      strictParseOptions,
    )(input)
    const sourceRows =
      evidence.schemaVersion !== 'bayn.inference-cost-evidence.v1'
        ? evidence.requests
        : evidence.requests.map((row) => ({ ...row, handoff: null }))
    const requests = yield* Result.all(sourceRows.map((row) => decodeInferenceCostRequest(row, evidence.asOf)))
    if (
      evidence.schemaVersion !== 'bayn.inference-cost-evidence.v3' &&
      requests.some((row) => row.chartCheckpoint !== undefined)
    )
      return yield* failure('Chart checkpoints require versioned financial evidence')
    if (
      evidence.schemaVersion === 'bayn.inference-cost-evidence.v1' &&
      requests.some((row) => row.requestSchemaVersion !== 'bayn.jev-evaluation-request.v1')
    )
      return yield* failure('Historical financial evidence cannot carry current execution requests')
    return { ...evidence, requests } satisfies DecodedInferenceCostEvidence
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof InferenceCostError
        ? cause
        : new InferenceCostError({ message: 'Inference cost evidence is malformed', cause }),
    ),
  )

/** Operating-expense evidence only; broker cash and trading authority are separate ledgers. */
export const makeInferenceCostReport = (
  evidence: DecodedInferenceCostEvidence,
  rateCardInput: unknown,
): Result.Result<InferenceCostReport, InferenceCostError> =>
  Result.gen(function* () {
    const rateCard = yield* Schema.decodeUnknownResult(InferenceRateCardSchema, strictParseOptions)(rateCardInput)
    for (const [index, rate] of rateCard.rates.entries()) {
      if (rate.effectiveFrom >= rate.effectiveUntil) return yield* failure('Inference rate interval must be nonempty')
      if (
        rateCard.rates
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.provider === rate.provider &&
              earlier.model === rate.model &&
              earlier.effectiveFrom < rate.effectiveUntil &&
              rate.effectiveFrom < earlier.effectiveUntil,
          )
      )
        return yield* failure('Inference rate intervals overlap')
    }
    const rates = yield* Result.all(
      rateCard.rates.map((rate) => canonicalHashV1Result(rate).pipe(Result.map((rateHash) => ({ rate, rateHash })))),
    )
    const rateCardHash = yield* canonicalHashV1Result({
      schemaVersion: rateCard.schemaVersion,
      rates: [...rates].sort((a, b) => a.rateHash.localeCompare(b.rateHash)).map((value) => value.rate),
    })
    const fingerprints = new Map<string, string>()
    const lines: InferenceCostLine[] = []
    let inputTokens = 0n,
      outputTokens = 0n,
      totalPicoUsd = 0n,
      unknownUsageCount = 0,
      notDispatchedRequestCount = 0,
      unpricedUsageCount = 0,
      rejectedResponseUsageCount = 0
    for (const row of evidence.requests) {
      const prior = fingerprints.get(row.requestId)
      if (prior !== undefined) {
        if (prior !== row.sourceFingerprint) return yield* failure('Duplicate inference evidence conflicts')
        continue
      }
      fingerprints.set(row.requestId, row.sourceFingerprint)
      for (const stage of row.stages) {
        const measured = stage.usage
        const startedAt = stage.startedAt
        const priced =
          measured === null || measured.status === InferenceUsageStatus.NotDispatched || startedAt === undefined
            ? undefined
            : rates.find(
                ({ rate }) =>
                  rate.provider === stage.provider &&
                  rate.model === stage.model &&
                  rate.effectiveFrom <= startedAt &&
                  startedAt < rate.effectiveUntil,
              )
        const cost =
          measured?.status === InferenceUsageStatus.NotDispatched
            ? 0n
            : measured === null || priced === undefined
              ? null
              : yield* priceInferenceUsage(measured, priced.rate)
        const common = {
          requestId: row.requestId,
          cycleId: row.cycleId,
          receiptHash: stage.receiptHash,
          resolutionHash: stage.resolutionHash,
          model: stage.model,
          purpose: stage.purpose,
          usageStatus: measured?.status ?? InferenceUsageStatus.Unknown,
          inputTokens: measured?.inputTokens.toString() ?? null,
          outputTokens: measured?.outputTokens.toString() ?? null,
          rateHash: priced?.rateHash ?? null,
          estimatedCostPicoUsd: cost?.toString() ?? null,
        }
        lines.push(
          stage.stage === null
            ? common
            : {
                ...common,
                stage: stage.stage,
                ...(stage.chartClaimHash === undefined
                  ? {}
                  : { chartClaimHash: stage.chartClaimHash, chartTerminalHash: stage.chartTerminalHash ?? null }),
                handoffHash: stage.handoffHash,
                cachedInputTokens: measured?.cachedInputTokens.toString() ?? null,
                cacheWriteInputTokens: measured?.cacheWriteInputTokens.toString() ?? null,
              },
        )
        if (measured === null) unknownUsageCount++
        else {
          inputTokens += measured.inputTokens
          outputTokens += measured.outputTokens
          if (measured.status === InferenceUsageStatus.NotDispatched) notDispatchedRequestCount++
          if (measured.status === InferenceUsageStatus.Rejected) rejectedResponseUsageCount++
          if (cost === null) unpricedUsageCount++
          else totalPicoUsd += cost
        }
      }
    }
    const requests = lines.sort((a, b) => inferenceStageKey(a).localeCompare(inferenceStageKey(b)))
    const evidenceHash = yield* canonicalHashV1Result({
      schemaVersion: evidence.schemaVersion,
      accountBindingHash: evidence.accountBindingHash,
      sessionDate: evidence.sessionDate,
      asOf: evidence.asOf,
      requests: requests.map((line) => ({
        requestId: line.requestId,
        stage: 'stage' in line ? line.stage : null,
        handoffHash: 'handoffHash' in line ? line.handoffHash : null,
        receiptHash: line.receiptHash,
        resolutionHash: line.resolutionHash,
        ...('chartClaimHash' in line
          ? { chartClaimHash: line.chartClaimHash, chartTerminalHash: line.chartTerminalHash }
          : {}),
      })),
    })
    const complete = unknownUsageCount === 0 && unpricedUsageCount === 0
    const knownEstimatedCostMicros = ((totalPicoUsd + 999_999n) / 1_000_000n).toString()
    const material = {
      schemaVersion: 'bayn.inference-cost-report.v2' as const,
      accountBindingHash: evidence.accountBindingHash,
      sessionDate: evidence.sessionDate,
      asOf: evidence.asOf,
      evidenceHash,
      rateCardHash,
      coverage: complete ? InferenceCostCoverage.Estimated : InferenceCostCoverage.Incomplete,
      invoiceReconciled: false as const,
      requestCount: fingerprints.size,
      providerRequestCount: requests.length,
      meteredRequestCount: requests.length - unknownUsageCount - notDispatchedRequestCount,
      notDispatchedRequestCount,
      rejectedResponseUsageCount,
      unknownUsageCount,
      unpricedUsageCount,
      inputTokens: inputTokens.toString(),
      outputTokens: outputTokens.toString(),
      knownEstimatedCostPicoUsd: totalPicoUsd.toString(),
      knownEstimatedCostMicros,
      estimatedTotalCostMicros: complete ? knownEstimatedCostMicros : null,
      requests,
    }
    return { ...material, reportHash: yield* canonicalHashV1Result(material) }
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof InferenceCostError
        ? cause
        : new InferenceCostError({ message: 'Inference cost evidence or tariff is malformed', cause }),
    ),
  )
