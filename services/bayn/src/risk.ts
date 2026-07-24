import { Data, Result, Schema } from 'effect'

import { canonicalHashV1 } from './hash'
import { ExecutionSessionBindingSchema } from './execution-session'
import {
  AccountSnapshotSchema,
  AccountStatus,
  Authority,
  AuthorityStateSchema,
  IntentSchema,
  IntentState,
  KillState,
  OrderSchema,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSchema,
  PositiveMicrosSchema,
  ReconciliationSchema,
  ReconciliationStatus,
  ReferenceIntentSchema,
  RiskDecisionSchema,
  RiskInputSchema,
  RiskOutcome,
  SignedMicrosSchema,
  TimeInForce,
  UnsignedMicrosSchema,
  type Intent,
  type Position,
  type ReferenceIntent,
} from './paper'
import { reconciledStateHash } from './reconciliation'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  strictParseOptions as StrictParseOptions,
} from './schemas'

const MAX_POLICY_MICROS = 9_223_372_036_854_775_807n
const MAX_AGE_MS = 86_400_000
const MAX_UNKNOWN_MUTATIONS = 1_000
const BASIS_POINTS = 10_000n
const QUANTITY_SCALE = 1_000_000n

const LimitMicros = UnsignedMicrosSchema.check(
  Schema.makeFilter((value: string) => BigInt(value) <= MAX_POLICY_MICROS, {
    expected: `canonical micros not exceeding ${MAX_POLICY_MICROS}`,
  }),
)
const AgeMilliseconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_AGE_MS }))
const MutationCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_UNKNOWN_MUTATIONS }))
const BasisPointLimit = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number(BASIS_POINTS) }))

const isSorted = (values: ReadonlyArray<string>): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) return false
  }
  return true
}

const SortedUniqueStrings = Schema.makeFilter((values: ReadonlyArray<string>) => isSorted(values), {
  expected: 'a strictly sorted unique array',
})

export enum BrokerMode {
  Paper = 'PAPER',
}

export enum Gate {
  IntentState = 'intent_state',
  IntentTime = 'intent_time',
  IntentFreshness = 'intent_freshness',
  Account = 'account',
  AccountStatus = 'account_status',
  Equity = 'equity',
  Symbol = 'symbol',
  MarketDataSymbol = 'market_data_symbol',
  OrderType = 'order_type',
  TimeInForce = 'time_in_force',
  Authority = 'authority',
  Kill = 'kill',
  Reconciliation = 'reconciliation',
  BrokerStateFreshness = 'broker_state_freshness',
  MarketDataFreshness = 'market_data_freshness',
  Session = 'session',
  UnknownMutations = 'unknown_mutations',
  UnresolvedOrders = 'unresolved_orders',
  IntentNotional = 'intent_notional',
  OrderNotional = 'order_notional',
  BuyingPower = 'buying_power',
  AdverseSlippage = 'adverse_slippage',
  LongOnly = 'long_only',
  SymbolExposure = 'symbol_exposure',
  GrossExposure = 'gross_exposure',
  NetExposure = 'net_exposure',
  DailyTradedNotional = 'daily_traded_notional',
  DailyLoss = 'daily_loss',
  Drawdown = 'drawdown',
}

export enum Reason {
  IntentNotPlanned = 'INTENT_NOT_PLANNED',
  IntentTimeInvalid = 'INTENT_TIME_INVALID',
  IntentStale = 'INTENT_STALE',
  AccountMismatch = 'ACCOUNT_MISMATCH',
  AccountNotActive = 'ACCOUNT_NOT_ACTIVE',
  EquityNotPositive = 'EQUITY_NOT_POSITIVE',
  SymbolNotAllowed = 'SYMBOL_NOT_ALLOWED',
  MarketDataSymbolMismatch = 'MARKET_DATA_SYMBOL_MISMATCH',
  OrderTypeNotAllowed = 'ORDER_TYPE_NOT_ALLOWED',
  TimeInForceNotAllowed = 'TIME_IN_FORCE_NOT_ALLOWED',
  AuthorityNotPaper = 'AUTHORITY_NOT_PAPER',
  KillActive = 'KILL_ACTIVE',
  ReconciliationNotExact = 'RECONCILIATION_NOT_EXACT',
  BrokerStateStale = 'BROKER_STATE_STALE',
  MarketDataStale = 'MARKET_DATA_STALE',
  OutsideSession = 'OUTSIDE_SESSION',
  UnknownMutation = 'UNKNOWN_MUTATION',
  UnresolvedOrdersExceeded = 'UNRESOLVED_ORDERS_EXCEEDED',
  IntentNotionalExceeded = 'INTENT_NOTIONAL_EXCEEDED',
  OrderNotionalExceeded = 'ORDER_NOTIONAL_EXCEEDED',
  BuyingPowerExceeded = 'BUYING_POWER_EXCEEDED',
  AdverseSlippageExceeded = 'ADVERSE_SLIPPAGE_EXCEEDED',
  ShortPositionNotAllowed = 'SHORT_POSITION_NOT_ALLOWED',
  SymbolExposureExceeded = 'SYMBOL_EXPOSURE_EXCEEDED',
  GrossExposureExceeded = 'GROSS_EXPOSURE_EXCEEDED',
  NetExposureExceeded = 'NET_EXPOSURE_EXCEEDED',
  DailyTradedNotionalExceeded = 'DAILY_TRADED_NOTIONAL_EXCEEDED',
  DailyLossExceeded = 'DAILY_LOSS_EXCEEDED',
  DrawdownExceeded = 'DRAWDOWN_EXCEEDED',
}

export interface RiskGateDefinition {
  readonly name: Gate
  readonly reason: Reason
}

type RiskGateDefinitionByName = {
  readonly [Name in Gate]: {
    readonly name: Name
    readonly reason: Reason
  }
}

