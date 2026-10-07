import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber, Logger, Option, References } from 'effect'
import { TestClock } from 'effect/testing'

import { CycleState, CycleTerminalReason } from '../cycle/model'
import { makeInitialCycle } from '../cycle/store/decisions'
import type { CycleMutationReceipt, CycleStoreShape } from '../cycle/store'
import type { JevBatchStore } from '../jev/batch-evaluation'
import { operationalError } from '../errors'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { withTerminalJevEvidence } from './terminal-jev-evidence'

const fixture = nativeJevFixture()
const evidence = nativeJevDecisionEvidence(fixture)
const cycle = {
  ...makeInitialCycle(fixture.draft, fixture.observation.payload.observedAt),
  state: CycleState.Completed,
}
const base = (receipt: CycleMutationReceipt): CycleStoreShape => ({
  acquire: () => Effect.succeed({ cycle: receipt.cycle, created: false }),
  read: () => Effect.succeed(Option.some(receipt.cycle)),
  readAuthoritySlot: () => Effect.succeed(Option.none()),
  readDecisionDocument: () => Effect.succeed(Option.none()),
  readOldestUnfinished: () => Effect.succeed(Option.none()),
  bindSnapshot: () => Effect.succeed(receipt),
  activate: () => Effect.succeed(receipt),
  bindDecision: () => Effect.succeed(receipt),
  finish: () => Effect.succeed(receipt),
  block: () => Effect.succeed(receipt),
})

const batchStore = (overrides: Partial<typeof JevBatchStore.Service> = {}): typeof JevBatchStore.Service => ({
  read: () => Effect.succeed({ plan: evidence.batchPlan, result: null }),
  pending: () => Effect.succeed([evidence.batchPlan.batchId]),
  begin: () => Effect.die('cleanup cannot begin a batch'),
  finish: () => Effect.succeed({ plan: evidence.batchPlan, result: evidence.batchResult }),
  ...overrides,
})
const captureLogs = () => {
  const annotations: Readonly<Record<string, unknown>>[] = []
  const logger = Logger.make(({ fiber }) => annotations.push(fiber.getRef(References.CurrentLogAnnotations)))
  return { annotations, layer: Logger.layer([logger]) }
}

