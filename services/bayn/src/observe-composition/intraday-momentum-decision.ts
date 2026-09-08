import { Data, Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import type { AutonomousCycle } from '../cycle'
import { utcInstantFromEpochMillis } from '../time'
import {
  IntradaySnapshotPurpose,
  persistIntradaySnapshotRows,
  type IntradayMarketSnapshot,
  type IntradaySnapshotQuery,
  type PersistedIntradaySnapshotRows,
} from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import type { ExecutionMarketDataBinding } from '../shadow-decision-contract'
import { MICROS } from '../execution-model'
import {
  intradayMomentumPlanningTargetWeights,
  type IntradayMomentumStrategyDefinition,
  type IntradayMomentumTargetPortfolio,
} from '../strategy/intraday-momentum/model'
import { intradayMomentumSnapshotSymbols, type IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import { numberToMicros } from '../strategy/execution-model/fixed-point'
import { adverseQuotePrices, executionMarketDataBinding, maximumBuyQuantities } from './intraday-market-data'

const minuteMs = 60_000

export class IntradayMomentumRuntimeDecisionFailure extends Data.TaggedError('IntradayMomentumRuntimeDecisionFailure')<{
  readonly operation: 'entry-query' | 'entry-decision' | 'binding'
  readonly message: string
  readonly cause?: unknown
}> {}

export class IntradayMomentumEntryAwaitingSnapshot extends Data.TaggedError('IntradayMomentumEntryAwaitingSnapshot')<{
  readonly message: string
  readonly availableAt?: string
}> {}

export class IntradayMomentumCloseAwaitingSnapshot extends Data.TaggedError('IntradayMomentumCloseAwaitingSnapshot')<{
  readonly message: string
}> {}

const failure = (
  operation: IntradayMomentumRuntimeDecisionFailure['operation'],
  message: string,
  cause?: unknown,
): IntradayMomentumRuntimeDecisionFailure => new IntradayMomentumRuntimeDecisionFailure({ operation, message, cause })

const snapshotQuery = (
  cycle: AutonomousCycle,
  protocol: IntradayMomentumProtocol,
  calendar: MarketCalendarObservation,
  rangeStartAt: string,
  rangeEndAt: string,
  observedAt: string,
  minimumWatermarkLagMs: number,
  symbols?: readonly string[],
): IntradaySnapshotQuery => ({
  sessionDate: cycle.identity.executionSessionDate,
  calendar,
  rangeStartAt,
  rangeEndAt,
  observedAt,
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  ...(symbols === undefined ? {} : { symbols }),
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: protocol.sourceTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs,
})

export const intradayMomentumEntryQuery = (
  cycle: AutonomousCycle,
  protocol: IntradayMomentumProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
): Result.Result<
  IntradaySnapshotQuery,
  IntradayMomentumEntryAwaitingSnapshot | IntradayMomentumRuntimeDecisionFailure
> => {
  const observedEpoch = Date.parse(observedAt)
  const decisionDelayMs = protocol.decisionDelaySeconds * 1_000
  const rangeEndEpoch = Math.floor((observedEpoch - decisionDelayMs) / minuteMs) * minuteMs
  const rangeStartEpoch = rangeEndEpoch - protocol.lookbackMinutes * minuteMs
  const rangeStartAt = utcInstantFromEpochMillis(rangeStartEpoch)
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndEpoch)
  const firstEligibleRangeEndEpoch = Math.ceil(Date.parse(cycle.window.submissionOpenAt) / minuteMs) * minuteMs
  const availableAt = utcInstantFromEpochMillis(firstEligibleRangeEndEpoch + decisionDelayMs)
  if (
    cycle.schemaVersion !== 'bayn.autonomous-cycle.v3' ||
    cycle.identity.strategyName !== 'intraday-momentum' ||
    cycle.identity.executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3' ||
    observedAt < cycle.window.submissionOpenAt ||
    observedAt >= cycle.window.submissionCutoffAt ||
    rangeStartAt < cycle.window.executionOpenAt ||
    rangeEndAt > cycle.window.submissionCutoffAt ||
    observedEpoch < rangeEndEpoch + decisionDelayMs
  ) {
    return Result.fail(failure('entry-query', 'cycle does not admit a complete rolling intraday snapshot at this time'))
  }
  if (rangeEndAt < cycle.window.submissionOpenAt) {
    return Result.fail(
      new IntradayMomentumEntryAwaitingSnapshot({
        message: 'full-session intraday entry is waiting for its first decision-delay-complete snapshot',
        availableAt,
      }),
    )
  }
  return Result.succeed(
    snapshotQuery(
      cycle,
      protocol,
      calendar,
      rangeStartAt,
      rangeEndAt,
      observedAt,
      decisionDelayMs,
      intradayMomentumSnapshotSymbols(protocol),
    ),
  )
}

export const intradayMomentumPricingQuery = (
  cycle: AutonomousCycle,
  protocol: IntradayMomentumProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
  decisionRangeEndAt: string,
  symbols: readonly string[],
): Result.Result<
  IntradaySnapshotQuery,
  IntradayMomentumCloseAwaitingSnapshot | IntradayMomentumRuntimeDecisionFailure
> => {
  const canonicalSymbols = [...new Set(symbols)].sort()
  const rangeEndEpoch = Date.parse(decisionRangeEndAt)
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndEpoch)
  const rangeStartAt = utcInstantFromEpochMillis(rangeEndEpoch - minuteMs)
  if (canonicalSymbols.length === 0 || canonicalSymbols.some((symbol) => !protocol.universe.includes(symbol))) {
    return Result.fail(failure('entry-query', 'existing position is outside the strategy source universe'))
  }
  if (
    cycle.identity.strategyName !== 'intraday-momentum' ||
    rangeStartAt < cycle.window.executionOpenAt ||
    rangeEndAt >= cycle.window.executionCloseAt
  ) {
    return Result.fail(failure('entry-query', 'cycle does not admit a complete intraday close snapshot at this time'))
  }
  if (observedAt <= rangeEndAt) {
    return Result.fail(
      new IntradayMomentumCloseAwaitingSnapshot({
        message: 'intraday close is waiting for the current minute to become complete',
      }),
    )
  }
  return Result.succeed({
    ...snapshotQuery(cycle, protocol, calendar, rangeStartAt, rangeEndAt, observedAt, 0, canonicalSymbols),
    purpose: IntradaySnapshotPurpose.EntryPricing,
  })
}

