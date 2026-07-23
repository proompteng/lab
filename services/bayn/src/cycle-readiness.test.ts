import { describe, expect, test } from 'bun:test'

import { Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'

import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
} from './cycle'
import { measurePublicationFreshness, runCyclePublicationReadiness } from './cycle-readiness'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import { operationalError } from './errors'
import { canonicalHashV1, sha256 } from './hash'
import { MarketData, type FinalizedPublicationInspection, type MarketDataService } from './market-data'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type InputManifest } from './types'

const signalCalendarVersion = 'signal-XNYS-2026-v1'
const snapshotId = 'd'.repeat(64)

const executionPolicy = makeCycleExecutionPolicy({
  schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
  strategyExecutionModelHash: '3'.repeat(64),
  submissionWindowMs: 30 * 60 * 1_000,
  submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
})

const makeCycle = (): AutonomousCycle => {
  const signalSession = {
    calendar_version: signalCalendarVersion,
    session_date: '2026-01-30' as const,
    close_time: '16:00',
    timezone: 'America/New_York' as const,
  }
  const executionCalendar = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: '2026-02-02',
    openAt: '2026-02-02T14:30:00.000Z',
    closeAt: '2026-02-02T21:00:00.000Z',
  })
  const identity = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: '1'.repeat(64),
    strategyProtocolHash: '2'.repeat(64),
    accountId: 'paper-account',
    signalSessionDate: signalSession.session_date,
    signalCalendarVersion,
    executionSessionDate: executionCalendar.executionSessionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  const draft = makeCycleDraft(identity, makeCycleWindow(signalSession, executionCalendar, executionPolicy))
  return {
    ...draft,
    state: CycleState.Pending,
    bindings: {},
    stateVersion: 1,
    createdAt: '2026-01-30T20:00:00.000Z',
    updatedAt: '2026-01-30T20:00:00.000Z',
  }
}

const makeInputManifest = (finalizedAt = '2026-01-30T21:15:00.000Z'): InputManifest => {
  const symbol = 'SPY'
  const finalizedSnapshot = {
    schemaVersion: 'bayn.finalized-snapshot.v3' as const,
    snapshotId,
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
    requestedStart: '2026-01-30' as const,
    firstSession: '2026-01-30' as const,
    lastSession: '2026-01-30' as const,
    asOfSession: '2026-01-30' as const,
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
      dataStart: '2026-01-30',
      dataEnd: '2026-01-30',
      lookbackStart: '2026-01-30',
      evaluationStart: '2026-01-30',
      evaluationEnd: '2026-01-30',
    },
    rowCount: 1,
    sessionCount: 1,
    firstSession: '2026-01-30',
    lastSession: '2026-01-30',
    symbols: [
      {
        symbol,
        rows: 1,
        firstSession: '2026-01-30',
        lastSession: '2026-01-30',
      },
    ],
    finalizedSnapshot,
  }
  return { ...material, hash: canonicalHashV1(material) }
}

const finalizedPublication = (manifest = makeInputManifest()): FinalizedPublicationInspection => ({
  outcome: 'FINALIZED',
  observedAt: '2026-01-30T21:20:00.000Z',
  inspection: {
    manifest,
    sessionDates: ['2026-01-30'],
    signalSession: {
      calendar_version: signalCalendarVersion,
      session_date: '2026-01-30',
      close_time: '16:00',
      timezone: 'America/New_York',
    },
  },
})

const marketDataService = (
  inspectPublication: MarketDataService['inspectPublication'],
  inspectSnapshotPublication: MarketDataService['inspectSnapshotPublication'] = (input) => inspectPublication(input),
): MarketDataService => {
  const unused = Effect.die(new Error('cycle readiness must only inspect the exact finalized publication'))
  return {
    check: unused,
    inspect: unused,
    inspectCyclePublications: unused,
    inspectPublication,
    inspectSnapshotPublication,
    loadSnapshotPublication: () => unused,
    load: unused,
  }
}

