import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Fiber, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { config, successfulJournal, readyState, recoveringStore } from './app-test-support'
import { monitor, probe } from './app'
import { AccountStatus, type BrokerReadShape, type ReadResult, type Account } from './broker/alpaca'
import { unusedMarketCalendar } from './broker/alpaca-test-support'
import { CycleOperationsCondition, CycleOperationsReason, type CycleOperationsProjection } from './cycle-observability'
import { CycleState } from './cycle'
import { CycleObservability, type CycleObservabilityShape } from './db/cycle-observability'
import { EvidenceStore } from './db/evidence-store'
import type { BrokerProbe } from './health'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { initialState } from './runtime-state'
import { makeSnapshot } from './test-fixtures'

const brokerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const accountResult = (id = brokerAccountId): ReadResult<Account> => ({
  value: {
    id,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '1000000',
    equityMicros: '1000000',
    buyingPowerMicros: '1000000',
    accountBlocked: false,
    tradingBlocked: false,
    tradeSuspendedByUser: false,
    observedAt: '2026-07-20T00:00:00.000Z',
  },
  evidence: {
    requestId: 'broker-health-request',
    status: 200,
    contentHash: 'a'.repeat(64),
    observedAt: '2026-07-20T00:00:00.000Z',
  },
})

const brokerRead = (account: BrokerReadShape['account']): BrokerReadShape => {
  const unused = Effect.die(new Error('continuous broker health must only read the account'))
  return {
    account,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar: unusedMarketCalendar,
  }
}

const emptyCycleProjection = (): CycleOperationsProjection => ({
  current: null,
  last: null,
  unfinishedCycleCount: 0,
  authority: null,
  reconciliation: null,
  mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
})

const cycleObservability = (
  read: CycleObservabilityShape['read'] = () => Effect.succeed(emptyCycleProjection()),
): CycleObservabilityShape => ({ read })

