import { describe, expect, test } from 'bun:test'

import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Ref, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from './effect-test-support'

import {
  ApplicationPlatformLive,
  closedCycleReceiptEmissionAllowed,
  finalizePaperEpisode,
  paperReceiptFinalizationWindowOpen,
  refreshResearchPaperActivationReconciliation,
  restrictExpiredPaperActivation,
  retryClosedCycleReceipts,
} from './composition'
import { BrokerEnvironment } from './broker/identity'
import type { AuthorityRestrictionStoreShape } from './db/execution-store'
import { makeResearchPaperActivationRequest, makeResearchPaperPlanHash } from './execution/configuration'
import type { WriterFenceService } from './execution/writer-fence'
import { utcInstantFromEpochMillis } from './time'
import { paperEpisodeReceiptFinalizationExpiresAt } from './observe-composition'
import { initialState } from './runtime-state'

const hash = (value: string) => value.repeat(64).slice(0, 64)

const researchPlan = {
  schemaVersion: 'bayn.paper-research-plan.v1' as const,
  activation: {
    sourceRevision: '3'.repeat(40),
    imageRepository: 'registry.example.test/bayn',
    imageDigest: `sha256:${hash('4')}`,
  },
  strategy: {
    name: 'risk-balanced-trend',
    behaviorHash: hash('5'),
    parameterHash: hash('6'),
    parameterSchemaVersion: 'bayn.robust-trend-parameters.v2',
    protocolHash: hash('7'),
  },
  broker: {
    environment: BrokerEnvironment.Sandbox,
    accountId: 'paper-account',
    identityHash: hash('8'),
  },
  riskPolicyHash: hash('9'),
  limits: { maxOpenOrders: 0 as const, maxPositions: 0 as const },
  cutoffAt: '2026-09-01T13:30:00.000Z',
  expiresAt: '2026-09-03T20:00:00.000Z',
  maximumCloseSessions: 3 as const,
} as const
const { schemaVersion: _researchPlanSchemaVersion, ...researchPlanFields } = researchPlan

const researchRequest = Result.getOrThrow(
  makeResearchPaperActivationRequest({
    schemaVersion: 'bayn.paper-research-activation-request.v1',
    grant: { _tag: 'Research', planHash: Result.getOrThrow(makeResearchPaperPlanHash(researchPlan)) },
    ...researchPlanFields,
  }),
)

describe('Bayn application platform', () => {
  test('provides filesystem access for TLS-backed PostgreSQL acquisition', async () => {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(ApplicationPlatformLive)))

    expect(Context.get(context, FileSystem.FileSystem)).toBeDefined()
  })
})

describe('Bayn PAPER receipt retry boundary', () => {
  test('does not bind a generation receipt before its PAPER entry cutoff', () => {
    const cutoffAt = '2026-08-03T12:00:00.000Z'

    expect(closedCycleReceiptEmissionAllowed(cutoffAt, '2026-08-03T11:59:59.999Z')).toBe(false)
    expect(closedCycleReceiptEmissionAllowed(cutoffAt, cutoffAt)).toBe(true)
  })

  test('keeps retrying through the close lease instead of a fixed attempt count', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = utcInstantFromEpochMillis(startAt + 1_000)
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (cycleId, current) =>
            Effect.sync(() => {
              expect(cycleId).toBeUndefined()
              observedAt.push(current)
              return observedAt.length >= 17
            }),
          cutoffAt,
          utcInstantFromEpochMillis(startAt + 17_000),
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(17_000)
        yield* Fiber.join(retry)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(17)
    expect(observedAt.at(-1)).toBe(utcInstantFromEpochMillis(startAt + 17_000))
  })

  test('keeps retrying until close settlement and reconciliation produce a receipt', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = utcInstantFromEpochMillis(startAt + 1_000)
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (_cycleId, current) =>
            Effect.sync(() => {
              observedAt.push(current)
              return observedAt.length >= 8
            }),
          cutoffAt,
          utcInstantFromEpochMillis(startAt + 8_000),
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(8_000)
        yield* Fiber.join(retry)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(8)
    expect(observedAt.at(-1)).toBe(utcInstantFromEpochMillis(startAt + 8_000))
  })

  test('stops receipt retries at the bounded finalization lease when evidence never becomes eligible', async () => {
    const startAt = Date.parse('2026-08-03T12:00:00.000Z')
    const cutoffAt = utcInstantFromEpochMillis(startAt + 1_000)
    const retryUntilAt = utcInstantFromEpochMillis(startAt + 4_000)
    const observedAt: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(startAt)
        const retry = yield* retryClosedCycleReceipts(
          (_cycleId, current) =>
            Effect.sync(() => {
              observedAt.push(current)
              return false
            }),
          cutoffAt,
          retryUntilAt,
          1_000,
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(10_000)
        yield* Fiber.join(retry)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(observedAt).toHaveLength(4)
    expect(observedAt.at(-1)).toBe(retryUntilAt)
  })

  test('leaves a bounded post-close finalization window for late settlement', () => {
    expect(paperEpisodeReceiptFinalizationExpiresAt('2026-08-03T12:00:00.000Z')).toBe('2026-08-03T12:30:00.000Z')
  })

  test('keeps receipt finalization available after a restart during the close-to-receipt grace window', () => {
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:15:00.001Z')).toBe(true)
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:30:00.000Z')).toBe(false)
    expect(paperReceiptFinalizationWindowOpen('2026-08-03T12:00:00.000Z', '2026-08-03T12:14:59.999Z')).toBe(false)
  })
})

