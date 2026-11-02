import { Result, Schema } from 'effect'

import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { canonicalHashV1Result } from '../hash'
import { jevMarketForSymbol } from '../jev/markets'
import { jevEntryQuoteExclusion } from '../jev/trading-signals'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { isContinuousMarket, observationSession } from '../market-hours'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { ExecutionRiskPolicySchema } from '../risk'
import { NonNegativeIntegerSchema, PositiveMicrosSchema, StrictNonEmptyStringSchema } from '../schemas'
import { replayQuoteRejection } from './broker-execution-evidence'
import {
  controlEntryQuantity,
  createControlPortfolio,
  type ControlPortfolio,
  type ControlQuote,
} from './control-portfolio'
import { applyReplayFill, createReplayLedger } from './ledger'
import { ReplayInstrumentsSchema } from './execution-core'
import {
  finishMatchedLifecycle,
  MatchedEvent,
  stepMatchedLifecycle,
  type MatchedLifecycle,
  type MatchedTerms,
} from './matched-entry-lifecycle'
import { SignalScreenRule, SignalStudyFailure, studyOrder, type prepareSignalStudyBatch } from './signal-study'

export const CapitalScenarioSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  latencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
  slippageBps: NonNegativeIntegerSchema.check(Schema.isLessThan(10_000)),
  availableLiquidityPpm: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  feeMultiplierPpm: Schema.Int.check(Schema.isBetween({ minimum: 1_000_000, maximum: 10_000_000 })),
})
export const CapitalTermsSchema = Schema.Struct({
  openingCashMicros: PositiveMicrosSchema,
  policy: ExecutionRiskPolicySchema,
  instruments: ReplayInstrumentsSchema,
  costHurdleMarginBps: NonNegativeIntegerSchema.check(Schema.isLessThan(10_000)),
  scenarios: Schema.Array(CapitalScenarioSchema).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
})
export type CapitalTerms = typeof CapitalTermsSchema.Type
export type CapitalScenario = typeof CapitalScenarioSchema.Type
export type CapitalBatch = Result.Result.Success<ReturnType<typeof prepareSignalStudyBatch>>
export interface CapitalOpportunity {
  readonly batch: CapitalBatch
  readonly committedAtMs: number | null
  readonly inferenceCostMicros: string | null
  readonly operatingCostMicros: string | null
  readonly knownInferenceCostMicros: string
  readonly knownOperatingCostMicros: string
}
export enum CapitalArm {
  Baseline = 'RETAINED_ALGO_JEV',
  CostHurdle = 'RETAINED_ALGO_JEV_COST_HURDLE',
}
export enum CapitalAdmission {
  UnknownCommitment = 'UNKNOWN_COMMITMENT',
  UnknownCommitmentOutsideSource = 'UNKNOWN_COMMITMENT_OUTSIDE_SOURCE',
  UnknownModelDecision = 'UNKNOWN_MODEL_DECISION',
  Late = 'LATE',
  Abstain = 'ABSTAIN',
  CapitalBusy = 'CAPITAL_BUSY',
  SymbolBlocked = 'SYMBOL_BLOCKED',
  Cutoff = 'CUTOFF',
  UnknownEntryQuote = 'UNKNOWN_ENTRY_QUOTE',
  EntryQuoteBlocked = 'ENTRY_QUOTE_BLOCKED',
  UnknownRiskEquity = 'UNKNOWN_RISK_EQUITY',
  LossOrDrawdownBlocked = 'LOSS_OR_DRAWDOWN_BLOCKED',
  CapitalOrTurnoverBlocked = 'CAPITAL_OR_TURNOVER_BLOCKED',
  UnknownHurdleCost = 'UNKNOWN_HURDLE_COST',
  HurdleCapacityRejected = 'HURDLE_CAPACITY_REJECTED',
  CostHurdle = 'COST_HURDLE',
  Admitted = 'ADMITTED',
}
export enum CapitalEventKind {
  Opportunity = 'OPPORTUNITY',
  EntryArrival = 'ENTRY_ARRIVAL',
  Poll = 'POLL',
  ExitArrival = 'EXIT_ARRIVAL',
}
export interface CapitalEvent {
  readonly atMs: number
  readonly opportunity: CapitalOpportunity
  readonly kind: CapitalEventKind
}
interface Active {
  readonly batchId: string
  readonly lifecycle: MatchedLifecycle
  readonly startFillIndex: number
  readonly startEpisodeIndex: number
  readonly openingCashMicros: string
  readonly terms: MatchedTerms
}
export interface CapitalState {
  readonly arm: CapitalArm
  readonly portfolio: ControlPortfolio
  readonly active: Active | null
  readonly rows: readonly {
    readonly batchId: string
    readonly status: CapitalAdmission
    readonly hurdle: ReturnType<typeof hurdleRecord> | null
  }[]
  readonly trades: readonly { readonly batchId: string; readonly result: ReturnType<typeof finishTrade> }[]
  readonly inferenceMicros: bigint
  readonly operatingMicros: bigint
  readonly unknownInference: number
  readonly unknownOperating: number
  readonly peakMicros: bigint
  readonly maximumDrawdownMicros: bigint
  readonly missingMarks: number
  readonly lastMissingMarkAtMs: number | null
  readonly problems: readonly string[]
  readonly days: ReadonlyMap<string, { readonly opening: bigint; readonly peak: bigint; readonly turnover: bigint }>
}
const riskDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
const dayAt = (atMs: number) => riskDate.format(atMs)
const fail = (message: string) => Result.fail(new SignalStudyFailure({ message }))
const hurdleRecord = (proxy: bigint, cost: bigint, principal: bigint) => ({
  momentumProxyMicros: String(proxy),
  estimatedRoundTripLossMicros: String(cost),
  projectedEntryNotionalMicros: String(principal),
})

