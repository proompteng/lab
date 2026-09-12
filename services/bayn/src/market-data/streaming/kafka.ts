import { randomUUID } from 'node:crypto'
import {
  bootstrapKafkaPartitions,
  canonicalPositions,
  kafkaBootstrapComplete,
  KafkaBootstrapTimestampPolicy,
  type KafkaBootstrapEvidence,
  type KafkaPartitionPosition,
} from './bootstrap'
import {
  Consumer,
  MessagesStreamFallbackModes,
  MessagesStreamModes,
  stringDeserializers,
  type MessagesStream,
  type Offsets,
} from '@platformatic/kafka'
import { Cause, Clock, Context, Data, Duration, Effect, Layer, Redacted, Result, Schedule, Stream } from 'effect'
import {
  featureAvailabilityMeasurement,
  partitionLagMeasurements,
  projectionCoverageMeasurements,
  safeKafkaFailureCodes,
} from './telemetry'

import {
  emptyStreamingProjection,
  incorporateMarketRecord,
  topicPartitionKey,
  type StreamingProjection,
} from './projection'
import type { KafkaMarketRecord, StreamingUniverse } from './raw-events'

export interface KafkaMarketConfig {
  readonly shadowOnly?: boolean
  readonly technicalFeaturesTopic?: string | undefined
  readonly brokers: readonly string[]
  readonly username: string
  readonly password: Redacted.Redacted<string>
  readonly groupPrefix: string
  readonly operationTimeoutMs: number
  readonly bootstrapTimeoutMs: number
  readonly timestampPolicy: KafkaBootstrapTimestampPolicy
}
export class KafkaMarketFailure extends Data.TaggedError('KafkaMarketFailure')<{
  readonly operation: 'connect' | 'bootstrap' | 'consume' | 'commit' | 'close' | 'read'
  readonly message: string
  readonly cause?: unknown
}> {}
const failure = (operation: KafkaMarketFailure['operation'], message: string, cause?: unknown) =>
  new KafkaMarketFailure({ operation, message, ...(cause === undefined ? {} : { cause }) })

export interface KafkaConsumedRecord extends KafkaMarketRecord {
  readonly timestampMs: number
  readonly leaderEpoch: number
}
export interface KafkaProjectionStream extends AsyncIterable<KafkaConsumedRecord> {
  readonly queuedRecords: () => number
  /** Positions include skipped transaction/control offsets. False while any delivered record is unincorporated. */
  readonly drainedPositions: () => readonly KafkaPartitionPosition[] | undefined
}
export interface KafkaProjectionTransport {
  readonly offsets: (topics: readonly string[], timestamp: bigint) => Promise<readonly KafkaPartitionPosition[]>
  readonly consume: (
    positions: readonly KafkaPartitionPosition[],
    invalidated: (cause: unknown) => void,
  ) => Promise<KafkaProjectionStream>
  readonly commit: (records: readonly KafkaConsumedRecord[]) => Promise<void>
  readonly close: () => Promise<void>
}
export type KafkaProjectionTransportFactory = (config: KafkaMarketConfig, epoch: string) => KafkaProjectionTransport

const positionList = (offsets: Offsets): readonly KafkaPartitionPosition[] =>
  [...offsets].flatMap(([topic, values]) =>
    values.map((offset, partition) => ({ topic, partition, offset: String(offset) })),
  )

