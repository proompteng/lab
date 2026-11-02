import { expect, test } from 'bun:test'
import { Deferred, Effect, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { migrationTimeoutMs, withMigrationDeadline } from './postgres-migrations'

test('a six-minute retained-history migration completes within the dedicated startup budget', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const migration = yield* withMigrationDeadline(Deferred.await(release), migrationTimeoutMs).pipe(
        Effect.result,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust('6 minutes')
      yield* Deferred.succeed(release, undefined)
      return yield* Fiber.join(migration)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(result).toEqual(Result.succeed(undefined))
})

test('a stuck migration still fails with the database migration error at its deadline', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const migration = yield* withMigrationDeadline(Effect.never, migrationTimeoutMs).pipe(
        Effect.result,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(migrationTimeoutMs)
      return yield* Fiber.join(migration)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure: { failure: 'migration', operation: 'migrate' } })
})