interface StoreControl {
  current: AutonomousCycle
  binds: number
  blocks: number
}

const cycleStore = (control: StoreControl): CycleStoreShape => {
  const unused = () => Effect.die(new Error('cycle readiness used an unexpected store operation'))
  return {
    acquire: unused,
    read: () => Effect.succeed(Option.some(control.current)),
    readAuthoritySlot: unused,
    readDecisionDocument: unused,
    readOldestUnfinished: unused,
    bindSnapshot: (_cycleId, inputManifest, observedAt) =>
      Effect.sync(() => {
        control.binds += 1
        const existing = control.current.bindings.snapshotId
        if (existing === undefined) {
          control.current = {
            ...control.current,
            bindings: { snapshotId: inputManifest.finalizedSnapshot.snapshotId },
            stateVersion: control.current.stateVersion + 1,
            updatedAt: observedAt,
          }
          return { cycle: control.current, changed: true }
        }
        if (existing !== inputManifest.finalizedSnapshot.snapshotId) {
          throw new Error('test store refused snapshot replacement')
        }
        return { cycle: control.current, changed: false }
      }),
    activate: unused,
    bindDecision: unused,
    finish: unused,
    block: (_cycleId, reason, observedAt) =>
      Effect.sync(() => {
        control.blocks += 1
        control.current = {
          ...control.current,
          state: CycleState.Blocked,
          terminalReason: reason,
          stateVersion: control.current.stateVersion + 1,
          updatedAt: observedAt,
          terminalAt: observedAt,
        }
        return { cycle: control.current, changed: true }
      }),
  }
}

const provide = (
  cycle: AutonomousCycle,
  inspectPublication: MarketDataService['inspectPublication'],
  control: StoreControl,
  inspectSnapshotPublication?: MarketDataService['inspectSnapshotPublication'],
) =>
  runCyclePublicationReadiness(cycle).pipe(
    Effect.provideService(MarketData, marketDataService(inspectPublication, inspectSnapshotPublication)),
    Effect.provideService(CycleStore, cycleStore(control)),
  )