export const intradayMomentumCloseQuery = (
  cycle: AutonomousCycle,
  protocol: IntradayMomentumProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
  symbols: readonly string[],
): Result.Result<
  IntradaySnapshotQuery,
  IntradayMomentumCloseAwaitingSnapshot | IntradayMomentumRuntimeDecisionFailure
> =>
  Result.map(
    intradayMomentumPricingQuery(
      cycle,
      protocol,
      calendar,
      observedAt,
      utcInstantFromEpochMillis(Math.floor(Date.parse(observedAt) / minuteMs) * minuteMs),
      symbols,
    ),
    (query) => ({ ...query, purpose: IntradaySnapshotPurpose.Liquidation }),
  )

export type IntradayMomentumEntryDisposition = 'AWAIT_SIGNAL' | 'EXECUTE' | 'NO_TRADE'

export const intradayMomentumEntryDisposition = (
  decision: IntradayMomentumTargetPortfolio,
  positionsRequireContainment: boolean,
  submissionCutoffAt: string,
  finalizationHeadroomMs: number,
): IntradayMomentumEntryDisposition => {
  if (decision.selectedSymbols.length > 0 || positionsRequireContainment) return 'EXECUTE'
  const remainingMs = Date.parse(submissionCutoffAt) - Date.parse(decision.observedAt)
  return remainingMs > finalizationHeadroomMs ? 'AWAIT_SIGNAL' : 'NO_TRADE'
}

export interface CompiledIntradayMomentumDecision {
  readonly decision: IntradayMomentumTargetPortfolio
  readonly decisionMarketDataRows: PersistedIntradaySnapshotRows
  readonly priceMicros: Readonly<Record<string, string>>
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
  readonly maximumBuyQuantityMicros: Readonly<Record<string, string>>
  readonly maximumSellQuantityMicros: Readonly<Record<string, string>>
  readonly planningTargetWeights: Readonly<Record<string, number>>
  readonly decisionMarketData?: ExecutionMarketDataBinding
  readonly executionMarketData: ExecutionMarketDataBinding
}

