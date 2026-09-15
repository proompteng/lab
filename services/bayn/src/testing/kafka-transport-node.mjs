import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { mock } from 'node:test'
import { Consumer } from '@platformatic/kafka'
import { Redacted } from 'effect'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { platformaticProjectionTransport } from '../market-data/streaming/kafka.ts'

let finishJoin
const closeMock = mock.method(Consumer.prototype, 'close')
mock.method(Consumer.prototype, 'joinGroup', function (_options, callback) {
  finishJoin = () => {
    this.memberId = 'test-member'
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
const mode = process.argv[2]
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
  assert.ok(mode === 'construct' || mode === 'shutdown')
  const constructionError = new Error('offset refresh failed during construction')
  mock.method(Consumer.prototype, 'listOffsets', function (_options, callback) {
    callback(mode === 'construct' ? constructionError : null, new Map([['bars', [0n]]]))
  })
  const attempt = transport.consume(positions, (cause) => failures.push(cause))
  setImmediate(() => finishJoin())
  const stream = await attempt
  if (mode === 'construct') {
    await assert.rejects(stream[Symbol.asyncIterator]().next(), constructionError)
    assert.deepEqual(failures, [constructionError])
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
if (mode !== 'construct') assert.deepEqual(failures, [])
mock.restoreAll()
console.log(`${mode}: Kafka stream owned and closed without an unhandled error`)