describe('autonomous cycle finalized-publication readiness', () => {
  test('waits before Signal close without reading publication data', async () => {
    const cycle = makeCycle()
    const control: StoreControl = { current: cycle, binds: 0, blocks: 0 }
    let inspections = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T20:59:59.999Z'))
        return yield* provide(
          cycle,
          () =>
            Effect.sync(() => {
              inspections += 1
              return finalizedPublication()
            }),
          control,
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({ outcome: 'WAITING', reason: 'SIGNAL_SESSION_OPEN' })
    expect(inspections).toBe(0)
    expect(control).toMatchObject({ binds: 0, blocks: 0 })
  })

  test('survives a missing publication and binds the delayed exact snapshot on restart', async () => {
    const cycle = makeCycle()
    const control: StoreControl = { current: cycle, binds: 0, blocks: 0 }
    let finalized = false
    const inspect = () =>
      Effect.succeed(
        finalized ? finalizedPublication() : ({ outcome: 'MISSING', observedAt: '2026-01-30T21:01:00.000Z' } as const),
      )
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:01:00.000Z'))
        const waiting = yield* provide(control.current, inspect, control)
        finalized = true
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const bound = yield* provide(control.current, inspect, control)
        return { bound, waiting }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(results.waiting).toMatchObject({ outcome: 'WAITING', reason: 'PUBLICATION_MISSING' })
    expect(results.bound).toMatchObject({
      outcome: 'BOUND',
      snapshotId,
      freshness: {
        dataAgeMs: 5 * 60 * 1_000,
        publicationDelayMs: 15 * 60 * 1_000,
      },
    })
    expect(control).toMatchObject({ binds: 1, blocks: 0 })
  })

  test('blocks at the exact deadline without inspecting Signal or binding a snapshot', async () => {
    const cycle = makeCycle()
    const control: StoreControl = { current: cycle, binds: 0, blocks: 0 }
    let inspections = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(cycle.window.publicationDeadlineAt))
        return yield* provide(
          cycle,
          () =>
            Effect.sync(() => {
              inspections += 1
              return finalizedPublication()
            }),
          control,
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({
      outcome: 'BLOCKED',
      cycle: {
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
        terminalAt: cycle.window.publicationDeadlineAt,
      },
    })
    expect(inspections).toBe(0)
    expect(control).toMatchObject({ binds: 0, blocks: 1 })
  })

  test('blocks an invalid inspection that crosses the deadline and never binds its data', async () => {
    const cycle = makeCycle()
    const control: StoreControl = { current: cycle, binds: 0, blocks: 0 }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(cycle.window.publicationDeadlineAt) - 1)
        return yield* provide(
          cycle,
          () =>
            TestClock.setTime(Date.parse(cycle.window.publicationDeadlineAt)).pipe(
              Effect.andThen(
                Effect.fail(operationalError('market-data', 'inspect-publication', 'mutated finalized manifest')),
              ),
            ),
          control,
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({
      outcome: 'BLOCKED',
      cycle: {
        terminalReason: CycleTerminalReason.MissedPublication,
      },
    })
    expect(control).toMatchObject({ binds: 0, blocks: 1 })
  })

  test('fails invalid freshness before the deadline and refuses to replace an existing binding', async () => {
    const cycle = makeCycle()
    const control: StoreControl = { current: cycle, binds: 0, blocks: 0 }
    const invalid = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        return yield* Effect.flip(
          provide(
            cycle,
            () => Effect.succeed(finalizedPublication(makeInputManifest('2026-01-30T20:59:00.000Z'))),
            control,
          ),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(invalid).toMatchObject({
      _tag: 'CycleReadinessError',
      operation: 'measure-freshness',
      failure: 'contract',
    })
    expect(control).toMatchObject({ binds: 0, blocks: 0 })
    const publication = finalizedPublication()
    if (publication.outcome !== 'FINALIZED') throw new Error('finalized fixture must contain an inspection')
    expect(() =>
      measurePublicationFreshness(
        cycle,
        {
          ...publication.inspection,
          signalSession: { ...publication.inspection.signalSession, close_time: '13:00' },
        },
        '2026-01-30T21:20:00.000Z',
      ),
    ).toThrow('verified Signal session material does not match the cycle window')

    const boundCycle: AutonomousCycle = {
      ...cycle,
      bindings: { snapshotId },
      stateVersion: 2,
      updatedAt: '2026-01-30T21:20:00.000Z',
    }
    control.current = boundCycle
    const inspectedSnapshotIds: string[] = []
    const unexpectedSessionLookup = () =>
      Effect.die(new Error('bound readiness must not rediscover publications by session and calendar'))
    const rebound = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:21:00.000Z'))
        return yield* provide(boundCycle, unexpectedSessionLookup, control, (request) =>
          Effect.sync(() => {
            inspectedSnapshotIds.push(request.snapshotId)
            return finalizedPublication()
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(rebound).toMatchObject({
      outcome: 'ALREADY_BOUND',
      snapshotId,
      freshness: {
        dataAgeMs: 6 * 60 * 1_000,
        publicationDelayMs: 15 * 60 * 1_000,
      },
    })
    const replacement = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:22:00.000Z'))
        return yield* Effect.flip(
          provide(boundCycle, unexpectedSessionLookup, control, (request) =>
            Effect.sync(() => {
              inspectedSnapshotIds.push(request.snapshotId)
              const manifest = makeInputManifest()
              return finalizedPublication({
                ...manifest,
                finalizedSnapshot: {
                  ...manifest.finalizedSnapshot,
                  snapshotId: 'e'.repeat(64),
                },
              })
            }),
          ),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(replacement).toMatchObject({
      _tag: 'CycleReadinessError',
      operation: 'inspect-publication',
      failure: 'contract',
    })
    expect(inspectedSnapshotIds).toEqual([snapshotId, snapshotId])
    expect(control.binds).toBe(0)
  })
})
