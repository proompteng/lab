import { Data, Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import type { AutonomousCycle } from '../cycle'
import { utcInstantFromEpochMillis } from '../time'
import type { IntradayMarketSnapshot, IntradaySnapshotQuery } from '../market-data'
import type { ExecutionMarketDataBinding } from '../shadow-decision-contract'
import type {
  IntradayMomentumProtocol,
  IntradayMomentumStrategyDefinition,
  IntradayMomentumTargetPortfolio,
} from '../strategy/intraday-momentum'
import {
  adverseQuotePrices,
  executionMarketDataBinding,
  intradayArchiveTopics,
  maximumBuyQuantities,
} from './opening-drive-decision'

const minuteMs = 60_000

export class IntradayMomentumRuntimeDecisionFailure extends Data.TaggedError('IntradayMomentumRuntimeDecisionFailure')<{
  readonly operation: 'entry-query' | 'entry-decision' | 'binding'
  readonly message: string
  readonly cause?: unknown
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
  sourceTopics: intradayArchiveTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs,
})

export const intradayMomentumEntryQuery = (
  cycle: AutonomousCycle,
  protocol: IntradayMomentumProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
): Result.Result<IntradaySnapshotQuery, IntradayMomentumRuntimeDecisionFailure> => {
  const observedEpoch = Date.parse(observedAt)
  const decisionDelayMs = protocol.decisionDelaySeconds * 1_000
  const rangeEndEpoch = Math.floor((observedEpoch - decisionDelayMs) / minuteMs) * minuteMs
  const rangeStartEpoch = rangeEndEpoch - protocol.lookbackMinutes * minuteMs
  const rangeStartAt = utcInstantFromEpochMillis(rangeStartEpoch)
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndEpoch)
  if (
    cycle.schemaVersion !== 'bayn.autonomous-cycle.v3' ||
    cycle.identity.strategyName !== 'intraday-momentum' ||
    cycle.identity.executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3' ||
    observedAt < cycle.window.submissionOpenAt ||
    observedAt >= cycle.window.submissionCutoffAt ||
    rangeStartAt < cycle.window.executionOpenAt ||
    rangeEndAt < cycle.window.submissionOpenAt ||
    rangeEndAt > cycle.window.submissionCutoffAt ||
    observedEpoch < rangeEndEpoch + decisionDelayMs
  ) {
    return Result.fail(failure('entry-query', 'cycle does not admit a complete rolling intraday snapshot at this time'))
  }
  return Result.succeed(snapshotQuery(cycle, protocol, calendar, rangeStartAt, rangeEndAt, observedAt, decisionDelayMs))
}

export const intradayMomentumCloseQuery = (
  cycle: AutonomousCycle,
  protocol: IntradayMomentumProtocol,
  calendar: MarketCalendarObservation,
  observedAt: string,
  symbols: readonly string[],
): Result.Result<IntradaySnapshotQuery, IntradayMomentumRuntimeDecisionFailure> => {
  const observedEpoch = Date.parse(observedAt)
  const rangeEndEpoch = Math.floor(observedEpoch / minuteMs) * minuteMs
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndEpoch)
  const rangeStartAt = utcInstantFromEpochMillis(rangeEndEpoch - minuteMs)
  if (
    cycle.identity.strategyName !== 'intraday-momentum' ||
    rangeStartAt < cycle.window.executionOpenAt ||
    rangeEndAt >= cycle.window.executionCloseAt ||
    observedAt <= rangeEndAt
  ) {
    return Result.fail(failure('entry-query', 'cycle does not admit a complete intraday close snapshot at this time'))
  }
  return Result.succeed(snapshotQuery(cycle, protocol, calendar, rangeStartAt, rangeEndAt, observedAt, 0, symbols))
}

export type IntradayMomentumEntryDisposition = 'AWAIT_SIGNAL' | 'EXECUTE' | 'NO_TRADE'

export const intradayMomentumEntryDisposition = (
  decision: IntradayMomentumTargetPortfolio,
  submissionCutoffAt: string,
  finalizationHeadroomMs: number,
): IntradayMomentumEntryDisposition => {
  if (decision.selectedSymbols.length > 0) return 'EXECUTE'
  const remainingMs = Date.parse(submissionCutoffAt) - Date.parse(decision.observedAt)
  return remainingMs > finalizationHeadroomMs ? 'AWAIT_SIGNAL' : 'NO_TRADE'
}

export interface CompiledIntradayMomentumDecision {
  readonly decision: IntradayMomentumTargetPortfolio
  readonly priceMicros: Readonly<Record<string, string>>
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
  readonly maximumBuyQuantityMicros: Readonly<Record<string, string>>
  readonly executionMarketData: ExecutionMarketDataBinding
}

export const compileIntradayMomentumDecision = (
  definition: IntradayMomentumStrategyDefinition,
  cycle: AutonomousCycle,
  snapshot: IntradayMarketSnapshot,
): Result.Result<CompiledIntradayMomentumDecision, IntradayMomentumRuntimeDecisionFailure> =>
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
      const binding = yield* executionMarketDataBinding(snapshot)
      return {
        decision,
        priceMicros: quotePrices.askPriceMicros,
        ...quotePrices,
        maximumBuyQuantityMicros,
        executionMarketData: binding,
      }
    }),
    (cause) => failure('entry-decision', 'intraday-momentum strategy rejected its verified runtime snapshot', cause),
  )
