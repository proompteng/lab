import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Admin, Producer } from '@platformatic/kafka'
import { Effect, Logger, Redacted, Result } from 'effect'

import { canonicalHashV1, sha256 } from '../hash.ts'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { makeKafkaMarketProjection } from '../market-data/streaming/kafka.ts'
import { CaptureDisposition, restoreKafkaTransportTimestamp } from '../research-capture/capture.ts'
import { makeResearchCaptureRecorder } from '../research-capture/recorder.ts'
import { verifyResearchCaptureExport } from '../research-capture/export.ts'
import { readResearchCaptureInterval } from '../research-capture/replay.ts'

const username = process.env.BAYN_TEST_KAFKA_USERNAME
const password = process.env.BAYN_TEST_KAFKA_PASSWORD
assert.match(username ?? '', /^bayn-fixture-[0-9a-f]+$/)
assert.match(password ?? '', /^[0-9a-f]{64}$/)
const brokers = ['127.0.0.1:19092']
const connection = {
  bootstrapBrokers: brokers,
  sasl: { mechanism: 'SCRAM-SHA-512', username, password },
  retries: 2,
  requestTimeout: 5_000,
  connectTimeout: 5_000,
  timeout: 5_000,
}
const prefix = `bayn-capture-${randomUUID()}`
const topics = Object.fromEntries(['bars', 'quotes', 'trades', 'features'].map((kind) => [kind, `${prefix}-${kind}`]))
const admin = new Admin({ ...connection, clientId: `${prefix}-admin` })
const producer = new Producer({ ...connection, clientId: `${prefix}-producer` })
const transactional = new Producer({
  ...connection,
  clientId: `${prefix}-transactional`,
  transactionalId: `${prefix}-transaction`,
  idempotent: true,
})
let openTransaction
try {
  await admin.createTopics({ topics: Object.values(topics), partitions: 1, replicas: 1 })
  const at = Date.now()
  const atText = new Date(at).toISOString()
  const payloads = [
    Buffer.from(
      JSON.stringify({
        version: 2,
        provider: 'alpaca',
        feed: 'iex',
        delayClass: 'real_time_exchange_only',
        marketSession: 'regular',
        channel: 'quotes',
        symbol: 'AAPL',
        eventTs: atText,
        ingestTs: atText,
        payload: { t: atText, bp: 200, ap: 200.01, bs: 100, as: 100 },
      }),
    ),
    Buffer.from('é'),
    Buffer.from([0x80]),
    Buffer.from([0x81]),
    Buffer.alloc(0),
    undefined,
  ]
  await producer.send({
    messages: payloads.map((value, index) => ({
      topic: topics.quotes,
      partition: 0,
      key: Buffer.from(String(index)),
      value,
      timestamp: BigInt(at),
    })),
  })
  const receipts = []
  const boundaries = []
  const invalidations = []
  const chunks = []
  const seals = []
  const objects = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* makeResearchCaptureRecorder(
          {
            append: (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk)
              }),
            seal: (seal) =>
              Effect.sync(() => {
                seals.push(seal)
              }),
          },
          {
            captureId: prefix,
            sourceRevision: 'a'.repeat(40),
            maximumQueuedReceipts: 64,
            maximumQueuedBytes: 256 * 1024,
            maximumReceiptBytes: 64 * 1024,
            flushIntervalMs: 50,
            writeTimeoutMs: 1000,
          },
          {
            putVerified: (object) =>
              Effect.sync(() => {
                objects.push({ ...object, payload: Buffer.from(object.payload) })
              }),
          },
        )
        yield* makeKafkaMarketProjection(
          {
            brokers,
            username,
            password: Redacted.make(password),
            groupPrefix: prefix,
            operationTimeoutMs: 5_000,
            bootstrapTimeoutMs: 15_000,
            timestampPolicy: KafkaBootstrapTimestampPolicy.RetainedBeginning,
          },
          {
            universeId: prefix,
            universeSymbolHash: 'a'.repeat(64),
            symbols: ['AAPL'],
            topics,
          },
          undefined,
          undefined,
          {
            rawValues: true,
            record: (event, observedAtMs, rawValue) => {
              recorder.record(event, observedAtMs, rawValue)
              if (event.kind === 'market-record') receipts.push({ event, observedAtMs })
              if (event.kind === 'consumer-boundary') boundaries.push(event)
            },
            invalidate: (reason) => {
              recorder.invalidate(reason)
              invalidations.push(reason)
            },
          },
        )
        while (receipts.length < payloads.length) yield* Effect.sleep(10)
      }),
    ).pipe(Effect.timeout('20 seconds'), Effect.provide(Logger.layer([]))),
  )
  assert.equal(receipts.length, payloads.length)
  assert.equal(new Set(receipts.map(({ event }) => event.consumerEpoch)).size, 1)
  assert.deepEqual(
    receipts.map(({ event }) => event.consumerSequence),
    [1, 2, 3, 4, 5, 6],
  )
  assert.deepEqual(
    receipts.map(({ event }) => event.offset),
    ['0', '1', '2', '3', '4', '5'],
  )
  for (const [index, { event, observedAtMs }] of receipts.entries()) {
    const raw = payloads[index]
    assert.equal(event.rawValueSha256, raw === undefined ? null : sha256(raw))
    assert.equal(event.rawByteLength, raw === undefined ? null : raw.byteLength)
    assert.equal(event.tombstone, raw === undefined)
    assert.equal(restoreKafkaTransportTimestamp(event.originalTransport), at)
    assert.equal(event.disposition, index === 0 ? CaptureDisposition.Accepted : CaptureDisposition.Rejected)
    assert.ok(observedAtMs >= at)
  }
  assert.notEqual(receipts[2].event.rawValueSha256, receipts[3].event.rawValueSha256)
  const objectText = (object) => ({ contentHash: object.contentHash, payload: object.payload.toString('utf8') })
  const exported = chunks.map((metadata, index) => ({
    metadata,
    raw: objects[index * 3].payload,
    index: objectText(objects[index * 3 + 2]),
  }))
  const verified = Result.getOrThrow(verifyResearchCaptureExport(exported, seals[0], objectText(objects.at(-1))))
  assert.equal(verified.complete, false)
  assert.equal(verified.exportVerified, true)
  assert.deepEqual(
    Buffer.concat(exported.map((chunk) => chunk.raw)),
    Buffer.concat(payloads.filter((value) => value !== undefined)),
  )
  assert.ok(boundaries.some(({ phase }) => phase === 'ASSIGNED'))
  assert.ok(boundaries.some(({ phase }) => phase === 'STOPPED'))
  console.log(
    'native Kafka: original bytes, immutable export ranges, tombstones, consumer epoch and offsets verified; UNQUALIFIED',
  )

  const configuredTopics = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const executionConfig = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const findTechnicalTopic = (value) => {
    if (value === null || typeof value !== 'object') return undefined
    if (value.name === 'BAYN_KAFKA_TECHNICAL_FEATURES_TOPIC') return value.value
    return Object.values(value)
      .map(findTechnicalTopic)
      .find((topic) => topic !== undefined)
  }
  const technicalTopic = findTechnicalTopic(executionConfig)
  assert.equal(typeof technicalTopic, 'string')
  const configured = {
    bars: 'torghut.bars.1m.v1',
    quotes: 'torghut.quotes.v1',
    trades: 'torghut.trades.v1',
    features: 'torghut.market-features.v1',
    technicalFeatures: technicalTopic,
  }
  const intervalTopics = Object.fromEntries(Object.keys(configured).map((kind) => [kind, `${prefix}-interval-${kind}`]))
  const expectedPartitions = []
  for (const [kind, configuredName] of Object.entries(configured)) {
    const definition = configuredTopics.find(
      (topic) => topic.kind === 'KafkaTopic' && topic.metadata.name === configuredName,
    )
    assert.ok(definition)
    await admin.createTopics({ topics: [intervalTopics[kind]], partitions: definition.spec.partitions, replicas: 1 })
    for (let partition = 0; partition < definition.spec.partitions; partition++)
      expectedPartitions.push({ topic: intervalTopics[kind], partition })
  }
  expectedPartitions.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)
  assert.equal(expectedPartitions.length, 25)
  const message = (value) => ({ topic: intervalTopics.quotes, partition: 0, value, timestamp: BigInt(at) })
  const aborted = await transactional.beginTransaction()
  await aborted.send({ messages: [message(Buffer.from('aborted-transaction'))] })
  await aborted.abort()
  const committed = await transactional.beginTransaction()
  await committed.send({ messages: [message(payloads[0]), message(Buffer.from([0x80])), message(Buffer.alloc(0))] })
  await committed.commit()
  openTransaction = await transactional.beginTransaction()
  await openTransaction.send({ messages: [message(Buffer.from('committed-after-interval'))] })
  const intervalUniverse = {
    universeId: prefix,
    universeSymbolHash: 'a'.repeat(64),
    symbols: ['AAPL'],
    topics: intervalTopics,
  }
  const intervalChunks = []
  const intervalSeals = []
  const intervalObjects = new Map()
  const delivered = []
  const observedBoundaries = []
  let replayed
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const recorder = yield* makeResearchCaptureRecorder(
          {
            append: (chunk) => Effect.sync(() => intervalChunks.push(chunk)),
            seal: (seal) => Effect.sync(() => intervalSeals.push(seal)),
          },
          {
            captureId: `${prefix}-interval`,
            sourceRevision: 'a'.repeat(40),
            maximumQueuedReceipts: 128,
            maximumQueuedBytes: 1024 * 1024,
            maximumReceiptBytes: 64 * 1024,
            flushIntervalMs: 50,
            writeTimeoutMs: 1000,
          },
          {
            putVerified: (object) =>
              Effect.sync(() => intervalObjects.set(object.contentHash, Buffer.from(object.payload))),
          },
        )
        const market = yield* makeKafkaMarketProjection(
          {
            brokers,
            username,
            password: Redacted.make(password),
            groupPrefix: prefix,
            operationTimeoutMs: 5000,
            bootstrapTimeoutMs: 15000,
            timestampPolicy: KafkaBootstrapTimestampPolicy.RetainedBeginning,
          },
          intervalUniverse,
          undefined,
          undefined,
          {
            rawValues: true,
            record: (event, observedAtMs, rawValue) => {
              recorder.record(event, observedAtMs, rawValue)
              if (event.kind === 'market-record') delivered.push({ event, observedAtMs })
              if (event.kind === 'consumer-boundary') observedBoundaries.push({ event, observedAtMs })
            },
            invalidate: recorder.invalidate,
          },
        )
        while (delivered.length < 3 || !(yield* market.status).ready) yield* Effect.sleep(10)
        assert.equal(delivered.length, 3)
        assert.deepEqual(
          delivered.map(({ event }) => event.offset),
          ['2', '3', '4'],
        )
        assert.deepEqual(
          delivered.map(({ event }) => event.disposition),
          [CaptureDisposition.Accepted, CaptureDisposition.Rejected, CaptureDisposition.Rejected],
        )
        const assigned = observedBoundaries.find(({ event }) => event.phase === 'ASSIGNED')
        assert.ok(assigned)
        const request = {
          intervalId: 'native-committed-interval',
          coverageStartMs: assigned.observedAtMs,
          coverageEndMs: Date.now(),
          universeHash: canonicalHashV1(intervalUniverse),
          expectedPartitions,
        }
        let cut
        while (cut === undefined) {
          assert.equal((yield* market.status).ready, true)
          const attempt = yield* market.captureInterval(request).pipe(Effect.result)
          if (Result.isSuccess(attempt)) cut = attempt.success
          else {
            assert.match(
              attempt.failure.message,
              /Capture committed fence has not observed the interval end|Capture interval is not drained/,
            )
            yield* Effect.sleep(100)
          }
        }
        assert.ok(cut.committedFence.lookupStartedAtMs >= request.coverageEndMs)
        assert.ok(cut.committedFence.lookupCompletedAtMs >= cut.committedFence.lookupStartedAtMs)
        console.log('native Kafka committed-fence sample', {
          waitMs: cut.committedFence.lookupStartedAtMs - request.coverageEndMs,
          lookupMs: cut.committedFence.lookupCompletedAtMs - cut.committedFence.lookupStartedAtMs,
        })
        assert.equal(cut.finalConsumerSequence, 3)
        assert.equal(
          cut.committedFence.positions.find(
            (position) => position.topic === intervalTopics.quotes && position.partition === 0,
          ).offset,
          '6',
        )
        const nativeProjection = (yield* market.read).projection
        yield* recorder.finish
        const exactSeal = intervalSeals[0]
        assert.ok(exactSeal)
        const retained = intervalChunks.flatMap((chunk) => JSON.parse(chunk.payload).receipts)
        assert.equal(
          retained.some(({ event }) => event.kind === 'consumer-boundary' && event.phase === 'STOPPED'),
          false,
        )
        replayed = yield* readResearchCaptureInterval({
          seal: exactSeal,
          maximumBytes: 4 * 1024 * 1024,
          request,
          universe: intervalUniverse,
          readObject: (hash, limit) =>
            Effect.sync(() => {
              const bytes = intervalObjects.get(hash)
              assert.ok(bytes)
              assert.ok(bytes.byteLength <= limit)
              return bytes
            }),
          readMetadataChunk: (ordinal) =>
            Effect.sync(() => {
              assert.ok(intervalChunks[ordinal])
              return intervalChunks[ordinal]
            }),
        })
        assert.equal(replayed.structurallyClosed, false)
        assert.equal(replayed.controllerCoverage, 'UNKNOWN')
        assert.equal(replayed.manifest.recordCount, 3)
        assert.deepEqual(replayed.cursor.projection.quotes, nativeProjection.quotes)
        assert.deepEqual(replayed.cursor.projection.rejections, nativeProjection.rejections)
        const retainedCount = intervalChunks.length
        const objectCount = intervalObjects.size
        yield* Effect.promise(() => openTransaction.commit())
        openTransaction = undefined
        while (delivered.length < 4) yield* Effect.sleep(10)
        assert.equal(delivered[3].event.offset, '6')
        assert.equal(intervalChunks.length, retainedCount)
        assert.equal(intervalObjects.size, objectCount)
        assert.equal(intervalSeals.length, 1)
        assert.equal(intervalSeals[0].payload, exactSeal.payload)
        assert.equal(replayed.manifest.recordCount, 3)
      }),
    ).pipe(Effect.timeout('45 seconds'), Effect.provide(Logger.layer([]))),
  )
  assert.ok(observedBoundaries.some(({ event }) => event.phase === 'STOPPED'))
  console.log(
    'native Kafka: configured 25-partition read-committed interval, transaction gaps, open transaction excluded, original replay equivalence, durable seal while consumer continues; UNQUALIFIED',
  )
} finally {
  if (openTransaction !== undefined) await openTransaction.abort()
  await transactional.close()
  await producer.close()
  await admin.close()
}
