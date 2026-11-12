import { describe, expect, test } from 'bun:test'

import { PgClient } from '@effect/sql-pg'
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect'
import type { Connection } from 'effect/sql/SqlConnection'

import { WriterFence, WriterFenceLive } from './writer-fence'
import { postgresQueryFixture } from '../testing/postgres-fixture.test-support'

const fixture = (
  hooks: {
    readonly reserve?: Effect.Effect<void>
    readonly query?: (command: string) => Effect.Effect<void, Error>
  } = {},
) => {
  const commands: string[] = []
  let pending: string[] = []
  let durable: string[] = []
  let saved: string[] = []
  let released = 0
  const connection = {
    executeValues: () => Effect.succeed([[true]]),
    executeUnprepared: (command: string) =>
      Effect.gen(function* () {
        commands.push(command)
        if (command === 'BEGIN') pending = [...durable]
        if (hooks.query !== undefined) yield* hooks.query(command)
        if (command === 'SAVEPOINT bayn_finalization') saved = [...pending]
        if (command === 'ROLLBACK TO SAVEPOINT bayn_finalization') pending = [...saved]
        if (command === 'COMMIT') durable = [...pending]
        if (command === 'ROLLBACK') pending = [...durable]
        return []
      }),
  } as unknown as Connection
  const client = Object.assign(postgresQueryFixture(), {
    reserve: (hooks.reserve ?? Effect.void).pipe(
      Effect.andThen(
        Effect.acquireRelease(Effect.succeed(connection), () =>
          Effect.sync(() => {
            released += 1
          }),
        ),
      ),
    ),
  })
  const layer = WriterFenceLive.pipe(Layer.provide(Layer.succeed(PgClient.PgClient, client)))
  return {
    commands,
    client,
    connection,
    layer,
    durable: () => durable,
    released: () => released,
    write: (value: string) =>
      Effect.sync(() => {
        pending.push(value)
        return value
      }),
  }
}

