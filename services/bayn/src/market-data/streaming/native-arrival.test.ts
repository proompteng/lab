import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'
import fc from 'fast-check'

import { sha256, canonicalHashV1Result } from '../../hash'
import {
  decodeNativeArrivalChunk,
  makeNativeArrivalChunk,
  nativeArrival,
  NativeArrivalCaptureError,
  type NativeArrivalChunk,
} from './native-arrival'
import { makeNativeArrivalJournal, type NativeArrivalEnd, type NativeArrivalStore } from './native-arrival-journal'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from './native-arrival.test-support'
import { CaptureDisposition } from './transport-evidence'
import { checkAsyncProperty, checkProperty } from '../../testing/property-test-support'
import { decodeKafkaTransportValue } from './kafka'

test('native chunks preserve exact non-ASCII bytes, equal arrival times and exceptional transport timestamps', () => {
  const records = [
    nativeArrival(epoch, observation(1)),
    nativeArrival(epoch, {
      ...observation(2),
      availableAtMs: 1_001,
      record: { ...observation(2).record, timestampMs: Number.NaN },
      disposition: CaptureDisposition.Rejected,
    }),
    nativeArrival(epoch, {
      ...observation(3),
      record: { ...observation(3).record, timestampMs: -0 },
      assignmentInvalidated: true,
      disposition: CaptureDisposition.Ignored,
    }),
    nativeArrival(epoch, {
      ...observation(4),
      record: {
        ...observation(4).record,
        tombstone: true,
        rawValue: null,
        rawValueSha256: null,
        rawByteLength: null,
        value: '',
      },
      disposition: CaptureDisposition.Rejected,
    }),
  ]
  const chunk = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, records))
  expect(Result.getOrThrow(decodeNativeArrivalChunk(chunk))).toEqual(records)
  expect(chunk.header.lastConsumerSequence).toBe(4)
  expect(chunk.header.recordsHash).toBe(sha256(records.map((record) => JSON.stringify(record) + '\n').join('')))
})

test('native chunk validation rejects changed bytes, missing deliveries and rewritten raw identity', () => {
  const first = nativeArrival(epoch, observation(1))
  const second = nativeArrival(epoch, observation(2))
  const records = [first, second]
  const original = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, records))
  const changedBytes = Uint8Array.from(original.compressed)
  changedBytes[0] = 0
  expect(Result.isFailure(decodeNativeArrivalChunk({ ...original, compressed: changedBytes }))).toBe(true)
  for (const changed of [
    [second],
    [first, { ...second, receipt: { ...second.receipt, consumerSequence: 3 } }],
    [first, { ...second, rawValueBase64: Buffer.from('forged').toString('base64') }],
  ]) {
    const text = changed.map((record) => JSON.stringify(record) + '\n').join('')
    const compressed = gzipSync(text)
    const header = {
      ...original.header,
      uncompressedBytes: Buffer.byteLength(text),
      recordsHash: sha256(text),
      compressedHash: sha256(compressed),
    }
    expect(
      Result.isFailure(
        decodeNativeArrivalChunk({ header, contentHash: Result.getOrThrow(canonicalHashV1Result(header)), compressed }),
      ),
    ).toBe(true)
  }
})

test('a clock regression recovered within one chunk cannot be sealed as complete retained evidence', async () => {
  const inputs = [100, 90, 100].map((availableAtMs, index) => ({ ...observation(index + 1), availableAtMs }))
  expect(
    Result.isFailure(
      makeNativeArrivalChunk(
        epoch,
        0,
        null,
        inputs.map((input) => nativeArrival(epoch, input)),
      ),
    ),
  ).toBe(true)
  const { chunks, ends, store } = memoryStore()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(epoch, store)
        for (const input of inputs) yield* capture.observe(input)
      }),
    ),
  )
  expect(chunks).toHaveLength(0)
  expect(ends[0]).toMatchObject({ status: 'INCOMPLETE', observedConsumerSequence: 3, durableConsumerSequence: 0 })
})

const memoryStore = () => {
  const chunks: NativeArrivalChunk[] = []
  const ends: NativeArrivalEnd[] = []
  const store: NativeArrivalStore = {
    begin: () => Effect.void,
    append: (batch) =>
      Effect.sync(() => {
        chunks.push(...batch)
      }),
    end: (end) =>
      Effect.sync(() => {
        ends.push(end)
      }),
  }
  return { chunks, ends, store }
}

