import { MarketKind } from '../../instruments'
import { randomUUID } from 'node:crypto'
import { sha256 } from '../../hash'
import { CaptureDisposition } from './transport-evidence'
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
import { makeKafkaArrivalEnvelope } from './arrival-envelope'
import type { NativeArrivalCaptureFactory } from './native-arrival-journal'
import {
  featureAvailabilityMeasurement,
  partitionLagMeasurements,
  projectionCoverageMeasurements,
  safeKafkaFailureCodes,
} from './telemetry'

import {
  emptyStreamingProjection,
  kafkaCaptureDisposition,
  incorporateMarketRecord,
  topicPartitionKey,
  type StreamingProjection,
} from './projection'
import { marketSourceForTopic, marketSourceKind, type KafkaMarketRecord, type MarketSources } from './raw-events'

export interface KafkaMarketConfig {
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
  readonly operation: 'connect' | 'bootstrap' | 'consume' | 'close' | 'read'
  readonly message: string
  readonly cause?: unknown
}> {}

export enum KafkaInvalidationReason {
  Reassigned = 'PARTITIONS_REASSIGNED',
  Rejoined = 'GROUP_REJOINED',
  Rebalanced = 'GROUP_REBALANCED',
  HeartbeatStalled = 'HEARTBEAT_STALLED',
  BootstrapDeadlineExceeded = 'BOOTSTRAP_DEADLINE_EXCEEDED',
  TransportFailure = 'TRANSPORT_FAILURE',
}

class KafkaAssignmentInvalidation extends Data.TaggedError('KafkaAssignmentInvalidation')<{
  readonly reason: KafkaInvalidationReason
}> {}

class KafkaBootstrapDeadlineExceeded extends Data.TaggedError('KafkaBootstrapDeadlineExceeded')<{}> {}

const invalidationReason = (cause: unknown): KafkaInvalidationReason => {
  if (cause instanceof KafkaBootstrapDeadlineExceeded) return KafkaInvalidationReason.BootstrapDeadlineExceeded
  return cause instanceof KafkaAssignmentInvalidation ? cause.reason : KafkaInvalidationReason.TransportFailure
}

// Local catch-up exhaustion is not a Kafka protocol or network error.
const projectionFailureCodes = (cause: unknown): readonly string[] =>
  cause instanceof KafkaBootstrapDeadlineExceeded ? [] : safeKafkaFailureCodes(cause)

const failure = (operation: KafkaMarketFailure['operation'], message: string, cause?: unknown) =>
  new KafkaMarketFailure({ operation, message, ...(cause === undefined ? {} : { cause }) })

export interface KafkaConsumedRecord extends KafkaMarketRecord {
  readonly timestampMs: number
  readonly leaderEpoch: number
  readonly rawValueSha256?: string | null
  readonly rawByteLength?: number | null
  readonly tombstone?: boolean
  readonly rawValue?: Uint8Array | null
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
  readonly close: () => Promise<void>
}
export type KafkaProjectionTransportFactory = (
  config: KafkaMarketConfig,
  epoch: string,
  captureRawIdentity?: boolean,
  captureRawValues?: boolean,
) => KafkaProjectionTransport

export const decodeKafkaTransportValue = (
  value: Buffer | undefined,
  captureRawIdentity = false,
  captureRawValues = false,
) => {
  if (value === undefined) {
    if (!captureRawIdentity) throw new Error('Kafka market message has no payload')
    return {
      value: '',
      rawValueSha256: null,
      rawByteLength: null,
      tombstone: true,
      ...(captureRawValues ? { rawValue: null } : {}),
    }
  }
  return {
    rawByteLength: value.byteLength,
    ...(captureRawIdentity ? { rawValueSha256: sha256(value) } : {}),
    ...(captureRawValues ? { rawValue: value } : {}),
    value: value.toString('utf-8'),
  }
}

const positionList = (offsets: Offsets): readonly KafkaPartitionPosition[] =>
  [...offsets].flatMap(([topic, values]) =>
    values.map((offset, partition) => ({ topic, partition, offset: String(offset) })),
  )

