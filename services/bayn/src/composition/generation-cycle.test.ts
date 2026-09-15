import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber, Ref } from 'effect'

import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import type { RecoveryFirstCycleDriver } from '../observe-composition'
import type { TerminalGenerationRolloverReceipt } from '../blocked-generation-recovery'
import type { AutonomousRuntime } from '../app'
import { ownGenerationCycleDriver, withGenerationRebinding } from './generation-cycle'

const generationHash = 'a'.repeat(64)
const authority: AuthorityState = {
  schemaVersion: 'bayn.paper-authority.v1',
  generationHash,
  maximum: Authority.Execution,
  effective: Authority.Execution,
  kill: KillState.Clear,
  version: 1,
  updatedAt: '2026-09-14T19:00:00.000Z',
}
const restriction: AuthorityState = {
  ...authority,
  effective: Authority.Observe,
  kill: KillState.Active,
  reason:
    'execution cycle loop restricted effective authority: run-cycle-pass: mutation autonomous cycle pass did not complete or reconcile within 30000ms',
  version: 2,
}
const advanced = {
  observation: {
    result: 'FAILURE' as const,
    observedAt: '2026-09-14T19:12:19.332Z',
    operation: 'run-cycle-pass' as const,
    failure: 'operational' as const,
    message: 'mutation autonomous cycle pass did not complete or reconcile within 30000ms',
  },
}

test('a healthy driver hands off when its pass restricts the generation', async () => {
  const completed = await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(authority)
      const published = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
      const owner = yield* ownGenerationCycleDriver<never>({
        generationHash,
        mode: 'Mutation',
        readAuthority: Ref.get(state),
        reconcileWhenHeld: Effect.die('unexpected operator hold'),
        settle: Effect.die('healthy driver must rebind before settlement'),
        owner: (driver) => Deferred.succeed(published, driver).pipe(Effect.andThen(Effect.never)),
      })({
        advance: Ref.set(state, restriction).pipe(Effect.as(advanced)),
        nextDelayMs: 30_000,
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const driver = yield* Deferred.await(published)
      expect(yield* driver.advance).toEqual(advanced)
      yield* Effect.yieldNow
      const result = owner.pollUnsafe()
      yield* Fiber.interrupt(owner)
      return result !== undefined && Exit.isSuccess(result)
    }),
  )
  expect(completed).toBe(true)
})

test.each([
  { name: 'new system restriction', mode: 'Mutation' as const, state: restriction, rebind: true },
  {
    name: 'successor from another worker',
    mode: 'Mutation' as const,
    state: { ...authority, generationHash: 'b'.repeat(64) },
    rebind: true,
  },
  {
    name: 'operator kill during trading',
    mode: 'Mutation' as const,
    state: { ...restriction, reason: 'operator emergency stop' },
    rebind: false,
  },
  {
    name: 'operator kill during recovery',
    mode: 'CloseOnly' as const,
    state: { ...restriction, reason: 'operator emergency stop' },
    rebind: false,
  },
])('checks $name before running another cycle', async ({ mode, state, rebind }) => {
  let reconciled = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const published = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
      const owner = yield* ownGenerationCycleDriver<never>({
        generationHash,
        mode,
        readAuthority: Effect.succeed(state),
        reconcileWhenHeld: Effect.sync(() => {
          reconciled = true
        }),
        settle: Effect.die('must not settle changed or operator-restricted authority'),
        owner: (driver) => Deferred.succeed(published, driver).pipe(Effect.andThen(Effect.never)),
      })({ advance: Effect.die('must not advance the stale driver'), nextDelayMs: 30_000 }).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      const driver = yield* Deferred.await(published)
      expect((yield* driver.advance).observation).toMatchObject({ result: 'FAILURE', operation: 'read-authority-slot' })
      yield* Effect.yieldNow
      expect(owner.pollUnsafe() !== undefined).toBe(rebind)
      expect(reconciled).toBe(!rebind)
      yield* Fiber.interrupt(owner)
    }),
  )
})

