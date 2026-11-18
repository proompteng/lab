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
import {
  intradaySourceTopics,
  intradayStreamingContract,
  intradayUniverse,
  currentEquityUniverse,
  sp100EntrySymbols,
} from '../strategy/intraday-market'
import type { AutonomousCycle } from '../cycle/model'

export const retainedEquityMarketProfile = Object.freeze({
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
export const currentEquityMarketProfile = Object.freeze({
  ...retainedEquityMarketProfile,
  universeId: currentEquityUniverse.id,
  universeSymbolHash: currentEquityUniverse.symbolHash,
  universe: currentEquityUniverse.symbols,
  candidateSymbols: sp100EntrySymbols,
})
export const equityMarketProfile = retainedEquityMarketProfile
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
export const jevMarketProfiles = Object.freeze([retainedEquityMarketProfile, cryptoMarketProfile])
export type JevMarketProfile =
  | typeof retainedEquityMarketProfile
  | typeof currentEquityMarketProfile
  | typeof cryptoMarketProfile
export const jevUniverse = Object.freeze(jevMarketProfiles.flatMap((profile) => profile.universe).sort())
export const jevCandidateSymbols = Object.freeze(
  jevMarketProfiles.flatMap((profile) => profile.candidateSymbols).sort(),
)
export const currentJevMarketProfiles = Object.freeze([currentEquityMarketProfile, cryptoMarketProfile])
export const currentJevUniverse = Object.freeze(currentJevMarketProfiles.flatMap((profile) => profile.universe).sort())
export const currentJevCandidateSymbols = Object.freeze(
  currentJevMarketProfiles.flatMap((profile) => profile.candidateSymbols).sort(),
)

const profilesHash = Result.getOrThrow(canonicalHashV1Result(jevMarketProfiles))
export const JevMarketProfilesSchema = Schema.declare<readonly JevMarketProfile[]>(
  (input): input is readonly JevMarketProfile[] => {
    const hash = canonicalHashV1Result(input)
    return Result.isSuccess(hash) && hash.success === profilesHash
  },
)
const currentProfilesHash = Result.getOrThrow(canonicalHashV1Result(currentJevMarketProfiles))
export const CurrentJevMarketProfilesSchema = Schema.declare<readonly JevMarketProfile[]>(
  (input): input is readonly JevMarketProfile[] => {
    const hash = canonicalHashV1Result(input)
    return Result.isSuccess(hash) && hash.success === currentProfilesHash
  },
)

export const jevMarketForSymbol = (symbol: string, sourceUniverseId?: string): JevMarketProfile =>
  instrumentMarket(symbol) === MarketKind.Crypto
    ? cryptoMarketProfile
    : sourceUniverseId === currentEquityMarketProfile.universeId
      ? currentEquityMarketProfile
      : retainedEquityMarketProfile
export const jevMarketForCycle = (cycle: {
  readonly window: Pick<AutonomousCycle['window'], 'executionCalendarSchemaVersion'>
}): JevMarketProfile =>
  cycle.window.executionCalendarSchemaVersion === 'bayn.continuous-market-hours.v1'
    ? cryptoMarketProfile
    : currentEquityMarketProfile
export const jevMarketForFeed = (feed: string, sourceUniverseId?: string): JevMarketProfile =>
  feed === 'us'
    ? cryptoMarketProfile
    : sourceUniverseId === currentEquityMarketProfile.universeId
      ? currentEquityMarketProfile
      : retainedEquityMarketProfile
export const jevBenchmarkSymbol = (symbol: string): string =>
  instrumentMarket(symbol) === MarketKind.Equity ? 'SPY' : symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD'
export const jevCycleCandidates = (
  cycle: { readonly window: Pick<AutonomousCycle['window'], 'executionCalendarSchemaVersion'> },
  allowed: readonly string[],
  profiles?: readonly JevMarketProfile[],
): readonly string[] => {
  const selected = jevMarketForCycle(cycle)
  const market = profiles?.find((profile) => profile.market === selected.market) ?? selected
  return allowed.filter((symbol) => market.candidateSymbols.some((candidate) => candidate === symbol))
}