export const platformaticProjectionTransport: KafkaProjectionTransportFactory = (
  config,
  epoch,
  captureRawIdentity = false,
  captureRawValues = false,
) => {
  const consumer = new Consumer<string, Buffer, string, string>({
    clientId: `bayn-market-${epoch}`,
    groupId: `${config.groupPrefix}-${epoch}`,
    bootstrapBrokers: [...config.brokers],
    deserializers: { ...stringDeserializers, value: (data?: Buffer) => data },
    sasl: { mechanism: 'SCRAM-SHA-512', username: config.username, password: Redacted.value(config.password) },
    autocreateTopics: false,
    timeout: config.operationTimeoutMs,
    requestTimeout: config.operationTimeoutMs,
    connectTimeout: config.operationTimeoutMs,
    retries: 2,
    retryDelay: 250,
  })
  let closePromise: Promise<void> | undefined
  let active: MessagesStream<string, Buffer, string, string> | undefined
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
        if (joined) invalidated(new KafkaAssignmentInvalidation({ reason: KafkaInvalidationReason.Reassigned }))
        joined = true
      })
      consumer.on('consumer:group:rejoin', () => {
        if (joined) invalidated(new KafkaAssignmentInvalidation({ reason: KafkaInvalidationReason.Rejoined }))
      })
      consumer.on('consumer:group:rebalance', () => {
        if (joined) invalidated(new KafkaAssignmentInvalidation({ reason: KafkaInvalidationReason.Rebalanced }))
      })
      consumer.on('consumer:heartbeat:stalled', () =>
        invalidated(new KafkaAssignmentInvalidation({ reason: KafkaInvalidationReason.HeartbeatStalled })),
      )
      const source = await new Promise<MessagesStream<string, Buffer, string, string>>((resolve, reject) => {
        if (closePromise !== undefined) {
          reject(new Error('Kafka consumer is closed'))
          return
        }
        consumer.consume(
          {
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
          },
          (error, stream) => {
            if (error !== null && error !== undefined) {
              reject(error)
              return
            }
            if (stream === undefined) {
              reject(new Error('Kafka consumer returned no stream'))
              return
            }
            // Node can run _construct and emit an error before a Promise continuation attaches the iterator.
            stream.on('error', (cause) => {
              if (closePromise === undefined) invalidated(cause)
            })
            if (closePromise !== undefined) {
              stream.destroy()
              reject(new Error('Kafka consumer closed during stream acquisition'))
              return
            }
            active = stream
            resolve(stream)
          },
        )
      })
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
              const payload = decodeKafkaTransportValue(message.value, captureRawIdentity, captureRawValues)
              return {
                done: false,
                value: {
                  topic: message.topic,
                  partition: message.partition,
                  offset: String(message.offset),
                  ...payload,
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
    close,
  }
}

