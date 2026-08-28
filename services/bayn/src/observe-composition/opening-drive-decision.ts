import { Data, Effect, Result, Schema } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import { quantizeAlpacaLimitPriceMicros } from '../broker/alpaca-price'
import type { AutonomousCycle } from '../cycle'
import type { OperationalError } from '../errors'
import { MICROS, numberToMicros } from '../execution-model'
import { utcInstantFromEpochMillis } from '../time'
import {
  intradayAgeNanos,
  millisecondsAsNanos,
  type IntradayMarketDataService,
  type IntradayMarketSnapshot,
  type IntradaySnapshotQuery,
} from '../market-data'
import { ExecutionMarketDataBindingSchema, type ExecutionMarketDataBinding } from '../shadow-decision-contract'
import { strictParseOptions } from '../schemas'
import type {
  OpeningDriveProtocol,
  OpeningDriveRejectionReason,
  OpeningDriveStrategyDefinition,
  OpeningDriveTargetPortfolio,
} from '../strategy/opening-drive'

export const intradayArchiveTopics = Object.freeze({
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
})

export class OpeningDriveRuntimeDecisionFailure extends Data.TaggedError('OpeningDriveRuntimeDecisionFailure')<{
  readonly operation:
    | 'entry-query'
    | 'entry-decision'
    | 'close-query'
    | 'close-quote-not-ready'
    | 'close-prices'
    | 'binding'
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (
  operation: OpeningDriveRuntimeDecisionFailure['operation'],
  message: string,
  cause?: unknown,
): OpeningDriveRuntimeDecisionFailure => new OpeningDriveRuntimeDecisionFailure({ operation, message, cause })

const commonQuery = (
  protocol: OpeningDriveProtocol,
  sessionDate: IntradaySnapshotQuery['sessionDate'],
  calendar: MarketCalendarObservation,
  rangeStartAt: string,
  rangeEndAt: string,
  observedAt: string,
  minimumWatermarkLagMs: number,
): IntradaySnapshotQuery => ({
  sessionDate,
  calendar,
  rangeStartAt,
  rangeEndAt,
  observedAt,
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: intradayArchiveTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs,
})

export const openingDriveEntryQuery = (
  cycle: AutonomousCycle,
  protocol: OpeningDriveProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
): Result.Result<IntradaySnapshotQuery, OpeningDriveRuntimeDecisionFailure> => {
  const rangeEndAt = utcInstantFromEpochMillis(
    Date.parse(cycle.window.executionOpenAt) + protocol.openingRangeMinutes * 60_000,
  )
  const expectedDecisionAt = utcInstantFromEpochMillis(Date.parse(rangeEndAt) + protocol.decisionDelaySeconds * 1_000)
  if (
    (cycle.schemaVersion !== 'bayn.autonomous-cycle.v2' && cycle.schemaVersion !== 'bayn.autonomous-cycle.v3') ||
    cycle.identity.strategyName !== 'opening-drive-momentum' ||
    cycle.window.submissionOpenAt !== expectedDecisionAt ||
    observedAt < expectedDecisionAt ||
    observedAt >= cycle.window.submissionCutoffAt
  ) {
    return Result.fail(failure('entry-query', 'cycle does not admit an opening-drive snapshot at this time'))
  }
  return Result.succeed(
    commonQuery(
      protocol,
      cycle.identity.executionSessionDate,
      calendar,
      cycle.window.executionOpenAt,
      rangeEndAt,
      observedAt,
      protocol.decisionDelaySeconds * 1_000,
    ),
  )
}

export const openingDriveCloseQuery = (
  cycle: AutonomousCycle,
  protocol: OpeningDriveProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
  symbols: readonly string[],
): Result.Result<IntradaySnapshotQuery, OpeningDriveRuntimeDecisionFailure> => {
  const observedEpoch = Date.parse(observedAt)
  const rangeEndEpoch = Math.floor(observedEpoch / 60_000) * 60_000
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndEpoch)
  const rangeStartAt = utcInstantFromEpochMillis(rangeEndEpoch - 60_000)
  if (
    cycle.identity.strategyName !== 'opening-drive-momentum' ||
    rangeStartAt < cycle.window.executionOpenAt ||
    rangeEndAt >= cycle.window.executionCloseAt ||
    observedAt <= rangeEndAt
  ) {
    return Result.fail(failure('close-query', 'cycle does not admit a complete intraday close snapshot at this time'))
  }
  return Result.succeed({
    ...commonQuery(protocol, cycle.identity.executionSessionDate, calendar, rangeStartAt, rangeEndAt, observedAt, 0),
    symbols: [...new Set(symbols)].sort(),
    purpose: 'LIQUIDATION',
  })
}

export const loadIntradaySnapshot = (
  marketData: IntradayMarketDataService,
  query: IntradaySnapshotQuery,
): Effect.Effect<IntradayMarketSnapshot, OperationalError> =>
  marketData
    .captureVersion(query)
    .pipe(Effect.flatMap((archiveWatermarks) => marketData.loadSnapshot({ ...query, archiveWatermarks })))

