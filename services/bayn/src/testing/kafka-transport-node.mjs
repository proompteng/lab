import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { mock } from 'node:test'
import { Consumer } from '@platformatic/kafka'
import { Redacted } from 'effect'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { platformaticProjectionTransport } from '../market-data/streaming/kafka.ts'

let finishJoin
let consumer
mock.method(Consumer.prototype, 'joinGroup', function (_options, callback) {
  consumer = this
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
const attempt = transport.consume([{ topic: 'bars', partition: 0, offset: '0' }], () => {})
const rejected = assert.rejects(attempt, /closed/i)
const closing = transport.close()
setImmediate(() => finishJoin())
await closing
await rejected
await nextTurn()
await transport.close()
assert.equal(consumer.closed, true)
assert.equal(consumer.streamsCount, 0)
mock.restoreAll()
console.log('late Kafka stream rejected and closed without an unhandled error')
