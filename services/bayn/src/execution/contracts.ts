import { pipe, Result, Schema } from 'effect'
import { instrumentMarket, MarketKind } from '../instruments'
import { quantityScale } from '../quantity'
import { CryptoFeeTierSchema } from '../broker/crypto-fees'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import { ResearchCapitalGrantSchema } from './mandate'
import {
  ImageDigestSchema as ImageDigest,
  Sha256Schema as Sha256,
  SourceRevisionSchema as SourceRevision,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  UtcDatabaseInstantSchema,
  UtcOrderTimestampSchema as UtcOrderTimestamp,
  strictParseOptions as StrictParseOptions,
} from '../schemas'

import {
  legacyAccountingReceiptSchemaVersion,
  legacyAuthorityGenerationV2SchemaVersion,
  legacyAuthorityGenerationV3SchemaVersion,
  legacyAuthorityProofBindingSchemaVersion,
  legacyAuthorityStateSchemaVersion,
  legacyBrokerEventSchemaVersion,
  legacyFillSchemaVersion,
  legacyOrderV2SchemaVersion,
  legacyReconciliationSchemaVersion,
  legacyResearchGrantProofSchemaVersion,
  legacyRiskDecisionSchemaVersion,
  legacyRiskInputSchemaVersion,
  legacyValuationSchemaVersion,
} from './legacy-wire'

export const executionIntentSchemaVersion = 'bayn.execution-intent.v5' as const
export const referenceIntentSchemaVersion = 'bayn.reference-intent.v4' as const
export const intentPlanSchemaVersion = 'bayn.intent-plan.v3' as const
export const intentIdentitySchemaVersion = 'bayn.execution-intent-identity.v5' as const
export const accountSnapshotSchemaVersion = 'bayn.paper-account-snapshot.v2' as const

const U32_MAX = 4_294_967_295
const U64_MAX = 18_446_744_073_709_551_615n
const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const I128_MIN = -170_141_183_460_469_231_731_687_303_715_884_105_728n
const I128_MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727n

const boundedInteger = (pattern: RegExp, minimum: bigint, maximum: bigint, expected: string) =>
  Schema.String.check(
    Schema.makeFilter(
      (value: string) => {
        if (!pattern.test(value)) return false
        const parsed = BigInt(value)
        return parsed >= minimum && parsed <= maximum
      },
      { expected },
    ),
  )

const DecimalId = boundedInteger(/^[1-9][0-9]*$/, 1n, U128_MAX, 'a canonical positive u128 decimal string')
const Sequence = boundedInteger(/^(?:0|[1-9][0-9]*)$/, 0n, U64_MAX, 'a canonical unsigned u64 decimal string')
const SignedMicros = boundedInteger(/^(?:0|-?[1-9][0-9]*)$/, I128_MIN, I128_MAX, 'canonical signed i128 micros')
const NonPositiveMicros = boundedInteger(/^(?:0|-[1-9][0-9]*)$/, I128_MIN, 0n, 'canonical non-positive i128 micros')
const UnsignedMicros = boundedInteger(/^(?:0|[1-9][0-9]*)$/, 0n, U128_MAX, 'canonical unsigned u128 micros')
const PositiveMicros = DecimalId

export {
  PositiveMicros as PositiveMicrosSchema,
  SignedMicros as SignedMicrosSchema,
  UnsignedMicros as UnsignedMicrosSchema,
}
const Ledger = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: U32_MAX }))
const Version = Schema.Int.check(Schema.isGreaterThan(0))
const ReasonCodes = Schema.Array(NonEmptyString).check(Schema.isUnique())
const isStrictlyAscending = (values: ReadonlyArray<string>): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined || BigInt(previous) >= BigInt(current)) return false
  }
  return true
}
const OrderedDecimalIds = Schema.Array(DecimalId).check(
  Schema.isMinLength(1),
  Schema.isUnique(),
  Schema.makeFilter(isStrictlyAscending, { expected: 'strictly ascending decimal identifiers' }),
)

export enum Broker {
  Alpaca = 'ALPACA',
}

export enum AccountStatus {
  Active = 'ACTIVE',
  Restricted = 'RESTRICTED',
  Closed = 'CLOSED',
}

export enum OrderSide {
  Buy = 'BUY',
  Sell = 'SELL',
}

export enum OrderType {
  Market = 'MARKET',
  Limit = 'LIMIT',
  StopLimit = 'STOP_LIMIT',
}

const ProtectivePrices = {
  stopPriceMicros: PositiveMicros,
  stopLimitPriceMicros: PositiveMicros,
  profitLimitPriceMicros: PositiveMicros,
}