const decodeExecutionMarketDataBinding = Schema.decodeUnknownResult(
  ExecutionMarketDataBindingSchema,
  strictParseOptions,
)

export const executionMarketDataBinding = (
  snapshot: IntradayMarketSnapshot,
): Result.Result<ExecutionMarketDataBinding, OpeningDriveRuntimeDecisionFailure> =>
  Result.mapError(
    decodeExecutionMarketDataBinding({
      schemaVersion:
        snapshot.manifest.universe === undefined
          ? 'bayn.execution-market-data-binding.v1'
          : 'bayn.execution-market-data-binding.v2',
      snapshotSchemaVersion: snapshot.manifest.schemaVersion,
      sessionDate: snapshot.manifest.sessionDate,
      calendar: snapshot.manifest.calendar,
      rangeStartAt: snapshot.manifest.rangeStartAt,
      rangeEndAt: snapshot.manifest.rangeEndAt,
      observedAt: snapshot.manifest.observedAt,
      universeId: snapshot.manifest.universeId,
      universeSymbolHash: snapshot.manifest.universeSymbolHash,
      ...(snapshot.manifest.universe === undefined ? {} : { universe: snapshot.manifest.universe }),
      symbols: snapshot.manifest.symbols,
      ...(snapshot.manifest.purpose === undefined ? {} : { purpose: snapshot.manifest.purpose }),
      feed: snapshot.manifest.feed,
      delayClass: snapshot.manifest.delayClass,
      sourceTopics: snapshot.manifest.sourceTopics,
      archiveWatermarks: snapshot.manifest.archiveWatermarks,
      maximumQuoteAgeMs: snapshot.manifest.maximumQuoteAgeMs,
      minimumWatermarkLagMs: snapshot.manifest.minimumWatermarkLagMs,
      barCount: snapshot.manifest.barCount,
      quoteCount: snapshot.manifest.quoteCount,
      tradeCount: snapshot.manifest.tradeCount,
      barsContentHash: snapshot.manifest.barsContentHash,
      quotesContentHash: snapshot.manifest.quotesContentHash,
      tradesContentHash: snapshot.manifest.tradesContentHash,
      lineage: snapshot.manifest.lineage,
      contentHash: snapshot.manifest.contentHash,
      snapshotId: snapshot.manifest.snapshotId,
    }),
    (cause) => failure('binding', 'verified intraday snapshot cannot form an execution binding', cause),
  )

export interface CompiledOpeningDriveDecision {
  readonly decision: OpeningDriveTargetPortfolio
  /** Legacy allocation-cap input remains conservatively valued at the verified ask. */
  readonly priceMicros: Readonly<Record<string, string>>
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
  readonly maximumBuyQuantityMicros: Readonly<Record<string, string>>
  readonly executionMarketData: ExecutionMarketDataBinding
}

export interface AdverseQuotePrices {
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
}

export type OpeningDriveEntryDisposition = 'AWAIT_SIGNAL' | 'EXECUTE' | 'NO_TRADE'

const mutableEntryRejectionReasons = new Set<OpeningDriveRejectionReason>([
  'breakout',
  'displayed-liquidity',
  'opening-return',
  'range-location',
  'spread',
  'market-data-freshness',
])

/**
 * An opening range is immutable after it is finalized, while breakout, spread, and displayed liquidity can still
 * improve before the entry cutoff. Keep the cycle unbound only when at least one symbol can still become eligible and
 * another full controller pass fits before the cutoff.
 */
export const openingDriveEntryDisposition = (
  decision: OpeningDriveTargetPortfolio,
  submissionCutoffAt: string,
  finalizationHeadroomMs: number,
): OpeningDriveEntryDisposition => {
  if (decision.selectedSymbols.length > 0) return 'EXECUTE'
  const canStillBecomeEligible = decision.signals.some(
    (signal) =>
      signal.rejectionReasons.length > 0 &&
      signal.rejectionReasons.every((reason) => mutableEntryRejectionReasons.has(reason)),
  )
  if (!canStillBecomeEligible) return 'NO_TRADE'
  const remainingMs = Date.parse(submissionCutoffAt) - Date.parse(decision.observedAt)
  return remainingMs > finalizationHeadroomMs ? 'AWAIT_SIGNAL' : 'NO_TRADE'
}

export const adverseQuotePrices = (
  snapshot: IntradayMarketSnapshot,
  symbols: readonly string[],
): Result.Result<AdverseQuotePrices, OpeningDriveRuntimeDecisionFailure> => {
  const bidPriceMicros: Record<string, string> = {}
  const askPriceMicros: Record<string, string> = {}
  for (const symbol of [...new Set(symbols)].sort()) {
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('close-prices', `intraday snapshot has no verified quote for ${symbol}`))
    }
    const prices = Result.all({
      bid: numberToMicros(quote.bidPrice, `bid price for ${symbol}`),
      ask: numberToMicros(quote.askPrice, `ask price for ${symbol}`),
    })
    if (Result.isFailure(prices) || prices.success.bid <= 0n || prices.success.ask <= 0n) {
      return Result.fail(failure('close-prices', `quote for ${symbol} is outside the exact price domain`))
    }
    bidPriceMicros[symbol] = quantizeAlpacaLimitPriceMicros(prices.success.bid, 'DOWN').toString()
    askPriceMicros[symbol] = quantizeAlpacaLimitPriceMicros(prices.success.ask, 'UP').toString()
  }
  return Result.succeed({
    bidPriceMicros: Object.freeze(bidPriceMicros),
    askPriceMicros: Object.freeze(askPriceMicros),
  })
}

