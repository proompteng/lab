import { expect, test } from 'bun:test'
import { Cause, Context, Deferred, Effect, Exit, Fiber, Tracer } from 'effect'
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
    acquireConnection: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          control('RELEASE').pipe(
            Effect.andThen(TestClock.adjust(30)),
            Effect.andThen(options.releaseDefects ? Effect.die(releaseDefect) : Effect.void),
          ),
        )
        return 17
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

const phase = (f: ReturnType<typeof fixture>, name: string) => {
  const span = f.spans.find((span) => span.attributes.get('db.operation.name') === name)
  if (span === undefined || span.status._tag !== 'Ended') throw new Error(`Missing completed ${name} span`)
  expect(span.parent._tag === 'Some' && span.parent.value.spanId).toBe(f.parent().spanId)
  return { span, status: span.status }
}

const duration = (status: Tracer.SpanStatus) => {
  if (status._tag !== 'Ended') throw new Error('Span did not end')
  return status.endTime - status.startTime
}

test('native control spans distinguish commit latency from connection release', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(Effect.succeed(42)))).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(f.spans).toHaveLength(3)
  const commit = phase(f, 'COMMIT')
  expect(Exit.isSuccess(commit.status.exit)).toBe(true)
  expect(duration(commit.status)).toBe(100_000_000n)
  expect(duration(f.parent().status)).toBe(130_000_000n)
  const parent = f.parent().status
  if (parent._tag === 'Ended') expect(parent.endTime - commit.status.endTime).toBe(30_000_000n)
})

test('preserves a failed commit and its failed control span before releasing once', async () => {
  const f = fixture({ commitFails: true })
  const exit = await f.run(f.transaction(Effect.succeed(42)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(f.commitFailure)
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(Exit.isFailure(phase(f, 'COMMIT').status.exit)).toBe(true)
})

test('preserves a body failure and measures its rollback before releasing once', async () => {
  const f = fixture()
  const failure = new Error('body fixture failure')
  const exit = await f.run(f.transaction(Effect.fail(failure)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
  expect(f.calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  const rollback = phase(f, 'ROLLBACK')
  expect(Exit.isSuccess(rollback.status.exit)).toBe(true)
  expect(duration(rollback.status)).toBe(20_000_000n)
  expect(duration(f.parent().status)).toBe(50_000_000n)
})

test('retains a release defect independently of a successful commit', async () => {
  const f = fixture({ releaseDefects: true })
  const exit = await f.run(f.transaction(Effect.succeed(42)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(f.releaseDefect)
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(Exit.isSuccess(phase(f, 'COMMIT').status.exit)).toBe(true)
  expect(f.parent().status).toMatchObject({ _tag: 'Ended', exit: { _tag: 'Failure' } })
})

test('a failed rollback retains its failed control span and releases once', async () => {
  const f = fixture({ rollbackFails: true })
  const exit = await f.run(f.transaction(Effect.fail('body fixture failure')))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(f.calls).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE'])
  expect(Exit.isFailure(phase(f, 'ROLLBACK').status.exit)).toBe(true)
})

test('commit recovery runs after the failed commit and before connection release', async () => {
  const f = fixture({ commitFails: true, recoverCommit: true })
  const exit = await f.run(f.transaction(Effect.succeed(42)))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(f.commitFailure)
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RECOVER', 'RELEASE'])
  const commit = phase(f, 'COMMIT')
  const recovery = phase(f, 'ROLLBACK')
  expect(Exit.isFailure(commit.status.exit)).toBe(true)
  expect(recovery.status.startTime).toBe(commit.status.endTime)
  expect(duration(recovery.status)).toBe(10_000_000n)
  const parent = f.parent().status
  if (parent._tag === 'Ended') expect(parent.endTime - recovery.status.endTime).toBe(30_000_000n)
})

test('interruption rolls back and releases the connection without committing', async () => {
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
  expect(Exit.isSuccess(phase(f, 'ROLLBACK').status.exit)).toBe(true)
})

test('nested savepoints retain their own control spans and one outer connection release', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(f.transaction(Effect.succeed(42))))).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'SAVEPOINT', 'RELEASE SAVEPOINT', 'COMMIT', 'RELEASE'])
  const transactions = f.spans.filter((span) => span.name === 'sql.transaction')
  expect(transactions).toHaveLength(2)
  const nested = transactions[1]
  const controls = f.spans.filter((span) => span.parent._tag === 'Some' && span.parent.value.spanId === nested?.spanId)
  expect(controls.map((span) => span.attributes.get('db.operation.name'))).toEqual(['SAVEPOINT', 'RELEASE SAVEPOINT'])
})

test('default SQL clients retain native control spans without connection-wait attributes', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(Effect.succeed(42)), false)).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(Exit.isSuccess(phase(f, 'COMMIT').status.exit)).toBe(true)
  expect(f.parent().attributes.has('db.client.connection.wait_time_ms')).toBe(false)
})

test('disabling tracing keeps the same transaction controls without recording spans', async () => {
  const f = fixture()
  expect(await f.run(f.transaction(Effect.succeed(42)), true, false)).toEqual(Exit.succeed(42))
  expect(f.calls).toEqual(['BEGIN', 'COMMIT', 'RELEASE'])
  expect(f.spans).toHaveLength(0)
})
