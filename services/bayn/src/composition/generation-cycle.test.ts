import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber, Ref, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'

import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import type { RecoveryFirstCycleDriver } from '../observe-composition/model'
import type { TerminalGenerationRolloverReceipt } from '../blocked-generation-recovery'
import { CycleRunnerError } from '../cycle/runner/model'
import type { AutonomousRuntime } from '../app'
import { runRestateAdvanceWithinTimeout } from '../observe-composition/recovery-driver'
import { ExecutionStageTimings, type ExecutionStageTiming } from '../telemetry'
import { makeGenerationCycleDriver, ownGenerationCycleDriver, withGenerationRebinding } from './generation-cycle'

const generationHash = 'a'.repeat(64)
const deadline = { timeoutMs: 30_000, onTimeout: (error: CycleRunnerError) => Effect.fail(error) }
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

test.each(['success', 'failure', 'held'] as const)(
  'generation and cycle deadlines record distinct operation samples for %s',
  async (outcome) => {
    const timings = new Map<string, ExecutionStageTiming>()
    const failure = new CycleRunnerError({
      operation: 'run-cycle-pass',
      failure: 'operational',
      message: 'fixture cycle failure',
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const permit = yield* Semaphore.make(1)
        const owned = yield* makeGenerationCycleDriver(
          {
            generationHash,
            mode: 'Mutation',
            readAuthority: Effect.succeed(
              outcome === 'held' ? { ...restriction, reason: 'operator emergency stop' } : authority,
            ),
            reconcileWhenHeld: Effect.void,
            settle: Effect.die('must not settle a mutation driver'),
          },
          {
            advance: runRestateAdvanceWithinTimeout(
              permit,
              outcome === 'failure' ? Effect.fail(failure) : Effect.succeed(advanced),
              deadline.timeoutMs,
              Effect.fail,
            ),
            ...deadline,
            nextDelayMs: 30_000,
          },
        )
        const result = yield* Effect.exit(owned.driver.advance)
        expect(Exit.isSuccess(result)).toBe(outcome !== 'failure')
      }).pipe(Effect.provideService(ExecutionStageTimings, timings)),
    )
    const samples = [...timings.values()]
    const generation = samples.find(({ stage }) => stage === 'bayn.execution.generation-pass')
    const cycle = samples.find(({ stage }) => stage === 'bayn.execution.bounded-pass')
    expect(generation).toMatchObject({ count: 1, failures: outcome === 'failure' ? 1 : 0 })
    if (outcome === 'held') expect(cycle).toBeUndefined()
    else expect(cycle).toMatchObject({ count: 1, failures: outcome === 'failure' ? 1 : 0 })
  },
)

test.each(['authority', 'cycle', 'settlement'] as const)(
  'the pass deadline includes a stalled %s stage',
  async (stage) => {
    let cycleTimeouts = 0
    let finalized = false
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const published = yield* Deferred.make<RecoveryFirstCycleDriver<never>>()
        const stalled = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true
            }),
          ),
        )
        const owner = yield* ownGenerationCycleDriver<never>({
          generationHash,
          mode: stage === 'settlement' ? 'CloseOnly' : 'Mutation',
          readAuthority:
            stage === 'authority' ? stalled : Effect.succeed(stage === 'settlement' ? restriction : authority),
          reconcileWhenHeld: Effect.die('not held'),
          settle: stage === 'settlement' ? stalled : Effect.die('not settling'),
          owner: (driver) => Deferred.succeed(published, driver).pipe(Effect.andThen(Effect.never)),
        })({
          timeoutMs: 100,
          nextDelayMs: 100,
          onTimeout: () =>
            Effect.sync(() => {
              cycleTimeouts += 1
              return advanced
            }),
          advance: stage === 'cycle' ? stalled : Effect.succeed(advanced),
        }).pipe(Effect.forkChild({ startImmediately: true }))
        const driver = yield* Deferred.await(published)
        const attempt = yield* driver.advance.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* TestClock.adjust(stage === 'authority' ? 16 : 100)
        const result = yield* Fiber.await(attempt)
        yield* Fiber.interrupt(owner)
        return result
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(Exit.isSuccess(exit)).toBe(stage === 'cycle')
    expect(cycleTimeouts).toBe(stage === 'cycle' ? 1 : 0)
    expect(finalized).toBe(true)
  },
)

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
        ...deadline,
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
      })({ advance: Effect.die('must not advance the stale driver'), ...deadline, nextDelayMs: 30_000 }).pipe(
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
        ...deadline,
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
  expect(closePasses).toBe(1)
  expect(settlements).toBe(2)
})

test('a settled flat generation restores without running another cycle pass', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(restriction)
      const owned = yield* makeGenerationCycleDriver(
        {
          generationHash,
          mode: 'CloseOnly',
          readAuthority: Ref.get(state),
          reconcileWhenHeld: Effect.die('Recovery is not an operator hold'),
          settle: Ref.set(state, {
            ...authority,
            generationHash: 'b'.repeat(64),
            maximum: Authority.Observe,
            effective: Authority.Observe,
          }).pipe(
            Effect.as({
              _tag: 'RolledOver',
              previousGenerationHash: generationHash,
              generationHash: 'b'.repeat(64),
              blockedCycleCount: 0,
              blockedIntentCount: 0,
              expiredIntentCount: 0,
              terminalIntentCount: 0,
            } as const),
          ),
        },
        { ...deadline, nextDelayMs: 30_000, advance: Effect.die('A flat settled account needs no cycle pass') },
      )
      expect((yield* owned.driver.advance).observation).toMatchObject({ result: 'SUCCESS', outcome: 'RECOVERED' })
      expect(yield* owned.needsRebind).toBe(true)
    }),
  )
})

test('an operator hold arriving during settlement prevents another recovery cycle', async () => {
  let heldReconciliations = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(restriction)
      const owned = yield* makeGenerationCycleDriver(
        {
          generationHash,
          mode: 'CloseOnly',
          readAuthority: Ref.get(state),
          reconcileWhenHeld: Effect.sync(() => {
            heldReconciliations += 1
          }),
          settle: Ref.set(state, { ...restriction, reason: 'operator hold' }).pipe(
            Effect.as({ _tag: 'NotRequired' } as const),
          ),
        },
        { ...deadline, nextDelayMs: 30_000, advance: Effect.die('An operator hold cannot advance recovery') },
      )
      expect((yield* owned.driver.advance).observation).toMatchObject({
        result: 'FAILURE',
        operation: 'read-authority-slot',
      })
      expect(yield* owned.needsRebind).toBe(false)
      expect((yield* Ref.get(state)).kill).toBe(KillState.Active)
    }),
  )
  expect(heldReconciliations).toBe(1)
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
      })({ advance: Effect.never, ...deadline, nextDelayMs: 30_000 }).pipe(Effect.forkChild({ startImmediately: true }))
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
                  ...deadline,
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
    'terminal intents and fresh exact flat reconciliation',
    'clear OBSERVE successor',
    'activation verified',
    'Mutation',
  ])
  expect(finalized).toBe(3)
})