export const capitalAblationDefinition = {
  schemaVersion: 'bayn.capital-ablation-definition.v1',
  baseline: `Frozen native ${defaultJevProtocolDocument.schemaVersion} algorithm + Jev entry choices; one cash portfolio per arm and scenario.`,
  candidate:
    'After the same Jev decision, require native lookback price return times projected entry notional to exceed an immediate quote-based round-trip loss, allocated inference and operating expense, and the frozen margin. Momentum is an uncalibrated proxy, never expected payoff or a win probability.',
  management: 'Common five-second mechanical stop/maximum-hold exits with persistent reducing IOC retries.',
  costAccounting:
    'Fees book only through the replay ledger. Spread and slippage are embedded in fill prices. Hurdle estimates are never booked. Inference and operating allocations charge every retained opportunity in both arms, including busy, rejected, late and abstaining decisions; they do not debit broker cash.',
  risk: 'One shared position and cash balance across both markets; v5 capital weights and frozen order/exposure/cash caps. New York daily turnover, loss and peak drawdown guards; reserve entry plus expected exit turnover. Exits continue after entry guards bind.',
  limitations: [
    'DEVELOPMENT_SCENARIO, never held-out proof, strategy qualification or trading authority.',
    'Retained flat-entry opportunities are endogenous: opportunities absent while the recorder strategy held inventory remain unknown. Both arms see exactly the supplied population.',
    'Frozen Jev responses are not regenerated for counterfactual cash, inventory or account context. Mechanical exits isolate entry admission; this is not a replay of native Jev position management.',
    'Opening cash, initially zero turnover, flat inventory, and policy limits are frozen scenario inputs, not a reconstructed live account. No pending broker orders or external cash flows are modeled.',
    'Tariffs, crypto fee multipliers, capacity, slippage and routing are declared scenarios, never account fee-tier or executable-capacity claims. Inference timing and native evidence remain observed and are not accelerated.',
    'Drawdown is sampled at event/poll times using fresh bids and known allocated costs; it is not a continuous or liquidation-fee-adjusted drawdown. Missing marks and unknown expenses withhold the complete metric.',
  ],
} as const

