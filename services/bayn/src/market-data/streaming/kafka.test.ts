import {
  bootstrapKafkaPartitions,
  kafkaBootstrapComplete,
  KafkaBootstrapTimestampPolicy,
  type KafkaBootstrapEvidence,
  type KafkaPartitionPosition,
} from './bootstrap'
import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Exit, Redacted } from 'effect'
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