const riskGateDefinitionByName: RiskGateDefinitionByName = {
  [Gate.IntentState]: { name: Gate.IntentState, reason: Reason.IntentNotPlanned },
  [Gate.IntentTime]: { name: Gate.IntentTime, reason: Reason.IntentTimeInvalid },
  [Gate.IntentFreshness]: { name: Gate.IntentFreshness, reason: Reason.IntentStale },
  [Gate.Account]: { name: Gate.Account, reason: Reason.AccountMismatch },
  [Gate.AccountStatus]: { name: Gate.AccountStatus, reason: Reason.AccountNotActive },
  [Gate.Equity]: { name: Gate.Equity, reason: Reason.EquityNotPositive },
  [Gate.Symbol]: { name: Gate.Symbol, reason: Reason.SymbolNotAllowed },
  [Gate.MarketDataSymbol]: { name: Gate.MarketDataSymbol, reason: Reason.MarketDataSymbolMismatch },
  [Gate.OrderType]: { name: Gate.OrderType, reason: Reason.OrderTypeNotAllowed },
  [Gate.TimeInForce]: { name: Gate.TimeInForce, reason: Reason.TimeInForceNotAllowed },
  [Gate.Authority]: { name: Gate.Authority, reason: Reason.AuthorityNotPaper },
  [Gate.Kill]: { name: Gate.Kill, reason: Reason.KillActive },
  [Gate.Reconciliation]: { name: Gate.Reconciliation, reason: Reason.ReconciliationNotExact },
  [Gate.BrokerStateFreshness]: { name: Gate.BrokerStateFreshness, reason: Reason.BrokerStateStale },
  [Gate.MarketDataFreshness]: { name: Gate.MarketDataFreshness, reason: Reason.MarketDataStale },
  [Gate.Session]: { name: Gate.Session, reason: Reason.OutsideSession },
  [Gate.UnknownMutations]: { name: Gate.UnknownMutations, reason: Reason.UnknownMutation },
  [Gate.UnresolvedOrders]: { name: Gate.UnresolvedOrders, reason: Reason.UnresolvedOrdersExceeded },
  [Gate.IntentNotional]: { name: Gate.IntentNotional, reason: Reason.IntentNotionalExceeded },
  [Gate.OrderNotional]: { name: Gate.OrderNotional, reason: Reason.OrderNotionalExceeded },
  [Gate.BuyingPower]: { name: Gate.BuyingPower, reason: Reason.BuyingPowerExceeded },
  [Gate.AdverseSlippage]: { name: Gate.AdverseSlippage, reason: Reason.AdverseSlippageExceeded },
  [Gate.LongOnly]: { name: Gate.LongOnly, reason: Reason.ShortPositionNotAllowed },
  [Gate.SymbolExposure]: { name: Gate.SymbolExposure, reason: Reason.SymbolExposureExceeded },
  [Gate.GrossExposure]: { name: Gate.GrossExposure, reason: Reason.GrossExposureExceeded },
  [Gate.NetExposure]: { name: Gate.NetExposure, reason: Reason.NetExposureExceeded },
  [Gate.DailyTradedNotional]: {
    name: Gate.DailyTradedNotional,
    reason: Reason.DailyTradedNotionalExceeded,
  },
  [Gate.DailyLoss]: { name: Gate.DailyLoss, reason: Reason.DailyLossExceeded },
  [Gate.Drawdown]: { name: Gate.Drawdown, reason: Reason.DrawdownExceeded },
}

export const orderedRiskGateDefinitions: ReadonlyArray<RiskGateDefinition> = Object.values(riskGateDefinitionByName)

export const PolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-risk-policy.v1'),
  accountId: NonEmptyString,
  brokerMode: Schema.Literal(BrokerMode.Paper),
  allowedSymbols: Schema.Array(SymbolName).check(Schema.isMinLength(1), Schema.isUnique(), SortedUniqueStrings),
  allowedOrderTypes: Schema.Tuple([Schema.Literal(OrderType.Market)]),
  allowedTimeInForce: Schema.Array(Schema.Enum(TimeInForce)).check(
    Schema.isMinLength(1),
    Schema.isUnique(),
    SortedUniqueStrings,
  ),
  maxOrderNotionalMicros: LimitMicros,
  maxSymbolExposureMicros: LimitMicros,
  maxGrossExposureMicros: LimitMicros,
  maxNetExposureMicros: LimitMicros,
  maxDailyTradedNotionalMicros: LimitMicros,
  maxDailyLossMicros: LimitMicros,
  maxDrawdownMicros: LimitMicros,
  maxIntentAgeMs: AgeMilliseconds,
  maxBrokerStateAgeMs: AgeMilliseconds,
  maxMarketDataAgeMs: AgeMilliseconds,
  maxAdverseSlippageBps: BasisPointLimit,
  maxUnresolvedOrders: Schema.Literal(0),
  decisionTtlMs: AgeMilliseconds,
})
export type Policy = typeof PolicySchema.Type

const StateBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-risk-state.v2'),
  brokerMode: Schema.Literal(BrokerMode.Paper),
  account: AccountSnapshotSchema,
  positions: Schema.Array(PositionSchema),
  positionsObservedAt: UtcInstant,
  orders: Schema.Array(OrderSchema),
  ordersObservedAt: UtcInstant,
  reconciliation: ReconciliationSchema,
  authority: AuthorityStateSchema,
  authorityObservedAt: UtcInstant,
  unknownMutationCount: MutationCount,
  dailyTradedNotionalMicros: UnsignedMicrosSchema,
  dayStartEquityMicros: SignedMicrosSchema,
  peakEquityMicros: SignedMicrosSchema,
  accountingHash: Sha256,
  marketDataSymbol: SymbolName,
  marketDataHash: Sha256,
  referencePriceMicros: PositiveMicrosSchema,
  expectedExecutionPriceMicros: PositiveMicrosSchema,
  marketDataObservedAt: UtcInstant,
  executionSession: ExecutionSessionBindingSchema,
  reservedBuyingPowerMicros: UnsignedMicrosSchema,
  evaluatedAt: UtcInstant,
})

const timeDoesNotFollow = (candidate: string, boundary: string): boolean => candidate > boundary

interface PositionBook {
  readonly positions: readonly Position[]
  readonly accountId: string
  readonly observedAt: string
}

const positionBookIssues = (book: PositionBook): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const symbols = book.positions.map((position) => position.symbol)
  if (new Set(symbols).size !== symbols.length || !isSorted(symbols)) {
    issues.push({ path: ['positions'], issue: 'must be unique and sorted by symbol' })
  }
  for (const [index, position] of book.positions.entries()) {
    if (position.accountId !== book.accountId) {
      issues.push({ path: ['positions', index, 'accountId'], issue: 'must match the account snapshot' })
    }
    if (position.observedAt !== book.observedAt) {
      issues.push({ path: ['positions', index, 'observedAt'], issue: 'must match positionsObservedAt' })
    }
    const quantity = BigInt(position.quantityMicros)
    const marketValue = BigInt(position.marketValueMicros)
    if (
      (quantity === 0n) !== (marketValue === 0n) ||
      (quantity > 0n && marketValue <= 0n) ||
      (quantity < 0n && marketValue >= 0n)
    ) {
      issues.push({ path: ['positions', index, 'marketValueMicros'], issue: 'must have the quantity sign' })
    }
  }
  return issues
}

