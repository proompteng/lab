import { sha256 } from '../../hash'
import { MarketChangeReason } from '../../execution/events'
import { makeMarketHints } from './readiness'
import {
  bootstrapKafkaPartitions,
  kafkaBootstrapComplete,
  KafkaBootstrapTimestampPolicy,
  type KafkaBootstrapEvidence,
  type KafkaPartitionPosition,
} from './bootstrap'
import { describe, expect, test } from 'bun:test'
import { Clock, Deferred, Effect, Exit, Logger, Metric, Redacted, Result } from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { makeCaptureHealth, observeCaptureWorker } from './capture-health'
import { readFileSync } from 'node:fs'
import { AuthenticationError, ProtocolError } from '@platformatic/kafka'
import { decodeRollingMarketFeature, featureBarContentHash } from '../features/contract'
import technicalFixture from '../features/fixtures/technical-indicators-v1.json'
import { decodeTechnicalMarketFeature } from '../features/technical-contract'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../../effect-test-support'
import { historicalRawArrivals } from '../../testing/historical-streaming-fixture'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { CaptureDisposition, CaptureReason } from './transport-evidence'
import { nativeArrivalCaptureId, type NativeArrivalChunk, type NativeArrivalObservation } from './native-arrival'
import { makeNativeArrivalJournal, type NativeArrivalCapture, type NativeArrivalEnd } from './native-arrival-journal'
import { nativeArrivalEpochFixture } from './native-arrival.test-support'
import { persistIntradayRecordRows } from '../intraday/verification'
import { reproduceStreamingSnapshot } from './replay'
import { constructStreamingSnapshot } from './snapshot'
import {
  makeKafkaMarketProjection,
  decodeKafkaTransportValue,
  type KafkaConsumedRecord,
  type KafkaMarketConfig,
  type KafkaProjectionStream,
  type KafkaProjectionTransport,
  type KafkaProjectionClosed,
} from './kafka'
import type { StreamingUniverse } from './raw-events'

const config: KafkaMarketConfig = {
  brokers: ['unused:9092'],
  username: 'test',
  password: Redacted.make('unused'),
  groupPrefix: 'test',
  operationTimeoutMs: 1000,
  bootstrapTimeoutMs: 5000,
  timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
}
const universe: StreamingUniverse = {
  universeId: 'test',
  universeSymbolHash: '0'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features' },
}
const positions = (offset: string): readonly KafkaPartitionPosition[] =>
  Object.values(universe.topics).map((topic) => ({ topic, partition: 0, offset }))
class FakeTransport implements KafkaProjectionTransport {
  closeCount = 0
  commits: readonly KafkaConsumedRecord[][] = []
  lookups: bigint[] = []
  invalidated: ((cause: unknown) => void) | undefined
  private drainedValue: readonly KafkaPartitionPosition[] | undefined = positions('0')
  private progressed: (() => void) | undefined
  get drained() {
    return this.drainedValue
  }
  set drained(value: readonly KafkaPartitionPosition[] | undefined) {
    this.drainedValue = value
    this.progressed?.()
  }
  queue: KafkaConsumedRecord[] = []
  pending: ((value: IteratorResult<KafkaConsumedRecord>) => void) | undefined
  closed = false
  offsets: KafkaProjectionTransport['offsets'] = async (topics, timestamp) => {
    this.lookups.push(timestamp)
    return positions('0').filter((position) => topics.includes(position.topic))
  }
  consume = async (
    _positions: readonly KafkaPartitionPosition[],
    invalidated: (cause: unknown) => void,
    progressed: () => void,
  ): Promise<KafkaProjectionStream> => {
    this.invalidated = invalidated
    this.progressed = progressed
    return {
      queuedRecords: () => this.queue.length,
      drainedPositions: () => this.drained,
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<KafkaConsumedRecord>>((resolve) => {
            const next = this.queue.shift()
            if (next !== undefined) resolve({ done: false, value: next })
            else if (this.closed) resolve({ done: true, value: undefined })
            else this.pending = resolve
          }),
        return: async () => {
          await this.close()
          return { done: true, value: undefined }
        },
      }),
    }
  }
  send(record: KafkaConsumedRecord) {
    const pending = this.pending
    this.pending = undefined
    if (pending === undefined) this.queue.push(record)
    else pending({ done: false, value: record })
  }
  commit = async (records: readonly KafkaConsumedRecord[]) => {
    this.commits = [...this.commits, [...records]]
  }
  close = async (): Promise<KafkaProjectionClosed> => {
    if (this.closed) return { _tag: 'Closed' }
    this.closed = true
    this.closeCount++
    this.pending?.({ done: true, value: undefined })
    this.pending = undefined
    return { _tag: 'Closed' }
  }
}
/** Models broker timestamp lookup and an immutable retained log, including skipped/control offsets. */
class RetainedLogTransport extends FakeTransport {
  maximumQueuedRecords = 0
  deliveredRecords = 0
  deliveredRawBytes = 0
  requested: readonly KafkaPartitionPosition[] = []
  constructor(
    readonly log: KafkaConsumedRecord[],
    readonly topics: readonly string[],
    readonly headTopics: readonly string[] = [],
  ) {
    super()
    const ends = () =>
      this.topics.map((topic) => ({
        topic,
        partition: 0,
        offset: String(
          this.log
            .filter((record) => record.topic === topic)
            .reduce((end, record) => (BigInt(record.offset) >= end ? BigInt(record.offset) + 1n : end), 0n),
        ),
      }))
    this.offsets = async (topics, timestamp) => {
      this.lookups.push(timestamp)
      return ends()
        .filter((position) => topics.includes(position.topic))
        .map((end) => {
          if (timestamp === -2n) return { ...end, offset: '0' }
          if (timestamp === -1n || this.headTopics.includes(end.topic)) return end
          const first = this.log
            .filter((record) => record.topic === end.topic && BigInt(record.timestampMs) >= timestamp)
            .toSorted((a, b) => Number(BigInt(a.offset) - BigInt(b.offset)))[0]
          return { ...end, offset: first?.offset ?? '-1' }
        })
    }
    const consume = this.consume
    this.consume = async (positions, invalidated, progressed) => {
      this.requested = positions
      const starts = new Map(positions.map((position) => [position.topic, BigInt(position.offset)]))
      const retained = this.log
        .filter((record) => BigInt(record.offset) >= (starts.get(record.topic) ?? 0n))
        .toSorted((a, b) => a.topic.localeCompare(b.topic) || Number(BigInt(a.offset) - BigInt(b.offset)))
      let cursor = 0
      const refill = () => {
        if (this.queue.length === 0 && cursor < retained.length) {
          this.queue.push(...retained.slice(cursor, cursor + 256))
          cursor += this.queue.length
          this.maximumQueuedRecords = Math.max(this.maximumQueuedRecords, this.queue.length)
        }
      }
      this.queue = []
      refill()
      const stream = await consume(positions, invalidated, progressed)
      const iterator = stream[Symbol.asyncIterator]()
      return {
        queuedRecords: stream.queuedRecords,
        drainedPositions: () => (cursor === retained.length && this.queue.length === 0 ? ends() : undefined),
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            refill()
            if (cursor === retained.length && this.queue.length === 0) progressed()
            const item = await iterator.next()
            if (item.done !== true) {
              this.deliveredRecords += 1
              this.deliveredRawBytes += item.value.rawByteLength ?? Buffer.byteLength(item.value.value)
            }
            return item
          },
          return: async () => {
            await this.close()
            return { done: true, value: undefined }
          },
        }),
      }
    }
  }
}

const readyLogProjection = (
  transport: RetainedLogTransport,
  source: StreamingUniverse,
  captureFactory?: Parameters<typeof makeKafkaMarketProjection>[4],
) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const projection = yield* makeKafkaMarketProjection(config, [source], () => transport, undefined, captureFactory, {
      changed: (reason) =>
        reason === MarketChangeReason.Ready ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void,
    })
    yield* Deferred.await(ready)
    return projection
  })

const snapshotLog = (fixture: Pick<ReturnType<typeof streamingFixtureFromRaw>, 'snapshot' | 'cut'>) => [
  ...historicalRawArrivals(fixture.snapshot, Date.parse(fixture.snapshot.manifest.observedAt)).map(({ record }) => ({
    ...record,
    timestampMs: Date.parse(JSON.parse(record.value).ingestTs),
    leaderEpoch: 1,
    rawByteLength: Buffer.byteLength(record.value),
  })),
  ...[...fixture.cut.projection.features.values()].flat().map((feature) => {
    const value = JSON.stringify(feature.value)
    return {
      topic: feature.topic,
      partition: feature.partition,
      offset: feature.offset,
      timestampMs: feature.value.computedAtMs,
      value,
      leaderEpoch: 1,
      rawByteLength: Buffer.byteLength(value),
    }
  }),
]

const clockEdges = [
  { ingestionSkewMs: -5_000, kafkaSkewMs: -5_000 },
  { ingestionSkewMs: -5_000, kafkaSkewMs: 5_000 },
  { ingestionSkewMs: 5_000, kafkaSkewMs: -5_000 },
  { ingestionSkewMs: 5_000, kafkaSkewMs: 5_000 },
]

const program = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe((self) => provideTestLayer(self, TestClock.layer())))

test.each(['rest_latest', 'ws', 'rest'])(
  'live market admission handles %s acquisition without losing retained arrival evidence',
  async (acquisition) => {
    await program(
      Effect.gen(function* () {
        const fixture = streamingFixture()
        const source = fixture.cut.projection.sources.get(fixture.query.universeId)
        if (source === undefined) throw new Error('Missing fixture source')
        const log = snapshotLog(fixture).map((record) => {
          const envelope = JSON.parse(record.value)
          if (envelope.symbol !== 'AAPL' || !['quotes', 'trades'].includes(envelope.channel)) return record
          const value = JSON.stringify({ ...envelope, source: acquisition })
          return { ...record, value, rawByteLength: Buffer.byteLength(value) }
        })
        yield* TestClock.setTime(Date.parse(fixture.query.observedAt))
        const transport = new RetainedLogTransport(log, Object.values(source.topics))
        const captured: NativeArrivalObservation[] = []
        const projection = yield* readyLogProjection(transport, source, () =>
          Effect.succeed({
            flush: Effect.void,
            observe: (input) =>
              Effect.sync(() => {
                captured.push(input)
              }),
            status: () => ({
              captureId: '0'.repeat(64),
              status: 'RECORDING',
              observedConsumerSequence: captured.length,
              durableConsumerSequence: 0,
              queuedCompressedBytes: 0,
              failure: null,
            }),
          }),
        )
        const cut = yield* projection.read
        expect(cut.projection.quotes.has('AAPL')).toBe(acquisition !== 'rest_latest')
        expect(cut.projection.trades.has('AAPL')).toBe(acquisition !== 'rest_latest')
        expect(cut.projection.rejections.size).toBe(0)
        expect(transport.deliveredRecords).toBeGreaterThan(0)
        const sampled = captured.filter((input) => {
          const envelope = JSON.parse(input.record.value)
          return envelope.symbol === 'AAPL' && ['quotes', 'trades'].includes(envelope.channel)
        })
        expect(sampled.length).toBeGreaterThan(0)
        expect(
          sampled.every((input) =>
            acquisition === 'rest_latest'
              ? input.reason === CaptureReason.RetiredLatestRest && input.disposition === CaptureDisposition.Ignored
              : input.reason === undefined && input.disposition === CaptureDisposition.Accepted,
          ),
        ).toBe(true)
      }),
    )
  },
)