test('close-only recovery waits for settlement and hands off once, including queued advances', async () => {
  let closePasses = 0
  let settlements = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(restriction)
      const published = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
      const settle: Effect.Effect<TerminalGenerationRolloverReceipt> = Effect.gen(function* () {
        settlements += 1
        if (settlements === 1) return { _tag: 'NotRequired' }
        yield* Ref.set(state, {
          ...authority,
          maximum: Authority.Observe,
          effective: Authority.Observe,
          generationHash: 'b'.repeat(64),
        })
        return {
          _tag: 'RolledOver',
          previousGenerationHash: generationHash,
          generationHash: 'b'.repeat(64),
          blockedCycleCount: 0,
          blockedIntentCount: 0,
          expiredIntentCount: 0,
          terminalIntentCount: 2,
        }
      })
      const owner = yield* ownGenerationCycleDriver<never>({
        generationHash,
        mode: 'CloseOnly',
        readAuthority: Ref.get(state),
        reconcileWhenHeld: Effect.die('unexpected operator hold'),
        settle,
        owner: (driver) => Deferred.succeed(published, driver).pipe(Effect.andThen(Effect.never)),
      })({
        advance: Effect.sync(() => {
          closePasses += 1
          return advanced
        }),
        nextDelayMs: 30_000,
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const driver = yield* Deferred.await(published)
      yield* driver.advance
      expect(owner.pollUnsafe()).toBeUndefined()
      yield* Effect.all([driver.advance, driver.advance], { concurrency: 2 })
      yield* Fiber.join(owner)
      expect(yield* Ref.get(state)).toMatchObject({ effective: Authority.Observe, kill: KillState.Clear })
    }),
  )
  expect(closePasses).toBe(2)
  expect(settlements).toBe(2)
})

test('interrupting recovery finalizes the published driver without settling authority', async () => {
  let finalized = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>()
      const owner = yield* ownGenerationCycleDriver<never>({
        generationHash,
        mode: 'CloseOnly',
        readAuthority: Effect.succeed(restriction),
        reconcileWhenHeld: Effect.die('unexpected operator hold'),
        settle: Effect.die('interruption cannot settle authority'),
        owner: () =>
          Deferred.succeed(published, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true
              }),
            ),
          ),
      })({ advance: Effect.never, nextDelayMs: 30_000 }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(published)
      yield* Fiber.interrupt(owner)
    }),
  )
  expect(finalized).toBe(true)
})

test('one runtime runs healthy, restricted, OBSERVE rollover and reactivation drivers without a restart', async () => {
  const transitions: string[] = []
  let finalized = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(authority)
      const first = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
      const second = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
      const third = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
      const successor = { ...authority, generationHash: 'b'.repeat(64) }
      const settle: Effect.Effect<TerminalGenerationRolloverReceipt> = Effect.gen(function* () {
        transitions.push('terminal intents and fresh exact flat reconciliation')
        yield* Ref.set(state, { ...successor, maximum: Authority.Observe, effective: Authority.Observe })
        transitions.push('clear OBSERVE successor')
        return {
          _tag: 'RolledOver',
          previousGenerationHash: generationHash,
          generationHash: successor.generationHash,
          blockedCycleCount: 0,
          blockedIntentCount: 0,
          expiredIntentCount: 0,
          terminalIntentCount: 2,
        }
      })
      const resolveNext = Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.maximum === Authority.Observe && current.kill === KillState.Clear) {
          transitions.push('activation verified')
          yield* Ref.set(state, successor)
        }
        return makeRuntime(yield* Ref.get(state))
      })
      const makeRuntime = (current: AuthorityState): AutonomousRuntime<never, never> => {
        const mode = current.kill === KillState.Active ? 'CloseOnly' : 'Mutation'
        const published = mode === 'CloseOnly' ? second : current.generationHash === generationHash ? first : third
        const owner = ownGenerationCycleDriver<never>({
          generationHash: current.generationHash,
          mode,
          readAuthority: Ref.get(state),
          reconcileWhenHeld: Effect.die('unexpected operator hold'),
          settle,
          owner: (driver) =>
            Deferred.succeed(published, driver).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized += 1
                }),
              ),
            ),
        })
        return {
          _tag: 'AutonomousRead',
          cycleBindingId: current.generationHash,
          startCycle: withGenerationRebinding(
            () =>
              Effect.succeed(
                owner({
                  nextDelayMs: 30_000,
                  advance: Effect.gen(function* () {
                    transitions.push(mode)
                    if (published === first) yield* Ref.set(state, restriction)
                    return advanced
                  }),
                }),
              ),
            resolveNext,
          ),
        }
      }
      const loop = yield* makeRuntime(authority).startCycle({
        cycleBindingId: generationHash,
        recordPass: () => Effect.void,
      })
      const fiber = yield* loop.pipe(Effect.forkChild({ startImmediately: true }))
      yield* (yield* Deferred.await(first)).advance
      yield* (yield* Deferred.await(second)).advance
      yield* (yield* Deferred.await(third)).advance
      expect(yield* Ref.get(state)).toEqual(successor)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(fiber)
    }),
  )
  expect(transitions).toEqual([
    'Mutation',
    'CloseOnly',
    'terminal intents and fresh exact flat reconciliation',
    'clear OBSERVE successor',
    'activation verified',
    'Mutation',
  ])
  expect(finalized).toBe(3)
})
