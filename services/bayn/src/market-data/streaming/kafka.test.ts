import {
  bootstrapKafkaPartitions,
  kafkaBootstrapComplete,
  KafkaBootstrapTimestampPolicy,
  type KafkaBootstrapEvidence,
  type KafkaPartitionPosition,
} from './bootstrap'
import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Exit, Logger, Redacted, Result } from 'effect'
import { readFileSync } from 'node:fs'
import { canonicalHashV1, sha256 } from '../../hash'
import { CaptureDisposition, type ResearchCaptureEvent } from '../../research-capture/capture'
import { AuthenticationError } from '@platformatic/kafka'
import { decodeRollingMarketFeature, featureBarContentHash } from '../features/contract'
import technicalFixture from '../features/fixtures/technical-indicators-v1.json'
import { decodeTechnicalMarketFeature } from '../features/technical-contract'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../../effect-test-support'
import { historicalRawArrivals } from '../../testing/historical-streaming-fixture'
import { streamingFixture } from '../../testing/streaming-market-fixture'
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
  drained: readonly KafkaPartitionPosition[] | undefined = positions('0')
  queue: KafkaConsumedRecord[] = []
  pending: ((value: IteratorResult<KafkaConsumedRecord>) => void) | undefined
  closed = false
  offsets = async (_topics: readonly string[], timestamp: bigint) => {
    this.lookups.push(timestamp)
    return positions('0')
  }
  consume = async (
    _positions: readonly KafkaPartitionPosition[],
    invalidated: (cause: unknown) => void,
  ): Promise<KafkaProjectionStream> => {
    this.invalidated = invalidated
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
  close = async () => {
    if (this.closed) return
    this.closed = true
    this.closeCount++
    this.pending?.({ done: true, value: undefined })
    this.pending = undefined
  }
}
const program = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer())))

