import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Producer, stringSerializers } from '@platformatic/kafka'
import { PgClient } from '@effect/sql-pg'
import { Clock, Data, Deferred, Effect, Layer, Redacted, Result, Schema } from 'effect'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { sha256 } from '../src/hash'
import { KafkaBootstrapTimestampPolicy } from '../src/market-data/streaming/bootstrap'
import {
  makeKafkaMarketProjection,
  platformaticProjectionTransport,
  type KafkaProjectionTransportFactory,
} from '../src/market-data/streaming/kafka'
import { constructStreamingSnapshot } from '../src/market-data/streaming/snapshot'
import { historicalRawArrivals } from '../src/testing/historical-streaming-fixture'
import { streamingFixture } from '../src/testing/streaming-market-fixture'
import { utcInstantFromEpochMillis } from '../src/time'
import { PostgresClientLive } from '../src/db/postgres-client'
import { postgresMigrations } from '../src/db/postgres-migrations'
import { makeNativeArrivalStore } from '../src/db/native-arrival-postgres'
import { nativeArrivalCaptureId } from '../src/market-data/streaming/native-arrival'
import {
  makeNativeArrivalJournal,
  type NativeArrivalCapture,
} from '../src/market-data/streaming/native-arrival-journal'
import { config as baseConfig } from '../src/testing/runtime-fixtures'
import * as readiness from '../src/market-data/streaming/readiness'

class BenchmarkFailure extends Data.TaggedError('BenchmarkFailure')<{ message: string; cause?: unknown }> {}

const Arguments = Schema.Struct({
  reportPath: Schema.String.check(Schema.isPattern(/^\//)),
  sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  expectedCold: Schema.Literals(['usable', 'missing']),
  profile: Schema.Literals(['tiny', 'mean', 'peak', 'burst']),
  postgresUrl: Schema.String,
})
const [
  reportPath,
  sourceRevision,
  expectedCold = 'usable',
  profile = 'peak',
  postgresUrl = 'postgres://bayn@127.0.0.1:55438/bayn_bootstrap_harness_test',
] = process.argv.slice(2)
const args = Schema.decodeUnknownSync(Arguments)({ reportPath, sourceRevision, expectedCold, profile, postgresUrl })
const database = new URL(args.postgresUrl)
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || !database.pathname.endsWith('_test'))
  throw new Error('Kafka benchmark requires an isolated localhost *_test database')
if (process.versions.node !== '24.11.1') throw new Error('Benchmark requires pinned Node24.11.1')
const kafkaImage = 'confluentinc/cp-kafka@sha256:9026dbbf280d41868b95ae3995e1fdf0f5db5964776fb9581b52a02e3776d727'
const containerName = `bayn-bootstrap-benchmark-${randomUUID().slice(0, 8)}`
const port = 19194
const username = 'synthetic-bootstrap'
const password = 'synthetic-bootstrap-password'
const docker = (command: readonly string[]) =>
  Effect.try({
    try: () =>
      execFileSync('docker', [...command], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DOCKER_HOST: `unix://${join(homedir(), '.docker/run/docker.sock')}` },
      }).trim(),
    catch: (cause) =>
      new BenchmarkFailure({ message: `Disposable benchmark Docker operation failed: ${command[0]}`, cause }),
  })
