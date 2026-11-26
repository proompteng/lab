import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { loadSharedJevProtocol } from '../strategy'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { makeIntradayAlphaPolicy, intradayAlphaEquityMarketProfile } from '../strategy/intraday-alpha/policy'
import {
  makeAlphaStreamingSnapshot,
  makeFlatAlphaPortfolio,
  makeTestTrailingBaseline,
} from '../strategy/intraday-alpha/test-support'
import { makeResearchStrategyBinding, ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { historicalRawArrivals } from '../testing/historical-streaming-fixture'
import { retainReplayArrivals } from '../testing/retained-replay-fixture'

const profiles = {
  COHR: { basePrice: 100, endReturnBps: -350 },
  LITE: { basePrice: 90, endReturnBps: -280 },
  SNDK: { basePrice: 60, endReturnBps: 340 },
  MU: { basePrice: 80, endReturnBps: 250 },
}

/** Synthetic, explicitly unqualified source: the baseline witness precedes this replay's first decision. */
export const alphaReplayBaselineFixture = () => {
  const protocol = Result.getOrThrow(loadSharedJevProtocol())
  const parameters = makeIntradayAlphaPolicy(protocol)
  const binding = Result.getOrThrow(
    makeResearchStrategyBinding({ engine: ResearchStrategyEngine.IntradayAlpha, parameters }),
  )
  const input = makeAlphaStreamingSnapshot({ minutesFromOpen: 120, profiles, quoteBidSize: 5000, quoteAskSize: 5000 })
  const observation = Result.getOrThrow(
    makeOwnedIntradayAlphaObservation({
      cycleId: '1'.repeat(64),
      authorityGenerationHash: '2'.repeat(64),
      protocol,
      portfolio: makeFlatAlphaPortfolio(input.observedAt, '100000000000', '400000000000', 'retained-alpha-fixture'),
      snapshot: input.snapshot,
      trailingBaseline: makeTestTrailingBaseline(),
    }),
  )
  const availableAt = new Date(Date.parse(input.observedAt) + 1).toISOString()
  const witness = {
    registrationHash: '3'.repeat(64),
    kind: 'ALPHA_OBSERVATION',
    sourceHash: observation.contentHash,
    sourceAt: input.observedAt,
    witnessedAt: availableAt,
    correct: true,
  }
  return {
    binding,
    source: {
      observationHash: observation.contentHash,
      payload: observation.payload,
      availableAt,
      witnessSourceHash: Result.getOrThrow(canonicalHashV1Result(witness)),
    },
    input,
  }
}

/** Real alpha signal, raw IEX arrivals, executable liquidity, and four independent native protective exits. */
export const alphaTradeReplayFixture = () => {
  const baseline = alphaReplayBaselineFixture()
  const input = makeAlphaStreamingSnapshot({ minutesFromOpen: 121, profiles, quoteBidSize: 5000, quoteAskSize: 5000 })
  const startMs = Date.parse(input.observedAt)
  const market = intradayAlphaEquityMarketProfile
  const initial = historicalRawArrivals(input.snapshot, startMs)
  const features = [...input.cut.projection.features.values()].flat().map((feature) => ({
    availableAtMs: feature.availableAtMs,
    record: { topic: feature.topic, partition: 0, offset: feature.offset, value: JSON.stringify(feature.value) },
  }))
  const offsets = new Map<string, bigint>()
  for (const { record } of [...initial, ...features]) {
    const key = `${record.topic}:${record.partition}`
    offsets.set(
      key,
      BigInt(record.offset) > (offsets.get(key) ?? -1n) ? BigInt(record.offset) : (offsets.get(key) ?? -1n),
    )
  }
  const quotes = Array.from({ length: 275 }, (_, index) => {
    const availableAtMs = startMs + (index + 1) * 200
    const at = new Date(availableAtMs).toISOString()
    return historicalRawArrivals(
      {
        bars: [],
        trades: [],
        quotes: input.snapshot.quotes.map((quote) => {
          const key = `${quote.sourceTopic}:${quote.sourcePartition}`
          const offset = (offsets.get(key) ?? -1n) + 1n
          offsets.set(key, offset)
          const factor =
            index < 99
              ? 1
              : ['COHR', 'LITE'].includes(quote.symbol)
                ? 1.1
                : ['MU', 'SNDK'].includes(quote.symbol)
                  ? 0.9
                  : 1
          return {
            ...quote,
            sourceOffset: String(offset),
            eventAt: at,
            ingestedAt: at,
            bidPrice: Math.round(quote.bidPrice * factor * 100) / 100,
            askPrice: Math.round(quote.askPrice * factor * 100) / 100,
            bidSize: 5000,
            askSize: 5000,
          }
        }),
      },
      availableAtMs,
    )
  }).flat()
  return {
    ...retainReplayArrivals(
      [...initial, ...features, ...quotes],
      [
        {
          universeId: market.universeId,
          universeSymbolHash: market.universeSymbolHash,
          symbols: market.universe,
          topics: { ...market.sourceTopics, features: market.streamingInput.featureTopic },
        },
      ],
      {
        schemaVersion: 'bayn.supplied-arrival-times.v1',
        description: 'Synthetic native alpha fixture arrival chronology',
        tieBreak: 'availability-topic-partition-offset',
      },
    ),
    input,
    binding: baseline.binding,
    alphaBaselineSources: [baseline.source],
  }
}