export const platformaticProjectionTransport: KafkaProjectionTransportFactory = (config, epoch) => {
  const consumer = new Consumer({
    clientId: `bayn-market-${epoch}`,
    groupId: `${config.groupPrefix}-${epoch}`,
    bootstrapBrokers: [...config.brokers],
    deserializers: stringDeserializers,
    sasl: { mechanism: 'SCRAM-SHA-512', username: config.username, password: Redacted.value(config.password) },
    autocreateTopics: false,
    timeout: config.operationTimeoutMs,
    requestTimeout: config.operationTimeoutMs,
    connectTimeout: config.operationTimeoutMs,
    retries: 2,
    retryDelay: 250,
  })
  let closePromise: Promise<void> | undefined
  let active: MessagesStream<string, string, string, string> | undefined
  const close = (): Promise<void> => {
    if (closePromise === undefined) {
      active?.destroy()
      closePromise = new Promise<void>((resolve, reject) => {
        consumer.close(true, (error) => (error !== null && error !== undefined ? reject(error) : resolve()))
      })
    }
    return closePromise
  }
  return {
    offsets: async (topics, timestamp) =>
      positionList(await consumer.listOffsets({ topics: [...topics], timestamp, isolationLevel: 1 })),
    consume: async (positions, invalidated) => {
      let joined = false
      consumer.on('consumer:group:join', () => {
        if (joined) invalidated(new Error('Kafka partitions reassigned'))
        joined = true
      })
      consumer.on('consumer:group:rejoin', () => {
        if (joined) invalidated(new Error('Kafka group rejoined'))
      })
      consumer.on('consumer:group:rebalance', () => {
        if (joined) invalidated(new Error('Kafka partitions reassigned'))
      })
      consumer.on('consumer:heartbeat:stalled', () => invalidated(new Error('Kafka heartbeat stalled')))
      const source = await consumer.consume({
        topics: [...new Set(positions.map((position) => position.topic))],
        mode: MessagesStreamModes.MANUAL,
        fallbackMode: MessagesStreamFallbackModes.FAIL,
        offsets: positions.map((position) => ({ ...position, offset: BigInt(position.offset) })),
        autocommit: false,
        isolationLevel: 1,
        highWaterMark: 256,
        maxBytes: 1_048_576,
        maxBytesPerPartition: 262_144,
        maxWaitTime: 250,
      })
      active = source
      let pending = false
      return {
        queuedRecords: () => source.readableLength,
        drainedPositions: () =>
          pending || source.readableLength !== 0
            ? undefined
            : positions.map(({ topic, partition }) => ({
                topic,
                partition,
                offset: String(source.offsetsToFetch.get(topicPartitionKey(topic, partition)) ?? -1n),
              })),
        [Symbol.asyncIterator]() {
          const iterator = source[Symbol.asyncIterator]()
          return {
            next: async (): Promise<IteratorResult<KafkaConsumedRecord>> => {
              pending = false
              const result = await iterator.next()
              if (result.done === true) return { done: true, value: undefined }
              pending = true
              const message = result.value
              if (message.value === undefined) throw new Error('Kafka market message has no payload')
              return {
                done: false,
                value: {
                  topic: message.topic,
                  partition: message.partition,
                  offset: String(message.offset),
                  value: message.value,
                  timestampMs: Number(message.timestamp),
                  leaderEpoch: message.leaderEpoch,
                },
              }
            },
            return: async (): Promise<IteratorResult<KafkaConsumedRecord>> => {
              await close()
              await iterator.return?.()
              return { done: true, value: undefined }
            },
          }
        },
      }
    },
    commit: (records) =>
      consumer.commit({
        offsets: records.map((record) => ({
          topic: record.topic,
          partition: record.partition,
          offset: BigInt(record.offset) + 1n,
          leaderEpoch: record.leaderEpoch,
        })),
      }),
    close,
  }
}

export interface KafkaProjectionCut {
  readonly projection: StreamingProjection
  readonly bootstrap: KafkaBootstrapEvidence
  readonly positions: readonly KafkaPartitionPosition[]
}
export class KafkaMarketProjection extends Context.Service<
  KafkaMarketProjection,
  {
    readonly read: Effect.Effect<KafkaProjectionCut, KafkaMarketFailure>
    readonly status: Effect.Effect<{
      readonly epoch: string
      readonly ready: boolean
      readonly sequence: number
      readonly failure?: string
    }>
  }
>()('@proompteng/bayn/KafkaMarketProjection') {}