export const validateCapitalPopulation = (opportunities: readonly CapitalOpportunity[], terms: CapitalTerms) =>
  Result.gen(function* () {
    if (new Set(terms.scenarios.map((s) => s.id)).size !== terms.scenarios.length)
      return yield* fail('Duplicate capital scenario id')
    if (
      terms.policy.maxAdverseSlippageBps !== 10 ||
      !terms.policy.allowedOrderTypes.includes(OrderType.Limit) ||
      !terms.policy.allowedTimeInForce.includes(TimeInForce.ImmediateOrCancel)
    )
      return yield* fail('Capital ablation requires the existing ten-bp LIMIT/IOC pricing contract')
    const expectedProtocolHash = yield* canonicalHashV1Result(defaultJevProtocolDocument)
    const ids = new Set<string>()
    for (const { batch, committedAtMs } of opportunities) {
      if (ids.has(batch.plan.batchId)) return yield* fail('Duplicate capital opportunity')
      ids.add(batch.plan.batchId)
      if ((yield* canonicalHashV1Result(batch.observation.protocol)) !== expectedProtocolHash)
        return yield* fail(
          `Capital ablation requires the current unmodified ${defaultJevProtocolDocument.schemaVersion}`,
        )
      if (batch.observation.portfolio.brokerState.account.accountId !== terms.policy.accountId)
        return yield* fail('Capital policy account differs from retained opportunities')
      if (committedAtMs !== null && committedAtMs < Date.parse(batch.decidedAt))
        return yield* fail('Capital commitment precedes the native decision')
    }
    return expectedProtocolHash
  })

export const capitalEvents = (
  opportunities: readonly CapitalOpportunity[],
  scenario: CapitalScenario,
  endMs: number,
) => {
  const events: CapitalEvent[] = []
  for (const opportunity of opportunities) {
    const atMs = opportunity.committedAtMs ?? Date.parse(opportunity.batch.decidedAt)
    const add = (kind: CapitalEventKind, at: number) => {
      if (at <= endMs) events.push({ kind, atMs: at, opportunity })
    }
    add(CapitalEventKind.Opportunity, Math.min(atMs, endMs))
    add(CapitalEventKind.EntryArrival, atMs + scenario.latencyMs)
    const protocol = opportunity.batch.observation.protocol
    const deadline = Math.min(endMs, atMs + scenario.latencyMs + protocol.maximumHoldingMinutes * 60_000 + 180_000)
    for (let at = atMs + scenario.latencyMs + 5000; at + scenario.latencyMs < deadline; at += 5000) {
      add(CapitalEventKind.Poll, at)
      add(CapitalEventKind.ExitArrival, at + scenario.latencyMs)
    }
  }
  const priority = { POLL: 0, EXIT_ARRIVAL: 1, OPPORTUNITY: 2, ENTRY_ARRIVAL: 3 }
  return events.sort(
    (a, b) =>
      a.atMs - b.atMs ||
      priority[a.kind] - priority[b.kind] ||
      a.opportunity.batch.plan.batchId.localeCompare(b.opportunity.batch.plan.batchId),
  )
}

export const createCapitalState = (arm: CapitalArm, openingCashMicros: string) =>
  createControlPortfolio(openingCashMicros).pipe(
    Result.map(
      (portfolio): CapitalState => ({
        arm,
        portfolio,
        active: null,
        rows: [],
        trades: [],
        inferenceMicros: 0n,
        operatingMicros: 0n,
        unknownInference: 0,
        unknownOperating: 0,
        peakMicros: BigInt(openingCashMicros),
        maximumDrawdownMicros: 0n,
        missingMarks: 0,
        lastMissingMarkAtMs: null,
        problems: [],
        days: new Map(),
      }),
    ),
  )