describe('writer-owned prepared finalization', () => {
  test('commits preparation and preserves a synchronous finalizer-selection defect', async () => {
    const check = fixture()
    const result = await Effect.runPromiseExit(
      Effect.flatMap(WriterFence, (fence) =>
        fence.transaction(check.write('prepared'), () => {
          throw new Error('selector defect')
        }),
      ).pipe(Effect.provide(check.layer)),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('selector defect')
    expect(check.durable()).toEqual(['prepared'])
    expect(check.commands).toEqual(['BEGIN', 'COMMIT'])
    expect(check.released()).toBe(1)
  })

  for (const command of ['SAVEPOINT bayn_finalization', 'RELEASE SAVEPOINT bayn_finalization']) {
    test(`external interruption during ${command} cannot return success`, async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const check = fixture({
            query: (query) =>
              query === command
                ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
          })
          const running = yield* Effect.flatMap(WriterFence, (fence) =>
            fence.transaction(check.write('prepared'), () => check.write('final')),
          ).pipe(Effect.provide(check.layer), Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(reached).pipe(Effect.raceFirst(Fiber.join(running)))
          const interrupted = yield* Fiber.interrupt(running).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interrupted)
          return { exit: yield* Fiber.await(running), check }
        }),
      )
      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.check.durable()).toEqual(command.startsWith('SAVEPOINT') ? ['prepared'] : ['prepared', 'final'])
      expect(result.check.commands.filter((query) => query === 'COMMIT')).toHaveLength(1)
      expect(result.check.released()).toBe(1)
    })
  }

  test('commits successful preparation and finalization together', async () => {
    const check = fixture()
    const result = await Effect.runPromise(
      Effect.flatMap(WriterFence, (fence) =>
        fence.transaction(check.write('prepared'), () => check.write('final')),
      ).pipe(Effect.provide(check.layer)),
    )
    expect(result).toBe('final')
    expect(check.durable()).toEqual(['prepared', 'final'])
    expect(check.commands.filter((command) => command === 'COMMIT')).toHaveLength(1)
    expect(check.released()).toBe(1)
  })

  for (const failure of ['typed', 'defect', 'interruption'] as const) {
    test(`commits preparation but rolls back finalization after ${failure}`, async () => {
      const check = fixture()
      const fail =
        failure === 'typed'
          ? Effect.fail('finalization failed')
          : failure === 'defect'
            ? Effect.die('finalization defect')
            : Effect.interrupt
      const result = await Effect.runPromiseExit(
        Effect.flatMap(WriterFence, (fence) =>
          fence.transaction(check.write('prepared'), () => check.write('discarded').pipe(Effect.andThen(fail))),
        ).pipe(Effect.provide(check.layer)),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(check.durable()).toEqual(['prepared'])
      expect(check.commands).toContain('ROLLBACK TO SAVEPOINT bayn_finalization')
      expect(check.commands.filter((command) => command === 'COMMIT')).toHaveLength(1)
      expect(check.commands).not.toContain('ROLLBACK')
      expect(check.released()).toBe(1)
    })
  }

  test('external Fiber interruption retains preparation before returning the interrupted exit', async () => {
    const check = fixture()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fence = yield* WriterFence
        const started = yield* Deferred.make<void>()
        const attempt = yield* fence
          .transaction(check.write('prepared'), () =>
            check
              .write('discarded')
              .pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(attempt)
        return yield* Fiber.await(attempt)
      }).pipe(Effect.provide(check.layer)),
    )
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(check.durable()).toEqual(['prepared'])
    expect(check.commands).toContain('ROLLBACK TO SAVEPOINT bayn_finalization')
    expect(check.commands.filter((command) => command === 'COMMIT')).toHaveLength(1)
    expect(check.released()).toBe(1)
  })

  for (const phase of ['reserve', 'begin', 'preparation'] as const) {
    test(`keeps ${phase} interruptible and does not finalize incomplete preparation`, async () => {
      const started = await Effect.runPromise(Deferred.make<void>())
      const block = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      const check = fixture({
        ...(phase === 'reserve' ? { reserve: block } : {}),
        query: (command) => (phase === 'begin' && command === 'BEGIN' ? block : Effect.void),
      })
      let finalized = false
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fence = yield* WriterFence
          const prepare = check
            .write('prepared')
            .pipe(Effect.andThen(phase === 'preparation' ? block : Effect.succeed('prepared')))
          const attempt = yield* fence
            .transaction(prepare, () =>
              Effect.sync(() => {
                finalized = true
                return 'unexpected'
              }),
            )
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(attempt)
          return yield* Fiber.await(attempt)
        }).pipe(Effect.provide(check.layer)),
      )
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
      expect(finalized).toBe(false)
      expect(check.durable()).toEqual([])
      expect(check.commands).not.toContain('COMMIT')
      if (phase !== 'reserve') expect(check.commands).toContain('ROLLBACK')
    })
  }

  for (const command of [
    'SAVEPOINT bayn_finalization',
    'ROLLBACK TO SAVEPOINT bayn_finalization',
    'RELEASE SAVEPOINT bayn_finalization',
  ]) {
    test(`rolls back the whole transaction when ${command} fails`, async () => {
      const check = fixture({
        query: (current) => (current === command ? Effect.fail(new Error('SQL control failed')) : Effect.void),
      })
      const result = await Effect.runPromiseExit(
        Effect.flatMap(WriterFence, (fence) =>
          fence.transaction(check.write('prepared'), () =>
            check.write('discarded').pipe(Effect.andThen(Effect.fail('original finalization failure'))),
          ),
        ).pipe(Effect.provide(check.layer)),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(check.durable()).toEqual([])
      expect(check.commands).toContain('ROLLBACK')
      expect(check.commands).not.toContain('COMMIT')
      expect(check.released()).toBe(1)
      if (command !== 'SAVEPOINT bayn_finalization' && Exit.isFailure(result)) {
        expect(result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toContain(
          'original finalization failure',
        )
      }
    })
  }

  test('does not hide commit failure or the deferred finalization failure', async () => {
    const check = fixture({
      query: (command) => (command === 'COMMIT' ? Effect.fail(new Error('commit unavailable')) : Effect.void),
    })
    const result = await Effect.runPromiseExit(
      Effect.flatMap(WriterFence, (fence) =>
        fence.transaction(check.write('prepared'), () => Effect.fail('finalization failed')),
      ).pipe(Effect.provide(check.layer)),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const errors = result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
      expect(errors).toContain('finalization failed')
      expect(errors).toContainEqual(expect.objectContaining({ _tag: 'WriterFenceError', operation: 'transaction' }))
    }
  })

  test('does not add a savepoint when finalization is declined', async () => {
    const check = fixture()
    await Effect.runPromise(
      Effect.flatMap(WriterFence, (fence) => fence.transaction(check.write('prepared'), () => undefined)).pipe(
        Effect.provide(check.layer),
      ),
    )
    expect(check.commands).toEqual(['BEGIN', 'COMMIT'])
    expect(check.durable()).toEqual(['prepared'])
  })

  test('rejects finalization inside an ambient transaction', async () => {
    const check = fixture()
    const result = await Effect.runPromiseExit(
      Effect.flatMap(WriterFence, (fence) =>
        fence
          .transaction(check.write('prepared'), () => check.write('final'))
          .pipe(Effect.provideService(check.client.transactionService, [check.connection, 0])),
      ).pipe(Effect.provide(check.layer)),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(check.commands).toEqual([])
    expect(check.durable()).toEqual([])
  })
})
