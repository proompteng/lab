import { Data, Schema } from 'effect'

import {
  AccountSnapshotSchema,
  DiscrepancySchema,
  OrderType,
  OrderSchema,
  PositionSchema,
  ReconciliationStatus,
  TimeInForce,
} from '../execution/contracts'
import { legacyReconciliationSchemaVersion, legacyReferenceTargetPlanSchemaVersion } from '../execution/legacy-wire'
import { IntentPlanSchema, type IntentPlan } from '../execution/intents/domain'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
} from '../schemas'

export const intradaySnapshotReferencePricesSchemaVersion = 'bayn.intraday-snapshot-reference-prices.v1' as const

const IntradaySnapshotReferencePricesBase = Schema.Struct({
  schemaVersion: Schema.Literal(intradaySnapshotReferencePricesSchemaVersion),
  signalDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
  priceReference: Schema.Literal('verified-adverse-quote-boundary'),
  contentHash: Sha256Schema,
  /** Conservative compatibility surface; quote-bound planning requires this to equal the ask map. */
  priceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
  bidPriceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
  askPriceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
})

const intradayReferencePriceIssues = (
  prices: typeof IntradaySnapshotReferencePricesBase.Type,
): readonly Schema.FilterIssue[] => {
  const symbols = Object.keys(prices.priceMicros).sort()
  const bidSymbols = Object.keys(prices.bidPriceMicros).sort()
  const askSymbols = Object.keys(prices.askPriceMicros).sort()
  if (
    symbols.length !== bidSymbols.length ||
    symbols.length !== askSymbols.length ||
    symbols.some((symbol, index) => symbol !== bidSymbols[index] || symbol !== askSymbols[index])
  ) {
    return [{ path: ['priceMicros'], issue: 'bid, ask, and compatibility price maps must bind identical symbols' }]
  }
  const issues: Schema.FilterIssue[] = []
  for (const symbol of symbols) {
    const bid = prices.bidPriceMicros[symbol]
    const ask = prices.askPriceMicros[symbol]
    const compatibility = prices.priceMicros[symbol]
    if (bid === undefined || ask === undefined || compatibility === undefined) continue
    if (BigInt(bid) > BigInt(ask)) {
      issues.push({ path: ['bidPriceMicros', symbol], issue: 'verified bid must not exceed the verified ask' })
    }
    if (compatibility !== ask) {
      issues.push({ path: ['priceMicros', symbol], issue: 'compatibility price must equal the conservative ask' })
    }
  }
  return issues
}

export const IntradaySnapshotReferencePricesSchema = IntradaySnapshotReferencePricesBase.check(
  Schema.makeFilter(intradayReferencePriceIssues),
)

export const reconciledPositionReferencePricesSchemaVersion = 'bayn.reconciled-position-reference-prices.v1' as const

const ReconciledPositionReferencePricesBase = Schema.Struct({
  schemaVersion: Schema.Literal(reconciledPositionReferencePricesSchemaVersion),
  signalDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
  priceReference: Schema.Literal('reconciled-broker-position-mark'),
  contentHash: Sha256Schema,
  priceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
  bidPriceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
  askPriceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
})

export const ReconciledPositionReferencePricesSchema = ReconciledPositionReferencePricesBase.check(
  Schema.makeFilter((prices: typeof ReconciledPositionReferencePricesBase.Type): readonly Schema.FilterIssue[] => {
    const symbols = Object.keys(prices.priceMicros).sort()
    const bidSymbols = Object.keys(prices.bidPriceMicros).sort()
    const askSymbols = Object.keys(prices.askPriceMicros).sort()
    const issues: Schema.FilterIssue[] = []
    if (
      symbols.length !== bidSymbols.length ||
      symbols.length !== askSymbols.length ||
      symbols.some((symbol, index) => symbol !== bidSymbols[index] || symbol !== askSymbols[index])
    ) {
      issues.push({ path: ['priceMicros'], issue: 'position mark maps must bind identical symbols' })
    }
    for (const symbol of symbols) {
      const price = prices.priceMicros[symbol]
      if (price !== prices.bidPriceMicros[symbol] || price !== prices.askPriceMicros[symbol]) {
        issues.push({ path: ['priceMicros', symbol], issue: 'position mark must be identical in every price map' })
      }
    }
    return issues
  }),
)

export const ExecutionReferencePricesSchema = Schema.Union([
  IntradaySnapshotReferencePricesSchema,
  ReconciledPositionReferencePricesSchema,
])