test('scope finalization flushes the last short chunk and confirms its exact durable prefix', async () => {
  const { chunks, ends, store } = memoryStore()
  const capture = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(epoch, store)
        yield* capture.observe(observation(1))
        yield* capture.observe(observation(2))
        expect(chunks).toHaveLength(0)
        return capture
      }),
    ),
  )
  expect(chunks).toHaveLength(1)
  expect(Result.getOrThrow(decodeNativeArrivalChunk(chunks[0] ?? expect.unreachable()))).toHaveLength(2)
  expect(ends).toEqual([
    {
      captureId: epoch.captureId,
      status: 'STOPPED',
      observedConsumerSequence: 2,
      durableConsumerSequence: 2,
      lastChunkHash: chunks[0]?.contentHash,
      reason: null,
      consumerScopeCompleted: true,
    },
  ])
  expect(capture.status()).toMatchObject({ status: 'STOPPED', durableConsumerSequence: 2, queuedCompressedBytes: 0 })
})

test('a full compressed queue backpressures deliveries and resumes the exact prefix after persistence recovers', async () => {
  const { chunks, ends, store } = memoryStore()
  const capture = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const paused = yield* Deferred.make<void>()
        const writing = yield* Deferred.make<void>()
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: (batch) =>
              Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Deferred.await(paused)),
                Effect.andThen(store.append(batch)),
              ),
          },
          { chunkBytes: 1, queueBytes: 1_500 },
        )
        const producer = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index + 1),
          (sequence) => capture.observe(observation(sequence, sha256(String(sequence)).repeat(4))),
          { discard: true },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(writing)
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        const pressured = capture.status()
        yield* Deferred.succeed(paused, undefined)
        yield* Fiber.join(producer)
        expect(pressured.status).toBe('RECORDING')
        expect(pressured.observedConsumerSequence).toBeLessThan(100)
        expect(pressured.queuedCompressedBytes).toBeLessThanOrEqual(1_500)
        return capture
      }),
    ),
  )
  expect(chunks).toHaveLength(100)
  expect(chunks.map((chunk) => chunk.header.firstConsumerSequence)).toEqual(chunks.map((_, index) => index + 1))
  expect(chunks.flatMap((chunk) => Result.getOrThrow(decodeNativeArrivalChunk(chunk)))).toEqual(
    Array.from({ length: 100 }, (_, index) =>
      nativeArrival(epoch, observation(index + 1, sha256(String(index + 1)).repeat(4))),
    ),
  )
  expect(ends[0]).toMatchObject({
    status: 'STOPPED',
    observedConsumerSequence: 100,
    durableConsumerSequence: 100,
  })
  expect(capture.status()).toMatchObject({ status: 'STOPPED', durableConsumerSequence: 100, queuedCompressedBytes: 0 })
})

test.each([
  { name: 'many short chunks', count: 600, value: sha256('bootstrap-batch') },
  {
    name: 'large compressed chunks',
    count: 24,
    value: Array.from({ length: 8_192 }, (_, index) => sha256(String(index))).join(''),
  },
])('a bootstrap backlog preserves every delivery with bounded atomic appends for $name', async ({ count, value }) => {
  const { chunks, ends, store } = memoryStore()
  const inputs = Array.from({ length: count }, (_, index) => observation(index + 1, value))
  const capture = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: (batch) =>
              Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(
                  Effect.suspend(() =>
                    batch.length > 256 ||
                    batch.reduce((bytes, chunk) => bytes + chunk.compressed.byteLength, 0) > 8 * 1_024 * 1_024
                      ? Effect.fail(
                          new NativeArrivalCaptureError({
                            message: 'synthetic atomic append exceeded its budget',
                          }),
                        )
                      : store.append(batch),
                  ),
                ),
              ),
          },
          { chunkBytes: 1, queueBytes: 64 * 1_024 * 1_024 },
        )
        for (const input of inputs) yield* capture.observe(input)
        yield* Deferred.await(writing)
        yield* Deferred.succeed(resume, undefined)
        while (capture.status().status === 'RECORDING' && capture.status().durableConsumerSequence < count)
          yield* Effect.yieldNow
        return capture
      }),
    ),
  )
  expect(capture.status()).toMatchObject({
    status: 'STOPPED',
    durableConsumerSequence: count,
    queuedCompressedBytes: 0,
  })
  expect(ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ status: 'STOPPED', observedConsumerSequence: count, durableConsumerSequence: count })
  expect(chunks.flatMap((chunk) => Result.getOrThrow(decodeNativeArrivalChunk(chunk)))).toEqual(
    inputs.map((input) => nativeArrival(epoch, input)),
  )
  expect(chunks.map((chunk) => chunk.header.previousHash)).toEqual(
    chunks.map((_, index) => (index === 0 ? null : chunks[index - 1]?.contentHash)),
  )
})

