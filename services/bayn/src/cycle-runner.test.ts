import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Fiber, Layer, Logger, Option, References, Result } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AccountStatus,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type Account,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
  type MarketCalendarSession,
  type ReadEvidence,
} from './broker/alpaca'
import { BrokerMutation, type BrokerMutationShape } from './broker/alpaca-mutations'
import { unusedAssetBySymbol } from './broker/alpaca-test-support'
import {
  CycleState,
  CycleTerminalReason,
  makeCycleExecutionPolicy,
  type AutonomousCycle,
  type CycleDraft,
  type CycleExecutionPolicy,
} from './cycle'
import {
  boundedCyclePublications,
  CycleDecisionBuildError,
  CycleRunnerError,
  cyclePassLogFacts,
  decideIdleReconciliationCadence,
  isMonthEndCycleDue,
  makeAutonomousCycleLoop,
  makeDueCycleDraft,
  marketCalendarQueryForPublications,
  marketCalendarQueryForSignal,
  runAutonomousCyclePass,
  selectCycleAuthoritySlots,
  selectCycleCalendarCandidate,
  selectDiscoveredPublications,
  selectNextExecutionSession,
  shouldDeferCyclePollForReconciliation,
  type AutonomousCycleLoopOptions,
  type CycleCandidate,
  type CyclePassObservation,
  type CycleRunContext,
  type CycleRunResult,
} from './cycle-runner'
import { CycleNotDueReconciliationError } from './cycle-runner/model'
import { completeCycleAuthoritySelection } from './cycle-runner/decisions'
import { runAutonomousCycleUntilSettled } from './cycle-runner/program'
import { selectBoundDecision } from './cycle-runner/recovery-decision-binding'
import { selectCycleRecovery, type CycleRecoveryState } from './cycle-recovery'
import { CycleStore, type CycleAuthoritySlot, type CycleStoreShape } from './db/cycle-store'
import { canonicalHashV1, sha256 } from './hash'
import {
  MarketData,
  type FinalizedPublicationDiscovery,
  type MarketDataInspection,
  type MarketDataService,
} from './market-data'
import {
  makeObserveShadowDecisionDocument,
  type CycleDecisionDocument,
  type ObserveShadowDecisionDocument,
} from './shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from './target-planner'
import { currentUtcInstant, utcInstantFromEpochMillis } from './time'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type InputManifest, type IsoDate } from './types'

type CycleLoopTestOptions<E, ContextR, DecisionR> = Omit<
  AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  'cyclePassTimeoutMs' | 'reconcileNotDue' | 'reconciliationIntervalMs'
> &
  Partial<
    Pick<
      AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
      'cyclePassTimeoutMs' | 'reconcileNotDue' | 'reconciliationIntervalMs'
    >
  >

const cycleLoop = <E, ContextR, DecisionR>(options: CycleLoopTestOptions<E, ContextR, DecisionR>) =>
  Effect.fromResult(
    makeAutonomousCycleLoop({
      cyclePassTimeoutMs: 50,
      reconcileNotDue: Effect.void,
      reconciliationIntervalMs: 30_000,
      ...options,
    }),
  )

const signalCalendarVersion = 'signal-XNYS-2026-v1'
const snapshotId = 'd'.repeat(64)
const evidence = {
  requestId: 'calendar-request',
  status: 200,
  contentHash: 'c'.repeat(64),
  observedAt: '2026-01-30T21:01:00.000Z',
}

const executionPolicyFixture = (): CycleExecutionPolicy => {
  const result = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: '3'.repeat(64),
    submissionWindowMs: 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable(result.failure.message)
  return result.success
}

const executionPolicy = executionPolicyFixture()

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

const ordinaryNotDueCalendar = calendar(
  [
    {
      date: '2026-01-29',
      openAt: '2026-01-29T14:30:00.000Z',
      closeAt: '2026-01-29T21:00:00.000Z',
    },
    {
      date: '2026-01-30',
      openAt: '2026-01-30T14:30:00.000Z',
      closeAt: '2026-01-30T21:00:00.000Z',
    },
  ],
  { start: '2026-01-29', end: '2026-02-28' },
)

const dueCycleDraftFixture = (
  cycleCandidate: CycleCandidate,
  observation: MarketCalendarObservation,
  executionSession: MarketCalendarSession,
): CycleDraft => {
  const result = makeDueCycleDraft(cycleCandidate, observation, executionSession)
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable(result.failure.message)
  expect(result.success).toBeDefined()
  if (result.success === undefined) return expect.unreachable('cycle fixture must be due')
  return result.success
}