export const NativeProtectionSchema = Schema.TaggedUnion({
  Bracket: ProtectivePrices,
  Oco: { ...ProtectivePrices, entryDecisionHash: Sha256 },
  StopLimit: { stopPriceMicros: PositiveMicros, entryDecisionHash: Sha256 },
})
export type NativeProtection = typeof NativeProtectionSchema.Type
export const submittedBrokerOrderCount = (protection: NativeProtection | undefined): number =>
  protection?._tag === 'Bracket' ? 3 : protection?._tag === 'Oco' ? 2 : 1

export enum TimeInForce {
  Day = 'DAY',
  GoodUntilCanceled = 'GTC',
  ImmediateOrCancel = 'IOC',
  FillOrKill = 'FOK',
}

export enum OrderStatus {
  New = 'NEW',
  PartiallyFilled = 'PARTIALLY_FILLED',
  Filled = 'FILLED',
  Canceled = 'CANCELED',
  Expired = 'EXPIRED',
  Rejected = 'REJECTED',
  Pending = 'PENDING',
}

export enum MutationOutcome {
  Known = 'KNOWN',
  Unknown = 'UNKNOWN',
}

export enum IntentState {
  Planned = 'PLANNED',
  Approved = 'APPROVED',
  IoStarted = 'IO_STARTED',
  Acknowledged = 'ACKNOWLEDGED',
  Unknown = 'UNKNOWN',
  Terminal = 'TERMINAL',
  Recovered = 'RECOVERED',
}

export enum TerminalOutcome {
  Filled = 'FILLED',
  Canceled = 'CANCELED',
  Expired = 'EXPIRED',
  Rejected = 'REJECTED',
  Blocked = 'BLOCKED',
}

export enum RiskOutcome {
  Approved = 'APPROVED',
  Blocked = 'BLOCKED',
}

export enum ReconciliationStatus {
  Exact = 'EXACT',
  Discrepancy = 'DISCREPANCY',
}

export enum DiscrepancyKind {
  Account = 'ACCOUNT',
  Cash = 'CASH',
  Position = 'POSITION',
  Order = 'ORDER',
  Fill = 'FILL',
  Mutation = 'MUTATION',
  Accounting = 'ACCOUNTING',
  Valuation = 'VALUATION',
}

export enum Authority {
  Observe = 'OBSERVE',
  /** Durable wire value retained while execution is account-environment neutral. */
  Execution = 'PAPER',
}

export enum KillState {
  Clear = 'CLEAR',
  Active = 'ACTIVE',
}

const AccountSnapshotBase = Schema.Struct({
  schemaVersion: Schema.Literal(accountSnapshotSchemaVersion),
  accountId: NonEmptyString,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicros,
  equityMicros: SignedMicros,
  buyingPowerMicros: SignedMicros,
  cryptoFeeTier: Schema.NullOr(CryptoFeeTierSchema),
  observedAt: UtcInstant,
})

export const AccountSnapshotSchema = AccountSnapshotBase
export type AccountSnapshot = typeof AccountSnapshotSchema.Type

export const PositionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.position.v2'),
  accountId: NonEmptyString,
  symbol: SymbolName,
  quantityAtoms: SignedMicros,
  averageEntryPriceMicros: UnsignedMicros,
  costBasisMicros: SignedMicros,
  marketPriceMicros: UnsignedMicros,
  marketValueMicros: SignedMicros,
  unrealizedPnlMicros: SignedMicros,
  observedAt: UtcInstant,
})
export type Position = typeof PositionSchema.Type

const OrderBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyOrderV2SchemaVersion),
  accountId: NonEmptyString,
  brokerOrderId: NonEmptyString,
  parentBrokerOrderId: Schema.optionalKey(NonEmptyString),
  clientOrderId: NonEmptyString,
  intentId: Schema.optionalKey(Sha256),
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  quantityAtoms: Schema.optionalKey(PositiveMicros),
  notionalMicros: Schema.optionalKey(PositiveMicros),
  filledQuantityAtoms: UnsignedMicros,
  limitPriceMicros: Schema.optionalKey(PositiveMicros),
  stopPriceMicros: Schema.optionalKey(PositiveMicros),
  status: Schema.Enum(OrderStatus),
  observedAt: UtcInstant,
})

