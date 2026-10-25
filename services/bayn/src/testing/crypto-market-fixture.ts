import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { nativePayloadCanonicalJson, nativeSourceContentHash } from '../market-data/native-json'

import btc from '../market-data/features/fixtures/crypto-continuous-v2.json'
import eth from '../market-data/features/fixtures/crypto-eth-continuous-v2.json'
import sol from '../market-data/features/fixtures/crypto-sol-continuous-v2.json'
import btcFirst from '../market-data/features/fixtures/crypto-continuous-first-minute-v2.json'
import ethFirst from '../market-data/features/fixtures/crypto-eth-continuous-first-minute-v2.json'
import solFirst from '../market-data/features/fixtures/crypto-sol-continuous-first-minute-v2.json'
import { cryptoMarketProfile, jevBenchmarkSymbol } from '../jev/markets'
import { continuousMarketHours } from '../market-hours'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap'
import { emptyStreamingProjection, incorporateMarketRecord } from '../market-data/streaming/projection'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { MarketSource } from '../market-data/streaming/raw-events'

export const cryptoMarketFixture = (
  candidate: 'BTC/USD' | 'ETH/USD' | 'SOL/USD' = 'BTC/USD',
  timing: {
    readonly firstMinute?: boolean
    readonly tradeLagMs?: number
    readonly tradePrice?: number
    readonly quoteLagMs?: number
    readonly benchmarkQuoteLagMs?: number
    readonly quoteSpreadBps?: number
    readonly quoteAskSize?: number
    readonly missingTradeSymbols?: readonly string[]
    readonly observedPriceChoices?: boolean
  } = {},
) => {
  const fixtures = timing.firstMinute === true ? [btcFirst, ethFirst, solFirst] : [btc, eth, sol]
  const end = btc.feature.material.windowEndMs
  const observedAtMs = end + 3000
  const source: MarketSource = {
    universeId: cryptoMarketProfile.universeId,
    universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
    symbols: cryptoMarketProfile.universe,
    topics: { ...cryptoMarketProfile.sourceTopics, features: cryptoMarketProfile.streamingInput.featureTopic },
  }
  let projection = emptyStreamingProjection('crypto-native')
  const positions = []
  for (const [featurePartition, original] of fixtures.entries()) {
    const fixture = structuredClone(original)
    if (timing.observedPriceChoices === true) {
      const record = fixture.records.at(-1)
      const input = fixture.feature.material.inputs.at(-1)
      if (record === undefined || input === undefined || record.offset !== input.sourceOffset)
        throw new Error('Expected final crypto bar and source reference')
      const envelope = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(record.value))
      const payload = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(envelope['payload'])
      record.value = JSON.stringify({ ...envelope, payload: { ...payload, h: 110, l: 95 } })
      input.contentHash = nativeSourceContentHash(
        ['alpaca', 'us', fixture.feature.material.symbol, 'bars', input.eventTimeNanos, input.ingestionTimeNanos],
        Result.getOrThrow(nativePayloadCanonicalJson(record.value)),
      )
      fixture.feature.material.priceWindow.rangeHighPrice = '110'
      fixture.feature.material.priceWindow.rangeLowPrice = '95'
      fixture.feature.material.historyHash = fixture.feature.material.inputs.reduce(
        (previous, reference) => Result.getOrThrow(canonicalHashV1Result([previous, reference])),
        fixture.feature.material.historyPrefixHash,
      )
      fixture.feature.featureId = Result.getOrThrow(canonicalHashV1Result(fixture.feature.material))
    }
    fixtures[featurePartition] = fixture
    for (const record of fixture.records)
      projection = incorporateMarketRecord(projection, record, source, Date.parse(JSON.parse(record.value).ingestTs))
    projection = incorporateMarketRecord(
      projection,
      {
        topic: source.topics.features,
        partition: featurePartition,
        offset: '0',
        value: JSON.stringify(fixture.feature),
      },
      source,
      observedAtMs,
    )
    const partition = fixture.records[0]?.partition
    if (partition === undefined) throw new Error('Native producer fixture has no source records')
    const symbol = fixture.feature.material.symbol
    const quoteLagMs =
      symbol === jevBenchmarkSymbol(candidate)
        ? (timing.benchmarkQuoteLagMs ?? timing.quoteLagMs ?? 0)
        : (timing.quoteLagMs ?? 0)
    const bid = symbol === candidate ? 103.123456789 : 100.123456789
    const ask =
      timing.quoteSpreadBps === undefined
        ? bid + 0.00000001
        : Number((bid * (1 + timing.quoteSpreadBps / 10_000)).toFixed(9))
    for (const [index, channel] of ['quotes', 'trades'].entries()) {
      if (channel === 'trades' && timing.missingTradeSymbols?.includes(symbol) === true) continue
      const at = new Date(end + 2000 - (channel === 'trades' ? (timing.tradeLagMs ?? 0) : quoteLagMs)).toISOString()
      projection = incorporateMarketRecord(
        projection,
        {
          topic: source.topics.bars,
          partition,
          offset: String(fixture.records.length + index),
          value: JSON.stringify({
            provider: 'alpaca',
            feed: 'us',
            delayClass: 'real_time_crypto',
            marketSession: 'continuous',
            channel,
            seq: 100 + index,
            symbol,
            version: 2,
            eventTs: at,
            ingestTs: at,
            payload:
              channel === 'quotes'
                ? {
                    T: 'q',
                    S: symbol,
                    t: at,
                    bp: bid,
                    bs: 0.031234567,
                    ap: ask,
                    as: timing.quoteAskSize ?? 0.031234567,
                  }
                : { T: 't', S: symbol, t: at, p: timing.tradePrice ?? bid, s: 0.000000001 },
          }),
        },
        source,
        observedAtMs,
      )
    }
    positions.push({ topic: source.topics.bars, partition, offset: String(fixture.records.length + 2) })
    positions.push({ topic: source.topics.features, partition: featurePartition, offset: '1' })
  }
  positions.sort((left, right) => left.topic.localeCompare(right.topic) || left.partition - right.partition)
  const cut = {
    projection,
    positions,
    bootstrap: {
      schemaVersion: 'bayn.kafka-bootstrap.v1' as const,
      epoch: projection.epoch,
      observedAtMs: end - 3_600_000,
      lowerTimestampMs: end - 3_600_000,
      timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
      partitions: positions.map((position) => ({
        topic: position.topic,
        partition: position.partition,
        logStartOffset: '0',
        startOffset: '0',
        endOffset: position.offset,
      })),
    },
  }
  const query = {
    calendar: continuousMarketHours,
    sessionDate: '2026-10-11' as const,
    observedAt: new Date(observedAtMs).toISOString(),
    rangeStartAt: new Date(end - 30 * 60_000).toISOString(),
    rangeEndAt: new Date(end).toISOString(),
    universeId: source.universeId,
    universeSymbolHash: source.universeSymbolHash,
    universe: source.symbols,
    symbols: [candidate, jevBenchmarkSymbol(candidate)].sort(),
    candidateSymbols: [candidate],
    candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
    benchmarkEvidencePolicy: cryptoMarketProfile.benchmarkEvidencePolicy,
    benchmarkSymbols: [jevBenchmarkSymbol(candidate)],
    feed: cryptoMarketProfile.feed,
    delayClass: cryptoMarketProfile.delayClass,
    sourceTopics: cryptoMarketProfile.sourceTopics,
    maximumQuoteAgeMs: 10_000,
    minimumWatermarkLagMs: 2000,
  }
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, query))
  return { cut, query, snapshot, rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)), fixtures }
}