export const makeKafkaMarketProjection = (
  config: KafkaMarketConfig,
  universe: StreamingUniverse,
  factory: KafkaProjectionTransportFactory = platformaticProjectionTransport,
  diagnosticStartMs?: number,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const owner = yield* Effect.scope
    let restartAfterMs: number | undefined
    let projection = emptyStreamingProjection('starting', universe.topics.technicalFeatures)
    let bootstrap: KafkaBootstrapEvidence | undefined
    let positions: readonly KafkaPartitionPosition[] = []
    let ready = false
    let lastFailure: KafkaMarketFailure | undefined
    const cycle = Effect.scoped(
      Effect.gen(function* () {
        const epoch = yield* Effect.sync(randomUUID)
        projection = emptyStreamingProjection(epoch, universe.topics.technicalFeatures)
        ready = false
        bootstrap = undefined
        positions = []
        lastFailure = undefined
        const transport = yield* Effect.acquireRelease(
          Effect.try({
            try: () => factory(config, epoch),
            catch: (cause) => failure('connect', 'Kafka client acquisition failed', cause),
          }),
          (resource) =>
            Effect.tryPromise({
              try: () => resource.close(),
              catch: (cause) => failure('close', 'Kafka client close failed', cause),
            }).pipe(Effect.orDie),
        )
        const operation = <A>(name: KafkaMarketFailure['operation'], run: () => Promise<A>) =>
          Effect.tryPromise({ try: run, catch: (cause) => failure(name, `Kafka ${name} failed`, cause) }).pipe(
            Effect.onInterrupt(() => Effect.promise(() => transport.close())),
            Effect.timeoutOrElse({
              duration: config.operationTimeoutMs,
              orElse: () => Effect.fail(failure(name, `Kafka ${name} timed out`)),
            }),
          )
        const observedAtMs = yield* Clock.currentTimeMillis
        const lowerTimestampMs =
          diagnosticStartMs ?? Math.floor((observedAtMs - 2000) / 60_000) * 60_000 - 30 * 60_000 - 5000
        const topics = Object.values(universe.topics).filter((topic) => topic !== undefined)
        if (new Set(topics).size !== topics.length)
          return yield* failure('bootstrap', 'Market input topics must be distinct')
        const starts = yield* operation('bootstrap', () => transport.offsets(topics, -2n))
        const ends = yield* operation('bootstrap', () => transport.offsets(topics, -1n))
        const seek =
          config.timestampPolicy === KafkaBootstrapTimestampPolicy.ProducerClock
            ? yield* operation('bootstrap', () => transport.offsets(topics, BigInt(lowerTimestampMs)))
            : starts
        const partitions = yield* Effect.try({
          try: () => bootstrapKafkaPartitions(starts, ends, seek),
          catch: (cause) => failure('bootstrap', 'Invalid Kafka bootstrap bounds', cause),
        })
        bootstrap = {
          schemaVersion: 'bayn.kafka-bootstrap.v1',
          epoch,
          observedAtMs,
          lowerTimestampMs,
          timestampPolicy: config.timestampPolicy,
          partitions,
        }
        const evidence = bootstrap
        let invalidation: unknown
        positions = partitions.map((partition) => ({
          topic: partition.topic,
          partition: partition.partition,
          offset: partition.startOffset,
        }))
        const source = yield* operation('consume', () =>
          transport.consume(
            partitions.map((partition) => ({
              topic: partition.topic,
              partition: partition.partition,
              offset: partition.startOffset,
            })),
            (cause) => {
              invalidation = cause
              ready = false
            },
          ),
        )
        const terminals = new Map<string, KafkaConsumedRecord>()
        const consume = Stream.fromAsyncIterable(source, (cause) =>
          failure('consume', 'Kafka consumption failed', cause),
        ).pipe(
          Stream.runForEach((record) =>
            Effect.gen(function* () {
              if (invalidation !== undefined) return
              const previousSequence = projection.sequence
              projection = incorporateMarketRecord(projection, record, universe, clock.currentTimeMillisUnsafe())
              terminals.set(topicPartitionKey(record.topic, record.partition), record)
              if (projection.technicalFeatureArrival !== null && projection.sequence !== previousSequence)
                yield* Effect.logInfo('Kafka technical feature incorporated', {
                  ...featureAvailabilityMeasurement(
                    epoch,
                    projection.technicalFeatureArrival,
                    partitions.find(
                      (partition) => partition.topic === record.topic && partition.partition === record.partition,
                    )?.endOffset,
                  ),
                  definitionId: projection.technicalFeatureArrival.value.material.definitionId,
                  consumerPurpose: diagnosticStartMs === undefined ? 'execution-worker' : 'retained-input-diagnostic',
                })
              if (record.topic === universe.topics.features && projection.sequence !== previousSequence) {
                const incorporatedFeature = projection.featureArrival
                if (incorporatedFeature !== null)
                  yield* Effect.logInfo('Kafka feature incorporated', {
                    ...featureAvailabilityMeasurement(
                      epoch,
                      incorporatedFeature,
                      partitions.find(
                        (partition) => partition.topic === record.topic && partition.partition === record.partition,
                      )?.endOffset,
                    ),
                    consumerPurpose: diagnosticStartMs === undefined ? 'execution-worker' : 'retained-input-diagnostic',
                  })
              }
            }),
          ),
          Effect.andThen(Effect.fail(failure('consume', 'Kafka consumption ended'))),
        )
        const monitor = Effect.gen(function* () {
          let announced = false
          while (true) {
            yield* Effect.sleep(Duration.seconds(1))
            if (invalidation !== undefined)
              return yield* failure('consume', 'Kafka assignment invalidated', invalidation)
            const drained = source.drainedPositions()
            const incorporated = new Map(
              positions.map((position) => [topicPartitionKey(position.topic, position.partition), position]),
            )
            for (const position of drained ?? [])
              incorporated.set(topicPartitionKey(position.topic, position.partition), position)
            for (const record of terminals.values()) {
              const key = topicPartitionKey(record.topic, record.partition)
              const prior = incorporated.get(key)
              if (prior === undefined || BigInt(prior.offset) <= BigInt(record.offset))
                incorporated.set(key, {
                  topic: record.topic,
                  partition: record.partition,
                  offset: String(BigInt(record.offset) + 1n),
                })
            }
            positions = canonicalPositions([...incorporated.values()])
            ready = kafkaBootstrapComplete(evidence, positions)
            if (!ready && (yield* Clock.currentTimeMillis) - observedAtMs > config.bootstrapTimeoutMs)
              return yield* failure('bootstrap', 'Kafka bootstrap deadline exceeded')
            if (ready && !announced) {
              announced = true
              yield* Effect.logInfo('Kafka market projection bootstrap completed', {
                epoch,
                partitions: positions.length,
                incorporatedRecords: projection.sequence,
                elapsedMs: (yield* Clock.currentTimeMillis) - observedAtMs,
                rejectedPartitions: projection.rejections.size,
              })
            }
            if (terminals.size > 0) {
              const committed = [...terminals.values()]
              yield* operation('commit', () => transport.commit(committed))
              for (const record of committed) {
                const key = topicPartitionKey(record.topic, record.partition)
                if (terminals.get(key) === record) terminals.delete(key)
              }
            }
          }
        })
        const report = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.seconds(30))
            const lookupStartedAtMs = yield* Clock.currentTimeMillis
            // The SDK bounds requests and retries; an optional lookup must not use operation's whole-client timeout.
            // Consumer-scope finalization still closes this request if the worker stops during the lookup.
            const ends = yield* Effect.tryPromise({
              try: () => transport.offsets(topics, -1n),
              catch: (cause) => failure('read', 'Kafka read failed', cause),
            }).pipe(Effect.result)
            const measuredAtMs = yield* Clock.currentTimeMillis
            yield* Effect.logInfo('Kafka market projection measurements', {
              schemaVersion: 'bayn.kafka-projection-measurements.v1',
              epoch,
              sequence: projection.sequence,
              bootstrapComplete: ready,
              queuedRecords: source.queuedRecords(),
              queueHighWaterMark: 256,
              endOffsetLookupStartedAtMs: lookupStartedAtMs,
              endOffsetLookupCompletedAtMs: measuredAtMs,
              endOffsetLookupFailure: Result.isFailure(ends) ? ends.failure.message : null,
              endOffsetLookupFailureCodes: Result.isFailure(ends) ? safeKafkaFailureCodes(ends.failure.cause) : null,
              partitions: partitionLagMeasurements(positions, Result.isSuccess(ends) ? ends.success : undefined),
              ...projectionCoverageMeasurements(projection, universe.symbols, measuredAtMs),
            })
          }
        })
        return yield* Effect.raceFirst(consume, Effect.raceFirst(monitor, report))
      }),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          ready = false
          lastFailure = cause
        }),
      ),
    )
    const supervision = cycle.pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced(Duration.seconds(1)) }),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
          ready = false
          restartAfterMs = clock.currentTimeMillisUnsafe() + 30_000
          lastFailure ??= failure('consume', 'Kafka market projection stopped', cause)
          yield* Effect.logError('Kafka market projection stopped', cause)
        }),
      ),
    )
    const start = Effect.gen(function* () {
      restartAfterMs = undefined
      yield* supervision.pipe(Effect.forkIn(owner))
    })
    yield* start
    return {
      read: Effect.suspend(() => {
        if (restartAfterMs !== undefined && clock.currentTimeMillisUnsafe() >= restartAfterMs)
          return start.pipe(
            Effect.andThen(Effect.fail(failure('read', 'Kafka projection is rebuilding after connection recovery'))),
          )
        return ready && bootstrap !== undefined
          ? Effect.succeed({
              projection,
              bootstrap,
              positions: positions.map((position) => {
                const last = projection.offsets.get(topicPartitionKey(position.topic, position.partition))
                return last !== undefined && BigInt(last) >= BigInt(position.offset)
                  ? { ...position, offset: String(BigInt(last) + 1n) }
                  : position
              }),
            })
          : Effect.fail(lastFailure ?? failure('read', 'Kafka projection is rebuilding required history'))
      }),
      status: Effect.sync(() => ({
        epoch: projection.epoch,
        ready,
        sequence: projection.sequence,
        ...(lastFailure === undefined ? {} : { failure: lastFailure.message }),
      })),
    }
  })
export const KafkaMarketProjectionLive = (config: KafkaMarketConfig, universe: StreamingUniverse) =>
  Layer.effect(KafkaMarketProjection, makeKafkaMarketProjection(config, universe))
