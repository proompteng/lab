import { parentPort, workerData } from 'node:worker_threads'
import { NodeRuntime } from '@effect/platform-node'
import { Effect, Exit, Logger, Redacted, Result, Scope } from 'effect'

import { KafkaBootstrapTimestampPolicy } from './bootstrap'
import {
  decodeKafkaTransportValue,
  makeKafkaMarketProjection,
  type KafkaConsumedRecord,
  type KafkaProjectionStream,
} from './kafka'
import { makeNativeArrivalJournal } from './native-arrival-journal'
import { nativeArrivalCaptureId } from './native-arrival'
import { nativeArrivalEpochFixture } from './native-arrival.test-support'
import { serveProjectionWorker } from './market-projection-worker'
import { sha256 } from '../../hash'
import { CaptureDisposition } from './transport-evidence'
import { streamingFixture } from '../../testing/streaming-market-fixture'

if (parentPort === null) throw new Error('Test requires a worker port')
const port = parentPort
const { signals: shared, mode } = workerData as {
  readonly signals: SharedArrayBuffer
  readonly mode: 'consume' | 'hang' | 'fail' | 'fixture'
}
const signals = new Int32Array(shared)
const times = new BigInt64Array(shared, 32)
const source = {
  universeId: 'thread-test',
  universeSymbolHash: '0'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features', webullBars: 'webull' },
}
const positions = Object.values(source.topics).map((topic) => ({ topic, partition: 0, offset: '0' }))

const program = Effect.gen(function* () {
  if (mode === 'fixture') {
    const fixture = streamingFixture()
    let read = false
    const cut = {
      ...fixture.cut,
      consumerSequence: fixture.cut.projection.sequence,
      deliveredPositions: fixture.cut.positions,
    }
    return yield* serveProjectionWorker(
      {
        check: Effect.void,
        read: Effect.sync(() => {
          read = true
          return cut
        }),
        readForLiquidation: Effect.succeed(cut),
        status: Effect.sync(() => ({
          epoch: cut.projection.epoch,
          sequence: read ? cut.projection.sequence : 0,
          ready: true,
          bootstrapDeadlineAtMs: null,
        })),
      },
      Effect.void,
      port,
    )
  }
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
  let next: ((value: IteratorResult<KafkaConsumedRecord>) => void) | undefined
  let closed = false
  let queued: KafkaConsumedRecord | undefined
  const stream: KafkaProjectionStream = {
    queuedRecords: () => (queued === undefined ? 0 : 1),
    drainedPositions: () => positions,
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) => {
          if (queued !== undefined) {
            const record = queued
            queued = undefined
            resolve({ done: false, value: record })
          } else if (closed) resolve({ done: true, value: undefined })
          else next = resolve
        }),
    }),
  }
  const projection = yield* makeKafkaMarketProjection(
    {
      brokers: ['unused:9092'],
      username: 'test',
      password: Redacted.make('unused'),
      groupPrefix: 'test',
      operationTimeoutMs: 1000,
      bootstrapTimeoutMs: 5000,
      timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
    },
    [source],
    () => ({
      offsets: async (topics) => positions.filter((position) => topics.includes(position.topic)),
      consume: async () => stream,
      close: async () => {
        if (!closed) {
          closed = true
          Atomics.add(signals, 2, 1)
          next?.({ done: true, value: undefined })
        }
        return { _tag: 'Closed' }
      },
    }),
    undefined,
    (bootstrap, sources) =>
      Effect.gen(function* () {
        const epoch = {
          ...nativeArrivalEpochFixture,
          bootstrap,
          sources,
          captureId: Result.getOrThrow(nativeArrivalCaptureId(nativeArrivalEpochFixture.build, bootstrap, sources)),
        }
        const journal = yield* makeNativeArrivalJournal(epoch, {
          begin: () => Effect.void,
          append: () => Effect.void,
          end: (end) =>
            Effect.sync(() => {
              Atomics.add(signals, 3, 1)
              Atomics.store(signals, 4, end.status === 'STOPPED' && end.durableConsumerSequence === 1 ? 1 : -1)
            }),
        })
        return {
          ...journal,
          observe: (input) =>
            journal.observe(input).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  Atomics.store(signals, 6, input.disposition === CaptureDisposition.Accepted ? 1 : -1)
                  Atomics.store(signals, 7, input.projectionSequence)
                  Atomics.store(times, 1, BigInt(input.availableAtMs))
                  Atomics.store(signals, 1, 1)
                  Atomics.notify(signals, 1)
                }),
              ),
            ),
        }
      }),
  ).pipe(Effect.provideService(Scope.Scope, scope))
  yield* Effect.gen(function* () {
    while (Atomics.load(signals, 0) === 0) yield* Effect.sleep('1 millis')
    const now = Date.now()
    Atomics.store(times, 0, BigInt(now))
    const minute = Math.floor(now / 60_000) * 60_000
    const payload = Buffer.from(
      JSON.stringify({
        result: [
          {
            symbol: 'AAPL',
            delay_minutes: '0',
            result: [
              {
                time: new Date(minute - 60_000).toISOString().replace('Z', '+0000'),
                trading_session: 'RTH',
                open: '100',
                high: '102',
                low: '99',
                close: '101',
                volume: '25000',
              },
            ],
          },
        ],
      }),
    )
    const value = JSON.stringify({
      version: 1,
      provider: 'webull',
      feed: 'nasdaq_basic',
      captureId: '96d77600-414a-4211-9342-f3a986254fbc',
      receivedAt: new Date(now).toISOString(),
      source: {
        type: 'http',
        endpoint: '/market-data/stocks/bars/list',
        requestedSymbols: ['AAPL'],
        requestBody: JSON.stringify({
          symbols: ['AAPL'],
          category: 'US_STOCK',
          timespan: 'M1',
          count: '5',
          real_time_required: true,
          trading_sessions: 'PRE,RTH,ATH',
          start_time: minute - 300_000,
          end_time: minute - 1,
        }),
      },
      payloadBase64: payload.toString('base64'),
      payloadSha256: sha256(payload),
    })
    const record = {
      topic: 'webull',
      partition: 0,
      offset: '0',
      timestampMs: now,
      leaderEpoch: 1,
      ...decodeKafkaTransportValue(Buffer.from(value), true, true),
    }
    if (next !== undefined) next({ done: false, value: record })
    else queued = record
  }).pipe(Effect.forkIn(scope))
  const exposed =
    mode === 'hang'
      ? { ...projection, read: Effect.never.pipe(Effect.ensuring(Effect.sync(() => Atomics.add(signals, 5, 1)))) }
      : projection
  if (mode === 'fail') throw new Error('Synthetic projection startup failure')
  return yield* serveProjectionWorker(exposed, Scope.close(scope, Exit.void), port)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(Logger.layer([]))))
