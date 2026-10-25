import { expect, test } from 'bun:test'
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope, Tracer } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import { SqlError, UnknownError } from 'effect/sql/SqlError'
import { TestClock } from 'effect/testing'

const fixture = (
  options: { commitFails?: boolean; rollbackFails?: boolean; recoverCommit?: boolean; releaseDefects?: boolean } = {},
) => {
  const calls: string[] = []
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const commitFailure = new SqlError({
    reason: new UnknownError({ cause: 'private-commit-fixture', operation: 'commit' }),
  })
  const releaseDefect = new Error('private-release-fixture')
  const rollbackFailure = new SqlError({
    reason: new UnknownError({ cause: 'private-rollback-fixture', operation: 'rollback' }),
  })
  const control = (name: string) => Effect.sync(() => calls.push(name)).pipe(Effect.asVoid)
  const transaction = SqlClient.makeWithTransaction({
    transactionService: Context.Service<readonly [number, number]>('bayn/TransactionPhaseFixture'),
    spanAttributes: [['db.system.name', 'postgresql']],
    acquireConnection: Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(
        scope,
        control('RELEASE').pipe(
          Effect.andThen(TestClock.adjust(30)),
          Effect.andThen(options.releaseDefects ? Effect.die(releaseDefect) : Effect.void),
        ),
      )
      return [scope, 17] as const
    }),
    begin: () => control('BEGIN'),
    savepoint: () => control('SAVEPOINT'),
    releaseSavepoint: () => control('RELEASE SAVEPOINT'),
    commit: () =>
      control('COMMIT').pipe(
        Effect.andThen(TestClock.adjust(100)),
        Effect.andThen(options.commitFails ? Effect.fail(commitFailure) : Effect.void),
      ),
    onCommitFailure: options.recoverCommit
      ? () => control('RECOVER').pipe(Effect.andThen(TestClock.adjust(10)))
      : undefined,
    rollback: () =>
      control('ROLLBACK').pipe(
        Effect.andThen(TestClock.adjust(20)),
        Effect.andThen(options.rollbackFails ? Effect.fail(rollbackFailure) : Effect.void),
      ),
    rollbackSavepoint: () => control('ROLLBACK SAVEPOINT'),
  })
  const run = <A, E>(effect: Effect.Effect<A, E>, enabled = true, tracing = true) =>
    Effect.runPromiseExit(
      effect.pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(Statement.SpanPropagationEnabled, enabled),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.withTracerEnabled(tracing),
      ),
    )
  const parent = () => {
    const span = spans.find((span) => span.name === 'sql.transaction')
    if (span === undefined) throw new Error('Transaction trace is missing')
    return span
  }
  return { calls, spans, transaction, run, parent, commitFailure, rollbackFailure, releaseDefect }
}

test('distinguishes commit latency from connection release without extra controls or spans', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(Effect.succeed(42)))).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(f.spans).toHaveLength(1)
  const events = f.parent().events
  expect(events.map(([name, , attributes]) => ({ name, attributes }))).toEqual([
    { name: 'db.transaction.commit', attributes: {} },
    { name: 'db.transaction.commit.completed', attributes: { 'db.transaction.outcome': 'succeeded' } },
    { name: 'db.transaction.connection.release.started', attributes: {} },
    {
      name: 'db.transaction.connection.release.completed',
      attributes: { 'db.transaction.outcome': 'succeeded' },
    },
  ])
  const times = events.map(([, time]) => time)
  expect(times[1] - times[0]).toBe(100_000_000n)
  expect(times[3] - times[2]).toBe(30_000_000n)
})