export const TargetPlannerBrokerStateSchema = Schema.Struct({
  account: AccountSnapshotSchema,
  positions: Schema.Array(PositionSchema),
  positionsObservedAt: UtcInstantSchema,
  orders: Schema.Array(OrderSchema),
  ordersObservedAt: UtcInstantSchema,
  accountingHash: Sha256Schema,
  reconciliation: Schema.Struct({
    schemaVersion: Schema.Literal(legacyReconciliationSchemaVersion),
    reconciliationId: Sha256Schema,
    accountId: StrictNonEmptyStringSchema,
    expectedHash: Sha256Schema,
    observedHash: Sha256Schema,
    contentHash: Sha256Schema,
    status: Schema.Enum(ReconciliationStatus),
    discrepancies: Schema.Array(DiscrepancySchema),
    reconciledAt: UtcInstantSchema,
  }),
  unknownOrderCount: NonNegativeIntegerSchema,
})

const TargetPlannerInputFields = {
  strategyName: StrictNonEmptyStringSchema,
  cycleId: Sha256Schema,
  decisionHash: Sha256Schema,
  policyHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  signalDate: IsoDateSchema,
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  referencePrices: ExecutionReferencePricesSchema,
  brokerState: TargetPlannerBrokerStateSchema,
  precision: Schema.Struct({
    quantityIncrementAtoms: PositiveMicrosSchema,
    priceIncrementMicros: PositiveMicrosSchema,
    minimumBuyNotionalMicros: PositiveMicrosSchema,
  }),
  maximumInputAgeMs: PositiveIntegerSchema,
  submissionCutoffAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
} as const

export const quoteBoundTargetPlannerInputSchemaVersion = 'bayn.target-planner-input.quote-bound.v1' as const

const QuoteBoundLimitExecutionIdentityFields = {
  executionPurpose: Schema.optionalKey(Schema.Literal('forced-close')),
  orderType: Schema.Literal(OrderType.Limit),
  timeInForce: Schema.Literals([TimeInForce.Day, TimeInForce.ImmediateOrCancel]),
  priceReference: Schema.Literals(['verified-adverse-quote-boundary', 'reconciled-broker-position-mark']),
} as const

const TargetPlanExecutionSnapshotFields = {
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
} as const

const QuoteBoundLimitExecutionTermsSchema = Schema.Struct({
  ...QuoteBoundLimitExecutionIdentityFields,
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
  maximumBuyQuantityAtoms: Schema.Record(SymbolSchema, UnsignedMicrosSchema),
  maximumSellQuantityAtoms: Schema.Record(SymbolSchema, UnsignedMicrosSchema),
})

export const QuoteBoundExecutionTermsSchema = QuoteBoundLimitExecutionTermsSchema

export const TargetPlanExecutionTermsSchema = Schema.Struct({
  ...QuoteBoundLimitExecutionIdentityFields,
  ...TargetPlanExecutionSnapshotFields,
})
export type TargetPlanExecutionTerms = typeof TargetPlanExecutionTermsSchema.Type

const QuoteBoundTargetPlannerInputBase = Schema.Struct({
  schemaVersion: Schema.Literal(quoteBoundTargetPlannerInputSchemaVersion),
  ...TargetPlannerInputFields,
  allocationCapitalMicros: UnsignedMicrosSchema,
  executionTerms: QuoteBoundExecutionTermsSchema,
})

const quoteBoundInputIssues = (input: typeof QuoteBoundTargetPlannerInputBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (
    input.executionTerms.snapshotId !== input.referencePrices.snapshotId ||
    input.executionTerms.snapshotContentHash !== input.referencePrices.snapshotContentHash
  ) {
    issues.push({
      path: ['executionTerms'],
      issue: 'must bind the same verified intraday snapshot as its reference prices',
    })
  }
  if (input.executionTerms.priceReference !== input.referencePrices.priceReference) {
    issues.push({ path: ['executionTerms', 'priceReference'], issue: 'must match the bound reference-price source' })
  }
  const targetSymbols = Object.keys(input.targetWeights).sort()
  const buyQuantitySymbols = Object.keys(input.executionTerms.maximumBuyQuantityAtoms).sort()
  const sellQuantitySymbols = Object.keys(input.executionTerms.maximumSellQuantityAtoms).sort()
  if (
    targetSymbols.length !== buyQuantitySymbols.length ||
    targetSymbols.length !== sellQuantitySymbols.length ||
    targetSymbols.some((symbol, index) => symbol !== buyQuantitySymbols[index] || symbol !== sellQuantitySymbols[index])
  ) {
    issues.push({
      path: ['executionTerms'],
      issue: 'must contain one buy and sell quantity limit for every target symbol',
    })
  }
  const quantityIncrement = BigInt(input.precision.quantityIncrementAtoms)
  const forcedClose = input.executionTerms.executionPurpose !== undefined
  if (input.executionTerms.priceReference === 'reconciled-broker-position-mark' && !forcedClose)
    issues.push({ path: ['executionTerms'], issue: 'a reconciled position mark can only price a forced close' })
  if (forcedClose) {
    if (Object.values(input.targetWeights).some((weight) => weight !== 0)) {
      issues.push({ path: ['targetWeights'], issue: 'forced close must target a flat account' })
    }
    const positionQuantities = new Map(
      input.brokerState.positions.map((position) => [position.symbol, BigInt(position.quantityAtoms)]),
    )
    if (
      targetSymbols.some((symbol) => {
        const currentQuantity = positionQuantities.get(symbol) ?? 0n
        const expectedMaximumBuy = currentQuantity < 0n ? -currentQuantity : 0n
        const expectedMaximumSell = currentQuantity > 0n ? currentQuantity : 0n
        return (
          BigInt(input.executionTerms.maximumBuyQuantityAtoms[symbol] ?? '0') !== expectedMaximumBuy ||
          BigInt(input.executionTerms.maximumSellQuantityAtoms[symbol] ?? '0') !== expectedMaximumSell
        )
      })
    ) {
      issues.push({
        path: ['executionTerms'],
        issue: 'forced close must cap buys and sells at each exactly reconciled position quantity',
      })
    }
  }
  if (
    [
      ...Object.values(input.executionTerms.maximumBuyQuantityAtoms),
      ...Object.values(input.executionTerms.maximumSellQuantityAtoms),
    ].some((quantity) => BigInt(quantity) % quantityIncrement !== 0n)
  ) {
    issues.push({
      path: ['executionTerms'],
      issue: 'buy and sell limits must use the declared quantity precision',
    })
  }
  return issues
}