const brokerRead = (marketCalendar: BrokerReadShape['marketCalendar']): BrokerReadShape => {
  const unused = Effect.die(new Error('cycle runner must use only the broker calendar read'))
  return {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
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
    loadSnapshotPublication: () => unused,
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
  bindingOverrides: Partial<ObserveShadowDecisionDocument['bindings']> = {},
): ObserveShadowDecisionDocument => {
  const targetPlanMaterial = {
    schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    inputHash: '4'.repeat(64),
    status: blockedReason === undefined ? TargetPlanStatus.NoTrade : TargetPlanStatus.Blocked,
    reason: blockedReason ?? TargetPlanReason.TargetsSatisfied,
    targets:
      blockedReason === undefined
        ? [
            {
              symbol: 'SPY',
              targetWeight: 0,
              referencePriceMicros: '1000000',
              currentQuantityMicros: '0',
              targetQuantityMicros: '0',
            },
          ]
        : [],
    intentTargets: [],
    requiredReferenceBuyNotionalMicros: '0',
    availableBuyingPowerMicros: '0',
    residualBuyingPowerMicros: '0',
  }
  const snapshot = cycle.bindings.snapshotId
  expect(snapshot).toBeDefined()
  if (snapshot === undefined) return expect.unreachable('shadow decision fixture requires a bound snapshot')
  const result = makeObserveShadowDecisionDocument({
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
      ...bindingOverrides,
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
  if (Result.isFailure(result)) return expect.unreachable(JSON.stringify(result.failure))
  expect(Result.isSuccess(result)).toBe(true)
  return result.success
}

const slotKey = (slot: CycleAuthoritySlot): string =>
  `${slot.qualificationRunId}\u001f${slot.accountId}\u001f${slot.signalSessionDate}`

interface StoreControl {
  readonly acquisitions: Array<{ readonly draft: CycleDraft; readonly observedAt: string }>
  binds: number
}

interface CycleStorePersistence {
  readonly cycles: Map<string, AutonomousCycle>
  readonly slots: Map<string, string>
  readonly documents: Map<string, CycleDecisionDocument>
  readonly manifests: Map<string, InputManifest>
}

const makeCycleStorePersistence = (): CycleStorePersistence => ({
  cycles: new Map(),
  slots: new Map(),
  documents: new Map(),
  manifests: new Map(),
})

const cycleStore = (
  control: StoreControl,
  persistence: CycleStorePersistence = makeCycleStorePersistence(),
): CycleStoreShape => {
  const { cycles, documents, manifests, slots } = persistence
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
        manifests.set(cycleId, manifest)
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
  test('decides first-pass, boundary, wait, and monotonic-regression reconciliation cadence purely', () => {
    const empty = {}
    const lastAttemptAtNanos = 1_000_000_000n
    const state = { lastAttemptAtNanos }
    const postPersistenceCompletionAtNanos = lastAttemptAtNanos + 30_000_000n
    const postPersistenceState = { lastAttemptAtNanos: postPersistenceCompletionAtNanos }

    expect(decideIdleReconciliationCadence(empty, lastAttemptAtNanos, 100)).toEqual({ _tag: 'RECONCILE' })
    expect(decideIdleReconciliationCadence(state, lastAttemptAtNanos + 99_000_000n, 100)).toEqual({
      _tag: 'WAIT',
      remainingNanos: 1_000_000n,
    })
    expect(decideIdleReconciliationCadence(state, lastAttemptAtNanos + 100_000_000n, 100)).toEqual({
      _tag: 'RECONCILE',
    })
    expect(decideIdleReconciliationCadence(state, lastAttemptAtNanos - 1n, 100)).toEqual({
      _tag: 'RECONCILE',
    })
    expect(
      decideIdleReconciliationCadence(postPersistenceState, postPersistenceCompletionAtNanos + 99_000_000n, 100),
    ).toEqual({ _tag: 'WAIT', remainingNanos: 1_000_000n })
    expect(
      decideIdleReconciliationCadence(postPersistenceState, postPersistenceCompletionAtNanos + 100_000_000n, 100),
    ).toEqual({ _tag: 'RECONCILE' })
    expect(
      shouldDeferCyclePollForReconciliation({
        lastAttemptAtNanos: 0n,
        nextPollAtNanos: 99n,
        pollStartAtNanos: 99n,
        reconciliationAtNanos: 100n,
        cyclePassTimeoutNanos: 2n,
      }),
    ).toBe(true)
    expect(
      shouldDeferCyclePollForReconciliation({
        lastAttemptAtNanos: 100n,
        nextPollAtNanos: 99n,
        pollStartAtNanos: 100n,
        reconciliationAtNanos: 200n,
        cyclePassTimeoutNanos: 100n,
      }),
    ).toBe(false)
    expect(state).toEqual({ lastAttemptAtNanos })
    expect(postPersistenceState).toEqual({ lastAttemptAtNanos: postPersistenceCompletionAtNanos })
  })

  test('selects recovery from durable cycle state and publication readiness without effects', () => {
    const executionSession = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (executionSession === undefined) throw new Error('recovery fixture requires an execution session')
    const draft = dueCycleDraftFixture(candidate(), monthEndCalendar, executionSession)
    const pending = cycleFrom(draft, '2026-01-30T21:20:00.000Z')
    const bound: AutonomousCycle = {
      ...pending,
      bindings: { snapshotId },
      stateVersion: pending.stateVersion + 1,
      updatedAt: '2026-01-30T21:21:00.000Z',
    }
    const sameInstantBound: AutonomousCycle = {
      ...bound,
      updatedAt: pending.updatedAt,
    }
    const active: AutonomousCycle = {
      ...bound,
      state: CycleState.Active,
      stateVersion: bound.stateVersion + 1,
      updatedAt: '2026-01-30T21:22:00.000Z',
    }

    expect(selectCycleRecovery(recoveryState(undefined))).toEqual(Result.succeed({ action: 'DISCOVER' }))
    expect(selectCycleRecovery(recoveryState(pending))).toEqual(
      Result.succeed({ action: 'READ_PUBLICATION', cycle: pending }),
    )
    expect(
      selectCycleRecovery(
        recoveryState(pending, {
          observedAt: '2026-01-30T21:21:00.000Z',
          readiness: {
            outcome: 'WAITING',
            reason: 'PUBLICATION_MISSING',
            observedAt: '2026-01-30T21:21:00.000Z',
            cycle: pending,
          },
        }),
      ),
    ).toMatchObject({
      _tag: 'Success',
      success: { action: 'RETURN_READINESS', recoveryAction: 'WAITING' },
    })
    expect(
      selectCycleRecovery(
        recoveryState(pending, {
          observedAt: bound.updatedAt,
          readiness: {
            outcome: 'BOUND',
            observedAt: bound.updatedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      ),
    ).toMatchObject({
      _tag: 'Success',
      success: { action: 'RETURN_READINESS', recoveryAction: 'BOUND_SNAPSHOT' },
    })
    expect(
      selectCycleRecovery(
        recoveryState(bound, {
          observedAt: bound.updatedAt,
          readiness: {
            outcome: 'ALREADY_BOUND',
            observedAt: bound.updatedAt,
            cycle: bound,
            snapshotId,
          },
        }),
      ),
    ).toEqual(Result.succeed({ action: 'ACTIVATE', cycleId: bound.identity.cycleId, observedAt: bound.updatedAt }))
    expect(
      selectCycleRecovery(
        recoveryState(pending, {
          observedAt: pending.updatedAt,
          readiness: {
            outcome: 'ALREADY_BOUND',
            observedAt: pending.updatedAt,
            cycle: sameInstantBound,
            snapshotId,
          },
        }),
      ),
    ).toMatchObject({
      _tag: 'Success',
      success: {
        action: 'RETURN_READINESS',
        recoveryAction: 'BOUND_SNAPSHOT',
        result: { outcome: 'BOUND', cycle: { stateVersion: pending.stateVersion + 1 } },
      },
    })
    expect(selectCycleRecovery(recoveryState(active))).toEqual(
      Result.succeed({
        action: 'WAIT',
        cycle: active,
        observedAt: '2026-01-30T21:23:00.000Z',
      }),
    )
    expect(
      selectCycleRecovery(
        recoveryState(active, {
          observedAt: active.window.submissionOpenAt,
        }),
      ),
    ).toEqual(Result.succeed({ action: 'BUILD_DECISION', cycle: active }))
    expect(
      selectCycleRecovery(
        recoveryState(active, {
          observedAt: active.window.submissionCutoffAt,
        }),
      ),
    ).toEqual(
      Result.succeed({
        action: 'BLOCK',
        cycleId: active.identity.cycleId,
        observedAt: active.window.submissionCutoffAt,
        reason: CycleTerminalReason.MissedSubmission,
      }),
    )
    expect(
      selectCycleRecovery(
        recoveryState(active, {
          strategyProtocolHash: 'f'.repeat(64),
        }),
      ),
    ).toEqual(
      Result.succeed({
        action: 'BLOCK',
        cycleId: active.identity.cycleId,
        observedAt: '2026-01-30T21:23:00.000Z',
        reason: CycleTerminalReason.ProvenanceMismatch,
      }),
    )
    const terminalRecovery = selectCycleRecovery(
      recoveryState({
        ...pending,
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
        terminalAt: pending.updatedAt,
      }),
    )
    expect(Result.isFailure(terminalRecovery)).toBe(true)
    if (Result.isFailure(terminalRecovery)) {
      expect(terminalRecovery.failure).toMatchObject({
        operation: 'select',
        reason: 'terminal-cycle',
        message: 'terminal cycles must not enter autonomous recovery',
      })
    }

    const decision = makeDecision(active, active.window.submissionOpenAt)
    const decisionBoundAt = utcInstantFromEpochMillis(Date.parse(decision.createdAt) + 1)
    const decisionBound: AutonomousCycle = {
      ...active,
      bindings: { ...active.bindings, decisionHash: decision.contentHash },
      stateVersion: active.stateVersion + 1,
      updatedAt: decisionBoundAt,
    }
    const afterCutoff = utcInstantFromEpochMillis(Date.parse(active.window.submissionCutoffAt) + 1)
    expect(
      selectCycleRecovery(
        recoveryState(decisionBound, {
          strategyProtocolHash: 'f'.repeat(64),
          observedAt: afterCutoff,
        }),
      ),
    ).toEqual(Result.succeed({ action: 'READ_DECISION', cycle: decisionBound }))
    expect(
      selectCycleRecovery(
        recoveryState(decisionBound, {
          strategyProtocolHash: 'f'.repeat(64),
          observedAt: afterCutoff,
          decisionDocument: decision,
        }),
      ),
    ).toEqual(
      Result.succeed({
        action: 'FINISH',
        cycleId: decisionBound.identity.cycleId,
        observedAt: afterCutoff,
        state: CycleState.NoTrade,
      }),
    )

    const paperDecision = {
      ...decision,
      schemaVersion: 'bayn.paper-cycle-decision.v1',
      mode: 'PAPER',
      dispatchable: true,
      bindings: {
        ...decision.bindings,
        qualificationRunId: decisionBound.identity.qualificationRunId,
        authorityGenerationHash: 'b'.repeat(64),
      },
      targetPlan: { ...decision.targetPlan, status: TargetPlanStatus.Planned, reason: null },
      orderedIntentIds: [],
      contentHash: 'c'.repeat(64),
    } as unknown as CycleDecisionDocument
    const paperDecisionBound = {
      ...decisionBound,
      bindings: { ...decisionBound.bindings, decisionHash: paperDecision.contentHash },
    }
    expect(selectBoundDecision(paperDecisionBound, paperDecision, afterCutoff)).toEqual(
      Result.succeed({ action: 'WAIT', cycle: paperDecisionBound, observedAt: afterCutoff }),
    )
    expect(
      Result.isFailure(
        selectBoundDecision(
          paperDecisionBound,
          {
            ...paperDecision,
            bindings: {
              ...paperDecision.bindings,
              qualificationRunId: 'd'.repeat(64),
              authorityGenerationHash: 'b'.repeat(64),
            },
          } as CycleDecisionDocument,
          afterCutoff,
        ),
      ),
    ).toBe(true)

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
    ).toEqual(
      Result.succeed({
        action: 'BLOCK',
        cycleId: blockedDecisionBound.identity.cycleId,
        observedAt: afterCutoff,
        reason: CycleTerminalReason.DataStale,
      }),
    )
  })

  test('bounds decoded publications and reports reachable calendar-range overflow without mutating inputs', () => {
    const newest = finalizedPublicationInspection('2026-01-30')
    const prior = finalizedPublicationInspection('2026-01-29')
    const stale = finalizedPublicationInspection('2026-01-09')
    const frozen = Object.freeze([stale, newest, prior] as const)
    const inputOrder = frozen.map((publication) => publication.signalSession.session_date)

    expect(boundedCyclePublications(frozen)).toEqual(Result.succeed([newest, prior]))
    expect(frozen.map((publication) => publication.signalSession.session_date)).toEqual(inputOrder)
    expect(boundedCyclePublications([prior, newest, finalizedPublicationInspection('2026-01-30')])).toEqual(
      Result.fail({
        _tag: 'CyclePublicationDuplicate',
        signalSessionDate: '2026-01-30',
      }),
    )
    expect(boundedCyclePublications([newest, stale, finalizedPublicationInspection('2026-01-09')])).toEqual(
      Result.fail({
        _tag: 'CyclePublicationDuplicate',
        signalSessionDate: '2026-01-09',
      }),
    )
    expect(boundedCyclePublications([finalizedPublicationInspection('0000-01-01')])).toEqual(
      Result.fail({
        _tag: 'CyclePublicationRangeOutOfRange',
        signalSessionDate: '0000-01-01',
        offsetDays: -20,
        cause: {
          _tag: 'IsoDateShiftResultOutOfRange',
          date: '0000-01-01',
          days: -20,
          shifted: '-000001-12-12T00:00:00.000Z',
        },
      }),
    )
    expect(marketCalendarQueryForSignal('9999-12-31')).toEqual(
      Result.fail({
        _tag: 'CycleCalendarQueryRangeOutOfRange',
        signalSessionDate: '9999-12-31',
        offsetDays: 30,
        cause: {
          _tag: 'IsoDateShiftResultOutOfRange',
          date: '9999-12-31',
          days: 30,
          shifted: '+010000-01-30T00:00:00.000Z',
        },
      }),
    )
    expect(marketCalendarQueryForPublications([finalizedPublicationInspection('9999-12-31')])).toEqual(
      Result.fail({
        _tag: 'CycleCalendarQueryRangeOutOfRange',
        signalSessionDate: '9999-12-31',
        offsetDays: 30,
        cause: {
          _tag: 'IsoDateShiftResultOutOfRange',
          date: '9999-12-31',
          days: 30,
          shifted: '+010000-01-30T00:00:00.000Z',
        },
      }),
    )
    expect(marketCalendarQueryForPublications([newest, prior])).toEqual(
      Result.succeed({ start: '2026-01-29', end: '2026-02-28' }),
    )

    const malformedNonLatest = boundedCyclePublications([
      { signalSession: { session_date: '2026-01-30' } },
      { signalSession: { session_date: '0000-00-00' } },
    ])
    expect(malformedNonLatest).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CyclePublicationDateInvalid',
        signalSessionDate: '0000-00-00',
      },
    })
    if (Result.isSuccess(malformedNonLatest)) throw new Error('malformed publication fixture must fail')
    if (malformedNonLatest.failure._tag !== 'CyclePublicationDateInvalid') {
      throw new Error('malformed publication fixture must retain its date failure')
    }
    expect(malformedNonLatest.failure.cause).toEqual({
      _tag: 'IsoDateInputInvalid',
      date: '0000-00-00',
      epochMillis: Number.NaN,
    })

    const malformedQuery = marketCalendarQueryForSignal('0000-00-00')
    if (Result.isSuccess(malformedQuery)) throw new Error('malformed query fixture must fail')
    expect(malformedQuery.failure.cause).toEqual({
      _tag: 'IsoDateInputInvalid',
      date: '0000-00-00',
      epochMillis: Number.NaN,
    })
    expect(marketCalendarQueryForSignal('2026-02-30')).toEqual(
      Result.fail({
        _tag: 'CycleCalendarQueryRangeOutOfRange',
        signalSessionDate: '2026-02-30',
        offsetDays: 30,
        cause: {
          _tag: 'IsoDateInputNotCanonical',
          date: '2026-02-30',
          normalized: '2026-03-02T00:00:00.000Z',
        },
      }),
    )
  })

  test('classifies publication discovery as a pure typed decision before dependency reads', () => {
    const observedAt = '2026-01-30T21:15:00.000Z'
    const newest = finalizedPublicationInspection('2026-01-30')
    const prior = finalizedPublicationInspection('2026-01-29')

    expect(selectDiscoveredPublications({ outcome: 'MISSING', observedAt })).toEqual(
      Result.succeed({
        _tag: 'NO_PUBLICATION',
        result: { outcome: 'NO_PUBLICATION', observedAt },
      }),
    )
    expect(selectDiscoveredPublications(finalizedPublications([prior, newest], observedAt))).toEqual(
      Result.succeed({
        _tag: 'PUBLICATIONS',
        observedAt,
        publications: [newest, prior],
      }),
    )
    expect(selectDiscoveredPublications(finalizedPublications([], observedAt))).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CycleRunnerError',
        operation: 'inspect-publication',
        failure: 'contract',
      },
    })
    expect(
      selectDiscoveredPublications(
        finalizedPublications([newest, finalizedPublicationInspection('2026-01-30')], observedAt),
      ),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CycleRunnerError',
        operation: 'inspect-publication',
        failure: 'contract',
        cause: {
          _tag: 'CyclePublicationDuplicate',
          signalSessionDate: '2026-01-30',
        },
      },
    })
  })

  test('selects authority slots with exhaustive precedence without mutating its inputs', () => {
    const publication = finalizedPublicationInspection()
    const olderPublication = finalizedPublicationInspection('2026-01-29')
    const executionSession = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (executionSession === undefined) throw new Error('authority fixture requires an execution session')
    const draft = dueCycleDraftFixture(candidate(), monthEndCalendar, executionSession)
    const pending = cycleFrom(draft, '2026-01-30T21:20:00.000Z')
    const bound: AutonomousCycle = {
      ...pending,
      bindings: { snapshotId },
      stateVersion: pending.stateVersion + 1,
      updatedAt: '2026-01-30T21:21:00.000Z',
    }
    const terminal = cycleFrom(draft, draft.window.publicationDeadlineAt)
    const olderTerminal = { ...terminal, identity: { ...terminal.identity, cycleId: 'f'.repeat(64) } }
    expect(selectCycleAuthoritySlots([{ publication, existing: undefined }])).toEqual({
      _tag: 'READ_CALENDAR',
      publications: [publication],
    })
    expect(
      selectCycleAuthoritySlots([
        { publication, existing: undefined },
        { publication: olderPublication, existing: undefined },
      ]),
    ).toEqual({
      _tag: 'READ_CALENDAR',
      publications: [publication, olderPublication],
    })
    for (const state of [CycleState.Completed, CycleState.NoTrade, CycleState.Blocked] as const) {
      const cycle = { ...terminal, state }
      expect(selectCycleAuthoritySlots([{ publication, existing: cycle }])).toEqual({
        _tag: 'ALREADY_TERMINAL',
        cycle,
      })
    }
    expect(
      completeCycleAuthoritySelection(
        { _tag: 'UNCLAIMED', publications: [publication], latestTerminal: terminal },
        'PAPER_BOOTSTRAP',
      ),
    ).toEqual({ _tag: 'ALREADY_TERMINAL', cycle: terminal })
    const noTrade = { ...terminal, state: CycleState.NoTrade }
    expect(
      completeCycleAuthoritySelection(
        { _tag: 'UNCLAIMED', publications: [publication], latestTerminal: noTrade },
        'PAPER_BOOTSTRAP',
      ),
    ).toEqual({ _tag: 'READ_CALENDAR', publications: [publication] })
    const blocked = { ...terminal, state: CycleState.Blocked }
    expect(
      completeCycleAuthoritySelection(
        { _tag: 'UNCLAIMED', publications: [publication], latestTerminal: blocked },
        'PAPER_BOOTSTRAP',
      ),
    ).toEqual({ _tag: 'ALREADY_TERMINAL', cycle: blocked })
    const newerPublication = finalizedPublicationInspection('2026-02-02')
    expect(
      completeCycleAuthoritySelection(
        { _tag: 'UNCLAIMED', publications: [newerPublication, publication], latestTerminal: terminal },
        'PAPER_BOOTSTRAP',
      ),
    ).toEqual({ _tag: 'READ_CALENDAR', publications: [newerPublication] })
    const riskBlocked = { ...terminal, terminalReason: CycleTerminalReason.Risk }
    expect(
      completeCycleAuthoritySelection(
        { _tag: 'UNCLAIMED', publications: [newerPublication], latestTerminal: riskBlocked },
        'PAPER_BOOTSTRAP',
      ),
    ).toEqual({ _tag: 'ALREADY_TERMINAL', cycle: riskBlocked })
    expect(
      selectCycleAuthoritySlots([
        { publication, existing: terminal },
        { publication: olderPublication, existing: olderTerminal },
      ]),
    ).toEqual({ _tag: 'ALREADY_TERMINAL', cycle: terminal })
    expect(
      selectCycleAuthoritySlots([
        { publication, existing: terminal },
        { publication: olderPublication, existing: undefined },
      ]),
    ).toEqual({
      _tag: 'READ_CALENDAR',
      publications: [olderPublication],
    })
    expect(
      selectCycleAuthoritySlots([
        { publication, existing: undefined },
        { publication: olderPublication, existing: terminal },
      ]),
    ).toEqual({ _tag: 'READ_CALENDAR', publications: [publication] })
    expect(selectCycleAuthoritySlots([{ publication, existing: pending }])).toEqual({
      _tag: 'RESUME',
      publication,
      cycle: pending,
    })
    expect(
      selectCycleAuthoritySlots([
        { publication: finalizedPublicationInspection('2026-02-02'), existing: terminal },
        { publication, existing: bound },
        { publication: olderPublication, existing: undefined },
      ]),
    ).toEqual({
      _tag: 'ALREADY_ACQUIRED',
      publication,
      cycle: bound,
    })

    const publicationBefore = JSON.stringify(publication)
    const boundBefore = JSON.stringify(bound)
    const frozenSlots = Object.freeze([{ publication, existing: bound }] as const)
    selectCycleAuthoritySlots(frozenSlots)
    expect(JSON.stringify(publication)).toBe(publicationBefore)
    expect(JSON.stringify(bound)).toBe(boundBefore)
  })

  test('decides calendar candidates purely across not-due, failure, and exact acquisition material', () => {
    const duePublication = finalizedPublicationInspection('2026-01-30')
    const dailyPublication = finalizedPublicationInspection('2026-02-02', '2026-02-02T21:15:00.000Z')
    const catchUpCalendar = calendar([
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
      {
        date: '2026-02-03',
        openAt: '2026-02-03T14:30:00.000Z',
        closeAt: '2026-02-03T21:00:00.000Z',
      },
    ])
    const publications = Object.freeze([dailyPublication, duePublication] as const)
    const publicationOrder = publications.map((publication) => publication.signalSession.session_date)
    const calendarBefore = JSON.stringify(catchUpCalendar)
    const observedAt = '2026-02-02T21:20:00.000Z'

    const decision = selectCycleCalendarCandidate(
      context(),
      publications,
      catchUpCalendar,
      evidence.contentHash,
      observedAt,
    )
    expect(Result.isSuccess(decision)).toBe(true)
    if (Result.isFailure(decision) || decision.success._tag !== 'ACQUIRE') {
      throw new Error('catch-up fixture must produce acquisition material')
    }
    expect(decision.success.material).toMatchObject({
      publication: duePublication,
      signalSessionDate: '2026-01-30',
      executionSessionDate: '2026-02-02',
      calendarResponseHash: catchUpCalendar.normalizedResponseHash,
      calendarReadContentHash: evidence.contentHash,
      draft: {
        identity: {
          cycleId: '1528d70b630e50d40a879904091225e879ca99b3db73de1adddf2f41e6401db0',
        },
        window: {
          publicationDeadlineAt: '2026-02-02T13:58:00.000Z',
          submissionCutoffAt: '2026-02-02T14:28:00.000Z',
        },
      },
    })
    expect(publications.map((publication) => publication.signalSession.session_date)).toEqual(publicationOrder)
    expect(JSON.stringify(catchUpCalendar)).toBe(calendarBefore)

    const notDue = selectCycleCalendarCandidate(
      context(),
      [finalizedPublicationInspection('2026-01-29')],
      calendar([
        {
          date: '2026-01-30',
          openAt: '2026-01-30T14:30:00.000Z',
          closeAt: '2026-01-30T21:00:00.000Z',
        },
      ]),
      evidence.contentHash,
      observedAt,
    )
    expect(notDue).toMatchObject({
      _tag: 'Success',
      success: {
        _tag: 'NOT_DUE',
        result: {
          outcome: 'NOT_DUE',
          signalSessionDate: '2026-01-29',
          executionSessionDate: '2026-01-30',
          observedAt,
        },
      },
    })
    expect(
      selectCycleCalendarCandidate(
        context(),
        [dailyPublication, finalizedPublicationInspection('2026-01-29')],
        catchUpCalendar,
        evidence.contentHash,
        observedAt,
      ),
    ).toMatchObject({
      _tag: 'Success',
      success: {
        _tag: 'NOT_DUE',
        result: {
          outcome: 'NOT_DUE',
          signalSessionDate: '2026-02-02',
          executionSessionDate: '2026-02-03',
          observedAt,
        },
      },
    })
    expect(
      selectCycleCalendarCandidate(context(), publications, monthEndCalendar, evidence.contentHash, observedAt),
    ).toEqual(
      Result.fail({
        _tag: 'CycleExecutionSessionUnavailable',
        signalSessionDate: '2026-02-02',
      }),
    )

    const januaryEndPublication = finalizedPublicationInspection('2026-01-31')
    const lateClosePublication: MarketDataInspection = {
      ...januaryEndPublication,
      signalSession: { ...januaryEndPublication.signalSession, close_time: '23:59' },
    }
    const domainFailure = selectCycleCalendarCandidate(
      context(),
      [lateClosePublication],
      calendar([
        {
          date: '2026-02-01',
          openAt: '2026-02-01T00:30:00.000Z',
          closeAt: '2026-02-01T01:30:00.000Z',
        },
      ]),
      evidence.contentHash,
      observedAt,
    )
    expect(domainFailure).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CycleDraftConstructionFailed',
        signalSessionDate: '2026-01-31',
        cause: expect.anything(),
      },
    })
  })

  test('derives complete success and failure log facts without effects', () => {
    const executionSession = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (executionSession === undefined) throw new Error('log fixture requires an execution session')
    const draft = dueCycleDraftFixture(candidate(), monthEndCalendar, executionSession)
    const pending = cycleFrom(draft, '2026-01-30T21:20:00.000Z')
    const bound: AutonomousCycle = {
      ...pending,
      bindings: { snapshotId },
      stateVersion: pending.stateVersion + 1,
      updatedAt: '2026-01-30T21:21:00.000Z',
    }
    const terminal = cycleFrom(draft, draft.window.publicationDeadlineAt)
    const readiness = {
      outcome: 'BOUND' as const,
      observedAt: bound.updatedAt,
      cycle: bound,
      snapshotId,
    }
    const common = {
      signalSessionDate: '2026-01-30',
      executionSessionDate: '2026-02-02',
      observedAt: bound.updatedAt,
      calendarResponseHash: monthEndCalendar.normalizedResponseHash,
      calendarReadContentHash: evidence.contentHash,
    }
    const results: readonly CycleRunResult[] = [
      { outcome: 'NO_PUBLICATION', observedAt: bound.updatedAt },
      {
        outcome: 'ALREADY_ACQUIRED',
        signalSessionDate: '2026-01-30',
        observedAt: bound.updatedAt,
        cycle: bound,
      },
      {
        outcome: 'ALREADY_TERMINAL',
        signalSessionDate: '2026-01-30',
        observedAt: terminal.updatedAt,
        cycle: terminal,
      },
      {
        outcome: 'RESUMED',
        signalSessionDate: '2026-01-30',
        observedAt: bound.updatedAt,
        readiness,
      },
      {
        outcome: 'RECOVERED',
        action: 'BOUND_SNAPSHOT',
        observedAt: bound.updatedAt,
        cycle: bound,
      },
      { outcome: 'NOT_DUE', ...common },
      {
        outcome: 'ACQUIRED',
        ...common,
        receipt: { cycle: pending, created: true },
        readiness,
      },
      {
        outcome: 'REACQUIRED',
        ...common,
        receipt: { cycle: pending, created: false },
        readiness,
      },
    ]
    const facts = results.map((result) =>
      cyclePassLogFacts({ outcome: 'SUCCEEDED', observedAt: '2026-01-30T21:22:00.000Z', result }),
    )
    expect(facts.map((fact) => fact.level)).toEqual(Array.from({ length: results.length }, () => 'INFO'))
    expect(facts.map((fact) => fact.message)).toEqual(
      Array.from({ length: results.length }, () => 'Bayn autonomous cycle pass completed'),
    )
    expect(facts.map((fact) => [fact.annotations['outcome'], fact.annotations['persistenceDeduplicated']])).toEqual([
      ['NO_PUBLICATION', undefined],
      ['ALREADY_ACQUIRED', undefined],
      ['ALREADY_TERMINAL', undefined],
      ['RESUMED', undefined],
      ['RECOVERED', undefined],
      ['NOT_DUE', undefined],
      ['ACQUIRED', false],
      ['REACQUIRED', true],
    ])

    const error = new CycleRunnerError({
      operation: 'market-calendar',
      failure: 'calendar-read',
      message: 'calendar failed',
    })
    expect(
      cyclePassLogFacts({
        outcome: 'FAILED',
        observedAt: '2026-01-30T21:22:00.000Z',
        error,
      }),
    ).toEqual({
      level: 'ERROR',
      message: 'Bayn autonomous cycle pass failed',
      annotations: {
        operation: 'market-calendar',
        failure: 'calendar-read',
        message: 'calendar failed',
      },
    })
  })

  test('builds one bounded calendar query and selects the first session strictly after Signal', () => {
    const queryResult = marketCalendarQueryForSignal('2026-01-30')
    expect(queryResult).toEqual(Result.succeed({ start: '2026-01-30', end: '2026-03-01' }))
    if (Result.isFailure(queryResult)) throw new Error('calendar query fixture must be in range')
    const query = queryResult.success
    const inclusiveDays =
      (Date.parse(`${query.end}T00:00:00.000Z`) - Date.parse(`${query.start}T00:00:00.000Z`)) / 86_400_000 + 1
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
    const first = dueCycleDraftFixture(candidate(), monthEndCalendar, selected)
    const changedEvidence = calendar([selected], { start: '2026-01-31', end: '2026-02-10' })
    const second = dueCycleDraftFixture(candidate(), changedEvidence, selected)
    expect(first.identity.cycleId).toBe(second.identity.cycleId)
    expect(first.window).toMatchObject({
      signalCloseAt: '2026-01-30T21:00:00.000Z',
      publicationDeadlineAt: '2026-02-02T13:58:00.000Z',
      submissionOpenAt: '2026-02-02T13:58:00.000Z',
      submissionCutoffAt: '2026-02-02T14:28:00.000Z',
      executionOpenAt: '2026-02-02T14:30:00.000Z',
      executionCloseAt: '2026-02-02T20:00:00.000Z',
    })
  })

  test('admits a PAPER bootstrap publication without weakening the default monthly cadence', () => {
    const executionSession = selectNextExecutionSession('2026-01-29', ordinaryNotDueCalendar)
    if (executionSession === undefined) throw new Error('bootstrap fixture must have an execution session')
    const monthly = makeDueCycleDraft(candidate('2026-01-29'), ordinaryNotDueCalendar, executionSession)
    const bootstrap = makeDueCycleDraft(
      { ...candidate('2026-01-29'), cadence: 'PAPER_BOOTSTRAP' },
      ordinaryNotDueCalendar,
      executionSession,
    )
    expect(monthly).toEqual(Result.succeed(undefined))
    expect(Result.isSuccess(bootstrap)).toBe(true)
    if (Result.isSuccess(bootstrap)) expect(bootstrap.success?.identity.signalSessionDate).toBe('2026-01-29')
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

  test('reads recovery first and authority slots in descending order until the first resumable slot', async () => {
    const executionSession = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (executionSession === undefined) throw new Error('read-order fixture requires an execution session')
    const draft = dueCycleDraftFixture(candidate(), monthEndCalendar, executionSession)
    const pending = cycleFrom(draft, '2026-01-30T21:20:00.000Z')
    const bound: AutonomousCycle = {
      ...pending,
      bindings: { snapshotId },
      stateVersion: pending.stateVersion + 1,
      updatedAt: '2026-01-30T21:21:00.000Z',
    }
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const baseStore = cycleStore(control)
    const events: string[] = []
    const store: CycleStoreShape = {
      ...baseStore,
      readOldestUnfinished: () =>
        Effect.sync(() => {
          events.push('read-oldest-unfinished')
          return Option.none()
        }),
      readAuthoritySlot: (slot) =>
        Effect.sync(() => {
          events.push(`read-authority-slot:${slot.signalSessionDate}`)
          return slot.signalSessionDate === '2026-01-30' ? Option.some(bound) : Option.none()
        }),
    }
    const publications = [
      finalizedPublicationInspection('2026-01-29'),
      finalizedPublicationInspection('2026-01-30'),
      finalizedPublicationInspection('2026-02-02', '2026-02-02T21:15:00.000Z'),
    ]
    const result = await Effect.runPromise(
      provide(
        runAutonomousCyclePass(context()),
        brokerRead(() => Effect.die(new Error('early authority exit must not read the broker'))),
        store,
        marketDataService(
          Effect.sync(() => {
            events.push('inspect-cycle-publications')
            return finalizedPublications(publications)
          }),
        ),
      ),
    )

    expect(result).toMatchObject({
      outcome: 'ALREADY_ACQUIRED',
      signalSessionDate: '2026-01-30',
      cycle: { identity: { cycleId: bound.identity.cycleId } },
    })
    expect(events).toEqual([
      'read-oldest-unfinished',
      'inspect-cycle-publications',
      'read-authority-slot:2026-02-02',
      'read-authority-slot:2026-01-30',
    ])
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('observes a missing publication as a healthy completed loop pass', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const loop = yield* cycleLoop({
          context: Effect.succeed(context()),
          observePass: (observation) => Effect.sync(() => observations.push(observation)),
          pollIntervalMs: 100,
        })
        const fiber = yield* provide(
          loop.pipe(Effect.forkScoped({ startImmediately: true })),
          brokerRead(() => Effect.die(new Error('missing publication must not read the broker'))),
          cycleStore(control),
          marketDataService(Effect.succeed({ outcome: 'MISSING', observedAt: '2026-01-30T21:20:00.000Z' })),
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(observations).toEqual([
      {
        outcome: 'SUCCEEDED',
        observedAt: '2026-01-30T21:20:00.000Z',
        result: {
          outcome: 'NO_PUBLICATION',
          observedAt: '2026-01-30T21:20:00.000Z',
        },
      },
    ])
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
    expect(queries).toEqual([{ start: '2026-01-29', end: '2026-02-28' }])
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('reconciles one NOT_DUE pass before recording it as successful', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    const events: string[] = []
    let reconciliations = 0
    const ordinaryCalendar = calendar([
      {
        date: '2026-01-29',
        openAt: '2026-01-29T14:30:00.000Z',
        closeAt: '2026-01-29T21:00:00.000Z',
      },
      {
        date: '2026-01-30',
        openAt: '2026-01-30T14:30:00.000Z',
        closeAt: '2026-01-30T21:00:00.000Z',
      },
    ])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const completed = yield* Deferred.make<CyclePassObservation>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            cyclePassTimeoutMs: 25,
            observePass: (observation) =>
              Effect.sync(() => {
                events.push('observe')
                observations.push(observation)
              }).pipe(Effect.andThen(Deferred.succeed(completed, observation)), Effect.asVoid),
            pollIntervalMs: 60_000,
            reconcileNotDue: Effect.sync(() => {
              reconciliations += 1
              events.push('reconcile')
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.succeed({ value: ordinaryCalendar, evidence })),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(completed)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(reconciliations).toBe(1)
    expect(events).toEqual(['reconcile', 'observe'])
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NOT_DUE' } })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('reconciles before polling when the idle and cycle deadlines coincide', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const events: string[] = []
    let observations = 0
    let reconciliations = 0
    let calendarReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const firstPass = yield* Deferred.make<void>()
          const secondCalendarRead = yield* Deferred.make<void>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: () =>
              Effect.sync(() => {
                observations += 1
                events.push(`observe:${observations.toString()}`)
                return observations
              }).pipe(
                Effect.flatMap((count) =>
                  count === 1 ? Deferred.succeed(firstPass, undefined).pipe(Effect.asVoid) : Effect.void,
                ),
              ),
            cyclePassTimeoutMs: 100,
            pollIntervalMs: 100,
            reconciliationIntervalMs: 100,
            reconcileNotDue: Effect.sync(() => {
              reconciliations += 1
              events.push(`reconcile:${reconciliations.toString()}`)
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() =>
              Effect.sync(() => {
                calendarReads += 1
                events.push(`calendar:${calendarReads.toString()}`)
                return calendarReads
              }).pipe(
                Effect.tap((count) =>
                  count === 2 ? Deferred.succeed(secondCalendarRead, undefined).pipe(Effect.asVoid) : Effect.void,
                ),
                Effect.as({ value: ordinaryNotDueCalendar, evidence }),
              ),
            ),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(firstPass)
          yield* TestClock.adjust(100)
          yield* Deferred.await(secondCalendarRead)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(events.indexOf('reconcile:2')).toBeGreaterThan(events.indexOf('observe:1'))
    expect(events.indexOf('reconcile:2')).toBeLessThan(events.indexOf('calendar:2'))
    expect(events.indexOf('observe:2')).toBeLessThan(events.indexOf('calendar:2'))
    expect(calendarReads).toBe(2)
    expect(reconciliations).toBe(2)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('defers a near-deadline poll whose bounded pass would cross reconciliation cadence', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const events: string[] = []
    let observations = 0
    let reconciliations = 0
    let publicationReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const firstPass = yield* Deferred.make<void>()
          const secondPublicationRead = yield* Deferred.make<void>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            cyclePassTimeoutMs: 2,
            observePass: () =>
              Effect.sync(() => {
                observations += 1
                events.push(`observe:${observations.toString()}`)
                return observations
              }).pipe(
                Effect.flatMap((count) =>
                  count === 1 ? Deferred.succeed(firstPass, undefined).pipe(Effect.asVoid) : Effect.void,
                ),
              ),
            pollIntervalMs: 99,
            reconciliationIntervalMs: 100,
            reconcileNotDue: Effect.sync(() => {
              reconciliations += 1
              events.push(`reconcile:${reconciliations.toString()}`)
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('missing-publication loop must not read the broker calendar'))),
            cycleStore(control),
            marketDataService(
              Effect.sync(() => {
                publicationReads += 1
                events.push(`publication:${publicationReads.toString()}`)
                return publicationReads
              }).pipe(
                Effect.tap((count) =>
                  count === 2 ? Deferred.succeed(secondPublicationRead, undefined).pipe(Effect.asVoid) : Effect.void,
                ),
                Effect.as({ outcome: 'MISSING' as const, observedAt: '2026-01-29T21:20:00.000Z' }),
              ),
            ),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(firstPass)
          yield* TestClock.withLive(Effect.sleep(5))
          yield* TestClock.adjust(99)
          expect(publicationReads).toBe(1)
          expect(reconciliations).toBe(1)
          yield* TestClock.adjust(1)
          yield* Deferred.await(secondPublicationRead)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(events.indexOf('reconcile:2')).toBeLessThan(events.indexOf('publication:2'))
    expect(publicationReads).toBe(2)
    expect(reconciliations).toBe(2)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('keeps faster cycle polling from over-reading reconciliation before the exact cadence boundary', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    let reconciliations = 0
    let calendarReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          const third = yield* Deferred.make<void>()
          const fourth = yield* Deferred.make<void>()
          const fifth = yield* Deferred.make<void>()
          const sixth = yield* Deferred.make<void>()
          const completions = [first, second, third, fourth, fifth, sixth]
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: (observation) =>
              Effect.sync(() => {
                observations.push(observation)
                return completions[observations.length - 1]
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
            pollIntervalMs: 100,
            reconciliationIntervalMs: 250,
            reconcileNotDue: Effect.sync(() => {
              reconciliations += 1
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() =>
              Effect.sync(() => {
                calendarReads += 1
                return { value: ordinaryNotDueCalendar, evidence }
              }),
            ),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(first)
          yield* TestClock.adjust(100)
          yield* Deferred.await(second)
          yield* TestClock.adjust(100)
          yield* Deferred.await(third)
          yield* TestClock.adjust(49)
          expect(reconciliations).toBe(1)
          expect(observations).toHaveLength(3)
          yield* TestClock.adjust(2)
          yield* Deferred.await(fourth)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(reconciliations).toBe(2)
    expect(calendarReads).toBe(3)
    expect(observations).toHaveLength(4)
    expect(observations.every((observation) => observation.outcome === 'SUCCEEDED')).toBe(true)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('runs idle reconciliation independently when cycle polling is slower than its configured cadence', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    let reconciliations = 0
    let calendarReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          const third = yield* Deferred.make<void>()
          const fourth = yield* Deferred.make<void>()
          const fifth = yield* Deferred.make<void>()
          const sixth = yield* Deferred.make<void>()
          const completions = [first, second, third, fourth, fifth, sixth]
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: (observation) =>
              Effect.sync(() => {
                observations.push(observation)
                return completions[observations.length - 1]
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
            pollIntervalMs: 350,
            reconciliationIntervalMs: 100,
            reconcileNotDue: Effect.sync(() => {
              reconciliations += 1
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() =>
              Effect.sync(() => {
                calendarReads += 1
                return { value: ordinaryNotDueCalendar, evidence }
              }),
            ),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(first)
          yield* TestClock.adjust(100)
          yield* Deferred.await(second)
          yield* TestClock.adjust(100)
          yield* Deferred.await(third)
          yield* TestClock.adjust(100)
          yield* Deferred.await(fourth)
          expect(calendarReads).toBe(1)
          expect(reconciliations).toBe(4)
          yield* TestClock.adjust(49)
          expect(observations).toHaveLength(4)
          yield* TestClock.adjust(1)
          yield* Deferred.await(fifth)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(calendarReads).toBe(2)
    expect(reconciliations).toBe(4)
    expect(observations).toHaveLength(5)
    expect(observations.every((observation) => observation.outcome === 'SUCCEEDED')).toBe(true)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('retries a failed idle reconciliation on cadence without recording false success or waiting for a slower poll', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    const failure = new CycleNotDueReconciliationError({
      failure: 'database',
      message: 'NOT_DUE reconciliation persistence failed',
    })
    let attempts = 0
    let calendarReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          const completions = [first, second]
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: (observation) =>
              Effect.sync(() => {
                observations.push(observation)
                return completions[observations.length - 1]
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
            pollIntervalMs: 1_000,
            reconciliationIntervalMs: 100,
            reconcileNotDue: Effect.suspend(() => {
              attempts += 1
              return attempts === 1 ? Effect.fail(failure) : Effect.void
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() =>
              Effect.sync(() => {
                calendarReads += 1
                return { value: ordinaryNotDueCalendar, evidence }
              }),
            ),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(first)
          expect(observations).toHaveLength(1)
          expect(observations[0]).toMatchObject({ outcome: 'FAILED' })
          yield* TestClock.adjust(99)
          expect(attempts).toBe(1)
          expect(observations).toHaveLength(1)
          yield* TestClock.adjust(1)
          yield* Deferred.await(second)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(attempts).toBe(2)
    expect(calendarReads).toBe(1)
    expect(observations).toHaveLength(2)
    expect(observations[0]).toMatchObject({ outcome: 'FAILED' })
    expect(observations[1]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NOT_DUE' } })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('keeps a failed reconciliation authoritative across non-idle polls until retry succeeds', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    const failure = new CycleNotDueReconciliationError({
      failure: 'database',
      message: 'non-idle reconciliation persistence failed',
    })
    let attempts = 0
    let publicationReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const first = yield* Deferred.make<void>()
          const second = yield* Deferred.make<void>()
          const completions = [first, second]
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            cyclePassTimeoutMs: 2,
            observePass: (observation) =>
              Effect.sync(() => {
                observations.push(observation)
                return completions[observations.length - 1]
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
            pollIntervalMs: 5,
            reconciliationIntervalMs: 10,
            reconcileNotDue: Effect.suspend(() => {
              attempts += 1
              return attempts === 1 ? Effect.fail(failure) : Effect.void
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('missing-publication loop must not read the broker calendar'))),
            cycleStore(control),
            marketDataService(
              Effect.sync(() => {
                publicationReads += 1
                return { outcome: 'MISSING' as const, observedAt: '2026-01-29T21:20:00.000Z' }
              }),
            ),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(first)
          yield* Deferred.await(second)
          for (let elapsed = 0; elapsed < 15; elapsed += 1) {
            yield* TestClock.withLive(Effect.sleep(1))
            yield* TestClock.adjust(1)
          }
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(attempts).toBe(2)
    expect(publicationReads).toBe(3)
    expect(observations).toHaveLength(5)
    expect(observations[0]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NO_PUBLICATION' } })
    expect(observations[1]).toMatchObject({
      outcome: 'FAILED',
      error: { operation: 'reconcile-not-due', message: failure.message },
    })
    expect(observations[2]).toMatchObject({
      outcome: 'FAILED',
      error: { operation: 'reconcile-not-due', message: failure.message },
    })
    expect(observations[3]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NO_PUBLICATION' } })
    expect(observations[4]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NO_PUBLICATION' } })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('records non-idle recovery immediately when cadence retry succeeds before the next poll', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    const failure = new CycleNotDueReconciliationError({
      failure: 'database',
      message: 'slow-poll reconciliation persistence failed',
    })
    let attempts = 0
    let publicationReads = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const initial = yield* Deferred.make<void>()
          const failed = yield* Deferred.make<void>()
          const recovered = yield* Deferred.make<void>()
          const completions = [initial, failed, recovered]
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: (observation) =>
              Effect.sync(() => {
                observations.push(observation)
                return completions[observations.length - 1]
              }).pipe(
                Effect.flatMap((completion) =>
                  completion === undefined ? Effect.void : Deferred.succeed(completion, undefined).pipe(Effect.asVoid),
                ),
              ),
            pollIntervalMs: 250,
            reconciliationIntervalMs: 100,
            reconcileNotDue: Effect.suspend(() => {
              attempts += 1
              return attempts === 1 ? Effect.fail(failure) : Effect.void
            }),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('missing-publication loop must not read the broker calendar'))),
            cycleStore(control),
            marketDataService(
              Effect.sync(() => {
                publicationReads += 1
                return { outcome: 'MISSING' as const, observedAt: '2026-01-29T21:20:00.000Z' }
              }),
            ),
          ).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(initial)
          yield* Deferred.await(failed)
          yield* TestClock.adjust(100)
          yield* Deferred.await(recovered)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(attempts).toBe(2)
    expect(publicationReads).toBe(1)
    expect(observations).toHaveLength(3)
    expect(observations[0]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NO_PUBLICATION' } })
    expect(observations[1]).toMatchObject({
      outcome: 'FAILED',
      error: { operation: 'reconcile-not-due', message: failure.message },
    })
    expect(observations[2]).toMatchObject({ outcome: 'SUCCEEDED', result: { outcome: 'NO_PUBLICATION' } })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('records a typed NOT_DUE reconciliation failure instead of a successful pass', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const cause = { _tag: 'ReconciliationStoreFixtureFailure' }
    const failure = new CycleNotDueReconciliationError({
      failure: 'database',
      message: 'NOT_DUE reconciliation persistence failed',
      cause,
    })
    let attempts = 0
    const ordinaryCalendar = calendar([
      {
        date: '2026-01-29',
        openAt: '2026-01-29T14:30:00.000Z',
        closeAt: '2026-01-29T21:00:00.000Z',
      },
      {
        date: '2026-01-30',
        openAt: '2026-01-30T14:30:00.000Z',
        closeAt: '2026-01-30T21:00:00.000Z',
      },
    ])

    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const completed = yield* Deferred.make<CyclePassObservation>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: (pass) => Deferred.succeed(completed, pass).pipe(Effect.asVoid),
            pollIntervalMs: 60_000,
            reconcileNotDue: Effect.sync(() => {
              attempts += 1
            }).pipe(Effect.andThen(Effect.fail(failure))),
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.succeed({ value: ordinaryCalendar, evidence })),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          const pass = yield* Deferred.await(completed)
          yield* Fiber.interrupt(fiber)
          return pass
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(attempts).toBe(1)
    expect(observation).toEqual({
      outcome: 'FAILED',
      observedAt: '2026-01-29T21:20:00.000Z',
      error: new CycleRunnerError({
        operation: 'reconcile-not-due',
        failure: 'database',
        message: failure.message,
        cause: failure,
      }),
    })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('scope interruption cancels in-flight NOT_DUE reconciliation without recording a pass', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    let interrupted = false
    const ordinaryCalendar = calendar([
      {
        date: '2026-01-29',
        openAt: '2026-01-29T14:30:00.000Z',
        closeAt: '2026-01-29T21:00:00.000Z',
      },
      {
        date: '2026-01-30',
        openAt: '2026-01-30T14:30:00.000Z',
        closeAt: '2026-01-30T21:00:00.000Z',
      },
    ])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-29T21:20:00.000Z'))
          const started = yield* Deferred.make<void>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: (observation) => Effect.sync(() => observations.push(observation)),
            pollIntervalMs: 60_000,
            reconcileNotDue: Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
            ),
          })
          yield* provide(
            loop,
            brokerRead(() => Effect.succeed({ value: ordinaryCalendar, evidence })),
            cycleStore(control),
            marketDataService(Effect.succeed(finalizedPublication('2026-01-29'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(started)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(interrupted).toBe(true)
    expect(observations).toEqual([])
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
      { start: '2026-01-30', end: '2026-03-01' },
      { start: '2026-02-02', end: '2026-03-04' },
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
    expect(queries).toEqual([{ start: '2026-01-30', end: '2026-03-01' }])
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('samples acquisition before the write and publication binding after it completes', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    const delayedStore: CycleStoreShape = {
      ...store,
      acquire: (draft, observedAt) => TestClock.adjust(1_000).pipe(Effect.andThen(store.acquire(draft, observedAt))),
    }
    let calendarReads = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        return yield* provide(
          runAutonomousCyclePass(context()),
          brokerRead(() => {
            calendarReads += 1
            return Effect.succeed({ value: monthEndCalendar, evidence })
          }),
          delayedStore,
          marketDataService(Effect.succeed(finalizedPublication()), finalizedPublicationInspection()),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(control.acquisitions).toEqual([
      {
        draft: expect.anything(),
        observedAt: '2026-01-30T21:20:00.000Z',
      },
    ])
    expect(result).toMatchObject({
      outcome: 'ACQUIRED',
      observedAt: '2026-01-30T21:20:01.000Z',
      readiness: {
        outcome: 'BOUND',
        observedAt: '2026-01-30T21:20:01.000Z',
        cycle: { updatedAt: '2026-01-30T21:20:01.000Z' },
      },
    })
    expect(calendarReads).toBe(1)
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

  test('admits only a newer PAPER bootstrap publication after a missed publication deadline', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    let calendarReads = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const paperContext = { ...context(), cadence: 'PAPER_BOOTSTRAP' as const }
    const missedPublication = finalizedPublicationInspection('2026-01-29', '2026-01-29T21:15:00.000Z')
    const newerPublication = finalizedPublicationInspection('2026-01-30', '2026-01-30T21:15:00.000Z')

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T14:30:00.000Z'))
        const missed = yield* provide(
          runAutonomousCyclePass(paperContext),
          read,
          store,
          marketDataService(Effect.succeed(finalizedPublications([missedPublication]))),
        )
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const successor = yield* provide(
          runAutonomousCyclePass(paperContext),
          read,
          store,
          marketDataService(
            Effect.succeed(finalizedPublications([newerPublication, missedPublication])),
            newerPublication,
          ),
        )
        return { missed, successor }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.missed).toMatchObject({
      outcome: 'ACQUIRED',
      signalSessionDate: '2026-01-29',
      readiness: {
        outcome: 'BLOCKED',
        cycle: { state: CycleState.Blocked, terminalReason: CycleTerminalReason.MissedPublication },
      },
    })
    expect(result.successor).toMatchObject({
      outcome: 'ACQUIRED',
      signalSessionDate: '2026-01-30',
      executionSessionDate: '2026-02-02',
      readiness: {
        outcome: 'BOUND',
        cycle: { state: CycleState.Pending, bindings: { snapshotId } },
      },
    })
    expect(calendarReads).toBe(2)
    expect(control.acquisitions).toHaveLength(2)
    expect(control.binds).toBe(1)
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

  test('finishes an exact pre-cutoff decision at the post-read Clock time after cutoff and a protocol change', async () => {
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
    const afterDelayedRead = '2026-02-02T14:30:00.000Z'

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
        const delayedReadStore: CycleStoreShape = {
          ...store,
          readDecisionDocument: (cycleId) =>
            TestClock.adjust(60_000).pipe(Effect.andThen(store.readDecisionDocument(cycleId))),
        }
        const recovered = yield* provide(runAutonomousCyclePass(changedProtocol), read, delayedReadStore, marketData)
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
      observedAt: afterDelayedRead,
      cycle: {
        state: CycleState.NoTrade,
        terminalAt: afterDelayedRead,
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
    const correctionSnapshotId = 'e'.repeat(64)
    const original = finalizedPublicationInspection()
    const correction = finalizedPublicationInspection('2026-01-30', '2026-01-30T21:16:00.000Z', correctionSnapshotId)
    const marketData = marketDataService(Effect.succeed(finalizedPublications([original])), correction)

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
      cycle: { state: CycleState.Pending, bindings: { snapshotId: correctionSnapshotId } },
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

  test('honors a coincident reconciliation deadline after RECOVERED without duplicating durable work', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store = cycleStore(control)
    const observations: CyclePassObservation[] = []
    const events: string[] = []
    let calendarReads = 0
    let reconciliations = 0
    const read = brokerRead(() => {
      calendarReads += 1
      return Effect.succeed({ value: monthEndCalendar, evidence })
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const loop = yield* cycleLoop({
          context: Effect.succeed(context()),
          observePass: (observation) =>
            Effect.sync(() => {
              observations.push(observation)
              events.push(`observe:${observations.length.toString()}`)
            }),
          pollIntervalMs: 100,
          reconciliationIntervalMs: 100,
          reconcileNotDue: Effect.sync(() => {
            reconciliations += 1
            events.push(`reconcile:${reconciliations.toString()}`)
          }),
        })
        const fiber = yield* provide(
          loop.pipe(Effect.forkScoped({ startImmediately: true })),
          read,
          store,
          marketDataService(Effect.succeed(finalizedPublication()), finalizedPublicationInspection()),
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(control.acquisitions).toHaveLength(1)
        expect(reconciliations).toBe(1)
        yield* TestClock.adjust(99)
        expect(control.acquisitions).toHaveLength(1)
        expect(reconciliations).toBe(1)
        yield* TestClock.adjust(1)
        expect(control.acquisitions).toHaveLength(1)
        expect(reconciliations).toBe(2)
        yield* TestClock.adjust(100)
        expect(control.acquisitions).toHaveLength(1)
        expect(reconciliations).toBe(3)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(calendarReads).toBe(1)
    expect(control.binds).toBe(1)
    expect(observations).toHaveLength(3)
    expect(events.indexOf('reconcile:2')).toBeLessThan(events.indexOf('observe:2'))
    expect(events.indexOf('reconcile:3')).toBeLessThan(events.indexOf('observe:3'))
    for (const observation of observations) {
      expect(observation).toMatchObject({
        outcome: 'SUCCEEDED',
        result: {
          outcome: 'RECOVERED',
          action: 'WAITING',
          cycle: {
            state: CycleState.Active,
            bindings: { snapshotId },
          },
        },
      })
    }
  })

  test('fails typed when a store reports progress without a durable state transition', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const persistence = makeCycleStorePersistence()
    const store = cycleStore(control, persistence)
    const stuckStore: CycleStoreShape = {
      ...store,
      activate: (cycleId) =>
        Effect.sync(() => {
          const cycle = persistence.cycles.get(cycleId)
          if (cycle === undefined) throw new Error('stuck activation could not find the cycle')
          return { cycle, changed: false }
        }),
    }
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
      return yield* provide(
        runAutonomousCycleUntilSettled(context()),
        brokerRead(() => Effect.succeed({ value: monthEndCalendar, evidence })),
        stuckStore,
        marketDataService(Effect.succeed(finalizedPublication()), finalizedPublicationInspection()),
      ).pipe(Effect.flip)
    }).pipe(Effect.provide(TestClock.layer()))

    const failure = await Effect.runPromise(program)
    expect(failure).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'recover-cycle',
      failure: 'contract',
      message: 'autonomous cycle pass repeated ACTIVATED without durable progress',
    })
    expect(control.acquisitions).toHaveLength(1)
    expect(control.binds).toBe(1)
  })

  test('completes one deterministic due OBSERVE pass and restarts without duplicate evidence or orders', async () => {
    const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const discoveryAt = '2026-01-30T21:20:00.000Z'
    const submissionOpenAt = '2026-02-02T13:58:00.000Z'
    const inspection = finalizedPublicationInspection()
    const persistence = makeCycleStorePersistence()
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    let calendarReads = 0
    let publicationDiscoveries = 0
    let exactSnapshotReads = 0
    let accountReads = 0
    let positionReads = 0
    let orderReads = 0
    let mutationSubmits = 0
    let mutationCancels = 0
    let notDueReconciliations = 0

    interface DurableReconciliationEvidence {
      readonly schemaVersion: 'bayn.test-observe-reconciliation.v1'
      readonly reconciliationId: string
      readonly cycleId: string
      readonly snapshotId: string
      readonly accountId: string
      readonly observedAt: string
      readonly authority: 'OBSERVE'
      readonly accountHash: string
      readonly positionsHash: string
      readonly ordersHash: string
      readonly brokerOrderCount: number
      readonly contentHash: string
    }

    const reconciliations = new Map<string, DurableReconciliationEvidence>()
    const readEvidence = (identity: string): ReadEvidence => ({
      requestId: `request-${identity}`,
      status: 200,
      contentHash: canonicalHashV1(identity),
      observedAt: submissionOpenAt,
    })
    const account: Account = {
      id: accountId,
      status: AccountStatus.Active,
      currency: 'USD',
      cashMicros: '1000000000',
      equityMicros: '1000000000',
      lastEquityMicros: '1000000000',
      buyingPowerMicros: '2000000000',
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: submissionOpenAt,
    }
    const unexpectedRead = Effect.die(new Error('deterministic due-cycle proof performed an unexpected broker read'))
    const read: BrokerReadShape = {
      account: Effect.sync(() => {
        accountReads += 1
        return { value: account, evidence: readEvidence('account') }
      }),
      accountConfiguration: unexpectedRead,
      assetBySymbol: unusedAssetBySymbol,
      positions: Effect.sync(() => {
        positionReads += 1
        return { value: [], evidence: readEvidence('positions') }
      }),
      orders: () =>
        Effect.sync(() => {
          orderReads += 1
          return { value: [], evidence: readEvidence('orders') }
        }),
      orderById: () => unexpectedRead,
      orderByClientId: () => unexpectedRead,
      fillActivities: () => unexpectedRead,
      marketCalendar: (query) =>
        Effect.sync(() => {
          calendarReads += 1
          expect(query).toEqual({ start: '2026-01-30', end: '2026-03-01' })
          return { value: monthEndCalendar, evidence }
        }),
    }
    const exactPublication = () =>
      Effect.sync(() => {
        exactSnapshotReads += 1
        return {
          outcome: 'FINALIZED' as const,
          observedAt: inspection.manifest.finalizedSnapshot.finalizedAt,
          inspection,
        }
      })
    const marketData: MarketDataService = {
      ...marketDataService(Effect.die(new Error('deterministic discovery override was not installed'))),
      inspectCyclePublications: Effect.sync(() => {
        publicationDiscoveries += 1
        return finalizedPublications([inspection], discoveryAt)
      }),
      inspectPublication: exactPublication,
      inspectSnapshotPublication: exactPublication,
    }
    const mutation: BrokerMutationShape = {
      submit: () =>
        Effect.sync(() => {
          mutationSubmits += 1
          throw new Error('OBSERVE cycle attempted to submit an order')
        }),
      cancel: () =>
        Effect.sync(() => {
          mutationCancels += 1
          throw new Error('OBSERVE cycle attempted to cancel an order')
        }),
    }
    const baseContext = context(accountId)
    const dueContext: CycleRunContext<BrokerRead> = {
      ...baseContext,
      buildDecision: (cycle, reconciliationCompleted = Effect.void) =>
        Effect.gen(function* () {
          const broker = yield* BrokerRead
          const [accountObservation, positionsObservation, ordersObservation, observedAt] = yield* Effect.all([
            broker.account,
            broker.positions,
            broker.orders(),
            currentUtcInstant,
          ])
          const boundSnapshotId = cycle.bindings.snapshotId
          if (boundSnapshotId === undefined) {
            return yield* Effect.die(new Error('same-pass reconciliation requires the immutable snapshot binding'))
          }
          const accountHash = canonicalHashV1(accountObservation.value)
          const positionsHash = canonicalHashV1(positionsObservation.value)
          const ordersHash = canonicalHashV1(ordersObservation.value)
          const reconciliationMaterial = {
            schemaVersion: 'bayn.test-observe-reconciliation.v1' as const,
            cycleId: cycle.identity.cycleId,
            snapshotId: boundSnapshotId,
            accountId: accountObservation.value.id,
            observedAt,
            authority: 'OBSERVE' as const,
            accountHash,
            positionsHash,
            ordersHash,
            brokerOrderCount: ordersObservation.value.length,
          }
          const reconciliationId = canonicalHashV1({
            schemaVersion: reconciliationMaterial.schemaVersion,
            cycleId: reconciliationMaterial.cycleId,
            observedAt,
          })
          const contentHash = canonicalHashV1(reconciliationMaterial)
          yield* Effect.sync(() => {
            if (reconciliations.has(cycle.identity.cycleId)) {
              throw new Error('same-pass reconciliation evidence was duplicated')
            }
            reconciliations.set(cycle.identity.cycleId, {
              ...reconciliationMaterial,
              reconciliationId,
              contentHash,
            })
          })
          yield* reconciliationCompleted
          return makeDecision(cycle, observedAt, undefined, {
            planningBrokerStateHash: canonicalHashV1({ accountHash, positionsHash, ordersHash }),
            reconciliationId,
            reconciliationHash: contentHash,
          })
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CycleDecisionBuildError({
                failure: 'market-data',
                message: 'deterministic same-pass broker reconciliation failed',
                cause,
              }),
          ),
        ),
    }
    const durableStore = cycleStore(control, persistence)
    const dueStore: CycleStoreShape = {
      ...durableStore,
      bindSnapshot: (cycleId, manifest, observedAt) =>
        durableStore
          .bindSnapshot(cycleId, manifest, observedAt)
          .pipe(Effect.tap((receipt) => TestClock.setTime(Date.parse(receipt.cycle.window.submissionOpenAt)))),
    }
    const runOnePass = (store: CycleStoreShape) =>
      Effect.scoped(
        Effect.gen(function* () {
          const observed = yield* Deferred.make<CyclePassObservation>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(dueContext),
            cyclePassTimeoutMs: 604_800_000,
            observePass: (observation) =>
              Effect.sync(() => observations.push(observation)).pipe(
                Effect.andThen(Deferred.succeed(observed, observation)),
                Effect.asVoid,
              ),
            pollIntervalMs: 60_000,
            reconciliationIntervalMs: 604_800_000,
            reconcileNotDue: Effect.sync(() => {
              notDueReconciliations += 1
            }),
          })
          const fiber = yield* provide(loop, read, store, marketData).pipe(
            Effect.provideService(BrokerMutation, mutation),
            Effect.forkScoped({ startImmediately: true }),
          )
          const observation = yield* Deferred.await(observed)
          yield* Fiber.interrupt(fiber)
          return observation
        }),
      )

    const proof = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(discoveryAt))
        const completed = yield* runOnePass(dueStore)
        const restarted = yield* runOnePass(cycleStore(control, persistence))
        return { completed, restarted }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(isMonthEndCycleDue('2026-01-30', '2026-02-02')).toBe(true)
    expect(control.acquisitions).toHaveLength(1)
    expect(control.acquisitions[0]).toMatchObject({
      observedAt: discoveryAt,
      draft: {
        identity: {
          qualificationRunId: dueContext.qualificationRunId,
          strategyProtocolHash: dueContext.strategyProtocolHash,
          accountId,
          signalSessionDate: '2026-01-30',
          executionSessionDate: '2026-02-02',
        },
      },
    })
    expect(proof.completed).toMatchObject({
      outcome: 'SUCCEEDED',
      observedAt: submissionOpenAt,
      result: {
        outcome: 'RECOVERED',
        action: 'NO_TRADE',
        cycle: {
          state: CycleState.NoTrade,
          bindings: { snapshotId, decisionHash: expect.any(String) },
          terminalAt: submissionOpenAt,
        },
      },
    })
    expect(proof.restarted).toMatchObject({
      outcome: 'SUCCEEDED',
      observedAt: submissionOpenAt,
      result: {
        outcome: 'ALREADY_TERMINAL',
        signalSessionDate: '2026-01-30',
        cycle: { state: CycleState.NoTrade },
      },
    })
    expect(observations).toEqual([proof.completed, proof.restarted])
    expect(persistence.cycles).toHaveLength(1)
    expect(persistence.manifests).toHaveLength(1)
    expect(persistence.documents).toHaveLength(1)
    expect(reconciliations).toHaveLength(1)
    const durableCycle = [...persistence.cycles.values()][0]
    if (durableCycle === undefined) throw new Error('due-cycle proof did not persist its cycle')
    const durableManifest = persistence.manifests.get(durableCycle.identity.cycleId)
    const durableDecision = persistence.documents.get(durableCycle.identity.cycleId)
    const durableReconciliation = reconciliations.get(durableCycle.identity.cycleId)
    expect(durableCycle).toMatchObject({
      state: CycleState.NoTrade,
      stateVersion: 5,
      bindings: { snapshotId, decisionHash: durableDecision?.contentHash },
    })
    expect(durableManifest?.finalizedSnapshot.snapshotId).toBe(snapshotId)
    expect(durableDecision).toMatchObject({
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        cycleId: durableCycle.identity.cycleId,
        snapshotId,
        reconciliationId: durableReconciliation?.reconciliationId,
        reconciliationHash: durableReconciliation?.contentHash,
      },
      targetPlan: { status: TargetPlanStatus.NoTrade, intentTargets: [] },
      createdAt: submissionOpenAt,
    })
    expect(durableReconciliation).toMatchObject({
      cycleId: durableCycle.identity.cycleId,
      snapshotId,
      accountId,
      observedAt: submissionOpenAt,
      authority: 'OBSERVE',
      brokerOrderCount: 0,
    })
    expect(calendarReads).toBe(1)
    expect(publicationDiscoveries).toBe(2)
    expect(exactSnapshotReads).toBe(1)
    expect(accountReads).toBe(1)
    expect(positionReads).toBe(1)
    expect(orderReads).toBe(1)
    expect(notDueReconciliations).toBe(1)
    expect(control.binds).toBe(1)
    expect(mutationSubmits).toBe(0)
    expect(mutationCancels).toBe(0)
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
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            observePass: ignorePass,
            pollIntervalMs: 100,
          })
          yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('in-flight publication read must not reach the broker'))),
            cycleStore(control),
            marketDataService(latest),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(started)
        }),
      ),
    )
    expect(interrupted).toBe(true)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('interrupts a cycle pass that cannot complete before its admission deadline', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    let interrupted = false
    const discovery = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
    )
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
          const observed = yield* Deferred.make<CyclePassObservation>()
          const loop = yield* cycleLoop({
            context: Effect.succeed(context()),
            cyclePassTimeoutMs: 10,
            observePass: (pass) => Deferred.succeed(observed, pass).pipe(Effect.asVoid),
            pollIntervalMs: 100,
            reconciliationIntervalMs: 100,
            reconcileNotDue: Effect.void,
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('timed-out publication read must not reach the broker'))),
            cycleStore(control),
            marketDataService(discovery),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(started)
          yield* TestClock.adjust(10)
          const result = yield* Deferred.await(observed)
          yield* Fiber.interrupt(fiber)
          return result
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(interrupted).toBe(true)
    expect(observation).toMatchObject({
      outcome: 'FAILED',
      error: {
        operation: 'run-cycle-pass',
        failure: 'operational',
        message: 'autonomous cycle pass did not complete or reconcile within 10ms',
      },
    })
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('observes an empty FINALIZED discovery as a typed failure and continues the scheduled loop', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    let inspections = 0
    const discovery = Effect.sync(() => {
      inspections += 1
      return inspections === 1
        ? finalizedPublications([], '2026-01-30T21:20:00.000Z')
        : { outcome: 'MISSING' as const, observedAt: '2026-01-30T21:20:00.100Z' }
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const loop = yield* cycleLoop({
          context: Effect.succeed(context()),
          observePass: (observation) => Effect.sync(() => observations.push(observation)),
          pollIntervalMs: 100,
        })
        const fiber = yield* provide(
          loop.pipe(Effect.forkScoped({ startImmediately: true })),
          brokerRead(() => Effect.die(new Error('empty FINALIZED discovery must not read the broker'))),
          cycleStore(control),
          marketDataService(discovery),
        )
        yield* Effect.yieldNow
        expect(inspections).toBe(1)
        yield* TestClock.adjust(100)
        expect(inspections).toBe(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(observations).toEqual([
      {
        outcome: 'FAILED',
        observedAt: '2026-01-30T21:20:00.000Z',
        error: new CycleRunnerError({
          operation: 'inspect-publication',
          failure: 'contract',
          message: 'FINALIZED cycle publication discovery must contain a publication',
        }),
      },
      {
        outcome: 'SUCCEEDED',
        observedAt: '2026-01-30T21:20:00.100Z',
        result: { outcome: 'NO_PUBLICATION', observedAt: '2026-01-30T21:20:00.100Z' },
      },
    ])
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('observes duplicate publications as a typed failure and retries without authority or broker work', async () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const observations: CyclePassObservation[] = []
    let inspections = 0
    let authoritySlotReads = 0
    let brokerReads = 0
    const duplicateDate = '2026-01-30'
    const discovery = Effect.sync(() => {
      inspections += 1
      return inspections === 1
        ? finalizedPublications([
            finalizedPublicationInspection(duplicateDate),
            finalizedPublicationInspection(duplicateDate),
          ])
        : { outcome: 'MISSING' as const, observedAt: '2026-01-30T21:20:00.100Z' }
    })
    const baseStore = cycleStore(control)
    const store: CycleStoreShape = {
      ...baseStore,
      readAuthoritySlot: () =>
        Effect.sync(() => {
          authoritySlotReads += 1
          return Option.none()
        }),
    }
    const read = brokerRead(() =>
      Effect.sync(() => {
        brokerReads += 1
        return { value: monthEndCalendar, evidence }
      }),
    )
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const loop = yield* cycleLoop({
          context: Effect.succeed(context()),
          observePass: (observation) => Effect.sync(() => observations.push(observation)),
          pollIntervalMs: 100,
        })
        const fiber = yield* provide(
          loop.pipe(Effect.forkScoped({ startImmediately: true })),
          read,
          store,
          marketDataService(discovery),
        )
        yield* Effect.yieldNow
        expect(inspections).toBe(1)
        yield* TestClock.adjust(100)
        expect(inspections).toBe(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(observations).toEqual([
      {
        outcome: 'FAILED',
        observedAt: '2026-01-30T21:20:00.000Z',
        error: new CycleRunnerError({
          operation: 'inspect-publication',
          failure: 'contract',
          message: 'bounded cycle publication discovery is invalid',
          cause: {
            _tag: 'CyclePublicationDuplicate',
            signalSessionDate: duplicateDate,
          },
        }),
      },
      {
        outcome: 'SUCCEEDED',
        observedAt: '2026-01-30T21:20:00.100Z',
        result: { outcome: 'NO_PUBLICATION', observedAt: '2026-01-30T21:20:00.100Z' },
      },
    ])
    expect(authoritySlotReads).toBe(0)
    expect(brokerReads).toBe(0)
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('preserves every declared decision-build failure classification across scheduled passes', async () => {
    const executionSession = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (executionSession === undefined) return expect.unreachable('decision failure fixture requires a session')
    const draft = dueCycleDraftFixture(candidate(), monthEndCalendar, executionSession)
    const pending = cycleFrom(draft, '2026-01-30T21:20:00.000Z')
    const active: AutonomousCycle = {
      ...pending,
      state: CycleState.Active,
      bindings: { snapshotId },
      stateVersion: pending.stateVersion + 2,
      updatedAt: pending.window.submissionOpenAt,
    }
    const failures = (['market-data', 'database', 'store', 'operational'] as const).map(
      (failure) =>
        new CycleDecisionBuildError({
          failure,
          message: `${failure} decision build failed`,
          cause: { _tag: `${failure}-fixture` },
        }),
    )
    const observations: CyclePassObservation[] = []
    const control: StoreControl = { acquisitions: [], binds: 0 }
    const store: CycleStoreShape = {
      ...cycleStore(control),
      readOldestUnfinished: () => Effect.succeed(Option.some(active)),
    }
    let buildAttempts = 0
    const buildDecision: CycleRunContext['buildDecision'] = () => {
      const failure = failures[buildAttempts]
      if (failure === undefined) return Effect.die({ _tag: 'UnexpectedDecisionBuildAttempt' })
      buildAttempts += 1
      return Effect.fail(failure)
    }
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(active.window.submissionOpenAt))
        const loop = yield* cycleLoop({
          context: Effect.succeed(context(undefined, buildDecision)),
          observePass: (observation) => Effect.sync(() => observations.push(observation)),
          pollIntervalMs: 100,
        })
        const fiber = yield* provide(
          loop.pipe(Effect.forkScoped({ startImmediately: true })),
          brokerRead(() => Effect.die({ _tag: 'UnexpectedDecisionBuildBrokerRead' })),
          store,
          marketDataService(Effect.die({ _tag: 'UnexpectedDecisionBuildMarketDataRead' })),
        )
        yield* Effect.yieldNow
        for (let index = 1; index < failures.length; index += 1) {
          yield* TestClock.adjust(100)
        }
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(buildAttempts).toBe(failures.length)
    expect(observations).toHaveLength(failures.length)
    for (let index = 0; index < failures.length; index += 1) {
      expect(observations[index]).toMatchObject({
        outcome: 'FAILED',
        error: {
          _tag: 'CycleRunnerError',
          operation: 'build-decision',
          failure: failures[index]?.failure,
          message: failures[index]?.message,
          cause: failures[index],
        },
      })
    }
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('logs a failed pass and runs the next scheduled pass without killing the scoped loop', async () => {
    const contextFailure = new Error('qualification context unavailable')
    const control: StoreControl = { acquisitions: [], binds: 0 }
    let contextLoads = 0
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const observations: CyclePassObservation[] = []
    const secondPassObserved = await Effect.runPromise(Deferred.make<void>())
    const logger = Logger.make<unknown, void>((options) => {
      logs.push({
        message: options.message,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      })
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:20:00.000Z'))
        const loop = yield* cycleLoop({
          context: Effect.suspend(() => {
            contextLoads += 1
            return contextLoads === 1 ? Effect.fail(contextFailure) : Effect.succeed(context())
          }),
          observePass: (observation) =>
            Effect.sync(() => observations.push(observation)).pipe(
              Effect.flatMap((count) =>
                count === 2 ? Deferred.succeed(secondPassObserved, undefined).pipe(Effect.asVoid) : Effect.void,
              ),
            ),
          pollIntervalMs: 100,
        })
        const fiber = yield* provide(
          loop,
          brokerRead(() => Effect.succeed({ value: monthEndCalendar, evidence })),
          cycleStore(control),
          marketDataService(Effect.succeed(finalizedPublication()), finalizedPublicationInspection()),
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(contextLoads).toBe(1)
        expect(control.acquisitions).toEqual([])
        yield* TestClock.adjust(100)
        yield* Deferred.await(secondPassObserved)
        expect(contextLoads).toBe(2)
        expect(control.acquisitions).toHaveLength(1)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(Layer.merge(Logger.layer([logger]), TestClock.layer())))

    await Effect.runPromise(program)
    expect(
      logs.some(
        (entry) =>
          Array.isArray(entry.message) &&
          entry.message.includes('Bayn autonomous cycle pass failed') &&
          entry.annotations['operation'] === 'load-context' &&
          entry.annotations['failure'] === 'context',
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
      result: { outcome: 'RECOVERED', action: 'WAITING' },
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
          const loop = yield* cycleLoop<never, never, never>({
            context: Effect.die(defect),
            observePass: (observation) => Effect.sync(() => observations.push(observation)),
            pollIntervalMs: 100,
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('defective context must not read the broker'))),
            cycleStore(control),
            marketDataService(Effect.die(new Error('defective context must not inspect publications'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
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
          const loop = yield* cycleLoop<Error, never, never>({
            context: Effect.fail(contextFailure),
            observePass: ignorePass,
            pollIntervalMs: 100,
          })
          const fiber = yield* provide(
            loop,
            brokerRead(() => Effect.die(new Error('failed context must not read the broker'))),
            cycleStore(control),
            marketDataService(Effect.die(new Error('failed context must not inspect finalized publications'))),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          return yield* Fiber.interrupt(fiber)
        }),
      ),
    )
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })

  test('rejects invalid loop intervals before starting discovery', () => {
    const control: StoreControl = { acquisitions: [], binds: 0 }
    for (const pollIntervalMs of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = makeAutonomousCycleLoop({
        context: Effect.succeed(context()),
        cyclePassTimeoutMs: 50,
        observePass: ignorePass,
        pollIntervalMs,
        reconciliationIntervalMs: 30_000,
        reconcileNotDue: Effect.void,
      })
      expect(Result.isFailure(result)).toBe(true)
      expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
        _tag: 'CycleRunnerError',
        operation: 'configure',
        failure: 'invalid-config',
      })
    }
    for (const reconciliationIntervalMs of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const result = makeAutonomousCycleLoop({
        context: Effect.succeed(context()),
        cyclePassTimeoutMs: 50,
        observePass: ignorePass,
        pollIntervalMs: 100,
        reconciliationIntervalMs,
        reconcileNotDue: Effect.void,
      })
      expect(Result.isFailure(result)).toBe(true)
      expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
        _tag: 'CycleRunnerError',
        operation: 'configure',
        failure: 'invalid-config',
        message: 'reconciliation interval must be a positive safe integer',
      })
    }
    expect(control).toEqual({ acquisitions: [], binds: 0 })
  })
})