const physical = Clock.Clock.defaultValue()
const fixture = streamingFixture()
const originalAtMs = Date.parse(fixture.query.observedAt)
const universe = {
  universeId: fixture.protocol.universeId,
  universeSymbolHash: fixture.protocol.universeSymbolHash,
  symbols: fixture.protocol.universe,
  topics: { ...fixture.protocol.sourceTopics, features: fixture.protocol.streamingInput.featureTopic },
}
// Offsets are financial source identity. Offset zero is a valid off-session ignored envelope,
// so the fixture's existing raw offset 1..N and feature input hashes remain exact.
const filler = historicalRawArrivals(
  {
    bars: [],
    quotes: fixture.snapshot.quotes.slice(0, 1),
    trades: [],
  },
  originalAtMs,
)[0]
if (filler === undefined) throw new Error('Missing bootstrap fixture quote')
const decodeRaw = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Finite,
      provider: Schema.String,
      feed: Schema.String,
      delayClass: Schema.String,
      marketSession: Schema.String,
      symbol: Schema.String,
      channel: Schema.String,
      eventTs: Schema.String,
      ingestTs: Schema.String,
      isFinal: Schema.Boolean,
      payload: Schema.Unknown,
    }),
  ),
)
const rawRecords = historicalRawArrivals(
  {
    ...fixture.snapshot,
    trades: fixture.snapshot.trades.map((row) => ({
      ...row,
      eventAt: new Date(originalAtMs - 15_000).toISOString(),
      ingestedAt: new Date(originalAtMs - 15_000).toISOString(),
    })),
  },
  originalAtMs,
).map(({ record }) => ({ ...record, timestampMs: Date.parse(decodeRaw(record.value).ingestTs) }))
const count =
  args.profile === 'tiny'
    ? { quotes: 0, trades: 0 }
    : args.profile === 'mean'
      ? { quotes: 132_920, trades: 14_960 }
      : { quotes: 269_500, trades: 29_820 }