test.each(clockEdges)(
  'quote seek includes the valid age boundary with ingestion skew $ingestionSkewMs and Kafka skew $kafkaSkewMs',
  async ({ ingestionSkewMs, kafkaSkewMs }) => {
    await program(
      Effect.gen(function* () {
        const fixture = streamingFixture()
        const now = Date.parse(fixture.query.observedAt)
        const source = fixture.cut.projection.sources.get(fixture.query.universeId)
        if (source === undefined) throw new Error('Missing fixture source')
        const eventAt = new Date(now - 10_000).toISOString()
        const ingestedAt = new Date(Date.parse(eventAt) + ingestionSkewMs).toISOString()
        const log = snapshotLog(fixture).map((record) => {
          const value = JSON.parse(record.value)
          if (record.topic !== source.topics.quotes || value.symbol !== 'AAPL') return record
          const encoded = JSON.stringify({
            ...value,
            eventTs: eventAt,
            ingestTs: ingestedAt,
            payload: { ...value.payload, t: eventAt },
          })
          return {
            ...record,
            value: encoded,
            rawByteLength: Buffer.byteLength(encoded),
            timestampMs: Date.parse(ingestedAt) + kafkaSkewMs,
          }
        })
        yield* TestClock.setTime(now)
        const transport = new RetainedLogTransport(log, Object.values(source.topics))
        const projection = yield* readyLogProjection(transport, source)
        const snapshot = Result.getOrThrow(constructStreamingSnapshot(yield* projection.read, fixture.query))
        expect(transport.lookups).toContain(BigInt(now - 20_000))
        expect(snapshot.manifest.candidateExclusions).toEqual([])
        expect(Date.parse(snapshot.latestQuotes['AAPL']?.eventAt ?? '')).toBe(now - 10_000)
        expect(Date.parse(snapshot.latestQuotes['AAPL']?.ingestedAt ?? '')).toBe(Date.parse(ingestedAt))
        const row = snapshot.quotes.find((quote) => quote.symbol === 'AAPL')
        expect(row).toBeDefined()
        const receipt = snapshot.manifest.streaming.records.find(
          (entry) => entry.sourceTopic === row?.sourceTopic && entry.sourceOffset === row.sourceOffset,
        )
        expect(receipt?.availableAtMs).toBe(now)
        expect(snapshot.manifest.rangeEndAt).toBe(fixture.query.rangeEndAt)
      }),
    )
  },
)

test.each(clockEdges)(
  'aligned trade context includes its first row with ingestion skew $ingestionSkewMs and Kafka skew $kafkaSkewMs',
  async ({ ingestionSkewMs, kafkaSkewMs }) => {
    await program(
      Effect.gen(function* () {
        const base = streamingFixture()
        const end = Date.parse(base.query.rangeEndAt) - 60_000
        const start = end - 30 * 60_000
        const now = end + 61_999
        const query = {
          ...base.query,
          rangeStartAt: new Date(start).toISOString(),
          rangeEndAt: new Date(end).toISOString(),
          observedAt: new Date(now).toISOString(),
        }
        const shifted = (value: string) => new Date(Date.parse(value) - 60_000).toISOString()
        const eventAt = new Date(start).toISOString()
        const ingestedAt = new Date(start + ingestionSkewMs).toISOString()
        const fixture = streamingFixtureFromRaw(
          {
            bars: base.snapshot.bars.map((bar) => ({
              ...bar,
              eventAt: shifted(bar.eventAt),
              ingestedAt: shifted(bar.ingestedAt),
            })),
            quotes: base.snapshot.quotes.map((quote) => ({
              ...quote,
              eventAt: new Date(now - 1).toISOString(),
              ingestedAt: new Date(now - 1).toISOString(),
            })),
            trades: base.snapshot.trades.map((trade) => ({
              ...trade,
              eventAt: trade.symbol === 'AAPL' ? eventAt : shifted(trade.eventAt),
              ingestedAt: trade.symbol === 'AAPL' ? ingestedAt : shifted(trade.ingestedAt),
            })),
          },
          query,
        )
        const source = fixture.cut.projection.sources.get(query.universeId)
        if (source === undefined) throw new Error('Missing fixture source')
        const log = snapshotLog(fixture).map((record) =>
          record.topic === source.topics.trades && JSON.parse(record.value).symbol === 'AAPL'
            ? { ...record, timestampMs: Date.parse(ingestedAt) + kafkaSkewMs }
            : record,
        )
        yield* TestClock.setTime(now)
        const transport = new RetainedLogTransport(log, Object.values(source.topics))
        const projection = yield* readyLogProjection(transport, source)
        const snapshot = Result.getOrThrow(constructStreamingSnapshot(yield* projection.read, query))
        expect(now - 30 * 60_000 - start).toBe(61_999)
        expect(transport.lookups).toContain(BigInt(start - 10_000))
        const trade = snapshot.trades.find((entry) => entry.symbol === 'AAPL')
        expect(Date.parse(trade?.eventAt ?? '')).toBe(start)
        expect(Date.parse(trade?.ingestedAt ?? '')).toBe(Date.parse(ingestedAt))
        expect(snapshot.manifest.candidateExclusions).toEqual([])
        expect(snapshot.manifest.rangeStartAt).toBe(query.rangeStartAt)
        expect(snapshot.manifest.rangeEndAt).toBe(query.rangeEndAt)
      }),
    )
  },
)

test('a timestamp lookup racing appended records consumes from the captured end without skipping either append', async () => {
  await program(
    Effect.gen(function* () {
      const fixture = streamingFixture()
      const now = Date.parse(fixture.query.observedAt)
      const template = historicalRawArrivals(fixture.snapshot, now).find(
        ({ record }) =>
          record.topic === fixture.query.sourceTopics.quotes && JSON.parse(record.value).symbol === 'AAPL',
      )
      if (template === undefined) throw new Error('Missing quote envelope')
      const value = JSON.parse(template.record.value)
      const quote = (offset: string, ageMs: number): KafkaConsumedRecord => {
        const eventAt = new Date(now - ageMs).toISOString()
        const ingestedAt = new Date(now - ageMs - 5_000).toISOString()
        const encoded = JSON.stringify({
          ...value,
          eventTs: eventAt,
          ingestTs: ingestedAt,
          payload: { ...value.payload, t: eventAt },
        })
        return {
          topic: universe.topics.quotes,
          partition: 0,
          offset,
          value: encoded,
          timestampMs: now - ageMs - 10_000,
          leaderEpoch: 1,
          rawByteLength: Buffer.byteLength(encoded),
        }
      }
      const log = [quote('0', 30_000)]
      const transport = new RetainedLogTransport(log, Object.values(universe.topics))
      const offsets = transport.offsets
      let appended = false
      transport.offsets = async (topics, timestamp) => {
        if (timestamp >= 0n && topics.includes(universe.topics.quotes) && !appended) {
          appended = true
          log.push(quote('1', 10_001), quote('2', 9_999))
        }
        return offsets(topics, timestamp)
      }
      yield* TestClock.setTime(now)
      const incorporated = yield* Deferred.make<void>()
      let records = 0
      const projection = yield* makeKafkaMarketProjection(config, [universe], () => transport, undefined, undefined, {
        changed: (reason) =>
          reason === MarketChangeReason.Data && ++records === 2
            ? Deferred.succeed(incorporated, undefined).pipe(Effect.asVoid)
            : Effect.void,
      })
      yield* Deferred.await(incorporated)
      const cut = yield* projection.read
      expect(cut.bootstrap.partitions.find((partition) => partition.topic === universe.topics.quotes)).toMatchObject({
        startOffset: '1',
        endOffset: '1',
      })
      expect(transport.requested.find((position) => position.topic === universe.topics.quotes)?.offset).toBe('1')
      expect(cut.projection.quoteHistory.get('AAPL')?.map((entry) => entry.value.sourceOffset)).toEqual(['1', '2'])
      expect(cut.projection.quotes.get('AAPL')?.value.sourceOffset).toBe('2')
      expect(transport.deliveredRecords).toBe(2)
    }),
  )
})

test('history arriving after the original bootstrap deadline cannot make a cold worker ready', async () => {
  const transport = new FakeTransport()
  transport.offsets = async (topics, timestamp) =>
    positions(timestamp === -1n ? '10' : '0').filter((position) => topics.includes(position.topic))
  await program(
    Effect.gen(function* () {
      const market = yield* makeKafkaMarketProjection(config, [universe], () => transport)
      yield* Effect.sleep(5500).pipe(
        Effect.andThen(
          Effect.sync(() => {
            transport.drained = positions('10')
          }),
        ),
        Effect.forkChild,
      )
      yield* TestClock.adjust(5501)
      const status = yield* market.status
      expect(status.ready).toBe(false)
      expect(status.bootstrapDeadlineAtMs).toBe(5000)
      expect(status.failure).toBe('Kafka bootstrap deadline exceeded')
      expect(Result.isFailure(yield* market.read.pipe(Effect.result))).toBe(true)
    }),
  )
  expect(transport.closeCount).toBe(1)
})