// Same existing execution and fee primitives as real replay. The hypothetical flat-price round trip is a gate only.
const estimateHurdle = (input: {
  readonly quantityAtoms: bigint
  readonly quote: NonNullable<ControlQuote>
  readonly terms: MatchedTerms
  readonly lookbackReturnBps: number
}) =>
  Result.gen(function* () {
    const { terms, quote, quantityAtoms } = input
    const assumptions = { ...terms.assumptions, latencyMs: 0 }
    const order = (side: OrderSide, quantity: bigint) =>
      studyOrder({
        ...terms,
        assumptions,
        orderType: OrderType.Limit,
        side,
        quantityAtoms: quantity,
        decisionQuote: quote,
        arrivalQuote: quote,
        decisionAtMs: terms.decidedAtMs,
        arrivalAtMs: terms.decidedAtMs,
      })
    const bought = yield* order(OrderSide.Buy, quantityAtoms)
    if (bought.status !== 'FILLED') return null
    const opening = yield* createReplayLedger(terms.entryBudgetMicros)
    const ledger = yield* applyReplayFill(
      opening,
      bought.fill,
      String(quantityAtoms),
      terms.protocol.executionModel,
      assumptions.feeMultiplierPpm,
    )
    const quantity = BigInt(ledger.positions[0]?.quantityAtoms ?? '0')
    const sold = yield* order(OrderSide.Sell, quantity)
    if (sold.status !== 'FILLED') return null
    const closed = yield* applyReplayFill(
      ledger,
      sold.fill,
      String(quantity),
      terms.protocol.executionModel,
      assumptions.feeMultiplierPpm,
    )
    if (closed.netRealizedPnlAfterCostsMicros === null) return null
    const pnl = BigInt(closed.netRealizedPnlAfterCostsMicros)
    const principal = BigInt(bought.fill.notionalMicros)
    // Native metrics are integer bps; this is a frozen observed momentum proxy, not a calibrated forecast.
    return hurdleRecord((principal * BigInt(Math.floor(input.lookbackReturnBps))) / 10_000n, -pnl, principal)
  })

