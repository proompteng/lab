import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Admin, Producer } from '@platformatic/kafka'
import { Redacted } from 'effect'

import { platformaticProjectionTransport } from '../market-data/streaming/kafka.ts'
import { sha256 } from '../hash.ts'

const username = process.env.BAYN_TEST_KAFKA_USERNAME
const password = process.env.BAYN_TEST_KAFKA_PASSWORD
assert.ok(username && password)
const token = randomUUID()
const topic = `market-data-replay-${token}`
const config = {
  brokers: ['127.0.0.1:19092'],
  username,
  password: Redacted.make(password),
  groupPrefix: 'isolated-market-data-replay',
  operationTimeoutMs: 5000,
  bootstrapTimeoutMs: 15000,
  timestampPolicy: 'retained-beginning',
}
const connection = {
  bootstrapBrokers: config.brokers,
  sasl: { mechanism: 'SCRAM-SHA-512', username, password },
  requestTimeout: 5000,
  connectTimeout: 5000,
  retries: 2,
}
const admin = new Admin({ ...connection, clientId: `${token}-admin` })
const producer = new Producer({
  ...connection,
  clientId: `${token}-producer`,
  autocreateTopics: false,
  idempotent: true,
})
const at = Date.now()
const payloads = [
  Buffer.from('{"symbol":"AAPL"}'),
  Buffer.from('é'),
  Buffer.from([0x80]),
  Buffer.from([0x81]),
  Buffer.alloc(0),
  undefined,
]
try {
  await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 })
  await producer.send({
    messages: payloads.map((value, index) => ({
      topic,
      partition: 0,
      key: Buffer.from(String(index)),
      value,
      timestamp: BigInt(at),
    })),
  })
  const passes = []
  for (let pass = 0; pass < 2; pass++) {
    const consumer = platformaticProjectionTransport(config, `${token}-${pass}`, true, true)
    const rows = []
    const timer = setTimeout(() => {
      void consumer.close()
    }, 15000)
    try {
      const stream = await consumer.consume([{ topic, partition: 0, offset: '0' }], () =>
        assert.fail('Unexpected assignment change'),
      )
      for await (const record of stream) {
        rows.push(record)
        if (rows.length === payloads.length) break
      }
      assert.equal(rows.length, payloads.length)
      rows.forEach((row, index) => {
        const expected = payloads[index]
        assert.equal(row.offset, String(index))
        assert.equal(row.timestampMs, at)
        assert.equal(row.rawValueSha256, expected === undefined ? null : sha256(expected))
        assert.equal(row.rawByteLength, expected === undefined ? null : expected.length)
        assert.deepEqual(row.rawValue, expected === undefined ? null : expected)
      })
      passes.push(rows)
    } finally {
      clearTimeout(timer)
      await consumer.close()
    }
  }
  assert.deepEqual(passes[0], passes[1])
  console.log(
    'market-data-replay: original Kafka bytes, offsets and timestamps replay identically after consumer replacement, including malformed UTF8, empty values and tombstones',
  )
} finally {
  await producer.close()
  await admin.close()
}
