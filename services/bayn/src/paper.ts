import { Schema } from 'effect'

import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  UtcOrderTimestampSchema as UtcOrderTimestamp,
  strictParseOptions as StrictParseOptions,
} from './schemas'

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
    if (BigInt(values[index - 1]) >= BigInt(values[index])) return false
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
}

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
  Paper = 'PAPER',
}

export enum KillState {
  Clear = 'CLEAR',
  Active = 'ACTIVE',
}

const AccountSnapshotBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-account-snapshot.v1'),
  accountId: NonEmptyString,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicros,
  equityMicros: SignedMicros,
  buyingPowerMicros: SignedMicros,
  observedAt: UtcInstant,
})

export const AccountSnapshotSchema = AccountSnapshotBase
export type AccountSnapshot = typeof AccountSnapshotSchema.Type

export const PositionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-position.v1'),
  accountId: NonEmptyString,
  symbol: SymbolName,
  quantityMicros: SignedMicros,
  averageEntryPriceMicros: UnsignedMicros,
  marketPriceMicros: UnsignedMicros,
  marketValueMicros: SignedMicros,
  unrealizedPnlMicros: SignedMicros,
  observedAt: UtcInstant,
})
export type Position = typeof PositionSchema.Type

const OrderBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-order.v1'),
  accountId: NonEmptyString,
  brokerOrderId: NonEmptyString,
  clientOrderId: NonEmptyString,
  intentId: Schema.optionalKey(Sha256),
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  quantityMicros: PositiveMicros,
  filledQuantityMicros: UnsignedMicros,
  limitPriceMicros: Schema.optionalKey(PositiveMicros),
  status: Schema.Enum(OrderStatus),
  observedAt: UtcInstant,
})

export const OrderSchema = OrderBase.check(
  Schema.makeFilter((order: typeof OrderBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (BigInt(order.filledQuantityMicros) > BigInt(order.quantityMicros)) {
      issues.push({ path: ['filledQuantityMicros'], issue: 'must not exceed quantityMicros' })
    }
    const filledQuantity = BigInt(order.filledQuantityMicros)
    const quantity = BigInt(order.quantityMicros)
    if (order.status === OrderStatus.Filled && filledQuantity !== quantity) {
      issues.push({ path: ['filledQuantityMicros'], issue: 'must equal quantityMicros for a filled order' })
    }
    if (order.status === OrderStatus.PartiallyFilled && (filledQuantity === 0n || filledQuantity >= quantity)) {
      issues.push({
        path: ['filledQuantityMicros'],
        issue: 'must be between zero and quantityMicros for a partial fill',
      })
    }
    if ((order.status === OrderStatus.New || order.status === OrderStatus.Pending) && filledQuantity !== 0n) {
      issues.push({ path: ['filledQuantityMicros'], issue: 'must be zero before any fill' })
    }
    if (
      (order.status === OrderStatus.Canceled ||
        order.status === OrderStatus.Expired ||
        order.status === OrderStatus.Rejected) &&
      filledQuantity >= quantity
    ) {
      issues.push({
        path: ['filledQuantityMicros'],
        issue: 'must be less than quantityMicros for an unfilled terminal order',
      })
    }
    if (order.orderType === OrderType.Limit && order.limitPriceMicros === undefined) {
      issues.push({ path: ['limitPriceMicros'], issue: 'is required for a limit order' })
    }
    if (order.orderType === OrderType.Market && order.limitPriceMicros !== undefined) {
      issues.push({ path: ['limitPriceMicros'], issue: 'must be absent for a market order' })
    }
    return issues
  }),
)
export type Order = typeof OrderSchema.Type

export const FillSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-fill.v1'),
  accountId: NonEmptyString,
  fillId: NonEmptyString,
  brokerOrderId: NonEmptyString,
  clientOrderId: NonEmptyString,
  intentId: Schema.optionalKey(Sha256),
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  quantityMicros: PositiveMicros,
  priceMicros: PositiveMicros,
  feeMicros: UnsignedMicros,
  occurredAt: UtcInstant,
})
export type Fill = typeof FillSchema.Type

export const BrokerErrorSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-broker-error.v1'),
  requestId: NonEmptyString,
  code: NonEmptyString,
  message: NonEmptyString,
  retryable: Schema.Boolean,
  mutationOutcome: Schema.Enum(MutationOutcome),
  observedAt: UtcInstant,
})
export type BrokerError = typeof BrokerErrorSchema.Type

const RateLimitBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-rate-limit.v1'),
  limit: Sequence,
  remaining: Sequence,
  resetsAt: UtcInstant,
  observedAt: UtcInstant,
})

export const RateLimitSchema = RateLimitBase.check(
  Schema.makeFilter((rateLimit: typeof RateLimitBase.Type) =>
    BigInt(rateLimit.remaining) <= BigInt(rateLimit.limit)
      ? []
      : [{ path: ['remaining'], issue: 'must not exceed limit' }],
  ),
)
export type RateLimit = typeof RateLimitSchema.Type