export const stepCapitalState = (
  state: CapitalState,
  config: CapitalTerms,
  scenario: CapitalScenario,
  event: CapitalEvent,
  quote: ControlQuote,
  heldQuote: ControlQuote = quote,
): Result.Result<CapitalState, SignalStudyFailure> =>
  Result.gen(function* () {
    const { batch } = event.opportunity
    const { atMs } = event
    const batchId = batch.plan.batchId
    let next = yield* markCapitalState(state, atMs, heldQuote)
    if (event.kind === CapitalEventKind.Opportunity) {
      next = {
        ...next,
        inferenceMicros: next.inferenceMicros + BigInt(event.opportunity.knownInferenceCostMicros),
        operatingMicros: next.operatingMicros + BigInt(event.opportunity.knownOperatingCostMicros),
        unknownInference: next.unknownInference + Number(event.opportunity.inferenceCostMicros === null),
        unknownOperating: next.unknownOperating + Number(event.opportunity.operatingCostMicros === null),
      }
      const row = (status: CapitalAdmission, hurdle: ReturnType<typeof hurdleRecord> | null = null): CapitalState => ({
        ...next,
        rows: [...next.rows, { batchId, status, hurdle }],
      })
      if (event.opportunity.committedAtMs === null) return row(CapitalAdmission.UnknownCommitment)
      if (event.opportunity.committedAtMs !== atMs) return row(CapitalAdmission.UnknownCommitmentOutsideSource)
      if (batch.modelStatus !== 'AVAILABLE') return row(CapitalAdmission.UnknownModelDecision)
      if (atMs >= Date.parse(batch.plan.expiresAt)) return row(CapitalAdmission.Late)
      const symbol = batch.selected[SignalScreenRule.Jev]
      if (symbol === null) return row(CapitalAdmission.Abstain)
      if (next.active !== null) return row(CapitalAdmission.CapitalBusy)
      if (!config.policy.allowedSymbols.includes(symbol)) return row(CapitalAdmission.SymbolBlocked)
      const protocol = batch.observation.protocol
      const session = observationSession(batch.snapshot.manifest.calendar, batch.snapshot.manifest.sessionDate)
      if (session === undefined) return yield* fail('Capital opportunity has no market session')
      const terms: MatchedTerms = {
        symbol,
        protocol,
        assumptions: { ...scenario, instruments: config.instruments },
        entryBudgetMicros: next.portfolio.ledger.cashMicros,
        decidedAtMs: atMs,
        cutoffMs: isContinuousMarket(batch.snapshot.manifest.calendar)
          ? Number.POSITIVE_INFINITY
          : Date.parse(session.closeAt) - protocol.flattenBeforeCloseMinutes * 60_000,
        closeMs: isContinuousMarket(batch.snapshot.manifest.calendar)
          ? atMs + scenario.latencyMs + protocol.maximumHoldingMinutes * 60_000 + 180_000
          : Date.parse(session.closeAt),
      }
      if (atMs + scenario.latencyMs >= terms.cutoffMs) return row(CapitalAdmission.Cutoff)
      const rejection = replayQuoteRejection(quote, symbol, atMs, { ...protocol, ...jevMarketForSymbol(symbol) })
      if (rejection !== null || quote === undefined)
        return { ...row(CapitalAdmission.UnknownEntryQuote), problems: [...next.problems, `${batchId}:${rejection}`] }
      if ((yield* jevEntryQuoteExclusion(quote.value)) !== null) return row(CapitalAdmission.EntryQuoteBlocked)
      if (next.missingMarks > 0) return row(CapitalAdmission.UnknownRiskEquity)
      const cash = BigInt(next.portfolio.ledger.cashMicros)
      const day = next.days.get(dayAt(atMs)) ?? { opening: cash, peak: cash, turnover: 0n }
      if (
        day.opening - cash > BigInt(config.policy.maxDailyLossMicros) ||
        day.peak - cash > BigInt(config.policy.maxDrawdownMicros)
      )
        return row(CapitalAdmission.LossOrDrawdownBlocked)
      const quantityAtoms = yield* controlEntryQuantity({
        portfolio: { ...next.portfolio, tradedNotionalMicros: day.turnover },
        policy: config.policy,
        protocol,
        targetWeight: Math.min(protocol.maximumGrossWeight, protocol.maximumSymbolWeight),
        symbol,
        referencePriceMicros: yield* priceNumberToMicros(quote.value.askPrice, 'capital.ask', 'UP'),
        instruments: terms.assumptions.instruments,
        atMs,
        feeMultiplierPpm: scenario.feeMultiplierPpm,
        turnoverPolicy: EntryTurnoverPolicy.EntryAndExpectedExit,
      })
      if (quantityAtoms === 0n) return row(CapitalAdmission.CapitalOrTurnoverBlocked)
      let hurdle: ReturnType<typeof hurdleRecord> | null = null
      if (state.arm === CapitalArm.CostHurdle) {
        if (event.opportunity.inferenceCostMicros === null || event.opportunity.operatingCostMicros === null)
          return row(CapitalAdmission.UnknownHurdleCost)
        const signal = batch.signals.find((candidate) => candidate.symbol === symbol)
        if (signal === undefined) return yield* fail('Native selection has no reproduced signal')
        hurdle = yield* estimateHurdle({
          quantityAtoms,
          quote,
          terms,
          lookbackReturnBps: signal.metrics.lookbackReturnBps,
        })
        if (hurdle === null) return row(CapitalAdmission.HurdleCapacityRejected)
        const margin =
          (BigInt(hurdle.projectedEntryNotionalMicros) * BigInt(config.costHurdleMarginBps) + 9999n) / 10_000n
        if (
          BigInt(hurdle.momentumProxyMicros) <=
          BigInt(hurdle.estimatedRoundTripLossMicros) +
            BigInt(event.opportunity.inferenceCostMicros) +
            BigInt(event.opportunity.operatingCostMicros) +
            margin
        )
          return row(CapitalAdmission.CostHurdle, hurdle)
      }
      return {
        ...row(CapitalAdmission.Admitted, hurdle),
        active: {
          batchId,
          terms,
          startFillIndex: next.portfolio.ledger.fills.length,
          startEpisodeIndex: next.portfolio.episodes.length,
          openingCashMicros: next.portfolio.ledger.cashMicros,
          lifecycle: {
            portfolio: next.portfolio,
            entry: { status: 'PENDING' as const, quantityAtoms, quote },
            exit: null,
            problems: [],
            quoteHashes: [quote.recordHash],
            orders: [],
          },
        },
      }
    }
    const active = next.active
    if (active === null || active.batchId !== batchId) return next
    if (event.kind === CapitalEventKind.Poll && active.lifecycle.exit !== null) return next
    if (
      event.kind === CapitalEventKind.ExitArrival &&
      (active.lifecycle.exit === null || active.lifecycle.exit.atMs + scenario.latencyMs !== atMs)
    )
      return next
    const lifecycle = yield* stepMatchedLifecycle(active.lifecycle, active.terms, {
      kind:
        event.kind === CapitalEventKind.EntryArrival
          ? MatchedEvent.EntryArrival
          : event.kind === CapitalEventKind.Poll
            ? MatchedEvent.Poll
            : MatchedEvent.ExitArrival,
      atMs,
      quote,
    })
    const newFills = lifecycle.portfolio.ledger.fills.slice(next.portfolio.ledger.fills.length)
    const days = new Map(next.days)
    for (const fill of newFills) {
      const date = dayAt(Date.parse(fill.observedAt))
      const cash = BigInt(next.portfolio.ledger.cashMicros)
      const day = days.get(date) ?? { opening: cash, peak: cash, turnover: 0n }
      days.set(date, { ...day, turnover: day.turnover + BigInt(fill.notionalMicros) })
    }
    next = { ...next, portfolio: lifecycle.portfolio, active: { ...active, lifecycle }, days }
    if (lifecycle.portfolio.inventory.status === 'FLAT')
      next = {
        ...next,
        active: null,
        trades: [...next.trades, { batchId, result: finishTrade({ ...active, lifecycle }) }],
      }
    return next
  }).pipe(Result.mapError((cause) => new SignalStudyFailure({ message: 'Capital ablation step failed', cause })))

