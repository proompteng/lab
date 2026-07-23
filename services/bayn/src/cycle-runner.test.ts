import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Fiber, Logger, Option, References } from 'effect'
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
  type CyclePassObservation,
  type CycleRunContext,
} from './cycle-runner'
import { selectCycleRecovery, type CycleRecoveryState } from './cycle-recovery'
import { CycleStore, type CycleAuthoritySlot, type CycleStoreShape } from './db/cycle-store'
import { canonicalHashV1, sha256 } from './hash'
import {
  MarketData,
  type FinalizedPublicationDiscovery,
  type MarketDataInspection,
  type MarketDataService,
} from './market-data'
import { makeObserveShadowDecisionDocument, type ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from './target-planner'
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

const context = (
  accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  buildDecision: CycleRunContext['buildDecision'] = () =>
    Effect.die(new Error('cycle runner built an unexpected decision')),
): CycleRunContext => ({
  qualificationRunId: '1'.repeat(64),
  strategyProtocolHash: '2'.repeat(64),
  accountId,
  executionPolicy,
  buildDecision,
})

const ignorePass = () => Effect.void

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
  exactPublication?: MarketDataInspection,
): MarketDataService => {
  const unused = Effect.die(new Error('cycle runner must inspect only bounded finalized publication candidates'))
  const inspectExactPublication = () =>
    exactPublication === undefined
      ? unused
      : Effect.succeed({
          outcome: 'FINALIZED' as const,
          observedAt: exactPublication.manifest.finalizedSnapshot.finalizedAt,
          inspection: exactPublication,
        })
  return {
    check: unused,
    inspect: unused,
    inspectCyclePublications,
    inspectPublication: inspectExactPublication,
    inspectSnapshotPublication: inspectExactPublication,
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

const makeDecision = (
  cycle: AutonomousCycle,
  createdAt: string,
  blockedReason?: Exclude<TargetPlanReason, TargetPlanReason.TargetsSatisfied>,
): ObserveShadowDecisionDocument => {
  const targetPlanMaterial = {
    schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    inputHash: '4'.repeat(64),
    status: blockedReason === undefined ? TargetPlanStatus.NoTrade : TargetPlanStatus.Blocked,
    reason: blockedReason ?? TargetPlanReason.TargetsSatisfied,
    targets: [],
    intentTargets: [],
    requiredReferenceBuyNotionalMicros: '0',
    availableBuyingPowerMicros: '0',
    residualBuyingPowerMicros: '0',
  }
  const snapshot = cycle.bindings.snapshotId
  if (snapshot === undefined) throw new Error('shadow decision fixture requires a bound snapshot')
  return makeObserveShadowDecisionDocument({
    schemaVersion: 'bayn.observe-shadow-decision.v1',
    mode: 'OBSERVE',
    dispatchable: false,
    bindings: {
      strategyName: cycle.identity.strategyName,
      cycleId: cycle.identity.cycleId,
      strategyProtocolHash: cycle.identity.strategyProtocolHash,
      snapshotId: snapshot,
      snapshotContentHash: '5'.repeat(64),
      snapshotFinalizedAt: cycle.window.signalCloseAt,
      strategyDecisionHash: '6'.repeat(64),
      policyHash: '7'.repeat(64),
      accountId: cycle.identity.accountId,
      planningBrokerStateHash: '8'.repeat(64),
      reconciliationId: '9'.repeat(64),
      reconciliationHash: 'a'.repeat(64),
    },
    targetPlan: {
      ...targetPlanMaterial,
      outputHash: canonicalHashV1(targetPlanMaterial),
    },
    deltaRisk: [],
    createdAt,
    submissionCutoffAt: cycle.window.submissionCutoffAt,
    expiresAt: cycle.window.submissionCutoffAt,
  })
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
  const documents = new Map<string, ObserveShadowDecisionDocument>()
  const readCycle = (cycleId: string): AutonomousCycle | undefined => cycles.get(cycleId)
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
    readDecisionDocument: (cycleId) =>
      Effect.sync(() => {
        const document = documents.get(cycleId)
        return document === undefined ? Option.none() : Option.some(document)
      }),
    readOldestUnfinished: (scope) =>
      Effect.sync(() => {
        const oldest = [...cycles.values()]
          .filter(
            (cycle) =>
              cycle.identity.qualificationRunId === scope.qualificationRunId &&
              cycle.identity.accountId === scope.accountId &&
              (cycle.state === CycleState.Pending || cycle.state === CycleState.Active),
          )
          .sort((left, right) => {
            const session = left.identity.signalSessionDate.localeCompare(right.identity.signalSessionDate)
            return session === 0 ? left.identity.cycleId.localeCompare(right.identity.cycleId) : session
          })[0]
        return oldest === undefined ? Option.none() : Option.some(oldest)
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
    activate: (cycleId, observedAt) =>
      Effect.sync(() => {
        const cycle = readCycle(cycleId)
        if (cycle === undefined) throw new Error('test activation could not find the cycle')
        if (cycle.state === CycleState.Active) return { cycle, changed: false }
        if (cycle.state !== CycleState.Pending || cycle.bindings.snapshotId === undefined) {
          throw new Error('test activation requires a snapshot-bound pending cycle')
        }
        if (observedAt >= cycle.window.submissionCutoffAt) {
          const blocked = {
            ...cycle,
            state: CycleState.Blocked,
            terminalReason: CycleTerminalReason.MissedSubmission,
            stateVersion: cycle.stateVersion + 1,
            updatedAt: observedAt,
            terminalAt: observedAt,
          }
          cycles.set(cycleId, blocked)
          return { cycle: blocked, changed: true }
        }
        const active = {
          ...cycle,
          state: CycleState.Active,
          stateVersion: cycle.stateVersion + 1,
          updatedAt: observedAt,
        }
        cycles.set(cycleId, active)
        return { cycle: active, changed: true }
      }),
    bindDecision: (cycleId, document, observedAt) =>
      Effect.sync(() => {
        const cycle = readCycle(cycleId)
        if (cycle === undefined) throw new Error('test decision binding could not find the cycle')
        if (cycle.bindings.decisionHash !== undefined) {
          if (cycle.bindings.decisionHash !== document.contentHash) {
            throw new Error('test store refused decision replacement')
          }
          return { cycle, changed: false }
        }
        if (cycle.state !== CycleState.Active) throw new Error('test decision binding requires an active cycle')
        if (observedAt >= cycle.window.submissionCutoffAt) {
          const blocked = {
            ...cycle,
            state: CycleState.Blocked,
            terminalReason: CycleTerminalReason.MissedSubmission,
            stateVersion: cycle.stateVersion + 1,
            updatedAt: observedAt,
            terminalAt: observedAt,
          }
          cycles.set(cycleId, blocked)
          return { cycle: blocked, changed: true }
        }
        const updated = {
          ...cycle,
          bindings: { ...cycle.bindings, decisionHash: document.contentHash },
          stateVersion: cycle.stateVersion + 1,
          updatedAt: observedAt,
        }
        documents.set(cycleId, document)
        cycles.set(cycleId, updated)
        return { cycle: updated, changed: true }
      }),
    finish: (cycleId, state, observedAt) =>
      Effect.sync(() => {
        const cycle = readCycle(cycleId)
        if (cycle === undefined) throw new Error('test cycle finish could not find the cycle')
        if (cycle.state === state) return { cycle, changed: false }
        if (cycle.state !== CycleState.Active || cycle.bindings.decisionHash === undefined) {
          throw new Error('test cycle finish requires a decision-bound active cycle')
        }
        const finished = {
          ...cycle,
          state,
          stateVersion: cycle.stateVersion + 1,
          updatedAt: observedAt,
          terminalAt: observedAt,
        }
        cycles.set(cycleId, finished)
        return { cycle: finished, changed: true }
      }),
    block: (cycleId, reason, observedAt) =>
      Effect.sync(() => {
        const cycle = readCycle(cycleId)
        if (cycle === undefined) throw new Error('test blocking could not find the cycle')
        if (cycle.state === CycleState.Blocked && cycle.terminalReason === reason) {
          return { cycle, changed: false }
        }
        const blocked = {
          ...cycle,
          state: CycleState.Blocked,
          terminalReason: reason,
          stateVersion: cycle.stateVersion + 1,
          updatedAt: observedAt,
          terminalAt: observedAt,
        }
        cycles.set(cycleId, blocked)
        return { cycle: blocked, changed: true }
      }),
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

const recoveryState = (
  cycle: AutonomousCycle | undefined,
  overrides: Partial<Omit<CycleRecoveryState, 'cycle'>> = {},
): CycleRecoveryState => ({
  qualificationRunId: context().qualificationRunId,
  accountId: context().accountId,
  strategyProtocolHash: context().strategyProtocolHash,
  observedAt: '2026-01-30T21:23:00.000Z',
  cycle,
  ...overrides,
})

describe('autonomous cycle runner', () => {
  test('selects recovery from durable cycle state and publication readiness without effects', () => {
    const executionSession = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (executionSession === undefined) throw new Error('recovery fixture requires an execution session')
    const draft = makeDueCycleDraft(candidate(), monthEndCalendar, executionSession)
    if (draft === undefined) throw new Error('recovery fixture requires a due cycle')
    const pending = cycleFrom(draft, '2026-01-30T21:20:00.000Z')
    const bound: AutonomousCycle = {
      ...pending,
      bindings: { snapshotId },
      stateVersion: pending.stateVersion + 1,
      updatedAt: '2026-01-30T21:21:00.000Z',
    }
    const active: AutonomousCycle = {
      ...bound,
      state: CycleState.Active,
      stateVersion: bound.stateVersion + 1,
      updatedAt: '2026-01-30T21:22:00.000Z',
    }

    expect(selectCycleRecovery(recoveryState(undefined))).toEqual({ action: 'DISCOVER' })
    expect(selectCycleRecovery(recoveryState(pending))).toEqual({ action: 'READ_PUBLICATION', cycle: pending })
    expect(
      selectCycleRecovery(
        recoveryState(pending, {
          readiness: {
            outcome: 'WAITING',
            reason: 'PUBLICATION_MISSING',
            observedAt: '2026-01-30T21:21:00.000Z',
            cycle: pending,
          },
        }),
      ),
    ).toMatchObject({ action: 'RETURN_READINESS', recoveryAction: 'WAITING' })
    expect(
      selectCycleRecovery(
        recoveryState(pending, {
          readiness: {
            outcome: 'BOUND',
            observedAt: bound.updatedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      ),
    ).toMatchObject({ action: 'RETURN_READINESS', recoveryAction: 'BOUND_SNAPSHOT' })
    expect(
      selectCycleRecovery(
        recoveryState(bound, {
          readiness: {
            outcome: 'ALREADY_BOUND',
            observedAt: bound.updatedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      ),
    ).toEqual({ action: 'ACTIVATE', cycleId: bound.identity.cycleId, observedAt: bound.updatedAt })
    expect(selectCycleRecovery(recoveryState(active))).toEqual({ action: 'BUILD_DECISION', cycle: active })
    expect(() =>
      selectCycleRecovery(
        recoveryState({
          ...pending,
          state: CycleState.Blocked,
          terminalReason: CycleTerminalReason.MissedPublication,
          terminalAt: pending.updatedAt,
        }),
      ),
    ).toThrow('terminal cycles must not enter autonomous recovery')

    const decision = makeDecision(active, '2026-01-30T21:23:30.000Z')
    const decisionBound: AutonomousCycle = {
      ...active,
      bindings: { ...active.bindings, decisionHash: decision.contentHash },
      stateVersion: active.stateVersion + 1,
      updatedAt: '2026-01-30T21:24:00.000Z',
    }
    const afterCutoff = new Date(Date.parse(active.window.submissionCutoffAt) + 1).toISOString()
    expect(
      selectCycleRecovery(
        recoveryState(decisionBound, {
          strategyProtocolHash: 'f'.repeat(64),
          observedAt: afterCutoff,
        }),
      ),
    ).toEqual({ action: 'READ_DECISION', cycle: decisionBound })
    expect(
      selectCycleRecovery(
        recoveryState(decisionBound, {
          strategyProtocolHash: 'f'.repeat(64),
          observedAt: afterCutoff,
          decisionDocument: decision,
        }),
      ),
    ).toEqual({
      action: 'FINISH',
      cycleId: decisionBound.identity.cycleId,
      observedAt: afterCutoff,
      state: CycleState.NoTrade,
    })

    const blockedDecision = makeDecision(active, decision.createdAt, TargetPlanReason.InputStale)
    const blockedDecisionBound: AutonomousCycle = {
      ...decisionBound,
      bindings: { ...active.bindings, decisionHash: blockedDecision.contentHash },
    }
    expect(
      selectCycleRecovery(
        recoveryState(blockedDecisionBound, {
          strategyProtocolHash: 'f'.repeat(64),
          observedAt: afterCutoff,
          decisionDocument: blockedDecision,
        }),
      ),
    ).toEqual({
      action: 'BLOCK',
      cycleId: blockedDecisionBound.identity.cycleId,
      observedAt: afterCutoff,
      reason: CycleTerminalReason.DataStale,
    })
  })

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
      outcome: 'NOT_DUE',
      signalSessionDate: '2026-02-02',
      executionSessionDate: '2026-02-03',
    })
    expect(queries).toEqual([
      marketCalendarQueryForPublications(publications),
      marketCalendarQueryForSignal('2026-02-02'),
    ])
    expect(calendarReads).toBe(2)
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
          marketDataService(Effect.succeed(finalizedPublication()), finalizedPublicationInspection()),
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
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const marketData = marketDataService(Effect.succeed(finalizedPublication()))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-02-02T13:58:00.000Z'))
        const acquired = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        const restarted = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        return { acquired, restarted }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.acquired).toMatchObject({
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
    expect(result.restarted).toMatchObject({
      outcome: 'ALREADY_TERMINAL',
      signalSessionDate: '2026-01-30',
      cycle: {
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
      },
    })
    expect(calendarReads).toBe(1)
    expect(control.binds).toBe(0)
  })

  test('reinspects and activates a bound cycle on restart before any new discovery', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const inspection = finalizedPublicationInspection()
    const marketData = marketDataService(Effect.succeed(finalizedPublication()), inspection)

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
      outcome: 'RECOVERED',
      action: 'ACTIVATED',
      cycle: { state: CycleState.Active, bindings: { snapshotId } },
    })
    expect(calendarReads).toBe(1)
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('finishes an exact pre-cutoff decision after cutoff and a runtime protocol change', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const inspection = finalizedPublicationInspection()
    const marketData = marketDataService(Effect.succeed(finalizedPublication()), inspection)
    const decisionAt = '2026-02-02T14:20:00.000Z'
    const afterCutoff = '2026-02-02T14:29:00.000Z'

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const acquired = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        yield* TestClock.setTime(Date.parse('2026-01-30T21:21:00.000Z'))
        const activated = yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        yield* TestClock.setTime(Date.parse(decisionAt))
        const decisionBound = yield* provide(
          runAutonomousCyclePass(context(undefined, (cycle) => Effect.succeed(makeDecision(cycle, decisionAt)))),
          read,
          store,
          marketData,
        )
        yield* TestClock.setTime(Date.parse(afterCutoff))
        const changedProtocol = {
          ...context(),
          strategyProtocolHash: 'f'.repeat(64),
        }
        const recovered = yield* provide(runAutonomousCyclePass(changedProtocol), read, store, marketData)
        return { acquired, activated, decisionBound, recovered }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(results.acquired.outcome).toBe('ACQUIRED')
    expect(results.activated).toMatchObject({ outcome: 'RECOVERED', action: 'ACTIVATED' })
    expect(results.decisionBound).toMatchObject({
      outcome: 'RECOVERED',
      action: 'BOUND_DECISION',
      cycle: {
        state: CycleState.Active,
        bindings: { snapshotId, decisionHash: expect.any(String) },
      },
    })
    expect(results.recovered).toMatchObject({
      outcome: 'RECOVERED',
      action: 'NO_TRADE',
      observedAt: afterCutoff,
      cycle: {
        state: CycleState.NoTrade,
        terminalAt: afterCutoff,
      },
    })
    if (results.recovered.outcome !== 'RECOVERED') throw new Error('recovery fixture must finish the bound decision')
    expect(results.recovered.cycle.terminalReason).toBeUndefined()
    expect(calendarReads).toBe(1)
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('uses runner-owned bind time and blocks a decision builder that completes after cutoff', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const inspection = finalizedPublicationInspection()
    const marketData = marketDataService(Effect.succeed(finalizedPublication()), inspection)
    const documentCreatedAt = '2026-02-02T14:20:00.000Z'

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        yield* TestClock.setTime(Date.parse('2026-01-30T21:21:00.000Z'))
        yield* provide(runAutonomousCyclePass(context()), read, store, marketData)
        yield* TestClock.setTime(Date.parse(documentCreatedAt))
        return yield* provide(
          runAutonomousCyclePass(
            context(undefined, (cycle) =>
              TestClock.adjust(9 * 60_000).pipe(Effect.as(makeDecision(cycle, documentCreatedAt))),
            ),
          ),
          read,
          store,
          marketData,
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result).toMatchObject({
      outcome: 'RECOVERED',
      action: 'BLOCKED',
      observedAt: '2026-02-02T14:29:00.000Z',
      cycle: {
        state: CycleState.Blocked,
        bindings: { snapshotId },
        terminalReason: CycleTerminalReason.MissedSubmission,
        terminalAt: '2026-02-02T14:29:00.000Z',
      },
    })
    if (result.outcome !== 'RECOVERED') throw new Error('late builder fixture must produce a recovery result')
    expect(result.cycle.bindings.decisionHash).toBeUndefined()
    expect(calendarReads).toBe(1)
    expect(control.acquisitions).toHaveLength(1)
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
    const inspection = finalizedPublicationInspection()
    const marketData = marketDataService(Effect.succeed(finalizedPublication()), inspection)

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
      outcome: 'RECOVERED',
      action: 'BOUND_SNAPSHOT',
      cycle: { state: CycleState.Pending, bindings: { snapshotId } },
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
            observePass: ignorePass,
            pollIntervalMs: 100,
          }),
          read,
          store,
          marketDataService(Effect.succeed(finalizedPublication()), finalizedPublicationInspection()),
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
              observePass: ignorePass,
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
    const observations: CyclePassObservation[] = []
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
            observePass: (observation) => Effect.sync(() => observations.push(observation)),
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
    expect(observations).toHaveLength(2)
    expect(observations[0]).toMatchObject({
      outcome: 'FAILED',
      observedAt: '2026-01-30T21:20:00.000Z',
      error: {
        _tag: 'CycleRunnerError',
        operation: 'load-context',
        failure: 'context',
        cause: contextFailure,
      },
    })
    expect(observations[1]).toMatchObject({
      outcome: 'SUCCEEDED',
      observedAt: '2026-01-30T21:20:00.100Z',
      result: { outcome: 'ACQUIRED' },
    })
    expect(control.binds).toBe(1)
  })

  test('leaves defects visible through the returned scoped fiber', async () => {
    const defect = new Error('unexpected cycle-loop defect')
    const observations: CyclePassObservation[] = []
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provide(
            startAutonomousCycleLoop({
              context: Effect.die(defect),
              observePass: (observation) => Effect.sync(() => observations.push(observation)),
              pollIntervalMs: 100,
            }),
            brokerRead(() => Effect.die(new Error('defective context must not read the broker'))),
            cycleStore(control),
            marketDataService(Effect.die(new Error('defective context must not inspect publications'))),
          )
          return yield* Fiber.await(fiber)
        }),
      ),
    )

    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') expect(Cause.pretty(exit.cause)).toContain(defect.message)
    expect(observations).toEqual([])
    expect(control).toEqual({ acquisitions: [], binds: 0 })
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
              observePass: ignorePass,
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
                observePass: ignorePass,
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