describe('Bayn PAPER startup recovery boundary', () => {
  test('persists one fresh reconciliation before activating a new research PAPER generation', async () => {
    const operations: string[] = []

    await Effect.runPromise(
      refreshResearchPaperActivationReconciliation(
        Effect.sync(() => {
          operations.push('reconcile')
        }),
        1_000,
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            operations.push('activate')
          }),
        ),
      ),
    )

    expect(operations).toEqual(['reconcile', 'activate'])
  })

  test('keeps activation disabled when the fresh reconciliation fails', async () => {
    const operations: string[] = []
    const reconciliationFailure = new Error('read-only reconciliation failed')

    const failure = await Effect.runPromise(
      Effect.flip(
        refreshResearchPaperActivationReconciliation(Effect.fail(reconciliationFailure), 1_000).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operations.push('activate')
            }),
          ),
        ),
      ),
    )

    expect(operations).toEqual([])
    expect(failure.message).toBe('research PAPER pre-activation reconciliation failed')
    expect(failure.cause).toBe(reconciliationFailure)
  })

  test('times out and interrupts pre-activation reconciliation before activation', async () => {
    const operations: string[] = []
    const timeoutFailure = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalizations = yield* Ref.make(0)
        const activation = yield* refreshResearchPaperActivationReconciliation(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Ref.update(finalizations, (count) => count + 1)),
          ),
          1_000,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operations.push('activate')
            }),
          ),
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        )

        yield* Deferred.await(started)
        yield* TestClock.adjust(999)
        expect(yield* Ref.get(finalizations)).toBe(0)
        yield* TestClock.adjust(1)

        const failure = yield* Fiber.join(activation)
        expect(yield* Ref.get(finalizations)).toBe(1)
        return failure
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(operations).toEqual([])
    expect(timeoutFailure.message).toBe('research PAPER pre-activation reconciliation failed')
    expect(timeoutFailure.cause).toMatchObject({
      message: 'research PAPER pre-activation reconciliation timed out',
    })
  })

  test('restricts durable authority before an expired close recovery is rejected', async () => {
    const restrictions: Array<{ readonly reason: string; readonly updatedAt: string }> = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: (reason, updatedAt) =>
        Effect.sync(() => {
          restrictions.push({ reason, updatedAt })
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-08-03T12:00:00.000Z'))
        yield* restrictExpiredPaperActivation(authorityRestrictionStore, writerFence)
      }).pipe(provideTestLayer(TestClock.layer())),
    )

    expect(restrictions).toEqual([
      {
        reason: 'PAPER activation lease restricted effective authority: immutable activation request expired',
        updatedAt: '2026-08-03T12:00:00.000Z',
      },
    ])
  })

  test('returns to OBSERVE presentation only after the exact flat receipt is durable', async () => {
    const restrictions: string[] = []
    const authorityRestrictionStore: AuthorityRestrictionStoreShape = {
      restrictAuthority: (reason) =>
        Effect.sync(() => {
          restrictions.push(reason)
        }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* Ref.make(
          initialState({
            broker: { expectedAccountId: 'paper-account', executionEligible: true, executionDisabledReason: null },
            autonomousCycleLoopConfigured: true,
          }),
        )
        const finalized = yield* finalizePaperEpisode(
          state,
          researchRequest,
          hash('2'),
          authorityRestrictionStore,
          writerFence,
          () => Effect.succeed(hash('a')),
          'cycle-1',
          '2026-09-03T20:01:00.000Z',
        )
        return { finalized, state: yield* Ref.get(state) }
      }),
    )

    expect(result.finalized).toBe(true)
    expect(restrictions).toEqual(['PAPER episode restricted effective authority: flat exact receipt finalized'])
    expect(result.state.paperActivation).toEqual({
      _tag: 'Completed',
      requestHash: researchRequest.requestHash,
      generationHash: hash('2'),
      grant: 'Research',
      receiptHash: hash('a'),
    })
    expect(result.state.broker).toMatchObject({
      executionEligible: false,
      executionDisabledReason: 'PAPER_EPISODE_COMPLETED',
    })
  })
})
