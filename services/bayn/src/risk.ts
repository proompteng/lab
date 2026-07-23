import { Schema } from 'effect'

import { canonicalHashV1 } from './hash'
import { ExecutionSessionBindingSchema } from './execution-session'
import {
  AccountSnapshotSchema,
  AccountStatus,
  Authority,
  AuthorityStateSchema,
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
  RiskDecisionSchema,
  RiskInputSchema,
  RiskOutcome,
  SignedMicrosSchema,
  TimeInForce,
  UnsignedMicrosSchema,
  type Intent,
  type RiskDecision,
  type RiskInput,
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
    const positionSymbols = state.positions.map((position) => position.symbol)
    if (new Set(positionSymbols).size !== positionSymbols.length || !isSorted(positionSymbols)) {
      issues.push({ path: ['positions'], issue: 'must be unique and sorted by symbol' })
    }
    for (const [index, position] of state.positions.entries()) {
      if (position.accountId !== accountId) {
        issues.push({ path: ['positions', index, 'accountId'], issue: 'must match the account snapshot' })
      }
      if (position.observedAt !== state.positionsObservedAt) {
        issues.push({ path: ['positions', index, 'observedAt'], issue: 'must match positionsObservedAt' })
      }
      const quantity = BigInt(position.quantityMicros)
      const marketValue = BigInt(position.marketValueMicros)
      if (
        (quantity === 0n) !== (marketValue === 0n) ||
        (quantity > 0n && marketValue < 0n) ||
        (quantity < 0n && marketValue > 0n)
      ) {
        issues.push({ path: ['positions', index, 'marketValueMicros'], issue: 'must have the quantity sign' })
      }
    }
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

export type GateResult = {
  readonly name: Gate
  readonly passed: boolean
  readonly reason: Reason
  readonly actual: string
  readonly required: string
}

export type Evaluation = {
  readonly policyHash: string
  readonly input: RiskInput
  readonly decision: RiskDecision
  readonly gates: readonly GateResult[]
  readonly metrics: {
    readonly orderNotionalMicros: string
    readonly postTradeSymbolExposureMicros: string
    readonly postTradeGrossExposureMicros: string
    readonly postTradeNetExposureMicros: string
    readonly dailyTradedNotionalMicros: string
    readonly dailyLossMicros: string
    readonly drawdownMicros: string
    readonly adverseSlippageBps: string
    readonly aggregateBuyingPowerMicros: string
    readonly unresolvedOrderCount: number
  }
}

const decodeInput = Schema.decodeUnknownSync(RiskInputSchema, StrictParseOptions)
const decodeDecision = Schema.decodeUnknownSync(RiskDecisionSchema, StrictParseOptions)

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
  reason: Reason,
  passed: boolean,
  actual: string | number | bigint,
  required: string | number | bigint,
): GateResult => ({ name, reason, passed, actual: String(actual), required: String(required) })

const isUnresolved = (status: OrderStatus): boolean =>
  status === OrderStatus.New || status === OrderStatus.PartiallyFilled || status === OrderStatus.Pending

