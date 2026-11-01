import { Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { equityClockSession } from '../equity-hours'
import { canonicalHashV1Result } from '../hash'
import { cryptoMarketProfile } from '../jev/markets'
import { decodeCryptoMarketFeature, type CryptoMarketFeature } from '../market-data/features/crypto-contract'
import constantCrypto from '../market-data/features/fixtures/crypto-continuous-v2.json'
import { nativePayloadCanonicalJson, nativeSourceContentHash } from '../market-data/native-json'
import type { HistoricalMarketArrival } from '../market-data/streaming/historical'
import { MarketSourcesSchema } from '../market-data/streaming/raw-events'
import { IsoDateSchema } from '../schemas'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { historicalRawArrivals } from './historical-streaming-fixture'
import { retainReplayArrivals } from './retained-replay-fixture'
import { fixtureProtocol } from './runtime-fixtures'
import { streamingFixture, streamingFixtureFromRaw } from './streaming-market-fixture'

/** Synthetic short exchange sessions exercise the whole registered window, never empirical profitability. */
export const registeredTradeReplayFixture = () => {
  const dates = Array.from({ length: 20 }, (_, index) =>
    Schema.decodeUnknownSync(IsoDateSchema)(
      new Date(Date.UTC(2026, 10, 2 + index + Math.floor(index / 5) * 2)).toISOString().slice(0, 10),
    ),
  )
  const calendar = dates.map((date) => ({
    date,
    open: '09:30',
    close: '09:40',
    session_open: '0930',
    session_close: '0940',
  }))
  const first = dates[0]
  const last = dates.at(-1)
  if (first === undefined || last === undefined) throw new Error('Missing registered synthetic calendar')
  const calendarObservation = Result.getOrThrow(normalizeMarketCalendarResult(calendar, { start: first, end: last }))
  const base = streamingFixture()
  const arrivals: HistoricalMarketArrival[] = []
  const offsets = new Map<string, bigint>()
  const next = (topic: string, partition = 0) => {
    const key = `${topic}:${partition}`
    const offset = offsets.get(key) ?? 0n
    offsets.set(key, offset + 1n)
    return String(offset)
  }
  for (const session of calendarObservation.providerSessions) {
    const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)(session.date)
    const open = Date.parse(session.regularOpenAt)
    const close = Date.parse(session.regularCloseAt)
    const instant = (at: number) => new Date(at).toISOString()
    for (const [partition, symbol] of cryptoMarketProfile.universe.entries()) {
      const topic = cryptoMarketProfile.sourceTopics.bars
      const featureTopic = cryptoMarketProfile.streamingInput.featureTopic
      const inputs: CryptoMarketFeature['material']['inputs'][number][] = []
      const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
      let prefix = hash([])
      let history = prefix
      const price = Number(constantCrypto.feature.material.priceWindow.referencePrice)
      const start = open - 62 * 60_000
      for (let at = start + 60_000; at <= close; at += 1000) {
        if (at % 60_000 === 0) {
          const offset = next(topic, partition)
          const value = JSON.stringify({
            version: 2,
            provider: 'alpaca',
            feed: 'us',
            delayClass: 'real_time_crypto',
            marketSession: 'continuous',
            channel: 'bars',
            seq: Number(offset) + 1,
            symbol,
            eventTs: instant(at - 60_000),
            ingestTs: instant(at),
            payload: {
              T: 'b',
              S: symbol,
              t: instant(at - 60_000),
              o: price,
              h: price,
              l: price,
              c: price,
              v: 0.000000001,
              vw: price,
            },
          })
          const identity = {
            eventTimeNanos: String(BigInt(at - 60_000) * 1_000_000n),
            ingestionTimeNanos: String(BigInt(at) * 1_000_000n),
            sourceTopic: topic,
            sourcePartition: partition,
            sourceOffset: offset,
          }
          const reference = {
            ...identity,
            contentHash: nativeSourceContentHash(
              ['alpaca', 'us', symbol, 'bars', identity.eventTimeNanos, identity.ingestionTimeNanos],
              Result.getOrThrow(nativePayloadCanonicalJson(value)),
            ),
          }
          inputs.push(reference)
          if (inputs.length > 61) prefix = hash([prefix, inputs.shift()])
          history = hash([history, reference])
          arrivals.push({ availableAtMs: at, record: { topic, partition, offset, value } })
        }
        if (at % 60_000 === 2000 && inputs.length >= 61) {
          // Constant-price native producer statistics remain exact as the constant history grows.
          const material = {
            ...constantCrypto.feature.material,
            symbol,
            windowStartMs: at - 2000 - 61 * 60_000,
            windowEndMs: at - 2000,
            historyPrefixHash: prefix,
            historyHash: history,
            inputs: [...inputs],
          }
          const feature = Result.getOrThrow(
            decodeCryptoMarketFeature({
              ...constantCrypto.feature,
              material,
              featureId: hash(material),
              computedAtMs: at,
            }),
          )
          arrivals.push({
            availableAtMs: at,
            record: {
              topic: featureTopic,
              partition,
              offset: next(featureTopic, partition),
              value: JSON.stringify(feature),
            },
          })
        }
        if (at < open - 1000) continue
        for (const channel of ['quotes', 'trades']) {
          const offset = next(topic, partition)
          arrivals.push({
            availableAtMs: at,
            record: {
              topic,
              partition,
              offset,
              value: JSON.stringify({
                version: 2,
                provider: 'alpaca',
                feed: 'us',
                delayClass: 'real_time_crypto',
                marketSession: 'continuous',
                channel,
                seq: Number(offset) + 1,
                symbol,
                eventTs: instant(at),
                ingestTs: instant(at),
                payload:
                  channel === 'quotes'
                    ? {
                        T: 'q',
                        S: symbol,
                        t: instant(at),
                        bp: price,
                        ap: price + 0.00000001,
                        bs: 0.031234567,
                        as: 0.031234567,
                      }
                    : { T: 't', S: symbol, t: instant(at), p: price, s: 0.000000001 },
              }),
            },
          })
        }
      }
    }
    const request = {
      ...base.query,
      calendar: calendarObservation,
      sessionDate,
      rangeStartAt: session.regularOpenAt,
      rangeEndAt: session.regularCloseAt,
      observedAt: instant(close + 2000),
    }
    const raw = makeIntradayMomentumTestSnapshot(
      fixtureProtocol,
      { ...request, archiveWatermarks: base.archive.manifest.archiveWatermarks },
      { AAPL: 0.02, AMZN: 0.01 },
    )
    const bars = raw.bars.map((bar) => ({
      ...bar,
      sourceOffset: next(bar.sourceTopic),
      high: bar.symbol !== 'SPY' && Date.parse(bar.eventAt) === open ? 105 : bar.high,
      low: bar.symbol !== 'SPY' && Date.parse(bar.eventAt) === open ? 95 : bar.low,
    }))
    for (const bar of bars)
      arrivals.push(...historicalRawArrivals({ bars: [bar], quotes: [], trades: [] }, Date.parse(bar.ingestedAt)))
    for (let at = open - 1000; at <= close; at += 1000) {
      const quotes = raw.quotes.map((quote) => ({
        ...quote,
        sourceOffset: next(quote.sourceTopic),
        eventAt: instant(at),
        ingestedAt: instant(at),
        marketSession: equityClockSession(instant(at)) ?? 'regular',
        bidPrice: quote.bidPrice * (quote.symbol === 'AAPL' && at >= open + 250000 ? 1.04 : 1),
        askPrice: quote.askPrice * (quote.symbol === 'AAPL' && at >= open + 250000 ? 1.04 : 1),
      }))
      const trades = raw.trades.map((trade) => ({
        ...trade,
        sourceOffset: next(trade.sourceTopic),
        eventAt: instant(at),
        ingestedAt: instant(at),
        marketSession: equityClockSession(instant(at)) ?? 'regular',
        price: trade.price * (trade.symbol === 'AAPL' && at >= open + 250000 ? 1.04 : 1),
      }))
      arrivals.push(...historicalRawArrivals({ bars: [], quotes, trades }, at))
      if (at <= open + 2000 || (at - open) % 60000 !== 2000) continue
      const end = at - 2000
      const snapshot = streamingFixtureFromRaw(
        { bars: bars.filter((bar) => Date.parse(bar.eventAt) < end), quotes, trades },
        { ...request, rangeEndAt: instant(end), observedAt: instant(at) },
      )
      for (const feature of [...snapshot.cut.projection.features.values()].flat())
        arrivals.push({
          availableAtMs: at,
          record: {
            topic: feature.topic,
            partition: 0,
            offset: next(feature.topic),
            value: JSON.stringify(feature.value),
          },
        })
    }
  }
  const sources = Schema.decodeUnknownSync(MarketSourcesSchema)(
    fixtureProtocol.marketProfiles.map((profile) => ({
      universeId: profile.universeId,
      universeSymbolHash: profile.universeSymbolHash,
      symbols: profile.universe,
      topics: { ...profile.sourceTopics, features: profile.streamingInput.featureTopic },
    })),
  )
  const retained = retainReplayArrivals(arrivals, sources, {
    schemaVersion: 'bayn.supplied-arrival-times.v1',
    description: 'Synthetic causal bars, quotes, trades and regenerated features across twenty short test sessions',
    tieBreak: 'availability-topic-partition-offset',
  })
  return {
    ...retained,
    calendar,
    calendarObservation,
    sessions: calendarObservation.providerSessions,
  }
}