export const OrderSchema = OrderBase.check(
  Schema.makeFilter((order: typeof OrderBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    const hasQuantity = order.quantityAtoms !== undefined
    const hasNotional = order.notionalMicros !== undefined
    if (hasQuantity === hasNotional) {
      issues.push({ path: ['quantityAtoms'], issue: 'provider order must contain exactly one quantity or notional' })
    }
    const filledQuantity = BigInt(order.filledQuantityAtoms)
    if (order.quantityAtoms !== undefined) {
      const quantity = BigInt(order.quantityAtoms)
      if (filledQuantity > quantity) {
        issues.push({ path: ['filledQuantityAtoms'], issue: 'must not exceed quantityAtoms' })
      }
      if (order.status === OrderStatus.Filled && filledQuantity !== quantity) {
        issues.push({ path: ['filledQuantityAtoms'], issue: 'must equal quantityAtoms for a filled order' })
      }
      if (order.status === OrderStatus.PartiallyFilled && (filledQuantity === 0n || filledQuantity >= quantity)) {
        issues.push({
          path: ['filledQuantityAtoms'],
          issue: 'must be between zero and quantityAtoms for a partial fill',
        })
      }
      if (
        (order.status === OrderStatus.Canceled ||
          order.status === OrderStatus.Expired ||
          order.status === OrderStatus.Rejected) &&
        filledQuantity >= quantity
      ) {
        issues.push({
          path: ['filledQuantityAtoms'],
          issue: 'must be less than quantityAtoms for an unfilled terminal order',
        })
      }
    } else if (
      (order.status === OrderStatus.Filled || order.status === OrderStatus.PartiallyFilled) &&
      filledQuantity === 0n
    ) {
      issues.push({ path: ['filledQuantityAtoms'], issue: 'must be positive for a filled notional order' })
    }
    if ((order.status === OrderStatus.New || order.status === OrderStatus.Pending) && filledQuantity !== 0n) {
      issues.push({ path: ['filledQuantityAtoms'], issue: 'must be zero before any fill' })
    }
    if (
      (order.orderType === OrderType.Limit || order.orderType === OrderType.StopLimit) &&
      order.limitPriceMicros === undefined
    ) {
      issues.push({ path: ['limitPriceMicros'], issue: 'is required for a limit order' })
    }
    if ((order.orderType === OrderType.StopLimit) !== (order.stopPriceMicros !== undefined))
      issues.push({ path: ['stopPriceMicros'], issue: 'is required exactly for a stop-limit order' })
    if (order.orderType === OrderType.Market && order.limitPriceMicros !== undefined) {
      issues.push({ path: ['limitPriceMicros'], issue: 'must be absent for a market order' })
    }
    if (hasNotional && order.orderType !== OrderType.Market) {
      issues.push({ path: ['notionalMicros'], issue: 'is supported only for market orders' })
    }
    return issues
  }),
)
export type Order = typeof OrderSchema.Type

export const FillSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyFillSchemaVersion),
  accountId: NonEmptyString,
  fillId: NonEmptyString,
  brokerOrderId: NonEmptyString,
  clientOrderId: NonEmptyString,
  intentId: Schema.optionalKey(Sha256),
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  quantityAtoms: PositiveMicros,
  priceAtoms: PositiveMicros,
  feeMicros: UnsignedMicros,
  occurredAt: UtcInstant,
})
export type Fill = typeof FillSchema.Type

const SourceFields = {
  schemaVersion: Schema.Literal(legacyBrokerEventSchemaVersion),
  eventId: Sha256,
  contentHash: Sha256,
  broker: Schema.Enum(Broker),
  accountId: NonEmptyString,
  sourceEventId: NonEmptyString,
  sourceSequence: Sequence,
  occurredAt: UtcInstant,
  observedAt: UtcInstant,
} as const

const BrokerEventBase = Schema.TaggedUnion({
  Account: { ...SourceFields, account: AccountSnapshotSchema },
  Position: { ...SourceFields, position: PositionSchema },
  Order: { ...SourceFields, order: OrderSchema },
  Fill: { ...SourceFields, sourceTimestamp: UtcOrderTimestamp, fill: FillSchema },
})

const brokerEventAccountId = (event: typeof BrokerEventBase.Type): string => {
  switch (event._tag) {
    case 'Account':
      return event.account.accountId
    case 'Position':
      return event.position.accountId
    case 'Order':
      return event.order.accountId
    case 'Fill':
      return event.fill.accountId
  }
}

const brokerEventPayloadTime = (event: typeof BrokerEventBase.Type): string => {
  switch (event._tag) {
    case 'Account':
      return event.account.observedAt
    case 'Position':
      return event.position.observedAt
    case 'Order':
      return event.order.observedAt
    case 'Fill':
      return event.fill.occurredAt
  }
}