export const StateSchema = StateBase.check(
  Schema.makeFilter((state: typeof StateBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    const accountId = state.account.accountId
    if (state.executionSession.signal.contentHash !== state.marketDataHash) {
      issues.push({ path: ['marketDataHash'], issue: 'must match the finalized signal-session binding' })
    }
    if (
      state.executionSession.planningBrokerState.contentHash !== state.reconciliation.observedHash ||
      state.executionSession.planningBrokerState.observedAt !== state.reconciliation.reconciledAt
    ) {
      issues.push({
        path: ['executionSession', 'planningBrokerState'],
        issue: 'must match the exact reconciled broker state used for planning',
      })
    }
    const timestamps = [
      ['account', 'observedAt', state.account.observedAt],
      ['positionsObservedAt', state.positionsObservedAt],
      ['ordersObservedAt', state.ordersObservedAt],
      ['reconciliation', 'reconciledAt', state.reconciliation.reconciledAt],
      ['authorityObservedAt', state.authorityObservedAt],
      ['marketDataObservedAt', state.marketDataObservedAt],
    ] as const
    for (const path of timestamps) {
      const candidate = path[path.length - 1]
      if (timeDoesNotFollow(candidate, state.evaluatedAt)) {
        issues.push({ path: path.slice(0, -1), issue: 'must not follow evaluatedAt' })
      }
    }
    if (state.reconciliation.accountId !== accountId) {
      issues.push({ path: ['reconciliation', 'accountId'], issue: 'must match the account snapshot' })
    }
    if (state.authority.updatedAt > state.authorityObservedAt) {
      issues.push({ path: ['authorityObservedAt'], issue: 'must not precede the authority update' })
    }
    if (
      state.reconciliation.reconciledAt < state.account.observedAt ||
      state.reconciliation.reconciledAt < state.positionsObservedAt ||
      state.reconciliation.reconciledAt < state.ordersObservedAt
    ) {
      issues.push({ path: ['reconciliation', 'reconciledAt'], issue: 'must cover every broker snapshot' })
    }
    issues.push(
      ...positionBookIssues({
        positions: state.positions,
        accountId,
        observedAt: state.positionsObservedAt,
      }),
    )
    const brokerOrderIds = state.orders.map((order) => order.brokerOrderId)
    if (new Set(brokerOrderIds).size !== brokerOrderIds.length || !isSorted(brokerOrderIds)) {
      issues.push({ path: ['orders'], issue: 'must be unique and sorted by brokerOrderId' })
    }
    const clientOrderIds = state.orders.map((order) => order.clientOrderId)
    if (new Set(clientOrderIds).size !== clientOrderIds.length) {
      issues.push({ path: ['orders'], issue: 'must have unique clientOrderId values' })
    }
    const latestOrderObservation = state.orders.reduce(
      (latest, order) => (order.observedAt > latest ? order.observedAt : latest),
      '',
    )
    if (state.orders.length > 0 && latestOrderObservation !== state.ordersObservedAt) {
      issues.push({ path: ['ordersObservedAt'], issue: 'must equal the latest paginated order observation' })
    }
    for (const [index, order] of state.orders.entries()) {
      if (order.accountId !== accountId) {
        issues.push({ path: ['orders', index, 'accountId'], issue: 'must match the account snapshot' })
      }
      if (order.observedAt > state.ordersObservedAt) {
        issues.push({ path: ['orders', index, 'observedAt'], issue: 'must not follow ordersObservedAt' })
      }
    }
    if (BigInt(state.peakEquityMicros) < BigInt(state.account.equityMicros)) {
      issues.push({ path: ['peakEquityMicros'], issue: 'must not be less than current equity' })
    }
    return issues
  }),
)
export type State = typeof StateSchema.Type

const GateResultSchema = Schema.Struct({
  name: Schema.Enum(Gate),
  passed: Schema.Boolean,
  reason: Schema.Enum(Reason),
  actual: NonEmptyString,
  required: NonEmptyString,
})
export type GateResult = typeof GateResultSchema.Type

const EvaluationMetricsSchema = Schema.Struct({
  orderNotionalMicros: UnsignedMicrosSchema,
  postTradeSymbolExposureMicros: SignedMicrosSchema,
  postTradeGrossExposureMicros: UnsignedMicrosSchema,
  postTradeNetExposureMicros: SignedMicrosSchema,
  dailyTradedNotionalMicros: UnsignedMicrosSchema,
  dailyLossMicros: UnsignedMicrosSchema,
  drawdownMicros: UnsignedMicrosSchema,
  adverseSlippageBps: UnsignedMicrosSchema,
  aggregateBuyingPowerMicros: UnsignedMicrosSchema,
  unresolvedOrderCount: MutationCount,
})

const EvaluationBase = Schema.Struct({
  policyHash: Sha256,
  input: RiskInputSchema,
  decision: RiskDecisionSchema,
  gates: Schema.Array(GateResultSchema),
  metrics: EvaluationMetricsSchema,
})

export const EvaluationSchema = EvaluationBase.check(
  Schema.makeFilter((evaluation: typeof EvaluationBase.Type): readonly Schema.FilterIssue[] => {
    const issues: Schema.FilterIssue[] = []
    if (
      evaluation.policyHash !== evaluation.input.policyHash ||
      evaluation.policyHash !== evaluation.decision.policyHash ||
      evaluation.input.inputHash !== evaluation.decision.inputHash ||
      evaluation.input.intentId !== evaluation.decision.intentId
    ) {
      issues.push({ path: ['decision'], issue: 'must bind the exact risk input, intent, and policy' })
    }
    if (
      evaluation.input.evaluatedAt !== evaluation.decision.decidedAt ||
      evaluation.input.freshUntil !== evaluation.decision.expiresAt
    ) {
      issues.push({ path: ['decision'], issue: 'must retain the risk input evaluation and expiry times' })
    }
    const { decisionId, ...decisionMaterial } = evaluation.decision
    const expectedDecisionId = Result.try(() => canonicalHashV1(decisionMaterial))
    if (Result.isFailure(expectedDecisionId)) {
      issues.push({ path: ['decision', 'decisionId'], issue: 'risk decision material must be canonicalizable' })
    } else if (decisionId !== expectedDecisionId.success) {
      issues.push({ path: ['decision', 'decisionId'], issue: 'must match the canonical risk decision material' })
    }
    if (
      evaluation.gates.length !== orderedRiskGateDefinitions.length ||
      evaluation.gates.some((gate, index) => {
        const definition = orderedRiskGateDefinitions[index]
        return definition === undefined || gate.name !== definition.name || gate.reason !== definition.reason
      })
    ) {
      issues.push({ path: ['gates'], issue: 'must contain every risk gate/reason pair in canonical order' })
    }
    const failedReasons = evaluation.gates.filter((gate) => !gate.passed).map((gate) => gate.reason)
    if (
      failedReasons.length !== evaluation.decision.reasonCodes.length ||
      failedReasons.some((reason, index) => reason !== evaluation.decision.reasonCodes[index])
    ) {
      issues.push({ path: ['decision', 'reasonCodes'], issue: 'must match the failed risk gates in order' })
    }
    const expectedOutcome = failedReasons.length === 0 ? RiskOutcome.Approved : RiskOutcome.Blocked
    if (evaluation.decision.outcome !== expectedOutcome) {
      issues.push({ path: ['decision', 'outcome'], issue: 'must agree with the complete risk gate set' })
    }
    return issues
  }),
)
export type Evaluation = typeof EvaluationSchema.Type
export type RiskIntent = Intent | ReferenceIntent

