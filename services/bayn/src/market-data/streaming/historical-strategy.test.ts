import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1 } from '../../hash'
import { decideIntradayMomentumCore } from '../../strategy/intraday-momentum/decision-core'
import { intradayMomentumBehaviorHash } from '../../strategy/intraday-momentum/decision'
import { canonicalRawTimestamp } from './raw-events'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { replayHistoricalStreamingStrategy } from './historical-strategy'

const experiment = () => {
  const { cut, snapshot, protocol } = streamingFixture()
  const observedAtMs = Date.parse(snapshot.manifest.observedAt)
  const raw = [...snapshot.bars, ...snapshot.quotes, ...snapshot.trades].map((row) => ({
    availableAtMs: observedAtMs,
    record: {
      topic: row.sourceTopic,
      partition: row.sourcePartition,
      offset: row.sourceOffset,
      value: JSON.stringify({
        version: 2,
        provider: row.provider,
        feed: row.feed,
        delayClass: row.delayClass,
        marketSession: row.marketSession,
        symbol: row.symbol,
        eventTs: row.eventAt,
        ingestTs: row.ingestedAt,
        channel: 'open' in row ? row.channel : 'bidPrice' in row ? 'quotes' : 'trades',
        isFinal: 'open' in row ? row.final : true,
        payload: {
          t: row.eventAt,
          ...('open' in row
            ? {
                o: row.open,
                h: row.high,
                l: row.low,
                c: row.close,
                v: row.volume,
                vw: row.vwap,
                n: row.tradeCount === null ? null : Number(row.tradeCount),
              }
            : 'bidPrice' in row
              ? { bp: row.bidPrice, ap: row.askPrice, bs: row.bidSize, as: row.askSize }
              : { p: row.price, s: row.size }),
        },
      }),
    },
  }))
  const features = [...cut.projection.features.values()].flat().map((feature, partition) => ({
    availableAtMs: observedAtMs,
    record: { topic: feature.topic, partition, offset: feature.offset, value: JSON.stringify(feature.value) },
  }))
  const input = {
    schemaVersion: 'bayn.historical-streaming-strategy-input.v1',
    protocolHash: canonicalHashV1(protocol),
    behaviorHash: intradayMomentumBehaviorHash,
    sessionDate: '2026-09-04',
    calendar: [{ date: '2026-09-04', open: '09:30', close: '16:00' }],
    arrivals: {
      schemaVersion: 'bayn.historical-market-arrivals.v1',
      runId: 'a'.repeat(64),
      observedAtMs,
      deliveryModel: {
        schemaVersion: 'bayn.supplied-arrival-times.v1',
        description: 'All retained records available at the supplied observation',
        tieBreak: 'availability-topic-partition-offset',
      },
      events: [...raw, ...features],
    },
  }
  return { input, snapshot, protocol, raw, features }
}

test('historical strategy reaches the same core with all seven symbols and an explicit research receipt', () => {
  const { input, snapshot, protocol } = experiment()
  const receipt = Result.getOrThrow(replayHistoricalStreamingStrategy(input))
  const direct = Result.getOrThrow(
    decideIntradayMomentumCore({
      protocol,
      bars: snapshot.bars,
      latestQuotes: Object.fromEntries(
        snapshot.quotes.map((row) => [
          row.symbol,
          { ...row, eventAt: Result.getOrThrow(canonicalRawTimestamp(row.eventAt)) },
        ]),
      ),
      latestTrades: Object.fromEntries(
        snapshot.trades.map((row) => [
          row.symbol,
          { ...row, eventAt: Result.getOrThrow(canonicalRawTimestamp(row.eventAt)) },
        ]),
      ),
      observedAt: snapshot.manifest.observedAt,
      rangeStartAt: snapshot.manifest.rangeStartAt,
    }),
  )
  expect(receipt.decision).toEqual(direct)
  expect(receipt.decision.selectedSymbols).toEqual(['AAPL'])
  expect(receipt.features).toHaveLength(7)
  expect(receipt.evidenceMode).toBe('simulated-consumer-availability')
  expect(receipt.regeneratedFeatures).toBeNull()
  expect(receipt).toEqual(Result.getOrThrow(replayHistoricalStreamingStrategy(input)))
  const { receiptHash, ...material } = receipt
  expect(receiptHash).toBe(canonicalHashV1(material))
})