test('an accepted quote emits a data hint before audit capture or its one-second flush', async () => {
  await program(
    Effect.gen(function* () {
      const fixture = streamingFixture()
      const now = Date.parse(fixture.query.observedAt) + 1_000
      yield* TestClock.setTime(now)
      const source: StreamingUniverse = {
        universeId: fixture.protocol.universeId,
        universeSymbolHash: fixture.protocol.universeSymbolHash,
        symbols: fixture.protocol.universe,
        topics: { ...fixture.protocol.sourceTopics, features: fixture.protocol.streamingInput.featureTopic },
      }
      const arrival = historicalRawArrivals(fixture.snapshot, now).find(
        ({ record }) => record.topic === source.topics.quotes,
      )
      if (arrival === undefined) throw new Error('Missing fresh quote fixture')
      const transport = new FakeTransport()
      const bounds = Object.values(source.topics).map((topic) => ({ topic, partition: 0, offset: '0' }))
      transport.offsets = async (topics) => bounds.filter((position) => topics.includes(position.topic))
      transport.drained = bounds
      const data = yield* Deferred.make<void>()
      const captured = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const reasons: MarketChangeReason[] = []
      let flushed = 0
      const projection = yield* makeKafkaMarketProjection(
        config,
        [source],
        () => transport,
        undefined,
        () =>
          Effect.succeed({
            observe: () => Deferred.succeed(captured, undefined).pipe(Effect.andThen(Deferred.await(release))),
            flush: Effect.sync(() => {
              flushed += 1
            }),
            status: () => ({
              captureId: '0'.repeat(64),
              status: 'RECORDING' as const,
              observedConsumerSequence: 1,
              durableConsumerSequence: 0,
              queuedCompressedBytes: 0,
              failure: null,
            }),
          }),
        {
          changed: (reason) =>
            Effect.gen(function* () {
              reasons.push(reason)
              if (reason === MarketChangeReason.Data) yield* Deferred.succeed(data, undefined)
            }),
        },
      )
      transport.send({ ...arrival.record, timestampMs: now, leaderEpoch: 1 })
      yield* Deferred.await(data)
      yield* Deferred.await(captured)
      expect(reasons).toContain(MarketChangeReason.Data)
      expect(flushed).toBe(0)
      const cut = yield* projection.readForLiquidation
      expect(cut.projection.quotes.size).toBe(1)
      expect([...cut.projection.quotes.values()][0]?.availableAtMs).toBe(now)
      expect(yield* Clock.currentTimeMillis).toBe(now)
      yield* Deferred.succeed(release, undefined)
    }),
  )
})

test('quiet metadata failure emits recovery before readiness and recovers without another Kafka input', async () => {
  await program(
    Effect.gen(function* () {
      const reasons: MarketChangeReason[] = []
      let acquired = 0
      let firstLookup = true
      const projection = yield* makeKafkaMarketProjection(
        config,
        [universe],
        () => {
          const transport = new FakeTransport()
          acquired += 1
          transport.offsets = async (topics) => {
            if (firstLookup) {
              firstLookup = false
              throw new Error('Injected metadata outage on quiet topics')
            }
            return positions('0').filter((position) => topics.includes(position.topic))
          }
          return transport
        },
        undefined,
        undefined,
        {
          changed: (reason) =>
            Effect.sync(() => {
              reasons.push(reason)
            }),
        },
      )
      yield* TestClock.adjust('100 millis')
      expect(reasons).toEqual([MarketChangeReason.Startup, MarketChangeReason.Recovery])
      expect((yield* projection.status).ready).toBe(false)
      yield* TestClock.adjust('1 second')
      expect(reasons).toEqual([
        MarketChangeReason.Startup,
        MarketChangeReason.Recovery,
        MarketChangeReason.Startup,
        MarketChangeReason.Ready,
      ])
      expect((yield* projection.status).ready).toBe(true)
      expect(acquired).toBe(2)
      expect((yield* projection.read).projection.sequence).toBe(0)
    }),
  )
})

test('a later worker recovers the final fresh quote and a 15-second-old trade without a new input', async () => {
  await program(
    Effect.gen(function* () {
      const fixture = streamingFixture()
      const originalObservedAtMs = Date.parse(fixture.query.observedAt)
      const source: StreamingUniverse = {
        universeId: fixture.protocol.universeId,
        universeSymbolHash: fixture.protocol.universeSymbolHash,
        symbols: fixture.protocol.universe,
        topics: { ...fixture.protocol.sourceTopics, features: fixture.protocol.streamingInput.featureTopic },
      }
      const tradeAt = new Date(originalObservedAtMs - 15_000).toISOString()
      const ticks = historicalRawArrivals(
        {
          ...fixture.snapshot,
          trades: fixture.snapshot.trades.map((trade) => ({ ...trade, eventAt: tradeAt, ingestedAt: tradeAt })),
        },
        originalObservedAtMs,
      ).map(({ record }) => ({
        ...record,
        timestampMs: Date.parse(JSON.parse(record.value).ingestTs),
        leaderEpoch: 1,
        rawByteLength: Buffer.byteLength(record.value),
      }))
      const tickTopics = [source.topics.quotes, source.topics.trades]
      const log: KafkaConsumedRecord[] = [
        ...ticks.filter((record) => !tickTopics.includes(record.topic)),
        ...[...fixture.cut.projection.features.values()].flat().map((feature) => ({
          topic: feature.topic,
          partition: feature.partition,
          offset: feature.offset,
          timestampMs: feature.value.computedAtMs,
          value: JSON.stringify(feature.value),
          leaderEpoch: 1,
          rawByteLength: Buffer.byteLength(JSON.stringify(feature.value)),
        })),
      ]
      yield* TestClock.setTime(originalObservedAtMs)
      const transportA = new RetainedLogTransport(log, Object.values(source.topics))
      const A = yield* readyLogProjection(transportA, source)
      yield* A.check
      for (const record of ticks.filter((record) => tickTopics.includes(record.topic))) {
        log.push(record)
        transportA.send(record)
      }
      yield* TestClock.adjust('100 millis')
      const selectedA = Result.getOrThrow(
        constructStreamingSnapshot(yield* A.read, {
          ...fixture.query,
          observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        }),
      )
      expect(selectedA.manifest.candidateExclusions).toEqual([])
      expect(selectedA.trades.every((trade) => Date.parse(trade.eventAt) === originalObservedAtMs - 15_000)).toBe(true)
      yield* TestClock.setTime(originalObservedAtMs + 500)
      const queryB = { ...fixture.query, observedAt: new Date(yield* Clock.currentTimeMillis).toISOString() }
      const oldHead = new RetainedLogTransport(log, Object.values(source.topics), tickTopics)
      const oldB = yield* readyLogProjection(oldHead, source)
      const missing = constructStreamingSnapshot(yield* oldB.read, {
        ...queryB,
        observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      })
      expect(Result.isFailure(missing)).toBe(true)
      if (Result.isFailure(missing)) expect(missing.failure.reason).toBe('not-ready')
      const transportB = new RetainedLogTransport(log, Object.values(source.topics))
      const B = yield* readyLogProjection(transportB, source)
      const cutB = yield* B.read
      const selectedB = Result.getOrThrow(
        constructStreamingSnapshot(cutB, {
          ...queryB,
          observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        }),
      )
      expect(selectedB.manifest.candidateExclusions).toEqual([])
      expect(Result.getOrThrow(persistIntradayRecordRows(selectedB))).toEqual(
        Result.getOrThrow(persistIntradayRecordRows(selectedA)),
      )
      expect(selectedB.manifest.streaming.bootstrap.epoch).not.toBe(selectedA.manifest.streaming.bootstrap.epoch)
      expect(
        selectedB.manifest.streaming.records.every((receipt) => receipt.availableAtMs >= originalObservedAtMs + 500),
      ).toBe(true)
      expect(
        selectedA.manifest.streaming.records.every((receipt) => receipt.availableAtMs <= originalObservedAtMs + 200),
      ).toBe(true)
      expect(selectedB.manifest.rangeStartAt).toBe(fixture.query.rangeStartAt)
      expect(selectedB.manifest.rangeEndAt).toBe(fixture.query.rangeEndAt)
      expect(
        transportB.requested
          .filter((position) => tickTopics.includes(position.topic))
          .every(
            (position) =>
              BigInt(position.offset) <
              BigInt(oldHead.requested.find((other) => other.topic === position.topic)?.offset ?? '-1'),
          ),
      ).toBe(true)
      const staleAt = new Date(originalObservedAtMs - fixture.query.maximumQuoteAgeMs - 1).toISOString()
      const staleLog = log.map((record) => {
        const value = JSON.parse(record.value)
        if (record.topic !== source.topics.quotes || value.symbol !== 'AAPL') return record
        const encoded = JSON.stringify({
          ...value,
          eventTs: staleAt,
          ingestTs: staleAt,
          payload: { ...value.payload, t: staleAt },
        })
        return {
          ...record,
          value: encoded,
          rawByteLength: Buffer.byteLength(encoded),
          timestampMs: Date.parse(staleAt),
        }
      })
      const staleTransport = new RetainedLogTransport(staleLog, Object.values(source.topics))
      const stale = yield* readyLogProjection(staleTransport, source)
      const staleSnapshot = Result.getOrThrow(
        constructStreamingSnapshot(yield* stale.read, {
          ...queryB,
          observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        }),
      )
      expect(staleSnapshot.manifest.candidateExclusions).toContainEqual(
        expect.objectContaining({ symbol: 'AAPL', reason: 'freshness' }),
      )
      expect(Date.parse(staleSnapshot.latestQuotes['AAPL']?.eventAt ?? '')).toBe(Date.parse(staleAt))
      expect(staleSnapshot.manifest.rangeEndAt).toBe(fixture.query.rangeEndAt)
    }),
  )
})

