import { expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'

import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import type { TerminalGenerationRolloverReceipt } from '../blocked-generation-recovery'
import { OperationalError } from '../errors'
import { CycleRunnerError } from '../cycle/runner/model'
import { runRestateAdvanceWithinTimeout } from '../observe-composition/recovery-driver'
import { ExecutionStageTimings, type ExecutionStageTiming } from '../telemetry'
import { makeGenerationCycleDriver, makeRebindingCycleDriver } from './generation-cycle'

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
        const stalled = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true
            }),
          ),
        )
        const owned = yield* makeGenerationCycleDriver(
          {
            generationHash,
            mode: stage === 'settlement' ? 'CloseOnly' : 'Mutation',
            readAuthority:
              stage === 'authority' ? stalled : Effect.succeed(stage === 'settlement' ? restriction : authority),
            reconcileWhenHeld: Effect.die('not held'),
            settle: stage === 'settlement' ? stalled : Effect.die('not settling'),
          },
          {
            timeoutMs: 100,
            nextDelayMs: 100,
            onTimeout: () =>
              Effect.sync(() => {
                cycleTimeouts += 1
                return advanced
              }),
            advance: stage === 'cycle' ? stalled : Effect.succeed(advanced),
          },
        )
        const driver = owned.driver
        const attempt = yield* driver.advance.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* TestClock.adjust(stage === 'authority' ? 16 : 100)
        const result = yield* Fiber.await(attempt)
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
      const owned = yield* makeGenerationCycleDriver(
        {
          generationHash,
          mode: 'Mutation',
          readAuthority: Ref.get(state),
          reconcileWhenHeld: Effect.die('unexpected operator hold'),
          settle: Effect.die('healthy driver must rebind before settlement'),
        },
        {
          advance: Ref.set(state, restriction).pipe(Effect.as(advanced)),
          ...deadline,
          nextDelayMs: 30_000,
        },
      )
      const driver = owned.driver
      expect(yield* driver.advance).toEqual(advanced)
      return yield* owned.needsRebind
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
      const owned = yield* makeGenerationCycleDriver(
        {
          generationHash,
          mode,
          readAuthority: Effect.succeed(state),
          reconcileWhenHeld: Effect.sync(() => {
            reconciled = true
          }),
          settle: Effect.die('must not settle changed or operator-restricted authority'),
        },
        { advance: Effect.die('must not advance the stale driver'), ...deadline, nextDelayMs: 30_000 },
      )
      const driver = owned.driver
      expect((yield* driver.advance).observation).toMatchObject({ result: 'FAILURE', operation: 'read-authority-slot' })
      expect(yield* owned.needsRebind).toBe(rebind)
      expect(reconciled).toBe(!rebind)
    }),
  )
})

test('close-only recovery waits for settlement and hands off once, including queued advances', async () => {
  let closePasses = 0
  let settlements = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(restriction)
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
      const owned = yield* makeGenerationCycleDriver(
        {
          generationHash,
          mode: 'CloseOnly',
          readAuthority: Ref.get(state),
          reconcileWhenHeld: Effect.die('unexpected operator hold'),
          settle,
        },
        {
          advance: Effect.sync(() => {
            closePasses += 1
            return advanced
          }),
          ...deadline,
          nextDelayMs: 30_000,
        },
      )
      const driver = owned.driver
      yield* driver.advance
      expect(yield* owned.needsRebind).toBe(false)
      yield* Effect.all([driver.advance, driver.advance], { concurrency: 2 })
      expect(yield* owned.needsRebind).toBe(true)
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

test('one driver runs healthy, restricted, OBSERVE rollover and reactivation without a restart', async () => {
  const transitions: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(authority)
      const successor = { ...authority, generationHash: 'b'.repeat(64) }
      const prepare = Effect.gen(function* () {
        let current = yield* Ref.get(state)
        if (current.maximum === Authority.Observe && current.kill === KillState.Clear) {
          transitions.push('activation verified')
          yield* Ref.set(state, successor)
          current = successor
        }
        const mode = current.kill === KillState.Active ? 'CloseOnly' : 'Mutation'
        return yield* makeGenerationCycleDriver(
          {
            generationHash: current.generationHash,
            mode,
            readAuthority: Ref.get(state),
            reconcileWhenHeld: Effect.die('unexpected operator hold'),
            settle: Effect.gen(function* () {
              transitions.push('terminal intents and fresh exact flat reconciliation')
              yield* Ref.set(state, { ...successor, maximum: Authority.Observe, effective: Authority.Observe })
              transitions.push('clear OBSERVE successor')
              return {
                _tag: 'RolledOver' as const,
                previousGenerationHash: generationHash,
                generationHash: successor.generationHash,
                blockedCycleCount: 0,
                blockedIntentCount: 0,
                expiredIntentCount: 0,
                terminalIntentCount: 2,
              }
            }),
          },
          {
            ...deadline,
            nextDelayMs: 30_000,
            advance: Effect.gen(function* () {
              transitions.push(mode)
              if (current.generationHash === generationHash) yield* Ref.set(state, restriction)
              return advanced
            }),
          },
        )
      })
      const driver = yield* makeRebindingCycleDriver(yield* prepare, prepare)
      yield* driver.advance
      yield* driver.advance
      yield* driver.advance
      expect(yield* Ref.get(state)).toEqual(successor)
    }),
  )
  expect(transitions).toEqual([
    'Mutation',
    'terminal intents and fresh exact flat reconciliation',
    'clear OBSERVE successor',
    'activation verified',
    'Mutation',
  ])
})

