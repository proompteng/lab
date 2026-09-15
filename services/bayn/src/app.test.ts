import { describe, expect, test } from 'bun:test'

import { Effect, Fiber, Ref } from 'effect'

import { prepareAutonomousApplication, recordAutonomousCyclePass, type AutonomousRuntime } from './app'
import { initialState } from './runtime-state'

const bindingId = 'a'.repeat(64)

describe('Bayn autonomous application', () => {
  test('starts exactly the resolver-selected durable cycle', async () => {
    let startedBinding: string | undefined
    const resolved: AutonomousRuntime<never, never> = {
      _tag: 'AutonomousRead',
      cycleBindingId: bindingId,
      startCycle: (input) =>
        Effect.sync(() => {
          startedBinding = input.cycleBindingId
          return Effect.never
        }),
    }
    const pending: AutonomousRuntime<never, never> = {
      _tag: 'AutonomousRead',
      cycleBindingId: null,
      startCycle: () => Effect.succeed(Effect.never),
      resolveAfterStartup: () => Effect.succeed(resolved),
    }

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* prepareAutonomousApplication(pending)
        yield* Fiber.interrupt(prepared.cycleFiber)
        return yield* Ref.get(prepared.state)
      }).pipe(Effect.scoped),
    )

    expect(startedBinding).toBe(bindingId)
    expect(state.autonomousCycleLoop.startedAt).not.toBeNull()
  })

  test('fails closed when no durable cycle binding can be resolved', async () => {
    const runtime: AutonomousRuntime<never, never> = {
      _tag: 'AutonomousRead',
      cycleBindingId: null,
      startCycle: () => Effect.succeed(Effect.never),
    }

    const failure = await Effect.runPromise(Effect.flip(prepareAutonomousApplication(runtime).pipe(Effect.scoped)))

    expect(failure).toMatchObject({
      component: 'config',
      operation: 'prepare-autonomous-application',
      message: 'native execution preparation requires a durable cycle binding',
    })
  })

  test('projects cycle failures into runtime health without changing authority', async () => {
    const state = await Effect.runPromise(Ref.make(initialState({})))
    await Effect.runPromise(
      recordAutonomousCyclePass(state, {
        operation: 'reconcile',
        result: 'FAILURE',
        failure: 'operational',
        message: 'broker read failed',
        observedAt: '2026-08-28T16:00:00.000Z',
      }),
    )

    const current = await Effect.runPromise(Ref.get(state))
    expect(current.health.dependencies.cycleRunner).toEqual({
      status: 'UNAVAILABLE',
      checkedAt: '2026-08-28T16:00:00.000Z',
      error: 'reconcile/operational: broker read failed',
    })
    expect(current.capitalActivation).toEqual({ _tag: 'NotConfigured' })
  })
})