export const BrokerEventSchema = BrokerEventBase.check(
  Schema.makeFilter((event: typeof BrokerEventBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (event.observedAt < event.occurredAt) {
      issues.push({ path: ['observedAt'], issue: 'must not precede occurredAt' })
    }
    const payloadAccountId = brokerEventAccountId(event)
    if (payloadAccountId !== event.accountId) {
      issues.push({ path: [event._tag.toLowerCase(), 'accountId'], issue: 'must match the source accountId' })
    }
    const expectedPayloadTime = event._tag === 'Fill' ? event.occurredAt : event.observedAt
    if (brokerEventPayloadTime(event) !== expectedPayloadTime) {
      issues.push({ path: [event._tag.toLowerCase()], issue: 'timestamp must match the source event' })
    }
    return issues
  }),
)

const intentFields = {
  intentId: Sha256,
  riskDecisionId: Schema.optionalKey(Sha256),
  strategyName: NonEmptyString,
  cycleId: Sha256,
  decisionHash: Sha256,
  policyHash: Sha256,
  accountId: NonEmptyString,
  clientOrderId: NonEmptyString,
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Literals([OrderType.Limit, OrderType.StopLimit]),
  timeInForce: Schema.Literals([TimeInForce.Day, TimeInForce.ImmediateOrCancel, TimeInForce.GoodUntilCanceled]),
  quantityAtoms: PositiveMicros,
  notionalLimitMicros: PositiveMicros,
  limitPriceMicros: PositiveMicros,
  protection: Schema.optionalKey(NativeProtectionSchema),
  /** Hash of the prior close plan that authorizes a distinct residual close generation. */
  replanGenerationHash: Schema.optionalKey(Sha256),
  state: Schema.Enum(IntentState),
  terminalOutcome: Schema.optionalKey(Schema.Enum(TerminalOutcome)),
  createdAt: UtcInstant,
} as const

const ReferenceIntentBase = Schema.Struct({
  schemaVersion: Schema.Literal(referenceIntentSchemaVersion),
  ...intentFields,
})

const IntentBase = Schema.Struct({
  schemaVersion: Schema.Literal(executionIntentSchemaVersion),
  authorityGenerationHash: Sha256,
  ...intentFields,
})

type IntentContract = typeof ReferenceIntentBase.Type | typeof IntentBase.Type

const intentContractIssues = (intent: IntentContract): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const crypto = instrumentMarket(intent.symbol) === MarketKind.Crypto
  const protection = intent.protection
  const stop = protection?._tag === 'StopLimit'
  const group = protection?._tag === 'Bracket' || protection?._tag === 'Oco'
  if (
    stop !== (intent.orderType === OrderType.StopLimit) ||
    (protection?._tag === 'Bracket' && (crypto || intent.side !== OrderSide.Buy)) ||
    (protection?._tag === 'Oco' && (crypto || intent.side !== OrderSide.Sell)) ||
    (stop && intent.side !== OrderSide.Sell)
  )
    issues.push({ path: ['protection'], issue: 'native protection must match its market, side and order type' })
  if (stop && BigInt(intent.limitPriceMicros) > BigInt(protection.stopPriceMicros))
    issues.push({ path: ['limitPriceMicros'], issue: 'a sell stop-limit floor cannot exceed its trigger' })
  if (
    group &&
    (BigInt(protection.stopLimitPriceMicros) > BigInt(protection.stopPriceMicros) ||
      BigInt(protection.stopPriceMicros) >= BigInt(protection.profitLimitPriceMicros) ||
      (protection._tag === 'Oco' && intent.limitPriceMicros !== protection.profitLimitPriceMicros))
  )
    issues.push({ path: ['protection'], issue: 'linked sell exits must preserve their ordered strategy prices' })
  const duration = stop
    ? crypto
      ? TimeInForce.GoodUntilCanceled
      : TimeInForce.Day
    : crypto
      ? TimeInForce.ImmediateOrCancel
      : TimeInForce.Day
  if (intent.timeInForce !== duration)
    issues.push({ path: ['timeInForce'], issue: 'must use the native instrument LIMIT duration' })
  const notional =
    (BigInt(intent.quantityAtoms) * BigInt(intent.limitPriceMicros) +
      (intent.side === OrderSide.Buy ? quantityScale - 1n : 0n)) /
    quantityScale
  if (notional !== BigInt(intent.notionalLimitMicros))
    issues.push({ path: ['notionalLimitMicros'], issue: 'must match the explicit LIMIT price and quantity' })
  const terminal = intent.state === IntentState.Terminal
  if (terminal !== (intent.terminalOutcome !== undefined)) {
    issues.push({
      path: ['terminalOutcome'],
      issue: terminal ? 'is required for a terminal intent' : 'must be absent before terminal state',
    })
  }
  const planned = intent.state === IntentState.Planned
  if (planned === (intent.riskDecisionId !== undefined)) {
    issues.push({
      path: ['riskDecisionId'],
      issue: planned ? 'must be absent before risk evaluation' : 'is required after risk evaluation',
    })
  }
  return issues
}