test.each(['failure', 'defect', 'interruption'] as const)(
  'a replacement %s never runs a stale driver and permits a later retry',
  async (mode) => {
    let attempts = 0
    let finalized = 0
    let advances = 0
    const failure = new OperationalError({
      component: 'database',
      operation: 'fixture',
      message: 'unavailable',
      retryable: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const next = {
          driver: {
            ...deadline,
            nextDelayMs: 10,
            advance: Effect.sync(() => {
              advances++
              return advanced
            }),
          },
          needsRebind: Effect.succeed(false),
        }
        const prepare = Effect.gen(function* () {
          attempts++
          if (attempts > 1) return next
          yield* Deferred.succeed(entered, undefined)
          if (mode === 'failure') return yield* failure
          if (mode === 'defect') return yield* Effect.die(failure)
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized++
            }),
          ),
        )
        const driver = yield* makeRebindingCycleDriver(
          {
            driver: { ...deadline, nextDelayMs: 10, advance: Effect.die('stale driver') },
            needsRebind: Effect.succeed(true),
          },
          prepare,
        )
        const pass = yield* driver.advance.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        if (mode === 'interruption') yield* Fiber.interrupt(pass)
        const result = yield* Fiber.await(pass)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.hasFails(result.cause)).toBe(mode === 'failure')
          expect(Cause.hasDies(result.cause)).toBe(mode === 'defect')
          expect(result.cause.reasons.some(Cause.isInterruptReason)).toBe(mode === 'interruption')
        }
        expect(advances).toBe(0)
        expect(finalized).toBe(1)
        expect(yield* driver.advance).toEqual(advanced)
        expect(advances).toBe(1)
        expect(attempts).toBe(2)
        expect(finalized).toBe(2)
      }),
    )
  },
)

test('queued advances share one replacement and keep preparation inside pass timing', async () => {
  let preparations = 0
  let advances = 0
  let timed = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const prepare = Effect.gen(function* () {
        expect(timed).toBe(true)
        preparations++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return {
          driver: {
            ...deadline,
            nextDelayMs: 10,
            advance: Effect.sync(() => {
              expect(timed).toBe(true)
              advances++
              return advanced
            }),
          },
          needsRebind: Effect.succeed(false),
        }
      })
      const driver = yield* makeRebindingCycleDriver(
        {
          driver: { ...deadline, nextDelayMs: 10, advance: Effect.die('stale driver') },
          needsRebind: Effect.succeed(true),
        },
        prepare,
        (pass) =>
          Effect.gen(function* () {
            expect(timed).toBe(false)
            timed = true
            return yield* pass.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  timed = false
                }),
              ),
            )
          }),
      )
      const first = yield* driver.advance.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const second = yield* driver.advance.pipe(Effect.forkChild({ startImmediately: true }))
      expect(preparations).toBe(1)
      expect(advances).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(preparations).toBe(1)
      expect(advances).toBe(2)
      expect(timed).toBe(false)
    }),
  )
})