test('a bounded simulated retained-log burst cannot block source bootstrap on a busy hint receiver', async () => {
  await program(
    Effect.gen(function* () {
      const fixture = streamingFixture()
      const now = Date.parse(fixture.query.observedAt)
      const source: StreamingUniverse = {
        universeId: fixture.protocol.universeId,
        universeSymbolHash: fixture.protocol.universeSymbolHash,
        symbols: fixture.protocol.universe,
        topics: { ...fixture.protocol.sourceTopics, features: fixture.protocol.streamingInput.featureTopic },
      }
      const original = historicalRawArrivals(fixture.snapshot, now).map(({ record }) => ({
        ...record,
        timestampMs: Date.parse(JSON.parse(record.value).ingestTs),
        leaderEpoch: 1,
        rawByteLength: Buffer.byteLength(record.value),
      }))
      const log: KafkaConsumedRecord[] = original.filter((record) => record.topic === source.topics.bars)
      for (const [topic, seconds] of [
        [source.topics.quotes, 310],
        [source.topics.trades, 1800],
      ] as const) {
        const templates = original.filter((record) => record.topic === topic).map((record) => JSON.parse(record.value))
        let offset = 0
        for (let second = seconds - 1; second >= 0; second--) {
          const eventAt = new Date(now - second * 1000).toISOString()
          for (const template of templates) {
            const value = JSON.stringify({
              ...template,
              eventTs: eventAt,
              ingestTs: eventAt,
              payload: { ...template.payload, t: eventAt },
            })
            log.push({
              topic,
              partition: 0,
              offset: String(offset++),
              value,
              timestampMs: Date.parse(eventAt),
              leaderEpoch: 1,
              rawByteLength: Buffer.byteLength(value),
            })
          }
        }
      }
      for (const feature of [...fixture.cut.projection.features.values()].flat()) {
        const value = JSON.stringify(feature.value)
        log.push({
          topic: feature.topic,
          partition: feature.partition,
          offset: feature.offset,
          timestampMs: feature.value.computedAtMs,
          value,
          leaderEpoch: 1,
          rawByteLength: Buffer.byteLength(value),
        })
      }
      yield* TestClock.setTime(now)
      const transport = new RetainedLogTransport(log, Object.values(source.topics))
      const hints = yield* makeMarketHints('a'.repeat(40), '96d77600-414a-4211-9342-f3a986254fbc')
      const release = yield* Deferred.make<void>()
      const ready = yield* Deferred.make<void>()
      const delivered = yield* Deferred.make<void>()
      const hintSequences: number[] = []
      yield* hints
        .serve((event) =>
          Effect.gen(function* () {
            hintSequences.push(event.sequence)
            if (hintSequences.length === 1) yield* Deferred.await(release)
            else yield* Deferred.succeed(delivered, undefined)
          }),
        )
        .pipe(Effect.forkScoped)
      const began = performance.now()
      const projection = yield* makeKafkaMarketProjection(config, [source], () => transport, undefined, undefined, {
        changed: (reason) =>
          hints
            .changed(reason)
            .pipe(
              Effect.andThen(
                reason === MarketChangeReason.Ready
                  ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
      })
      yield* Deferred.await(ready)
      const bootstrapElapsedMs = performance.now() - began
      const cut = yield* projection.read
      const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, fixture.query))
      expect(snapshot.manifest.candidateExclusions).toEqual([])
      const requestedStarts = new Map(transport.requested.map((position) => [position.topic, BigInt(position.offset)]))
      expect(transport.deliveredRecords).toBe(
        log.filter((record) => BigInt(record.offset) >= (requestedStarts.get(record.topic) ?? 0n)).length,
      )
      expect(transport.maximumQueuedRecords).toBe(256)
      expect([...cut.projection.quoteHistory.values()].every((history) => history.length <= 512)).toBe(true)
      expect([...cut.projection.tradeHistory.values()].every((history) => history.length <= 512)).toBe(true)
      expect(hintSequences).toHaveLength(1)
      const heldFirst = hintSequences[0]
      expect(heldFirst).toBeGreaterThanOrEqual(1)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(delivered)
      expect(hintSequences).toEqual([heldFirst, transport.deliveredRecords + 2])
      yield* Effect.logInfo('Simulated retained-log bootstrap measurement', {
        boundary:
          'in-memory timestamp lookup and a fixture queue capped at 256; excludes broker, network, SQL and SDK buffering',
        rateModel: 'one quote and one trade per second per sampled fixture symbol; not the measured live peak',
        sourceUniverseSymbols: source.symbols.length,
        sampledTickSymbols: new Set(fixture.snapshot.quotes.map((quote) => quote.symbol)).size,
        retainedRecords: log.length,
        consumedRecords: transport.deliveredRecords,
        consumedRawBytes: transport.deliveredRawBytes,
        maximumFixtureQueuedRecords: transport.maximumQueuedRecords,
        bootstrapElapsedMs,
        deliveredHints: hintSequences.length,
      })
    }),
  )
}, 30_000)

test('native retention observes the trading consumer cut, including rejected records and repeated deliveries', async () => {
  await program(
    Effect.gen(function* () {
      const transport = new FakeTransport()
      const captured: NativeArrivalObservation[] = []
      let captureEpoch: string | undefined
      const market = yield* makeKafkaMarketProjection(
        config,
        [universe],
        (_config, _epoch, identity, bytes) => {
          expect(identity).toBe(true)
          expect(bytes).toBe(true)
          return transport
        },
        undefined,
        (bootstrap, sources) =>
          Effect.sync(() => {
            captureEpoch = bootstrap.epoch
            expect(sources).toEqual([universe])
            return {
              flush: Effect.void,
              observe: (record) =>
                Effect.sync(() => {
                  captured.push(record)
                }),
              status: () => ({
                captureId: '0'.repeat(64),
                status: 'RECORDING',
                observedConsumerSequence: captured.length,
                durableConsumerSequence: 0,
                queuedCompressedBytes: 0,
                failure: null,
              }),
            }
          }),
      )
      yield* TestClock.adjust(1_000)
      const record = {
        topic: 'quotes',
        partition: 0,
        offset: '0',
        timestampMs: 900,
        leaderEpoch: 1,
        ...decodeKafkaTransportValue(Buffer.from('{'), true, true),
      }
      transport.send(record)
      transport.send(record)
      yield* TestClock.adjust(1_000)
      expect(captured).toHaveLength(2)
      expect(captured.map((record) => record.consumerSequence)).toEqual([1, 2])
      expect(captured.map((record) => record.disposition)).toEqual([
        CaptureDisposition.Rejected,
        CaptureDisposition.Ignored,
      ])
      expect(captured.map((record) => record.record.rawValue)).toEqual([Buffer.from('{'), Buffer.from('{')])
      expect(captured[0]?.availableAtMs).toBe(captured[1]?.availableAtMs)
      if (captureEpoch === undefined) throw new Error('Missing native capture epoch')
      expect((yield* market.status).epoch).toBe(captureEpoch)
    }),
  )
})

test('failed native retention releases Kafka consumption and preserves incomplete evidence across epoch recovery', async () => {
  const health = makeCaptureHealth()
  const transports: FakeTransport[] = []
  const captures: NativeArrivalCapture[] = []
  const chunks: NativeArrivalChunk[] = []
  const ends: NativeArrivalEnd[] = []
  await program(
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>()
      const failWriter = yield* Deferred.make<void>()
      const reportHealth = yield* observeCaptureWorker
      const recordHealth = Effect.gen(function* () {
        const now = (yield* Clock.currentTimeMillis) / 1000
        const sample = health.sample(now, now)
        reportHealth(sample)
        yield* TestClock.adjust('15 seconds')
        const metrics = yield* PrometheusMetrics.format()
        expect(metrics).toContain('bayn_capture_workers_expected 1\n')
        expect(metrics).toContain('bayn_capture_workers_unobserved 0\n')
        if (sample.terminalFailures === 0) expect(metrics).not.toContain('bayn_capture_terminal_failures_total')
        else expect(metrics).toContain(`bayn_capture_terminal_failures_total ${sample.terminalFailures}\n`)
        return sample
      })
      let appendCalls = 0
      const market = yield* makeKafkaMarketProjection(
        config,
        [universe],
        () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        },
        undefined,
        health.wrap((bootstrap, sources) =>
          Effect.gen(function* () {
            const build = nativeArrivalEpochFixture.build
            const capture = yield* makeNativeArrivalJournal(
              {
                ...nativeArrivalEpochFixture,
                captureId: Result.getOrThrow(nativeArrivalCaptureId(build, bootstrap, sources)),
                bootstrap,
                sources,
              },
              {
                begin: () => Effect.void,
                append: (batch) =>
                  Effect.gen(function* () {
                    if (++appendCalls === 1) {
                      yield* Deferred.succeed(writing, undefined)
                      yield* Deferred.await(failWriter)
                      return yield* Effect.die('synthetic native writer defect')
                    }
                    chunks.push(...batch)
                  }),
                end: (end) => Effect.sync(() => void ends.push(end)),
              },
              { chunkBytes: 1, queueBytes: 700 },
            )
            captures.push(capture)
            return capture
          }),
        ),
      )
      yield* TestClock.adjust(1_000)
      const first = transports[0]
      const capture = captures[0]
      if (first === undefined || capture === undefined) throw new Error('missing initial consumer capture')
      const initial = yield* market.read
      expect(yield* recordHealth).toMatchObject({ activeCaptures: 1, terminalFailures: 0, pendingStagnantSeconds: 0 })
      // Malformed records exercise exact delivery retention, not market-content validity or freshness.
      const record = (offset: string): KafkaConsumedRecord => ({
        topic: 'quotes',
        partition: 0,
        offset,
        timestampMs: 900,
        leaderEpoch: 1,
        ...decodeKafkaTransportValue(Buffer.from('{'), true, true),
      })
      first.send(record('0'))
      yield* Deferred.await(writing)
      first.send(record('1'))
      const pendingAt = (yield* Clock.currentTimeMillis) / 1000
      expect(health.sample(pendingAt, pendingAt).pendingStagnantSeconds).toBe(0)
      yield* TestClock.adjust(1_000)
      expect(health.sample(pendingAt + 1, pendingAt + 1).pendingStagnantSeconds).toBe(1)
      expect(capture.status()).toMatchObject({
        status: 'RECORDING',
        observedConsumerSequence: 2,
        durableConsumerSequence: 0,
      })
      yield* Deferred.succeed(failWriter, undefined)
      yield* TestClock.adjust(1_000)
      first.send(record('2'))
      yield* TestClock.adjust(1_000)
      expect(capture.status()).toMatchObject({
        status: 'INCOMPLETE',
        observedConsumerSequence: 3,
        durableConsumerSequence: 0,
      })
      expect((yield* market.read).projection.epoch).toBe(initial.projection.epoch)
      expect((yield* market.readForLiquidation).consumerSequence).toBe(3)
      expect(transports).toHaveLength(1)
      expect(yield* recordHealth).toMatchObject({ activeCaptures: 1, incompleteCaptures: 1, terminalFailures: 1 })
      first.invalidated?.(new Error('synthetic assignment replacement'))
      expect(Exit.isFailure(yield* Effect.exit(market.read))).toBe(true)
      yield* TestClock.adjust(3_000)
      expect(transports).toHaveLength(2)
      expect(captures).toHaveLength(2)
      expect((yield* market.read).projection.epoch).not.toBe(initial.projection.epoch)
      expect(captures[1]?.status()).toMatchObject({
        status: 'RECORDING',
        observedConsumerSequence: 0,
        durableConsumerSequence: 0,
      })
      expect(captures[1]?.status().captureId).not.toBe(capture.status().captureId)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({
        captureId: capture.status().captureId,
        status: 'INCOMPLETE',
        observedConsumerSequence: 3,
        durableConsumerSequence: 1,
      })
      expect(chunks).toHaveLength(1)
      expect(chunks[0]?.header.lastConsumerSequence).toBe(1)
      expect(chunks[0]?.header.captureId).toBe(capture.status().captureId)
      expect(ends[0]?.lastChunkHash).toBe(chunks[0]?.contentHash)
      const sealedEnd = structuredClone(ends[0])
      const sealedStatus = structuredClone(capture.status())
      const sealedChunk = structuredClone(chunks[0])
      expect(yield* recordHealth).toMatchObject({
        activeCaptures: 1,
        incompleteCaptures: 0,
        terminalFailures: 1,
        pendingStagnantSeconds: 0,
      })
      transports[1]?.send(record('0'))
      yield* TestClock.adjust(1_000)
      expect(captures[1]?.status()).toMatchObject({
        status: 'RECORDING',
        observedConsumerSequence: 1,
        durableConsumerSequence: 1,
      })
      expect(chunks).toHaveLength(2)
      expect(chunks[1]?.header.captureId).toBe(captures[1]?.status().captureId)
      expect(ends[0]?.status).toBe('INCOMPLETE')
      expect(yield* recordHealth).toMatchObject({ terminalFailures: 1, pendingStagnantSeconds: 0 })
      yield* TestClock.adjust('60 seconds')
      expect(yield* recordHealth).toMatchObject({ activeCaptures: 1, terminalFailures: 1, pendingStagnantSeconds: 0 })
      expect(ends).toHaveLength(1)
      expect(ends[0]).toEqual(sealedEnd)
      expect(capture.status()).toEqual(sealedStatus)
      expect(chunks[0]).toEqual(sealedChunk)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  )
  expect(health.sample(1000, 1000)).toMatchObject({ activeCaptures: 0, terminalFailures: 1 })
  expect(ends.map((end) => end.status)).toEqual(['INCOMPLETE', 'STOPPED'])
  expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
})