test('a valid large individual chunk still persists whole', async () => {
  const { chunks, ends, store } = memoryStore()
  const input = observation(1, Array.from({ length: 10_000 }, (_, index) => sha256(String(index))).join(''))
  const expected = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, [nativeArrival(epoch, input)]))
  expect(expected.compressed.byteLength).toBeGreaterThan(1_024 * 1_024)
  expect(expected.header.uncompressedBytes).toBeLessThan(4 * 1_024 * 1_024)
  const capture = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(epoch, store)
        yield* capture.observe(input)
        return capture
      }),
    ),
  )
  expect(capture.status()).toMatchObject({ status: 'STOPPED', durableConsumerSequence: 1, queuedCompressedBytes: 0 })
  expect(chunks).toHaveLength(1)
  expect(chunks[0]?.contentHash).toBe(expected.contentHash)
  expect(Result.getOrThrow(decodeNativeArrivalChunk(chunks[0] ?? expect.unreachable()))).toEqual([
    nativeArrival(epoch, input),
  ])
  expect(ends[0]).toMatchObject({ status: 'STOPPED', observedConsumerSequence: 1, durableConsumerSequence: 1 })
})

test('a persistence failure releases a backpressured producer without claiming a durable suffix', async () => {
  const { chunks, ends, store } = memoryStore()
  const capture = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const paused = yield* Deferred.make<void>()
        const writing = yield* Deferred.make<void>()
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: () =>
              Deferred.succeed(writing, undefined).pipe(
                Effect.andThen(Deferred.await(paused)),
                Effect.andThen(
                  Effect.fail(new NativeArrivalCaptureError({ message: 'synthetic persistence failure' })),
                ),
              ),
          },
          { chunkBytes: 1, queueBytes: 1_500 },
        )
        const producer = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index + 1),
          (sequence) => capture.observe(observation(sequence)),
          { discard: true },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(writing)
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        const pressured = capture.status()
        yield* Deferred.succeed(paused, undefined)
        yield* Fiber.join(producer)
        expect(pressured.observedConsumerSequence).toBeLessThan(100)
        return capture
      }),
    ),
  )
  expect(chunks).toHaveLength(0)
  expect(ends).toHaveLength(0)
  expect(capture.status()).toMatchObject({
    status: 'INCOMPLETE',
    observedConsumerSequence: 100,
    durableConsumerSequence: 0,
  })
})

test('interrupting a backpressured owner drains and seals only its actually observed prefix', async () => {
  const { chunks, ends, store } = memoryStore()
  let observed = 0
  let calls = 0
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>()
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: (batch) =>
              Effect.suspend(() => {
                calls++
                return calls === 1
                  ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
                  : store.append(batch)
              }),
          },
          { chunkBytes: 1, queueBytes: 1_500 },
        )
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index + 1),
          (sequence) => capture.observe(observation(sequence)),
          { discard: true },
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(writing)
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        observed = capture.status().observedConsumerSequence
        return yield* Effect.interrupt
      }),
    ),
  )
  expect(Exit.hasInterrupts(exit)).toBe(true)
  expect(observed).toBeGreaterThan(0)
  expect(observed).toBeLessThan(100)
  expect(chunks.flatMap((chunk) => Result.getOrThrow(decodeNativeArrivalChunk(chunk)))).toEqual(
    Array.from({ length: observed }, (_, index) => nativeArrival(epoch, observation(index + 1))),
  )
  expect(ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({
    status: 'STOPPED',
    observedConsumerSequence: observed,
    durableConsumerSequence: observed,
    consumerScopeCompleted: false,
  })
})