export interface KafkaProjectionCut {
  readonly projection: StreamingProjection
  readonly bootstrap: KafkaBootstrapEvidence
  readonly positions: readonly KafkaPartitionPosition[]
}
export interface KafkaProjectionRead extends KafkaProjectionCut {
  readonly consumerSequence: number
  readonly deliveredPositions: readonly KafkaPartitionPosition[]
}
export class KafkaMarketProjection extends Context.Service<
  KafkaMarketProjection,
  {
    readonly read: Effect.Effect<KafkaProjectionRead, KafkaMarketFailure>
    readonly readForLiquidation: Effect.Effect<KafkaProjectionRead, KafkaMarketFailure>
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
  universe: MarketSources,
  factory: KafkaProjectionTransportFactory = platformaticProjectionTransport,
  diagnosticStartMs?: number,
  captureFactory?: NativeArrivalCaptureFactory,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const owner = yield* Effect.scope
    let projection = emptyStreamingProjection(
      'starting',
      universe.find((source) => source.topics.technicalFeatures !== undefined)?.topics.technicalFeatures,
    )
    let projectionConsumerSequence = 0
    let deliveredPositions = new Map<string, KafkaPartitionPosition>()
    let bootstrap: KafkaBootstrapEvidence | undefined
    let positions: readonly KafkaPartitionPosition[] = []
    let ready = false
    let lastFailure: KafkaMarketFailure | undefined
    let closeFailure: KafkaMarketFailure | undefined
    let recovery:
      | { readonly failedEpoch: string; readonly startedAtMs: number; readonly reason: KafkaInvalidationReason }
      | undefined
    const cycle = Effect.scoped(
      Effect.gen(function* () {
        const epoch = yield* Effect.sync(randomUUID)

        let consumerSequence = 0
        let consumerKnownRawBytes = 0
        let consumerUnknownRawByteLengthRecords = 0
        const arrivals = makeKafkaArrivalEnvelope()
        yield* Effect.addFinalizer(() =>
          Effect.logInfo('Kafka market projection arrival measurements finalized', {
            epoch,
            consumerSequence,
            arrivalEnvelope: arrivals.measurement(),
          }),
        )
        projection = emptyStreamingProjection(
          epoch,
          universe.find((source) => source.topics.technicalFeatures !== undefined)?.topics.technicalFeatures,
        )
        projectionConsumerSequence = 0
        deliveredPositions = new Map()
        ready = false
        bootstrap = undefined
        positions = []
        lastFailure = undefined
        closeFailure = undefined

        const transport = yield* Effect.acquireRelease(
          Effect.try({
            try: () => factory(config, epoch, captureFactory !== undefined, captureFactory !== undefined),
            catch: (cause) => failure('connect', 'Kafka client acquisition failed', cause),
          }),
          (resource) =>
            Effect.tryPromise({
              try: () => resource.close(),
              catch: (cause) => failure('close', 'Kafka client close failed', cause),
            }).pipe(
              Effect.tapError((cause) =>
                Effect.sync(() => {
                  closeFailure = cause
                }),
              ),
              Effect.orDie,
            ),
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
        const owners = new Map<string, string>()
        for (const source of universe) {
          const raw = [source.topics.bars, source.topics.quotes, source.topics.trades]
          const sourceTopics = Object.values(source.topics).filter((topic) => topic !== undefined)
          const unique = new Set(sourceTopics)
          if (
            (marketSourceKind(source) === MarketKind.Equity && unique.size !== sourceTopics.length) ||
            (marketSourceKind(source) === MarketKind.Crypto && (new Set(raw).size !== 1 || unique.size !== 2))
          )
            return yield* failure('bootstrap', 'Market source topics violate their channel contract')
          for (const topic of unique) {
            if (owners.has(topic)) return yield* failure('bootstrap', 'Market sources cannot share topics')
            owners.set(topic, source.universeId)
          }
        }
        const topics = [...owners.keys()]
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
        const capture =
          captureFactory === undefined
            ? undefined
            : yield* captureFactory(evidence, universe).pipe(
                Effect.mapError((cause) => failure('bootstrap', 'Native arrival capture could not start', cause)),
              )
        let invalidation: KafkaMarketFailure | undefined
        const terminals = new Map<string, KafkaPartitionPosition>()
        positions = partitions.map((partition) => ({
          topic: partition.topic,
          partition: partition.partition,
          offset: partition.startOffset,
        }))
        deliveredPositions = new Map(
          positions.map((position) => [topicPartitionKey(position.topic, position.partition), { ...position }]),
        )

        const source = yield* operation('consume', () =>
          transport.consume(
            partitions.map((partition) => ({
              topic: partition.topic,
              partition: partition.partition,
              offset: partition.startOffset,
            })),
            (cause) => {
              // Cleanup and SDK rejoin events must not overwrite the first causal failure of this epoch.
              if (projection.epoch !== epoch || invalidation !== undefined) return
              invalidation = failure('consume', 'Kafka assignment invalidated', cause)

              ready = false
              lastFailure = invalidation
              recovery ??= {
                failedEpoch: epoch,
                startedAtMs: clock.currentTimeMillisUnsafe(),
                reason: invalidationReason(cause),
              }
            },
          ),
        )
        let recordsSinceYield = 0
        const consume = Stream.fromAsyncIterable(source, (cause) =>
          failure('consume', 'Kafka consumption failed', cause),
        ).pipe(
          Stream.runForEach((record) =>
            Effect.gen(function* () {
              if (++recordsSinceYield === 256) {
                recordsSinceYield = 0
                yield* Effect.yieldNow
              }
              consumerSequence++
              if (record.tombstone !== true) {
                const byteLength = record.rawByteLength
                if (typeof byteLength === 'number' && Number.isSafeInteger(byteLength) && byteLength >= 0)
                  consumerKnownRawBytes += byteLength
                else consumerUnknownRawByteLengthRecords++
              }
              const availableAtMs = clock.currentTimeMillisUnsafe()
              arrivals.observe(availableAtMs, record.tombstone === true ? 0 : record.rawByteLength)
              const previousProjection = projection
              const previousSequence = projection.sequence
              const deliveryKey = topicPartitionKey(record.topic, record.partition)
              const priorDelivery = deliveredPositions.get(deliveryKey)
              if (priorDelivery === undefined || BigInt(priorDelivery.offset) <= BigInt(record.offset))
                deliveredPositions.set(deliveryKey, {
                  topic: record.topic,
                  partition: record.partition,
                  offset: String(BigInt(record.offset) + 1n),
                })
              if (invalidation === undefined && record.tombstone !== true) {
                const source = marketSourceForTopic(universe, record.topic)
                if (source === undefined)
                  return yield* failure('consume', 'Consumer delivered an unconfigured market topic')
                projection = incorporateMarketRecord(projection, record, source, availableAtMs)
              }
              projectionConsumerSequence = consumerSequence

              if (capture !== undefined)
                yield* capture.observe({
                  record,
                  availableAtMs,
                  consumerSequence,
                  projectionSequence: projection.sequence,
                  disposition:
                    record.tombstone === true
                      ? CaptureDisposition.Rejected
                      : invalidation !== undefined
                        ? CaptureDisposition.Ignored
                        : kafkaCaptureDisposition(previousProjection, projection),
                  assignmentInvalidated: invalidation !== undefined,
                })

              if (invalidation !== undefined) return
              if (record.tombstone === true)
                return yield* failure(
                  'consume',
                  'Kafka consumption failed',
                  new Error('Kafka market message has no payload'),
                )
              terminals.set(topicPartitionKey(record.topic, record.partition), {
                topic: record.topic,
                partition: record.partition,
                offset: record.offset,
              })
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
              if (
                universe.some((source) => record.topic === source.topics.features) &&
                projection.sequence !== previousSequence
              ) {
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
            if (invalidation !== undefined) return yield* invalidation
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
              return yield* failure(
                'bootstrap',
                'Kafka bootstrap deadline exceeded',
                new KafkaBootstrapDeadlineExceeded(),
              )
            if (ready && !announced) {
              announced = true

              yield* Effect.logInfo('Kafka market projection bootstrap completed', {
                epoch,
                partitions: positions.length,
                incorporatedRecords: projection.sequence,
                elapsedMs: (yield* Clock.currentTimeMillis) - observedAtMs,
                rejectedPartitions: projection.rejections.size,
              })
              if (recovery !== undefined) {
                const completed = recovery
                recovery = undefined
                yield* Effect.logInfo('Kafka market projection recovered', {
                  failedEpoch: completed.failedEpoch,
                  recoveredEpoch: epoch,
                  reason: completed.reason,
                  elapsedMs: (yield* Clock.currentTimeMillis) - completed.startedAtMs,
                  incorporatedRecords: projection.sequence,
                  partitions: positions.length,
                })
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
              consumerSequence,
              consumerKnownRawBytes,
              consumerUnknownRawByteLengthRecords,
              arrivalEnvelope: arrivals.measurement(),
              bootstrapComplete: ready,
              available: ready && lastFailure === undefined,
              failureOperation: lastFailure?.operation ?? null,
              failureCodes: lastFailure === undefined ? null : projectionFailureCodes(lastFailure.cause),
              queuedRecords: source.queuedRecords(),
              queueHighWaterMark: 256,
              endOffsetLookupStartedAtMs: lookupStartedAtMs,
              endOffsetLookupCompletedAtMs: measuredAtMs,
              endOffsetLookupFailure: Result.isFailure(ends) ? ends.failure.message : null,
              endOffsetLookupFailureCodes: Result.isFailure(ends) ? safeKafkaFailureCodes(ends.failure.cause) : null,
              nativeArrivalCapture: capture?.status() ?? null,
              partitions: partitionLagMeasurements(positions, Result.isSuccess(ends) ? ends.success : undefined),
              ...projectionCoverageMeasurements(
                projection,
                universe.flatMap((source) => source.symbols),
                measuredAtMs,
              ),
            })
          }
        })
        return yield* Effect.raceFirst(consume, Effect.raceFirst(monitor, report))
      }),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.gen(function* () {
          ready = false
          lastFailure ??= cause

          recovery ??= {
            failedEpoch: projection.epoch,
            startedAtMs: yield* Clock.currentTimeMillis,
            reason: invalidationReason(lastFailure.cause),
          }
          yield* Effect.logWarning('Kafka market projection cycle failed', {
            epoch: projection.epoch,
            operation: lastFailure.operation,
            reason: invalidationReason(lastFailure.cause),
            failureCodes: projectionFailureCodes(lastFailure.cause),
            retryableBySupervisor: true,
          })
        }),
      ),
    )
    const supervision = cycle.pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.spaced(Duration.seconds(1)),
        while: () => closeFailure === undefined,
      }),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
          ready = false
          lastFailure ??= failure('consume', 'Kafka market projection stopped', cause)
          yield* Effect.logError('Kafka market projection stopped', {
            epoch: projection.epoch,
            operation: lastFailure.operation,
            reason: invalidationReason(lastFailure.cause),
            failureCodes: projectionFailureCodes(lastFailure.cause),
            ...(closeFailure === undefined ? {} : { cleanupFailureCodes: safeKafkaFailureCodes(closeFailure.cause) }),
            cooldownMs: 30_000,
          })
          yield* Effect.sleep('30 seconds')
        }),
      ),
    )
    yield* supervision.pipe(Effect.forever, Effect.forkIn(owner))
    let memoPositions = positions
    let offsetMemo: Array<{ last: string; parsedLast: bigint; base: string; next: string | null } | undefined> = []
    const readCut = (requireHistory: boolean) =>
      Effect.suspend(() => {
        // Retain only immutable offset calculations for the current position inventory.
        if (memoPositions !== positions) {
          memoPositions = positions
          offsetMemo = []
        }
        offsetMemo.length = positions.length
        return (!requireHistory || ready) && bootstrap !== undefined && lastFailure === undefined
          ? Effect.succeed({
              projection,
              consumerSequence: projectionConsumerSequence,
              deliveredPositions: canonicalPositions([...deliveredPositions.values()]).map((position) => ({
                ...position,
              })),
              bootstrap,
              positions: positions.map((position, index) => {
                const last = projection.offsets.get(topicPartitionKey(position.topic, position.partition))
                if (last === undefined) return position
                const memo = offsetMemo[index]
                // Preserve conversion before the base getter, and both conversions for non-string inputs.
                const parsedLast = typeof last === 'string' && memo?.last === last ? memo.parsedLast : BigInt(last)
                const base = position.offset
                if (typeof last === 'string' && typeof base === 'string' && memo?.last === last && memo.base === base)
                  return memo.next === null ? position : { ...position, offset: memo.next }
                const advances = parsedLast >= BigInt(base)
                if (typeof last !== 'string' || typeof base !== 'string')
                  return advances ? { ...position, offset: String(BigInt(last) + 1n) } : position
                const next = advances ? String(parsedLast + 1n) : null
                const result = next === null ? position : { ...position, offset: next }
                offsetMemo[index] = { last, parsedLast, base, next }
                return result
              }),
            })
          : Effect.fail(lastFailure ?? failure('read', 'Kafka projection is rebuilding required history'))
      })
    return {
      read: readCut(true),
      readForLiquidation: readCut(false),
      status: Effect.sync(() => ({
        epoch: projection.epoch,
        ready: ready && lastFailure === undefined,
        sequence: projection.sequence,
        ...(lastFailure === undefined ? {} : { failure: lastFailure.message }),
      })),
    }
  })
export const KafkaMarketProjectionLive = (
  config: KafkaMarketConfig,
  universe: MarketSources,
  captureFactory: NativeArrivalCaptureFactory,
) =>
  Layer.effect(KafkaMarketProjection, makeKafkaMarketProjection(config, universe, undefined, undefined, captureFactory))