test('projection cuts preserve current offsets and fresh advancing outputs', async () => {
  await program(
    Effect.gen(function* () {
      const market = yield* makeKafkaMarketProjection(config, [universe], () => new FakeTransport())
      yield* TestClock.adjust(1000)
      const initial = yield* market.readForLiquidation
      expect(initial.consumerSequence).toBe(0)
      const position = initial.positions.find((row) => row.topic === 'quotes')
      if (position === undefined) throw new Error('missing quote position')
      const offsets = initial.projection.offsets as Map<string, string>
      const key = 'quotes:0'
      Object.assign(position, { offset: '10' })
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const read = () => runSync(market.readForLiquidation).positions
      yield* Effect.sync(() => {
        for (const last of ['9', '10', '12', '12', '8']) {
          offsets.set(key, last)
          const actual = read()
          const quote = actual.find((row) => row.topic === 'quotes')
          const advances = BigInt(last) >= 10n
          expect(quote?.offset).toBe(advances ? String(BigInt(last) + 1n) : '10')
          expect(quote === position).toBe(!advances)
          expect(actual).not.toBe(initial.positions)
        }
        offsets.set(key, '12')
        const first = read().find((row) => row.topic === 'quotes')
        const second = read().find((row) => row.topic === 'quotes')
        expect(first).not.toBe(second)
        Object.assign(first ?? {}, { offset: '999', topic: 'mutated-output' })
        expect(read().find((row) => row.topic === 'quotes')?.offset).toBe('13')
        Object.assign(position, { offset: '14' })
        expect(read().find((row) => row.topic === 'quotes')).toBe(position)
        for (const [base, last, expected] of [
          ['9007199254740992', '9007199254740992', '9007199254740993'],
          ['9223372036854775806', '9223372036854775806', '9223372036854775807'],
          ['9223372036854775807', '9223372036854775806', '9223372036854775807'],
        ] as const) {
          Object.assign(position, { offset: base })
          offsets.set(key, last)
          expect(read().find((row) => row.topic === 'quotes')?.offset).toBe(expected)
          expect(read().find((row) => row.topic === 'quotes')?.offset).toBe(expected)
        }
        offsets.delete(key)
        Object.defineProperty(position, 'offset', {
          configurable: true,
          enumerable: true,
          get: () => {
            throw new Error('missing last must not read base')
          },
        })
        expect(read().find((row) => row.topic === 'quotes')).toBe(position)
        Object.defineProperty(position, 'offset', { configurable: true, enumerable: true, writable: true, value: '0' })
      })
    }),
  )
})

test('projection cut offset coercions preserve failure and spread ordering', async () => {
  await program(
    Effect.gen(function* () {
      const market = yield* makeKafkaMarketProjection(config, [universe], () => new FakeTransport())
      yield* TestClock.adjust(1000)
      const initial = yield* market.readForLiquidation
      const position = initial.positions.find((row) => row.topic === 'quotes')
      if (position === undefined) throw new Error('missing quote position')
      const offsets = initial.projection.offsets as Map<string, unknown>
      const calls: string[] = []
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const read = () => runSync(market.readForLiquidation)
      yield* Effect.sync(() => {
        offsets.set('quotes:0', 'invalid')
        Object.defineProperty(position, 'offset', {
          configurable: true,
          enumerable: true,
          get: () => {
            calls.push('base:get')
            return '0'
          },
        })
        expect(read).toThrow()
        expect(calls).toEqual([])
        let conversions = 0
        offsets.set('quotes:0', {
          [Symbol.toPrimitive]: () => {
            calls.push(`last:${++conversions}`)
            return conversions === 1 ? '2' : '3'
          },
        })
        Object.defineProperty(position, 'offset', {
          configurable: true,
          enumerable: true,
          get: () => {
            calls.push('base:get')
            return {
              [Symbol.toPrimitive]: () => {
                calls.push('base:convert')
                return '1'
              },
            }
          },
        })
        expect(read().positions.find((row) => row.topic === 'quotes')?.offset).toBe('4')
        expect(calls).toEqual(['last:1', 'base:get', 'base:convert', 'base:get', 'last:2'])
        calls.length = 0
        offsets.set('quotes:0', '3')
        Object.defineProperty(position, 'offset', {
          configurable: true,
          enumerable: true,
          get: () => {
            calls.push('base:get')
            return 'invalid'
          },
        })
        expect(read).toThrow()
        expect(calls).toEqual(['base:get'])
        Object.defineProperty(position, 'offset', { configurable: true, enumerable: true, writable: true, value: '0' })
        expect(read().positions.find((row) => row.topic === 'quotes')?.offset).toBe('4')
        offsets.set('quotes:0', 'invalid')
        expect(read).toThrow()
        offsets.set('quotes:0', '4')
        expect(read().positions.find((row) => row.topic === 'quotes')?.offset).toBe('5')
      })
    }),
  )
})

test('projection cuts follow replaced positions and reject an invalidated epoch', async () => {
  const transports: FakeTransport[] = []
  await program(
    Effect.gen(function* () {
      const market = yield* makeKafkaMarketProjection(config, [universe], () => {
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
      })
      yield* TestClock.adjust(1000)
      const initial = yield* market.readForLiquidation
      ;(initial.projection.offsets as Map<string, string>).set('quotes:0', '9')
      expect((yield* market.readForLiquidation).positions.find((row) => row.topic === 'quotes')?.offset).toBe('10')
      const transport = transports[0]
      if (transport === undefined) throw new Error('missing transport')
      transport.drained = positions('20')
      yield* TestClock.adjust(1000)
      const replaced = yield* market.readForLiquidation
      expect(replaced.positions.find((row) => row.topic === 'quotes')?.offset).toBe('20')
      expect(replaced.deliveredPositions.every((row) => row.offset === '0')).toBeTrue()
      transport.invalidated?.(new Error('replace test epoch'))
      expect(Result.isFailure(yield* market.readForLiquidation.pipe(Effect.result))).toBe(true)
      yield* TestClock.adjust(3000)
      const recovered = yield* market.readForLiquidation
      expect(recovered.projection.epoch).not.toBe(initial.projection.epoch)
      expect(recovered.positions.every((row) => row.offset === '0')).toBe(true)
      expect(transports.length).toBe(2)
    }),
  )
})

test('Kafka capture hashes exact bytes before UTF8 replacement and distinguishes tombstones from empty payloads', () => {
  const left = decodeKafkaTransportValue(Buffer.from([0x80]), true)
  const right = decodeKafkaTransportValue(Buffer.from([0x81]), true)
  expect(left.value).toBe(right.value)
  expect(left.rawValueSha256).not.toBe(right.rawValueSha256)
  expect(left.rawValueSha256).toBe(sha256(Buffer.from([0x80])))
  expect(decodeKafkaTransportValue(Buffer.from('é'), true)).toEqual({
    value: 'é',
    rawValueSha256: sha256(Buffer.from('é')),
    rawByteLength: 2,
  })
  expect(decodeKafkaTransportValue(undefined, true)).toEqual({
    value: '',
    tombstone: true,
    rawValueSha256: null,
    rawByteLength: null,
  })
  expect(decodeKafkaTransportValue(Buffer.alloc(0), true)).toEqual({
    value: '',
    rawValueSha256: sha256(Buffer.alloc(0)),
    rawByteLength: 0,
  })
  expect(() => decodeKafkaTransportValue(undefined)).toThrow('Kafka market message has no payload')
  expect(decodeKafkaTransportValue(Buffer.from('é'))).toEqual({ value: 'é', rawByteLength: 2 })
  const binary = Buffer.from([0x80])
  expect(decodeKafkaTransportValue(binary, true, true).rawValue).toBe(binary)
  expect(decodeKafkaTransportValue(undefined, true, true).rawValue).toBeNull()
  expect(decodeKafkaTransportValue(Buffer.alloc(0), true, true).rawValue).toEqual(Buffer.alloc(0))
  expect(decodeKafkaTransportValue(binary, true).rawValue).toBeUndefined()
})

test('Kafka payload sizes are exact without enabling hashes or raw-value retention', () => {
  for (const bytes of [Buffer.from('é'), Buffer.from([0x80]), Buffer.alloc(0)]) {
    expect(decodeKafkaTransportValue(bytes)).toEqual({
      value: bytes.toString('utf-8'),
      rawByteLength: bytes.byteLength,
    })
  }
})