interface BindRiskAuthorityIssue {
  readonly operation: 'bind-authority'
  readonly reason: 'authority-contract' | 'authority-generation' | 'authority-maximum'
}

interface CanonicalizeRiskInputIssue {
  readonly operation: 'canonicalize-input'
  readonly reason: 'evidence' | 'reconciliation'
}

interface DecodeRiskInputIssue {
  readonly operation: 'decode-input'
  readonly reason: 'intent' | 'policy' | 'positions' | 'state'
}

interface DecodeRiskOutputIssue {
  readonly operation: 'decode-output'
  readonly reason: 'decision' | 'evaluation' | 'input'
}

type RiskEvaluationIssue =
  | BindRiskAuthorityIssue
  | CanonicalizeRiskInputIssue
  | DecodeRiskInputIssue
  | DecodeRiskOutputIssue

interface RiskEvaluationFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

export const RiskEvaluationFailure = Data.TaggedError('RiskEvaluationFailure')<
  RiskEvaluationIssue & RiskEvaluationFailureDetails
>
export type RiskEvaluationFailure = InstanceType<typeof RiskEvaluationFailure>

type RiskEvaluationReason<Operation extends RiskEvaluationIssue['operation']> = Extract<
  RiskEvaluationIssue,
  { readonly operation: Operation }
>['reason']

const bindRiskAuthorityFailure = (
  reason: RiskEvaluationReason<'bind-authority'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): RiskEvaluationFailure => new RiskEvaluationFailure({ operation: 'bind-authority', reason, message, facts, cause })

const canonicalizeRiskInputFailure = (
  reason: RiskEvaluationReason<'canonicalize-input'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): RiskEvaluationFailure =>
  new RiskEvaluationFailure({ operation: 'canonicalize-input', reason, message, facts, cause })

const decodeRiskInputFailure = (
  reason: RiskEvaluationReason<'decode-input'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): RiskEvaluationFailure => new RiskEvaluationFailure({ operation: 'decode-input', reason, message, facts, cause })

const decodeRiskOutputFailure = (
  reason: RiskEvaluationReason<'decode-output'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): RiskEvaluationFailure => new RiskEvaluationFailure({ operation: 'decode-output', reason, message, facts, cause })

const RiskIntentSchema = Schema.Union([IntentSchema, ReferenceIntentSchema])
const ProposedPositionsSchema = Schema.Array(PositionSchema)
const decodeRiskIntentResult = Schema.decodeUnknownResult(RiskIntentSchema, StrictParseOptions)
const decodeRiskStateResult = Schema.decodeUnknownResult(StateSchema, StrictParseOptions)
const decodeRiskPolicyResult = Schema.decodeUnknownResult(PolicySchema, StrictParseOptions)
const decodeProposedPositionsResult = Schema.decodeUnknownResult(ProposedPositionsSchema, StrictParseOptions)
const decodeRiskInputResult = Schema.decodeUnknownResult(RiskInputSchema, StrictParseOptions)
const decodeRiskDecisionResult = Schema.decodeUnknownResult(RiskDecisionSchema, StrictParseOptions)
const decodeRiskEvaluationResult = Schema.decodeUnknownResult(EvaluationSchema, StrictParseOptions)

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const positiveDifference = (left: bigint, right: bigint): bigint => (left > right ? left - right : 0n)
const divideUp = (numerator: bigint, denominator: bigint): bigint =>
  numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator
const divideAwayFromZero = (numerator: bigint, denominator: bigint): bigint =>
  numerator < 0n ? -divideUp(-numerator, denominator) : divideUp(numerator, denominator)
const instant = (value: string): number => Date.parse(value)
const utc = (value: number): string => new Date(value).toISOString()

const makeGate = (
  name: Gate,
  passed: boolean,
  actual: string | number | bigint,
  required: string | number | bigint,
): GateResult => ({
  name,
  reason: riskGateDefinitionByName[name].reason,
  passed,
  actual: String(actual),
  required: String(required),
})

const isUnresolved = (status: OrderStatus): boolean =>
  status === OrderStatus.New || status === OrderStatus.PartiallyFilled || status === OrderStatus.Pending

interface ParsedPositionFacts {
  readonly symbol: string
  readonly quantityMicros: bigint
  readonly marketValueMicros: bigint
}

interface RiskFacts {
  readonly intent: RiskIntent
  readonly state: State
  readonly policy: Policy
  readonly proposedPositions: State['positions']
  readonly positions: ReadonlyArray<ParsedPositionFacts>
  readonly evaluatedAt: number
  readonly intentCreatedAt: number
  readonly marketDataObservedAt: number
  readonly submissionOpenAt: number
  readonly submissionCutoffAt: number
  readonly referencePriceMicros: bigint
  readonly expectedExecutionPriceMicros: bigint
  readonly intentQuantityMicros: bigint
  readonly intentNotionalLimitMicros: bigint
  readonly accountEquityMicros: bigint
  readonly accountBuyingPowerMicros: bigint
  readonly reservedBuyingPowerMicros: bigint
  readonly priorDailyTradedNotionalMicros: bigint
  readonly dayStartEquityMicros: bigint
  readonly peakEquityMicros: bigint
  readonly maxOrderNotionalMicros: bigint
  readonly maxSymbolExposureMicros: bigint
  readonly maxGrossExposureMicros: bigint
  readonly maxNetExposureMicros: bigint
  readonly maxDailyTradedNotionalMicros: bigint
  readonly maxDailyLossMicros: bigint
  readonly maxDrawdownMicros: bigint
  readonly maxAdverseSlippageBps: bigint
}

