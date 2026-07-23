import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape, type MarketCalendarObservation } from '../broker/alpaca'
import { unusedAssetBySymbol } from '../broker/alpaca-test-support'
import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type CycleDraft,
} from '../cycle'
import {
  makeDueCycleDraft,
  runAutonomousCyclePass,
  selectNextExecutionSession,
  type CycleRunContext,
  type CycleRunResult,
} from '../cycle-runner'
import { canonicalHashV1, sha256 } from '../hash'
import {
  MarketData,
  type FinalizedPublicationInspection,
  type MarketDataService,
  type SignalSessionRow,
} from '../market-data'
import { ReconciliationStatus } from '../paper'
import { makeObserveShadowDecisionDocument } from '../shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus } from '../target-planner'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type InputManifest, type IsoDate } from '../types'
import { CycleStore, CycleStoreLive, type CycleStoreShape } from './cycle-store'
import { PostgresClientLive } from './evidence-store'
import { migrationLoader } from './migrations'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const signalCalendarVersion = 'signal-XNYS-2026-v1'
const snapshotA = 'd'.repeat(64)
const snapshotB = 'e'.repeat(64)
const staleSnapshot = '6'.repeat(64)
const wrongCalendarSnapshot = '7'.repeat(64)
const wrongAsOfSnapshot = '8'.repeat(64)
const missingSnapshot = '9'.repeat(64)
const strategyDecisionHash = 'f'.repeat(64)

const databaseConfig = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeRuntime = () =>
  ManagedRuntime.make(
    CycleStoreLive.pipe(Layer.provideMerge(PostgresClientLive(databaseConfig)), Layer.provideMerge(NodeServices.layer)),
  )

const signalSession = (
  sessionDate: IsoDate,
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'> => ({
  calendar_version: signalCalendarVersion,
  session_date: sessionDate,
  close_time: '16:00',
  timezone: 'America/New_York',
})

const makeDraft = (
  accountId = 'paper-account-1',
  options: {
    readonly executionCloseAt?: string
    readonly executionOpenAt?: string
    readonly executionSessionDate?: IsoDate
    readonly signalSessionDate?: IsoDate
    readonly submissionWindowMs?: number
  } = {},
): CycleDraft => {
  const signalSessionDate = options.signalSessionDate ?? '2026-03-06'
  const executionSessionDate = options.executionSessionDate ?? '2026-03-09'
  const executionPolicy = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'c'.repeat(64),
    submissionWindowMs: options.submissionWindowMs ?? 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  const executionCalendar = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: executionSessionDate,
    openAt: options.executionOpenAt ?? '2026-03-09T13:30:00.000Z',
    closeAt: options.executionCloseAt ?? '2026-03-09T20:00:00.000Z',
  })
  const identity = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: 'a'.repeat(64),
    strategyProtocolHash: 'b'.repeat(64),
    accountId,
    signalSessionDate,
    signalCalendarVersion,
    executionSessionDate: executionCalendar.executionSessionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy,
  })
  return makeCycleDraft(identity, makeCycleWindow(signalSession(signalSessionDate), executionCalendar, executionPolicy))
}

const insertSnapshotReference = (
  snapshotId: string,
  options: {
    readonly calendarVersion?: string
    readonly lastSession?: IsoDate
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const lastSession = options.lastSession ?? '2026-03-06'
    yield* sql`
      INSERT INTO snapshot_references (
        snapshot_id, schema_version, database_name, table_name, dataset_version,
        source, source_feed, adjustment, content_hash, row_count,
        first_session, last_session, manifest
      ) VALUES (
        ${snapshotId}, 'bayn.finalized-snapshot.v3', 'signal', 'adjusted_daily_bars_v2',
        'signal.adjusted-daily-snapshot.v2', 'alpaca', 'sip', 'all',
        ${snapshotId}, 1, ${lastSession}, ${lastSession},
        ${sql.json({
          schemaVersion: 'bayn.finalized-snapshot.v3',
          snapshotId,
          contentHash: snapshotId,
          calendarVersion: options.calendarVersion ?? signalCalendarVersion,
          firstSession: lastSession,
          lastSession,
          rowCount: 1,
        })}
      )
    `
  })

const makeInputManifest = (
  snapshotId: string,
  options: {
    readonly asOfSession?: IsoDate
    readonly calendarVersion?: string
    readonly finalizedAt?: string
    readonly lastSession?: IsoDate
  } = {},
): InputManifest => {
  const lastSession = options.lastSession ?? '2026-03-06'
  const symbol = 'SPY'
  const finalizedSnapshot = {
    schemaVersion: 'bayn.finalized-snapshot.v3' as const,
    snapshotId,
    publicationId: snapshotId,
    publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
    universeId: 'cross-asset-taa-v1' as const,
    universeSymbolHash: sha256(symbol),
    source: DataSource.Alpaca,
    sourceFeed: DataFeed.Sip,
    adjustment: PriceAdjustment.All,
    calendarVersion: options.calendarVersion ?? signalCalendarVersion,
    publisherSourceRevision: '1'.repeat(40),
    publisherImage: {
      repository: 'registry.example.com/signal-publisher',
      digest: `sha256:${'2'.repeat(64)}`,
    },
    finalizedAt: options.finalizedAt ?? '2026-03-06T21:01:00.000Z',
    requestedStart: lastSession,
    firstSession: lastSession,
    lastSession,
    asOfSession: options.asOfSession ?? lastSession,
    symbols: [symbol],
    rowCount: 1,
    sessionCount: 1,
    contentHash: snapshotId,
    sessionsContentHash: '3'.repeat(64),
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
      dataStart: lastSession,
      dataEnd: lastSession,
      lookbackStart: lastSession,
      evaluationStart: lastSession,
      evaluationEnd: lastSession,
    },
    rowCount: 1,
    sessionCount: 1,
    firstSession: lastSession,
    lastSession,
    symbols: [{ symbol, rows: 1, firstSession: lastSession, lastSession }],
    finalizedSnapshot,
  }
  return { ...material, hash: canonicalHashV1(material) }
}

