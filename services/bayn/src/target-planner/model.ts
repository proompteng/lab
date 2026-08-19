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
import {
  legacyReconciliationSchemaVersion,
  legacyReferenceTargetPlanSchemaVersion,
  legacyTargetPlannerInputV1SchemaVersion,
  legacyTargetPlannerInputV2SchemaVersion,
} from '../execution/legacy-wire'
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

export const SignalSessionReferencePricesSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.signal-session-reference-prices.v1'),
  signalDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  contentHash: Sha256Schema,
  priceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
})

export const intradaySnapshotReferencePricesSchemaVersion = 'bayn.intraday-snapshot-reference-prices.v1' as const

export const IntradaySnapshotReferencePricesSchema = Schema.Struct({
  schemaVersion: Schema.Literal(intradaySnapshotReferencePricesSchemaVersion),
  signalDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
  priceReference: Schema.Literal('verified-adverse-quote-boundary'),
  contentHash: Sha256Schema,
  priceMicros: Schema.Record(SymbolSchema, PositiveMicrosSchema),
})

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
  signalDate: SignalSessionReferencePricesSchema.fields.signalDate,
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  referencePrices: SignalSessionReferencePricesSchema,
  brokerState: TargetPlannerBrokerStateSchema,
  precision: Schema.Struct({
    quantityIncrementMicros: PositiveMicrosSchema,
    priceIncrementMicros: PositiveMicrosSchema,
    minimumBuyNotionalMicros: PositiveMicrosSchema,
  }),
  maximumInputAgeMs: PositiveIntegerSchema,
  submissionCutoffAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
} as const

export const quoteBoundTargetPlannerInputSchemaVersion = 'bayn.target-planner-input.quote-bound.v1' as const

export const QuoteBoundExecutionTermsSchema = Schema.Struct({
  orderType: Schema.Literal(OrderType.Limit),
  timeInForce: Schema.Literal(TimeInForce.ImmediateOrCancel),
  priceReference: Schema.Literal('verified-adverse-quote-boundary'),
  snapshotId: Sha256Schema,
  snapshotContentHash: Sha256Schema,
})

export const TargetPlannerInputV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyTargetPlannerInputV1SchemaVersion),
  ...TargetPlannerInputFields,
})

export const TargetPlannerInputV2Schema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyTargetPlannerInputV2SchemaVersion),
  ...TargetPlannerInputFields,
  allocationCapitalMicros: UnsignedMicrosSchema,
})

const QuoteBoundTargetPlannerInputBase = Schema.Struct({
  schemaVersion: Schema.Literal(quoteBoundTargetPlannerInputSchemaVersion),
  ...TargetPlannerInputFields,
  referencePrices: IntradaySnapshotReferencePricesSchema,
  precision: Schema.Struct({
    quantityIncrementMicros: Schema.Literal('1000000'),
    priceIncrementMicros: PositiveMicrosSchema,
    minimumBuyNotionalMicros: PositiveMicrosSchema,
  }),
  allocationCapitalMicros: UnsignedMicrosSchema,
  executionTerms: QuoteBoundExecutionTermsSchema,
})

const quoteBoundInputIssues = (input: typeof QuoteBoundTargetPlannerInputBase.Type): readonly Schema.FilterIssue[] =>
  input.executionTerms.snapshotId === input.referencePrices.snapshotId &&
  input.executionTerms.snapshotContentHash === input.referencePrices.snapshotContentHash
    ? []
    : [
        {
          path: ['executionTerms'],
          issue: 'must bind the same verified intraday snapshot as its reference prices',
        },
      ]

export const QuoteBoundTargetPlannerInputSchema = QuoteBoundTargetPlannerInputBase.check(
  Schema.makeFilter(quoteBoundInputIssues),
)

export const TargetPlannerInputSchema = Schema.Union([
  TargetPlannerInputV1Schema,
  TargetPlannerInputV2Schema,
  QuoteBoundTargetPlannerInputSchema,
])

export type SignalSessionReferencePrices = typeof SignalSessionReferencePricesSchema.Type
export type IntradaySnapshotReferencePrices = typeof IntradaySnapshotReferencePricesSchema.Type
export type TargetPlannerBrokerState = typeof TargetPlannerBrokerStateSchema.Type
export type TargetPlannerInputV1 = typeof TargetPlannerInputV1Schema.Type
export type TargetPlannerInputV2 = typeof TargetPlannerInputV2Schema.Type
export type QuoteBoundExecutionTerms = typeof QuoteBoundExecutionTermsSchema.Type
export type QuoteBoundTargetPlannerInput = typeof QuoteBoundTargetPlannerInputSchema.Type
export type TargetPlannerInput = typeof TargetPlannerInputSchema.Type

export interface PlannedTargetQuantity {
  readonly symbol: string
  readonly targetWeight: number
  readonly referencePriceMicros: string
  readonly currentQuantityMicros: string
  readonly targetQuantityMicros: string
}

export type ReferenceTargetIntent = Omit<IntentPlan, 'schemaVersion' | 'notionalLimitMicros'>

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
  currentQuantityMicros: UnsignedMicrosSchema,
  targetQuantityMicros: UnsignedMicrosSchema,
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
  quantityMicros: IntentPlanSchema.fields.quantityMicros,
  createdAt: IntentPlanSchema.fields.createdAt,
})

export const referenceTargetPlanSchemaVersion = 'bayn.reference-target-plan.v2' as const

export const TargetPlanResultFields = {
  schemaVersion: Schema.Literals([legacyReferenceTargetPlanSchemaVersion, referenceTargetPlanSchemaVersion]),
  inputHash: Sha256Schema,
  outputHash: Sha256Schema,
  targets: Schema.Array(PlannedTargetQuantitySchema),
  requiredReferenceBuyNotionalMicros: UnsignedMicrosSchema,
  availableBuyingPowerMicros: SignedMicrosSchema,
  residualBuyingPowerMicros: SignedMicrosSchema,
} as const
