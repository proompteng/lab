import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Fiber, Logger, Option, References } from 'effect'
import { TestClock } from 'effect/testing'

import {
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
} from './broker/alpaca'
import {
  CycleState,
  CycleTerminalReason,
  makeCycleExecutionPolicy,
  type AutonomousCycle,
  type CycleDraft,
} from './cycle'
import {
  isMonthEndCycleDue,
  makeDueCycleDraft,
  marketCalendarQueryForPublications,
  marketCalendarQueryForSignal,
  runAutonomousCyclePass,
  selectNextExecutionSession,
  startAutonomousCycleLoop,
  type CycleCandidate,
  type CycleRunContext,
} from './cycle-runner'
import { CycleStore, type CycleAuthoritySlot, type CycleStoreShape } from './db/cycle-store'
import { canonicalHashV1, sha256 } from './hash'
import {
  MarketData,
  type FinalizedPublicationDiscovery,
  type MarketDataInspection,
  type MarketDataService,
} from './market-data'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type InputManifest, type IsoDate } from './types'

const signalCalendarVersion = 'signal-XNYS-2026-v1'
const snapshotId = 'd'.repeat(64)
const evidence = {
  requestId: 'calendar-request',
  status: 200,
  contentHash: 'c'.repeat(64),
  observedAt: '2026-01-30T21:01:00.000Z',
}

const executionPolicy = makeCycleExecutionPolicy({
  schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
  strategyExecutionModelHash: '3'.repeat(64),
  submissionWindowMs: 30 * 60 * 1_000,
  submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
})

const context = (accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): CycleRunContext => ({
  qualificationRunId: '1'.repeat(64),
  strategyProtocolHash: '2'.repeat(64),
  accountId,
  executionPolicy,
})

const signalSession = (sessionDate: IsoDate) => ({
  calendar_version: signalCalendarVersion,
  session_date: sessionDate,
  close_time: '16:00',
  timezone: 'America/New_York' as const,
})

const candidate = (
  sessionDate: IsoDate = '2026-01-30',
  accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
): CycleCandidate => ({
  ...context(accountId),
  signalSession: signalSession(sessionDate),
})

const calendar = (
  sessions: MarketCalendarObservation['sessions'],
  requestedRange: MarketCalendarObservation['requestedRange'] = {
    start: '2026-01-30',
    end: '2026-03-01',
  },
): MarketCalendarObservation => {
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange,
    timeZone: 'UTC' as const,
    sessions,
  }
  return { ...material, normalizedResponseHash: canonicalHashV1(material) }
}

const monthEndCalendar = calendar([
  {
    date: '2026-01-30',
    openAt: '2026-01-30T14:30:00.000Z',
    closeAt: '2026-01-30T21:00:00.000Z',
  },
  {
    date: '2026-02-02',
    openAt: '2026-02-02T14:30:00.000Z',
    closeAt: '2026-02-02T20:00:00.000Z',
  },
])

const brokerRead = (marketCalendar: BrokerReadShape['marketCalendar']): BrokerReadShape => {
  const unused = Effect.die(new Error('cycle runner must use only the broker calendar read'))
  return {
    account: unused,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar,
  }
}

