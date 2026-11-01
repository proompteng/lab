import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { mock } from 'node:test'
import { Consumer } from '@platformatic/kafka'
import { Redacted } from 'effect'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { platformaticProjectionTransport } from '../market-data/streaming/kafka.ts'

const mode = process.argv[2]
let finishJoin
const closeMock = mock.method(Consumer.prototype, 'close')
const commitMock = mock.method(Consumer.prototype, 'commit', () => {
  throw new Error('ephemeral market readers must not commit offsets')
})
mock.method(Consumer.prototype, 'joinGroup', function (_options, callback) {
  finishJoin = () => {
    this.memberId = 'test-member'
    if (mode === 'payloads') this.assignments = [{ topic: 'bars', partitions: [0] }]
    callback(null, this.memberId)
  }
})

const transport = platformaticProjectionTransport(
  {
    brokers: ['127.0.0.1:1'],
    username: 'test',
    password: Redacted.make('unused'),
    groupPrefix: 'test',
    operationTimeoutMs: 100,
    bootstrapTimeoutMs: 100,
    timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
  },
  'late-stream',
)
const positions = [{ topic: 'bars', partition: 0, offset: '0' }]
const failures = []
if (mode === 'closed') {
  await transport.close()
  await assert.rejects(
    transport.consume(positions, (cause) => failures.push(cause)),
    /closed/i,
  )
  assert.equal(finishJoin, undefined)
} else if (mode === 'late') {
  const rejected = assert.rejects(
    transport.consume(positions, (cause) => failures.push(cause)),
    /closed/i,
  )
  const closing = transport.close()
  setImmediate(() => finishJoin())
  await closing
  await rejected
} else {
  assert.ok(mode === 'construct' || mode === 'shutdown' || mode === 'payloads')
  const constructionError = new Error('offset refresh failed during construction')
  mock.method(Consumer.prototype, 'listOffsets', function (_options, callback) {
    callback(mode === 'construct' ? constructionError : null, new Map([['bars', [mode === 'payloads' ? 3n : 0n]]]))
  })
  const payloads = [Buffer.from('é'), Buffer.from([0x80]), Buffer.alloc(0)]
  if (mode === 'payloads') {
    const originalConsume = Consumer.prototype.consume
    mock.method(Consumer.prototype, 'consume', function (options, callback) {
      return originalConsume.call(this, { ...options, maxFetches: 1 }, callback)
    })
    mock.method(Consumer.prototype, 'metadata', (_options, callback) =>
      setImmediate(() =>
        callback(null, {
          topics: new Map([['bars', { id: 'bar-id', partitions: [{ leader: 0, leaderEpoch: 1, replicas: [0] }] }]]),
          brokers: new Map([[0, {}]]),
        }),
      ),
    )
    mock.method(Consumer.prototype, 'fetch', (_options, callback) =>
      setImmediate(() =>
        callback(null, {
          responses: [
            {
              topicId: 'bar-id',
              partitions: [
                {
                  partitionIndex: 0,
                  records: [
                    {
                      firstOffset: 0n,
                      firstTimestamp: 0n,
                      lastOffsetDelta: 2,
                      attributes: 0,
                      partitionLeaderEpoch: 1,
                      records: payloads.map((value, offsetDelta) => ({
                        value,
                        offsetDelta,
                        timestampDelta: 0n,
                        key: null,
                        headers: [],
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    )
  }
  const attempt = transport.consume(positions, (cause) => failures.push(cause))
  setImmediate(() => finishJoin())
  const stream = await attempt
  if (mode === 'construct') {
    await assert.rejects(stream[Symbol.asyncIterator]().next(), constructionError)
    assert.deepEqual(failures, [constructionError])
  } else if (mode === 'payloads') {
    const records = []
    for await (const record of stream) records.push(record)
    assert.equal(records.length, payloads.length)
    payloads.forEach((bytes, index) => {
      assert.equal(records[index].offset, String(index))
      assert.equal(records[index].value, bytes.toString('utf-8'))
      assert.equal(records[index].rawByteLength, bytes.byteLength)
      assert.equal(records[index].rawValue, undefined)
      assert.equal(records[index].rawValueSha256, undefined)
    })
  } else {
    await nextTurn()
    await transport.close()
  }
}
await nextTurn()
await transport.close()
await nextTurn()
assert.equal(closeMock.mock.callCount(), 1)
assert.equal(closeMock.mock.calls[0].this.closed, true)
assert.equal(closeMock.mock.calls[0].this.streamsCount, 0)
assert.equal(commitMock.mock.callCount(), 0)
if (mode !== 'construct') assert.deepEqual(failures, [])
mock.restoreAll()
console.log(`${mode}: Kafka stream owned and closed without an unhandled error`)