const acquireAt = '2026-03-06T21:01:00.000Z'
const snapshotAt = '2026-03-06T21:02:00.000Z'
const activeAt = '2026-03-06T21:03:00.000Z'
const decisionAt = '2026-03-06T21:04:00.000Z'
const terminalAt = '2026-03-06T21:05:00.000Z'

const shadowReconciliation = (draft: CycleDraft) => {
  const planningBrokerStateHash = '4'.repeat(64)
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId: draft.identity.accountId,
    expectedHash: planningBrokerStateHash,
    observedHash: planningBrokerStateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: snapshotAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material,
  })
  return {
    ...material,
    reconciliationId,
    contentHash: canonicalHashV1({ ...material, reconciliationId }),
  }
}

const makeShadowDecision = (
  draft: CycleDraft,
  boundSnapshotId: string,
  options: {
    readonly blockedReason?: Exclude<TargetPlanReason, TargetPlanReason.TargetsSatisfied>
    readonly createdAt?: string
    readonly snapshotContentHash?: string
    readonly strategyDecisionHash?: string
  } = {},
) => {
  const reconciliation = shadowReconciliation(draft)
  const targetPlanMaterial = {
    schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    inputHash: '1'.repeat(64),
    status: options.blockedReason === undefined ? TargetPlanStatus.NoTrade : TargetPlanStatus.Blocked,
    reason: options.blockedReason ?? TargetPlanReason.TargetsSatisfied,
    targets: [],
    intentTargets: [],
    requiredReferenceBuyNotionalMicros: '0',
    availableBuyingPowerMicros: '0',
    residualBuyingPowerMicros: '0',
  }
  const targetPlan = {
    ...targetPlanMaterial,
    outputHash: canonicalHashV1(targetPlanMaterial),
  }
  return makeObserveShadowDecisionDocument({
    schemaVersion: 'bayn.observe-shadow-decision.v1',
    mode: 'OBSERVE',
    dispatchable: false,
    bindings: {
      strategyName: draft.identity.strategyName,
      cycleId: draft.identity.cycleId,
      strategyProtocolHash: draft.identity.strategyProtocolHash,
      snapshotId: boundSnapshotId,
      snapshotContentHash: options.snapshotContentHash ?? boundSnapshotId,
      snapshotFinalizedAt: acquireAt,
      strategyDecisionHash: options.strategyDecisionHash ?? strategyDecisionHash,
      policyHash: '2'.repeat(64),
      accountId: draft.identity.accountId,
      planningBrokerStateHash: reconciliation.observedHash,
      reconciliationId: reconciliation.reconciliationId,
      reconciliationHash: reconciliation.contentHash,
    },
    targetPlan,
    deltaRisk: [],
    createdAt: options.createdAt ?? decisionAt,
    submissionCutoffAt: draft.window.submissionCutoffAt,
    expiresAt: draft.window.submissionCutoffAt,
  })
}

const insertShadowReconciliation = (draft: CycleDraft) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const reconciliation = shadowReconciliation(draft)
    yield* sql`
      INSERT INTO reconciliations (
        reconciliation_id,
        schema_version,
        account_id,
        expected_hash,
        observed_hash,
        content_hash,
        status,
        discrepancies,
        reconciled_at
      ) VALUES (
        ${reconciliation.reconciliationId},
        ${reconciliation.schemaVersion},
        ${reconciliation.accountId},
        ${reconciliation.expectedHash},
        ${reconciliation.observedHash},
        ${reconciliation.contentHash},
        ${reconciliation.status},
        '[]'::jsonb,
        ${reconciliation.reconciledAt}
      )
    `
  })

const runnerContext = (accountId: string): CycleRunContext => ({
  qualificationRunId: 'a'.repeat(64),
  strategyProtocolHash: 'b'.repeat(64),
  accountId,
  executionPolicy: makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'c'.repeat(64),
    submissionWindowMs: 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  }),
  buildDecision: () => Effect.die(new Error('runner integration fixture built an unexpected decision')),
})

const runnerPublication = (): Extract<FinalizedPublicationInspection, { readonly outcome: 'FINALIZED' }> => ({
  outcome: 'FINALIZED',
  observedAt: '2026-01-30T21:01:00.000Z',
  inspection: {
    manifest: makeInputManifest(snapshotA, {
      asOfSession: '2026-01-30',
      finalizedAt: '2026-01-30T21:00:30.000Z',
      lastSession: '2026-01-30',
    }),
    sessionDates: ['2026-01-30'],
    signalSession: signalSession('2026-01-30'),
  },
})

const runnerMarketData = (): MarketDataService => {
  const unused = Effect.die(new Error('autonomous cycle runner must inspect only bounded publication candidates'))
  const inspectExactPublication = () => Effect.succeed(runnerPublication())
  return {
    check: unused,
    inspect: unused,
    inspectCyclePublications: Effect.succeed({
      outcome: 'FINALIZED',
      observedAt: runnerPublication().observedAt,
      publications: [runnerPublication().inspection],
    }),
    inspectPublication: inspectExactPublication,
    inspectSnapshotPublication: inspectExactPublication,
    loadSnapshotPublication: () => unused,
    load: unused,
  }
}

const runnerCalendar = (): MarketCalendarObservation => {
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: '2026-01-30', end: '2026-03-01' },
    timeZone: 'UTC' as const,
    sessions: [
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
    ],
  }
  return { ...material, normalizedResponseHash: canonicalHashV1(material) }
}

const runnerBrokerRead = (queries: Array<{ readonly start: string; readonly end: string }>): BrokerReadShape => {
  const unused = Effect.die(new Error('autonomous cycle runner must use only marketCalendar'))
  return {
    account: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar: (query) => {
      queries.push(query)
      return Effect.succeed({
        value: runnerCalendar(),
        evidence: {
          requestId: `calendar-${queries.length}`,
          status: 200,
          contentHash: String(queries.length).repeat(64),
          observedAt: '2026-01-30T21:01:00.000Z',
        },
      })
    },
  }
}