test('late candidate features exclude only that candidate while late benchmark or all candidates fail', () => {
  const { input, raw, features } = experiment()
  const run = (late: readonly string[]) =>
    replayHistoricalStreamingStrategy({
      ...input,
      arrivals: {
        ...input.arrivals,
        events: [
          ...raw,
          ...features.map((event) => ({
            ...event,
            availableAtMs: late.includes(JSON.parse(event.record.value).material.symbol)
              ? input.arrivals.observedAtMs + 1000
              : event.availableAtMs,
          })),
        ],
      },
    })
  const partial = Result.getOrThrow(run(['AAPL']))
  expect(partial.decision.excludedCandidates.map((entry) => entry.symbol)).toEqual(['AAPL'])
  expect(partial.decision.selectedSymbols).toEqual(['AMZN'])
  expect(Result.isFailure(run(['SPY']))).toBe(true)
  expect(Result.isFailure(run(['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH']))).toBe(true)
})

test('regenerated research retains real computation time and requires a declared run identity', () => {
  const { input, raw, features } = experiment()
  const recordedAtMs = input.arrivals.observedAtMs + 86_400_000
  const arrivals = {
    ...input.arrivals,
    events: [
      ...raw,
      ...features.map((event) => ({
        ...event,
        record: {
          ...event.record,
          value: JSON.stringify({ ...JSON.parse(event.record.value), computedAtMs: recordedAtMs }),
        },
      })),
    ],
  }
  expect(Result.isFailure(replayHistoricalStreamingStrategy({ ...input, arrivals }))).toBe(true)
  const receipt = Result.getOrThrow(
    replayHistoricalStreamingStrategy({
      ...input,
      arrivals: {
        ...arrivals,
        regeneratedFeatures: { runId: 'b'.repeat(64), recordedAtMs },
      },
    }),
  )
  expect(receipt.features.every((entry) => entry.value.computedAtMs === recordedAtMs)).toBe(true)
  expect(receipt.features.every((entry) => entry.simulatedAvailableAtMs === input.arrivals.observedAtMs)).toBe(true)
})

test('a delivery model reversing Kafka offsets fails globally instead of excluding a candidate', () => {
  const { input } = experiment()
  const candidates = input.arrivals.events
    .filter((event) => {
      const value = JSON.parse(event.record.value)
      return value.symbol === 'AAPL' && value.channel === 'bars'
    })
    .toSorted((a, b) => Number(BigInt(a.record.offset) - BigInt(b.record.offset)))
  const second = candidates[1]
  if (second === undefined) throw new Error('missing fixture bars')
  second.availableAtMs -= 1
  expect(Result.isFailure(replayHistoricalStreamingStrategy(input))).toBe(true)
})

test('feature transport partitions outside Kafka Int32 fail the whole experiment', () => {
  const { input, raw, features } = experiment()
  const changed = features.map((event) => ({ ...event, record: { ...event.record, partition: 2_147_483_648 } }))
  expect(
    Result.isFailure(
      replayHistoricalStreamingStrategy({
        ...input,
        arrivals: {
          ...input.arrivals,
          events: [...raw, ...changed],
        },
      }),
    ),
  ).toBe(true)
})

test('invalid protocol, session, raw input and stale benchmark cannot become successful research decisions', () => {
  const { input } = experiment()
  expect(Result.isFailure(replayHistoricalStreamingStrategy({ ...input, protocolHash: '0'.repeat(64) }))).toBe(true)
  expect(Result.isFailure(replayHistoricalStreamingStrategy({ ...input, behaviorHash: '0'.repeat(64) }))).toBe(true)
  expect(Result.isFailure(replayHistoricalStreamingStrategy({ ...input, calendar: [] }))).toBe(true)
  for (const observedAtMs of [
    0,
    Date.parse('2026-09-04T13:31:02Z'),
    Date.parse('2026-09-04T19:56:02Z'),
    Number.MAX_SAFE_INTEGER,
  ]) {
    expect(
      Result.isFailure(replayHistoricalStreamingStrategy({ ...input, arrivals: { ...input.arrivals, observedAtMs } })),
    ).toBe(true)
  }
  expect(
    Result.isFailure(
      replayHistoricalStreamingStrategy({
        ...input,
        arrivals: {
          ...input.arrivals,
          observedAtMs: input.arrivals.observedAtMs + 15_000,
        },
      }),
    ),
  ).toBe(true)
  const invalid = structuredClone(input)
  const first = invalid.arrivals.events[0]
  if (first === undefined) throw new Error('missing fixture raw event')
  first.record.value = '{}'
  expect(Result.isFailure(replayHistoricalStreamingStrategy(invalid))).toBe(true)
})