const dense = [universe.topics.quotes, universe.topics.trades].flatMap((topic) => {
  const originals = rawRecords.filter((row) => row.topic === topic)
  const size = topic === universe.topics.quotes ? count.quotes : count.trades
  const horizon = topic === universe.topics.quotes ? 309_000 : 1_809_000
  return Array.from({ length: size }, (_, index) => {
    const original = originals[index % originals.length]
    if (original === undefined) throw new Error('No raw source template')
    const decoded = decodeRaw(original.value)
    const endGapMs = topic === universe.topics.quotes ? 1_001 : 16_000
    const recentBurstCount = 66_566
    const oldCount = size - recentBurstCount
    const atMs =
      topic === universe.topics.quotes && args.profile === 'burst'
        ? index < oldCount
          ? originalAtMs - horizon + Math.floor(((horizon - 20_001) * index) / Math.max(1, oldCount - 1))
          : originalAtMs -
            20_000 +
            Math.floor(((20_000 - endGapMs) * (index - oldCount)) / Math.max(1, recentBurstCount - 1))
        : originalAtMs - horizon + Math.floor(((horizon - endGapMs) * index) / Math.max(1, size - 1))
    const at = utcInstantFromEpochMillis(atMs)
    const payload =
      topic === universe.topics.quotes
        ? Schema.decodeUnknownSync(
            Schema.Struct({ bp: Schema.Finite, ap: Schema.Finite, bs: Schema.Finite, as: Schema.Finite }),
          )(decoded.payload)
        : Schema.decodeUnknownSync(Schema.Struct({ p: Schema.Finite, s: Schema.Finite }))(decoded.payload)
    const material = { ...decoded, eventTs: at, ingestTs: at, payload: { ...payload, t: at } }
    const unpadded = JSON.stringify(material)
    const targetBytes = topic === universe.topics.quotes ? 448 : 426
    const padding = 'x'.repeat(
      Math.max(0, targetBytes - Buffer.byteLength(unpadded) - Buffer.byteLength(',"benchmarkPadding":""')),
    )
    return {
      ...original,
      offset: String(index + 1),
      timestampMs: atMs,
      value: JSON.stringify({ ...material, benchmarkPadding: padding }),
    }
  })
})
const finalRaw = rawRecords.map((row) => ({
  ...row,
  offset: String(
    BigInt(row.offset) +
      BigInt(
        row.topic === universe.topics.quotes ? count.quotes : row.topic === universe.topics.trades ? count.trades : 0,
      ),
  ),
}))
const featureRecords = [...fixture.cut.projection.features.values()].flat().map((row) => ({
  topic: row.topic,
  partition: row.partition,
  offset: row.offset,
  value: JSON.stringify(row.value),
  timestampMs: row.value.computedAtMs,
}))
const offSession = new Date(originalAtMs - 5 * 60 * 60_000).toISOString()
const placeholders = [universe.topics.bars, universe.topics.quotes, universe.topics.trades].map((topic) => {
  const first = rawRecords.find((record) => record.topic === topic)
  if (first === undefined) throw new Error(`No source for ${topic}`)
  const envelope = decodeRaw(first.value)
  return {
    topic,
    partition: 0,
    offset: '0',
    timestampMs: Date.parse(offSession),
    value: JSON.stringify({
      ...envelope,
      eventTs: offSession,
      ingestTs: offSession,
      payload: {
        ...(topic === universe.topics.bars
          ? { o: 100, h: 101, l: 99, c: 100, v: 1 }
          : topic === universe.topics.quotes
            ? { bp: 100, ap: 101, bs: 1, as: 1 }
            : { p: 100, s: 1 }),
        t: offSession,
      },
    }),
  }
})
const ordered = [...placeholders, ...dense, ...finalRaw, ...featureRecords].sort(
  (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition || Number(BigInt(a.offset) - BigInt(b.offset)),
)
for (const topic of Object.values(universe.topics)) {
  const records = ordered.filter((record) => record.topic === topic)
  if (records.some((record, index) => BigInt(record.offset) !== BigInt(index)))
    throw new Error(`Fixture source offsets must already be contiguous for ${topic}`)
}

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [fresh] = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ fresh: Schema.Boolean })))(
    yield* sql`SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public') AS fresh`,
  )
  if (fresh?.fresh !== true) return yield* Effect.die('Kafka benchmark refuses to change a nonempty database')
  yield* postgresMigrations
  const journals: NativeArrivalCapture[] = []
  yield* Effect.acquireRelease(
    docker([
      'run',
      '-d',
      '--pull=never',
      '--name',
      containerName,
      '--tmpfs',
      '/var/lib/kafka/data:rw,size=512m,mode=1777',
      '--tmpfs',
      '/tmp:rw,size=64m',
      '-p',
      `127.0.0.1:${port}:9092`,
      '--entrypoint',
      '/bin/bash',
      '-e',
      'KAFKA_NODE_ID=1',
      '-e',
      'KAFKA_PROCESS_ROLES=broker,controller',
      '-e',
      'KAFKA_LISTENERS=SASL_PLAINTEXT://0.0.0.0:9092,INTERNAL://0.0.0.0:9094,CONTROLLER://0.0.0.0:9093',
      '-e',
      `KAFKA_ADVERTISED_LISTENERS=SASL_PLAINTEXT://127.0.0.1:${port},INTERNAL://localhost:9094`,
      '-e',
      'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,SASL_PLAINTEXT:SASL_PLAINTEXT',
      '-e',
      'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
      '-e',
      'KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093',
      '-e',
      'KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL',
      '-e',
      'KAFKA_SASL_ENABLED_MECHANISMS=SCRAM-SHA-512',
      '-e',
      'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
      '-e',
      'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
      '-e',
      'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
      '-e',
      'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0',
      '-e',
      'KAFKA_LOG_DIRS=/var/lib/kafka/data',
      '-e',
      'KAFKA_LOG_RETENTION_MS=-1',
      '-e',
      'KAFKA_HEAP_OPTS=-Xms128m -Xmx256m',
      '-e',
      'KAFKA_OPTS=-Djava.security.auth.login.config=/tmp/jaas.conf',
      '-e',
      'CLUSTER_ID=MkU3OEVBNTcwNTJENDM2Qk',
      kafkaImage,
      '-c',
      `printf '%s\n' 'KafkaServer { org.apache.kafka.common.security.scram.ScramLoginModule required username="${username}" password="${password}"; };' > /tmp/jaas.conf; exec /etc/confluent/docker/run`,
    ]).pipe(Effect.onError(() => docker(['rm', '-f', containerName]).pipe(Effect.ignore))),
    () =>
      docker(['logs', containerName]).pipe(
        Effect.flatMap((log) =>
          Effect.tryPromise({
            try: () => writeFile(`${args.reportPath}.broker.log`, log),
            catch: (cause) => new BenchmarkFailure({ message: 'Write broker log failed', cause }),
          }),
        ),
        Effect.ignore,
        Effect.andThen(docker(['rm', '-f', containerName])),
        Effect.orDie,
      ),
  )
  const setupDeadline = performance.now() + 50_000
  while (true) {
    const ready = yield* docker([
      'exec',
      containerName,
      'kafka-topics',
      '--bootstrap-server',
      'localhost:9094',
      '--list',
    ]).pipe(Effect.result)
    if (Result.isSuccess(ready)) break
    if (performance.now() > setupDeadline) return yield* Effect.die('Disposable Kafka startup timed out')
    yield* Effect.sleep(200)
  }
  yield* docker([
    'exec',
    containerName,
    'kafka-configs',
    '--bootstrap-server',
    'localhost:9094',
    '--alter',
    '--add-config',
    `SCRAM-SHA-512=[password=${password}]`,
    '--entity-type',
    'users',
    '--entity-name',
    username,
  ])
  for (const topic of Object.values(universe.topics))
    yield* docker([
      'exec',
      containerName,
      'kafka-topics',
      '--bootstrap-server',
      'localhost:9094',
      '--create',
      '--topic',
      topic,
      '--partitions',
      '1',
      '--replication-factor',
      '1',
    ])
  const producer = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Producer<string, string, string, string>({
          clientId: 'bayn-bootstrap-benchmark',
          bootstrapBrokers: [`127.0.0.1:${port}`],
          sasl: { mechanism: 'SCRAM-SHA-512', username, password },
          serializers: stringSerializers,
          autocreateTopics: false,
          acks: -1,
          timeout: 10_000,
          requestTimeout: 10_000,
        }),
    ),
    (client) => Effect.promise(() => client.close(true)),
  )
  const produce = (records: typeof ordered) =>
    Effect.gen(function* () {
      for (let start = 0; start < records.length; start += 1000)
        yield* Effect.tryPromise({
          try: () =>
            producer.send({
              messages: records.slice(start, start + 1000).map((record) => ({
                topic: record.topic,
                partition: record.partition,
                timestamp: BigInt(record.timestampMs),
                value: record.value,
              })),
            }),
          catch: (cause) => new BenchmarkFailure({ message: 'Synthetic Kafka produce failed', cause }),
        })
    })
  const ticks = finalRaw.filter(
    (record) => record.topic === universe.topics.quotes || record.topic === universe.topics.trades,
  )
  yield* produce(ordered.filter((record) => !ticks.includes(record)))
  const measurements: Array<unknown> = []
  const coldUsable: boolean[] = []
  const pauseExpiry: Array<unknown> = []
  let warmProviderRowsHash: string | undefined
  let providerRowsDiffer = false
  const sample = <E = never>(label: string, afterReady?: Effect.Effect<void, E>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const start = performance.now()
        const cpuStart = process.cpuUsage()
        let activeAnchor = afterReady === undefined ? start : undefined
        const semanticNow = () =>
          originalAtMs + (activeAnchor === undefined ? 0 : Math.floor(performance.now() - activeAnchor))
        const clock: Clock.Clock = {
          sleep: (duration) => physical.sleep(duration),
          monotonicTimeNanosUnsafe: () => physical.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: physical.monotonicTimeNanos,
          currentTimeMillisUnsafe: semanticNow,
          currentTimeMillis: Effect.sync(semanticNow),
          currentTimeNanosUnsafe: () => BigInt(semanticNow()) * 1_000_000n,
          currentTimeNanos: Effect.sync(() => BigInt(semanticNow()) * 1_000_000n),
        }
        let records = 0,
          bytes = 0,
          maximumSdkQueue = 0
        const consumedByTopic = new Map<
          string,
          {
            records: number
            rawUtf8Bytes: number
            minKafkaTimestampMs: number
            maxKafkaTimestampMs: number
            firstOffset: string
            lastOffset: string
          }
        >()
        const factory: KafkaProjectionTransportFactory = (...parameters) => {
          const transport = platformaticProjectionTransport(...parameters)
          return {
            ...transport,
            consume: async (...consumeParameters) => {
              const stream = await transport.consume(...consumeParameters)
              return {
                ...stream,
                [Symbol.asyncIterator]() {
                  const iterator = stream[Symbol.asyncIterator]()
                  return {
                    ...iterator,
                    next: async () => {
                      const result = await iterator.next()
                      if (result.done !== true) {
                        records++
                        const rawBytes = Buffer.byteLength(result.value.value)
                        bytes += rawBytes
                        const previous = consumedByTopic.get(result.value.topic)
                        consumedByTopic.set(result.value.topic, {
                          records: (previous?.records ?? 0) + 1,
                          rawUtf8Bytes: (previous?.rawUtf8Bytes ?? 0) + rawBytes,
                          minKafkaTimestampMs: Math.min(
                            previous?.minKafkaTimestampMs ?? Infinity,
                            result.value.timestampMs,
                          ),
                          maxKafkaTimestampMs: Math.max(
                            previous?.maxKafkaTimestampMs ?? -Infinity,
                            result.value.timestampMs,
                          ),
                          firstOffset: previous?.firstOffset ?? result.value.offset,
                          lastOffset: result.value.offset,
                        })
                        maximumSdkQueue = Math.max(maximumSdkQueue, stream.queuedRecords())
                      }
                      return result
                    },
                  }
                },
              }
            },
          }
        }
        return yield* Effect.gen(function* () {
          const hints =
            'makeMarketHints' in readiness
              ? yield* readiness.makeMarketHints(args.sourceRevision, randomUUID())
              : undefined
          const releaseHint = yield* Deferred.make<void>()
          let hintsDelivered = 0
          if (hints !== undefined)
            yield* hints
              .serve(() =>
                Effect.gen(function* () {
                  hintsDelivered++
                  if (hintsDelivered === 1) yield* Deferred.await(releaseHint)
                }),
              )
              .pipe(Effect.forkChild)
          const projection = yield* makeKafkaMarketProjection(
            {
              brokers: [`127.0.0.1:${port}`],
              username,
              password: Redacted.make(password),
              groupPrefix: `bayn-bootstrap-${label}-${randomUUID()}`,
              operationTimeoutMs: 10_000,
              bootstrapTimeoutMs: 300_000,
              timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
            },
            [universe],
            factory,
            undefined,
            (bootstrap, sources) =>
              Effect.gen(function* () {
                const build = {
                  ...baseConfig.build,
                  sourceRevision: args.sourceRevision,
                  imageDigest: `sha256:${sha256(args.sourceRevision)}`,
                }
                const captureId = yield* Effect.fromResult(nativeArrivalCaptureId(build, bootstrap, sources))
                const journal = yield* makeNativeArrivalJournal(
                  { schemaVersion: 'bayn.native-arrival-epoch.v1', captureId, build, bootstrap, sources },
                  makeNativeArrivalStore(sql),
                )
                journals.push(journal)
                return journal
              }),
            hints,
          )
          while (Result.isFailure(yield* projection.check.pipe(Effect.result))) {
            if (performance.now() - start > 300_000) return yield* Effect.die(`Bootstrap ${label} failed to complete`)
            yield* Effect.sleep(20)
          }
          const bootstrapMs = performance.now() - start
          if (afterReady !== undefined) {
            activeAnchor = performance.now()
            yield* afterReady
          }
          if (label === 'warm-A') {
            while (true) {
              const current = yield* projection.read
              if (
                fixture.snapshot.quotes.every(
                  (quote) =>
                    Date.parse(current.projection.quotes.get(quote.symbol)?.value.eventAt ?? '') ===
                    Date.parse(quote.eventAt),
                ) &&
                fixture.snapshot.trades.every(
                  (trade) =>
                    Date.parse(current.projection.trades.get(trade.symbol)?.value.eventAt ?? '') ===
                    originalAtMs - 15_000,
                )
              )
                break
              if (performance.now() - start > 300_000)
                return yield* Effect.die('Final source ticks did not reach warm A')
              yield* Effect.sleep(20)
            }
          }
          const cut = yield* projection.read
          const query = { ...fixture.query, observedAt: utcInstantFromEpochMillis(semanticNow()) }
          const result = constructStreamingSnapshot(cut, query)
          const stale = constructStreamingSnapshot(cut, {
            ...query,
            observedAt: utcInstantFromEpochMillis(originalAtMs + 20_000),
          })
          const cpu = process.cpuUsage(cpuStart)
          const usable = Result.isSuccess(result)
          const providerRowsHash = Result.isSuccess(result)
            ? sha256(
                JSON.stringify({
                  bars: result.success.bars,
                  quotes: result.success.quotes,
                  trades: result.success.trades,
                }),
              )
            : null
          if (label === 'warm-A' && providerRowsHash !== null) warmProviderRowsHash = providerRowsHash
          const matchesWarmProviderRows = providerRowsHash !== null && providerRowsHash === warmProviderRowsHash
          if (usable && !matchesWarmProviderRows) providerRowsDiffer = true
          if (label === 'warm-A' && Result.isFailure(result))
            return yield* Effect.die(`Warm A unusable: ${result.failure.message}`)

          if (Result.isSuccess(stale))
            return yield* Effect.die('Stale provider quote bypassed the original freshness deadline')
          const providerQuoteAgeMs = semanticNow() - Date.parse(fixture.snapshot.quotes[0]?.eventAt ?? '')
          if (usable && providerQuoteAgeMs > fixture.query.maximumQuoteAgeMs)
            return yield* Effect.die('Usable cut exceeded the original quote freshness budget')
          if (label !== 'warm-A') coldUsable.push(usable)
          const measurement = {
            label,
            bootstrapMs,
            completeWallMs: performance.now() - start,
            cpuUserMicros: cpu.user,
            cpuSystemMicros: cpu.system,
            records,
            rawUtf8Bytes: bytes,
            consumedByTopic: [...consumedByTopic].map(([topic, statistics]) => ({ topic, ...statistics })),
            sdkQueueHighWaterConfigured: 256,
            maximumSdkQueueObserved: maximumSdkQueue,
            usable,
            providerRowsHash,
            matchesWarmProviderRows,
            staleRejected: Result.isFailure(stale),
            staleReason: Result.isFailure(stale) ? stale.failure.reason : null,
            providerQuoteAgeMs,
            originalMaximumQuoteAgeMs: fixture.query.maximumQuoteAgeMs,
            originalWindow: { startAt: query.rangeStartAt, endAt: query.rangeEndAt },
            observedAt: query.observedAt,
            positions: cut.positions,
            bootstrap: cut.bootstrap,
            snapshotManifestHash: Result.isSuccess(result) ? sha256(JSON.stringify(result.success.manifest)) : null,
            bars: cut.projection.bars.size,
            quotes: cut.projection.quotes.size,
            trades: cut.projection.trades.size,
            error: Result.isFailure(result) ? String(result.failure) : null,
            actualMarketHintCallback: hints !== undefined,
            hintDeliveryCountAtMeasuredCut: hintsDelivered,
          }
          measurements.push(measurement)
          yield* Effect.tryPromise({
            try: () => appendFile(`${args.reportPath}.samples.ndjson`, JSON.stringify(measurement) + '\n'),
            catch: (cause) => new BenchmarkFailure({ message: 'Write per-trial metrics failed', cause }),
          })
          yield* Deferred.succeed(releaseHint, undefined)
          yield* Effect.yieldNow
          if (label === 'cold-B-1' && args.expectedCold === 'usable') {
            const pausedAt = performance.now()
            const originalDeadline =
              Date.parse(fixture.snapshot.quotes[0]?.eventAt ?? '') + fixture.query.maximumQuoteAgeMs
            yield* Effect.sleep(Math.max(1, originalDeadline - semanticNow() + 5))
            const afterPause = constructStreamingSnapshot(yield* projection.read, {
              ...fixture.query,
              observedAt: utcInstantFromEpochMillis(semanticNow()),
            })
            if (Result.isSuccess(afterPause) || afterPause.failure.reason !== 'freshness')
              return yield* Effect.die('Physical pause did not expire the original quote contract')
            pauseExpiry.push({
              label,
              pausedWallMs: performance.now() - pausedAt,
              providerQuoteAgeMs: semanticNow() - Date.parse(fixture.snapshot.quotes[0]?.eventAt ?? ''),
              reason: afterPause.failure.reason,
              refreshedSource: false,
            })
          }
        }).pipe(Effect.provideService(Clock.Clock, clock))
      }),
    )
  yield* sample('warm-A', produce(ticks).pipe(Effect.asVoid))
  for (let index = 0; index < (args.profile === 'burst' ? 1 : 5); index++) yield* sample(`cold-B-${index + 1}`)
  const captured =
    yield* sql`SELECT capture_id, count(*)::int AS chunks, sum(octet_length(compressed))::text AS compressed_bytes FROM native_arrival_chunks GROUP BY capture_id ORDER BY capture_id`
  if (
    journals.some((journal) => {
      const status = journal.status()
      return status.status !== 'STOPPED' || status.observedConsumerSequence !== status.durableConsumerSequence
    })
  )
    return yield* Effect.die('Native source retention did not stop with exact durable coverage')
  yield* Effect.tryPromise({
    try: () =>
      writeFile(
        args.reportPath,
        JSON.stringify(
          {
            schemaVersion: 'bayn.kafka-bootstrap-benchmark.v1',
            sourceRevision: args.sourceRevision,
            profile: args.profile,
            scope:
              'Actual SCRAM Kafka and default production SDK transport/projection; fixed synthetic source; no full financial engine',
            sourceClock:
              'Original historical anchor plus actual monotonic elapsed in each independent cold bootstrap trial; warm A source eligibility clock starts at final tick publication after preloading; physical sleep and timeouts',
            excluded: ['Dorvud WebSocket', 'Flink', 'Restate', 'inference', 'financial admission and broker mutation'],
            workload: {
              symbols: universe.symbols.length,
              records: ordered.length,
              seedByTopic: Object.values(universe.topics).map((topic) => {
                const records = ordered.filter((record) => record.topic === topic)
                return {
                  topic,
                  records: records.length,
                  rawUtf8Bytes: records.reduce((sum, record) => sum + Buffer.byteLength(record.value), 0),
                  minKafkaTimestampMs: records.reduce(
                    (minimum, record) => Math.min(minimum, record.timestampMs),
                    Infinity,
                  ),
                  maxKafkaTimestampMs: records.reduce(
                    (maximum, record) => Math.max(maximum, record.timestampMs),
                    -Infinity,
                  ),
                  firstOffset: records[0]?.offset ?? null,
                  lastOffset: records.at(-1)?.offset ?? null,
                }
              }),
              activeSymbols: fixture.snapshot.quotes.map((quote) => quote.symbol),
              rawUtf8Bytes: ordered.reduce((n, r) => n + Buffer.byteLength(r.value), 0),
              hash: sha256(JSON.stringify(ordered)),
              sourceQuotesUnchangedAfterWarmA: true,
              retention: 'Task-owned broker log.retention.ms=-1 to retain original historical source timestamps',
              measuredRatesRepresentative: false,
              densityCalibration:
                args.profile === 'burst'
                  ? 'Hypothetical conservative burst: the measured busiest-minute estimate66566quotes is concentrated within20s; NOT a measured20sproductionrate. Total310s/1810s counts unchanged. Ignored padding matches native value byte averages.'
                  : 'Mean/peak counts from Nov11 production Prometheus rolling increase estimates; uniform density is a mean within that tail, NOT a measured20speakworstcase. Ignored padding matches native public quote448B/trade426B averages; synthetic prices are not a representative strategy session.',
              producer: 'deterministic retained fixture seeded before timing, one final tick wave after warm A ready',
            },
            opportunities: {
              expectedCold: coldUsable.length,
              usable: coldUsable.filter(Boolean).length,
              missingOrExpired: coldUsable.filter((value) => !value).length,
            },
            measurements,
            pauseExpiry,
            nativeCapture: {
              implementation: 'actual production hash/compress/journal plus PostgreSQL18 store',
              captured,
              statuses: journals.map((journal) => journal.status()),
            },
          },
          null,
          2,
        ) + '\n',
      ),
    catch: (cause) => new BenchmarkFailure({ message: 'Write benchmark report failed', cause }),
  })
  if (coldUsable.some((usable) => usable !== (args.expectedCold === 'usable')))
    return yield* Effect.die('Cold bootstrap missed expected source outcome; all trials retained in report')
  if (providerRowsDiffer) return yield* Effect.die('Cold bootstrap changed the original warm provider rows')
}).pipe(Effect.scoped)

NodeRuntime.runMain(
  program.pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- standalone benchmark entrypoint owns disposable Kafka
    Effect.provide(
      PostgresClientLive({
        ...baseConfig,
        operationTimeoutMs: 60_000,
        postgres: { url: Redacted.make(args.postgresUrl), tls: false, caPath: '/unused' },
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
)