export const QuoteBoundTargetPlannerInputSchema = QuoteBoundTargetPlannerInputBase.check(
  Schema.makeFilter(quoteBoundInputIssues),
)

export const TargetPlannerInputSchema = QuoteBoundTargetPlannerInputSchema

export type IntradaySnapshotReferencePrices = typeof IntradaySnapshotReferencePricesSchema.Type
export type ExecutionReferencePrices = typeof ExecutionReferencePricesSchema.Type
export type QuoteBoundTargetPlannerInput = typeof QuoteBoundTargetPlannerInputSchema.Type
export type TargetPlannerInput = typeof TargetPlannerInputSchema.Type

export interface PlannedTargetQuantity {
  readonly symbol: string
  readonly targetWeight: number
  readonly referencePriceMicros: string
  readonly currentQuantityAtoms: string
  readonly targetQuantityAtoms: string
}

export type ReferenceTargetIntent = Omit<IntentPlan, 'schemaVersion' | 'notionalLimitMicros' | 'limitPriceMicros'>

export enum TargetPlanStatus {
  Planned = 'PLANNED',
  NoTrade = 'NO_TRADE',
  Blocked = 'BLOCKED',
}

export enum TargetPlanReason {
  AccountNotActive = 'ACCOUNT_NOT_ACTIVE',
  BelowMinimumBuyNotional = 'BELOW_MINIMUM_BUY_NOTIONAL',
  IdentityMismatch = 'IDENTITY_MISMATCH',
  InputMismatch = 'INPUT_MISMATCH',
  InputStale = 'INPUT_STALE',
  InsufficientBuyLiquidity = 'INSUFFICIENT_BUY_LIQUIDITY',
  InsufficientSellLiquidity = 'INSUFFICIENT_SELL_LIQUIDITY',
  InsufficientBuyingPower = 'INSUFFICIENT_BUYING_POWER',
  NonPositiveEquity = 'NON_POSITIVE_EQUITY',
  ReconciliationNotExact = 'RECONCILIATION_NOT_EXACT',
  ShortPositionNotAllowed = 'SHORT_POSITION_NOT_ALLOWED',
  SubmissionCutoffReached = 'SUBMISSION_CUTOFF_REACHED',
  TargetsSatisfied = 'TARGETS_SATISFIED',
  UnknownOrder = 'UNKNOWN_ORDER',
  UnresolvedOrder = 'UNRESOLVED_ORDER',
}

export const blockedTargetPlanReasons = [
  TargetPlanReason.AccountNotActive,
  TargetPlanReason.BelowMinimumBuyNotional,
  TargetPlanReason.IdentityMismatch,
  TargetPlanReason.InputMismatch,
  TargetPlanReason.InputStale,
  TargetPlanReason.InsufficientBuyLiquidity,
  TargetPlanReason.InsufficientSellLiquidity,
  TargetPlanReason.InsufficientBuyingPower,
  TargetPlanReason.NonPositiveEquity,
  TargetPlanReason.ReconciliationNotExact,
  TargetPlanReason.ShortPositionNotAllowed,
  TargetPlanReason.SubmissionCutoffReached,
  TargetPlanReason.UnknownOrder,
  TargetPlanReason.UnresolvedOrder,
] as const
export type BlockedTargetPlanReason = (typeof blockedTargetPlanReasons)[number]