export const ReferenceIntentSchema = ReferenceIntentBase.check(Schema.makeFilter(intentContractIssues))
export type ReferenceIntent = typeof ReferenceIntentSchema.Type

export const IntentSchema = IntentBase.check(Schema.makeFilter(intentContractIssues))
export type Intent = typeof IntentSchema.Type

const RiskInputBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyRiskInputSchemaVersion),
  inputHash: Sha256,
  intentId: Sha256,
  policyHash: Sha256,
  accountSnapshotHash: Sha256,
  positionsHash: Sha256,
  ordersHash: Sha256,
  marketDataHash: Sha256,
  evaluatedAt: UtcInstant,
  freshUntil: UtcInstant,
})

export const RiskInputSchema = RiskInputBase.check(
  Schema.makeFilter((input: typeof RiskInputBase.Type) =>
    input.freshUntil > input.evaluatedAt ? [] : [{ path: ['freshUntil'], issue: 'must follow evaluatedAt' }],
  ),
)

const RiskDecisionBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyRiskDecisionSchemaVersion),
  decisionId: Sha256,
  inputHash: Sha256,
  intentId: Sha256,
  policyHash: Sha256,
  outcome: Schema.Enum(RiskOutcome),
  reasonCodes: ReasonCodes,
  decidedAt: UtcInstant,
  expiresAt: UtcInstant,
})

export const RiskDecisionSchema = RiskDecisionBase.check(
  Schema.makeFilter((decision: typeof RiskDecisionBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (decision.expiresAt <= decision.decidedAt) {
      issues.push({ path: ['expiresAt'], issue: 'must follow decidedAt' })
    }
    const expectedReasons = decision.outcome === RiskOutcome.Blocked
    if (expectedReasons === (decision.reasonCodes.length === 0)) {
      issues.push({
        path: ['reasonCodes'],
        issue: expectedReasons ? 'must explain a blocked decision' : 'must be empty for an approved decision',
      })
    }
    return issues
  }),
)
export type RiskDecision = typeof RiskDecisionSchema.Type

const AccountingReceiptBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyAccountingReceiptSchemaVersion),
  receiptId: Sha256,
  intentId: Schema.optionalKey(Sha256),
  brokerEventId: Sha256,
  tigerBeetleClusterId: DecimalId,
  tigerBeetleLedger: Ledger,
  accountIds: OrderedDecimalIds.check(Schema.isMinLength(2)),
  transferIds: OrderedDecimalIds,
  debitMicros: PositiveMicros,
  creditMicros: PositiveMicros,
  contentHash: Sha256,
  recordedAt: UtcInstant,
})

export const AccountingReceiptSchema = AccountingReceiptBase.check(
  Schema.makeFilter((receipt: typeof AccountingReceiptBase.Type) =>
    receipt.debitMicros === receipt.creditMicros ? [] : [{ path: ['creditMicros'], issue: 'must equal debitMicros' }],
  ),
)
export type AccountingReceipt = typeof AccountingReceiptSchema.Type

const ValuationBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyValuationSchemaVersion),
  valuationId: Sha256,
  accountId: NonEmptyString,
  sourceHash: Sha256,
  cashMicros: SignedMicros,
  longMarketValueMicros: UnsignedMicros,
  shortMarketValueMicros: NonPositiveMicros,
  equityMicros: SignedMicros,
  asOf: UtcInstant,
})

export const ValuationSchema = ValuationBase.check(
  Schema.makeFilter((valuation: typeof ValuationBase.Type) =>
    BigInt(valuation.equityMicros) ===
    BigInt(valuation.cashMicros) + BigInt(valuation.longMarketValueMicros) + BigInt(valuation.shortMarketValueMicros)
      ? []
      : [{ path: ['equityMicros'], issue: 'must equal cash plus long and short market value' }],
  ),
)
export type Valuation = typeof ValuationSchema.Type