export const adverseClosingQuotePrices = (
  snapshot: IntradayMarketSnapshot,
  symbols: readonly string[],
): Result.Result<AdverseQuotePrices, OpeningDriveRuntimeDecisionFailure> => {
  const maximumQuoteAge = millisecondsAsNanos(snapshot.manifest.maximumQuoteAgeMs)
  for (const symbol of [...new Set(symbols)].sort()) {
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('close-quote-not-ready', `intraday snapshot has no verified quote for ${symbol}`))
    }
    const quoteAge = intradayAgeNanos(snapshot.manifest.observedAt, quote.eventAt)
    if (quoteAge < 0n || quoteAge > maximumQuoteAge) {
      return Result.fail(
        failure('close-quote-not-ready', `closing quote for ${symbol} is outside the freshness window`),
      )
    }
  }
  return adverseQuotePrices(snapshot, symbols)
}

export const requireFreshIntradayPositionQuotes = (
  snapshot: IntradayMarketSnapshot,
  positions: readonly { readonly symbol: string; readonly quantityMicros: string }[],
): Result.Result<void, OpeningDriveRuntimeDecisionFailure> => {
  const maximumQuoteAge = millisecondsAsNanos(snapshot.manifest.maximumQuoteAgeMs)
  for (const position of positions) {
    if (BigInt(position.quantityMicros) === 0n) continue
    const quote = snapshot.latestQuotes[position.symbol]
    if (quote === undefined) {
      return Result.fail(
        failure('entry-decision', `existing position ${position.symbol} has no verified entry-cycle quote`),
      )
    }
    const quoteAge = intradayAgeNanos(snapshot.manifest.observedAt, quote.eventAt)
    if (quoteAge < 0n || quoteAge > maximumQuoteAge) {
      return Result.fail(
        failure('entry-decision', `existing position ${position.symbol} has no fresh entry-cycle liquidation quote`),
      )
    }
  }
  return Result.succeed(undefined)
}

export const requireFreshOpeningDrivePositionQuotes = requireFreshIntradayPositionQuotes

export const maximumBuyQuantities = (
  snapshot: IntradayMarketSnapshot,
  targetWeights: Readonly<Record<string, number>>,
): Result.Result<Readonly<Record<string, string>>, OpeningDriveRuntimeDecisionFailure> => {
  const quantities: Record<string, string> = {}
  for (const [symbol, targetWeight] of Object.entries(targetWeights).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (targetWeight === 0) {
      quantities[symbol] = '0'
      continue
    }
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('entry-decision', `entry snapshot has no verified quote for ${symbol}`))
    }
    const quantity = numberToMicros(quote.askSize, `entry ask size for ${symbol}`)
    if (Result.isFailure(quantity)) {
      return Result.fail(
        failure(
          'entry-decision',
          `entry ask size for ${symbol} is outside the exact quantity domain`,
          quantity.failure,
        ),
      )
    }
    quantities[symbol] = ((quantity.success / MICROS) * MICROS).toString()
  }
  return Result.succeed(Object.freeze(quantities))
}

export const compileOpeningDriveDecision = (
  definition: OpeningDriveStrategyDefinition,
  cycle: AutonomousCycle,
  snapshot: IntradayMarketSnapshot,
): Result.Result<CompiledOpeningDriveDecision, OpeningDriveRuntimeDecisionFailure> =>
  Result.mapError(
    Result.gen(function* () {
      const decision = yield* definition.decide({
        market: {
          snapshot,
          session: {
            sessionDate: cycle.identity.executionSessionDate,
            openAt: cycle.window.executionOpenAt,
            closeAt: cycle.window.executionCloseAt,
            calendarHash: cycle.window.executionCalendarHash,
          },
        },
      })
      const maximumBuyQuantityMicros = yield* maximumBuyQuantities(snapshot, decision.targetWeights)
      const quotePrices = yield* adverseQuotePrices(
        snapshot,
        decision.signals.map((signal) => signal.symbol),
      )
      return {
        decision,
        priceMicros: quotePrices.askPriceMicros,
        ...quotePrices,
        maximumBuyQuantityMicros,
        executionMarketData: yield* executionMarketDataBinding(snapshot),
      }
    }),
    (cause) => failure('entry-decision', 'opening-drive strategy rejected its verified runtime snapshot', cause),
  )

export const closeBidPrices = (
  snapshot: IntradayMarketSnapshot,
  symbols: readonly string[],
): Result.Result<Readonly<Record<string, string>>, OpeningDriveRuntimeDecisionFailure> =>
  Result.map(adverseClosingQuotePrices(snapshot, symbols), (prices) => prices.bidPriceMicros)
