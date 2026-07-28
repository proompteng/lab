import { Schema } from 'effect'

import {
  PositiveMicrosSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

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

export type SignedMicros = string
export type UnsignedMicros = string
export type PositiveMicros = string
export type Sha256 = string
export type UtcInstant = string

export interface AccountSnapshot {
  readonly accountId: string
  readonly status: AccountStatus
  readonly currency: 'USD'
  readonly cashMicros: SignedMicros
  readonly equityMicros: SignedMicros
  readonly buyingPowerMicros: SignedMicros
  readonly observedAt: UtcInstant
}

export interface Position {
  readonly accountId: string
  readonly symbol: string
  readonly quantityMicros: SignedMicros
  readonly averageEntryPriceMicros: UnsignedMicros
  readonly marketPriceMicros: UnsignedMicros
  readonly marketValueMicros: SignedMicros
  readonly unrealizedPnlMicros: SignedMicros
  readonly observedAt: UtcInstant
}

export interface Order {
  readonly accountId: string
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly intentId?: Sha256
  readonly symbol: string
  readonly side: OrderSide
  readonly orderType: OrderType
  readonly timeInForce: TimeInForce
  readonly quantityMicros: PositiveMicros
  readonly filledQuantityMicros: UnsignedMicros
  readonly limitPriceMicros?: PositiveMicros
  readonly status: OrderStatus
  readonly observedAt: UtcInstant
}

export interface Fill {
  readonly accountId: string
  readonly fillId: string
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly intentId?: Sha256
  readonly symbol: string
  readonly side: OrderSide
  readonly quantityMicros: PositiveMicros
  readonly priceMicros: PositiveMicros
  readonly feeMicros: UnsignedMicros
  readonly occurredAt: UtcInstant
}

export interface BrokerError {
  readonly requestId: string
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly mutationOutcome: MutationOutcome
  readonly observedAt: UtcInstant
}

export interface RateLimit {
  readonly limit: string
  readonly remaining: string
  readonly resetsAt: UtcInstant
  readonly observedAt: UtcInstant
}

interface BrokerEventSource {
  readonly eventId: Sha256
  readonly contentHash: Sha256
  readonly broker: Broker
  readonly accountId: string
  readonly sourceEventId: string
  readonly sourceSequence: string
  readonly occurredAt: UtcInstant
  readonly observedAt: UtcInstant
}

export type BrokerEvent =
  | (BrokerEventSource & { readonly _tag: 'Account'; readonly account: AccountSnapshot })
  | (BrokerEventSource & { readonly _tag: 'Position'; readonly position: Position })
  | (BrokerEventSource & { readonly _tag: 'Order'; readonly order: Order })
  | (BrokerEventSource & { readonly _tag: 'Fill'; readonly sourceTimestamp: string; readonly fill: Fill })
  | (BrokerEventSource & { readonly _tag: 'Error'; readonly error: BrokerError })
  | (BrokerEventSource & { readonly _tag: 'RateLimit'; readonly rateLimit: RateLimit })

const IntentFieldsSchema = {
  intentId: Sha256Schema,
  riskDecisionId: Schema.optionalKey(Sha256Schema),
  strategyName: StrictNonEmptyStringSchema,
  cycleId: Sha256Schema,
  decisionHash: Sha256Schema,
  policyHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  clientOrderId: StrictNonEmptyStringSchema,
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  quantityMicros: PositiveMicrosSchema,
  notionalLimitMicros: PositiveMicrosSchema,
  state: Schema.Enum(IntentState),
  terminalOutcome: Schema.optionalKey(Schema.Enum(TerminalOutcome)),
  createdAt: UtcInstantSchema,
} as const

const intentContractIssues = (intent: {
  readonly state: IntentState
  readonly terminalOutcome?: TerminalOutcome
  readonly riskDecisionId?: string
}): readonly Schema.FilterIssue[] => {
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
}

export const ReferenceIntentSchema = Schema.Struct(IntentFieldsSchema).check(Schema.makeFilter(intentContractIssues))
export type ReferenceIntent = typeof ReferenceIntentSchema.Type

const ExecutionIntentBase = Schema.Struct({
  authorityGenerationHash: Sha256Schema,
  ...IntentFieldsSchema,
})

export const ExecutionIntentSchema = ExecutionIntentBase.check(Schema.makeFilter(intentContractIssues))
export type Intent = typeof ExecutionIntentSchema.Type
export const decodeExecutionIntentResult = Schema.decodeUnknownResult(ExecutionIntentSchema, strictParseOptions)

export interface RiskInput {
  readonly inputHash: Sha256
  readonly intentId: Sha256
  readonly policyHash: Sha256
  readonly accountSnapshotHash: Sha256
  readonly positionsHash: Sha256
  readonly ordersHash: Sha256
  readonly marketDataHash: Sha256
  readonly evaluatedAt: UtcInstant
  readonly freshUntil: UtcInstant
}

export interface RiskDecision {
  readonly decisionId: Sha256
  readonly inputHash: Sha256
  readonly intentId: Sha256
  readonly policyHash: Sha256
  readonly outcome: RiskOutcome
  readonly reasonCodes: readonly string[]
  readonly decidedAt: UtcInstant
  readonly expiresAt: UtcInstant
}

export interface AccountingReceipt {
  readonly receiptId: Sha256
  readonly intentId?: Sha256
  readonly brokerEventId: Sha256
  readonly tigerBeetleClusterId: string
  readonly tigerBeetleLedger: number
  readonly accountIds: readonly string[]
  readonly transferIds: readonly string[]
  readonly debitMicros: PositiveMicros
  readonly creditMicros: PositiveMicros
  readonly contentHash: Sha256
  readonly recordedAt: UtcInstant
}

export interface Valuation {
  readonly valuationId: Sha256
  readonly accountId: string
  readonly sourceHash: Sha256
  readonly cashMicros: SignedMicros
  readonly longMarketValueMicros: UnsignedMicros
  readonly shortMarketValueMicros: SignedMicros
  readonly equityMicros: SignedMicros
  readonly asOf: UtcInstant
}

export interface Discrepancy {
  readonly discrepancyId: Sha256
  readonly kind: DiscrepancyKind
  readonly identity: string
  readonly expected: string
  readonly observed: string
  readonly evidenceHash: Sha256
  readonly firstObservedAt: UtcInstant
  readonly lastObservedAt: UtcInstant
}

export interface Reconciliation {
  readonly reconciliationId: Sha256
  readonly accountId: string
  readonly expectedHash: Sha256
  readonly observedHash: Sha256
  readonly contentHash: Sha256
  readonly status: ReconciliationStatus
  readonly discrepancies: readonly Discrepancy[]
  readonly reconciledAt: UtcInstant
}