const DiscrepancyBase = Schema.Struct({
  discrepancyId: Sha256,
  kind: Schema.Enum(DiscrepancyKind),
  identity: NonEmptyString,
  expected: NonEmptyString,
  observed: NonEmptyString,
  evidenceHash: Sha256,
  firstObservedAt: UtcInstant,
  lastObservedAt: UtcInstant,
})
export const DiscrepancySchema = DiscrepancyBase.check(
  Schema.makeFilter((value: typeof DiscrepancyBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (value.lastObservedAt < value.firstObservedAt) {
      issues.push({ path: ['lastObservedAt'], issue: 'must not precede firstObservedAt' })
    }
    if (value.expected === value.observed) {
      issues.push({ path: ['observed'], issue: 'must differ while the discrepancy is open' })
    }
    return issues
  }),
)
export type Discrepancy = typeof DiscrepancySchema.Type

const ReconciliationBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyReconciliationSchemaVersion),
  reconciliationId: Sha256,
  accountId: NonEmptyString,
  expectedHash: Sha256,
  observedHash: Sha256,
  contentHash: Sha256,
  status: Schema.Enum(ReconciliationStatus),
  discrepancies: Schema.Array(DiscrepancySchema),
  reconciledAt: UtcInstant,
})

export const ReconciliationSchema = ReconciliationBase.check(
  Schema.makeFilter((reconciliation: typeof ReconciliationBase.Type) => {
    const exact = reconciliation.status === ReconciliationStatus.Exact
    const matches = reconciliation.expectedHash === reconciliation.observedHash
    if (exact && matches && reconciliation.discrepancies.length === 0) return []
    if (!exact && !matches && reconciliation.discrepancies.length > 0) return []
    return [{ path: ['status'], issue: 'must agree with hashes and discrepancies' }]
  }),
)
export type Reconciliation = typeof ReconciliationSchema.Type

export const CapitalGrantProofBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyAuthorityProofBindingSchemaVersion),
  riskPolicyHash: Sha256,
  proofPlanHash: Sha256,
})

export const ResearchCapitalGrantProofBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyResearchGrantProofSchemaVersion),
  grant: ResearchCapitalGrantSchema,
  activationSourceRevision: SourceRevision,
  activationImageRepository: NonEmptyString,
  activationImageDigest: ImageDigest,
  strategyName: NonEmptyString,
  strategyBehaviorHash: Sha256,
  strategyParameterHash: Sha256,
  strategyParameterSchemaVersion: NonEmptyString,
  strategyProtocolHash: Sha256,
  accountId: NonEmptyString,
  brokerIdentityHash: Sha256,
  riskPolicyHash: Sha256,
  proofPlanHash: Sha256,
})
export type ResearchCapitalGrantProofBinding = typeof ResearchCapitalGrantProofBindingSchema.Type

const CapitalGrantGenerationIdentityMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyAuthorityGenerationV2SchemaVersion),
  maximum: Schema.Literal(Authority.Execution),
  previousGenerationHash: Sha256,
  qualificationRunId: Sha256,
  qualificationLockId: Sha256,
  qualificationResultHash: Sha256,
  protocolHash: Sha256,
  qualificationExecutionPolicyHash: Sha256,
  qualificationSourceRevision: SourceRevision,
  qualificationImageRepository: NonEmptyString,
  qualificationImageDigest: ImageDigest,
  activationSourceRevision: SourceRevision,
  activationImageRepository: NonEmptyString,
  activationImageDigest: ImageDigest,
  strategyName: NonEmptyString,
  strategyBehaviorHash: Sha256,
  strategyParameterHash: Sha256,
  strategyParameterSchemaVersion: NonEmptyString,
  accountId: NonEmptyString,
  riskPolicyHash: Sha256,
  proofPlanHash: Sha256,
})

export const CapitalGrantGenerationMaterialSchema = Schema.Struct({
  ...CapitalGrantGenerationIdentityMaterialSchema.fields,
  reconciliationId: Sha256,
  reconciliationContentHash: Sha256,
})
export type CapitalGrantGenerationMaterial = typeof CapitalGrantGenerationMaterialSchema.Type

const capitalGrantGenerationIdentity = (material: CapitalGrantGenerationMaterial) => {
  const {
    reconciliationContentHash: _reconciliationContentHash,
    reconciliationId: _reconciliationId,
    ...identity
  } = material
  return identity
}

const CapitalGrantGenerationBase = Schema.Struct({
  ...CapitalGrantGenerationMaterialSchema.fields,
  generationHash: Sha256,
})