test('property: delayed persistence keeps randomized original deliveries ordered within the compressed byte bound', async () => {
  await checkAsyncProperty(
    'native-arrival-backpressure',
    fc.asyncProperty(
      fc.array(fc.uint8Array({ maxLength: 128 }), { minLength: 8, maxLength: 24 }),
      fc.integer({ min: 1_600, max: 3_200 }),
      async (values, queueBytes) => {
        const inputs = values.map((value, index) => observation(index + 1, Buffer.from(value).toString('hex')))
        const { chunks, ends, store } = memoryStore()
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const paused = yield* Deferred.make<void>()
              const writing = yield* Deferred.make<void>()
              const capture = yield* makeNativeArrivalJournal(
                epoch,
                {
                  ...store,
                  append: (batch) =>
                    Deferred.succeed(writing, undefined).pipe(
                      Effect.andThen(Deferred.await(paused)),
                      Effect.andThen(store.append(batch)),
                    ),
                },
                { chunkBytes: 1, queueBytes },
              )
              const producer = yield* Effect.forEach(inputs, capture.observe, { discard: true }).pipe(Effect.forkChild)
              yield* Deferred.await(writing)
              for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
              const pressured = capture.status()
              yield* Deferred.succeed(paused, undefined)
              yield* Fiber.join(producer)
              expect(pressured.status).toBe('RECORDING')
              expect(pressured.queuedCompressedBytes).toBeLessThanOrEqual(queueBytes)
            }),
          ),
        )
        expect(chunks.flatMap((chunk) => Result.getOrThrow(decodeNativeArrivalChunk(chunk)))).toEqual(
          inputs.map((input) => nativeArrival(epoch, input)),
        )
        expect(chunks.map((chunk) => chunk.header.previousHash)).toEqual(
          chunks.map((_, index) => (index === 0 ? null : chunks[index - 1]?.contentHash)),
        )
        expect(ends).toHaveLength(1)
        expect(ends[0]).toMatchObject({
          status: 'STOPPED',
          observedConsumerSequence: inputs.length,
          durableConsumerSequence: inputs.length,
        })
      },
    ),
  )
})

test('an individually oversized compressed chunk fails without waiting for impossible queue space', async () => {
  const { chunks, ends, store } = memoryStore()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(epoch, store, { chunkBytes: 1, queueBytes: 1 })
        yield* capture.observe(observation(1))
        expect(capture.status()).toMatchObject({ status: 'INCOMPLETE', durableConsumerSequence: 0 })
      }),
    ),
  )
  expect(chunks).toHaveLength(0)
  expect(ends[0]).toMatchObject({ status: 'INCOMPLETE', observedConsumerSequence: 1, durableConsumerSequence: 0 })
})

test('interruption before staging a large next delivery cannot seal a missing suffix as stopped', async () => {
  const { chunks, ends, store } = memoryStore()
  const value = 'x'.repeat(1_000_000)
  const first = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, [nativeArrival(epoch, observation(1, value))]))
  let calls = 0
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>()
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: (batch) =>
              Effect.suspend(() => {
                calls++
                return calls === 1
                  ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
                  : store.append(batch)
              }),
          },
          { chunkBytes: 4 * 1024 * 1024, queueBytes: first.compressed.byteLength + 100 },
        )
        yield* Effect.forEach([1, 2, 3, 4], (sequence) => capture.observe(observation(sequence, value)), {
          discard: true,
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(writing)
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        return yield* Effect.interrupt
      }),
    ),
  )
  expect(Exit.hasInterrupts(exit)).toBe(true)
  expect(chunks.length).toBeGreaterThan(0)
  expect(ends).toHaveLength(1)
  expect(ends[0]?.status).toBe('INCOMPLETE')
  expect(ends[0]?.observedConsumerSequence).toBeGreaterThan(ends[0]?.durableConsumerSequence ?? 0)
})

