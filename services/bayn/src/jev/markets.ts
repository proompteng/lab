import { Result, Schema } from 'effect'

import { IntradayBenchmarkEvidencePolicy } from '../market-data/intraday/model'
import { MarketKind, instrumentMarket } from '../instruments'
import { canonicalHashV1Result, sha256 } from '../hash'
import {
  cryptoFeatureDefinitionMaterial,
  cryptoFeatureTopic,
  cryptoRawTopic,
  cryptoUniverse,
} from '../market-data/features/crypto-contract'
import { intradaySourceTopics, intradayStreamingContract, intradayUniverse } from '../strategy/intraday-market'
import type { AutonomousCycle } from '../cycle/model'
import type { JevProtocol } from './protocol'

export const equityMarketProfile = Object.freeze({
  market: MarketKind.Equity,
  maximumEntrySpreadBps: 5,
  estimatedTakerFeeBps: 0,
  universeId: intradayUniverse.id,
  universeSymbolHash: intradayUniverse.symbolHash,
  universe: intradayUniverse.symbols,
  candidateSymbols: intradayUniverse.symbols.filter((symbol) => symbol !== 'SPY'),
  feed: 'iex' as const,
  delayClass: 'real_time_exchange_only' as const,
  sourceTopics: intradaySourceTopics,
  streamingInput: intradayStreamingContract,
})
export const cryptoMarketProfile = Object.freeze({
  market: MarketKind.Crypto,
  maximumEntrySpreadBps: 25,
  estimatedTakerFeeBps: 25,
  universeId: cryptoUniverse.id,
  universeSymbolHash: sha256(cryptoUniverse.symbols.join(',')),
  universe: cryptoUniverse.symbols,
  candidateSymbols: cryptoUniverse.symbols,
  feed: 'us' as const,
  benchmarkEvidencePolicy: IntradayBenchmarkEvidencePolicy.CompletedBars,
  delayClass: 'real_time_crypto' as const,
  sourceTopics: Object.freeze({ bars: cryptoRawTopic, quotes: cryptoRawTopic, trades: cryptoRawTopic }),
  streamingInput: Object.freeze({
    featureTopic: cryptoFeatureTopic,
    requiredDefinitionId: 'dorvud.crypto-continuous-1m.v2',
    requiredDefinitionHash: Result.getOrThrow(canonicalHashV1Result(cryptoFeatureDefinitionMaterial)),
  }),
})
export const jevMarketProfiles = Object.freeze([equityMarketProfile, cryptoMarketProfile])
export type JevMarketProfile = typeof equityMarketProfile | typeof cryptoMarketProfile
export const jevUniverse = Object.freeze(jevMarketProfiles.flatMap((profile) => profile.universe).sort())
export const jevCandidateSymbols = Object.freeze(
  jevMarketProfiles.flatMap((profile) => profile.candidateSymbols).sort(),
)

const profilesHash = Result.getOrThrow(canonicalHashV1Result(jevMarketProfiles))
export const JevMarketProfilesSchema = Schema.declare<readonly JevMarketProfile[]>(
  (input): input is readonly JevMarketProfile[] => {
    const hash = canonicalHashV1Result(input)
    return Result.isSuccess(hash) && hash.success === profilesHash
  },
)

export const jevMarketForSymbol = (symbol: string): JevMarketProfile =>
  instrumentMarket(symbol) === MarketKind.Crypto ? cryptoMarketProfile : equityMarketProfile
export const jevHoldingMinutesForSymbol = (protocol: JevProtocol, symbol: string): number =>
  protocol.holdingMinutes[jevMarketForSymbol(symbol).market]
export const jevMarketForCycle = (cycle: {
  readonly window: Pick<AutonomousCycle['window'], 'executionCalendarSchemaVersion'>
}): JevMarketProfile =>
  cycle.window.executionCalendarSchemaVersion === 'bayn.continuous-market-hours.v1'
    ? cryptoMarketProfile
    : equityMarketProfile
export const jevMarketForFeed = (feed: string): JevMarketProfile =>
  feed === 'us' ? cryptoMarketProfile : equityMarketProfile
export const jevBenchmarkSymbol = (symbol: string): string =>
  instrumentMarket(symbol) === MarketKind.Equity ? 'SPY' : symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD'
export const jevCycleCandidates = (
  cycle: { readonly window: Pick<AutonomousCycle['window'], 'executionCalendarSchemaVersion'> },
  allowed: readonly string[],
): readonly string[] => {
  const market = jevMarketForCycle(cycle)
  return allowed.filter((symbol) => market.candidateSymbols.some((candidate) => candidate === symbol))
}
