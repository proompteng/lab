import { expect, test } from 'bun:test'
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Option, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import type { WriterFenceService } from '../execution/writer-fence'
import { makeRecoveryContainmentStore, makeRecoveryClockFixture } from './recovery-clock.test-support'
import { containRuntimeFailure } from '../simulation-reconciliation/broker-containment'
import { ReconciliationError } from '../simulation-reconciliation/broker-reconciler-model'
import { currentUtcInstant } from '../time'

class FixtureTransaction extends Context.Service<FixtureTransaction, boolean>()('FixtureTransaction') {}

const initial = Date.parse('2026-09-04T19:59:03.010Z')
const timestamp = (millis: number) => new Date(millis).toISOString()

const makeFixtureFence = (database?: { clock: number; restriction: string | null }) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    return {
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.serviceOption(FixtureTransaction).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
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
        const database: { clock: number; restriction: string | null } = { clock: initial, restriction: null }
        const fence = yield* makeFixtureFence(database)
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
        const pairedClock = yield* makeRecoveryClockFixture(
          Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                database.clock = now + 1
              }),
            ),
            Effect.andThen(advanceClock),
          ),
        )
        const recovery = pairedClock.reconcile(reconcile)
        const worker = yield* recovery.pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(entered)
        if (mode === 'interruption') yield* Fiber.interrupt(worker)
        else {
          const exit = yield* Fiber.join(worker)
          expect(exit._tag).toBe('Failure')
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
        }
        expect(database.restriction).toBe(mode === 'interruption' ? null : 'reconciliation pass incomplete')
        expect(timestamp(database.clock)).toBe('2026-09-04T19:59:03.011Z')
        expect(yield* Clock.currentTimeMillis).toBe(database.clock)
        yield* pairedClock.reconcile(Effect.void)
        expect(timestamp(database.clock)).toBe('2026-09-04T19:59:03.013Z')
        expect(yield* Clock.currentTimeMillis).toBe(database.clock)
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
      const fence = yield* makeFixtureFence()
      const recoveryClock = yield* makeRecoveryClockFixture(advanceClock)
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
        recoveryClock.reconcile(reconciliation).pipe(
          Effect.andThen(
            recoveryClock.authority(
              fence.transaction(
                Effect.gen(function* () {
                  const activatedAt = yield* Clock.currentTimeMillis
                  const evidence = { activatedAt: timestamp(activatedAt), reconciledAt: timestamp(reconciledAt) }
                  authority.push(evidence)
                  expect(reconciledAt, JSON.stringify(evidence)).toBeLessThan(activatedAt)
                }),
              ),
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
      const second = yield* owner(reconcile).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(timestamp(yield* Clock.currentTimeMillis)).toBe('2026-09-04T19:59:03.011Z')
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(persisted.map(timestamp)).toEqual(['2026-09-04T19:59:03.011Z', '2026-09-04T19:59:03.013Z'])
      expect(authority).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test('interruption cannot separate the committed database tick from the Effect clock tick', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(initial)
      const databaseAdvanced = yield* Deferred.make<void>()
      const publishClock = yield* Deferred.make<void>()
      let databaseClock = initial
      let reconciled = false
      const recoveryClock = yield* makeRecoveryClockFixture(
        Effect.gen(function* () {
          databaseClock = (yield* Clock.currentTimeMillis) + 1
          yield* Deferred.succeed(databaseAdvanced, undefined)
          yield* Deferred.await(publishClock)
          yield* TestClock.setTime(databaseClock)
        }),
      )
      const worker = yield* recoveryClock
        .reconcile(
          Effect.sync(() => {
            reconciled = true
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(databaseAdvanced)
      const cancellation = yield* Fiber.interrupt(worker).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(worker.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(publishClock, undefined)
      yield* Fiber.join(cancellation)
      expect(reconciled).toBe(false)
      expect(timestamp(databaseClock)).toBe('2026-09-04T19:59:03.011Z')
      expect(yield* Clock.currentTimeMillis).toBe(databaseClock)
      expect(yield* recoveryClock.authority(Effect.succeed('permit released'))).toBe('permit released')
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test.each(
  [
    ['first reconciliation', 'first authority', 'second reconciliation', 'second authority'],
    ['first reconciliation', 'second reconciliation', 'first authority', 'second authority'],
    ['first reconciliation', 'second reconciliation', 'second authority', 'first authority'],
    ['second reconciliation', 'second authority', 'first reconciliation', 'first authority'],
    ['second reconciliation', 'first reconciliation', 'second authority', 'first authority'],
    ['second reconciliation', 'first reconciliation', 'first authority', 'second authority'],
  ].map((order) => ({ order, label: order.join(' ') })),
)('recovery clock stays later than reconciliation in recovery order $label', async ({ order }) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(initial)
      const fence = yield* makeFixtureFence()
      const recoveryClock = yield* makeRecoveryClockFixture(advanceClock)
      let reconciledAt = initial
      for (const action of order) {
        if (action.endsWith('reconciliation')) {
          yield* recoveryClock.reconcile(
            fence.transaction(
              Clock.currentTimeMillis.pipe(
                Effect.tap((now) =>
                  Effect.sync(() => {
                    reconciledAt = now
                  }),
                ),
              ),
            ),
          )
        } else {
          yield* recoveryClock.authority(
            fence.transaction(
              Effect.gen(function* () {
                const activatedAt = yield* Clock.currentTimeMillis
                expect(reconciledAt, JSON.stringify({ order, action, activatedAt, reconciledAt })).toBeLessThan(
                  activatedAt,
                )
              }),
            ),
          )
        }
      }
    }).pipe(Effect.provide(TestClock.layer())),
  )
})
