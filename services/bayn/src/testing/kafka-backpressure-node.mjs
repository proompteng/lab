import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  Consumer,
  MessagesStream,
  MessagesStreamModes,
  MessagesStreamFallbackModes,
  stringDeserializers,
} from '@platformatic/kafka'

const mode = process.argv[2]
assert.ok(mode === 'drain' || mode === 'interrupt' || mode === 'invalid')
const recordsPerPartition = 5000
const partitions = [0, 1, 2, 3]
const consumer = new Consumer({
  clientId: 'bounded-fixture',
  groupId: 'bounded-fixture',
  bootstrapBrokers: ['127.0.0.1:1'],
  deserializers: stringDeserializers,
})
consumer.assignments = [{ topic: 'quotes', partitions }]
const metadata = {
  topics: new Map([
    [
      'quotes',
      {
        id: 'quote-id',
        partitions: partitions.map((partition) => ({
          leader: partition % 2,
          leaderEpoch: 11,
          replicas: [partition % 2],
        })),
      },
    ],
  ]),
  brokers: new Map([
    [0, {}],
    [1, {}],
  ]),
}
mock.method(consumer, 'metadata', (_options, callback) => setImmediate(() => callback(null, metadata)))
mock.method(consumer, 'listOffsets', (_options, callback) =>
  setImmediate(() => callback(null, new Map([['quotes', partitions.map(() => BigInt(recordsPerPartition + 2))]]))),
)
let fetches = 0
let maxQueue = 0
mock.method(consumer, 'fetch', (options, callback) => {
  fetches += 1
  assert.ok(fetches <= 2, 'another response fetched before the current responses drained')
  const responses = options.topics.map((topic) => ({
    topicId: topic.topicId,
    partitions: topic.partitions.map(({ partition }) => ({
      partitionIndex: partition,
      records: [
        {
          firstOffset: 0n,
          firstTimestamp: 0n,
          lastOffsetDelta: recordsPerPartition,
          attributes: 0,
          partitionLeaderEpoch: 7,
          records: Array.from({ length: recordsPerPartition + 1 }, (_, index) => ({
            offsetDelta: index,
            timestampDelta: BigInt(index),
            key: null,
            headers: [],
            value: Buffer.from(`${partition}:${index}`),
          })),
        },
        {
          firstOffset: BigInt(recordsPerPartition + 1),
          firstTimestamp: 0n,
          lastOffsetDelta: 0,
          attributes: 32,
          partitionLeaderEpoch: 7,
          records: [],
        },
      ],
    })),
  }))
  setImmediate(() => {
    callback(null, { responses })
    maxQueue = Math.max(maxQueue, stream.readableLength)
  })
})
const stream = new MessagesStream(consumer, {
  topics: ['quotes'],
  mode: MessagesStreamModes.MANUAL,
  fallbackMode: MessagesStreamFallbackModes.FAIL,
  offsets: partitions.map((partition) => ({ topic: 'quotes', partition, offset: 1n })),
  autocommit: false,
  maxFetches: 1,
  highWaterMark: 256,
  deserializers:
    mode !== 'invalid'
      ? stringDeserializers
      : {
          ...stringDeserializers,
          value: (value) => {
            if (value?.toString().endsWith(':3')) throw new Error('invalid value')
            return value?.toString()
          },
        },
})
const seen = new Map(partitions.map((partition) => [partition, 0]))
let received = 0
let rejected = false
try {
  for await (const message of stream) {
    const expected = seen.get(message.partition) + 1
    assert.equal(Number(message.offset), expected)
    assert.equal(message.value, `${message.partition}:${expected}`)
    assert.equal(message.leaderEpoch, 7)
    seen.set(message.partition, expected)
    received += 1
    maxQueue = Math.max(maxQueue, stream.readableLength)
    assert.ok(stream.readableLength <= stream.readableHighWaterMark)
    if (received === 1) assert.equal(stream.offsetsToFetch.get(`quotes:${message.partition}`), 1n)
    if (received % 32 === 0) await nextTurn()
    if (mode === 'interrupt' && received === 123) break
  }
  if (mode === 'drain') {
    assert.equal(received, recordsPerPartition * partitions.length)
    for (const partition of partitions)
      assert.equal(stream.offsetsToFetch.get(`quotes:${partition}`), BigInt(recordsPerPartition + 2))
  } else assert.equal(received, 123)
} catch (error) {
  if (mode !== 'invalid') throw error
  assert.match(error.message, /Failed to deserialize a message/)
  rejected = true
} finally {
  stream.destroy()
  await new Promise((resolve, reject) => consumer.close(true, (error) => (error ? reject(error) : resolve())))
  await nextTurn()
  mock.restoreAll()
}
if (mode === 'invalid') assert.equal(rejected, true)
assert.ok(maxQueue <= stream.readableHighWaterMark)
console.log(`${mode}: bounded real Kafka stream preserved offsets and released its response`)