describe('Kafka bootstrap and scoped consumption', () => {
  test('live workers retain entry charts and warm only recent pricing history for disabled markets', async () => {
    const equity = { ...universe, topics: { ...universe.topics, webullBars: 'webull' } }
    const crypto: StreamingUniverse = {
      universeId: 'crypto',
      universeSymbolHash: '1'.repeat(64),
      symbols: ['ETH/USD'],
      topics: { bars: 'crypto', quotes: 'crypto', trades: 'crypto', features: 'crypto-features' },
    }
    const bounds = [
      ...positions('100'),
      { topic: 'webull', partition: 0, offset: '100' },
      ...['crypto', 'crypto-features'].map((topic) => ({
        topic,
        partition: 0,
        offset: '100',
      })),
    ]
    const transport = new FakeTransport()
    const seeks: { topics: readonly string[]; timestamp: bigint }[] = []
    transport.offsets = async (topics, timestamp) => {
      if (timestamp >= 0n) seeks.push({ topics, timestamp })
      return bounds
        .filter((position) => topics.includes(position.topic))
        .map((position) => ({ ...position, offset: timestamp === -1n ? position.offset : '0' }))
    }
    const consume = transport.consume
    let requested: readonly KafkaPartitionPosition[] = []
    transport.consume = async (starts, invalidated, progressed) => {
      requested = starts
      transport.drained = starts
      return consume(starts, invalidated, progressed)
    }
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-10-29T01:00:03.000Z'))
        const projection = yield* makeKafkaMarketProjection(config, [equity, crypto], () => transport)
        yield* TestClock.adjust('1 second')
        expect(seeks).toEqual([
          { topics: ['bars', 'features'], timestamp: BigInt(Date.parse('2026-10-29T00:29:55.000Z')) },
          { topics: ['quotes'], timestamp: BigInt(Date.parse('2026-10-29T00:59:43.000Z')) },
          { topics: ['trades'], timestamp: BigInt(Date.parse('2026-10-29T00:29:50.000Z')) },
          {
            topics: ['webull', 'crypto', 'crypto-features'],
            timestamp: BigInt(Date.parse('2026-10-29T00:57:55.000Z')),
          },
        ])
        expect(requested.filter((position) => ['quotes', 'trades'].includes(position.topic))).toEqual(
          bounds
            .filter((position) => ['quotes', 'trades'].includes(position.topic))
            .map((position) => ({ ...position, offset: '0' })),
        )
        expect(
          requested
            .filter((position) => !['quotes', 'trades'].includes(position.topic))
            .every((position) => position.offset === '0'),
        ).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        transport.drained = bounds.map((position) => ({
          ...position,
          offset: ['crypto', 'webull'].includes(position.topic) ? '99' : position.offset,
        }))
        yield* TestClock.adjust('1 second')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        transport.drained = bounds.map((position) => ({
          ...position,
          offset: position.topic === 'webull' ? '99' : position.offset,
        }))
        yield* TestClock.adjust('1 second')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        transport.drained = bounds
        yield* TestClock.adjust('1 second')
        const cut = yield* projection.read
        expect(cut.projection.quotes.size).toBe(0)
        expect(kafkaBootstrapComplete(cut.bootstrap, cut.positions)).toBe(true)
        yield* TestClock.adjust('6 seconds')
        expect((yield* projection.read).projection.epoch).toBe(cut.projection.epoch)
        expect(transport.closeCount).toBe(0)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('explicit historical diagnostics retain equity and disabled-market history', async () => {
    const equity = { ...universe, topics: { ...universe.topics, webullBars: 'webull' } }
    const crypto: StreamingUniverse = {
      universeId: 'crypto',
      universeSymbolHash: '1'.repeat(64),
      symbols: ['ETH/USD'],
      topics: { bars: 'crypto', quotes: 'crypto', trades: 'crypto', features: 'crypto-features' },
    }
    const topics = [...Object.values(equity.topics), 'crypto', 'crypto-features']
    const bounds = (offset: string) => topics.map((topic) => ({ topic, partition: 0, offset }))
    const transport = new FakeTransport()
    const seeks: { topics: readonly string[]; timestamp: bigint }[] = []
    transport.offsets = async (topics, timestamp) => {
      if (timestamp >= 0n) seeks.push({ topics, timestamp })
      return bounds(timestamp === -1n ? '100' : '0')
    }
    const consume = transport.consume
    let requested: readonly KafkaPartitionPosition[] = []
    transport.consume = async (starts, invalidated, progressed) => {
      requested = starts
      transport.drained = starts
      return consume(starts, invalidated, progressed)
    }
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [equity, crypto], () => transport, 0)
        yield* TestClock.adjust('1 second')
        expect(seeks).toEqual([{ topics, timestamp: 0n }])
        expect(requested).toEqual(bounds('0').toSorted((a, b) => a.topic.localeCompare(b.topic)))
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        transport.drained = bounds('100')
        yield* TestClock.adjust('1 second')
        expect(kafkaBootstrapComplete((yield* projection.read).bootstrap, bounds('100'))).toBe(true)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('rebuilds retained RTH history without a new lookback wait or backdated availability', async () => {
    const fixture = streamingFixture()
    const bootAtMs = Date.parse(fixture.query.observedAt) + 1000
    const retainedUniverse: StreamingUniverse = {
      universeId: fixture.protocol.universeId,
      universeSymbolHash: fixture.protocol.universeSymbolHash,
      symbols: fixture.protocol.universe,
      topics: { ...fixture.protocol.sourceTopics, features: fixture.protocol.streamingInput.featureTopic },
    }
    const records: KafkaConsumedRecord[] = [
      ...historicalRawArrivals(fixture.snapshot, bootAtMs).map(({ record }) => ({
        ...record,
        timestampMs: Date.parse(JSON.parse(record.value).ingestTs),
        leaderEpoch: 1,
      })),
      ...[...fixture.cut.projection.features.values()].flat().map((feature) => ({
        topic: feature.topic,
        partition: feature.partition,
        offset: feature.offset,
        timestampMs: feature.value.computedAtMs,
        value: JSON.stringify(feature.value),
        leaderEpoch: 1,
      })),
    ].sort(
      (a, b) =>
        a.topic.localeCompare(b.topic) || a.partition - b.partition || Number(BigInt(a.offset) - BigInt(b.offset)),
    )
    const delayedBars = records.filter((record) => record.topic === retainedUniverse.topics.bars)
    if (delayedBars.length === 0) throw new Error('retained bar fixture is empty')
    const tickTopics = [retainedUniverse.topics.quotes, retainedUniverse.topics.trades]
    const ticks = records.filter((record) => tickTopics.includes(record.topic))
    const transport = new FakeTransport()
    transport.drained = undefined
    transport.queue = records.filter(
      (record) => record.topic !== retainedUniverse.topics.bars && !tickTopics.includes(record.topic),
    )
    transport.offsets = async (topics, timestamp) => {
      transport.lookups.push(timestamp)
      return fixture.cut.positions
        .filter((position) => topics.includes(position.topic))
        .map((position) => ({
          ...position,
          offset: timestamp === -1n ? position.offset : '0',
        }))
    }
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(bootAtMs)
        const projection = yield* makeKafkaMarketProjection(config, [retainedUniverse], () => transport)
        yield* TestClock.adjust('1 second')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        for (const record of delayedBars) transport.send(record)
        yield* TestClock.adjust('1 second')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        const awaitingQuotes = yield* projection.readForLiquidation
        expect(awaitingQuotes.projection.quotes.size).toBe(0)
        expect(
          Result.isFailure(
            constructStreamingSnapshot(awaitingQuotes, {
              ...fixture.query,
              observedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
            }),
          ),
        ).toBe(true)
        const nextOffsets = new Map(
          fixture.cut.positions.map((position) => [`${position.topic}:${position.partition}`, BigInt(position.offset)]),
        )
        const tickAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        for (const record of ticks) {
          const key = `${record.topic}:${record.partition}`
          const offset = nextOffsets.get(key)
          if (offset === undefined) throw new Error('tick partition missing')
          nextOffsets.set(key, offset + 1n)
          const value = JSON.parse(record.value)
          transport.send({
            ...record,
            offset: String(offset),
            timestampMs: Date.parse(tickAt),
            value: JSON.stringify({
              ...value,
              eventTs: tickAt,
              ingestTs: tickAt,
              payload: { ...value.payload, t: tickAt },
            }),
          })
        }
        yield* TestClock.adjust('1 second')
        const cut = yield* projection.read
        const observedAtMs = yield* Clock.currentTimeMillis
        expect(observedAtMs - bootAtMs).toBe(3000)
        expect(kafkaBootstrapComplete(cut.bootstrap, cut.positions)).toBe(true)
        expect(transport.lookups).toContain(BigInt(Date.parse(fixture.query.rangeStartAt) - 5000))
        const snapshot = Result.getOrThrow(
          constructStreamingSnapshot(cut, { ...fixture.query, observedAt: new Date(observedAtMs).toISOString() }),
        )
        expect(snapshot.bars.map((bar) => Result.getOrThrow(featureBarContentHash(bar)))).toEqual(
          fixture.snapshot.bars.map((bar) => Result.getOrThrow(featureBarContentHash(bar))),
        )
        expect(snapshot.manifest.streaming.records.every((receipt) => receipt.availableAtMs >= bootAtMs)).toBe(true)
        expect(snapshot.manifest.streaming.features.every((receipt) => receipt.availableAtMs >= bootAtMs)).toBe(true)
        expect(snapshot.manifest.streaming.features.map(({ value }) => value)).toEqual(
          fixture.snapshot.manifest.streaming.features.map(({ value }) => value),
        )
        expect(
          Result.isFailure(
            constructStreamingSnapshot(cut, {
              ...fixture.query,
              observedAt: new Date(bootAtMs + 500).toISOString(),
            }),
          ),
        ).toBe(true)
        const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
        expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))).toEqual(snapshot)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test.each(['rejected', 'stalled'] as const)(
    'ephemeral projection needs no offset commits even when commits would be %s',
    async (commitFailure) => {
      const transports: FakeTransport[] = []
      let commitAttempts = 0
      await program(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
          const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
            const transport = new FakeTransport()
            transport.commit = () => {
              commitAttempts++
              return commitFailure === 'stalled'
                ? new Promise<void>(() => {})
                : Promise.reject(new Error('OffsetCommit coordinator unavailable'))
            }
            transports.push(transport)
            return transport
          })
          yield* TestClock.adjust('2 seconds')
          const initial = yield* projection.read
          const transport = transports[0]
          if (transport === undefined) throw new Error('transport missing')
          for (const offset of ['0', '1']) {
            const at = yield* Clock.currentTimeMillis
            transport.send({
              topic: 'quotes',
              partition: 0,
              offset,
              value: JSON.stringify({
                provider: 'alpaca',
                feed: 'iex',
                delayClass: 'real_time_exchange_only',
                marketSession: 'regular',
                channel: 'quotes',
                symbol: 'AAPL',
                eventTs: new Date(at).toISOString(),
                ingestTs: new Date(at).toISOString(),
                version: 2,
                payload: { t: new Date(at).toISOString(), bp: 100 + Number(offset), ap: 102, bs: 10, as: 10 },
              }),
              timestampMs: at,
              leaderEpoch: 1,
            })
            yield* TestClock.adjust('4 seconds')
          }
          const cut = yield* projection.read
          expect(cut.projection.epoch).toBe(initial.projection.epoch)
          expect(cut.projection.quotes.get('AAPL')?.value.bidPrice).toBe(101)
          expect(cut.positions.find((position) => position.topic === 'quotes')?.offset).toBe('2')
          expect(cut.projection.rejections.size).toBe(0)
          expect(transport.closeCount).toBe(0)
          expect(transports).toHaveLength(1)
          expect(commitAttempts).toBe(0)
        }),
      )
      expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
    },
  )

  test('exposes a liquidation cut during history rebuild and invalidates it immediately on reassignment', async () => {
    const transport = new FakeTransport()
    transport.offsets = async (topics, timestamp) =>
      positions('0')
        .filter((position) => topics.includes(position.topic))
        .map((position) => ({
          ...position,
          offset: timestamp === -1n && position.topic !== universe.topics.quotes ? '100' : '0',
        }))
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => transport)
        yield* TestClock.adjust('2 seconds')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        const cut = yield* projection.readForLiquidation
        expect(kafkaBootstrapComplete(cut.bootstrap, cut.positions)).toBe(false)
        transport.invalidated?.(new Error('assignment changed'))
        expect(Exit.isFailure(yield* Effect.exit(projection.readForLiquidation))).toBe(true)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('periodic measurements report lookup failure as unknown and close with their consumer scope', async () => {
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    const transport = new FakeTransport()
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => transport)
        yield* TestClock.adjust('2 seconds')
        transport.offsets = async () => {
          throw new AuthenticationError('private authentication detail')
        }
        yield* TestClock.adjust('30 seconds')
        expect(logs).toContainEqual([
          'Kafka market projection measurements',
          expect.objectContaining({
            bootstrapComplete: true,
            queuedRecords: 0,
            endOffsetLookupFailure: 'Kafka read failed',
            endOffsetLookupFailureCodes: ['PLT_KFK_AUTHENTICATION'],
            partitions: expect.arrayContaining(
              positions('0').map((position) => ({ ...position, endOffset: null, lagOffsets: null })),
            ),
          }),
        ])
        expect((yield* projection.read).projection.sequence).toBe(0)
        expect(transport.closeCount).toBe(0)
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('delivery measurements count ignored and rejected payloads and reset with the consumer epoch', async () => {
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    const transports: FakeTransport[] = []
    const payloads = [Buffer.from([0x80]), Buffer.from([0x80]), Buffer.alloc(0)]
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
        const market = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('2 seconds')
        const first = transports[0]
        if (first === undefined) throw new Error('first transport missing')
        const firstEpoch = (yield* market.read).projection.epoch
        payloads.forEach((bytes, index) =>
          first.send({
            topic: 'quotes',
            partition: 0,
            offset: String(Math.max(0, index - 1)),
            timestampMs: 0,
            leaderEpoch: 1,
            ...decodeKafkaTransportValue(bytes),
          }),
        )
        first.send({ topic: 'quotes', partition: 0, offset: '2', value: '', timestampMs: 0, leaderEpoch: 1 })
        first.send({
          topic: 'quotes',
          partition: 0,
          offset: '3',
          value: '',
          timestampMs: 0,
          leaderEpoch: 1,
          rawByteLength: -1,
        })
        yield* TestClock.adjust('30 seconds')
        expect(logs).toContainEqual([
          'Kafka market projection measurements',
          expect.objectContaining({
            epoch: firstEpoch,
            sequence: 4,
            consumerSequence: 5,
            consumerKnownRawBytes: 2,
            consumerUnknownRawByteLengthRecords: 2,
            arrivalEnvelope: expect.objectContaining({
              schemaVersion: 'bayn.kafka-arrival-envelope.v1',
              valid: true,
              observedRecordCount: 5,
              knownRawBytes: 2,
              unknownRawByteLengthRecords: 2,
              windows: [1, 10, 100, 1000].map((windowMs) => ({
                windowMs,
                maximumAlignedWindowRecords: 5,
                maximumWindowRecordsUpperBound: 5,
                maximumAlignedWindowKnownRawBytes: 2,
                maximumWindowRawBytesUpperBound: null,
              })),
            }),
          }),
        ])
        first.invalidated?.(new Error('assignment changed'))
        yield* TestClock.adjust('3 seconds')
        const replacementEpoch = (yield* market.read).projection.epoch
        expect(replacementEpoch).not.toBe(firstEpoch)
        yield* TestClock.adjust('30 seconds')
        expect(logs).toContainEqual([
          'Kafka market projection measurements',
          expect.objectContaining({
            epoch: replacementEpoch,
            sequence: 0,
            consumerSequence: 0,
            consumerKnownRawBytes: 0,
            consumerUnknownRawByteLengthRecords: 0,
            arrivalEnvelope: expect.objectContaining({
              valid: true,
              firstObservedAtMs: null,
              lastObservedAtMs: null,
              observedRecordCount: 0,
              knownRawBytes: 0,
              unknownRawByteLengthRecords: 0,
              windows: [1, 10, 100, 1000].map((windowMs) => ({
                windowMs,
                maximumAlignedWindowRecords: 0,
                maximumWindowRecordsUpperBound: 0,
                maximumAlignedWindowKnownRawBytes: 0,
                maximumWindowRawBytesUpperBound: 0,
              })),
            }),
          }),
        ])
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(transports).toHaveLength(2)
    expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
  })

  test('an epoch failing before its first periodic report still finalizes its observed arrival burst', async () => {
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    const transports: FakeTransport[] = []
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
        const market = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('2 seconds')
        const first = transports[0]
        if (first === undefined) throw new Error('first transport missing')
        const epoch = (yield* market.read).projection.epoch
        for (let index = 0; index < 3; index++)
          first.send({
            topic: 'quotes',
            partition: 0,
            offset: String(index),
            value: 'invalid-json',
            rawByteLength: 12,
            timestampMs: 0,
            leaderEpoch: 1,
          })
        yield* TestClock.adjust('1 second')
        first.invalidated?.(new Error('assignment changed'))
        yield* TestClock.adjust('3 seconds')
        expect(logs.some((entry) => Array.isArray(entry) && entry[0] === 'Kafka market projection measurements')).toBe(
          false,
        )
        expect(logs).toContainEqual([
          'Kafka market projection arrival measurements finalized',
          expect.objectContaining({
            epoch,
            consumerSequence: 3,
            arrivalEnvelope: expect.objectContaining({
              valid: true,
              observedRecordCount: 3,
              knownRawBytes: 36,
              unknownRawByteLengthRecords: 0,
              windows: [1, 10, 100, 1000].map((windowMs) => ({
                windowMs,
                maximumAlignedWindowRecords: 3,
                maximumWindowRecordsUpperBound: 3,
                maximumAlignedWindowKnownRawBytes: 36,
                maximumWindowRawBytesUpperBound: 36,
              })),
            }),
          }),
        ])
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
    expect(
      logs.filter(
        (entry) => Array.isArray(entry) && entry[0] === 'Kafka market projection arrival measurements finalized',
      ),
    ).toHaveLength(transports.length)
  })

  test.each(['rolling', 'technical'] as const)(
    '%s feature arrival receipts are emitted once after incorporation, excluding transport and semantic retries',
    async (family) => {
      const fixture: unknown = JSON.parse(
        readFileSync(new URL('../features/fixtures/observed-price-window-v1.json', import.meta.url), 'utf8'),
      )
      const feature =
        family === 'technical'
          ? Result.getOrThrow(decodeTechnicalMarketFeature(technicalFixture))
          : Result.getOrThrow(decodeRollingMarketFeature(fixture))
      const technicalTopic = 'torghut.technical-features.v1'
      const featureTopic = family === 'technical' ? technicalTopic : universe.topics.features
      const logMessage = family === 'technical' ? 'Kafka technical feature incorporated' : 'Kafka feature incorporated'
      const input = feature.material.inputs[0]
      if (input === undefined) throw new Error('fixture has no input')
      const featureUniverse = {
        ...universe,
        universeId: feature.material.universeId,
        universeSymbolHash: feature.material.universeSymbolHash,
        topics: {
          ...universe.topics,
          bars: input.sourceTopic,
          ...(family === 'technical' ? { technicalFeatures: technicalTopic } : {}),
        },
      }
      const logs: unknown[] = []
      const logger = Logger.make(({ message }) => logs.push(message))
      const transport = new FakeTransport()
      const bounds = Object.values(featureUniverse.topics).map((topic) => ({ topic, partition: 0, offset: '0' }))
      const requestedTopics: readonly string[][] = []
      const lookups = [...requestedTopics]
      transport.offsets = async (topics) => {
        lookups.push([...topics])
        return bounds.filter((position) => topics.includes(position.topic))
      }
      transport.drained = bounds
      await program(
        Effect.gen(function* () {
          yield* TestClock.setTime(feature.computedAtMs + 1000)
          const projection = yield* makeKafkaMarketProjection(config, [featureUniverse], () => transport)
          yield* TestClock.adjust('100 millis')
          const record = {
            topic: featureTopic,
            partition: 0,
            offset: '0',
            value: JSON.stringify(feature),
            timestampMs: feature.computedAtMs,
            leaderEpoch: 1,
          }
          transport.send(record)
          yield* TestClock.adjust('100 millis')
          expect((yield* projection.status).ready).toBe(true)
          transport.send(record)
          transport.send({ ...record, offset: '1' })
          yield* TestClock.adjust('1 second')
          const state = (yield* projection.read).projection
          expect((family === 'technical' ? state.technicalFeatures : state.features).get('AAPL')).toHaveLength(1)
          expect(lookups.slice(0, 2).every((topics) => topics.includes(featureTopic))).toBe(true)
          expect(lookups.slice(2).filter((topics) => topics.includes(featureTopic))).toHaveLength(1)
          expect(logs.filter((message) => Array.isArray(message) && message[0] === logMessage)).toEqual([
            [
              logMessage,
              expect.objectContaining({
                featureId: feature.featureId,
                computedAtMs: feature.computedAtMs,
                offset: '0',
                bootstrapEndOffset: '0',
                retainedAtBootstrap: false,
              }),
            ],
          ])
        }).pipe(Effect.provide(Logger.layer([logger]))),
      )
      expect(transport.closeCount).toBe(1)
    },
  )

  test('a slow optional lookup leaves the live projection and consumer running', async () => {
    const transport = new FakeTransport()
    let finishLookup: ((value: readonly KafkaPartitionPosition[]) => void) | undefined
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => transport)
        yield* TestClock.adjust('2 seconds')
        const original = yield* projection.read
        transport.offsets = () =>
          new Promise((resolve) => {
            finishLookup = resolve
          })
        yield* TestClock.adjust('33 seconds')
        expect(transport.closeCount).toBe(0)
        expect((yield* projection.read).projection.epoch).toBe(original.projection.epoch)
        expect(finishLookup).toBeDefined()
        finishLookup?.(positions('0'))
        yield* TestClock.adjust('1 second')
        expect((yield* projection.read).projection.epoch).toBe(original.projection.epoch)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('binds empty partitions and gaps without assuming contiguous message offsets', () => {
    const partitions = bootstrapKafkaPartitions(positions('10'), positions('100'), positions('-1'))
    expect(partitions.every((partition) => partition.startOffset === '100')).toBe(true)
    const evidence: KafkaBootstrapEvidence = {
      schemaVersion: 'bayn.kafka-bootstrap.v1',
      epoch: 'test',
      observedAtMs: 1,
      lowerTimestampMs: 0,
      timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
      partitions,
    }
    expect(kafkaBootstrapComplete(evidence, positions('100'))).toBe(true)
    expect(kafkaBootstrapComplete(evidence, positions('99'))).toBe(false)
    expect(() => bootstrapKafkaPartitions(positions('11'), positions('100'), positions('10'))).toThrow('retention')
    expect(() => bootstrapKafkaPartitions(positions('10').slice(1), positions('100'), positions('10'))).toThrow(
      'partition set',
    )
  })

  test('replacement workers seek history, wait for barriers, and close an idle iterator exactly once', async () => {
    const transport = new FakeTransport()
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => transport)
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        yield* TestClock.adjust('2 seconds')
        const cut = yield* projection.read
        expect(cut.projection.sequence).toBe(0)
        expect(transport.lookups).toEqual([
          -2n,
          -1n,
          BigInt(Date.parse('2026-09-11T13:29:55Z')),
          BigInt(Date.parse('2026-09-11T13:59:42Z')),
          BigInt(Date.parse('2026-09-11T13:29:50Z')),
        ])
        expect(cut.bootstrap.epoch).toBe(cut.projection.epoch)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('positions follow rejection incorporation and reassignment revokes readiness immediately', async () => {
    const transports: FakeTransport[] = []
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-11T14:00:02Z'))
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('2 seconds')
        const transport = transports[0]
        if (transport === undefined) throw new Error('transport missing')
        const prior = yield* projection.read
        transport.send({
          topic: 'quotes',
          partition: 0,
          offset: '0',
          value: 'invalid JSON',
          timestampMs: yield* Clock.currentTimeMillis,
          leaderEpoch: 1,
        })
        yield* TestClock.adjust('2 seconds')
        const cut = yield* projection.read
        expect(cut.projection.rejections.size).toBe(1)
        expect(cut.positions.find((position) => position.topic === 'quotes')?.offset).toBe('1')
        expect(transport.commits).toHaveLength(0)
        transport.invalidated?.(new Error('reassigned'))
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        yield* TestClock.adjust('3 seconds')
        const replacement = yield* projection.read
        expect(replacement.projection.epoch).not.toBe(prior.projection.epoch)
        expect(replacement.projection.sequence).toBe(0)
        expect(transport.closeCount).toBe(1)
      }),
    )
    expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
  })

  test('late invalidation from a closed consumer cannot poison its replacement', async () => {
    const transports: FakeTransport[] = []
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('2 seconds')
        const first = transports[0]
        if (first === undefined) throw new Error('first transport missing')
        first.invalidated?.(new Error('connection lost'))
        yield* TestClock.adjust('3 seconds')
        const replacement = yield* projection.read
        expect(first.closed).toBe(true)
        first.invalidated?.(new Error('delayed heartbeat from closed consumer'))
        expect((yield* projection.read).projection.epoch).toBe(replacement.projection.epoch)
        yield* TestClock.adjust('2 seconds')
        expect((yield* projection.status).failure).toBeUndefined()
        expect((yield* projection.readForLiquidation).projection.epoch).toBe(replacement.projection.epoch)
        expect(transports).toHaveLength(2)
        transports[1]?.invalidated?.(new Error('current consumer invalidation'))
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(projection.readForLiquidation))).toBe(true)
      }),
    )
    expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
  })

  test('reports a local bootstrap deadline distinctly while preserving fail-closed retry and cleanup', async () => {
    const transports: FakeTransport[] = []
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          if (transports.length === 0)
            transport.offsets = async (topics, timestamp) =>
              positions(timestamp === -1n ? '1' : '0').filter((position) => topics.includes(position.topic))
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('5 seconds')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        expect(transports).toHaveLength(1)
        yield* TestClock.adjust('2 seconds')
        expect(logs).toContainEqual([
          'Kafka market projection cycle failed',
          expect.objectContaining({
            operation: 'bootstrap',
            reason: 'BOOTSTRAP_DEADLINE_EXCEEDED',
            failureCodes: [],
            retryableBySupervisor: true,
          }),
        ])
        expect(transports[0]?.closeCount).toBe(1)
        yield* TestClock.adjust('3 seconds')
        expect((yield* projection.status).failure).toBeUndefined()
        yield* projection.read
        expect(logs).toContainEqual([
          'Kafka market projection recovered',
          expect.objectContaining({ reason: 'BOOTSTRAP_DEADLINE_EXCEEDED' }),
        ])
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(transports).toHaveLength(2)
    expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
  })

  test('retains the first invalidation cause and reports recovery without private transport details', async () => {
    const transports: FakeTransport[] = []
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    const firstCause = new AuthenticationError('private transport credential detail')
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('2 seconds')
        const prior = yield* projection.read
        const first = transports[0]
        if (first === undefined) throw new Error('First transport missing')
        first.invalidated?.(firstCause)
        first.invalidated?.(new Error('secondary stream failure'))
        const invalid = yield* Effect.result(projection.read)
        if (Result.isSuccess(invalid)) throw new Error('Invalidated epoch remained readable')
        expect(invalid.failure.cause).toBe(firstCause)
        yield* TestClock.adjust('3 seconds')
        expect((yield* projection.read).projection.epoch).not.toBe(prior.projection.epoch)
        expect(logs).toContainEqual([
          'Kafka market projection cycle failed',
          expect.objectContaining({ reason: 'TRANSPORT_FAILURE', failureCodes: ['PLT_KFK_AUTHENTICATION'] }),
        ])
        expect(logs).toContainEqual([
          'Kafka market projection recovered',
          expect.objectContaining({ failedEpoch: prior.projection.epoch }),
        ])
        expect(JSON.stringify(logs)).not.toContain('private transport credential detail')
        expect(first.closeCount).toBe(1)
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
  })

  test('invalidation without a cause still revokes the epoch and rebuilds', async () => {
    const transports: FakeTransport[] = []
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('2 seconds')
        const prior = yield* projection.read
        const first = transports[0]
        if (first === undefined) throw new Error('first transport missing')
        first.invalidated?.(undefined)
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        yield* TestClock.adjust('3 seconds')
        const replacement = yield* projection.read
        expect(replacement.projection.epoch).not.toBe(prior.projection.epoch)
        expect((yield* projection.status).failure).toBeUndefined()
        expect(first.closed).toBe(true)
        expect(transports).toHaveLength(2)
      }),
    )
  })

  test('rebuilds after bounded connection failure and cooldown without a read', async () => {
    let attempts = 0
    let recovered = false
    const transport = new FakeTransport()
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          attempts++
          if (!recovered) throw new Error('connection unavailable')
          return transport
        })
        yield* TestClock.adjust('5 seconds')
        expect(attempts).toBe(3)
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        recovered = true
        yield* TestClock.adjust('31 seconds')
        expect(attempts).toBe(4)
        expect((yield* projection.status).ready).toBe(true)
        expect((yield* projection.read).projection.sequence).toBe(0)
      }),
    )
    expect(transport.closeCount).toBe(1)
  })

  test('rebuilds after local shutdown despite an unavailable group coordinator without the fatal-close cooldown', async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    const close = first.close
    first.close = async () => {
      await close()
      return { _tag: 'ClosedAfterCoordinatorFailure', cause: new ProtocolError('COORDINATOR_NOT_AVAILABLE') }
    }
    let attempts = 0
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          attempts++
          if (attempts === 1) return first
          expect(first.closed).toBe(true)
          return second
        })
        yield* TestClock.adjust('2 seconds')
        const initial = yield* projection.read
        first.invalidated?.(new Error('fetch session failed'))
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        yield* TestClock.adjust('3 seconds')
        expect(attempts).toBe(2)
        const recovered = yield* projection.read
        expect(recovered.bootstrap.epoch).not.toBe(initial.bootstrap.epoch)
        expect(recovered.projection.sequence).toBe(0)
        expect(first.closeCount).toBe(1)
      }),
    )
    expect(second.closeCount).toBe(1)
  })

  test('closes a failed consumer before replacing it even when cleanup reports an error', async () => {
    const first = new FakeTransport()
    const second = new FakeTransport()
    let attempts = 0
    const closeFirst = first.close
    first.close = async () => {
      await closeFirst()
      throw new Error('leave group failed after transport closed')
    }
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          attempts += 1
          if (attempts === 1) return first
          expect(first.closed).toBe(true)
          return second
        })
        yield* TestClock.adjust('2 seconds')
        first.invalidated?.(new Error('connection lost'))
        yield* TestClock.adjust('2 seconds')
        expect((yield* projection.status).ready).toBe(false)
        expect(attempts).toBe(1)
        yield* TestClock.adjust('32 seconds')
        expect(attempts).toBe(2)
        expect((yield* projection.status).ready).toBe(true)
        yield* Effect.all([projection.read, projection.read], { concurrency: 'unbounded' })
        expect(attempts).toBe(2)
      }),
    )
    expect(second.closeCount).toBe(1)
  })

  test('scope closure cancels a scheduled reconnect', async () => {
    let attempts = 0
    await program(
      Effect.gen(function* () {
        yield* makeKafkaMarketProjection(config, [universe], () => {
          attempts += 1
          throw new Error('offline')
        })
        yield* TestClock.adjust('5 seconds')
        expect(attempts).toBe(3)
      }),
    )
    expect(attempts).toBe(3)
  })

  test('startup timeout cancels the client and retries only within the configured bound', async () => {
    const transports: FakeTransport[] = []
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, [universe], () => {
          const transport = new FakeTransport()
          let cancel: ((positions: readonly KafkaPartitionPosition[]) => void) | undefined
          transport.offsets = () =>
            new Promise((resolve) => {
              cancel = resolve
            })
          const close = transport.close
          transport.close = async () => {
            const closed = await close()
            cancel?.(positions('0'))
            return closed
          }
          transports.push(transport)
          return transport
        })
        yield* TestClock.adjust('8 seconds')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        expect(transports).toHaveLength(3)
        expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
      }),
    )
  })
})
