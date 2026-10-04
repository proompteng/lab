import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Admin, Producer } from '@platformatic/kafka'
import { Effect, Logger, Redacted } from 'effect'

import { sha256 } from '../hash.ts'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { makeKafkaMarketProjection } from '../market-data/streaming/kafka.ts'
import { CaptureDisposition } from '../research-capture/capture.ts'

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
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
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
            record: (event, observedAtMs) => {
              if (event.kind === 'market-record') receipts.push({ event, observedAtMs })
              if (event.kind === 'consumer-boundary') boundaries.push(event)
            },
            invalidate: (reason) => {
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
    assert.equal(event.disposition, index === 0 ? CaptureDisposition.Accepted : CaptureDisposition.Rejected)
    assert.ok(observedAtMs >= at)
  }
  assert.notEqual(receipts[2].event.rawValueSha256, receipts[3].event.rawValueSha256)
  assert.ok(boundaries.some(({ phase }) => phase === 'ASSIGNED'))
  assert.ok(boundaries.some(({ phase }) => phase === 'STOPPED'))
  console.log('native Kafka: exact raw receipts, tombstone identity, consumer epoch and offsets verified')
} finally {
  await producer.close()
  await admin.close()
}