export const CapitalGrantGenerationSchema = CapitalGrantGenerationBase.check(
  Schema.makeFilter(
    (generation: typeof CapitalGrantGenerationBase.Type) => {
      const { generationHash, ...material } = generation
      const expectedHash = canonicalHashV1Result(capitalGrantGenerationIdentity(material))
      return Result.isSuccess(expectedHash) && generationHash === expectedHash.success
    },
    { expected: 'a generation hash matching the stable execution authority identity' },
  ),
)
export type CapitalGrantGeneration = typeof CapitalGrantGenerationSchema.Type

export type CapitalGrantGenerationConstructionFailure =
  | {
      readonly _tag: 'CapitalGrantGenerationSchemaInvalid'
      readonly operation: 'material' | 'generation'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'CapitalGrantGenerationCanonicalizationFailed'
      readonly cause: CanonicalHashFailure
    }

const decodeCapitalGrantGenerationMaterialResult = Schema.decodeUnknownResult(
  CapitalGrantGenerationMaterialSchema,
  StrictParseOptions,
)
const decodeCapitalGrantGenerationResult = Schema.decodeUnknownResult(CapitalGrantGenerationSchema, StrictParseOptions)

export const makeCapitalGrantGenerationResult = (
  input: CapitalGrantGenerationMaterial,
): Result.Result<CapitalGrantGeneration, CapitalGrantGenerationConstructionFailure> =>
  pipe(
    decodeCapitalGrantGenerationMaterialResult(input),
    Result.mapError(
      (cause): CapitalGrantGenerationConstructionFailure => ({
        _tag: 'CapitalGrantGenerationSchemaInvalid',
        operation: 'material',
        cause,
      }),
    ),
    Result.flatMap((material) =>
      pipe(
        canonicalHashV1Result(capitalGrantGenerationIdentity(material)),
        Result.mapError(
          (cause): CapitalGrantGenerationConstructionFailure => ({
            _tag: 'CapitalGrantGenerationCanonicalizationFailed',
            cause,
          }),
        ),
        Result.flatMap((generationHash) =>
          pipe(
            decodeCapitalGrantGenerationResult({ ...material, generationHash }),
            Result.mapError(
              (cause): CapitalGrantGenerationConstructionFailure => ({
                _tag: 'CapitalGrantGenerationSchemaInvalid',
                operation: 'generation',
                cause,
              }),
            ),
          ),
        ),
      ),
    ),
  )

const ResearchCapitalGrantGenerationIdentityMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyAuthorityGenerationV3SchemaVersion),
  maximum: Schema.Literal(Authority.Execution),
  previousGenerationHash: Sha256,
  grant: ResearchCapitalGrantSchema,
  activationSourceRevision: SourceRevision,
  activationImageRepository: NonEmptyString,
  activationImageDigest: ImageDigest,
  strategyName: NonEmptyString,
  strategyBehaviorHash: Sha256,
  strategyParameterHash: Sha256,
  strategyParameterSchemaVersion: NonEmptyString,
  strategyProtocolHash: Sha256,
  accountId: NonEmptyString,
  brokerIdentityHash: Sha256,
  riskPolicyHash: Sha256,
  proofPlanHash: Sha256,
})

export const ResearchCapitalGrantGenerationMaterialSchema = Schema.Struct({
  ...ResearchCapitalGrantGenerationIdentityMaterialSchema.fields,
  reconciliationId: Sha256,
  reconciliationContentHash: Sha256,
})
export type ResearchCapitalGrantGenerationMaterial = typeof ResearchCapitalGrantGenerationMaterialSchema.Type

const researchCapitalGrantGenerationIdentity = (material: ResearchCapitalGrantGenerationMaterial) => {
  const {
    reconciliationContentHash: _reconciliationContentHash,
    reconciliationId: _reconciliationId,
    ...identity
  } = material
  return identity
}

const ResearchCapitalGrantGenerationBase = Schema.Struct({
  ...ResearchCapitalGrantGenerationMaterialSchema.fields,
  generationHash: Sha256,
})

export const ResearchCapitalGrantGenerationSchema = ResearchCapitalGrantGenerationBase.check(
  Schema.makeFilter(
    (generation: typeof ResearchCapitalGrantGenerationBase.Type) => {
      const { generationHash, ...material } = generation
      const expectedHash = canonicalHashV1Result(researchCapitalGrantGenerationIdentity(material))
      return Result.isSuccess(expectedHash) && generationHash === expectedHash.success
    },
    { expected: 'a generation hash matching the stable research execution authority identity' },
  ),
)
export type ResearchCapitalGrantGeneration = typeof ResearchCapitalGrantGenerationSchema.Type

