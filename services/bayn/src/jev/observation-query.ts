import { equityFeatureSegmentStartMs } from '../equity-hours'
import { jevMarketForSymbol, jevBenchmarkSymbol } from './markets'
import { exchangeSessions, isContinuousMarket, type MarketHours } from '../market-hours'

import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import { utcInstantFromEpochMillis } from '../time'
import type { JevProtocol } from './protocol'

export const jevHistoryStartMs = (
  calendar: MarketHours,
  sessionDate: string,
  endMs: number,
  maximumMinutes: number,
) => {
  const lowerBound = endMs - maximumMinutes * 60_000
  if (isContinuousMarket(calendar)) return lowerBound
  const session = exchangeSessions(calendar).find((entry) => entry.date === sessionDate)
  return session === undefined
    ? lowerBound
    : Math.max(lowerBound, Date.parse(session.openAt), equityFeatureSegmentStartMs(endMs - 1))
}

export const makeJevEntryQuery = (input: {
  readonly protocol: JevProtocol
  readonly calendar: MarketHours
  readonly sessionDate: IntradaySnapshotQuery['sessionDate']
  readonly observedAtMs: number
  readonly candidates: readonly string[]
}): IntradaySnapshotQuery => {
  const { protocol, candidates } = input
  const market = jevMarketForSymbol(candidates[0] ?? 'SPY')
  const rangeEndMs = Math.floor((input.observedAtMs - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
  return {
    sessionDate: input.sessionDate,
    calendar: input.calendar,
    observedAt: utcInstantFromEpochMillis(input.observedAtMs),
    rangeStartAt: utcInstantFromEpochMillis(
      jevHistoryStartMs(input.calendar, input.sessionDate, rangeEndMs, protocol.lookbackMinutes),
    ),
    rangeEndAt: utcInstantFromEpochMillis(rangeEndMs),
    universeId: market.universeId,
    universeSymbolHash: market.universeSymbolHash,
    universe: market.universe,
    symbols: [...new Set([...candidates, ...candidates.map(jevBenchmarkSymbol)])].sort(),
    candidateSymbols: candidates,
    ...('benchmarkEvidencePolicy' in market
      ? {
          benchmarkEvidencePolicy: market.benchmarkEvidencePolicy,
          benchmarkSymbols: [...new Set(candidates.map(jevBenchmarkSymbol))].sort(),
        }
      : {}),
    ...(protocol.candidateEvidencePolicy === undefined
      ? {}
      : { candidateEvidencePolicy: protocol.candidateEvidencePolicy }),
    feed: market.feed,
    delayClass: market.delayClass,
    sourceTopics: market.sourceTopics,
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
  }
}