interface DerivedRiskMetrics {
  readonly orderNotionalMicros: bigint
  readonly currentSymbolQuantityMicros: bigint
  readonly postTradeSymbolQuantityMicros: bigint
  readonly postTradeSymbolExposureMicros: bigint
  readonly postTradeSymbolExposureMagnitudeMicros: bigint
  readonly postTradeGrossExposureMicros: bigint
  readonly postTradeNetExposureMicros: bigint
  readonly postTradeNetExposureMagnitudeMicros: bigint
  readonly aggregateBuyingPowerMicros: bigint
  readonly dailyTradedNotionalMicros: bigint
  readonly dailyLossMicros: bigint
  readonly drawdownMicros: bigint
  readonly adverseSlippageBps: bigint
  readonly unresolvedOrderCount: number
  readonly oldestBrokerStateAt: number
  readonly brokerFreshUntil: number
  readonly marketFreshUntil: number
}

const parseRiskFacts = (
  intent: RiskIntent,
  state: State,
  policy: Policy,
  proposedPositions: State['positions'],
): RiskFacts => ({
  intent,
  state,
  policy,
  proposedPositions,
  positions: proposedPositions.map((position) => ({
    symbol: position.symbol,
    quantityMicros: BigInt(position.quantityMicros),
    marketValueMicros: BigInt(position.marketValueMicros),
  })),
  evaluatedAt: instant(state.evaluatedAt),
  intentCreatedAt: instant(intent.createdAt),
  marketDataObservedAt: instant(state.marketDataObservedAt),
  submissionOpenAt: instant(state.executionSession.submissionOpenAt),
  submissionCutoffAt: instant(state.executionSession.submissionCutoffAt),
  referencePriceMicros: BigInt(state.referencePriceMicros),
  expectedExecutionPriceMicros: BigInt(state.expectedExecutionPriceMicros),
  intentQuantityMicros: BigInt(intent.quantityMicros),
  intentNotionalLimitMicros: BigInt(intent.notionalLimitMicros),
  accountEquityMicros: BigInt(state.account.equityMicros),
  accountBuyingPowerMicros: BigInt(state.account.buyingPowerMicros),
  reservedBuyingPowerMicros: BigInt(state.reservedBuyingPowerMicros),
  priorDailyTradedNotionalMicros: BigInt(state.dailyTradedNotionalMicros),
  dayStartEquityMicros: BigInt(state.dayStartEquityMicros),
  peakEquityMicros: BigInt(state.peakEquityMicros),
  maxOrderNotionalMicros: BigInt(policy.maxOrderNotionalMicros),
  maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
  maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
  maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
  maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
  maxDailyLossMicros: BigInt(policy.maxDailyLossMicros),
  maxDrawdownMicros: BigInt(policy.maxDrawdownMicros),
  maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
})

const deriveRiskMetrics = (facts: RiskFacts): DerivedRiskMetrics => {
  const orderNotionalMicros = divideUp(facts.intentQuantityMicros * facts.expectedExecutionPriceMicros, QUANTITY_SCALE)
  const direction = facts.intent.side === OrderSide.Buy ? 1n : -1n
  const currentSymbolQuantityMicros = facts.positions
    .filter((position) => position.symbol === facts.intent.symbol)
    .reduce((total, position) => total + position.quantityMicros, 0n)
  const postTradeSymbolQuantityMicros = currentSymbolQuantityMicros + direction * facts.intentQuantityMicros
  const postTradeSymbolExposureNumerator = postTradeSymbolQuantityMicros * facts.referencePriceMicros
  const postTradeSymbolExposureMicros = divideAwayFromZero(postTradeSymbolExposureNumerator, QUANTITY_SCALE)
  const postTradeSymbolExposureMagnitudeMicros = divideUp(absolute(postTradeSymbolExposureNumerator), QUANTITY_SCALE)
  const otherGrossExposureMicros = facts.positions
    .filter((position) => position.symbol !== facts.intent.symbol)
    .reduce((total, position) => total + absolute(position.marketValueMicros), 0n)
  const otherNetExposureMicros = facts.positions
    .filter((position) => position.symbol !== facts.intent.symbol)
    .reduce((total, position) => total + position.marketValueMicros, 0n)
  const postTradeGrossExposureMicros = otherGrossExposureMicros + postTradeSymbolExposureMagnitudeMicros
  const postTradeNetExposureNumerator = otherNetExposureMicros * QUANTITY_SCALE + postTradeSymbolExposureNumerator
  const postTradeNetExposureMicros = divideAwayFromZero(postTradeNetExposureNumerator, QUANTITY_SCALE)
  const postTradeNetExposureMagnitudeMicros = divideUp(absolute(postTradeNetExposureNumerator), QUANTITY_SCALE)
  const aggregateBuyingPowerMicros =
    facts.reservedBuyingPowerMicros + (facts.intent.side === OrderSide.Buy ? orderNotionalMicros : 0n)
  const dailyTradedNotionalMicros = facts.priorDailyTradedNotionalMicros + orderNotionalMicros
  const dailyLossMicros = positiveDifference(facts.dayStartEquityMicros, facts.accountEquityMicros)
  const drawdownMicros = positiveDifference(facts.peakEquityMicros, facts.accountEquityMicros)
  const adversePriceDifference =
    facts.intent.side === OrderSide.Buy
      ? positiveDifference(facts.expectedExecutionPriceMicros, facts.referencePriceMicros)
      : positiveDifference(facts.referencePriceMicros, facts.expectedExecutionPriceMicros)
  const adverseSlippageBps = divideUp(adversePriceDifference * BASIS_POINTS, facts.referencePriceMicros)
  const unresolvedOrderCount = facts.state.orders.filter((order) => isUnresolved(order.status)).length
  const oldestBrokerStateAt = Math.min(
    instant(facts.state.account.observedAt),
    instant(facts.state.positionsObservedAt),
    instant(facts.state.ordersObservedAt),
    ...facts.state.orders.map((order) => instant(order.observedAt)),
    instant(facts.state.reconciliation.reconciledAt),
    instant(facts.state.authorityObservedAt),
  )

  return {
    orderNotionalMicros,
    currentSymbolQuantityMicros,
    postTradeSymbolQuantityMicros,
    postTradeSymbolExposureMicros,
    postTradeSymbolExposureMagnitudeMicros,
    postTradeGrossExposureMicros,
    postTradeNetExposureMicros,
    postTradeNetExposureMagnitudeMicros,
    aggregateBuyingPowerMicros,
    dailyTradedNotionalMicros,
    dailyLossMicros,
    drawdownMicros,
    adverseSlippageBps,
    unresolvedOrderCount,
    oldestBrokerStateAt,
    brokerFreshUntil: oldestBrokerStateAt + facts.policy.maxBrokerStateAgeMs,
    marketFreshUntil: facts.marketDataObservedAt + facts.policy.maxMarketDataAgeMs,
  }
}

