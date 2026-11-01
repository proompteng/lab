import { equityFeatureSegmentStartMs } from '../equity-hours'
import { jevMarketForSymbol, jevBenchmarkSymbol } from './markets'
import { exchangeSessions, isContinuousMarket, type MarketHours } from '../market-hours'

import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import { utcInstantFromEpochMillis } from '../time'
import type { JevProtocol } from './protocol'

export const jevSignalIntervalMs = 60_000

export const jevSignalWindowEndMs = (observedAtMs: number, protocol: Pick<JevProtocol, 'decisionDelaySeconds'>) =>
  Math.floor((observedAtMs - protocol.decisionDelaySeconds * 1000) / jevSignalIntervalMs) * jevSignalIntervalMs

export const jevSignalDueAtMs = (windowEndMs: number, protocol: Pick<JevProtocol, 'decisionDelaySeconds'>) =>
  windowEndMs + protocol.decisionDelaySeconds * 1000

export const jevFirstSignalDueMs = (openMs: number, protocol: Pick<JevProtocol, 'decisionDelaySeconds'>) =>
  jevSignalDueAtMs((Math.floor(openMs / jevSignalIntervalMs) + 1) * jevSignalIntervalMs, protocol)

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
  const rangeEndMs = jevSignalWindowEndMs(input.observedAtMs, protocol)
  return {
    sessionDate: input.sessionDate,
    calendar: input.calendar,
    observedAt: utcInstantFromEpochMillis(input.observedAtMs),
    rangeStartAt: utcInstantFromEpochMillis(
      jevHistoryStartMs(
        input.calendar,
        input.sessionDate,
        rangeEndMs,
        isContinuousMarket(input.calendar) ? protocol.lookbackMinutes.crypto : protocol.lookbackMinutes.equity,
      ),
    ),
    rangeEndAt: utcInstantFromEpochMillis(rangeEndMs),
    universeId: market.universeId,
    universeSymbolHash: market.universeSymbolHash,
    universe: market.universe,
    symbols: [...candidates].sort(),
    candidateSymbols: candidates,
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

/** Independent momentum qualification requires its actual reference series. */
export const makeMomentumEntryQuery = (input: Parameters<typeof makeJevEntryQuery>[0]): IntradaySnapshotQuery => {
  const query = makeJevEntryQuery(input)
  const market = jevMarketForSymbol(input.candidates[0] ?? 'SPY')
  const benchmarkSymbols = [...new Set(input.candidates.map(jevBenchmarkSymbol))].sort()
  return {
    ...query,
    symbols: [...new Set([...input.candidates, ...benchmarkSymbols])].sort(),
    ...('benchmarkEvidencePolicy' in market
      ? { benchmarkEvidencePolicy: market.benchmarkEvidencePolicy, benchmarkSymbols }
      : {}),
  }
}