const SourceFields = {
  schemaVersion: Schema.Literal('bayn.paper-broker-event.v1'),
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
  Error: { ...SourceFields, error: BrokerErrorSchema },
  RateLimit: { ...SourceFields, rateLimit: RateLimitSchema },
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
    case 'Error':
    case 'RateLimit':
      return event.accountId
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
    case 'Error':
      return event.error.observedAt
    case 'RateLimit':
      return event.rateLimit.observedAt
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
export type BrokerEvent = typeof BrokerEventSchema.Type

const IntentBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-intent.v2'),
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
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  quantityMicros: PositiveMicros,
  notionalLimitMicros: PositiveMicros,
  state: Schema.Enum(IntentState),
  terminalOutcome: Schema.optionalKey(Schema.Enum(TerminalOutcome)),
  createdAt: UtcInstant,
})

export const IntentSchema = IntentBase.check(
  Schema.makeFilter((intent: typeof IntentBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
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
  }),
)
export type Intent = typeof IntentSchema.Type

const allowedTransitions: Readonly<Record<IntentState, readonly IntentState[]>> = {
  [IntentState.Planned]: [IntentState.Approved, IntentState.Terminal],
  [IntentState.Approved]: [IntentState.IoStarted, IntentState.Terminal],
  [IntentState.IoStarted]: [IntentState.Acknowledged, IntentState.Unknown, IntentState.Terminal],
  [IntentState.Acknowledged]: [IntentState.Terminal],
  [IntentState.Unknown]: [IntentState.Recovered],
  [IntentState.Recovered]: [IntentState.Acknowledged, IntentState.Terminal],
  [IntentState.Terminal]: [],
}

const allowedTerminalOutcomes: Readonly<Partial<Record<IntentState, readonly TerminalOutcome[]>>> = {
  [IntentState.Planned]: [TerminalOutcome.Blocked],
  [IntentState.Approved]: [TerminalOutcome.Blocked, TerminalOutcome.Canceled],
  [IntentState.IoStarted]: [
    TerminalOutcome.Filled,
    TerminalOutcome.Canceled,
    TerminalOutcome.Expired,
    TerminalOutcome.Rejected,
  ],
  [IntentState.Acknowledged]: [
    TerminalOutcome.Filled,
    TerminalOutcome.Canceled,
    TerminalOutcome.Expired,
    TerminalOutcome.Rejected,
  ],
  [IntentState.Recovered]: [
    TerminalOutcome.Filled,
    TerminalOutcome.Canceled,
    TerminalOutcome.Expired,
    TerminalOutcome.Rejected,
  ],
}

export const isIntentTransitionAllowed = (
  from: IntentState,
  to: IntentState,
  terminalOutcome?: TerminalOutcome,
): boolean => {
  if (!allowedTransitions[from].includes(to)) return false
  if (to !== IntentState.Terminal) return terminalOutcome === undefined
  return terminalOutcome !== undefined && (allowedTerminalOutcomes[from]?.includes(terminalOutcome) ?? false)
}

const RiskInputBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-risk-input.v1'),
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
export type RiskInput = typeof RiskInputSchema.Type

const RiskDecisionBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-risk-decision.v1'),
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
  schemaVersion: Schema.Literal('bayn.paper-accounting-receipt.v1'),
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
  schemaVersion: Schema.Literal('bayn.paper-valuation.v1'),
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
  schemaVersion: Schema.Literal('bayn.paper-reconciliation.v1'),
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

const AuthorityStateBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-authority.v1'),
  generationHash: Sha256,
  maximum: Schema.Enum(Authority),
  effective: Schema.Enum(Authority),
  kill: Schema.Enum(KillState),
  reason: Schema.optionalKey(NonEmptyString),
  version: Version,
  updatedAt: UtcInstant,
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
export const decodeAccountSnapshot = Schema.decodeUnknownEffect(AccountSnapshotSchema, StrictParseOptions)
export const decodePosition = Schema.decodeUnknownEffect(PositionSchema, StrictParseOptions)
export const decodeOrder = Schema.decodeUnknownEffect(OrderSchema, StrictParseOptions)
export const decodeFill = Schema.decodeUnknownEffect(FillSchema, StrictParseOptions)
export const decodeBrokerError = Schema.decodeUnknownEffect(BrokerErrorSchema, StrictParseOptions)
export const decodeRateLimit = Schema.decodeUnknownEffect(RateLimitSchema, StrictParseOptions)
export const decodeIntent = Schema.decodeUnknownEffect(IntentSchema, StrictParseOptions)
export const decodeRiskInput = Schema.decodeUnknownEffect(RiskInputSchema, StrictParseOptions)
export const decodeRiskDecision = Schema.decodeUnknownEffect(RiskDecisionSchema, StrictParseOptions)
export const decodeAccountingReceipt = Schema.decodeUnknownEffect(AccountingReceiptSchema, StrictParseOptions)
export const decodeValuation = Schema.decodeUnknownEffect(ValuationSchema, StrictParseOptions)
export const decodeReconciliation = Schema.decodeUnknownEffect(ReconciliationSchema, StrictParseOptions)
export const decodeAuthorityState = Schema.decodeUnknownEffect(AuthorityStateSchema, StrictParseOptions)
