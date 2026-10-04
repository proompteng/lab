import { randomUUID } from 'node:crypto'
import { sha256 } from '../../hash'
import {
  CaptureDisposition,
  capturesResearchRawValues,
  CaptureInvalidation,
  invalidateResearchCapture,
  recordResearchCapture,
  type ResearchCaptureObserver,
} from '../../research-capture/capture'
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
  TransportFailure = 'TRANSPORT_FAILURE',
}

class KafkaAssignmentInvalidation extends Data.TaggedError('KafkaAssignmentInvalidation')<{
  readonly reason: KafkaInvalidationReason
}> {}

const invalidationReason = (cause: unknown): KafkaInvalidationReason =>
  cause instanceof KafkaAssignmentInvalidation ? cause.reason : KafkaInvalidationReason.TransportFailure

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
  value: Buffer | string | undefined,
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
  if (typeof value === 'string') return { value }
  const rawIdentity = captureRawIdentity ? { rawValueSha256: sha256(value), rawByteLength: value.byteLength } : {}
  return { ...rawIdentity, ...(captureRawValues ? { rawValue: value } : {}), value: value.toString('utf-8') }
}

export const kafkaCaptureDisposition = (previous: StreamingProjection, next: StreamingProjection) => {
  if (next.rejections !== previous.rejections || next.technicalRejections !== previous.technicalRejections)
    return CaptureDisposition.Rejected
  return next.bars !== previous.bars ||
    next.quotes !== previous.quotes ||
    next.trades !== previous.trades ||
    next.features !== previous.features ||
    next.technicalFeatures !== previous.technicalFeatures
    ? CaptureDisposition.Accepted
    : CaptureDisposition.Ignored
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
  const consumer = new Consumer<string, string | Buffer, string, string>({
    clientId: `bayn-market-${epoch}`,
    groupId: `${config.groupPrefix}-${epoch}`,
    bootstrapBrokers: [...config.brokers],
    deserializers: captureRawIdentity
      ? { ...stringDeserializers, value: (data?: Buffer) => data }
      : stringDeserializers,
    sasl: { mechanism: 'SCRAM-SHA-512', username: config.username, password: Redacted.value(config.password) },
    autocreateTopics: false,
    timeout: config.operationTimeoutMs,
    requestTimeout: config.operationTimeoutMs,
    connectTimeout: config.operationTimeoutMs,
    retries: 2,
    retryDelay: 250,
  })
  let closePromise: Promise<void> | undefined
  let active: MessagesStream<string, string | Buffer, string, string> | undefined
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
      const source = await new Promise<MessagesStream<string, string | Buffer, string, string>>((resolve, reject) => {
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
export class KafkaMarketProjection extends Context.Service<
  KafkaMarketProjection,
  {
    readonly read: Effect.Effect<KafkaProjectionCut, KafkaMarketFailure>
    readonly readForLiquidation: Effect.Effect<KafkaProjectionCut, KafkaMarketFailure>
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
  capture?: ResearchCaptureObserver,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const owner = yield* Effect.scope
    let projection = emptyStreamingProjection('starting', universe.topics.technicalFeatures)
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
        projection = emptyStreamingProjection(epoch, universe.topics.technicalFeatures)
        ready = false
        bootstrap = undefined
        positions = []
        lastFailure = undefined
        closeFailure = undefined
        recordResearchCapture(capture, {
          kind: 'consumer-boundary',
          consumerEpoch: epoch,
          phase: 'STARTED',
          positions: [],
        })
        const transport = yield* Effect.acquireRelease(
          Effect.try({
            try: () => factory(config, epoch, capture !== undefined, capturesResearchRawValues(capture)),
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
              Effect.ensuring(
                Effect.sync(() =>
                  recordResearchCapture(capture, {
                    kind: 'consumer-boundary',
                    consumerEpoch: epoch,
                    phase: 'STOPPED',
                    positions,
                  }),
                ),
              ),
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
        let invalidation: KafkaMarketFailure | undefined
        positions = partitions.map((partition) => ({
          topic: partition.topic,
          partition: partition.partition,
          offset: partition.startOffset,
        }))
        recordResearchCapture(capture, {
          kind: 'consumer-boundary',
          consumerEpoch: epoch,
          phase: 'ASSIGNED',
          positions,
          bootstrap: evidence,
        })
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
              recordResearchCapture(capture, {
                kind: 'consumer-boundary',
                consumerEpoch: epoch,
                phase: 'INVALIDATED',
                positions,
                reason: invalidationReason(cause),
              })
              invalidateResearchCapture(capture, CaptureInvalidation.AssignmentChanged)
            },
          ),
        )
        const terminals = new Map<string, KafkaPartitionPosition>()
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
              if (invalidation !== undefined && capture === undefined) return
              const availableAtMs = clock.currentTimeMillisUnsafe()
              consumerSequence++
              const previousProjection = projection
              const previousSequence = projection.sequence
              if (invalidation === undefined && record.tombstone !== true)
                projection = incorporateMarketRecord(projection, record, universe, availableAtMs)
              if (capture !== undefined) {
                recordResearchCapture(
                  capture,
                  {
                    kind: 'market-record',
                    consumerEpoch: epoch,
                    consumerSequence,
                    projectionSequence: projection.sequence,
                    topic: record.topic,
                    partition: record.partition,
                    offset: record.offset,
                    rawValueSha256: record.rawValueSha256 ?? null,
                    rawByteLength: record.rawByteLength ?? null,
                    tombstone: record.tombstone === true,
                    bootstrap: !ready,
                    disposition:
                      record.tombstone === true
                        ? CaptureDisposition.Rejected
                        : invalidation !== undefined
                          ? CaptureDisposition.Ignored
                          : kafkaCaptureDisposition(previousProjection, projection),
                    ...(record.tombstone === true
                      ? { reason: 'tombstone' }
                      : invalidation !== undefined
                        ? { reason: 'assignment-invalidated' }
                        : {}),
                  },
                  availableAtMs,
                  record.rawValue,
                )
                if (
                  record.tombstone !== true &&
                  (record.rawValueSha256 === undefined || record.rawByteLength === undefined)
                )
                  invalidateResearchCapture(capture, CaptureInvalidation.MissingRawIdentity)
              }
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
              return yield* failure('bootstrap', 'Kafka bootstrap deadline exceeded')
            if (ready && !announced) {
              announced = true
              recordResearchCapture(capture, {
                kind: 'consumer-boundary',
                consumerEpoch: epoch,
                phase: 'BOOTSTRAPPED',
                positions,
              })
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
              bootstrapComplete: ready,
              available: ready && lastFailure === undefined,
              failureOperation: lastFailure?.operation ?? null,
              failureCodes: lastFailure === undefined ? null : safeKafkaFailureCodes(lastFailure.cause),
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
        Effect.gen(function* () {
          ready = false
          lastFailure ??= cause
          invalidateResearchCapture(capture, CaptureInvalidation.AssignmentChanged)
          recovery ??= {
            failedEpoch: projection.epoch,
            startedAtMs: yield* Clock.currentTimeMillis,
            reason: invalidationReason(lastFailure.cause),
          }
          yield* Effect.logWarning('Kafka market projection cycle failed', {
            epoch: projection.epoch,
            operation: lastFailure.operation,
            reason: invalidationReason(lastFailure.cause),
            failureCodes: safeKafkaFailureCodes(lastFailure.cause),
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
            failureCodes: safeKafkaFailureCodes(lastFailure.cause),
            ...(closeFailure === undefined ? {} : { cleanupFailureCodes: safeKafkaFailureCodes(closeFailure.cause) }),
            cooldownMs: 30_000,
          })
          yield* Effect.sleep('30 seconds')
        }),
      ),
    )
    yield* supervision.pipe(Effect.forever, Effect.forkIn(owner))
    const readCut = (requireHistory: boolean) =>
      Effect.suspend(() => {
        return (!requireHistory || ready) && bootstrap !== undefined && lastFailure === undefined
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
export const KafkaMarketProjectionLive = (config: KafkaMarketConfig, universe: StreamingUniverse) =>
  Layer.effect(KafkaMarketProjection, makeKafkaMarketProjection(config, universe))