const deriveReconciledHash = (facts: RiskFacts): Result.Result<string, RiskEvaluationFailure> =>
  Result.try({
    try: () =>
      reconciledStateHash({
        account: facts.state.account,
        positions: facts.state.positions,
        positionsObservedAt: facts.state.positionsObservedAt,
        orders: facts.state.orders,
        ordersObservedAt: facts.state.ordersObservedAt,
        accountingHash: facts.state.accountingHash,
      }),
    catch: (cause) =>
      canonicalizeRiskInputFailure(
        'reconciliation',
        'validated reconciled broker state is not canonicalizable',
        { intentId: facts.intent.intentId },
        cause,
      ),
  })

const buildIntentContractGates = (facts: RiskFacts): readonly GateResult[] => {
  const { intent, policy, state } = facts
  return [
    makeGate(Gate.IntentState, intent.state === IntentState.Planned, intent.state, 'PLANNED'),
    makeGate(
      Gate.IntentTime,
      facts.intentCreatedAt >= facts.submissionOpenAt && facts.intentCreatedAt <= facts.evaluatedAt,
      intent.createdAt,
      `[${state.executionSession.submissionOpenAt},${state.evaluatedAt}]`,
    ),
    makeGate(
      Gate.IntentFreshness,
      facts.evaluatedAt < facts.intentCreatedAt + policy.maxIntentAgeMs,
      facts.evaluatedAt - facts.intentCreatedAt,
      `<${policy.maxIntentAgeMs}`,
    ),
    makeGate(
      Gate.Account,
      intent.accountId === policy.accountId && state.account.accountId === policy.accountId,
      `${intent.accountId}:${state.account.accountId}`,
      policy.accountId,
    ),
    makeGate(
      Gate.AccountStatus,
      state.account.status === AccountStatus.Active,
      state.account.status,
      AccountStatus.Active,
    ),
    makeGate(Gate.Equity, facts.accountEquityMicros > 0n, state.account.equityMicros, '>0'),
    makeGate(
      Gate.Symbol,
      policy.allowedSymbols.includes(intent.symbol),
      intent.symbol,
      policy.allowedSymbols.join(','),
    ),
    makeGate(Gate.MarketDataSymbol, state.marketDataSymbol === intent.symbol, state.marketDataSymbol, intent.symbol),
    makeGate(
      Gate.OrderType,
      intent.orderType === OrderType.Market,
      intent.orderType,
      policy.allowedOrderTypes.join(','),
    ),
    makeGate(
      Gate.TimeInForce,
      policy.allowedTimeInForce.includes(intent.timeInForce),
      intent.timeInForce,
      policy.allowedTimeInForce.join(','),
    ),
  ]
}

const buildAuthorityAndStateGates = (
  facts: RiskFacts,
  metrics: DerivedRiskMetrics,
  reconciledHash: string,
): readonly GateResult[] => {
  const { policy, state } = facts
  return [
    makeGate(
      Gate.Authority,
      state.authority.maximum === Authority.Paper && state.authority.effective === Authority.Paper,
      `${state.authority.maximum}:${state.authority.effective}`,
      'PAPER:PAPER',
    ),
    makeGate(Gate.Kill, state.authority.kill === KillState.Clear, state.authority.kill, 'CLEAR'),
    makeGate(
      Gate.Reconciliation,
      state.reconciliation.status === ReconciliationStatus.Exact &&
        state.reconciliation.expectedHash === reconciledHash &&
        state.reconciliation.observedHash === reconciledHash,
      `${state.reconciliation.status}:${state.reconciliation.expectedHash}:${state.reconciliation.observedHash}`,
      `${ReconciliationStatus.Exact}:${reconciledHash}:${reconciledHash}`,
    ),
    makeGate(
      Gate.BrokerStateFreshness,
      facts.evaluatedAt < metrics.brokerFreshUntil,
      facts.evaluatedAt - metrics.oldestBrokerStateAt,
      `<${policy.maxBrokerStateAgeMs}`,
    ),
    makeGate(
      Gate.MarketDataFreshness,
      facts.evaluatedAt < metrics.marketFreshUntil,
      facts.evaluatedAt - facts.marketDataObservedAt,
      `<${policy.maxMarketDataAgeMs}`,
    ),
    makeGate(
      Gate.Session,
      facts.evaluatedAt >= facts.submissionOpenAt && facts.evaluatedAt < facts.submissionCutoffAt,
      state.evaluatedAt,
      `[${state.executionSession.submissionOpenAt},${state.executionSession.submissionCutoffAt})`,
    ),
    makeGate(Gate.UnknownMutations, state.unknownMutationCount === 0, state.unknownMutationCount, 0),
    makeGate(
      Gate.UnresolvedOrders,
      metrics.unresolvedOrderCount <= policy.maxUnresolvedOrders,
      metrics.unresolvedOrderCount,
      `<=${policy.maxUnresolvedOrders}`,
    ),
  ]
}

const buildOrderLimitGates = (facts: RiskFacts, metrics: DerivedRiskMetrics): readonly GateResult[] => {
  const { intent, policy, state } = facts
  return [
    makeGate(
      Gate.IntentNotional,
      metrics.orderNotionalMicros <= facts.intentNotionalLimitMicros,
      metrics.orderNotionalMicros,
      `<=${intent.notionalLimitMicros}`,
    ),
    makeGate(
      Gate.OrderNotional,
      metrics.orderNotionalMicros <= facts.maxOrderNotionalMicros,
      metrics.orderNotionalMicros,
      `<=${policy.maxOrderNotionalMicros}`,
    ),
    makeGate(
      Gate.BuyingPower,
      metrics.aggregateBuyingPowerMicros <= facts.accountBuyingPowerMicros,
      metrics.aggregateBuyingPowerMicros,
      `<=${state.account.buyingPowerMicros}`,
    ),
    makeGate(
      Gate.AdverseSlippage,
      metrics.adverseSlippageBps <= facts.maxAdverseSlippageBps,
      metrics.adverseSlippageBps,
      `<=${policy.maxAdverseSlippageBps}`,
    ),
  ]
}

const buildExposureGates = (facts: RiskFacts, metrics: DerivedRiskMetrics): readonly GateResult[] => {
  const { policy } = facts
  return [
    makeGate(
      Gate.LongOnly,
      metrics.currentSymbolQuantityMicros >= 0n && metrics.postTradeSymbolQuantityMicros >= 0n,
      `${metrics.currentSymbolQuantityMicros}:${metrics.postTradeSymbolQuantityMicros}`,
      '>=0:>=0',
    ),
    makeGate(
      Gate.SymbolExposure,
      metrics.postTradeSymbolExposureMagnitudeMicros <= facts.maxSymbolExposureMicros,
      metrics.postTradeSymbolExposureMagnitudeMicros,
      `<=${policy.maxSymbolExposureMicros}`,
    ),
    makeGate(
      Gate.GrossExposure,
      metrics.postTradeGrossExposureMicros <= facts.maxGrossExposureMicros,
      metrics.postTradeGrossExposureMicros,
      `<=${policy.maxGrossExposureMicros}`,
    ),
    makeGate(
      Gate.NetExposure,
      metrics.postTradeNetExposureMagnitudeMicros <= facts.maxNetExposureMicros,
      metrics.postTradeNetExposureMagnitudeMicros,
      `<=${policy.maxNetExposureMicros}`,
    ),
  ]
}

