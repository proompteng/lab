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
import { decodeRollingMarketFeature } from '../features/contract'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../../effect-test-support'
import {
  makeKafkaMarketProjection,
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

describe('Kafka bootstrap and scoped consumption', () => {
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
          throw new Error('end-offset lookup unavailable')
        }
        yield* TestClock.adjust('30 seconds')
        expect(logs).toContainEqual([
          'Kafka market projection measurements',
          expect.objectContaining({
            bootstrapComplete: true,
            queuedRecords: 0,
            endOffsetLookupFailure: 'Kafka read failed',
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

  test('feature arrival receipts are emitted once after incorporation, excluding transport and semantic retries', async () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('../features/fixtures/rolling-price-v1.json', import.meta.url), 'utf8'),
    )
    const feature = Result.getOrThrow(decodeRollingMarketFeature(fixture))
    const input = feature.material.inputs[0]
    if (input === undefined) throw new Error('fixture has no input')
    const featureUniverse = {
      ...universe,
      universeId: feature.material.universeId,
      universeSymbolHash: feature.material.universeSymbolHash,
      topics: { ...universe.topics, bars: input.sourceTopic },
    }
    const logs: unknown[] = []
    const logger = Logger.make(({ message }) => logs.push(message))
    const transport = new FakeTransport()
    const bounds = Object.values(featureUniverse.topics).map((topic) => ({ topic, partition: 0, offset: '0' }))
    transport.offsets = async () => bounds
    transport.drained = bounds
    await program(
      Effect.gen(function* () {
        yield* TestClock.setTime(feature.computedAtMs + 1000)
        const projection = yield* makeKafkaMarketProjection(config, featureUniverse, () => transport)
        yield* TestClock.adjust('2 seconds')
        const record = {
          topic: featureUniverse.topics.features,
          partition: 0,
          offset: '0',
          value: JSON.stringify(feature),
          timestampMs: feature.computedAtMs,
          leaderEpoch: 1,
        }
        transport.send(record)
        yield* TestClock.adjust('1 second')
        transport.send(record)
        transport.send({ ...record, offset: '1' })
        yield* TestClock.adjust('1 second')
        expect((yield* projection.read).projection.features.get('AAPL')).toHaveLength(1)
        expect(logs.filter((message) => Array.isArray(message) && message[0] === 'Kafka feature incorporated')).toEqual(
          [
            [
              'Kafka feature incorporated',
              expect.objectContaining({
                featureId: feature.featureId,
                computedAtMs: feature.computedAtMs,
                offset: '0',
              }),
            ],
          ],
        )
      }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(transport.closeCount).toBe(1)
  })

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

  test('commits follow rejection incorporation and reassignment revokes readiness immediately', async () => {
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
        expect(transport.commits.some((batch) => batch.some((record) => record.offset === '0'))).toBe(true)
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

  test('a later read can rebuild after bounded connection failure and cooldown, without overlapping clients', async () => {
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
        yield* TestClock.adjust('31 seconds')
        expect(attempts).toBe(3)
        recovered = true
        expect(Exit.isFailure(yield* Effect.exit(projection.read))).toBe(true)
        yield* TestClock.adjust('2 seconds')
        expect(attempts).toBe(4)
        expect((yield* projection.read).projection.sequence).toBe(0)
      }),
    )
    expect(transport.closeCount).toBe(1)
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