test('a delivery waiting behind the ticker remains observed when shutdown interrupts its permit wait', async () => {
  const { chunks, ends, store } = memoryStore()
  const firstInput = observation(1, 'x'.repeat(1_024))
  const first = Result.getOrThrow(makeNativeArrivalChunk(epoch, 0, null, [nativeArrival(epoch, firstInput)]))
  const second = Result.getOrThrow(
    makeNativeArrivalChunk(epoch, 1, first.contentHash, [nativeArrival(epoch, observation(2))]),
  )
  let calls = 0
  let delivered = 0
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>()
        const receiving = yield* Deferred.make<void>()
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: (batch) =>
              Effect.suspend(() => {
                calls++
                return calls === 1
                  ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
                  : store.append(batch)
              }),
          },
          {
            chunkBytes: Buffer.byteLength(JSON.stringify(nativeArrival(epoch, firstInput))) + 1,
            queueBytes: Math.max(first.compressed.byteLength, second.compressed.byteLength),
          },
        )
        yield* capture.observe(firstInput)
        yield* Deferred.await(writing)
        yield* capture.observe(observation(2))
        yield* TestClock.adjust('1 second')
        yield* Deferred.succeed(receiving, undefined).pipe(
          Effect.andThen(capture.observe(observation(3))),
          Effect.forkScoped,
        )
        yield* Deferred.await(receiving)
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow
        delivered = capture.status().observedConsumerSequence
        return yield* Effect.interrupt
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
  expect(Exit.hasInterrupts(exit)).toBe(true)
  expect(delivered).toBe(3)
  expect(chunks.flatMap((chunk) => Result.getOrThrow(decodeNativeArrivalChunk(chunk)))).toEqual([
    nativeArrival(epoch, firstInput),
    nativeArrival(epoch, observation(2)),
  ])
  expect(ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({
    status: 'INCOMPLETE',
    observedConsumerSequence: 3,
    durableConsumerSequence: 2,
    consumerScopeCompleted: false,
  })
})

test('missing raw bytes invalidate retention rather than fabricate an original arrival', async () => {
  const { chunks, ends, store } = memoryStore()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(epoch, store)
        const { rawValue: _rawValue, ...missing } = observation(1).record
        yield* capture.observe({ ...observation(1), record: missing })
        expect(capture.status().status).toBe('INCOMPLETE')
      }),
    ),
  )
  expect(chunks).toHaveLength(0)
  expect(ends[0]).toMatchObject({ status: 'INCOMPLETE', observedConsumerSequence: 1, durableConsumerSequence: 0 })
})

test('failed persistence leaves the epoch unsealed and cannot claim a durable delivery', async () => {
  const { ends, store } = memoryStore()
  const capture = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(
          epoch,
          {
            ...store,
            append: () => Effect.fail(new NativeArrivalCaptureError({ message: 'synthetic persistence failure' })),
          },
          { chunkBytes: 1, queueBytes: 1_500 },
        )
        yield* capture.observe(observation(1))
        return capture
      }),
    ),
  )
  expect(ends).toHaveLength(0)
  expect(capture.status()).toMatchObject({ status: 'INCOMPLETE', durableConsumerSequence: 0 })
})

for (const termination of ['defect', 'interruption'] as const) {
  test(`unexpected append ${termination} cannot leave a recording journal without a writer`, async () => {
    const { store } = memoryStore()
    const during = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const terminated = yield* Deferred.make<void>()
          let calls = 0
          const capture = yield* makeNativeArrivalJournal(
            epoch,
            {
              ...store,
              append: (chunks) =>
                Effect.suspend(() => {
                  calls++
                  if (calls > 1) return store.append(chunks)
                  return (termination === 'defect' ? Effect.die('synthetic writer defect') : Effect.interrupt).pipe(
                    Effect.ensuring(Deferred.succeed(terminated, undefined)),
                  )
                }),
            },
            { chunkBytes: 1, queueBytes: 1_500 },
          )
          yield* capture.observe(observation(1))
          yield* Deferred.await(terminated)
          yield* Effect.yieldNow
          return capture.status()
        }),
      ),
    )
    expect(during).toMatchObject({ status: 'INCOMPLETE', durableConsumerSequence: 0 })
  })
}