describe('Bayn continuous health', () => {
  test('requires the configured broker account GET while keeping execution disabled under OBSERVE', async () => {
    let observedAccountId = brokerAccountId
    const broker: BrokerProbe = {
      read: brokerRead(Effect.sync(() => accountResult(observedAccountId))),
      expectedAccountId: brokerAccountId,
      executionEligible: false,
      executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
    }
    const initial = {
      ...readyState(),
      broker: initialState(broker).broker,
    }
    const state = await Effect.runPromise(Ref.make(initial))
    const dependencies = (
      effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability>,
    ) =>
      effect.pipe(
        Effect.provideService(MarketData, {
          check: Effect.succeed(makeSnapshot().manifest.finalizedSnapshot),
          inspect: Effect.die(new Error('health probes must not inspect sessions')),
          inspectCyclePublications: Effect.die(
            new Error('health probes must not inspect cycle publication candidates'),
          ),
          inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
          inspectSnapshotPublication: () =>
            Effect.die(new Error('health probes must not inspect bound cycle publications')),
          load: Effect.die(new Error('health probes must not load bars')),
        }),
        Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
        Effect.provideService(CycleObservability, cycleObservability()),
      )

    await Effect.runPromise(dependencies(probe(config, state, broker)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'READY',
      broker: {
        configured: true,
        expectedAccountId: brokerAccountId,
        accountId: brokerAccountId,
        accountBound: true,
        readAvailable: true,
        executionEligible: false,
        executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
        error: null,
      },
    })

    observedAccountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await Effect.runPromise(dependencies(probe(config, state, broker)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      broker: {
        accountId: observedAccountId,
        accountBound: false,
        readAvailable: true,
        error: `Alpaca account probe resolved ${observedAccountId}, expected ${brokerAccountId}`,
      },
      error: expect.stringContaining('broker: Alpaca account probe resolved'),
    })
  })

  test('degrades on a probe defect, preserves evidence, and recovers only after a complete success', async () => {
    const initial = readyState()
    const initialEvidence = initial.evidence
    if (initialEvidence === null) throw new Error('ready fixture must contain evidence')
    const state = await Effect.runPromise(Ref.make(initial))
    let signalAvailable = false
    let databaseAvailable = true
    let accountingChecks = 0
    const marketData: MarketDataService = {
      check: Effect.suspend(() =>
        signalAvailable
          ? Effect.succeed(makeSnapshot().manifest.finalizedSnapshot)
          : Effect.die(new Error('Signal connection defect')),
      ),
      inspect: Effect.die(new Error('health probes must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health probes must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health probes must not inspect bound cycle publications')),
      load: Effect.die(new Error('health probes must not load bars')),
    }
    const journal: JournalService = {
      post: () => Effect.die(new Error('health probes must not write TigerBeetle')),
      verifyAccount: () => Effect.die(new Error('health probes must not reconcile paper accounting')),
      check: Effect.die(new Error('a durable run must use checkRun')),
      checkRun: () => Effect.sync(() => void (accountingChecks += 1)),
      journalAndReconcile: () => Effect.die(new Error('health probes must not write TigerBeetle')),
    }
    const evidenceStore = {
      ...recoveringStore(initial),
      check: Effect.suspend(() => (databaseAvailable ? Effect.void : Effect.fail(new Error('database unavailable')))),
    }
    const dependencies = (
      effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability>,
    ) =>
      effect.pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, journal),
        Effect.provideService(EvidenceStore, evidenceStore),
        Effect.provideService(CycleObservability, cycleObservability()),
      )

    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      evidence: { evaluation: { runId: initialEvidence.evaluation.runId } },
      health: {
        sequence: 2,
        dependencies: {
          postgresql: { status: 'AVAILABLE' },
          signal: { status: 'UNAVAILABLE', error: 'Signal connection defect' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })

    signalAvailable = true
    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'READY',
      error: null,
      health: {
        sequence: 3,
        dependencies: {
          postgresql: { status: 'AVAILABLE' },
          signal: { status: 'AVAILABLE' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })

    databaseAvailable = false
    await Effect.runPromise(dependencies(probe(config, state)))
    expect(await Effect.runPromise(Ref.get(state))).toMatchObject({
      status: 'DEGRADED',
      health: {
        sequence: 4,
        dependencies: {
          postgresql: { status: 'UNAVAILABLE', error: expect.stringContaining('database unavailable') },
          signal: { status: 'AVAILABLE' },
          tigerBeetle: { status: 'AVAILABLE' },
          evidence: { status: 'AVAILABLE' },
        },
      },
    })
    expect(accountingChecks).toBe(3)
  })

  test('runs immediately and then on the configured Effect schedule', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    let checks = 0
    const marketData: MarketDataService = {
      check: Effect.sync(() => {
        checks += 1
        return makeSnapshot().manifest.finalizedSnapshot
      }),
      inspect: Effect.die(new Error('health monitor must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health monitor must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health monitor must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health monitor must not inspect bound cycle publications')),
      load: Effect.die(new Error('health monitor must not load bars')),
    }
    const journal: JournalService = { ...successfulJournal, checkRun: () => Effect.void }
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* monitor({ ...config, healthIntervalMs: 100 }, state).pipe(
          Effect.provideService(MarketData, marketData),
          Effect.provideService(Journal, journal),
          Effect.provideService(EvidenceStore, recoveringStore(initial)),
          Effect.provideService(CycleObservability, cycleObservability()),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.yieldNow
        expect(checks).toBe(1)
        yield* TestClock.adjust(99)
        expect(checks).toBe(1)
        yield* TestClock.adjust(1)
        expect(checks).toBe(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('interrupts an in-flight probe when its scope closes', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    const started = await Effect.runPromise(Deferred.make<void>())
    let interrupted = false
    const marketData: MarketDataService = {
      check: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
      ),
      inspect: Effect.die(new Error('health monitor must not inspect sessions')),
      inspectCyclePublications: Effect.die(new Error('health monitor must not inspect cycle publication candidates')),
      inspectPublication: () => Effect.die(new Error('health monitor must not inspect cycle publications')),
      inspectSnapshotPublication: () =>
        Effect.die(new Error('health monitor must not inspect bound cycle publications')),
      load: Effect.die(new Error('health monitor must not load bars')),
    }
    const fiber = Effect.runFork(
      monitor(config, state).pipe(
        Effect.provideService(MarketData, marketData),
        Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
        Effect.provideService(CycleObservability, cycleObservability()),
      ),
    )
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(interrupted).toBe(true)
  })

  test('treats the stall threshold as exclusive and clears only after a later terminal success', async () => {
    const initial = readyState()
    const state = await Effect.runPromise(Ref.make(initial))
    const pending = {
      cycleId: '1'.repeat(64),
      accountId: 'paper-account-1',
      signalSessionDate: '2026-07-17',
      executionSessionDate: '2026-07-20',
      phase: CycleState.Pending,
      snapshotId: '2'.repeat(64),
      decisionHash: null,
      terminalReason: null,
      submissionOpenAt: '2026-07-20T00:00:00.000Z',
      submissionCutoffAt: '2026-07-20T01:00:00.000Z',
      executionOpenAt: '2026-07-20T01:02:00.000Z',
      executionCloseAt: '2026-07-20T20:00:00.000Z',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      terminalAt: null,
    } as const
    let projection: CycleOperationsProjection = {
      ...emptyCycleProjection(),
      current: pending,
      unfinishedCycleCount: 1,
    }
    const dependencies = (
      effect: Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability>,
    ) =>
      effect.pipe(
        Effect.provideService(MarketData, {
          check: Effect.succeed(makeSnapshot().manifest.finalizedSnapshot),
          inspect: Effect.die(new Error('health probes must not inspect sessions')),
          inspectCyclePublications: Effect.die(
            new Error('health probes must not inspect cycle publication candidates'),
          ),
          inspectPublication: () => Effect.die(new Error('health probes must not inspect cycle publications')),
          inspectSnapshotPublication: () =>
            Effect.die(new Error('health probes must not inspect bound cycle publications')),
          load: Effect.die(new Error('health probes must not load bars')),
        }),
        Effect.provideService(Journal, { ...successfulJournal, checkRun: () => Effect.void }),
        Effect.provideService(EvidenceStore, recoveringStore(initial)),
        Effect.provideService(
          CycleObservability,
          cycleObservability(() => Effect.sync(() => projection)),
        ),
      )
    const thresholdConfig = { ...config, cycleStallThresholdMs: 300_000 }
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-07-20T00:04:59.999Z'))
      yield* dependencies(probe(thresholdConfig, state))
      expect(yield* Ref.get(state)).toMatchObject({
        status: 'READY',
        cycle: {
          condition: CycleOperationsCondition.Running,
          reason: CycleOperationsReason.AwaitingActivation,
          attemptAgeMs: 299_999,
          alerts: { cycleStalled: false, cycleFailed: false },
        },
      })

      yield* TestClock.adjust(1)
      yield* dependencies(probe(thresholdConfig, state))
      expect(yield* Ref.get(state)).toMatchObject({
        status: 'DEGRADED',
        cycle: {
          condition: CycleOperationsCondition.Stalled,
          reason: CycleOperationsReason.AttemptStale,
          attemptAgeMs: 300_000,
          alerts: { cycleStalled: true },
        },
      })

      projection = {
        ...emptyCycleProjection(),
        last: {
          ...pending,
          phase: CycleState.Completed,
          decisionHash: '3'.repeat(64),
          updatedAt: '2026-07-20T00:05:01.000Z',
          terminalAt: '2026-07-20T00:05:01.000Z',
        },
      }
      yield* TestClock.adjust(1_000)
      yield* dependencies(probe(thresholdConfig, state))
      expect(yield* Ref.get(state)).toMatchObject({
        status: 'READY',
        cycle: {
          condition: CycleOperationsCondition.Waiting,
          reason: CycleOperationsReason.LastCycleCompleted,
          alerts: { cycleStalled: false, cycleFailed: false },
        },
      })
    }).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })
})