test('projection cuts preserve current offsets and fresh advancing outputs', async () => {
  await program(
    Effect.gen(function* () {
      const market = yield* makeKafkaMarketProjection(config, universe, () => new FakeTransport())
      yield* TestClock.adjust(1000)
      const initial = yield* market.readForLiquidation
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
      const market = yield* makeKafkaMarketProjection(config, universe, () => new FakeTransport())
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
      const market = yield* makeKafkaMarketProjection(config, universe, () => {
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

for (const scenario of [
  'ready',
  'queued',
  'undrained',
  'fence-ahead',
  'invalidated',
  'future-end',
  'missing-partition',
  'lookup-failed',
  'no-sample',
  'stale-sample',
  'replacement-failed',
  'replacement-pending',
  'frontier-regressed',
] as const)
  test(`research interval cut observes only a valid drained epoch: ${scenario}`, async () => {
    const transport = new FakeTransport()
    const events: ResearchCaptureEvent[] = []
    await program(
      Effect.gen(function* () {
        const market = yield* makeKafkaMarketProjection(config, universe, () => transport, undefined, {
          rawValues: true,
          record: (event) => events.push(event),
          invalidate: () => undefined,
        })
        yield* TestClock.adjust(1000)
        const request = {
          intervalId: 'test-interval',
          coverageStartMs: 0,
          coverageEndMs: scenario === 'future-end' || scenario === 'stale-sample' ? 30001 : 1000,
          universeHash: canonicalHashV1(universe),
          expectedPartitions: positions('0')
            .map(({ topic, partition }) => ({ topic, partition }))
            .toSorted((a, b) => a.topic.localeCompare(b.topic)),
        }
        if (scenario === 'queued')
          transport.queue.push({
            topic: 'quotes',
            partition: 0,
            offset: '0',
            value: '',
            timestampMs: 0,
            leaderEpoch: 1,
          })
        if (scenario === 'undrained') transport.drained = undefined
        if (scenario === 'fence-ahead') transport.offsets = async () => positions('1')
        if (scenario === 'missing-partition') request.expectedPartitions.pop()
        if (scenario === 'lookup-failed')
          transport.offsets = async () => {
            throw new Error('test lookup failed')
          }
        if (scenario === 'frontier-regressed') transport.drained = positions('1')
        if (scenario !== 'no-sample') yield* TestClock.adjust(29000)
        if (scenario === 'stale-sample') yield* TestClock.adjust(1000)
        if (scenario === 'replacement-failed') {
          transport.offsets = async () => {
            throw new Error('test replacement sample failed')
          }
          yield* TestClock.adjust(30000)
        }
        let completeLookup: ((value: readonly KafkaPartitionPosition[]) => void) | undefined
        if (scenario === 'replacement-pending') {
          transport.offsets = () =>
            new Promise((resolve) => {
              completeLookup = resolve
            })
          yield* TestClock.adjust(30000)
        }
        if (scenario === 'frontier-regressed') {
          transport.drained = positions('0')
          yield* TestClock.adjust(1000)
        }
        if (scenario === 'invalidated') transport.invalidated?.(new Error('test assignment lost'))
        const lookups = [...transport.lookups]
        const result = yield* market.captureInterval(request).pipe(Effect.result)
        expect(transport.lookups).toEqual(lookups)
        completeLookup?.(positions('0'))
        expect(Result.isSuccess(result)).toBe(scenario === 'ready')
        expect(events.filter((event) => event.kind === 'consumer-interval-cut')).toHaveLength(
          scenario === 'ready' ? 1 : 0,
        )
        expect(transport.closeCount).toBe(0)
        if (Result.isSuccess(result)) {
          expect(result.success.finalConsumerSequence).toBe(0)
          expect(result.success.committedFence.lookupStartedAtMs).toBe(30000)
          expect(result.success.drainedPositions).toHaveLength(4)
        }
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

test.each([false, true])('capture observes dispositions and exact transport time (rawValues=%s)', async (rawValues) => {
  const at = Date.parse('2026-09-11T14:00:02.000Z')
  const quote = (symbol: string) =>
    Buffer.from(
      JSON.stringify({
        version: 2,
        provider: 'alpaca',
        feed: 'iex',
        delayClass: 'real_time_exchange_only',
        marketSession: 'regular',
        channel: 'quotes',
        symbol,
        eventTs: new Date(at).toISOString(),
        ingestTs: new Date(at).toISOString(),
        payload: { t: new Date(at).toISOString(), bp: 200, ap: 200.01, bs: 100, as: 100 },
      }),
    )
  const transport = new FakeTransport()
  const payloads = [quote('AAPL'), Buffer.from([0x80]), quote('ZZZ'), quote('ZZZ')]
  transport.queue = payloads.map((value, index) => ({
    topic: 'quotes',
    partition: 0,
    offset: String(Math.min(index, 2)),
    timestampMs: at,
    leaderEpoch: 1,
    ...decodeKafkaTransportValue(value, true, rawValues),
  }))
  const receipts: Array<{ event: ResearchCaptureEvent; atMs: number | undefined }> = []
  let epoch: string | undefined
  await program(
    Effect.gen(function* () {
      yield* TestClock.setTime(at)
      const market = yield* makeKafkaMarketProjection(
        config,
        universe,
        (_config, selectedEpoch, captureRaw, captureValues) => {
          expect(captureRaw).toBe(true)
          expect(captureValues).toBe(rawValues)
          epoch = selectedEpoch
          return transport
        },
        undefined,
        {
          rawValues,
          record: (event, atMs) => {
            receipts.push({ event, atMs })
          },
          invalidate: () => undefined,
        },
      )
      yield* TestClock.adjust(1000)
      const cut = yield* market.read
      const records = receipts.filter((receipt) => receipt.event.kind === 'market-record')
      expect(
        records.map((receipt) => (receipt.event.kind === 'market-record' ? receipt.event.disposition : undefined)),
      ).toEqual([
        CaptureDisposition.Accepted,
        CaptureDisposition.Rejected,
        CaptureDisposition.Rejected,
        CaptureDisposition.Ignored,
      ])
      expect(
        records.map((receipt) => (receipt.event.kind === 'market-record' ? receipt.event.consumerSequence : undefined)),
      ).toEqual([1, 2, 3, 4])
      expect(
        records.every((receipt) => receipt.event.kind === 'market-record' && receipt.event.consumerEpoch === epoch),
      ).toBe(true)
      expect(records[0]?.atMs).toBe(cut.projection.quotes.get('AAPL')?.availableAtMs)
      if (rawValues) {
        expect(records[0]?.event).toMatchObject({
          originalTransport: {
            schemaVersion: 'bayn.kafka-original-transport.v1',
            timestampMs: { kind: 'VALUE', value: at },
          },
        })
      } else expect(records[0]?.event).not.toHaveProperty('originalTransport')
      expect(records[1]?.event).toMatchObject({
        rawValueSha256: sha256(Buffer.from([0x80])),
        rawByteLength: 1,
        bootstrap: true,
      })
      expect(cut.projection.sequence).toBe(3)
    }),
  )
  expect(transport.closeCount).toBe(1)
  expect(receipts.at(-1)?.event).toMatchObject({ kind: 'consumer-boundary', phase: 'STOPPED', consumerEpoch: epoch })
})

describe('Kafka bootstrap and scoped consumption', () => {
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
    const delayedTrades = records.filter((record) => record.topic === retainedUniverse.topics.trades)
    if (delayedTrades.length === 0) throw new Error('retained trade fixture is empty')
    const transport = new FakeTransport()
    transport.drained = undefined
    transport.queue = records.filter((record) => record.topic !== retainedUniverse.topics.trades)
    transport.offsets = async (_topics, timestamp) => {
      transport.lookups.push(timestamp)
      return fixture.cut.positions.map((position) => ({
        ...position,
        offset: timestamp === -1n ? position.offset : '0',
      }))
    }
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(bootAtMs)
        const projection = yield* makeKafkaMarketProjection(config, retainedUniverse, () => transport)
        yield* TestClock.adjust('1 second')
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        for (const record of delayedTrades) transport.send(record)
        yield* TestClock.adjust('1 second')
        const cut = yield* projection.read
        const observedAtMs = yield* Clock.currentTimeMillis
        expect(observedAtMs - bootAtMs).toBe(2000)
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
          const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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
    transport.offsets = async (_topics, timestamp) =>
      positions('0').map((position) => ({
        ...position,
        offset: timestamp === -1n && position.topic !== universe.topics.quotes ? '100' : '0',
      }))
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, universe, () => transport)
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => transport)
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
        const market = yield* makeKafkaMarketProjection(config, universe, () => {
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
          }),
        ])
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(transports).toHaveLength(2)
    expect(transports.every((transport) => transport.closeCount === 1)).toBe(true)
  })

  test.each(['rolling', 'technical'] as const)(
    '%s feature arrival receipts are emitted once after incorporation, excluding transport and semantic retries',
    async (family) => {
      const fixture: unknown = JSON.parse(
        readFileSync(new URL('../features/fixtures/rolling-price-v1.json', import.meta.url), 'utf8'),
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
        return bounds
      }
      transport.drained = bounds
      await program(
        Effect.gen(function* () {
          yield* TestClock.setTime(feature.computedAtMs + 1000)
          const projection = yield* makeKafkaMarketProjection(config, featureUniverse, () => transport)
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
          expect((yield* projection.status).ready).toBe(false)
          transport.send(record)
          transport.send({ ...record, offset: '1' })
          yield* TestClock.adjust('1 second')
          const state = (yield* projection.read).projection
          expect((family === 'technical' ? state.technicalFeatures : state.features).get('AAPL')).toHaveLength(1)
          expect(lookups.every((topics) => topics.includes(featureTopic))).toBe(true)
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => transport)
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => transport)
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        yield* TestClock.adjust('2 seconds')
        const cut = yield* projection.read
        expect(cut.projection.sequence).toBe(0)
        expect(transport.lookups).toEqual([-2n, -1n, BigInt(Date.parse('2026-09-11T13:29:55Z'))])
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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

  test('retains the first invalidation cause and reports recovery without private transport details', async () => {
    const transports: FakeTransport[] = []
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    const firstCause = new AuthenticationError('private transport credential detail')
    await program(
      Effect.gen(function* () {
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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
          expect.objectContaining({ failureCodes: ['PLT_KFK_AUTHENTICATION'] }),
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
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
        yield* makeKafkaMarketProjection(config, universe, () => {
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
        const projection = yield* makeKafkaMarketProjection(config, universe, () => {
          const transport = new FakeTransport()
          let cancel: ((positions: readonly KafkaPartitionPosition[]) => void) | undefined
          transport.offsets = () =>
            new Promise((resolve) => {
              cancel = resolve
            })
          const close = transport.close
          transport.close = async () => {
            await close()
            cancel?.(positions('0'))
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