for (const termination of ['defect', 'interruption'] as const) {
  test(`post-commit ${termination} releases backpressure without acknowledging an uncertain suffix`, async () => {
    const { chunks, ends, store } = memoryStore()
    const { capture, during } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const committed = yield* Deferred.make<void>()
          const terminate = yield* Deferred.make<void>()
          let calls = 0
          const capture = yield* makeNativeArrivalJournal(
            epoch,
            {
              ...store,
              append: (batch) =>
                Effect.gen(function* () {
                  calls++
                  if (calls > 1) {
                    expect(batch).toEqual(chunks)
                    return
                  }
                  yield* store.append(batch)
                  yield* Deferred.succeed(committed, undefined)
                  yield* Deferred.await(terminate)
                  return yield* termination === 'defect' ? Effect.die('synthetic post-commit defect') : Effect.interrupt
                }),
            },
            { chunkBytes: 1, queueBytes: 700 },
          )
          yield* capture.observe(observation(1))
          yield* Deferred.await(committed)
          const producer = yield* capture.observe(observation(2)).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(capture.status()).toMatchObject({ observedConsumerSequence: 2, durableConsumerSequence: 0 })
          yield* Deferred.succeed(terminate, undefined)
          yield* Fiber.join(producer)
          return { capture, during: capture.status() }
        }),
      ),
    )
    expect(during).toMatchObject({ status: 'INCOMPLETE', observedConsumerSequence: 2, durableConsumerSequence: 0 })
    expect(chunks).toHaveLength(1)
    expect(Result.getOrThrow(decodeNativeArrivalChunk(chunks[0] ?? expect.unreachable()))).toEqual([
      nativeArrival(epoch, observation(1)),
    ])
    expect(capture.status()).toMatchObject({ status: 'INCOMPLETE', durableConsumerSequence: 1 })
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({
      status: 'INCOMPLETE',
      observedConsumerSequence: 2,
      durableConsumerSequence: 1,
      lastChunkHash: chunks[0]?.contentHash,
    })
  })
}

test('a failed epoch opening cannot start a writer or fabricate retained deliveries', async () => {
  const { chunks, ends, store } = memoryStore()
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      makeNativeArrivalJournal(epoch, {
        ...store,
        begin: () => Effect.fail(new NativeArrivalCaptureError({ message: 'synthetic opening failure' })),
      }),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(chunks).toHaveLength(0)
  expect(ends).toHaveLength(0)
})

test('interrupting the owner still flushes and finalizes the observed prefix exactly once', async () => {
  const { chunks, ends, store } = memoryStore()
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* makeNativeArrivalJournal(epoch, store)
        yield* capture.observe(observation(1))
        return yield* Effect.interrupt
      }),
    ),
  )
  expect(Exit.hasInterrupts(exit)).toBe(true)
  expect(chunks).toHaveLength(1)
  expect(ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({
    status: 'STOPPED',
    observedConsumerSequence: 1,
    durableConsumerSequence: 1,
    consumerScopeCompleted: false,
  })
})

test('property: original bytes and delivered sequence survive chunking while compressed-byte substitutions fail', () => {
  checkProperty(
    'native-arrival-byte-continuity',
    fc.property(
      fc.array(fc.uint8Array({ maxLength: 512 }), { minLength: 1, maxLength: 16 }),
      fc.integer({ min: 1, max: 8 }),
      (values, width) => {
        const records = values.map((value, index) =>
          nativeArrival(epoch, {
            ...observation(index + 1),
            availableAtMs: 1_000 + Math.floor(index / 2),
            record: { ...observation(index + 1).record, ...decodeKafkaTransportValue(Buffer.from(value), true, true) },
          }),
        )
        if (records.length >= 3) {
          const first = records[0]
          const second = records[1]
          if (first === undefined || second === undefined) throw new Error('Missing generated clock boundary')
          const regressed = [first, { ...second, availableAtMs: first.availableAtMs - 1 }, ...records.slice(2)]
          expect(Result.isFailure(makeNativeArrivalChunk(epoch, 0, null, regressed))).toBe(true)
        }
        let previous: string | null = null
        for (let index = 0; index < records.length; index += width) {
          const subset = records.slice(index, index + width)
          const chunk: NativeArrivalChunk = Result.getOrThrow(
            makeNativeArrivalChunk(epoch, index / width, previous, subset),
          )
          expect(Result.getOrThrow(decodeNativeArrivalChunk(chunk))).toEqual(subset)
          expect(chunk.header.firstConsumerSequence).toBe(index + 1)
          expect(chunk.header.previousHash).toBe(previous)
          const changed = Uint8Array.from(chunk.compressed)
          changed[0] = (changed[0] ?? 0) ^ 1
          expect(Result.isFailure(decodeNativeArrivalChunk({ ...chunk, compressed: changed }))).toBe(true)
          previous = chunk.contentHash
        }
      },
    ),
  )
})
