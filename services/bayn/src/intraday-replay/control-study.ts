import { Effect, Result, Schema } from 'effect'

import { AssetStatus, type MarketCalendarObservation, type MarketCalendarSession } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { OrderSide } from '../execution/contracts'
import { numberToMicros } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type { JevProtocol } from '../jev/protocol'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import { observedQuoteAt } from '../market-data/streaming/projection'
import { constructSimulatedSnapshot, type StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import type { Policy } from '../risk'
import { IsoDateSchema, NonNegativeIntegerSchema, PositiveIntegerSchema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { BacktestInputSchema, prepareBacktest } from './backtest'
import { replayQuoteRejection } from './broker-execution-evidence'
import {
  applyControlOrder,
  controlCandidates,
  controlEntryQuantity,
  ControlPolicy,
  ControlStudyFailure,
  createControlPortfolio,
  selectControlSymbol,
  triggerControlExit,
  type ControlQuote,
} from './control-portfolio'
import { openBacktestSource, type BacktestSourceReceipt } from './source'

export const ControlStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.control-study-input.v1'),
  backtest: BacktestInputSchema,
  decisionLatencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
  repeatedTargetWeightPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(200_000)),
})

export const controlStudyDefinition = {
  schemaVersion: 'bayn.control-study-definition.v1',
  policies: {
    RETAINED_BREAKOUT_CLOSE:
      'Six retained candidates, retained breakout thresholds, 10 percent allocation, hold until the close window.',
    REPEATED_BREAKOUT:
      'Jev candidate universe and retained breakout thresholds, mechanical stop and maximum hold, repeated entries.',
    REPEATED_RELATIVE_MOMENTUM:
      'Jev candidate universe, exact positive return and benchmark-relative return, mechanical stop and maximum hold, repeated entries.',
  },
  opportunityClock:
    'Each flat portfolio evaluates every eligible completed signal window. Rank by exact relative return, then symbol. No repeated entry evaluation in a successfully observed window.',
  sizing:
    'Bayn target allocation and order/symbol/turnover bounds, whole shares, cash reserved for cumulative fees at the adverse buy limit.',
  execution:
    'Fresh decision and arrival quotes, shared native IOC execution and accounting. One entry IOC; persistent risk-reducing exit retries on the next poll.',
  limitations: [
    'DEVELOPMENT_CONTROL_PORTFOLIOS. Not the frozen matched-control acceptance experiment or a prospective qualification.',
    'No model calls or invented Jev decisions. Repeated controls use deterministic management and therefore are not management-matched to the deployed Jev strategy.',
    'The retained selection and close lifecycle do not reproduce historical persistence, reconciliation, authority, retry and market-close fallback machinery.',
    'Decision latency is a declared scenario including construction, evaluation and persistence. It is not an observed full-batch p95 measurement. Routing latency is added separately.',
    'Quote size units and impact remain uncalibrated. Source completeness and a flat simulated close do not establish executable live capacity.',
    'Missing decision or valuation evidence remains explicit and makes a session incomplete. Candidate-local exclusions remain in the decision trace.',
  ],
} as const

export interface ControlMarket {
  readonly advanceTo: (atMs: number) => Effect.Effect<void, ControlStudyFailure>
  readonly quoteAt: (symbol: string, atMs: number) => Effect.Effect<ControlQuote, ControlStudyFailure>
  readonly snapshot: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<
    | { readonly status: 'AVAILABLE'; readonly snapshot: StrategyMarketSnapshot }
    | { readonly status: 'UNAVAILABLE'; readonly cause: unknown },
    ControlStudyFailure
  >
}

const failureDetails = (cause: unknown) =>
  Result.try({
    try: () => JSON.stringify(cause),
    catch: (error) => new ControlStudyFailure({ message: 'Cannot retain control failure details', cause: error }),
  }).pipe(
    Result.flatMap((value) =>
      value === undefined
        ? Result.fail(new ControlStudyFailure({ message: 'Control failure has no serializable details' }))
        : Result.succeed(value),
    ),
  )

