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
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevOutcome,
  type JevEvaluationReceipt,
} from './jev/evidence'
import { decodeJevResolution } from './jev/resolution'

export class InferenceCostError extends Data.TaggedError('InferenceCostError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export enum InferenceUsageStatus {
  Received = 'RECEIVED_USAGE',
  Rejected = 'REJECTED_RESPONSE_USAGE',
  Unknown = 'UNKNOWN_USAGE',
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

export const InferenceRateSchema = Schema.Struct({
  provider: Schema.Literal('typesafe'),
  model: StrictNonEmptyStringSchema,
  currency: Schema.Literal('USD'),
  source: StrictNonEmptyStringSchema,
  effectiveFrom: UtcInstantSchema,
  effectiveUntil: UtcInstantSchema,
  inputMicrosPerMillionTokens: UnsignedMicrosSchema,
  outputMicrosPerMillionTokens: UnsignedMicrosSchema,
})

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
})

export const InferenceCostEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.inference-cost-evidence.v1'),
  accountBindingHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  asOf: UtcInstantSchema,
  requests: Schema.Array(InferenceCostRequestSchema),
})

export type InferenceCostEvidence = typeof InferenceCostEvidenceSchema.Type

const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const MeteredResponse = Schema.Struct({
  model: StrictNonEmptyStringSchema,
  usage: Schema.Struct({ input_tokens: TokenCount, output_tokens: TokenCount }),
})
const PurposeState = Schema.Struct({ task: Schema.Struct({ decisionPurpose: Schema.Enum(InferencePurpose) }) })

interface Usage {
  readonly model: string
  readonly inputTokens: bigint
  readonly outputTokens: bigint
  readonly status: InferenceUsageStatus.Received | InferenceUsageStatus.Rejected
}

const meteredUsage = (receipt: JevEvaluationReceipt | null, model: string): Usage | null => {
  if (receipt === null) return null
  const outcome = receipt.outcome
  // Rejected responses can still be billable. Only extract their usage after the receipt and response hashes verify.
  const raw =
    outcome.status === JevOutcome.Received
      ? outcome.inference.response
      : outcome.responseHash === null
        ? null
        : outcome.rejectedResponse
  const response = Schema.decodeUnknownResult(MeteredResponse)(raw)
  if (Result.isFailure(response) || response.success.model !== model) return null
  return {
    model,
    inputTokens: BigInt(response.success.usage.input_tokens),
    outputTokens: BigInt(response.success.usage.output_tokens),
    status: outcome.status === JevOutcome.Received ? InferenceUsageStatus.Received : InferenceUsageStatus.Rejected,
  }
}

export const InferenceCostLineSchema = Schema.Struct({
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
})

export type InferenceCostLine = typeof InferenceCostLineSchema.Type

