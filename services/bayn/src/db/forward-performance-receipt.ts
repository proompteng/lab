import { Context, Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  ImageDigestSchema,
  ImageRepositorySchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SourceRevisionSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import type { ForwardPerformanceReceipt } from '../forward-performance/model'

const DecimalSchema = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9][0-9]*)\.[0-9]+$/))
const ReceiptStringSchema = Schema.String.check(Schema.isMinLength(1))
const ForwardPerformanceBuildBindingSchema = Schema.Struct({
  sourceRevision: SourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
})

const ForwardPerformanceStrategyBindingSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  strategyName: ReceiptStringSchema,
  strategyProtocolHash: Sha256Schema,
  strategyBehaviorHash: Sha256Schema,
  strategyParameterHash: Sha256Schema,
  strategyParameterSchemaVersion: ReceiptStringSchema,
  executionPolicyHash: Sha256Schema,
  strategyExecutionModelHash: Sha256Schema,
})

const ForwardPerformanceAccountBindingSchema = Schema.Struct({
  accountReferenceHash: Sha256Schema,
  provider: ReceiptStringSchema,
  environment: ReceiptStringSchema,
})

const ForwardPerformanceCashYieldBindingSchema = Schema.Struct({
  source: Schema.Literal('TIGERBEETLE_CASH_YIELD_TRANSFER'),
  transferId: ReceiptStringSchema,
  transferTimestampNs: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  amountMicros: SignedMicrosSchema,
})

const ForwardPerformanceExecutionQualitySchema = Schema.Struct({
  status: Schema.Union([Schema.Literal('MEASURED'), Schema.Literal('NOT_ELIGIBLE'), Schema.Literal('UNDETERMINED')]),
  reasonCodes: Schema.Array(ReceiptStringSchema),
  evidenceHash: Schema.NullOr(Sha256Schema),
  implementationShortfall: Schema.NullOr(
    Schema.Struct({
      plannedOrderCount: NonNegativeIntegerSchema,
      fillCount: NonNegativeIntegerSchema,
      plannedQuantityMicros: SignedMicrosSchema,
      filledQuantityMicros: SignedMicrosSchema,
      unfilledQuantityMicros: SignedMicrosSchema,
      plannedReferenceNotionalMicros: SignedMicrosSchema,
      executedNotionalMicros: SignedMicrosSchema,
      executionPriceShortfallMicros: SignedMicrosSchema,
      opportunityShortfallMicros: SignedMicrosSchema,
      explicitCostsMicros: SignedMicrosSchema,
      totalImplementationShortfallMicros: SignedMicrosSchema,
      implementationShortfallRate: Schema.Struct({
        numeratorMicros: SignedMicrosSchema,
        denominatorMicros: SignedMicrosSchema,
        decimal: DecimalSchema,
      }),
      firstDecisionAt: UtcInstantSchema,
      firstFillAt: Schema.NullOr(UtcInstantSchema),
      lastFillAt: Schema.NullOr(UtcInstantSchema),
      lastTerminalOrderObservedAt: UtcInstantSchema,
    }),
  ),
})

const ForwardPerformanceObservedCapacitySchema = Schema.Struct({
  status: Schema.Union([Schema.Literal('MEASURED'), Schema.Literal('NOT_ELIGIBLE'), Schema.Literal('UNDETERMINED')]),
  reasonCodes: Schema.Array(ReceiptStringSchema),
  evidenceHash: Schema.NullOr(Sha256Schema),
  observations: Schema.Array(
    Schema.Struct({
      cycleId: Sha256Schema,
      symbol: ReceiptStringSchema,
      windowOpenedAt: UtcInstantSchema,
      windowClosedAt: UtcInstantSchema,
      filledQuantityMicros: SignedMicrosSchema,
      marketVolumeQuantityMicros: SignedMicrosSchema,
      participationRate: Schema.Struct({
        numeratorQuantityMicros: SignedMicrosSchema,
        denominatorQuantityMicros: SignedMicrosSchema,
        decimal: DecimalSchema,
      }),
    }),
  ),
  boundedObservedReferenceNotionalMicros: Schema.NullOr(SignedMicrosSchema),
  boundedObservedExecutedNotionalMicros: Schema.NullOr(SignedMicrosSchema),
  maximumParticipationRate: Schema.NullOr(
    Schema.Struct({
      numeratorQuantityMicros: SignedMicrosSchema,
      denominatorQuantityMicros: SignedMicrosSchema,
      decimal: DecimalSchema,
    }),
  ),
})

const ForwardPerformanceReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-receipt.v3'),
  bindings: Schema.Struct({
    runtime: ForwardPerformanceBuildBindingSchema,
    source: Schema.NullOr(ForwardPerformanceBuildBindingSchema),
    strategy: Schema.NullOr(ForwardPerformanceStrategyBindingSchema),
    account: ForwardPerformanceAccountBindingSchema,
  }),
  window: Schema.Struct({
    firstCycleId: Schema.NullOr(Sha256Schema),
    lastCycleId: Schema.NullOr(Sha256Schema),
    openedAt: Schema.NullOr(UtcInstantSchema),
    closedAt: Schema.NullOr(UtcInstantSchema),
    reconciliationId: Schema.NullOr(Sha256Schema),
    reconciliationContentHash: Schema.NullOr(Sha256Schema),
    reconciliationStatus: Schema.NullOr(Schema.Union([Schema.Literal('EXACT'), Schema.Literal('DISCREPANCY')])),
    cashYieldAdjustedExact: Schema.NullOr(Schema.Boolean),
  }),
  totals: Schema.Struct({
    startingCapitalMicros: Schema.NullOr(SignedMicrosSchema),
    realizedGainsMicros: Schema.NullOr(SignedMicrosSchema),
    realizedLossesMicros: Schema.NullOr(SignedMicrosSchema),
    brokerExecutionFeesMicros: Schema.NullOr(SignedMicrosSchema),
    otherChargedCostsMicros: Schema.NullOr(SignedMicrosSchema),
    cashYieldMicros: Schema.NullOr(SignedMicrosSchema),
    grossRealizedPnlMicros: Schema.NullOr(SignedMicrosSchema),
    netRealizedPnlAfterCostsMicros: Schema.NullOr(SignedMicrosSchema),
    netRealizedReturn: Schema.NullOr(
      Schema.Struct({
        numeratorMicros: SignedMicrosSchema,
        denominatorMicros: SignedMicrosSchema,
        decimal: DecimalSchema,
      }),
    ),
  }),
  counts: Schema.Struct({
    cycleCount: NonNegativeIntegerSchema,
    completedExecutionCount: NonNegativeIntegerSchema,
    realizedCloseCount: NonNegativeIntegerSchema,
  }),
  evidence: Schema.Struct({
    status: Schema.Union([Schema.Literal('SUFFICIENT'), Schema.Literal('INSUFFICIENT_EVIDENCE')]),
    reasonCodes: Schema.Array(ReceiptStringSchema),
    cashYield: Schema.NullOr(ForwardPerformanceCashYieldBindingSchema),
  }),
  reconciliationProof: Schema.Struct({
    accountingReceiptsExact: Schema.Boolean,
    ledgerExact: Schema.Boolean,
    missingLedgerAccountCount: NonNegativeIntegerSchema,
    unresolvedMutationCount: NonNegativeIntegerSchema,
    unclosedCycleCount: NonNegativeIntegerSchema,
    openPositionCount: NonNegativeIntegerSchema,
  }),
  executionQuality: ForwardPerformanceExecutionQualitySchema,
  observedCapacity: ForwardPerformanceObservedCapacitySchema,
  profitability: Schema.Union([
    Schema.Literal('PROFITABLE'),
    Schema.Literal('NOT_PROFITABLE'),
    Schema.Literal('UNDETERMINED'),
  ]),
  receiptHash: Sha256Schema,
}).check(
  Schema.makeFilter((receipt) => {
    const { receiptHash: _receiptHash, ...material } = receipt
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === receipt.receiptHash
  }),
)

const ForwardPerformanceReceiptEnvelopeMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-receipt-envelope.v1'),
  authorityGenerationHash: Sha256Schema,
  cycleId: Sha256Schema,
  receiptHash: Sha256Schema,
  receipt: ForwardPerformanceReceiptSchema,
  createdAt: UtcInstantSchema,
}).check(
  Schema.makeFilter((envelope) => {
    if (typeof envelope.receipt !== 'object' || envelope.receipt === null) return false
    if (!('receiptHash' in envelope.receipt) || envelope.receipt.receiptHash !== envelope.receiptHash) return false
    return true
  }),
)

export const ForwardPerformanceReceiptEnvelopeSchema = Schema.Struct({
  ...ForwardPerformanceReceiptEnvelopeMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(
  Schema.makeFilter((envelope) => {
    if (typeof envelope.receipt !== 'object' || envelope.receipt === null) return false
    if (!('receiptHash' in envelope.receipt) || envelope.receipt.receiptHash !== envelope.receiptHash) return false
    const { contentHash: _contentHash, ...material } = envelope
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === envelope.contentHash
  }),
)

export type ForwardPerformanceReceiptEnvelopeMaterial = typeof ForwardPerformanceReceiptEnvelopeMaterialSchema.Type
export type ForwardPerformanceReceiptEnvelope = Omit<typeof ForwardPerformanceReceiptEnvelopeSchema.Type, 'receipt'> & {
  readonly receipt: ForwardPerformanceReceipt
}

export const makeForwardPerformanceReceiptEnvelope = (
  material: Omit<ForwardPerformanceReceiptEnvelopeMaterial, 'receipt'> & {
    readonly receipt: ForwardPerformanceReceipt
  },
): Result.Result<ForwardPerformanceReceiptEnvelope, 'ForwardPerformanceReceiptCanonicalizationFailed'> =>
  Result.map(canonicalHashV1Result(material), (contentHash) => ({ ...material, contentHash })).pipe(
    Result.mapError(() => 'ForwardPerformanceReceiptCanonicalizationFailed' as const),
  )

export class ForwardPerformanceReceiptStoreError extends Data.TaggedError('ForwardPerformanceReceiptStoreError')<{
  readonly operation: 'bind' | 'read'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ForwardPerformanceReceiptStoreShape {
  readonly read: (
    authorityGenerationHash: string,
  ) => Effect.Effect<Option.Option<ForwardPerformanceReceiptEnvelope>, ForwardPerformanceReceiptStoreError>
  readonly bind: (
    envelope: ForwardPerformanceReceiptEnvelope,
  ) => Effect.Effect<ForwardPerformanceReceiptEnvelope, ForwardPerformanceReceiptStoreError>
}

export class ForwardPerformanceReceiptStore extends Context.Service<
  ForwardPerformanceReceiptStore,
  ForwardPerformanceReceiptStoreShape
>()('bayn/ForwardPerformanceReceiptStore') {}

const decodeEnvelopeResult = Schema.decodeUnknownResult(ForwardPerformanceReceiptEnvelopeSchema, strictParseOptions)

export const decodeForwardPerformanceReceiptEnvelopeResult = (
  input: unknown,
): Result.Result<ForwardPerformanceReceiptEnvelope, unknown> =>
  decodeEnvelopeResult(input) as Result.Result<ForwardPerformanceReceiptEnvelope, unknown>
