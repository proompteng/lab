import { expect, test } from 'bun:test'
import { Clock, Context, Deferred, Effect, Exit, Fiber, Option, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import type { WriterFenceService } from '../execution/writer-fence'
import { makeRecoveryContainmentStore, reconcileRecoveryFixture } from './recovery-clock.test-support'
import { containRuntimeFailure } from '../simulation-reconciliation/broker-containment'
import { ReconciliationError } from '../simulation-reconciliation/broker-reconciler-model'
import { currentUtcInstant } from '../time'

class FixtureTransaction extends Context.Service<FixtureTransaction, boolean>()('FixtureTransaction') {}

const initial = Date.parse('2026-09-04T19:59:03.010Z')
const timestamp = (millis: number) => new Date(millis).toISOString()

const makeFixtureFence = (requested = Effect.void, database?: { clock: number; restriction: string | null }) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    return {
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.serviceOption(FixtureTransaction).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                requested.pipe(
                  Effect.andThen(
                    permit.withPermit(
                      Effect.uninterruptibleMask((restore) =>
                        Effect.gen(function* () {
                          const before = database === undefined ? undefined : { ...database }
                          const exit = yield* Effect.exit(
                            restore(effect.pipe(Effect.provideService(FixtureTransaction, true))),
                          )
                          if (Exit.isFailure(exit) && before !== undefined && database !== undefined) {
                            database.clock = before.clock
                            database.restriction = before.restriction
                          }
                          return yield* exit
                        }),
                      ),
                    ),
                  ),
                ),
              onSome: () => effect,
            }),
          ),
        ),
    } satisfies WriterFenceService
  })

const advanceClock = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => TestClock.setTime(now + 1)))

test.each(['failure', 'defect', 'interruption'] as const)(
  'recovery preserves committed containment and clock agreement after %s',
  async (mode) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(initial)
        const database = { clock: initial, restriction: null as string | null }
        const fence = yield* makeFixtureFence(Effect.void, database)
        const entered = yield* Deferred.make<void>()
        const failure = new ReconciliationError({ operation: 'snapshot', message: 'synthetic reconciliation failure' })
        const store = makeRecoveryContainmentStore((reason) =>
          Effect.sync(() => {
            database.restriction = reason
          }),
        )
        const reconcile = containRuntimeFailure(
          fence.transaction(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(
                mode === 'interruption' ? Effect.never : mode === 'defect' ? Effect.die(failure) : Effect.fail(failure),
              ),
            ),
          ),
          store,
          fence,
          currentUtcInstant,
        )
        const recovery = reconcileRecoveryFixture({
          writerFence: fence,
          advanceClock: Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                database.clock = now + 1
              }),
            ),
            Effect.andThen(advanceClock),
          ),
          reconcile,
        })
        const worker = yield* recovery.pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(entered)
        if (mode === 'interruption') yield* Fiber.interrupt(worker)
        else expect((yield* Fiber.join(worker))._tag).toBe('Failure')
        expect(database.restriction).toBe(mode === 'interruption' ? null : 'reconciliation pass incomplete')
        expect(timestamp(database.clock)).toBe('2026-09-04T19:59:03.011Z')
        expect(yield* Clock.currentTimeMillis).toBe(database.clock)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  },
)

test.each(['failure', 'interruption'] as const)(
  'recovery %s releases the fence without a completion tick',
  async (mode) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(initial)
        const fence = yield* makeFixtureFence()
        const entered = yield* Deferred.make<void>()
        const recovery = reconcileRecoveryFixture({
          writerFence: fence,
          advanceClock,
          reconcile: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(mode === 'failure' ? Effect.fail('synthetic reconciliation failure') : Effect.never),
          ),
        })
        const worker = yield* recovery.pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(entered)
        if (mode === 'interruption') yield* Fiber.interrupt(worker)
        else expect((yield* Fiber.join(worker))._tag).toBe('Failure')
        expect(timestamp(yield* Clock.currentTimeMillis)).toBe('2026-09-04T19:59:03.011Z')
        let reconciledAt = initial
        yield* reconcileRecoveryFixture({
          writerFence: fence,
          advanceClock,
          reconcile: Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                reconciledAt = now
              }),
            ),
          ),
        })
        expect(timestamp(reconciledAt)).toBe('2026-09-04T19:59:03.012Z')
        expect(timestamp(yield* Clock.currentTimeMillis)).toBe('2026-09-04T19:59:03.013Z')
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  },
)

test('concurrent recovery cannot advance the clock inside another reconciliation transaction', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(initial)
      const firstReconciliation = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondTransaction = yield* Deferred.make<void>()
      let requests = 0
      const fence = yield* makeFixtureFence(
        Effect.suspend(() => {
          requests += 1
          return requests === 2 ? Deferred.succeed(secondTransaction, undefined).pipe(Effect.asVoid) : Effect.void
        }),
      )
      let reconciledAt = initial
      const persisted: number[] = []
      const authority: { activatedAt: string; reconciledAt: string }[] = []
      const reconcile = fence.transaction(
        Effect.gen(function* () {
          reconciledAt = yield* Clock.currentTimeMillis
          persisted.push(reconciledAt)
        }),
      )
      const owner = (reconciliation: Effect.Effect<void>) =>
        reconcileRecoveryFixture({ writerFence: fence, advanceClock, reconcile: reconciliation }).pipe(
          Effect.andThen(
            fence.transaction(
              Effect.gen(function* () {
                const activatedAt = yield* Clock.currentTimeMillis
                const evidence = { activatedAt: timestamp(activatedAt), reconciledAt: timestamp(reconciledAt) }
                authority.push(evidence)
                expect(reconciledAt, JSON.stringify(evidence)).toBeLessThan(activatedAt)
              }),
            ),
          ),
        )
      const first = yield* owner(
        fence.transaction(
          Deferred.succeed(firstReconciliation, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(reconcile),
          ),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(firstReconciliation)
      const second = yield* owner(reconcile).pipe(Effect.forkChild)
      yield* Deferred.await(secondTransaction)
      expect(timestamp(yield* Clock.currentTimeMillis)).toBe('2026-09-04T19:59:03.011Z')
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(persisted.map(timestamp)).toEqual(['2026-09-04T19:59:03.011Z', '2026-09-04T19:59:03.013Z'])
      expect(authority).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test.each(
  [
    ['AC', 'AG', 'BC', 'BG'],
    ['AC', 'BC', 'AG', 'BG'],
    ['AC', 'BC', 'BG', 'AG'],
    ['BC', 'BG', 'AC', 'AG'],
    ['BC', 'AC', 'BG', 'AG'],
    ['BC', 'AC', 'AG', 'BG'],
  ].map((order) => ({ order, label: order.join(' ') })),
)('recovery clock stays later than reconciliation in writer order $label', async ({ order }) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(initial)
      const fence = yield* makeFixtureFence()
      let reconciledAt = initial
      for (const action of order) {
        if (action.endsWith('C')) {
          yield* reconcileRecoveryFixture({
            writerFence: fence,
            advanceClock,
            reconcile: fence.transaction(
              Clock.currentTimeMillis.pipe(
                Effect.tap((now) =>
                  Effect.sync(() => {
                    reconciledAt = now
                  }),
                ),
              ),
            ),
          })
        } else {
          yield* fence.transaction(
            Effect.gen(function* () {
              const activatedAt = yield* Clock.currentTimeMillis
              expect(reconciledAt, JSON.stringify({ order, action, activatedAt, reconciledAt })).toBeLessThan(
                activatedAt,
              )
            }),
          )
        }
      }
    }).pipe(Effect.provide(TestClock.layer())),
  )
})