export interface InferenceCostReport {
  readonly schemaVersion: 'bayn.inference-cost-report.v1'
  readonly accountBindingHash: string
  readonly sessionDate: string
  readonly asOf: string
  readonly evidenceHash: string
  readonly rateCardHash: string
  readonly coverage: InferenceCostCoverage
  readonly invoiceReconciled: false
  readonly requestCount: number
  readonly meteredRequestCount: number
  readonly rejectedResponseUsageCount: number
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

/** Operating-expense evidence only: never mutate broker cash, accounting receipts, or execution authority. */
export const makeInferenceCostReport = (
  evidenceInput: unknown,
  rateCardInput: unknown,
): Result.Result<InferenceCostReport, InferenceCostError> =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(
      InferenceCostEvidenceSchema,
      strictParseOptions,
    )(evidenceInput).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Inference cost evidence is malformed' })),
    )
    const rateCard = yield* Schema.decodeUnknownResult(
      InferenceRateCardSchema,
      strictParseOptions,
    )(rateCardInput).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Inference rate card is malformed' })),
    )
    for (const [index, rate] of rateCard.rates.entries()) {
      if (rate.effectiveFrom >= rate.effectiveUntil)
        return yield* Result.fail(new InferenceCostError({ message: 'Inference rate interval must be nonempty' }))
      if (
        rateCard.rates
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.model === rate.model &&
              earlier.effectiveFrom < rate.effectiveUntil &&
              rate.effectiveFrom < earlier.effectiveUntil,
          )
      )
        return yield* Result.fail(new InferenceCostError({ message: 'Inference rate intervals overlap' }))
    }
    const rates = yield* Result.all(
      rateCard.rates.map((rate) => canonicalHashV1Result(rate).pipe(Result.map((rateHash) => ({ rate, rateHash })))),
    ).pipe(Result.mapError(() => new InferenceCostError({ message: 'Inference rate cannot be hashed' })))
    const rateCardHash = yield* canonicalHashV1Result({
      schemaVersion: rateCard.schemaVersion,
      rates: [...rates].sort((a, b) => a.rateHash.localeCompare(b.rateHash)).map(({ rate }) => rate),
    }).pipe(Result.mapError(() => new InferenceCostError({ message: 'Inference rate card cannot be hashed' })))

    const lines = new Map<string, InferenceCostLine>()
    let inputTokens = 0n
    let outputTokens = 0n
    let totalPicoUsd = 0n
    let unknownUsageCount = 0
    let unpricedUsageCount = 0
    let rejectedResponseUsageCount = 0
    for (const row of evidence.requests) {
      const request = yield* decodeJevEvaluationRequest(row.request).pipe(
        Result.mapError(() => new InferenceCostError({ message: 'Inference request integrity failed' })),
      )
      if (
        request.requestId !== row.requestId ||
        request.cycleId !== row.cycleId ||
        request.authorityGenerationHash !== row.authorityGenerationHash ||
        request.observedAt > evidence.asOf
      )
        return yield* Result.fail(new InferenceCostError({ message: 'Inference request scope differs' }))
      const receipt =
        row.receipt === null
          ? null
          : yield* decodeJevEvaluationReceipt(request, row.receipt).pipe(
              Result.mapError(() => new InferenceCostError({ message: 'Inference receipt integrity failed' })),
            )
      const resolution =
        row.resolution === null
          ? null
          : yield* decodeJevResolution(request, receipt, row.resolution).pipe(
              Result.mapError(() => new InferenceCostError({ message: 'Inference resolution integrity failed' })),
            )
      if (
        (receipt !== null && receipt.completedAt > evidence.asOf) ||
        (resolution !== null && 'abandonedAt' in resolution && resolution.abandonedAt > evidence.asOf)
      )
        return yield* Result.fail(new InferenceCostError({ message: 'Inference evidence exceeds its as-of cut' }))
      const previous = lines.get(request.requestId)
      if (previous !== undefined) {
        if (
          previous.receiptHash !== (receipt?.receiptHash ?? null) ||
          previous.resolutionHash !== (resolution?.resolutionHash ?? null)
        )
          return yield* Result.fail(new InferenceCostError({ message: 'Duplicate inference evidence conflicts' }))
        continue
      }

      const usage = meteredUsage(receipt, request.request.model)
      const startedAt =
        receipt?.outcome.status === JevOutcome.Received ? receipt.outcome.inference.startedAt : receipt?.startedAt
      const priced =
        usage === null || startedAt === undefined
          ? undefined
          : rates.find(
              ({ rate }) =>
                rate.model === usage.model && rate.effectiveFrom <= startedAt && startedAt < rate.effectiveUntil,
            )
      // tokens * (USD micros / million tokens) is exact in pico-USD. Round only the aggregate, never each call.
      const cost =
        usage === null || priced === undefined
          ? null
          : usage.inputTokens * BigInt(priced.rate.inputMicrosPerMillionTokens) +
            usage.outputTokens * BigInt(priced.rate.outputMicrosPerMillionTokens)
      const purpose = Schema.decodeUnknownResult(PurposeState)(request.request.state)
      lines.set(request.requestId, {
        requestId: request.requestId,
        cycleId: request.cycleId,
        receiptHash: receipt?.receiptHash ?? null,
        resolutionHash: resolution?.resolutionHash ?? null,
        model: request.request.model,
        purpose: Result.isSuccess(purpose) ? purpose.success.task.decisionPurpose : InferencePurpose.Other,
        usageStatus: usage?.status ?? InferenceUsageStatus.Unknown,
        inputTokens: usage?.inputTokens.toString() ?? null,
        outputTokens: usage?.outputTokens.toString() ?? null,
        rateHash: priced?.rateHash ?? null,
        estimatedCostPicoUsd: cost?.toString() ?? null,
      })
      if (usage === null) unknownUsageCount += 1
      else {
        inputTokens += usage.inputTokens
        outputTokens += usage.outputTokens
        if (usage.status === InferenceUsageStatus.Rejected) rejectedResponseUsageCount += 1
        if (cost === null) unpricedUsageCount += 1
        else totalPicoUsd += cost
      }
    }
    const requests = [...lines.values()].sort((a, b) => a.requestId.localeCompare(b.requestId))
    const evidenceHash = yield* canonicalHashV1Result({
      schemaVersion: evidence.schemaVersion,
      accountBindingHash: evidence.accountBindingHash,
      sessionDate: evidence.sessionDate,
      asOf: evidence.asOf,
      requests: requests.map(({ requestId, receiptHash, resolutionHash }) => ({
        requestId,
        receiptHash,
        resolutionHash,
      })),
    }).pipe(Result.mapError(() => new InferenceCostError({ message: 'Inference evidence cannot be hashed' })))
    const complete = unknownUsageCount === 0 && unpricedUsageCount === 0
    const knownEstimatedCostMicros = ((totalPicoUsd + 999_999n) / 1_000_000n).toString()
    const material = {
      schemaVersion: 'bayn.inference-cost-report.v1' as const,
      accountBindingHash: evidence.accountBindingHash,
      sessionDate: evidence.sessionDate,
      asOf: evidence.asOf,
      evidenceHash,
      rateCardHash,
      coverage: complete ? InferenceCostCoverage.Estimated : InferenceCostCoverage.Incomplete,
      invoiceReconciled: false as const,
      requestCount: requests.length,
      meteredRequestCount: requests.length - unknownUsageCount,
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
    const reportHash = yield* canonicalHashV1Result(material).pipe(
      Result.mapError(() => new InferenceCostError({ message: 'Inference cost report cannot be hashed' })),
    )
    return { ...material, reportHash }
  })