const buildCumulativeRiskGates = (facts: RiskFacts, metrics: DerivedRiskMetrics): readonly GateResult[] => {
  const { policy } = facts
  return [
    makeGate(
      Gate.DailyTradedNotional,
      metrics.dailyTradedNotionalMicros <= facts.maxDailyTradedNotionalMicros,
      metrics.dailyTradedNotionalMicros,
      `<=${policy.maxDailyTradedNotionalMicros}`,
    ),
    makeGate(
      Gate.DailyLoss,
      metrics.dailyLossMicros <= facts.maxDailyLossMicros,
      metrics.dailyLossMicros,
      `<=${policy.maxDailyLossMicros}`,
    ),
    makeGate(
      Gate.Drawdown,
      metrics.drawdownMicros <= facts.maxDrawdownMicros,
      metrics.drawdownMicros,
      `<=${policy.maxDrawdownMicros}`,
    ),
  ]
}

const buildRiskGates = (
  facts: RiskFacts,
  metrics: DerivedRiskMetrics,
  reconciledHash: string,
): ReadonlyArray<GateResult> => [
  ...buildIntentContractGates(facts),
  ...buildAuthorityAndStateGates(facts, metrics, reconciledHash),
  ...buildOrderLimitGates(facts, metrics),
  ...buildExposureGates(facts, metrics),
  ...buildCumulativeRiskGates(facts, metrics),
]

const deriveRiskExpiry = (facts: RiskFacts, metrics: DerivedRiskMetrics, outcome: RiskOutcome): string => {
  const approvalExpiry = Math.min(
    facts.evaluatedAt + facts.policy.decisionTtlMs,
    facts.intentCreatedAt + facts.policy.maxIntentAgeMs,
    metrics.brokerFreshUntil,
    metrics.marketFreshUntil,
    facts.submissionCutoffAt,
  )
  const ordinaryBlockedExpiry = facts.evaluatedAt + Math.min(1_000, facts.policy.decisionTtlMs)
  const blockedExpiry =
    facts.evaluatedAt < facts.submissionCutoffAt
      ? Math.min(ordinaryBlockedExpiry, facts.submissionCutoffAt)
      : ordinaryBlockedExpiry
  return utc(outcome === RiskOutcome.Approved ? approvalExpiry : blockedExpiry)
}

interface RiskBindingHashes {
  readonly policyHash: string
  readonly accountSnapshotHash: string
  readonly positionsHash: string
  readonly ordersHash: string
  readonly marketDataHash: string
  readonly inputHash: string
}

const deriveRiskBindingHashes = (facts: RiskFacts): Result.Result<RiskBindingHashes, RiskEvaluationFailure> =>
  Result.try({
    try: () => {
      const { intent, policy, proposedPositions, state } = facts
      const policyHash = canonicalHashV1(policy)
      const accountSnapshotHash = canonicalHashV1({
        account: state.account,
        authority: state.authority,
        authorityObservedAt: state.authorityObservedAt,
        accountingHash: state.accountingHash,
        brokerMode: state.brokerMode,
        reconciliation: state.reconciliation,
        dailyTradedNotionalMicros: state.dailyTradedNotionalMicros,
        dayStartEquityMicros: state.dayStartEquityMicros,
        peakEquityMicros: state.peakEquityMicros,
      })
      const positionsHash = canonicalHashV1({
        items: proposedPositions,
        observedAt: state.positionsObservedAt,
      })
      const ordersHash = canonicalHashV1({
        items: state.orders,
        observedAt: state.ordersObservedAt,
        unknownMutationCount: state.unknownMutationCount,
      })
      const marketDataHash = canonicalHashV1({
        symbol: state.marketDataSymbol,
        sourceHash: state.marketDataHash,
        observedAt: state.marketDataObservedAt,
        referencePriceMicros: state.referencePriceMicros,
        expectedExecutionPriceMicros: state.expectedExecutionPriceMicros,
        executionSession: state.executionSession,
      })
      const inputHash = canonicalHashV1({
        schemaVersion:
          intent.schemaVersion === 'bayn.paper-intent.v3'
            ? 'bayn.paper-risk-evaluation-input.v3'
            : 'bayn.paper-risk-evaluation-input.v2',
        intent,
        policy,
        state,
        proposedPositions,
        componentHashes: {
          accountSnapshotHash,
          positionsHash,
          ordersHash,
          marketDataHash,
        },
      })
      return {
        policyHash,
        accountSnapshotHash,
        positionsHash,
        ordersHash,
        marketDataHash,
        inputHash,
      }
    },
    catch: (cause) =>
      canonicalizeRiskInputFailure(
        'evidence',
        'validated risk input evidence is not canonicalizable',
        { intentId: facts.intent.intentId },
        cause,
      ),
  })

type DecodedRiskInput = typeof RiskInputSchema.Type
type DecodedRiskDecision = typeof RiskDecisionSchema.Type

const makeRiskInput = (
  facts: RiskFacts,
  hashes: RiskBindingHashes,
  expiresAt: string,
): Result.Result<DecodedRiskInput, RiskEvaluationFailure> =>
  Result.mapError(
    decodeRiskInputResult({
      schemaVersion: 'bayn.paper-risk-input.v1',
      inputHash: hashes.inputHash,
      intentId: facts.intent.intentId,
      policyHash: hashes.policyHash,
      accountSnapshotHash: hashes.accountSnapshotHash,
      positionsHash: hashes.positionsHash,
      ordersHash: hashes.ordersHash,
      marketDataHash: hashes.marketDataHash,
      evaluatedAt: facts.state.evaluatedAt,
      freshUntil: expiresAt,
    }),
    (cause) =>
      decodeRiskOutputFailure('input', 'derived risk input is invalid', { intentId: facts.intent.intentId }, cause),
  )

