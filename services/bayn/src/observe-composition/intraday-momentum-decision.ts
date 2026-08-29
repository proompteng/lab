import { Data, Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import type { AutonomousCycle } from '../cycle'
import { utcInstantFromEpochMillis } from '../time'
import {
  persistIntradaySnapshotRows,
  type IntradaySnapshotQuery,
  type PersistedIntradaySnapshotRows,
} from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import type { ExecutionMarketDataBinding } from '../shadow-decision-contract'
import {
  IntradayMomentumFailure,
  type IntradayMomentumStrategyDefinition,
  type IntradayMomentumTargetPortfolio,
} from '../strategy/intraday-momentum/model'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import { adverseQuotePrices, executionMarketDataBinding, maximumBuyQuantities } from './opening-drive-decision'

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
    snapshotQuery(cycle, protocol, calendar, rangeStartAt, rangeEndAt, observedAt, decisionDelayMs, protocol.universe),
  )
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
> => {
  const observedEpoch = Date.parse(observedAt)
  const rangeEndEpoch = Math.floor(observedEpoch / minuteMs) * minuteMs
  const rangeEndAt = utcInstantFromEpochMillis(rangeEndEpoch)
  const rangeStartAt = utcInstantFromEpochMillis(rangeEndEpoch - minuteMs)
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
    ...snapshotQuery(cycle, protocol, calendar, rangeStartAt, rangeEndAt, observedAt, 0, symbols),
    purpose: 'LIQUIDATION',
  })
}

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
  readonly executionMarketData: ExecutionMarketDataBinding
}

export const compileIntradayMomentumDecision = (
  definition: IntradayMomentumStrategyDefinition,
  cycle: AutonomousCycle,
  snapshot: ArchiveVerifiedIntradayMarketSnapshot,
): Result.Result<
  CompiledIntradayMomentumDecision,
  IntradayMomentumEntryAwaitingSnapshot | IntradayMomentumRuntimeDecisionFailure
> =>
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
      const decisionMarketDataRows = yield* persistIntradaySnapshotRows(snapshot)
      const binding = yield* executionMarketDataBinding(snapshot)
      return {
        decision,
        decisionMarketDataRows,
        priceMicros: quotePrices.askPriceMicros,
        ...quotePrices,
        maximumBuyQuantityMicros,
        executionMarketData: binding,
      }
    }),
    (cause) =>
      cause instanceof IntradayMomentumFailure &&
      cause.reason === 'snapshot-coverage' &&
      cause.message === 'intraday symbol lacks the complete rolling lookback baseline'
        ? new IntradayMomentumEntryAwaitingSnapshot({ message: cause.message })
        : failure('entry-decision', 'intraday-momentum strategy rejected its verified runtime snapshot', cause),
  )