export const runControlSession = (input: {
  readonly policy: ControlPolicy
  readonly protocol: JevProtocol
  readonly risk: Policy
  readonly session: MarketCalendarSession
  readonly calendar: MarketCalendarObservation
  readonly openingCashMicros: string
  readonly openingPeakEquityMicros: string
  readonly dataCostMicros: string
  readonly targetWeight: number
  readonly decisionLatencyMs: number
  readonly pollIntervalMs: number
  readonly assumptions: typeof BacktestInputSchema.Type.assumptions
  readonly eligibleSymbols: ReadonlySet<string>
  readonly market: ControlMarket
}) =>
  Effect.gen(function* () {
    const { market, protocol, risk, session, assumptions } = input
    const sessionDate = yield* Schema.decodeUnknownEffect(IsoDateSchema)(session.date)
    const openMs = Date.parse(session.openAt)
    const closeMs = Date.parse(session.closeAt)
    const cutoffMs = closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000
    const warmupMs = openMs + protocol.lookbackMinutes * 60_000 + protocol.decisionDelaySeconds * 1000
    const openingCash = BigInt(input.openingCashMicros)
    const dataCost = BigInt(input.dataCostMicros)
    if (dataCost > openingCash)
      return yield* new ControlStudyFailure({ message: 'Allocated data cost exceeds available control cash' })
    let portfolio = yield* Effect.fromResult(createControlPortfolio(String(openingCash - dataCost)))
    let peakEquity = BigInt(input.openingPeakEquityMicros)
    let maximumDrawdown = 0n
    let maximumSessionLoss = dataCost
    let lastWindow = -1
    const decisions: {
      observedAt: string
      status: string
      symbol?: string
      snapshotHash?: string
      exclusions?: StrategyMarketSnapshot['manifest']['candidateExclusions']
      cause?: unknown
    }[] = []
    const orders: {
      submittedAt: string
      arrivedAt: string
      side: OrderSide
      symbol: string
      requestedQuantityMicros: string
      outcome: unknown
    }[] = []
    const marks: { observedAt: string; equityMicros: string | null; quoteHash: string | null; cause: string | null }[] =
      []
    let missingDecisions = 0
    let missingExecutionQuotes = 0
    let nextMarkMs = openMs
    const mark = (atMs: number) =>
      Effect.gen(function* () {
        const position = portfolio.ledger.positions[0]
        const quote = position === undefined ? undefined : yield* market.quoteAt(position.symbol, atMs)
        const rejection = position === undefined ? null : replayQuoteRejection(quote, position.symbol, atMs, protocol)
        if (rejection !== null) {
          marks.push({
            observedAt: utcInstantFromEpochMillis(atMs),
            equityMicros: null,
            quoteHash: quote?.recordHash ?? null,
            cause: rejection,
          })
          return
        }
        const equity =
          BigInt(portfolio.ledger.cashMicros) +
          (position !== undefined && quote !== undefined
            ? (BigInt(position.quantityMicros) * (yield* Effect.fromResult(numberToMicros(quote.value.bidPrice)))) /
              1_000_000n
            : 0n)
        if (equity > peakEquity) peakEquity = equity
        if (peakEquity - equity > maximumDrawdown) maximumDrawdown = peakEquity - equity
        if (openingCash - equity > maximumSessionLoss) maximumSessionLoss = openingCash - equity
        marks.push({
          observedAt: utcInstantFromEpochMillis(atMs),
          equityMicros: String(equity),
          quoteHash: quote?.recordHash ?? null,
          cause: null,
        })
      })
    const advanceTo = (atMs: number) =>
      Effect.gen(function* () {
        while (nextMarkMs <= atMs) {
          yield* market.advanceTo(nextMarkMs)
          yield* mark(nextMarkMs)
          nextMarkMs += 60_000
        }
        yield* market.advanceTo(atMs)
      })
    let atMs = openMs
    while (atMs < closeMs) {
      yield* advanceTo(atMs)
      const held = portfolio.ledger.positions[0]
      portfolio = yield* Effect.fromResult(
        triggerControlExit({
          portfolio,
          policy: input.policy,
          protocol,
          atMs,
          cutoffMs,
          quote: held === undefined ? undefined : yield* market.quoteAt(held.symbol, atMs),
        }),
      )
      let symbol: string | null = null
      let side = OrderSide.Buy
      if (portfolio.inventory.status === 'EXITING') {
        symbol = held?.symbol ?? null
        side = OrderSide.Sell
      } else if (portfolio.inventory.status === 'FLAT' && atMs >= warmupMs && atMs < cutoffMs) {
        const rangeEndMs = Math.floor((atMs - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
        if (rangeEndMs > lastWindow) {
          const observedAt = utcInstantFromEpochMillis(atMs)
          const candidates = controlCandidates(input.policy, protocol)
          const observed = yield* market.snapshot({
            sessionDate,
            calendar: input.calendar,
            observedAt,
            rangeStartAt: utcInstantFromEpochMillis(rangeEndMs - protocol.lookbackMinutes * 60_000),
            rangeEndAt: utcInstantFromEpochMillis(rangeEndMs),
            universeId: protocol.universeId,
            universeSymbolHash: protocol.universeSymbolHash,
            universe: protocol.universe,
            symbols: [...candidates, protocol.benchmarkSymbol].sort(),
            candidateSymbols: candidates,
            feed: protocol.feed,
            delayClass: protocol.delayClass,
            sourceTopics: protocol.sourceTopics,
            maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
            minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
          })
          if (observed.status === 'UNAVAILABLE') {
            missingDecisions += 1
            decisions.push({
              observedAt,
              status: 'UNAVAILABLE',
              cause: yield* Effect.fromResult(failureDetails(observed.cause)),
            })
          } else {
            lastWindow = rangeEndMs
            const selected = selectControlSymbol(observed.snapshot, input.policy, protocol)
            if (Result.isFailure(selected)) {
              missingDecisions += 1
              decisions.push({
                observedAt,
                status: 'UNAVAILABLE',
                cause: yield* Effect.fromResult(failureDetails(selected.failure)),
              })
            } else {
              symbol = selected.success
              decisions.push({
                observedAt,
                status: symbol === null ? 'NO_SIGNAL' : 'SELECTED',
                ...(symbol === null ? {} : { symbol }),
                snapshotHash: observed.snapshot.manifest.contentHash,
                exclusions: observed.snapshot.manifest.candidateExclusions ?? [],
              })
              atMs = Math.min(atMs + input.decisionLatencyMs, closeMs)
              yield* advanceTo(atMs)
              if (atMs >= cutoffMs || input.decisionLatencyMs > protocol.inferenceValidityMs) {
                decisions.push({ observedAt: utcInstantFromEpochMillis(atMs), status: 'DECISION_EXPIRED' })
                symbol = null
              }
            }
          }
        }
      }
      if (symbol !== null && atMs + assumptions.latencyMs < closeMs) {
        const decisionQuote = yield* market.quoteAt(symbol, atMs)
        const rejection = replayQuoteRejection(decisionQuote, symbol, atMs, protocol)
        if (rejection !== null || decisionQuote === undefined) {
          missingExecutionQuotes += 1
          decisions.push({
            observedAt: utcInstantFromEpochMillis(atMs),
            status: 'MISSING_PRICING',
            symbol,
            cause: rejection,
          })
        } else {
          const riskBlocked =
            side === OrderSide.Buy &&
            (!input.eligibleSymbols.has(symbol) ||
              openingCash - BigInt(portfolio.ledger.cashMicros) >= BigInt(risk.maxDailyLossMicros) ||
              peakEquity - BigInt(portfolio.ledger.cashMicros) >= BigInt(risk.maxDrawdownMicros))
          const quantity = riskBlocked
            ? 0n
            : side === OrderSide.Sell
              ? BigInt(held?.quantityMicros ?? '0')
              : yield* Effect.fromResult(
                  controlEntryQuantity({
                    portfolio,
                    policy: risk,
                    protocol,
                    targetWeight: input.targetWeight,
                    symbol,
                    referencePriceMicros: yield* Effect.fromResult(numberToMicros(decisionQuote.value.askPrice)),
                    atMs,
                    feeMultiplierPpm: assumptions.feeMultiplierPpm,
                  }),
                )
          if (quantity > 0n) {
            const submittedAtMs = atMs
            atMs += assumptions.latencyMs
            yield* advanceTo(atMs)
            const result = yield* Effect.fromResult(
              applyControlOrder(portfolio, {
                symbol,
                side,
                quantityMicros: quantity,
                protocol,
                assumptions,
                decisionQuote,
                arrivalQuote: yield* market.quoteAt(symbol, atMs),
                decisionAtMs: submittedAtMs,
                arrivalAtMs: atMs,
              }),
            )
            portfolio = result.portfolio
            if (result.outcome.status === 'UNRESOLVED') missingExecutionQuotes += 1
            orders.push({
              submittedAt: utcInstantFromEpochMillis(submittedAtMs),
              arrivedAt: utcInstantFromEpochMillis(atMs),
              side,
              symbol,
              requestedQuantityMicros: String(quantity),
              outcome: result.outcome,
            })
          } else
            decisions.push({ observedAt: utcInstantFromEpochMillis(atMs), status: 'RISK_OR_CAPITAL_BLOCKED', symbol })
        }
      }
      atMs = Math.min(atMs + input.pollIntervalMs, closeMs)
    }
    yield* advanceTo(closeMs)
    if (marks.at(-1)?.observedAt !== utcInstantFromEpochMillis(closeMs)) yield* mark(closeMs)
    const issues = [
      ...(missingDecisions > 0 ? ['MISSING_DECISION_DATA'] : []),
      ...(missingExecutionQuotes > 0 ? ['MISSING_EXECUTION_QUOTES'] : []),
      ...(marks.some((entry) => entry.equityMicros === null) ? ['MISSING_VALUATION'] : []),
      ...(portfolio.ledger.positions.length > 0 ? ['UNCLOSED_POSITION'] : []),
    ]
    const netPnl =
      portfolio.ledger.positions.length === 0 ? String(BigInt(portfolio.ledger.cashMicros) - openingCash) : null
    return {
      sessionDate: session.date,
      policy: input.policy,
      completion: issues.length === 0 ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
      issues,
      targetWeight: input.targetWeight,
      completedEpisodes: portfolio.episodes.length,
      filledNotionalMicros: String(portfolio.tradedNotionalMicros),
      netPnlAfterKnownCostsMicros: netPnl,
      netAfterAdditional10BpsMicros:
        netPnl === null ? null : String(BigInt(netPnl) - (portfolio.tradedNotionalMicros + 999n) / 1000n),
      executionFeesMicros: portfolio.ledger.executionFeesMicros,
      modelCostMicros: '0',
      dataCostMicros: input.dataCostMicros,
      maximumMarkedDrawdownMicros: String(maximumDrawdown),
      maximumMarkedSessionLossMicros: String(maximumSessionLoss),
      peakEquityMicros: String(peakEquity),
      missingDecisions,
      missingExecutionQuotes,
      ledger: portfolio.ledger,
      episodes: portfolio.episodes,
      decisions,
      orders,
      marks,
    }
  }).pipe(Effect.mapError((cause) => new ControlStudyFailure({ message: 'Control session failed', cause })))

export const runControlStudy = (raw: unknown, arrivalsPath: string, receipt: BacktestSourceReceipt) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(ControlStudyInputSchema, strictParseOptions)(raw)
    const prepared = yield* Effect.fromResult(prepareBacktest(input.backtest, receipt))
    if (prepared.input.cadence.pollIntervalMs > 60_000 || prepared.input.assumptions.latencyMs > 60_000)
      return yield* new ControlStudyFailure({
        message: 'Control polling and routing latency must each be at most one minute',
      })
    const risk = yield* loadQuoteBoundExecutionRiskPolicy(prepared.identity.accountId, prepared.protocol.universe)
    const firstDate = prepared.input.sessionDates[0]
    const lastDate = prepared.input.calendar.at(-1)?.date
    if (firstDate === undefined || lastDate === undefined)
      return yield* new ControlStudyFailure({ message: 'Control calendar has no boundary sessions' })
    const calendar = yield* Effect.fromResult(
      normalizeMarketCalendarResult(prepared.input.calendar, {
        start: firstDate,
        end: lastDate,
      }),
    )
    const runId = yield* Effect.fromResult(
      canonicalHashV1Result({ input, receiptHash: receipt.contentHash, definition: controlStudyDefinition, risk }),
    )
    const sessions = []
    for (const policy of Object.values(ControlPolicy)) {
      const results = yield* Effect.gen(function* () {
        const source = yield* openBacktestSource(arrivalsPath, prepared.input.source, runId, receipt)
        const market: ControlMarket = {
          advanceTo: (atMs) =>
            source.advanceTo(atMs).pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new ControlStudyFailure({ message: 'Cannot advance control source', cause })),
            ),
          quoteAt: (symbol, atMs) =>
            source.cursor.pipe(Effect.map((cursor) => observedQuoteAt(cursor.projection, symbol, atMs))),
          snapshot: (query) =>
            source.cursor.pipe(
              Effect.map((cursor) => {
                const result = constructSimulatedSnapshot(cursor, source.source, query)
                return Result.isSuccess(result)
                  ? { status: 'AVAILABLE' as const, snapshot: result.success }
                  : { status: 'UNAVAILABLE' as const, cause: result.failure }
              }),
            ),
        }
        const results = []
        let cash = prepared.input.openingCashMicros
        let peak = cash
        for (const session of prepared.sessions) {
          const result = yield* runControlSession({
            policy,
            protocol: prepared.protocol,
            risk,
            session,
            calendar,
            openingCashMicros: cash,
            openingPeakEquityMicros: peak,
            dataCostMicros: prepared.input.allocatedDataCostPerSessionMicros,
            targetWeight: policy === ControlPolicy.RetainedBreakout ? 0.1 : input.repeatedTargetWeightPpm / 1_000_000,
            decisionLatencyMs: input.decisionLatencyMs,
            pollIntervalMs: prepared.input.cadence.pollIntervalMs,
            assumptions: prepared.input.assumptions,
            eligibleSymbols: new Set(
              prepared.assets
                .filter((asset) => asset.tradable && asset.status === AssetStatus.Active)
                .map((asset) => asset.symbol),
            ),
            market,
          })
          results.push(result)
          if (result.ledger.positions.length !== 0 && session !== prepared.sessions.at(-1))
            return yield* new ControlStudyFailure({
              message: 'Cannot reset an unresolved control position between sessions',
            })
          cash = result.ledger.cashMicros
          peak = result.peakEquityMicros
        }
        yield* source.finish
        return results
      }).pipe(Effect.scoped)
      sessions.push(...results)
    }
    const report = {
      schemaVersion: 'bayn.control-study-report.v1',
      classification: 'DEVELOPMENT_CONTROL_PORTFOLIOS',
      runId,
      definition: controlStudyDefinition,
      input,
      sourceReceiptHash: receipt.contentHash,
      risk,
      sessions,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