const finishTrade = (active: Active) => {
  const result = finishMatchedLifecycle(active.lifecycle)
  const fills = result.fills.slice(active.startFillIndex)
  const flat = active.lifecycle.portfolio.ledger.positions.length === 0
  const resolved = result.problems.length === 0 && flat && result.orders.length > 0
  return {
    ...result,
    requestedEntryQuantityAtoms:
      active.lifecycle.entry?.status === 'PENDING' ? String(active.lifecycle.entry.quantityAtoms) : '0',
    status: resolved
      ? fills.length === 0
        ? ('NO_ENTRY_FILL' as const)
        : ('RESOLVED' as const)
      : ('UNRESOLVED' as const),
    fills,
    episodes: result.episodes.slice(active.startEpisodeIndex),
    netExecutionPnlMicros: resolved
      ? String(BigInt(active.lifecycle.portfolio.ledger.cashMicros) - BigInt(active.openingCashMicros))
      : null,
  }
}

export const markCapitalState = (
  state: CapitalState,
  atMs: number,
  quote: ControlQuote,
): Result.Result<CapitalState, SignalStudyFailure> =>
  Result.gen(function* () {
    let equity = BigInt(state.portfolio.ledger.cashMicros)
    const position = state.portfolio.ledger.positions[0]
    if (position !== undefined) {
      const protocol = state.active?.terms.protocol
      if (protocol === undefined) return yield* fail('Capital inventory has no active lifecycle')
      if (
        quote === undefined ||
        replayQuoteRejection(quote, position.symbol, atMs, { ...protocol, ...jevMarketForSymbol(position.symbol) }) !==
          null
      )
        return {
          ...state,
          missingMarks: state.missingMarks + Number(state.lastMissingMarkAtMs !== atMs),
          lastMissingMarkAtMs: atMs,
        }
      equity +=
        (BigInt(position.quantityAtoms) * (yield* priceNumberToMicros(quote.value.bidPrice, 'capital.mark', 'DOWN'))) /
        1_000_000_000n
    }
    const days = new Map(state.days)
    const date = dayAt(atMs)
    const day = days.get(date) ?? { opening: equity, peak: equity, turnover: 0n }
    days.set(date, { ...day, peak: equity > day.peak ? equity : day.peak })
    const afterKnownCosts = equity - state.inferenceMicros - state.operatingMicros
    const peak = state.peakMicros > afterKnownCosts ? state.peakMicros : afterKnownCosts
    const drawdown = peak - afterKnownCosts
    return {
      ...state,
      days,
      peakMicros: peak,
      maximumDrawdownMicros: drawdown > state.maximumDrawdownMicros ? drawdown : state.maximumDrawdownMicros,
    }
  }).pipe(Result.mapError((cause) => new SignalStudyFailure({ message: 'Capital valuation failed', cause })))

