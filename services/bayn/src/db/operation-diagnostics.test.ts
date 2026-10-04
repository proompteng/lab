import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Logger, References } from 'effect'
import { TestClock } from 'effect/testing'
import { runDatabase } from './database-error'

test('records slow successful database operations without logging their result', async () => {
  const logs: Readonly<Record<string, unknown>>[] = []
  const messages: unknown[] = []
  const logger = Logger.make(({ fiber, message }) => {
    logs.push(fiber.getRef(References.CurrentLogAnnotations))
    messages.push(message)
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<string>()
      const query = yield* runDatabase('read-generation', Deferred.await(release)).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(1_500)
      yield* Deferred.succeed(release, 'private-result')
      return yield* Fiber.join(query)
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
  )
  expect(result).toBe('private-result')
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatchObject({
    stage: 'bayn.postgres.operation',
    dependency: 'postgresql',
    operation: 'read-generation',
    elapsedMs: 1_500,
    outcome: 'succeeded',
  })
  expect(JSON.stringify({ logs, messages })).not.toContain('private-result')
})

test('ordinary successful database operations do not emit slow-operation logs', async () => {
  const messages: unknown[] = []
  const result = await Effect.runPromise(
    runDatabase('read-generation', Effect.succeed(1)).pipe(
      Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))])),
    ),
  )
  expect(result).toBe(1)
  expect(messages).toHaveLength(0)
})
