import { describe, expect, test } from 'bun:test'

import { Effect, Fiber, Option, Result, Schema, Semaphore } from 'effect'

describe('Effect beta.102 runtime compatibility', () => {
  test('keeps deeply nested JSON validation stack safe', () => {
    let nested: unknown = null
    for (let index = 0; index < 25_000; index += 1) nested = [nested]

    expect(Result.isSuccess(Schema.decodeUnknownResult(Schema.Json)(nested))).toBe(true)
  })

  test('decodes and encodes valid dates while rejecting invalid dates', () => {
    const date = new Date('2026-07-27T12:34:56.789Z')

    expect(Schema.decodeUnknownResult(Schema.Date)(date)).toEqual(Result.succeed(date))
    expect(Schema.encodeUnknownResult(Schema.Date)(date)).toEqual(Result.succeed(date))
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.Date)(new Date(Number.NaN)))).toBe(true)
    expect(Result.isFailure(Schema.encodeUnknownResult(Schema.Date)(new Date(Number.NaN)))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.DateFromString)('not-a-date'))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(Schema.DateFromMillis)(8_640_000_000_000_001))).toBe(true)
  })

  test('recovers permits after interrupted semaphore waiters', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        const blocked = yield* semaphore.withPermits(2)(Effect.void).pipe(Effect.forkChild)

        yield* Effect.yieldNow
        yield* Fiber.interrupt(blocked)
        expect(Option.isSome(yield* semaphore.withPermitsIfAvailable(1)(Effect.void))).toBe(true)
      }),
    )
  })
})