test('preserves a failed commit and marks its phase failed before releasing once', async () => {
  const f = fixture({ commitFails: true })
  const exit = await f.run(f.transaction(Effect.succeed(42)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(f.commitFailure)
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  const events = f.parent().events
  expect(events.find(([name]) => name === 'db.transaction.commit.completed')?.[2]).toEqual({
    'db.transaction.outcome': 'failed',
  })
  expect(events.find(([name]) => name === 'db.transaction.connection.release.completed')?.[2]).toEqual({
    'db.transaction.outcome': 'succeeded',
  })
  expect(JSON.stringify(events, (_, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(
    'private-commit-fixture',
  )
})

test('preserves a body failure and measures its rollback before releasing once', async () => {
  const f = fixture()
  const failure = new Error('body fixture failure')
  const exit = await f.run(f.transaction(Effect.fail(failure)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
  expect(f.calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  const events = f.parent().events
  expect(events.map(([name]) => name)).toEqual([
    'db.transaction.rollback',
    'db.transaction.rollback.completed',
    'db.transaction.connection.release.started',
    'db.transaction.connection.release.completed',
  ])
  expect(events[1][1] - events[0][1]).toBe(20_000_000n)
})

test('retains a release defect and distinguishes it from a successful commit', async () => {
  const f = fixture({ releaseDefects: true })
  const exit = await f.run(f.transaction(Effect.succeed(42)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(f.releaseDefect)
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  const events = f.parent().events
  expect(events.find(([name]) => name === 'db.transaction.commit.completed')?.[2]).toEqual({
    'db.transaction.outcome': 'succeeded',
  })
  expect(events.find(([name]) => name === 'db.transaction.connection.release.completed')?.[2]).toEqual({
    'db.transaction.outcome': 'failed',
  })
})

test('a failed rollback remains failed and still releases the connection once', async () => {
  const f = fixture({ rollbackFails: true })
  const exit = await f.run(f.transaction(Effect.fail('body fixture failure')))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(f.calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  const events = f.parent().events
  expect(events.find(([name]) => name === 'db.transaction.rollback.completed')?.[2]).toEqual({
    'db.transaction.outcome': 'failed',
  })
  expect(events.find(([name]) => name === 'db.transaction.connection.release.completed')?.[2]).toEqual({
    'db.transaction.outcome': 'succeeded',
  })
})

test('commit recovery stays after failed commit completion and before connection release', async () => {
  const f = fixture({ commitFails: true, recoverCommit: true })
  const exit = await f.run(f.transaction(Effect.succeed(42)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(f.commitFailure)
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RECOVER', 'RELEASE'])
  const events = f.parent().events
  const completed = events.find(([name]) => name === 'db.transaction.commit.completed')
  const releaseStarted = events.find(([name]) => name === 'db.transaction.connection.release.started')
  if (completed === undefined || releaseStarted === undefined) throw new Error('Transaction phase trace is missing')
  expect(completed[2]).toEqual({ 'db.transaction.outcome': 'failed' })
  expect(releaseStarted[1] - completed[1]).toBe(10_000_000n)
})

test('interruption rolls back and completes the owned release without committing', async () => {
  const f = fixture()
  const exit = await f.run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const fiber = yield* f
        .transaction(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }),
  )
  expect(exit).toMatchObject({ _tag: 'Success', value: { _tag: 'Failure' } })
  expect(f.calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  expect(f.parent().events.map(([name]) => name)).toEqual([
    'db.transaction.rollback',
    'db.transaction.rollback.completed',
    'db.transaction.connection.release.started',
    'db.transaction.connection.release.completed',
  ])
})

test('nested savepoints keep their existing controls and the outer connection owns release', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(f.transaction(Effect.succeed(42))))).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'SAVEPOINT', 'RELEASE SAVEPOINT', 'COMMIT', 'RELEASE'])
  expect(f.spans).toHaveLength(2)
  const nested = f.spans[1]
  expect(nested.events.map(([name]) => name)).toEqual(['db.transaction.savepoint'])
  expect(f.parent().events.filter(([name]) => name === 'db.transaction.connection.release.completed')).toHaveLength(1)
})

test('default SQL clients retain the existing event contract', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(Effect.succeed(42)), false)).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(f.parent().events.map(([name]) => name)).toEqual(['db.transaction.commit'])
})

test('disabling tracing keeps the same transaction controls without recording spans', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(Effect.succeed(42)), true, false)).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(f.spans).toHaveLength(0)
})