export const finishCapitalState = (state: CapitalState) => {
  const trades = [
    ...state.trades,
    ...(state.active === null ? [] : [{ batchId: state.active.batchId, result: finishTrade(state.active) }]),
  ]
  const executionComplete =
    state.active === null &&
    state.problems.length === 0 &&
    trades.every((t) => t.result.status !== 'UNRESOLVED') &&
    state.rows.every((row) => !row.status.startsWith('UNKNOWN') && !row.status.startsWith('UNRESOLVED'))
  const pnl = executionComplete ? state.portfolio.ledger.netRealizedPnlAfterCostsMicros : null
  const allCostsKnown = state.unknownInference === 0 && state.unknownOperating === 0
  const fills = state.portfolio.ledger.fills
  const buyOrders = trades.flatMap((trade) => trade.result.orders.filter((order) => order.side === OrderSide.Buy))
  const filledEntries = buyOrders.filter((order) => order.outcome.status === 'FILLED').length
  return {
    arm: state.arm,
    opportunities: state.rows,
    eligibleOpportunityIds: state.rows.map((row) => row.batchId),
    trades,
    ledger: state.portfolio.ledger,
    metrics: {
      opportunities: state.rows.length,
      admitted: state.rows.filter((row) => row.status === CapitalAdmission.Admitted).length,
      capitalBusy: state.rows.filter((row) => row.status === CapitalAdmission.CapitalBusy).length,
      costRejected: state.rows.filter((row) => row.status === CapitalAdmission.CostHurdle).length,
      unavailableOrUnknown: state.rows.filter(
        (row) =>
          row.status.startsWith('UNKNOWN') ||
          row.status.startsWith('UNRESOLVED') ||
          row.status === CapitalAdmission.Late,
      ).length,
      entryOrders: buyOrders.length,
      filledEntries,
      entryOrderFillRate: buyOrders.length === 0 ? null : filledEntries / buyOrders.length,
      partialEntries: trades.filter((trade) =>
        trade.result.orders.some(
          (order) =>
            order.side === OrderSide.Buy &&
            order.outcome.status === 'FILLED' &&
            BigInt(order.outcome.fill.quantityAtoms) < BigInt(trade.result.requestedEntryQuantityAtoms),
        ),
      ).length,
      closedEpisodes: state.portfolio.episodes.length,
      turnoverMicros: String(fills.reduce((sum, fill) => sum + BigInt(fill.notionalMicros), 0n)),
      dailyTurnoverMicros: Object.fromEntries([...state.days].map(([date, day]) => [date, String(day.turnover)])),
      executionFeesMicros: state.portfolio.ledger.executionFeesMicros,
      knownInferenceCostMicros: String(state.inferenceMicros),
      knownOperatingCostMicros: String(state.operatingMicros),
      unknownInferenceAllocations: state.unknownInference,
      unknownOperatingAllocations: state.unknownOperating,
      netExecutionPnlMicros: pnl,
      netAfterInferenceMicros:
        pnl === null || state.unknownInference > 0 ? null : String(BigInt(pnl) - state.inferenceMicros),
      netAfterAllCostsMicros:
        pnl === null || !allCostsKnown ? null : String(BigInt(pnl) - state.inferenceMicros - state.operatingMicros),
      maximumDrawdownAfterKnownCostsMicros: String(state.maximumDrawdownMicros),
      maximumDrawdownAfterAllCostsMicros:
        allCostsKnown && state.missingMarks === 0 && executionComplete ? String(state.maximumDrawdownMicros) : null,
      missingMarks: state.missingMarks,
      residualPositions: state.portfolio.ledger.positions,
      executionComplete,
    },
    problems: state.problems,
  }
}

/** A net-dollar headline requires the complete valuation/risk path, not only a flat final cash balance. */
export const capitalNetDifference = (
  evidenceComplete: boolean,
  arms: readonly ReturnType<typeof finishCapitalState>[],
): string | null => {
  const baseline = arms.find((arm) => arm.arm === CapitalArm.Baseline)
  const candidate = arms.find((arm) => arm.arm === CapitalArm.CostHurdle)
  if (
    !evidenceComplete ||
    arms.length !== 2 ||
    baseline === undefined ||
    candidate === undefined ||
    arms.some((arm) => arm.metrics.missingMarks !== 0 || arm.metrics.maximumDrawdownAfterAllCostsMicros === null) ||
    baseline.metrics.netAfterAllCostsMicros === null ||
    candidate.metrics.netAfterAllCostsMicros === null
  )
    return null
  return String(BigInt(candidate.metrics.netAfterAllCostsMicros) - BigInt(baseline.metrics.netAfterAllCostsMicros))
}