export const maximumSellQuantities = (
  snapshot: { readonly latestQuotes: Readonly<Record<string, { readonly bidSize: number }>> },
  positions: readonly { readonly symbol: string; readonly quantityMicros: string }[],
  targetWeights: Readonly<Record<string, number>>,
): Result.Result<Readonly<Record<string, string>>, IntradayMomentumRuntimeDecisionFailure> => {
  const quantities: Record<string, string> = Object.fromEntries(
    Object.keys(targetWeights)
      .sort()
      .map((symbol) => [symbol, '0']),
  )
  for (const { symbol, quantityMicros } of positions) {
    const heldQuantity = BigInt(quantityMicros)
    if (heldQuantity <= 0n) continue
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('entry-decision', `held long for ${symbol} has no verified pricing quote`))
    }
    const bidQuantity = numberToMicros(quote.bidSize, `entry bid size for ${symbol}`)
    if (Result.isFailure(bidQuantity)) {
      return Result.fail(
        failure(
          'entry-decision',
          `entry bid size for ${symbol} is outside the exact quantity domain`,
          bidQuantity.failure,
        ),
      )
    }
    quantities[symbol] = ((bidQuantity.success / MICROS) * MICROS).toString()
  }
  return Result.succeed(Object.freeze(quantities))
}

export const evaluateIntradayMomentumDecision = (
  definition: IntradayMomentumStrategyDefinition,
  cycle: AutonomousCycle,
  decisionSnapshot: ArchiveVerifiedIntradayMarketSnapshot,
): Result.Result<
  IntradayMomentumTargetPortfolio,
  IntradayMomentumEntryAwaitingSnapshot | IntradayMomentumRuntimeDecisionFailure
> =>
  Result.mapError(
    definition.decide({
      market: {
        snapshot: decisionSnapshot,
        session: {
          sessionDate: cycle.identity.executionSessionDate,
          openAt: cycle.window.executionOpenAt,
          closeAt: cycle.window.executionCloseAt,
          calendarHash: cycle.window.executionCalendarHash,
        },
      },
    }),
    (cause) =>
      cause.reason === 'snapshot-coverage' &&
      cause.message === 'intraday symbol lacks the complete rolling lookback baseline'
        ? new IntradayMomentumEntryAwaitingSnapshot({ message: cause.message })
        : failure('entry-decision', 'intraday-momentum strategy rejected its verified runtime snapshot', cause),
  )

export const compileIntradayMomentumDecision = (
  decision: IntradayMomentumTargetPortfolio,
  decisionSnapshot: IntradayMarketSnapshot,
  pricingSnapshot: IntradayMarketSnapshot,
  heldPositions: readonly { readonly symbol: string; readonly quantityMicros: string }[] = [],
): Result.Result<CompiledIntradayMomentumDecision, IntradayMomentumRuntimeDecisionFailure> =>
  Result.mapError(
    Result.gen(function* () {
      const heldSymbols = heldPositions.map((position) => position.symbol)
      const planningTargetWeights = intradayMomentumPlanningTargetWeights(decision, heldSymbols)
      const planningSymbols = Object.keys(planningTargetWeights)
      const maximumSellQuantityMicros = yield* maximumSellQuantities(
        pricingSnapshot,
        heldPositions,
        planningTargetWeights,
      )
      const maximumBuyQuantityMicros = yield* maximumBuyQuantities(pricingSnapshot, planningTargetWeights)
      const quotePrices = yield* adverseQuotePrices(pricingSnapshot, planningSymbols)
      const decisionMarketDataRows = yield* persistIntradaySnapshotRows(decisionSnapshot)
      const decisionBinding = yield* executionMarketDataBinding(decisionSnapshot)
      const usesDedicatedPricing = pricingSnapshot.manifest.purpose === IntradaySnapshotPurpose.EntryPricing
      const executionBinding = usesDedicatedPricing
        ? yield* executionMarketDataBinding(pricingSnapshot)
        : decisionBinding
      return {
        decision,
        decisionMarketDataRows,
        priceMicros: quotePrices.askPriceMicros,
        ...quotePrices,
        maximumBuyQuantityMicros,
        maximumSellQuantityMicros,
        planningTargetWeights,
        ...(usesDedicatedPricing ? { decisionMarketData: decisionBinding } : {}),
        executionMarketData: executionBinding,
      }
    }),
    (cause) => failure('entry-decision', 'intraday-momentum execution evidence could not be compiled', cause),
  )