const makeInputManifest = (
  sessionDate: IsoDate,
  finalizedAt = `${sessionDate}T21:15:00.000Z`,
  publicationSnapshotId = snapshotId,
): InputManifest => {
  const symbol = 'SPY'
  const finalizedSnapshot = {
    schemaVersion: 'bayn.finalized-snapshot.v3' as const,
    snapshotId: publicationSnapshotId,
    publicationId: '4'.repeat(64),
    publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
    universeId: 'cross-asset-taa-v1' as const,
    universeSymbolHash: sha256(symbol),
    source: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    calendarVersion: signalCalendarVersion,
    publisherSourceRevision: '5'.repeat(40),
    publisherImage: {
      repository: 'registry.example.com/signal-publisher',
      digest: `sha256:${'6'.repeat(64)}`,
    },
    finalizedAt,
    requestedStart: sessionDate,
    firstSession: sessionDate,
    lastSession: sessionDate,
    asOfSession: sessionDate,
    symbols: [symbol],
    rowCount: 1,
    sessionCount: 1,
    contentHash: '7'.repeat(64),
    sessionsContentHash: '8'.repeat(64),
  }
  const material: Omit<InputManifest, 'hash'> = {
    schemaVersion: 'bayn.input-manifest.v3',
    database: 'signal',
    tables: {
      bars: 'adjusted_daily_bars_v2',
      sessions: 'exchange_sessions_v1',
      manifests: 'snapshot_manifests_v2',
    },
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: sessionDate,
      dataEnd: sessionDate,
      lookbackStart: sessionDate,
      evaluationStart: sessionDate,
      evaluationEnd: sessionDate,
    },
    rowCount: 1,
    sessionCount: 1,
    firstSession: sessionDate,
    lastSession: sessionDate,
    symbols: [{ symbol, rows: 1, firstSession: sessionDate, lastSession: sessionDate }],
    finalizedSnapshot,
  }
  return { ...material, hash: canonicalHashV1(material) }
}

const finalizedPublicationInspection = (
  sessionDate: IsoDate = '2026-01-30',
  finalizedAt?: string,
  publicationSnapshotId?: string,
): MarketDataInspection => ({
  manifest: makeInputManifest(sessionDate, finalizedAt, publicationSnapshotId),
  sessionDates: [sessionDate],
  signalSession: signalSession(sessionDate),
})

const finalizedPublications = (
  publications: readonly MarketDataInspection[],
  observedAt = '2026-01-30T21:15:00.000Z',
): FinalizedPublicationDiscovery => ({
  outcome: 'FINALIZED',
  observedAt,
  publications,
})

const finalizedPublication = (
  sessionDate: IsoDate = '2026-01-30',
  finalizedAt?: string,
): FinalizedPublicationDiscovery =>
  finalizedPublications(
    [finalizedPublicationInspection(sessionDate, finalizedAt)],
    finalizedAt ?? `${sessionDate}T21:15:00.000Z`,
  )

const marketDataService = (
  inspectCyclePublications: MarketDataService['inspectCyclePublications'],
): MarketDataService => {
  const unused = Effect.die(new Error('cycle runner must inspect only bounded finalized publication candidates'))
  return {
    check: unused,
    inspect: unused,
    inspectCyclePublications,
    inspectPublication: () => unused,
    inspectSnapshotPublication: () => unused,
    load: unused,
  }
}

const cycleFrom = (draft: CycleDraft, observedAt: string): AutonomousCycle => {
  const missed = observedAt >= draft.window.publicationDeadlineAt
  return {
    ...draft,
    state: missed ? CycleState.Blocked : CycleState.Pending,
    bindings: {},
    ...(missed ? { terminalReason: CycleTerminalReason.MissedPublication, terminalAt: observedAt } : {}),
    stateVersion: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
  }
}

const slotKey = (slot: CycleAuthoritySlot): string =>
  `${slot.qualificationRunId}\u001f${slot.accountId}\u001f${slot.signalSessionDate}`

interface StoreControl {
  readonly acquisitions: Array<{ readonly draft: CycleDraft; readonly observedAt: string }>
  binds: number
}