interface CanonicalizeTargetPlannerInputIssue {
  readonly operation: 'canonicalize-input'
  readonly reason: 'hash'
}

interface CanonicalizeTargetPlannerOutputIssue {
  readonly operation: 'canonicalize-output'
  readonly reason: 'hash'
}

interface DecodeTargetPlannerInputIssue {
  readonly operation: 'decode-input'
  readonly reason: 'contract'
}

interface DecodeTargetPlannerOutputIssue {
  readonly operation: 'decode-output'
  readonly reason: 'contract' | 'hash'
}

interface DeriveTargetPlannerTargetsIssue {
  readonly operation: 'derive-targets'
  readonly reason: 'precision'
}

export type TargetPlannerIssue =
  | CanonicalizeTargetPlannerInputIssue
  | CanonicalizeTargetPlannerOutputIssue
  | DecodeTargetPlannerInputIssue
  | DecodeTargetPlannerOutputIssue
  | DeriveTargetPlannerTargetsIssue

interface TargetPlannerFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const TargetPlannerFailureClass = Data.TaggedError('TargetPlannerFailure')<
  TargetPlannerIssue & TargetPlannerFailureDetails
>
export type TargetPlannerFailure = InstanceType<typeof TargetPlannerFailureClass>

type TargetPlannerReasonFor<Operation extends TargetPlannerIssue['operation']> = Extract<
  TargetPlannerIssue,
  { readonly operation: Operation }
>['reason']

interface TargetPlannerFailureInput<Operation extends TargetPlannerIssue['operation']> {
  readonly reason: TargetPlannerReasonFor<Operation>
  readonly message: string
  readonly facts?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const failure = <Operation extends TargetPlannerIssue['operation']>(
  operation: Operation,
  input: TargetPlannerFailureInput<Operation>,
): TargetPlannerFailure => new TargetPlannerFailureClass({ operation, ...input, facts: input.facts ?? {} } as never)

export const canonicalizePlannerInputFailure = (
  input: TargetPlannerFailureInput<'canonicalize-input'>,
): TargetPlannerFailure => failure('canonicalize-input', input)

export const canonicalizePlannerOutputFailure = (
  input: TargetPlannerFailureInput<'canonicalize-output'>,
): TargetPlannerFailure => failure('canonicalize-output', input)

export const decodePlannerInputFailure = (input: TargetPlannerFailureInput<'decode-input'>): TargetPlannerFailure =>
  failure('decode-input', input)

export const decodePlannerOutputFailure = (input: TargetPlannerFailureInput<'decode-output'>): TargetPlannerFailure =>
  failure('decode-output', input)

export const deriveTargetsFailure = (input: TargetPlannerFailureInput<'derive-targets'>): TargetPlannerFailure =>
  failure('derive-targets', input)

export const PlannedTargetQuantitySchema = Schema.Struct({
  symbol: SymbolSchema,
  targetWeight: UnitIntervalSchema,
  referencePriceMicros: PositiveMicrosSchema,
  currentQuantityAtoms: SignedMicrosSchema,
  targetQuantityAtoms: UnsignedMicrosSchema,
})

export const ReferenceTargetIntentSchema = Schema.Struct({
  strategyName: IntentPlanSchema.fields.strategyName,
  cycleId: IntentPlanSchema.fields.cycleId,
  decisionHash: IntentPlanSchema.fields.decisionHash,
  policyHash: IntentPlanSchema.fields.policyHash,
  accountId: IntentPlanSchema.fields.accountId,
  symbol: IntentPlanSchema.fields.symbol,
  side: IntentPlanSchema.fields.side,
  orderType: IntentPlanSchema.fields.orderType,
  timeInForce: IntentPlanSchema.fields.timeInForce,
  quantityAtoms: IntentPlanSchema.fields.quantityAtoms,
  createdAt: IntentPlanSchema.fields.createdAt,
})

export const referenceTargetPlanSchemaVersion = 'bayn.reference-target-plan.v2' as const

export const TargetPlanResultFields = {
  schemaVersion: Schema.Literals([legacyReferenceTargetPlanSchemaVersion, referenceTargetPlanSchemaVersion]),
  inputHash: Sha256Schema,
  outputHash: Sha256Schema,
  executionTerms: Schema.optionalKey(TargetPlanExecutionTermsSchema),
  targets: Schema.Array(PlannedTargetQuantitySchema),
  requiredReferenceBuyNotionalMicros: UnsignedMicrosSchema,
  availableBuyingPowerMicros: SignedMicrosSchema,
  residualBuyingPowerMicros: SignedMicrosSchema,
} as const