describePostgres('PostgreSQL autonomous cycle store', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await runtime.dispose()
    runtime = makeRuntime()
    await runtime.runPromise(PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' }))
  }, 15_000)

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('concurrent deterministic acquisition creates one cycle with separate calendar provenance', async () => {
    const draft = makeDraft()
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const receipts = yield* Effect.all(
          [store.acquire(draft, acquireAt), store.acquire(structuredClone(draft), acquireAt)],
          { concurrency: 'unbounded' },
        )
        const sql = yield* PgClient.PgClient
        const [count] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM autonomous_cycles
        `
        return { count: count.count, receipts }
      }),
    )

    expect(
      observed.receipts.map((receipt) => receipt.created).sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true])
    expect(new Set(observed.receipts.map((receipt) => receipt.cycle.identity.cycleId)).size).toBe(1)
    expect(observed.receipts[0].cycle).toMatchObject({
      state: CycleState.Pending,
      identity: {
        signalCalendarVersion,
        executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
        executionCalendarSource: 'alpaca-v2-calendar',
      },
      window: {
        signalCalendarVersion,
        executionCalendarSchemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
        executionCalendarSource: 'alpaca-v2-calendar',
        executionOpenAt: '2026-03-09T13:30:00.000Z',
        executionCloseAt: '2026-03-09T20:00:00.000Z',
      },
    })
    expect(observed.count).toBe(1)
  })

  test('reads the oldest unfinished cycle inside one qualification and account scope', async () => {
    const accountId = 'paper-account-recovery'
    const older = makeDraft(accountId, {
      signalSessionDate: '2026-01-30',
      executionSessionDate: '2026-02-02',
      executionOpenAt: '2026-02-02T14:30:00.000Z',
      executionCloseAt: '2026-02-02T21:00:00.000Z',
    })
    const newer = makeDraft(accountId, {
      signalSessionDate: '2026-02-27',
      executionSessionDate: '2026-03-02',
      executionOpenAt: '2026-03-02T14:30:00.000Z',
      executionCloseAt: '2026-03-02T21:00:00.000Z',
    })
    const unrelated = makeDraft('paper-account-recovery-other')

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(older, '2026-01-30T21:01:00.000Z')
        yield* store.acquire(newer, '2026-02-27T21:01:00.000Z')
        yield* store.acquire(unrelated, acquireAt)

        const scope = { qualificationRunId: older.identity.qualificationRunId, accountId }
        const first = yield* store.readOldestUnfinished(scope)
        yield* store.block(
          older.identity.cycleId,
          CycleTerminalReason.MissedPublication,
          older.window.publicationDeadlineAt,
        )
        const second = yield* store.readOldestUnfinished(scope)
        yield* store.block(
          newer.identity.cycleId,
          CycleTerminalReason.MissedPublication,
          newer.window.publicationDeadlineAt,
        )
        const none = yield* store.readOldestUnfinished(scope)
        return { first, none, second }
      }),
    )

    expect(Option.isSome(observed.first)).toBe(true)
    if (Option.isSome(observed.first)) {
      expect(observed.first.value.identity.cycleId).toBe(older.identity.cycleId)
    }
    expect(Option.isSome(observed.second)).toBe(true)
    if (Option.isSome(observed.second)) {
      expect(observed.second.value.identity.cycleId).toBe(newer.identity.cycleId)
    }
    expect(Option.isNone(observed.none)).toBe(true)
  })

  test('concurrent runner passes and restart converge on one OBSERVE cycle', async () => {
    const context = runnerContext('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const queries: Array<{ readonly start: string; readonly end: string }> = []
    const read = runnerBrokerRead(queries)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:01:00.000Z'))
        const concurrent = yield* Effect.all(
          [
            runAutonomousCyclePass(context).pipe(Effect.provideService(BrokerRead, read)),
            runAutonomousCyclePass({ ...context }).pipe(Effect.provideService(BrokerRead, read)),
          ],
          { concurrency: 'unbounded' },
        )
        const readsAfterConcurrent = queries.length
        yield* TestClock.setTime(Date.parse('2026-01-30T21:02:00.000Z'))
        const restarted = yield* runAutonomousCyclePass(context).pipe(Effect.provideService(BrokerRead, read))
        const sql = yield* PgClient.PgClient
        const [count] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM autonomous_cycles
          WHERE qualification_run_id = ${context.qualificationRunId}
            AND account_id = ${context.accountId}
            AND signal_session_date = '2026-01-30'
        `
        return { concurrent, count: count.count, readsAfterConcurrent, restarted }
      }).pipe(Effect.provideService(MarketData, runnerMarketData()), Effect.provide(TestClock.layer())),
    )

    expect(result.concurrent.some((pass) => pass.outcome === 'ACQUIRED')).toBe(true)
    expect(result.concurrent.every((pass) => pass.outcome !== 'NO_PUBLICATION' && pass.outcome !== 'NOT_DUE')).toBe(
      true,
    )
    expect(result.restarted).toMatchObject({
      outcome: 'RECOVERED',
      action: 'ACTIVATED',
      cycle: {
        state: CycleState.Active,
        bindings: { snapshotId: snapshotA },
        identity: {
          accountId: context.accountId,
          signalSessionDate: '2026-01-30',
          executionSessionDate: '2026-02-02',
        },
      },
    })
    expect(result.count).toBe(1)
    expect(queries).toHaveLength(result.readsAfterConcurrent)
    expect(queries.length).toBeGreaterThanOrEqual(1)
    expect(queries.length).toBeLessThanOrEqual(2)
    expect(queries.every((query) => query.start === '2026-01-30' && query.end === '2026-03-01')).toBe(true)
  })

  test('resumes an exact publication binding after a crash between acquire and bind', async () => {
    const context = runnerContext('aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb')
    const publication = runnerPublication()
    if (publication.outcome !== 'FINALIZED') throw new Error('runner publication fixture must be finalized')
    const executionSession = selectNextExecutionSession('2026-01-30', runnerCalendar())
    if (executionSession === undefined) throw new Error('runner calendar fixture must contain an execution session')
    const draft = makeDueCycleDraft(
      { ...context, signalSession: publication.inspection.signalSession },
      runnerCalendar(),
      executionSession,
    )
    if (draft === undefined) throw new Error('runner fixture must produce a month-end cycle')
    const noCalendarRead: BrokerReadShape = {
      ...runnerBrokerRead([]),
      marketCalendar: () =>
        Effect.die(new Error('existing unbound authority slot must resume without another calendar read')),
    }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const acquired = yield* store.acquire(draft, '2026-01-30T21:01:00.000Z')
        yield* TestClock.setTime(Date.parse('2026-01-30T21:02:00.000Z'))
        const resumed = yield* runAutonomousCyclePass(context).pipe(Effect.provideService(BrokerRead, noCalendarRead))
        const sql = yield* PgClient.PgClient
        const [counts] = yield* sql<{ cycles: number; references: number }>`
          SELECT
            (SELECT count(*)::integer FROM autonomous_cycles) AS cycles,
            (SELECT count(*)::integer FROM snapshot_references) AS references
        `
        return { acquired, counts, resumed }
      }).pipe(Effect.provideService(MarketData, runnerMarketData()), Effect.provide(TestClock.layer())),
    )

    expect(result.acquired).toMatchObject({
      created: true,
      cycle: { state: CycleState.Pending, bindings: {} },
    })
    expect(result.resumed).toMatchObject({
      outcome: 'RECOVERED',
      action: 'BOUND_SNAPSHOT',
      cycle: { bindings: { snapshotId: snapshotA } },
    })
    expect(result.counts).toEqual({ cycles: 1, references: 1 })
  })

  test('runner Clock preserves every pre-open acquisition boundary in PostgreSQL', async () => {
    const cases = [
      {
        accountId: '10000000-0000-4000-8000-000000000001',
        observedAt: '2026-02-02T13:57:59.999Z',
        state: CycleState.Pending,
      },
      {
        accountId: '10000000-0000-4000-8000-000000000002',
        observedAt: '2026-02-02T13:58:00.000Z',
        state: CycleState.Blocked,
      },
      {
        accountId: '10000000-0000-4000-8000-000000000003',
        observedAt: '2026-02-02T14:28:00.000Z',
        state: CycleState.Blocked,
      },
      {
        accountId: '10000000-0000-4000-8000-000000000004',
        observedAt: '2026-02-02T14:30:00.000Z',
        state: CycleState.Blocked,
      },
    ] as const
    const queries: Array<{ readonly start: string; readonly end: string }> = []
    const read = runnerBrokerRead(queries)
    const results = await runtime.runPromise(
      Effect.gen(function* () {
        const observed: Array<Extract<CycleRunResult, { readonly outcome: 'ACQUIRED' | 'REACQUIRED' }>> = []
        for (const boundary of cases) {
          yield* TestClock.setTime(Date.parse(boundary.observedAt))
          const result = yield* runAutonomousCyclePass(runnerContext(boundary.accountId)).pipe(
            Effect.provideService(BrokerRead, read),
          )
          if (result.outcome !== 'ACQUIRED' && result.outcome !== 'REACQUIRED') {
            throw new Error('month-end runner fixture must acquire a cycle')
          }
          observed.push(result)
        }
        return observed
      }).pipe(Effect.provideService(MarketData, runnerMarketData()), Effect.provide(TestClock.layer())),
    )

    expect(results.map((result) => result.readiness.cycle.state)).toEqual(cases.map((boundary) => boundary.state))
    expect(results.map((result) => result.readiness.cycle.updatedAt)).toEqual(
      cases.map((boundary) => boundary.observedAt),
    )
    for (const result of results.slice(1)) {
      expect(result.readiness.cycle).toMatchObject({
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
      })
    }
    expect(
      results.every(
        (result) =>
          result.readiness.cycle.window.submissionOpenAt < result.readiness.cycle.window.submissionCutoffAt &&
          result.readiness.cycle.window.submissionCutoffAt < result.readiness.cycle.window.executionOpenAt,
      ),
    ).toBe(true)
  })

  test('samples a fresh Clock time after acquisition before binding a finalized publication', async () => {
    const accountId = '10000000-0000-4000-8000-000000000005'
    const beforeDeadline = '2026-02-02T13:57:59.999Z'
    const deadline = '2026-02-02T13:58:00.000Z'
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const delayedStore: CycleStoreShape = {
          ...store,
          acquire: (draft, observedAt) => store.acquire(draft, observedAt).pipe(Effect.tap(() => TestClock.adjust(1))),
        }
        yield* TestClock.setTime(Date.parse(beforeDeadline))
        const cycle = yield* runAutonomousCyclePass(runnerContext(accountId)).pipe(
          Effect.provideService(BrokerRead, runnerBrokerRead([])),
          Effect.provideService(CycleStore, delayedStore),
        )
        const sql = yield* PgClient.PgClient
        const [counts] = yield* sql<{ cycles: number; references: number }>`
          SELECT
            (SELECT count(*)::integer FROM autonomous_cycles) AS cycles,
            (SELECT count(*)::integer FROM snapshot_references) AS references
        `
        return { counts, cycle }
      }).pipe(Effect.provideService(MarketData, runnerMarketData()), Effect.provide(TestClock.layer())),
    )

    expect(result.cycle).toMatchObject({
      outcome: 'ACQUIRED',
      observedAt: deadline,
      receipt: {
        cycle: {
          state: CycleState.Pending,
          bindings: {},
          createdAt: beforeDeadline,
          updatedAt: beforeDeadline,
        },
      },
      readiness: {
        outcome: 'BLOCKED',
        observedAt: deadline,
        cycle: {
          state: CycleState.Blocked,
          bindings: {},
          terminalReason: CycleTerminalReason.MissedPublication,
          terminalAt: deadline,
          updatedAt: deadline,
        },
      },
    })
    expect(result.counts).toEqual({ cycles: 1, references: 0 })
  })

  test('reserves one capital-authority slot across changed calendar and policy inputs', async () => {
    const accountId = 'paper-account-authority-slot'
    const original = makeDraft(accountId)
    const changedCalendar = makeDraft(accountId, { executionCloseAt: '2026-03-09T19:00:00.000Z' })
    const changedPolicy = makeDraft(accountId, { submissionWindowMs: 15 * 60 * 1_000 })

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const acquired = yield* store.acquire(original, acquireAt)
        const conflicts = yield* Effect.all(
          [
            Effect.exit(store.acquire(changedCalendar, acquireAt)),
            Effect.exit(store.acquire(changedPolicy, acquireAt)),
          ],
          { concurrency: 'unbounded' },
        )
        const sql = yield* PgClient.PgClient
        const [count] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM autonomous_cycles
          WHERE qualification_run_id = ${original.identity.qualificationRunId}
            AND account_id = ${accountId}
            AND signal_session_date = ${original.identity.signalSessionDate}
        `
        return { acquired, conflicts, count: count.count }
      }),
    )

    expect(changedCalendar.identity.cycleId).not.toBe(original.identity.cycleId)
    expect(changedPolicy.identity.cycleId).not.toBe(original.identity.cycleId)
    expect(result.acquired.created).toBe(true)
    expect(result.conflicts.every(Exit.isFailure)).toBe(true)
    for (const conflict of result.conflicts) {
      if (Exit.isFailure(conflict)) {
        expect(Cause.pretty(conflict.cause)).toContain('stored cycle differs from deterministic acquisition input')
      }
    }
    expect(result.count).toBe(1)
  })

  test('atomically persists publications, rejects invalid timing/provenance, and serializes competing bindings', async () => {
    const temporalDraft = makeDraft('paper-account-temporal')
    const bindingDraft = makeDraft('paper-account-binding')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore

        yield* store.acquire(temporalDraft, '2026-03-06T20:58:00.000Z')
        const preClose = yield* Effect.exit(
          store.bindSnapshot(temporalDraft.identity.cycleId, makeInputManifest(snapshotA), '2026-03-06T20:59:00.000Z'),
        )
        const atClose = yield* store.bindSnapshot(
          temporalDraft.identity.cycleId,
          makeInputManifest(snapshotA),
          temporalDraft.window.signalCloseAt,
        )

        yield* store.acquire(bindingDraft, acquireAt)
        yield* insertSnapshotReference(missingSnapshot)
        const missingReference = yield* Effect.exit(
          store.bindSnapshot(bindingDraft.identity.cycleId, makeInputManifest(missingSnapshot), snapshotAt),
        )
        const staleReference = yield* Effect.exit(
          store.bindSnapshot(
            bindingDraft.identity.cycleId,
            makeInputManifest(staleSnapshot, { lastSession: '2026-03-05' }),
            snapshotAt,
          ),
        )
        const wrongCalendarReference = yield* Effect.exit(
          store.bindSnapshot(
            bindingDraft.identity.cycleId,
            makeInputManifest(wrongCalendarSnapshot, { calendarVersion: 'signal-XNYS-2026-revised' }),
            snapshotAt,
          ),
        )
        const bindingExits = yield* Effect.all(
          [
            Effect.exit(store.bindSnapshot(bindingDraft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)),
            Effect.exit(store.bindSnapshot(bindingDraft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)),
          ],
          { concurrency: 'unbounded' },
        )
        const selectedSnapshot = bindingExits.find(Exit.isSuccess)?.value.cycle.bindings.snapshotId ?? snapshotA
        const rebound = yield* store.bindSnapshot(
          bindingDraft.identity.cycleId,
          makeInputManifest(selectedSnapshot),
          snapshotAt,
        )
        const sql = yield* PgClient.PgClient
        const references = yield* sql<{ snapshot_id: string }>`
          SELECT snapshot_id
          FROM snapshot_references
          ORDER BY snapshot_id
        `
        return {
          atClose,
          bindingExits,
          missingReference,
          preClose,
          references,
          rebound,
          staleReference,
          wrongCalendarReference,
        }
      }),
    )

    expect(Exit.isFailure(result.preClose)).toBe(true)
    if (Exit.isFailure(result.preClose)) {
      expect(Cause.pretty(result.preClose.cause)).toContain('snapshot binding cannot precede the Signal session close')
    }
    expect(result.atClose.changed).toBe(true)
    expect(Exit.isFailure(result.missingReference)).toBe(true)
    if (Exit.isFailure(result.missingReference)) {
      expect(Cause.pretty(result.missingReference.cause)).toContain(
        'stored snapshot reference diverged from the finalized Signal publication',
      )
    }
    expect(Exit.isFailure(result.staleReference)).toBe(true)
    if (Exit.isFailure(result.staleReference)) {
      expect(Cause.pretty(result.staleReference.cause)).toContain(
        'finalized Signal publication does not match the cycle signal session and calendar',
      )
    }
    expect(Exit.isFailure(result.wrongCalendarReference)).toBe(true)
    if (Exit.isFailure(result.wrongCalendarReference)) {
      expect(Cause.pretty(result.wrongCalendarReference.cause)).toContain(
        'finalized Signal publication does not match the cycle signal session and calendar',
      )
    }
    expect(result.bindingExits.filter(Exit.isSuccess)).toHaveLength(1)
    expect(result.bindingExits.filter(Exit.isFailure)).toHaveLength(1)
    expect(result.rebound.changed).toBe(false)
    expect(result.references.map((row) => row.snapshot_id)).not.toContain(staleSnapshot)
    expect(result.references.map((row) => row.snapshot_id)).not.toContain(wrongCalendarSnapshot)
    const reboundSnapshotId = result.rebound.cycle.bindings.snapshotId
    if (reboundSnapshotId === undefined) throw new Error('successful binding must retain its snapshot ID')
    expect(result.references.map((row) => row.snapshot_id)).toContain(reboundSnapshotId)
  })

  test('rolls back snapshot persistence when publication as-of identity differs from the cycle session', async () => {
    const draft = makeDraft('paper-account-as-of-mismatch')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)

        const binding = yield* Effect.exit(
          store.bindSnapshot(
            draft.identity.cycleId,
            makeInputManifest(wrongAsOfSnapshot, { asOfSession: '2026-03-05' }),
            snapshotAt,
          ),
        )
        const cycle = yield* store.read(draft.identity.cycleId)
        const sql = yield* PgClient.PgClient
        const [reference] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM snapshot_references
          WHERE snapshot_id = ${wrongAsOfSnapshot}
        `
        return { binding, cycle, referenceCount: reference.count }
      }),
    )

    expect(Exit.isFailure(result.binding)).toBe(true)
    expect(result.referenceCount).toBe(0)
    expect(Option.isSome(result.cycle)).toBe(true)
    if (Option.isNone(result.cycle)) throw new Error('acquired cycle must remain readable after rejected binding')
    expect(result.cycle.value).toMatchObject({
      state: CycleState.Pending,
      bindings: {},
    })
  })

  test('atomically binds one content-hashed shadow decision with replay and zero dispatch state', async () => {
    const draft = makeDraft('paper-account-shadow-binding')
    const document = makeShadowDecision(draft, snapshotA)
    const divergent = makeShadowDecision(draft, snapshotA, { strategyDecisionHash: '7'.repeat(64) })
    const wrongSnapshot = makeShadowDecision(draft, snapshotA, { snapshotContentHash: '7'.repeat(64) })
    const backdated = makeShadowDecision(draft, snapshotA, { createdAt: snapshotAt })
    const futureDated = makeShadowDecision(draft, snapshotA, { createdAt: terminalAt })
    const missingDocumentDraft = makeDraft('paper-account-shadow-missing-document')
    const orphanDocumentDraft = makeDraft('paper-account-shadow-orphan-document')
    const orphanDocument = makeShadowDecision(orphanDocumentDraft, snapshotB)

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        yield* store.activate(draft.identity.cycleId, activeAt)

        const missingEvidence = yield* Effect.exit(store.bindDecision(draft.identity.cycleId, document, decisionAt))
        yield* insertShadowReconciliation(draft)
        const wrongEvidence = yield* Effect.exit(store.bindDecision(draft.identity.cycleId, wrongSnapshot, decisionAt))
        const backdatedBinding = yield* Effect.exit(store.bindDecision(draft.identity.cycleId, backdated, decisionAt))
        const futureBinding = yield* Effect.exit(store.bindDecision(draft.identity.cycleId, futureDated, decisionAt))
        const bound = yield* store.bindDecision(draft.identity.cycleId, document, decisionAt)
        const replay = yield* store.bindDecision(draft.identity.cycleId, structuredClone(document), decisionAt)
        const storedDocument = yield* store.readDecisionDocument(draft.identity.cycleId)
        const authoritySlot = yield* store.readAuthoritySlot({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
          signalSessionDate: draft.identity.signalSessionDate,
        })
        const conflict = yield* Effect.exit(store.bindDecision(draft.identity.cycleId, divergent, decisionAt))

        yield* store.acquire(missingDocumentDraft, acquireAt)
        yield* store.bindSnapshot(missingDocumentDraft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        yield* store.activate(missingDocumentDraft.identity.cycleId, activeAt)

        yield* store.acquire(orphanDocumentDraft, acquireAt)
        yield* store.bindSnapshot(orphanDocumentDraft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)
        yield* store.activate(orphanDocumentDraft.identity.cycleId, activeAt)

        const sql = yield* PgClient.PgClient
        const missingDocument = yield* Effect.exit(
          sql.withTransaction(sql`
            UPDATE autonomous_cycles
            SET
              decision_hash = ${'8'.repeat(64)},
              state_version = state_version + 1,
              updated_at = ${decisionAt}
            WHERE cycle_id = ${missingDocumentDraft.identity.cycleId}
          `),
        )
        const orphanDocumentInsert = yield* Effect.exit(
          sql.withTransaction(sql`
            INSERT INTO autonomous_cycle_shadow_decisions (
              cycle_id,
              schema_version,
              document,
              created_at
            ) VALUES (
              ${orphanDocumentDraft.identity.cycleId},
              ${orphanDocument.schemaVersion},
              ${sql.json(orphanDocument)},
              ${orphanDocument.createdAt}
            )
          `),
        )
        const directUpdate = yield* Effect.exit(sql`
          UPDATE autonomous_cycle_shadow_decisions
          SET document = ${sql.json(document)}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directDelete = yield* Effect.exit(sql`
          DELETE FROM autonomous_cycle_shadow_decisions
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directTruncate = yield* Effect.exit(sql`TRUNCATE autonomous_cycle_shadow_decisions`)
        const rows = yield* sql<{
          cycle_decision_hash: string
          document_decision_hash: string
          document: unknown
        }>`
          SELECT
            cycle.decision_hash AS cycle_decision_hash,
            shadow.decision_hash AS document_decision_hash,
            shadow.document
          FROM autonomous_cycles AS cycle
          JOIN autonomous_cycle_shadow_decisions AS shadow USING (cycle_id)
          WHERE cycle.cycle_id = ${draft.identity.cycleId}
        `
        const [counts] = yield* sql<{
          intents: number
          mutation_events: number
          risk_decisions: number
          shadow_decisions: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM autonomous_cycle_shadow_decisions) AS shadow_decisions,
            (SELECT count(*)::integer FROM intents) AS intents,
            (SELECT count(*)::integer FROM risk_decisions) AS risk_decisions,
            (SELECT count(*)::integer FROM mutation_events) AS mutation_events
        `
        return {
          authoritySlot,
          backdatedBinding,
          bound,
          conflict,
          counts,
          directDelete,
          directTruncate,
          directUpdate,
          futureBinding,
          missingDocument,
          missingEvidence,
          orphanDocumentInsert,
          replay,
          rows,
          storedDocument,
          wrongEvidence,
        }
      }),
    )

    expect(result.bound.changed).toBe(true)
    expect(result.bound.cycle.bindings).toEqual({
      snapshotId: snapshotA,
      decisionHash: document.contentHash,
    })
    expect(result.replay.changed).toBe(false)
    expect(result.replay.cycle).toEqual(result.bound.cycle)
    expect(Option.isSome(result.storedDocument)).toBe(true)
    if (Option.isNone(result.storedDocument)) throw new Error('bound decision document must remain readable')
    expect(result.storedDocument.value).toEqual(document)
    expect(Option.isSome(result.authoritySlot)).toBe(true)
    if (Option.isNone(result.authoritySlot)) throw new Error('bound authority slot must remain readable')
    expect(result.authoritySlot.value).toEqual(result.bound.cycle)
    expect(Exit.isFailure(result.conflict)).toBe(true)
    expect(Exit.isFailure(result.missingEvidence)).toBe(true)
    expect(Exit.isFailure(result.wrongEvidence)).toBe(true)
    expect(Exit.isFailure(result.backdatedBinding)).toBe(true)
    expect(Exit.isFailure(result.futureBinding)).toBe(true)
    expect(Exit.isFailure(result.missingDocument)).toBe(true)
    expect(Exit.isFailure(result.orphanDocumentInsert)).toBe(true)
    expect(Exit.isFailure(result.directUpdate)).toBe(true)
    expect(Exit.isFailure(result.directDelete)).toBe(true)
    expect(Exit.isFailure(result.directTruncate)).toBe(true)
    expect(result.rows).toEqual([
      {
        cycle_decision_hash: document.contentHash,
        document_decision_hash: document.contentHash,
        document,
      },
    ])
    expect(result.counts).toEqual({
      shadow_decisions: 1,
      intents: 0,
      risk_decisions: 0,
      mutation_events: 0,
    })
  })

  test('finishes the exact no-trade decision once after cutoff and preserves terminal history across runtimes', async () => {
    const draft = makeDraft()
    const shadowDecision = makeShadowDecision(draft, snapshotA)
    const afterCutoff = new Date(Date.parse(draft.window.submissionCutoffAt) + 1).toISOString()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        yield* store.activate(draft.identity.cycleId, activeAt)
        yield* insertShadowReconciliation(draft)
        yield* store.bindDecision(draft.identity.cycleId, shadowDecision, decisionAt)

        const sql = yield* PgClient.PgClient
        const directCompleted = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Completed},
            state_version = state_version + 1,
            updated_at = ${terminalAt},
            terminal_at = ${terminalAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const mismatchedFinish = yield* Effect.exit(
          store.finish(draft.identity.cycleId, CycleState.Completed, terminalAt),
        )
        const finishes = yield* Effect.all(
          [
            store.finish(draft.identity.cycleId, CycleState.NoTrade, afterCutoff),
            store.finish(draft.identity.cycleId, CycleState.NoTrade, afterCutoff),
          ],
          { concurrency: 'unbounded' },
        )
        const finished = finishes.find((receipt) => receipt.changed)
        const retried = finishes.find((receipt) => !receipt.changed)
        if (finished === undefined || retried === undefined) {
          return yield* Effect.die(new Error('concurrent finish fixture requires one mutation and one replay'))
        }
        const rejectedRewrite = yield* Effect.exit(
          store.block(draft.identity.cycleId, CycleTerminalReason.Reconciliation, afterCutoff),
        )
        const directUpdate = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET updated_at = ${new Date(Date.parse(afterCutoff) + 1).toISOString()}, state_version = state_version + 1
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directDelete = yield* Effect.exit(sql`
          DELETE FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
        `)
        return {
          directCompleted,
          directDelete,
          directUpdate,
          finished,
          mismatchedFinish,
          rejectedRewrite,
          retried,
        }
      }),
    )

    expect(Exit.isFailure(result.directCompleted)).toBe(true)
    expect(Exit.isFailure(result.mismatchedFinish)).toBe(true)
    expect(result.finished.cycle).toMatchObject({
      state: CycleState.NoTrade,
      bindings: {
        snapshotId: snapshotA,
        decisionHash: shadowDecision.contentHash,
      },
      terminalAt: afterCutoff,
    })
    expect(result.finished.cycle.terminalReason).toBeUndefined()
    expect(result.retried.changed).toBe(false)
    expect(result.retried.cycle).toEqual(result.finished.cycle)
    expect(Exit.isFailure(result.rejectedRewrite)).toBe(true)
    expect(Exit.isFailure(result.directUpdate)).toBe(true)
    expect(Exit.isFailure(result.directDelete)).toBe(true)

    const secondRuntime = makeRuntime()
    const durable = await secondRuntime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        return {
          cycle: yield* store.read(draft.identity.cycleId),
          document: yield* store.readDecisionDocument(draft.identity.cycleId),
        }
      }),
    )
    await secondRuntime.dispose()
    expect(Option.isSome(durable.cycle)).toBe(true)
    if (Option.isSome(durable.cycle)) expect(durable.cycle.value).toEqual(result.finished.cycle)
    expect(Option.isSome(durable.document)).toBe(true)
    if (Option.isSome(durable.document)) expect(durable.document.value).toEqual(shadowDecision)
  })

  test('requires decision-bound blocking to match the exact target-plan reason', async () => {
    const storeDraft = makeDraft('paper-account-blocked-store')
    const directDraft = makeDraft('paper-account-blocked-direct')
    const storeDocument = makeShadowDecision(storeDraft, snapshotA, {
      blockedReason: TargetPlanReason.InputStale,
    })
    const directDocument = makeShadowDecision(directDraft, snapshotB, {
      blockedReason: TargetPlanReason.InputStale,
    })

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(storeDraft, acquireAt)
        yield* store.bindSnapshot(storeDraft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        yield* store.activate(storeDraft.identity.cycleId, activeAt)
        yield* insertShadowReconciliation(storeDraft)
        yield* store.bindDecision(storeDraft.identity.cycleId, storeDocument, decisionAt)
        const storeMismatch = yield* Effect.exit(
          store.block(storeDraft.identity.cycleId, CycleTerminalReason.Reconciliation, terminalAt),
        )
        const storeMatch = yield* store.block(storeDraft.identity.cycleId, CycleTerminalReason.DataStale, terminalAt)

        yield* store.acquire(directDraft, acquireAt)
        yield* store.bindSnapshot(directDraft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)
        yield* store.activate(directDraft.identity.cycleId, activeAt)
        yield* insertShadowReconciliation(directDraft)
        yield* store.bindDecision(directDraft.identity.cycleId, directDocument, decisionAt)
        const sql = yield* PgClient.PgClient
        const directMismatch = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Reconciliation},
            state_version = state_version + 1,
            updated_at = ${terminalAt},
            terminal_at = ${terminalAt}
          WHERE cycle_id = ${directDraft.identity.cycleId}
        `)
        yield* sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.DataStale},
            state_version = state_version + 1,
            updated_at = ${terminalAt},
            terminal_at = ${terminalAt}
          WHERE cycle_id = ${directDraft.identity.cycleId}
        `
        return {
          directCycle: yield* store.read(directDraft.identity.cycleId),
          directMismatch,
          storeMatch,
          storeMismatch,
        }
      }),
    )

    expect(Exit.isFailure(result.storeMismatch)).toBe(true)
    expect(result.storeMatch.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.DataStale,
      bindings: { decisionHash: storeDocument.contentHash },
    })
    expect(Exit.isFailure(result.directMismatch)).toBe(true)
    expect(Option.isSome(result.directCycle)).toBe(true)
    if (Option.isSome(result.directCycle)) {
      expect(result.directCycle.value).toMatchObject({
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.DataStale,
        bindings: { decisionHash: directDocument.contentHash },
      })
    }
  })

  test('enforces initial lifecycle state and distinct publication and submission deadlines', async () => {
    const initialDraft = makeDraft('paper-account-initial')
    const missedDraft = makeDraft('paper-account-missed-publication')
    const activationDraft = makeDraft('paper-account-activation-cutoff')
    const afterCutoffDraft = makeDraft('paper-account-after-cutoff')
    const decisionDraft = makeDraft('paper-account-decision-cutoff')
    const lateBindingDraft = makeDraft('paper-account-late-snapshot')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(initialDraft, acquireAt)
        yield* store.bindSnapshot(initialDraft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const sql = yield* PgClient.PgClient
        const invalidInitialActive = yield* Effect.exit(sql`
          INSERT INTO autonomous_cycles (
            cycle_id, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, account_id,
            signal_session_date, signal_calendar_version,
            execution_policy_schema_version, execution_policy_hash,
            strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
            window_schema_version, execution_calendar_schema_version,
            execution_calendar_source, execution_calendar_hash, execution_session_date,
            signal_close_at, publication_deadline_at, submission_open_at,
            execution_open_at, execution_close_at, submission_cutoff_at,
            state, snapshot_id, decision_hash, terminal_reason, state_version,
            created_at, updated_at, terminal_at
          )
          SELECT
            ${'8'.repeat(64)}, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, 'paper-account-invalid-initial',
            signal_session_date, signal_calendar_version,
            execution_policy_schema_version, execution_policy_hash,
            strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
            window_schema_version, execution_calendar_schema_version,
            execution_calendar_source, execution_calendar_hash, execution_session_date,
            signal_close_at, publication_deadline_at, submission_open_at,
            execution_open_at, execution_close_at, submission_cutoff_at,
            ${CycleState.Active}, snapshot_id, NULL, NULL, 1,
            updated_at, updated_at, NULL
          FROM autonomous_cycles
          WHERE cycle_id = ${initialDraft.identity.cycleId}
        `)

        const missed = yield* store.acquire(missedDraft, missedDraft.window.publicationDeadlineAt)

        yield* store.acquire(lateBindingDraft, acquireAt)
        const directLateBinding = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            snapshot_id = ${snapshotA},
            state_version = state_version + 1,
            updated_at = ${lateBindingDraft.window.publicationDeadlineAt}
          WHERE cycle_id = ${lateBindingDraft.identity.cycleId}
        `)

        yield* store.acquire(activationDraft, acquireAt)
        yield* store.bindSnapshot(activationDraft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const earlySubmissionMiss = yield* Effect.exit(
          store.block(
            activationDraft.identity.cycleId,
            CycleTerminalReason.MissedSubmission,
            activationDraft.window.submissionOpenAt,
          ),
        )
        const activationAtCutoff = yield* store.activate(
          activationDraft.identity.cycleId,
          activationDraft.window.submissionCutoffAt,
        )

        yield* store.acquire(afterCutoffDraft, acquireAt)
        yield* store.bindSnapshot(afterCutoffDraft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const activationAfterCutoff = yield* store.activate(
          afterCutoffDraft.identity.cycleId,
          new Date(Date.parse(afterCutoffDraft.window.submissionCutoffAt) + 1).toISOString(),
        )

        yield* store.acquire(decisionDraft, acquireAt)
        yield* store.bindSnapshot(decisionDraft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)
        yield* store.activate(decisionDraft.identity.cycleId, activeAt)
        const decisionAtCutoff = yield* store.bindDecision(
          decisionDraft.identity.cycleId,
          makeShadowDecision(decisionDraft, snapshotB),
          decisionDraft.window.submissionCutoffAt,
        )

        return {
          activationAfterCutoff,
          activationAtCutoff,
          decisionAtCutoff,
          directLateBinding,
          earlySubmissionMiss,
          invalidInitialActive,
          missed,
        }
      }),
    )

    expect(Exit.isFailure(result.invalidInitialActive)).toBe(true)
    expect(result.missed.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedPublication,
      terminalAt: missedDraft.window.publicationDeadlineAt,
    })
    expect(Exit.isFailure(result.earlySubmissionMiss)).toBe(true)
    expect(Exit.isFailure(result.directLateBinding)).toBe(true)
    if (Exit.isFailure(result.directLateBinding)) {
      expect(Cause.pretty(result.directLateBinding.cause)).toContain(
        'autonomous cycle snapshot missed publication deadline',
      )
    }
    expect(result.activationAtCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
      terminalAt: activationDraft.window.submissionCutoffAt,
    })
    expect(result.activationAfterCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
    })
    expect(result.activationAfterCutoff.cycle.terminalAt).toBeDefined()
    if (result.activationAfterCutoff.cycle.terminalAt !== undefined) {
      expect(result.activationAfterCutoff.cycle.terminalAt > afterCutoffDraft.window.submissionCutoffAt).toBe(true)
    }
    expect(result.decisionAtCutoff.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
      terminalAt: decisionDraft.window.submissionCutoffAt,
    })
    expect(result.decisionAtCutoff.cycle.bindings.decisionHash).toBeUndefined()
    expect(decisionDraft.window.submissionCutoffAt < decisionDraft.window.executionOpenAt).toBe(true)
  })
})