export const evaluate = (intent: Intent, state: State, policy: Policy): Evaluation => {
  const evaluatedAt = instant(state.evaluatedAt)
  const policyHash = canonicalHashV1(policy)
  const referencePrice = BigInt(state.referencePriceMicros)
  const expectedPrice = BigInt(state.expectedExecutionPriceMicros)
  const orderNotional = divideUp(BigInt(intent.quantityMicros) * expectedPrice, QUANTITY_SCALE)
  const direction = intent.side === OrderSide.Buy ? 1n : -1n
  const currentSymbolQuantity = state.positions
    .filter((position) => position.symbol === intent.symbol)
    .reduce((total, position) => total + BigInt(position.quantityMicros), 0n)
  const postTradeSymbolQuantity = currentSymbolQuantity + direction * BigInt(intent.quantityMicros)
  const postTradeSymbolExposureNumerator = postTradeSymbolQuantity * referencePrice
  const postTradeSymbolExposure = divideAwayFromZero(postTradeSymbolExposureNumerator, QUANTITY_SCALE)
  const postTradeSymbolExposureMagnitude = divideUp(absolute(postTradeSymbolExposureNumerator), QUANTITY_SCALE)
  const otherGrossExposure = state.positions
    .filter((position) => position.symbol !== intent.symbol)
    .reduce((total, position) => total + absolute(BigInt(position.marketValueMicros)), 0n)
  const otherNetExposure = state.positions
    .filter((position) => position.symbol !== intent.symbol)
    .reduce((total, position) => total + BigInt(position.marketValueMicros), 0n)
  const postTradeGrossExposure = otherGrossExposure + postTradeSymbolExposureMagnitude
  const postTradeNetExposureNumerator = otherNetExposure * QUANTITY_SCALE + postTradeSymbolExposureNumerator
  const postTradeNetExposure = divideAwayFromZero(postTradeNetExposureNumerator, QUANTITY_SCALE)
  const postTradeNetExposureMagnitude = divideUp(absolute(postTradeNetExposureNumerator), QUANTITY_SCALE)
  const aggregateBuyingPower =
    BigInt(state.reservedBuyingPowerMicros) + (intent.side === OrderSide.Buy ? orderNotional : 0n)
  const dailyTradedNotional = BigInt(state.dailyTradedNotionalMicros) + orderNotional
  const dailyLoss = positiveDifference(BigInt(state.dayStartEquityMicros), BigInt(state.account.equityMicros))
  const drawdown = positiveDifference(BigInt(state.peakEquityMicros), BigInt(state.account.equityMicros))
  const adversePriceDifference =
    intent.side === OrderSide.Buy
      ? positiveDifference(expectedPrice, referencePrice)
      : positiveDifference(referencePrice, expectedPrice)
  const adverseSlippageBps = divideUp(adversePriceDifference * BASIS_POINTS, referencePrice)
  const unresolvedOrderCount = state.orders.filter((order) => isUnresolved(order.status)).length
  const reconciledHash = reconciledStateHash({
    account: state.account,
    positions: state.positions,
    positionsObservedAt: state.positionsObservedAt,
    orders: state.orders,
    ordersObservedAt: state.ordersObservedAt,
    accountingHash: state.accountingHash,
  })
  const oldestBrokerState = Math.min(
    instant(state.account.observedAt),
    instant(state.positionsObservedAt),
    instant(state.ordersObservedAt),
    ...state.orders.map((order) => instant(order.observedAt)),
    instant(state.reconciliation.reconciledAt),
    instant(state.authorityObservedAt),
  )
  const brokerFreshUntil = oldestBrokerState + policy.maxBrokerStateAgeMs
  const marketFreshUntil = instant(state.marketDataObservedAt) + policy.maxMarketDataAgeMs
  const submissionOpen = instant(state.executionSession.submissionOpenAt)
  const submissionCutoff = instant(state.executionSession.submissionCutoffAt)

  const gates = [
    makeGate(Gate.IntentState, Reason.IntentNotPlanned, intent.state === IntentState.Planned, intent.state, 'PLANNED'),
    makeGate(
      Gate.IntentTime,
      Reason.IntentTimeInvalid,
      instant(intent.createdAt) >= submissionOpen && instant(intent.createdAt) <= evaluatedAt,
      intent.createdAt,
      `[${state.executionSession.submissionOpenAt},${state.evaluatedAt}]`,
    ),
    makeGate(
      Gate.IntentFreshness,
      Reason.IntentStale,
      evaluatedAt < instant(intent.createdAt) + policy.maxIntentAgeMs,
      evaluatedAt - instant(intent.createdAt),
      `<${policy.maxIntentAgeMs}`,
    ),
    makeGate(
      Gate.Account,
      Reason.AccountMismatch,
      intent.accountId === policy.accountId && state.account.accountId === policy.accountId,
      `${intent.accountId}:${state.account.accountId}`,
      policy.accountId,
    ),
    makeGate(
      Gate.AccountStatus,
      Reason.AccountNotActive,
      state.account.status === AccountStatus.Active,
      state.account.status,
      AccountStatus.Active,
    ),
    makeGate(
      Gate.Equity,
      Reason.EquityNotPositive,
      BigInt(state.account.equityMicros) > 0n,
      state.account.equityMicros,
      '>0',
    ),
    makeGate(
      Gate.Symbol,
      Reason.SymbolNotAllowed,
      policy.allowedSymbols.includes(intent.symbol),
      intent.symbol,
      policy.allowedSymbols.join(','),
    ),
    makeGate(
      Gate.MarketDataSymbol,
      Reason.MarketDataSymbolMismatch,
      state.marketDataSymbol === intent.symbol,
      state.marketDataSymbol,
      intent.symbol,
    ),
    makeGate(
      Gate.OrderType,
      Reason.OrderTypeNotAllowed,
      intent.orderType === OrderType.Market,
      intent.orderType,
      policy.allowedOrderTypes.join(','),
    ),
    makeGate(
      Gate.TimeInForce,
      Reason.TimeInForceNotAllowed,
      policy.allowedTimeInForce.includes(intent.timeInForce),
      intent.timeInForce,
      policy.allowedTimeInForce.join(','),
    ),
    makeGate(
      Gate.Authority,
      Reason.AuthorityNotPaper,
      state.authority.maximum === Authority.Paper && state.authority.effective === Authority.Paper,
      `${state.authority.maximum}:${state.authority.effective}`,
      'PAPER:PAPER',
    ),
    makeGate(Gate.Kill, Reason.KillActive, state.authority.kill === KillState.Clear, state.authority.kill, 'CLEAR'),
    makeGate(
      Gate.Reconciliation,
      Reason.ReconciliationNotExact,
      state.reconciliation.status === ReconciliationStatus.Exact &&
        state.reconciliation.expectedHash === reconciledHash &&
        state.reconciliation.observedHash === reconciledHash,
      `${state.reconciliation.status}:${state.reconciliation.expectedHash}:${state.reconciliation.observedHash}`,
      `${ReconciliationStatus.Exact}:${reconciledHash}:${reconciledHash}`,
    ),
    makeGate(
      Gate.BrokerStateFreshness,
      Reason.BrokerStateStale,
      evaluatedAt < brokerFreshUntil,
      evaluatedAt - oldestBrokerState,
      `<${policy.maxBrokerStateAgeMs}`,
    ),
    makeGate(
      Gate.MarketDataFreshness,
      Reason.MarketDataStale,
      evaluatedAt < marketFreshUntil,
      evaluatedAt - instant(state.marketDataObservedAt),
      `<${policy.maxMarketDataAgeMs}`,
    ),
    makeGate(
      Gate.Session,
      Reason.OutsideSession,
      evaluatedAt >= submissionOpen && evaluatedAt < submissionCutoff,
      state.evaluatedAt,
      `[${state.executionSession.submissionOpenAt},${state.executionSession.submissionCutoffAt})`,
    ),
    makeGate(
      Gate.UnknownMutations,
      Reason.UnknownMutation,
      state.unknownMutationCount === 0,
      state.unknownMutationCount,
      0,
    ),
    makeGate(
      Gate.UnresolvedOrders,
      Reason.UnresolvedOrdersExceeded,
      unresolvedOrderCount <= policy.maxUnresolvedOrders,
      unresolvedOrderCount,
      `<=${policy.maxUnresolvedOrders}`,
    ),
    makeGate(
      Gate.IntentNotional,
      Reason.IntentNotionalExceeded,
      orderNotional <= BigInt(intent.notionalLimitMicros),
      orderNotional,
      `<=${intent.notionalLimitMicros}`,
    ),
    makeGate(
      Gate.OrderNotional,
      Reason.OrderNotionalExceeded,
      orderNotional <= BigInt(policy.maxOrderNotionalMicros),
      orderNotional,
      `<=${policy.maxOrderNotionalMicros}`,
    ),
    makeGate(
      Gate.BuyingPower,
      Reason.BuyingPowerExceeded,
      aggregateBuyingPower <= BigInt(state.account.buyingPowerMicros),
      aggregateBuyingPower,
      `<=${state.account.buyingPowerMicros}`,
    ),
    makeGate(
      Gate.AdverseSlippage,
      Reason.AdverseSlippageExceeded,
      adverseSlippageBps <= BigInt(policy.maxAdverseSlippageBps),
      adverseSlippageBps,
      `<=${policy.maxAdverseSlippageBps}`,
    ),
    makeGate(
      Gate.LongOnly,
      Reason.ShortPositionNotAllowed,
      currentSymbolQuantity >= 0n && postTradeSymbolQuantity >= 0n,
      `${currentSymbolQuantity}:${postTradeSymbolQuantity}`,
      '>=0:>=0',
    ),
    makeGate(
      Gate.SymbolExposure,
      Reason.SymbolExposureExceeded,
      postTradeSymbolExposureMagnitude <= BigInt(policy.maxSymbolExposureMicros),
      postTradeSymbolExposureMagnitude,
      `<=${policy.maxSymbolExposureMicros}`,
    ),
    makeGate(
      Gate.GrossExposure,
      Reason.GrossExposureExceeded,
      postTradeGrossExposure <= BigInt(policy.maxGrossExposureMicros),
      postTradeGrossExposure,
      `<=${policy.maxGrossExposureMicros}`,
    ),
    makeGate(
      Gate.NetExposure,
      Reason.NetExposureExceeded,
      postTradeNetExposureMagnitude <= BigInt(policy.maxNetExposureMicros),
      postTradeNetExposureMagnitude,
      `<=${policy.maxNetExposureMicros}`,
    ),
    makeGate(
      Gate.DailyTradedNotional,
      Reason.DailyTradedNotionalExceeded,
      dailyTradedNotional <= BigInt(policy.maxDailyTradedNotionalMicros),
      dailyTradedNotional,
      `<=${policy.maxDailyTradedNotionalMicros}`,
    ),
    makeGate(
      Gate.DailyLoss,
      Reason.DailyLossExceeded,
      dailyLoss <= BigInt(policy.maxDailyLossMicros),
      dailyLoss,
      `<=${policy.maxDailyLossMicros}`,
    ),
    makeGate(
      Gate.Drawdown,
      Reason.DrawdownExceeded,
      drawdown <= BigInt(policy.maxDrawdownMicros),
      drawdown,
      `<=${policy.maxDrawdownMicros}`,
    ),
  ] as const

  const reasonCodes = gates.filter((gate) => !gate.passed).map((gate) => gate.reason)
  const outcome = reasonCodes.length === 0 ? RiskOutcome.Approved : RiskOutcome.Blocked
  const approvalExpiry = Math.min(
    evaluatedAt + policy.decisionTtlMs,
    instant(intent.createdAt) + policy.maxIntentAgeMs,
    brokerFreshUntil,
    marketFreshUntil,
    submissionCutoff,
  )
  const expiresAt = utc(
    outcome === RiskOutcome.Approved ? approvalExpiry : evaluatedAt + Math.min(1_000, policy.decisionTtlMs),
  )
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
  const positionsHash = canonicalHashV1({ items: state.positions, observedAt: state.positionsObservedAt })
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
  const inputMaterial = {
    schemaVersion: 'bayn.paper-risk-evaluation-input.v1',
    intent,
    policy,
    state,
    componentHashes: { accountSnapshotHash, positionsHash, ordersHash, marketDataHash },
  } as const
  const inputHash = canonicalHashV1(inputMaterial)
  const input = decodeInput({
    schemaVersion: 'bayn.paper-risk-input.v1',
    inputHash,
    intentId: intent.intentId,
    policyHash,
    accountSnapshotHash,
    positionsHash,
    ordersHash,
    marketDataHash,
    evaluatedAt: state.evaluatedAt,
    freshUntil: expiresAt,
  })
  const decisionMaterial = {
    schemaVersion: 'bayn.paper-risk-decision.v1',
    inputHash,
    intentId: intent.intentId,
    policyHash,
    outcome,
    reasonCodes,
    decidedAt: state.evaluatedAt,
    expiresAt,
  } as const
  const decision = decodeDecision({ ...decisionMaterial, decisionId: canonicalHashV1(decisionMaterial) })

  return {
    policyHash,
    input,
    decision,
    gates,
    metrics: {
      orderNotionalMicros: orderNotional.toString(),
      postTradeSymbolExposureMicros: postTradeSymbolExposure.toString(),
      postTradeGrossExposureMicros: postTradeGrossExposure.toString(),
      postTradeNetExposureMicros: postTradeNetExposure.toString(),
      dailyTradedNotionalMicros: dailyTradedNotional.toString(),
      dailyLossMicros: dailyLoss.toString(),
      drawdownMicros: drawdown.toString(),
      adverseSlippageBps: adverseSlippageBps.toString(),
      aggregateBuyingPowerMicros: aggregateBuyingPower.toString(),
      unresolvedOrderCount,
    },
  }
}

export const decodePolicy = Schema.decodeUnknownEffect(PolicySchema, StrictParseOptions)
export const decodeState = Schema.decodeUnknownEffect(StateSchema, StrictParseOptions)