export type ResearchCapitalGrantGenerationConstructionFailure =
  | {
      readonly _tag: 'ResearchCapitalGrantGenerationSchemaInvalid'
      readonly operation: 'material' | 'generation'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'ResearchCapitalGrantGenerationCanonicalizationFailed'
      readonly cause: CanonicalHashFailure
    }

const decodeResearchCapitalGrantGenerationMaterialResult = Schema.decodeUnknownResult(
  ResearchCapitalGrantGenerationMaterialSchema,
  StrictParseOptions,
)
const decodeResearchCapitalGrantGenerationResult = Schema.decodeUnknownResult(
  ResearchCapitalGrantGenerationSchema,
  StrictParseOptions,
)

export const makeResearchCapitalGrantGenerationResult = (
  input: ResearchCapitalGrantGenerationMaterial,
): Result.Result<ResearchCapitalGrantGeneration, ResearchCapitalGrantGenerationConstructionFailure> =>
  pipe(
    decodeResearchCapitalGrantGenerationMaterialResult(input),
    Result.mapError(
      (cause): ResearchCapitalGrantGenerationConstructionFailure => ({
        _tag: 'ResearchCapitalGrantGenerationSchemaInvalid',
        operation: 'material',
        cause,
      }),
    ),
    Result.flatMap((material) =>
      pipe(
        canonicalHashV1Result(researchCapitalGrantGenerationIdentity(material)),
        Result.mapError(
          (cause): ResearchCapitalGrantGenerationConstructionFailure => ({
            _tag: 'ResearchCapitalGrantGenerationCanonicalizationFailed',
            cause,
          }),
        ),
        Result.flatMap((generationHash) =>
          pipe(
            decodeResearchCapitalGrantGenerationResult({ ...material, generationHash }),
            Result.mapError(
              (cause): ResearchCapitalGrantGenerationConstructionFailure => ({
                _tag: 'ResearchCapitalGrantGenerationSchemaInvalid',
                operation: 'generation',
                cause,
              }),
            ),
          ),
        ),
      ),
    ),
  )

const AuthorityStateBase = Schema.Struct({
  schemaVersion: Schema.Literal(legacyAuthorityStateSchemaVersion),
  generationHash: Sha256,
  maximum: Schema.Enum(Authority),
  effective: Schema.Enum(Authority),
  kill: Schema.Enum(KillState),
  reason: Schema.optionalKey(NonEmptyString),
  version: Version,
  updatedAt: UtcDatabaseInstantSchema,
})

export const AuthorityStateSchema = AuthorityStateBase.check(
  Schema.makeFilter((authority: typeof AuthorityStateBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (authority.maximum === Authority.Observe && authority.effective !== Authority.Observe) {
      issues.push({ path: ['effective'], issue: 'must not exceed the GitOps maximum' })
    }
    if (authority.kill === KillState.Active && authority.effective !== Authority.Observe) {
      issues.push({ path: ['effective'], issue: 'must be OBSERVE while the kill is active' })
    }
    if ((authority.kill === KillState.Active) !== (authority.reason !== undefined)) {
      issues.push({
        path: ['reason'],
        issue: authority.kill === KillState.Active ? 'is required while killed' : 'must be absent while clear',
      })
    }
    return issues
  }),
)
export type AuthorityState = typeof AuthorityStateSchema.Type

export const decodeBrokerEvent = Schema.decodeUnknownEffect(BrokerEventSchema, StrictParseOptions)

export const decodePosition = Schema.decodeUnknownEffect(PositionSchema, StrictParseOptions)

export const decodeOrder = Schema.decodeUnknownEffect(OrderSchema, StrictParseOptions)

export const decodeFill = Schema.decodeUnknownEffect(FillSchema, StrictParseOptions)

export const decodeIntent = Schema.decodeUnknownEffect(IntentSchema, StrictParseOptions)

export const decodeAccountingReceipt = Schema.decodeUnknownEffect(AccountingReceiptSchema, StrictParseOptions)

export const decodeValuation = Schema.decodeUnknownEffect(ValuationSchema, StrictParseOptions)

export const decodeReconciliation = Schema.decodeUnknownEffect(ReconciliationSchema, StrictParseOptions)

export const decodeResearchCapitalGrantProofBinding = Schema.decodeUnknownEffect(
  ResearchCapitalGrantProofBindingSchema,
  StrictParseOptions,
)

export const decodeResearchCapitalGrantGeneration = Schema.decodeUnknownEffect(
  ResearchCapitalGrantGenerationSchema,
  StrictParseOptions,
)

export const decodeAuthorityState = Schema.decodeUnknownEffect(AuthorityStateSchema, StrictParseOptions)