const cycleStore = (control: StoreControl): CycleStoreShape => {
  const cycles = new Map<string, AutonomousCycle>()
  const slots = new Map<string, string>()
  const readCycle = (cycleId: string): AutonomousCycle | undefined => cycles.get(cycleId)
  const unused = () => Effect.die(new Error('cycle runner used an unexpected store operation'))
  return {
    acquire: (draft, observedAt) =>
      Effect.sync(() => {
        control.acquisitions.push({ draft, observedAt })
        const key = slotKey({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
          signalSessionDate: draft.identity.signalSessionDate,
        })
        const existingId = slots.get(key)
        if (existingId !== undefined) {
          const existing = readCycle(existingId)
          if (existing === undefined) throw new Error('test authority slot lost its cycle')
          return { cycle: existing, created: false }
        }
        const created = cycleFrom(draft, observedAt)
        cycles.set(draft.identity.cycleId, created)
        slots.set(key, draft.identity.cycleId)
        return { cycle: created, created: true }
      }),
    read: (cycleId) =>
      Effect.sync(() => {
        const cycle = readCycle(cycleId)
        return cycle === undefined ? Option.none() : Option.some(cycle)
      }),
    readAuthoritySlot: (slot) =>
      Effect.sync(() => {
        const cycleId = slots.get(slotKey(slot))
        if (cycleId === undefined) return Option.none()
        const cycle = readCycle(cycleId)
        return cycle === undefined ? Option.none() : Option.some(cycle)
      }),
    bindSnapshot: (cycleId, manifest, observedAt) =>
      Effect.sync(() => {
        control.binds += 1
        const cycle = readCycle(cycleId)
        if (cycle === undefined) throw new Error('test binding could not find the cycle')
        const existing = cycle.bindings.snapshotId
        if (existing !== undefined) {
          if (existing !== manifest.finalizedSnapshot.snapshotId) throw new Error('test store refused replacement')
          return { cycle, changed: false }
        }
        const updated = {
          ...cycle,
          bindings: { snapshotId: manifest.finalizedSnapshot.snapshotId },
          stateVersion: cycle.stateVersion + 1,
          updatedAt: observedAt,
        }
        cycles.set(cycleId, updated)
        return { cycle: updated, changed: true }
      }),
    activate: unused,
    bindDecision: unused,
    block: unused,
  }
}

const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  read: BrokerReadShape,
  store: CycleStoreShape,
  marketData: MarketDataService,
) =>
  effect.pipe(
    Effect.provideService(BrokerRead, read),
    Effect.provideService(CycleStore, store),
    Effect.provideService(MarketData, marketData),
  )