const makeRiskDecision = (
  facts: RiskFacts,
  hashes: RiskBindingHashes,
  input: DecodedRiskInput,
  outcome: RiskOutcome,
  reasonCodes: ReadonlyArray<Reason>,
  expiresAt: string,
): Result.Result<DecodedRiskDecision, RiskEvaluationFailure> => {
  const material = {
    schemaVersion: 'bayn.paper-risk-decision.v1',
    inputHash: input.inputHash,
    intentId: facts.intent.intentId,
    policyHash: hashes.policyHash,
    outcome,
    reasonCodes,
    decidedAt: facts.state.evaluatedAt,
    expiresAt,
  } as const
  const decision = { ...material, decisionId: canonicalHashV1(material) }
  return Result.mapError(decodeRiskDecisionResult(decision), (cause) =>
    decodeRiskOutputFailure('decision', 'derived risk decision is invalid', { intentId: facts.intent.intentId }, cause),
  )
}

const makeRiskEvaluation = (
  hashes: RiskBindingHashes,
  input: DecodedRiskInput,
  decision: DecodedRiskDecision,
  gates: ReadonlyArray<GateResult>,
  metrics: DerivedRiskMetrics,
): Result.Result<Evaluation, RiskEvaluationFailure> =>
  Result.mapError(
    decodeRiskEvaluationResult({
      policyHash: hashes.policyHash,
      input,
      decision,
      gates,
      metrics: {
        orderNotionalMicros: metrics.orderNotionalMicros.toString(),
        postTradeSymbolExposureMicros: metrics.postTradeSymbolExposureMicros.toString(),
        postTradeGrossExposureMicros: metrics.postTradeGrossExposureMicros.toString(),
        postTradeNetExposureMicros: metrics.postTradeNetExposureMicros.toString(),
        dailyTradedNotionalMicros: metrics.dailyTradedNotionalMicros.toString(),
        dailyLossMicros: metrics.dailyLossMicros.toString(),
        drawdownMicros: metrics.drawdownMicros.toString(),
        adverseSlippageBps: metrics.adverseSlippageBps.toString(),
        aggregateBuyingPowerMicros: metrics.aggregateBuyingPowerMicros.toString(),
        unresolvedOrderCount: metrics.unresolvedOrderCount,
      },
    }),
    (cause) =>
      decodeRiskOutputFailure('evaluation', 'derived risk evaluation is invalid', { intentId: input.intentId }, cause),
  )

const validateAuthorityBinding = (intent: RiskIntent, state: State): Result.Result<void, RiskEvaluationFailure> => {
  if (intent.schemaVersion === 'bayn.paper-intent.v3') {
    if (state.authority.maximum !== Authority.Paper) {
      return Result.fail(
        bindRiskAuthorityFailure(
          'authority-maximum',
          'authority-generation-bound risk intent requires PAPER maximum authority',
          { intentId: intent.intentId, maximum: state.authority.maximum },
        ),
      )
    }
    if (intent.authorityGenerationHash !== state.authority.generationHash) {
      return Result.fail(
        bindRiskAuthorityFailure(
          'authority-generation',
          'PAPER risk intent must bind the exact PAPER authority generation from risk state',
          {
            intentId: intent.intentId,
            expectedGenerationHash: state.authority.generationHash,
            observedGenerationHash: intent.authorityGenerationHash,
          },
        ),
      )
    }
  } else if (state.authority.maximum === Authority.Paper) {
    return Result.fail(
      bindRiskAuthorityFailure(
        'authority-contract',
        'PAPER risk evaluation requires an authority-generation-bound intent',
        { intentId: intent.intentId },
      ),
    )
  }
  return Result.succeed(undefined)
}

const evaluateDecoded = (
  intent: RiskIntent,
  state: State,
  policy: Policy,
  proposedPositions: State['positions'],
): Result.Result<Evaluation, RiskEvaluationFailure> =>
  Result.flatMap(validateAuthorityBinding(intent, state), () => {
    const facts = parseRiskFacts(intent, state, policy, proposedPositions)
    return Result.flatMap(deriveReconciledHash(facts), (reconciledHash) => {
      const metrics = deriveRiskMetrics(facts)
      const gates = buildRiskGates(facts, metrics, reconciledHash)
      const reasonCodes = gates.filter((gate) => !gate.passed).map((gate) => gate.reason)
      const outcome = reasonCodes.length === 0 ? RiskOutcome.Approved : RiskOutcome.Blocked
      const expiresAt = deriveRiskExpiry(facts, metrics, outcome)
      return Result.flatMap(deriveRiskBindingHashes(facts), (hashes) =>
        Result.flatMap(makeRiskInput(facts, hashes, expiresAt), (input) =>
          Result.flatMap(makeRiskDecision(facts, hashes, input, outcome, reasonCodes, expiresAt), (decision) =>
            makeRiskEvaluation(hashes, input, decision, gates, metrics),
          ),
        ),
      )
    })
  })

export const evaluate = (
  intentInput: unknown,
  stateInput: unknown,
  policyInput: unknown,
  proposedPositionsInput?: unknown,
): Result.Result<Evaluation, RiskEvaluationFailure> => {
  const intent = Result.mapError(decodeRiskIntentResult(intentInput), (cause) =>
    decodeRiskInputFailure('intent', 'risk intent is invalid', {}, cause),
  )
  if (Result.isFailure(intent)) return Result.fail(intent.failure)
  const state = Result.mapError(decodeRiskStateResult(stateInput), (cause) =>
    decodeRiskInputFailure('state', 'risk state is invalid', {}, cause),
  )
  if (Result.isFailure(state)) return Result.fail(state.failure)
  const policy = Result.mapError(decodeRiskPolicyResult(policyInput), (cause) =>
    decodeRiskInputFailure('policy', 'risk policy is invalid', {}, cause),
  )
  if (Result.isFailure(policy)) return Result.fail(policy.failure)
  const proposedPositions = Result.mapError(
    decodeProposedPositionsResult(proposedPositionsInput ?? state.success.positions),
    (cause) => decodeRiskInputFailure('positions', 'proposed risk positions are invalid', {}, cause),
  )
  if (Result.isFailure(proposedPositions)) return Result.fail(proposedPositions.failure)
  const proposedPositionIssues = positionBookIssues({
    positions: proposedPositions.success,
    accountId: state.success.account.accountId,
    observedAt: state.success.positionsObservedAt,
  })
  if (proposedPositionIssues.length > 0) {
    return Result.fail(
      decodeRiskInputFailure(
        'positions',
        'proposed risk positions do not match the authoritative position-book context',
        { issues: proposedPositionIssues },
      ),
    )
  }
  return evaluateDecoded(intent.success, state.success, policy.success, proposedPositions.success)
}

export const decodePolicy = Schema.decodeUnknownEffect(PolicySchema, StrictParseOptions)
export const decodeState = Schema.decodeUnknownEffect(StateSchema, StrictParseOptions)
