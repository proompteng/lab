import assert from 'node:assert/strict'
import { Cause, Effect, Exit, Logger, Redacted, Result } from 'effect'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap.ts'
import { makeKafkaMarketProjection } from '../market-data/streaming/kafka.ts'
import { decodeNativeArrivalChunk, nativeArrivalCaptureId } from '../market-data/streaming/native-arrival.ts'
import { makeNativeArrivalJournal } from '../market-data/streaming/native-arrival-journal.ts'
import { sha256 } from '../hash.ts'

const mode = process.argv[2]
assert.ok(['drain', 'invalidate', 'interrupt'].includes(mode))
const total = 16_384
const universe = {
  universeId: 'scheduling-test',
  universeSymbolHash: '0'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features' },
}
const positions = (end) =>
  Object.values(universe.topics).map((topic) => ({
    topic,
    partition: 0,
    offset: topic === 'quotes' && end ? String(total) : '0',
  }))
const done = Promise.withResolvers()
const transportClosed = Promise.withResolvers()
const abort = new AbortController()
const turns = []
let consumed = 0
let pending
let closed = false
let closeCount = 0
let notifyInvalidation
let immediate
let retained = 0
let retainedHash = null
let captureEnd
let assignmentRevoked = false
const captureBuild = {
  sourceRevision: '1'.repeat(40),
  imageRepository: 'example.test/bayn',
  imageDigest: 'sha256:' + '2'.repeat(64),
  strategyBehaviorHash: '3'.repeat(64),
  strategyParameterHash: '4'.repeat(64),
  verification: 'development-configured',
}
const nextTurn = () => {
  turns.push(consumed)
  if (mode === 'interrupt') abort.abort()
  else if (mode === 'invalidate') {
    assignmentRevoked = true
    notifyInvalidation(new Error('assignment revoked'))
    return
  }
  if (!closed && consumed < total) immediate = setImmediate(nextTurn)
}
const transport = {
  offsets: async (_topics, timestamp) => positions(timestamp === -1n),
  consume: async (_positions, invalidated) => {
    notifyInvalidation = invalidated
    return {
      queuedRecords: () => total - consumed,
      drainedPositions: () => (consumed === total ? positions(true) : undefined),
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (closed) return { done: true, value: undefined }
          if (mode === 'invalidate' && assignmentRevoked)
            return new Promise((resolve) => {
              pending = resolve
            })
          if (consumed === total) {
            done.resolve()
            return new Promise((resolve) => {
              pending = resolve
            })
          }
          if (consumed === 0) immediate = setImmediate(nextTurn)
          const offset = String(consumed++)
          const at = new Date(Date.parse('2026-09-24T14:00:00Z') + consumed).toISOString()
          const value = JSON.stringify({
            provider: 'alpaca',
            feed: 'iex',
            delayClass: 'real_time_exchange_only',
            marketSession: 'regular',
            channel: 'quotes',
            symbol: 'AAPL',
            eventTs: at,
            ingestTs: at,
            version: 2,
            payload: { bp: 200, bs: 100, ap: 200.01, as: 100, t: at },
          })
          const rawValue = Buffer.from(value)
          return {
            done: false,
            value: {
              topic: 'quotes',
              partition: 0,
              offset,
              timestampMs: Date.parse(at),
              leaderEpoch: 0,
              value,
              rawValue,
              rawValueSha256: sha256(rawValue),
              rawByteLength: rawValue.byteLength,
            },
          }
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }
  },
  close: async () => {
    closeCount++
    closed = true
    clearImmediate(immediate)
    pending?.({ done: true, value: undefined })
    transportClosed.resolve()
  },
}
const exit = await Effect.runPromiseExit(
  Effect.scoped(
    Effect.gen(function* () {
      const projection = yield* makeKafkaMarketProjection(
        {
          brokers: ['unused:9092'],
          username: 'test',
          password: Redacted.make('unused'),
          groupPrefix: 'test',
          operationTimeoutMs: 1000,
          bootstrapTimeoutMs: 60_000,
          timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
        },
        [universe],
        () => transport,
        undefined,
        (bootstrap, sources) =>
          makeNativeArrivalJournal(
            {
              schemaVersion: 'bayn.native-arrival-epoch.v1',
              captureId: Result.getOrThrow(nativeArrivalCaptureId(captureBuild, bootstrap, sources)),
              build: captureBuild,
              bootstrap,
              sources,
            },
            {
              begin: () => Effect.void,
              append: (chunks) =>
                Effect.sleep('2 millis').pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      for (const chunk of chunks) {
                        const records = Result.getOrThrow(decodeNativeArrivalChunk(chunk))
                        assert.equal(chunk.header.previousHash, retainedHash)
                        assert.equal(chunk.header.firstConsumerSequence, retained + 1)
                        retained += records.length
                        retainedHash = chunk.contentHash
                      }
                    }),
                  ),
                ),
              end: (end) =>
                Effect.sync(() => {
                  captureEnd = end
                }),
            },
          ),
      )
      yield* Effect.promise(() => (mode === 'invalidate' ? transportClosed.promise : done.promise))
      if (mode === 'interrupt') yield* Effect.never
      const status = yield* projection.status
      if (mode === 'drain') yield* Effect.sleep('1100 millis')
      const read = yield* projection.read.pipe(Effect.result)
      return { status, read }
    }),
  ).pipe(Effect.provide(Logger.layer([]))),
  { signal: abort.signal },
)
assert.equal(closeCount, 1)
assert.equal(captureEnd?.status, 'STOPPED')
assert.equal(captureEnd?.durableConsumerSequence, retained)
assert.equal(captureEnd?.observedConsumerSequence, retained)
assert.equal(captureEnd?.lastChunkHash, retainedHash)
assert.ok(retained > 0 && retained <= consumed)
assert.ok(turns.length > 0, 'Node I/O never ran while draining the ready backlog')
assert.ok(turns[0] < total, 'Node I/O was starved until the entire backlog drained')
if (mode === 'interrupt') {
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
  assert.ok(consumed < total, 'scope cancellation waited for the entire backlog')
} else {
  assert.ok(Exit.isSuccess(exit))
  if (mode === 'drain') {
    assert.equal(consumed, total)
    assert.equal(retained, total)
    assert.ok(Result.isSuccess(exit.value.read))
    assert.equal(exit.value.read.success.projection.rejections.size, 0)
    assert.equal(exit.value.read.success.projection.sequence, total)
    assert.equal(exit.value.read.success.projection.quotes.size, 1)
    assert.ok(turns.length >= 4, 'I/O was not serviced throughout consumption')
    const checkpoints = [0, ...turns, total]
    assert.ok(checkpoints.every((value, index) => index === 0 || value - checkpoints[index - 1] <= 4096))
  } else {
    assert.ok(consumed < total, 'revocation must close a transport that cannot drain')
    assert.ok(exit.value.status.sequence <= turns[0], 'revoked records were incorporated after invalidation')
    assert.equal(exit.value.status.ready, false)
    assert.ok(Result.isFailure(exit.value.read))
  }
}
console.log(`${mode}: Node I/O serviced during consumption; consumed=${consumed}; turns=${turns.length}`)