describe('autonomous cycle runner', () => {
  test('builds one bounded calendar query and selects the first session strictly after Signal', () => {
    const query = marketCalendarQueryForSignal('2026-01-30')
    const inclusiveDays =
      (Date.parse(`${query.end}T00:00:00.000Z`) - Date.parse(`${query.start}T00:00:00.000Z`)) / 86_400_000 + 1
    expect(query).toEqual({ start: '2026-01-30', end: '2026-03-01' })
    expect(inclusiveDays).toBe(31)

    const selected = selectNextExecutionSession(
      '2026-01-30',
      calendar([
        {
          date: '2026-02-03',
          openAt: '2026-02-03T14:30:00.000Z',
          closeAt: '2026-02-03T21:00:00.000Z',
        },
        {
          date: '2026-01-30',
          openAt: '2026-01-30T14:30:00.000Z',
          closeAt: '2026-01-30T21:00:00.000Z',
        },
        {
          date: '2026-02-02',
          openAt: '2026-02-02T14:30:00.000Z',
          closeAt: '2026-02-02T20:00:00.000Z',
        },
      ]),
    )
    expect(selected?.date).toBe('2026-02-02')
  })

  test('keeps month-end selection pure and cycle identity independent of calendar query evidence', () => {
    expect(isMonthEndCycleDue('2026-01-29', '2026-01-30')).toBe(false)
    expect(isMonthEndCycleDue('2026-01-30', '2026-02-02')).toBe(true)

    const selected = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (selected === undefined) throw new Error('month-end fixture must have an execution session')
    const first = makeDueCycleDraft(candidate(), monthEndCalendar, selected)
    const changedEvidence = calendar([selected], { start: '2026-01-31', end: '2026-02-10' })
    const second = makeDueCycleDraft(candidate(), changedEvidence, selected)
    expect(first?.identity.cycleId).toBe(second?.identity.cycleId)
    expect(first?.window).toMatchObject({
      signalCloseAt: '2026-01-30T21:00:00.000Z',
      publicationDeadlineAt: '2026-02-02T13:58:00.000Z',
      submissionOpenAt: '2026-02-02T13:58:00.000Z',
      submissionCutoffAt: '2026-02-02T14:28:00.000Z',
      executionOpenAt: '2026-02-02T14:30:00.000Z',
      executionCloseAt: '2026-02-02T20:00:00.000Z',
    })
  })

  test('does nothing when no finalized publication exists and never reads the broker', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const result = await Effect.runPromise(
      provide(
        runAutonomousCyclePass(context()),
        brokerRead(() => Effect.die(new Error('missing publication must not read the broker'))),
        cycleStore(control),
        marketDataService(Effect.succeed({ outcome: 'MISSING', observedAt: '2026-01-30T21:01:00.000Z' })),
      ),
    )

    expect(result).toEqual({ outcome: 'NO_PUBLICATION', observedAt: '2026-01-30T21:01:00.000Z' })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('uses one calendar read and does not acquire an ordinary terminal session', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const queries: MarketCalendarQuery[] = []
    const observation = calendar([
      {
        date: '2026-01-30',
        openAt: '2026-01-30T14:30:00.000Z',
        closeAt: '2026-01-30T18:00:00.000Z',
      },
    ])
    const read = brokerRead((query) => {
      queries.push(query)
      return Effect.succeed({ value: observation, evidence })
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
        return yield* provide(
          runAutonomousCyclePass(context()),
          read,
          cycleStore(control),
          marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({
      outcome: 'NOT_DUE',
      signalSessionDate: '2026-01-29',
      executionSessionDate: '2026-01-30',
    })
    expect(queries).toEqual([marketCalendarQueryForSignal('2026-01-29')])
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('catches an unacquired month-end publication hidden by a newer daily publication after downtime', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    const queries: MarketCalendarQuery[] = []
    const observation = calendar(
      [
        {
          date: '2026-01-30',
          openAt: '2026-01-30T14:30:00.000Z',
          closeAt: '2026-01-30T21:00:00.000Z',
        },
        {
          date: '2026-02-02',
          openAt: '2026-02-02T14:30:00.000Z',
          closeAt: '2026-02-02T21:00:00.000Z',
        },
        {
          date: '2026-02-03',
          openAt: '2026-02-03T14:30:00.000Z',
          closeAt: '2026-02-03T21:00:00.000Z',
        },
      ],
      { start: '2026-01-30', end: '2026-03-01' },
    )
    let calendarReads = 0
    const read = brokerRead((query) => {
      calendarReads += 1
      queries.push(query)
      return Effect.succeed({ value: observation, evidence })
    })
    const publications = [
      finalizedPublicationInspection('2026-02-02', '2026-02-02T21:15:00.000Z', 'e'.repeat(64)),
      finalizedPublicationInspection('2026-01-30', '2026-01-30T21:15:00.000Z'),
    ]
    const marketData = marketDataService(
      Effect.succeed(finalizedPublications(publications, '2026-02-02T21:15:00.000Z')),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-02-02T21:20:00.000Z'))
        const caughtUp = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        const restarted = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        return { caughtUp, restarted }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.caughtUp).toMatchObject({
      outcome: 'ACQUIRED',
      signalSessionDate: '2026-01-30',
      executionSessionDate: '2026-02-02',
      readiness: {
        outcome: 'BLOCKED',
        cycle: {
          state: CycleState.Blocked,
          terminalReason: CycleTerminalReason.MissedPublication,
          identity: { signalSessionDate: '2026-01-30' },
          bindings: {},
        },
      },
    })
    expect(result.restarted).toMatchObject({
      outcome: 'RESUMED',
      signalSessionDate: '2026-01-30',
      readiness: {
        outcome: 'BLOCKED',
        cycle: { identity: { cycleId: control.acquisitions[0]?.draft.identity.cycleId } },
      },
    })
    expect(queries).toEqual([marketCalendarQueryForPublications(publications)])
    expect(calendarReads).toBe(1)
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(0)
  })

  test('discovers, acquires, and atomically binds the manifest-authoritative month-end publication', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const queries: MarketCalendarQuery[] = []
    const read = brokerRead((query) => {
      queries.push(query)
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        return yield* provide(
          runAutonomousCyclePass(context()),
          read,
          cycleStore(control),
          marketDataService(Effect.succeed(finalizedPublication())),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({
      outcome: 'ACQUIRED',
      readiness: {
        outcome: 'BOUND',
        snapshotId,
        cycle: {
          state: CycleState.Pending,
          identity: {
            signalSessionDate: '2026-01-30',
            signalCalendarVersion,
            executionSessionDate: '2026-02-02',
          },
          bindings: { snapshotId },
        },
      },
    })
    expect(queries).toEqual([marketCalendarQueryForSignal('2026-01-30')])
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('persists a late publication as missed and never binds it at or after the exact deadline', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-02-02T13:58:00.000Z'))
        return yield* provide(
          runAutonomousCyclePass(context()),
          brokerRead(() => Effect.succeed({ value: monthEndCalendar, evidence })),
          cycleStore(control),
          marketDataService(Effect.succeed(finalizedPublication())),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({
      outcome: 'ACQUIRED',
      readiness: {
        outcome: 'BLOCKED',
        cycle: {
          state: CycleState.Blocked,
          terminalReason: CycleTerminalReason.MissedPublication,
          terminalAt: '2026-02-02T13:58:00.000Z',
        },
      },
    })
    expect(control.binds).toBe(0)
  })

  test('returns an existing authority slot on restart without a second calendar read or duplicate binding', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const marketData = marketDataService(Effect.succeed(finalizedPublication()))

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const first = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        yield* TestClock.setTime(Date.parse('2026-01-30T21:21:00.000Z'))
        const restarted = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        return { first, restarted }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(results.first.outcome).toBe('ACQUIRED')
    expect(results.restarted).toMatchObject({
      outcome: 'ALREADY_ACQUIRED',
      cycle: { bindings: { snapshotId } },
    })
    expect(calendarReads).toBe(1)
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('resumes the exact bind after a crash immediately following durable acquisition', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    const crashAfterAcquire: CycleStoreShape = {
      ...store,
      bindSnapshot: () => Effect.die(new Error('injected crash after durable acquisition')),
    }
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const marketData = marketDataService(Effect.succeed(finalizedPublication()))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const crashed = yield* Effect.exit(
          provide(runAutonomousCyclePass(context()), read, crashAfterAcquire, marketData),
        )
        yield* TestClock.setTime(Date.parse('2026-01-30T21:21:00.000Z'))
        const resumed = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        return { crashed, resumed }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.crashed._tag).toBe('Failure')
    expect(result.resumed).toMatchObject({
      outcome: 'RESUMED',
      readiness: {
        outcome: 'BOUND',
        snapshotId,
        cycle: { bindings: { snapshotId } },
      },
    })
    expect(calendarReads).toBe(1)
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('fails typed when the bounded calendar has no future session or BrokerRead rejects drift', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    const marketData = marketDataService(Effect.succeed(finalizedPublication()))
    const missing = await Effect.runPromise(
      Effect.flip(
        provide(
          runAutonomousCyclePass(context()),
          brokerRead(() => Effect.succeed({ value: calendar([]), evidence })),
          store,
          marketData,
        ),
      ),
    )
    expect(missing).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'select-session',
      failure: 'calendar-unavailable',
    })

    const drift = new BrokerReadError({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      message: 'injected normalized response drift',
      retryable: false,
    })
    const invalid = await Effect.runPromise(
      Effect.flip(
        provide(
          runAutonomousCyclePass(context()),
          brokerRead(() => Effect.fail(drift)),
          store,
          marketData,
        ),
      ),
    )
    expect(invalid).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'market-calendar',
      failure: 'calendar-read',
      cause: drift,
    })
    expect(control.acquisitions).toEqual([])
  })

  test('runs immediately, repeats on Schedule.spaced, and avoids duplicate work after acquisition', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const fiber = yield* provide(
          startAutonomousCycleLoop({
            context: Effect.succeed(context()),
            pollIntervalMs: 100,
          }),
          read,
          store,
          marketDataService(Effect.succeed(finalizedPublication())),
        )
        yield* Effect.yieldNow
        expect(control.acquisitions).toHaveLength(1)
        yield* TestClock.adjust(99)
        expect(control.acquisitions).toHaveLength(1)
        yield* TestClock.adjust(1)
        expect(control.acquisitions).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(calendarReads).toBe(1)
    expect(control.binds).toBe(1)
  })

  test('scope closure interrupts in-flight publication discovery', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    let interrupted = false
    const latest = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
    )
    const control: StoreControl = { acquisitions: [], binds: 0 }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* provide(
            startAutonomousCycleLoop({
              context: Effect.succeed(context()),
              pollIntervalMs: 100,
            }),
            brokerRead(() => Effect.die(new Error('in-flight publication read must not reach the broker'))),
            cycleStore(control),
            marketDataService(latest),
          )
          yield* Deferred.await(started)
        }),
      ),
    )
    expect(interrupted).toBe(true)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('logs a failed pass and runs the next scheduled pass without killing the scoped loop', async () => {
    const contextFailure = new Error('qualification context unavailable')
    const control: StoreControl = { acquisitions: [], binds: 0 }
    let contextLoads = 0
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const logger = Logger.make<unknown, void>((options) => {
      logs.push({
        message: options.message,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      })
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const fiber = yield* provide(
          startAutonomousCycleLoop({
            context: Effect.suspend(() => {
              contextLoads += 1
              return contextLoads === 1 ? Effect.fail(contextFailure) : Effect.succeed(context())
            }),
            pollIntervalMs: 100,
          }),
          brokerRead(() => Effect.succeed({ value: monthEndCalendar, evidence })),
          cycleStore(control),
          marketDataService(Effect.succeed(finalizedPublication())),
        )
        yield* Effect.yieldNow
        expect(contextLoads).toBe(1)
        expect(control.acquisitions).toEqual([])
        yield* TestClock.adjust(100)
        expect(contextLoads).toBe(2)
        expect(control.acquisitions).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(Logger.layer([logger])), Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(
      logs.some(
        (entry) =>
          Array.isArray(entry.message) &&
          entry.message.includes('Bayn autonomous cycle pass failed') &&
          entry.annotations.operation === 'load-context' &&
          entry.annotations.failure === 'context',
      ),
    ).toBe(true)
    expect(control.binds).toBe(1)
  })

  test('keeps repeated context failures scoped and interruptible without touching discovery or the broker', async () => {
    const contextFailure = new Error('qualification context unavailable')
    const control: StoreControl = { acquisitions: [], binds: 0 }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provide(
            startAutonomousCycleLoop({
              context: Effect.fail(contextFailure),
              pollIntervalMs: 100,
            }),
            brokerRead(() => Effect.die(new Error('failed context must not read the broker'))),
            cycleStore(control),
            marketDataService(Effect.die(new Error('failed context must not inspect finalized publications'))),
          )
          yield* Effect.yieldNow
          return yield* Fiber.interrupt(fiber)
        }),
      ),
    )
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('rejects invalid loop intervals before starting discovery', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    for (const pollIntervalMs of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          Effect.scoped(
            provide(
              startAutonomousCycleLoop({
                context: Effect.succeed(context()),
                pollIntervalMs,
              }),
              brokerRead(() => Effect.die(new Error('invalid config must not read the broker'))),
              cycleStore(control),
              marketDataService(Effect.die(new Error('invalid config must not inspect publications'))),
            ),
          ),
        ),
      )
      expect(failure).toMatchObject({
        _tag: 'CycleRunnerError',
        operation: 'configure',
        failure: 'invalid-config',
      })
    }
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })
})