describe('future terminal Jev evidence closure', () => {
  test('a new terminal transition closes only its own retained pending batch without another provider', async () => {
    const receipt = { cycle, changed: true }
    const calls: string[] = []
    const batches: typeof JevBatchStore.Service = {
      read: () => Effect.succeed({ plan: evidence.batchPlan, result: null }),
      pending: (id) =>
        Effect.sync(() => {
          calls.push(`pending:${id}`)
          return [evidence.batchPlan.batchId]
        }),
      begin: () => Effect.die('terminal cleanup cannot begin a batch'),
      finish: (id) =>
        Effect.sync(() => {
          calls.push(`finish:${id}`)
          return { plan: evidence.batchPlan, result: evidence.batchResult }
        }),
    }
    const store = withTerminalJevEvidence(base(receipt), batches, 1000)
    expect(
      await Effect.runPromise(store.block(cycle.identity.cycleId, CycleTerminalReason.Risk, cycle.updatedAt)),
    ).toBe(receipt)
    expect(calls).toEqual([`pending:${cycle.identity.cycleId}`, `finish:${evidence.batchPlan.batchId}`])
  })

  test('replayed terminal history and nonterminal or non-Jev transitions never query or write research evidence', async () => {
    const unexpected = batchStore({ pending: () => Effect.die('No research history scan is permitted') })
    const receipts: CycleMutationReceipt[] = [
      { cycle, changed: false },
      { cycle: { ...cycle, state: CycleState.Active }, changed: true },
      { cycle: { ...candidateObservationFixture().cycle, state: CycleState.Completed }, changed: true },
    ]
    for (const receipt of receipts) {
      const store = withTerminalJevEvidence(base(receipt), unexpected, 100)
      expect(await Effect.runPromise(store.finish(cycle.identity.cycleId, CycleState.Completed, cycle.updatedAt))).toBe(
        receipt,
      )
    }
  })

  test('cleanup begins after the authoritative terminal store mutation and preserves its receipt', async () => {
    const receipt = { cycle, changed: true }
    const events: string[] = []
    const store = withTerminalJevEvidence(
      {
        ...base(receipt),
        finish: () =>
          Effect.sync(() => {
            events.push('terminal committed')
            return receipt
          }),
      },
      batchStore({
        pending: (id, generation) =>
          Effect.sync(() => {
            expect(id).toBe(cycle.identity.cycleId)
            expect(generation).toBeUndefined()
            events.push('cycle-only evidence read')
            return []
          }),
      }),
      100,
    )
    expect(await Effect.runPromise(store.finish(cycle.identity.cycleId, CycleState.Completed, cycle.updatedAt))).toBe(
      receipt,
    )
    expect(events).toEqual(['terminal committed', 'cycle-only evidence read'])
  })

  test('a foreign cycle from another account cannot be finalized even if a pending reader returns it', async () => {
    const foreign = nativeJevFixture(undefined, undefined, 'different-account')
    const foreignEvidence = nativeJevDecisionEvidence(foreign)
    const logs = captureLogs()
    const receipt = { cycle, changed: true }
    const store = withTerminalJevEvidence(
      base(receipt),
      batchStore({
        pending: () => Effect.succeed([foreignEvidence.batchPlan.batchId]),
        read: () => Effect.succeed({ plan: foreignEvidence.batchPlan, result: null }),
        finish: () => Effect.die('Cannot write another cycle or account'),
      }),
      100,
    )
    expect(
      await Effect.runPromise(
        store.block(cycle.identity.cycleId, CycleTerminalReason.Risk, cycle.updatedAt).pipe(Effect.provide(logs.layer)),
      ),
    ).toBe(receipt)
    expect(logs.annotations).toContainEqual({
      cycleId: cycle.identity.cycleId,
      cleanupReason: 'BATCH_SCOPE_MISMATCH',
      batchId: foreignEvidence.batchPlan.batchId,
    })
  })

  test('unexpired evidence is reported without sleeping, abandoning or changing its original deadline', async () => {
    const logs = captureLogs()
    const receipt = { cycle, changed: true }
    const store = withTerminalJevEvidence(
      base(receipt),
      batchStore({ finish: () => Effect.die('No early finalization') }),
      100,
    )
    await Effect.runPromise(
      TestClock.setTime(Date.parse(evidence.batchPlan.observedAt)).pipe(
        Effect.andThen(store.block(cycle.identity.cycleId, CycleTerminalReason.Risk, cycle.updatedAt)),
        Effect.provide(TestClock.layer()),
        Effect.provide(logs.layer),
      ),
    )
    expect(logs.annotations).toContainEqual({
      cycleId: cycle.identity.cycleId,
      cleanupReason: 'ORIGINAL_DEADLINE_PENDING',
      batchId: evidence.batchPlan.batchId,
    })
  })

  for (const [reason, failure] of [
    [
      'STORE_FAILURE',
      Effect.fail(operationalError({ component: 'database', operation: 'test', message: 'Unavailable' })),
    ],
    ['DEFECT', Effect.die('Unexpected cleanup defect')],
  ] as const)
    test(`${reason} is visible while the committed terminal receipt remains authoritative`, async () => {
      const receipt = { cycle, changed: true }
      const logs = captureLogs()
      const store = withTerminalJevEvidence(base(receipt), batchStore({ pending: () => failure }), 100)
      expect(
        await Effect.runPromise(
          store
            .block(cycle.identity.cycleId, CycleTerminalReason.Risk, cycle.updatedAt)
            .pipe(Effect.provide(logs.layer)),
        ),
      ).toBe(receipt)
      expect(logs.annotations).toContainEqual({ cycleId: cycle.identity.cycleId, cleanupReason: reason })
    })

  test('the configured cleanup timeout joins cancellation and returns the committed receipt with no background work', async () => {
    const receipt = { cycle, changed: true }
    const logs = captureLogs()
    let stopped = false
    const returned = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const store = withTerminalJevEvidence(
          base(receipt),
          batchStore({
            pending: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    stopped = true
                  }),
                ),
              ),
          }),
          100,
        )
        const fiber = yield* store
          .block(cycle.identity.cycleId, CycleTerminalReason.Risk, cycle.updatedAt)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* TestClock.adjust(100)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(logs.layer)),
    )
    expect(returned).toBe(receipt)
    expect(stopped).toBe(true)
    expect(logs.annotations).toContainEqual({ cycleId: cycle.identity.cycleId, cleanupReason: 'TIMEOUT' })
  })

  test('external interruption leaves the already committed terminal state intact and owns cleanup cancellation', async () => {
    const receipt = { cycle, changed: true }
    const logs = captureLogs()
    let committed = false,
      stopped = false
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const store = withTerminalJevEvidence(
          {
            ...base(receipt),
            block: () =>
              Effect.sync(() => {
                committed = true
                return receipt
              }),
          },
          batchStore({
            pending: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    stopped = true
                  }),
                ),
              ),
          }),
          100,
        )
        const fiber = yield* store
          .block(cycle.identity.cycleId, CycleTerminalReason.Risk, cycle.updatedAt)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(logs.layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(committed).toBe(true)
    expect(stopped).toBe(true)
    expect(logs.annotations).toContainEqual({ cycleId: cycle.identity.cycleId, cleanupReason: 'INTERRUPTED' })
  })
})
