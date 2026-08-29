import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'

import qualifiedCycleSnapshotBinding from '../../../migrations/0036_qualified_cycle_snapshot_binding'
import {
  AccountStatus as BrokerAccountStatus,
  BrokerRead,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type ReadEvidence,
} from '../../broker/alpaca'
import { unusedAssetBySymbol } from '../../broker/alpaca-test-support'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../../broker/identity'
import type { RuntimeConfig } from '../../config'
import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeIntradayCycleWindow,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  isIntradayCycleDraft,
  isLegacyAutonomousCycle,
  isLegacyCycleDraft,
  type AutonomousCycle,
  type CycleDraft,
  type CycleExecutionPolicy,
  type IntradayCycleDraft,
  type LegacyAutonomousCycle,
  type LegacyCycleDraft,
} from '../index'
import {
  CycleDecisionBuildError,
  makeDueCycleDraft,
  runAutonomousCyclePass,
  selectNextExecutionSession,
  type CycleRunContext,
  type CycleRunResult,
} from '../runner'
import { runAutonomousCycleUntilSettled } from '../runner/program'
import { AuthorityGenerationStore, ExecutionStoreLive } from '../../db/execution-store'
import { WriterFence, WriterFenceLive } from '../../execution/writer-fence'
import { BlockedCycleIntentStore, BlockedCycleIntentStoreLive } from '../../execution/intents'
import { canonicalHashV1, sha256 } from '../../hash'
import { Journal, type JournalService } from '../../ledger'
import {
  type ArchiveVerifiedIntradaySnapshotReference,
  MarketData,
  type FinalizedPublicationInspection,
  type MarketDataService,
  type MarketDataSnapshot,
  type SignalSessionRow,
} from '../../market-data'
import {
  buildMutationShadowCycleDecision,
  buildObserveCycleDecision,
  loadObserveRiskPolicy,
  prepareObserveStartup,
  terminalizeBlockedExecutionCycle,
  type ObserveDecisionFailure,
} from '../../observe-composition'
import {
  AccountStatus,
  Authority,
  IntentState,
  KillState,
  makeResearchCapitalGrantGenerationResult,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TimeInForce,
} from '../../execution/contracts'
import { BrokerAccess, noCapitalAuthority } from '../../execution/authority'
import { planExecutionIntent } from '../../execution/intents'
import { runOnce, type ReconciliationPassResult } from '../../reconciler'
import { reconciledStateHash } from '../../reconciliation'
import { readForwardPerformancePostgres } from '../../forward-performance/postgres'
import { Gate, Reason, type Policy } from '../../risk'
import {
  makeObserveShadowDecisionDocument,
  makeExecutionDecisionDocument,
  type ExecutionDecisionDocument,
} from '../../shadow-decision-contract'
import { makeRiskBalancedTrendDefinition } from '../../strategy'
import { defaultOpeningDriveProtocolHash, openingDriveExecutionModel } from '../../strategy/opening-drive'
import {
  defaultIntradayMomentumProtocolDocument,
  intradayMomentumExecutionModel,
} from '../../strategy/intraday-momentum/protocol'
import { TargetPlanReason, TargetPlanStatus } from '../../target-planner'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from '../../test-fixtures'
import { baynTestPostgresUrl, isGithubActions } from '../../test-environment.test-support'
import { utcDateFromEpochMillis, utcInstantFromEpochMillis } from '../../time'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DecisionPlan,
  type DailyBar,
  type InputManifest,
  type IsoDate,
  type Protocol,
} from '../../types'
import { PostgresClientLive } from '../../db/evidence-store'
import { migrationLoader } from '../../db/migrations'
import { ensureSnapshotReference } from '../../db/snapshot-reference'
import { CycleStore, CycleStoreLive, WriterFencedCycleStoreLive, type CycleStoreShape } from '.'
import { makeCycleQueries } from './queries'

const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const migrationLoaderBeforeIntradayNativeCycles = migrationLoader.pipe(
  Effect.map((migrations) => migrations.filter(([migrationId]) => migrationId < 46)),
)
const postgresUrl = baynTestPostgresUrl
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

interface CommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

const runCommand = async (command: readonly string[]): Promise<CommandResult> => {
  const childProcess = Bun.spawn({ cmd: [...command], stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    childProcess.exited,
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

const requireCommand = async (command: readonly string[]): Promise<string> => {
  const result = await runCommand(command)
  if (result.exitCode !== 0) {
    throw new Error(
      `command failed (${command.join(' ')}): ${result.stderr.length === 0 ? result.stdout : result.stderr}`,
    )
  }
  return result.stdout
}

interface PostgresProcessRestartEvidence {
  readonly containerId: string
  readonly image: string
  readonly startedAtBefore: string
  readonly startedAtAfter: string
}

const restartGithubPostgres18Process = async (): Promise<PostgresProcessRestartEvidence | undefined> => {
  if (!isGithubActions) return undefined

  const url = new URL(testUrl)
  const port = url.port.length === 0 ? '5432' : url.port
  const database = url.pathname.slice(1)
  const containers = (
    await requireCommand(['docker', 'ps', '--filter', `publish=${port}`, '--format', '{{.ID}}\t{{.Image}}'])
  )
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [containerId, image] = line.split('\t')
      return { containerId, image }
    })
    .filter(
      (entry): entry is { readonly containerId: string; readonly image: string } =>
        entry.containerId !== undefined && entry.image !== undefined && /^postgres:18(?:-|$)/.test(entry.image),
    )

  if (containers.length !== 1) {
    throw new Error(`expected exactly one published PostgreSQL 18 service container, found ${containers.length}`)
  }
  const [{ containerId, image }] = containers
  const startedAtBefore = await requireCommand(['docker', 'inspect', '--format', '{{.State.StartedAt}}', containerId])

  await requireCommand(['docker', 'restart', '--time', '0', containerId])
  let ready = false
  let lastReadiness = ''
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await runCommand([
      'docker',
      'exec',
      containerId,
      'pg_isready',
      '-U',
      decodeURIComponent(url.username),
      '-d',
      decodeURIComponent(database),
    ])
    lastReadiness = result.stderr.length === 0 ? result.stdout : result.stderr
    if (result.exitCode === 0) {
      ready = true
      break
    }
    await Bun.sleep(250)
  }
  if (!ready) throw new Error(`PostgreSQL 18 did not become ready after process restart: ${lastReadiness}`)

  const startedAtAfter = await requireCommand(['docker', 'inspect', '--format', '{{.State.StartedAt}}', containerId])
  if (startedAtAfter === startedAtBefore) {
    throw new Error('PostgreSQL 18 service container did not record a new process start')
  }
  return { containerId, image, startedAtBefore, startedAtAfter }
}

const makeRuntime = () =>
  ManagedRuntime.make(
    CycleStoreLive.pipe(Layer.provideMerge(PostgresClientLive(databaseConfig)), Layer.provideMerge(NodeServices.layer)),
  )

const makeWriterFencedRuntime = () =>
  ManagedRuntime.make(
    WriterFencedCycleStoreLive.pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(PostgresClientLive(databaseConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const dueAccountId = '13354000-0000-4000-8000-000000000054'
const dueBrokerIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: dueAccountId,
  }),
)
const dueAuthorityGenerationHash = '5'.repeat(64)
const dueSignalDate = '2099-12-31' as const
const dueExecutionDate = '2100-01-04' as const
const dueHistoryStart = '2089-06-03' as const
const dueEvaluationStart = '2090-06-05' as const
const dueAcquisitionAt = '2099-12-31T21:01:02.000Z'
const dueObservedAt = '2100-01-04T13:45:02.000Z'
const dueSnapshotId = '4'.repeat(64)

const dueProtocol: Protocol = {
  ...fixtureProtocol,
  historyStart: dueHistoryStart,
  evaluationStart: dueEvaluationStart,
}
const dueStrategy = {
  definition: makeRiskBalancedTrendDefinition(dueProtocol),
  provenance: makeTestProvenance(dueProtocol),
} as const

const autonomousRuntimeConfig: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  execution: {
    brokerIdentity: dueBrokerIdentity,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  build: {
    sourceRevision: '1'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${'2'.repeat(64)}`,
    strategyBehaviorHash: dueStrategy.provenance.strategy.behaviorHash,
    strategyParameterHash: dueStrategy.provenance.strategy.parameterHash,
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: databaseConfig.operationTimeoutMs,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: dueSnapshotId,
    publicationAsOf: dueSignalDate,
    calendarVersion: 'fixture-calendar-v2',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: dueHistoryStart,
      dataEnd: dueSignalDate,
      lookbackStart: dueHistoryStart,
      evaluationStart: dueEvaluationStart,
      evaluationEnd: dueSignalDate,
    },
  },
  postgres: databaseConfig.postgres,
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7_001 },
}

const autonomousJournal: JournalService = {
  post: () => Effect.void,
  verifyAccount: () => Effect.succeed(true),
  journalAndReconcile: () => Effect.die(new Error('autonomous OBSERVE proof must not run simulation journaling')),
  check: Effect.void,
  checkRun: () => Effect.void,
}

const makeAutonomousRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, ExecutionStoreLive(autonomousRuntimeConfig), BlockedCycleIntentStoreLive).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(Layer.succeed(Journal, autonomousJournal)),
      Layer.provideMerge(PostgresClientLive(autonomousRuntimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const weekdaySessions = (start: IsoDate, count: number): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  let cursor = DateTime.makeUnsafe(`${start}T00:00:00.000Z`)
  while (sessions.length < count) {
    const day = DateTime.getPartUtc(cursor, 'weekDay')
    if (day !== 0 && day !== 6) sessions.push(DateTime.formatIsoDate(cursor) as IsoDate)
    cursor = DateTime.add(cursor, { days: 1 })
  }
  return sessions
}

const dueBaseSnapshot = makeSnapshot(2_760)
const dueBaseSessionDates = [...new Set(dueBaseSnapshot.bars.map((bar) => bar.sessionDate))].sort()
const dueSessionDates = weekdaySessions(dueHistoryStart, dueBaseSessionDates.length)
if (
  dueSessionDates.at(-1) !== dueSignalDate ||
  dueSessionDates[dueBaseSessionDates.indexOf(fixtureProtocol.evaluationStart)] !== dueEvaluationStart
) {
  throw new Error('autonomous due-cycle fixture calendar does not match its deterministic protocol dates')
}
const dueSessionByBaseSession = new Map(dueBaseSessionDates.map((session, index) => [session, dueSessionDates[index]]))
const dueBars: readonly DailyBar[] = dueBaseSnapshot.bars.map((bar) => {
  const sessionDate = dueSessionByBaseSession.get(bar.sessionDate)
  if (sessionDate === undefined) throw new Error(`missing shifted session for ${bar.sessionDate}`)
  return { ...bar, sessionDate }
})
const { hash: _dueSourceManifestHash, ...dueSourceManifestMaterial } = dueBaseSnapshot.manifest
const dueManifestMaterial: Omit<InputManifest, 'hash'> = {
  ...dueSourceManifestMaterial,
  bounds: {
    ...dueSourceManifestMaterial.bounds,
    dataStart: dueHistoryStart,
    dataEnd: dueSignalDate,
    lookbackStart: dueHistoryStart,
    evaluationStart: dueEvaluationStart,
    evaluationEnd: dueSignalDate,
  },
  firstSession: dueHistoryStart,
  lastSession: dueSignalDate,
  symbols: dueSourceManifestMaterial.symbols.map((symbol) => ({
    ...symbol,
    firstSession: dueHistoryStart,
    lastSession: dueSignalDate,
  })),
  finalizedSnapshot: {
    ...dueSourceManifestMaterial.finalizedSnapshot,
    snapshotId: dueSnapshotId,
    publicationId: '3'.repeat(64),
    finalizedAt: '2099-12-31T21:01:00.000Z',
    requestedStart: dueHistoryStart,
    firstSession: dueHistoryStart,
    lastSession: dueSignalDate,
    asOfSession: dueSignalDate,
  },
}
const dueManifest: InputManifest = {
  ...dueManifestMaterial,
  hash: canonicalHashV1(dueManifestMaterial),
}
const duePublication = (): Extract<FinalizedPublicationInspection, { readonly outcome: 'FINALIZED' }> => ({
  outcome: 'FINALIZED',
  observedAt: '2099-12-31T21:01:00.000Z',
  inspection: {
    manifest: dueManifest,
    sessionDates: dueSessionDates,
    signalSession: {
      calendar_version: dueManifest.finalizedSnapshot.calendarVersion,
      session_date: dueSignalDate,
      close_time: '16:00',
      timezone: 'America/New_York',
    },
  },
})

const dueCalendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: dueSignalDate, end: '2100-01-30' },
  timeZone: 'UTC' as const,
  sessions: [
    {
      date: dueSignalDate,
      openAt: '2099-12-31T14:30:00.000Z',
      closeAt: '2099-12-31T21:00:00.000Z',
    },
    {
      date: dueExecutionDate,
      openAt: '2100-01-04T14:30:00.000Z',
      closeAt: '2100-01-04T21:00:00.000Z',
    },
  ],
}
const dueCalendar: MarketCalendarObservation = {
  ...dueCalendarMaterial,
  normalizedResponseHash: canonicalHashV1(dueCalendarMaterial),
}

interface DueIoControl {
  accountReads: number
  calendarReads: number
  discoveryReads: number
  fillReads: number
  orderReads: number
  positionReads: number
  publicationReads: number
  snapshotLoads: number
}

const makeDueIoControl = (): DueIoControl => ({
  accountReads: 0,
  calendarReads: 0,
  discoveryReads: 0,
  fillReads: 0,
  orderReads: 0,
  positionReads: 0,
  publicationReads: 0,
  snapshotLoads: 0,
})

const dueReadEvidence = (identity: string, observedAt = dueObservedAt): ReadEvidence => ({
  requestId: `pr13354-${identity}`,
  status: 200,
  contentHash: canonicalHashV1({ identity }),
  observedAt,
})

const dueBrokerRead = (control: DueIoControl): BrokerReadShape => {
  const unused = Effect.die(new Error('autonomous durability proof used an unrelated broker capability'))
  return {
    account: Effect.sync(() => {
      control.accountReads += 1
      return {
        value: {
          id: dueAccountId,
          status: BrokerAccountStatus.Active,
          currency: 'USD',
          cashMicros: '1000000000',
          equityMicros: '1000000000',
          lastEquityMicros: '1000000000',
          buyingPowerMicros: '1000000000',
          accountBlocked: false,
          tradingBlocked: false,
          tradeSuspendedByUser: false,
          observedAt: dueObservedAt,
        },
        evidence: dueReadEvidence('account'),
      }
    }),
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: Effect.sync(() => {
      control.positionReads += 1
      return { value: [], evidence: dueReadEvidence('positions') }
    }),
    orders: () =>
      Effect.sync(() => {
        control.orderReads += 1
        return { value: [], evidence: dueReadEvidence('orders') }
      }),
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () =>
      Effect.sync(() => {
        control.fillReads += 1
        return { value: { items: [] }, evidence: dueReadEvidence('fills') }
      }),
    marketCalendar: (query) =>
      Effect.sync(() => {
        control.calendarReads += 1
        if (query.start !== dueSignalDate || query.end !== dueCalendar.requestedRange.end) {
          throw new Error(`unexpected autonomous calendar query ${query.start}..${query.end}`)
        }
        return {
          value: dueCalendar,
          evidence: dueReadEvidence(
            `calendar-${control.calendarReads}`,
            control.calendarReads === 1 ? dueAcquisitionAt : dueObservedAt,
          ),
        }
      }),
  }
}

const dueMarketData = (control: DueIoControl, boundPublicationBoundary = Effect.void): MarketDataService => {
  const unused = Effect.die(new Error('autonomous durability proof used an unrelated market-data capability'))
  const inspectPublication = () =>
    Effect.sync(() => {
      control.publicationReads += 1
      return duePublication()
    })
  const inspectSnapshotPublication = () =>
    Effect.sync(() => {
      control.publicationReads += 1
    }).pipe(Effect.andThen(boundPublicationBoundary), Effect.as(duePublication()))
  return {
    check: unused,
    inspect: unused,
    inspectCyclePublications: Effect.sync(() => {
      control.discoveryReads += 1
      const publication = duePublication()
      return {
        outcome: 'FINALIZED' as const,
        observedAt: publication.observedAt,
        publications: [publication.inspection],
      }
    }),
    inspectPublication,
    inspectSnapshotPublication,
    loadSnapshotPublication: (request) =>
      Effect.sync(() => {
        control.snapshotLoads += 1
        if (
          request.snapshotId !== dueSnapshotId ||
          request.signalSessionDate !== dueSignalDate ||
          request.signalCalendarVersion !== dueManifest.finalizedSnapshot.calendarVersion
        ) {
          throw new Error('autonomous snapshot reload did not use the immutable cycle binding')
        }
        return { bars: dueBars, manifest: dueManifest }
      }),
    load: unused,
  }
}

const observeFailureToCycleDecision = (cause: ObserveDecisionFailure): CycleDecisionBuildError => {
  const failure =
    cause._tag === 'OperationalError'
      ? cause.component === 'database'
        ? 'database'
        : cause.component === 'market-data'
          ? 'market-data'
          : 'operational'
      : 'contract'
  const message =
    cause._tag === 'CycleCalendarQueryRangeOutOfRange'
      ? 'cycle decision calendar query construction failed'
      : cause.message
  return new CycleDecisionBuildError({ failure, message, cause })
}

const makeProductionDueContext = Effect.gen(function* () {
  const preparation = yield* Effect.fromResult(
    prepareObserveStartup({
      accountId: dueAccountId,
      authorityGenerationHash: dueAuthorityGenerationHash,
      pollIntervalMs: 30_000,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
      strategy: dueStrategy,
    }),
  )
  const policy = yield* loadObserveRiskPolicy(dueAccountId, dueProtocol.universe)
  return {
    qualificationRunId: '6'.repeat(64),
    strategyProtocolHash: preparation.strategyProtocolHash,
    accountId: dueAccountId,
    executionPolicy: preparation.executionPolicy,
    buildDecision: (cycle) =>
      buildObserveCycleDecision({
        authorityGenerationHash: dueAuthorityGenerationHash,
        cycle,
        executionModel: preparation.executionModel,
        policy,
        reconcile: runOnce,
        strategy: dueStrategy,
      }).pipe(Effect.mapError(observeFailureToCycleDecision)),
  } satisfies CycleRunContext<
    | BrokerRead
    | MarketData
    | import('../../db/execution-store').BrokerEventStore
    | import('../../db/execution-store').FillAccountingStore
    | import('../../db/execution-store').ValuationStore
    | import('../../db/execution-store').ReconciliationStore
    | import('../../db/execution-store').AuthorityRestrictionStore
    | import('../../execution/writer-fence').WriterFence
  >
})

const ensureDueObserveAuthority = AuthorityGenerationStore.pipe(
  Effect.flatMap((store) =>
    store.ensureAuthorityGeneration({
      generationHash: dueAuthorityGenerationHash,
      maximum: Authority.Observe,
    }),
  ),
)

interface DueDurabilityRows {
  readonly counts: {
    readonly brokerEvents: number
    readonly brokerOrderEvents: number
    readonly brokerOrders: number
    readonly cycles: number
    readonly distinctBrokerEvents: number
    readonly distinctReconciliations: number
    readonly distinctShadowDecisions: number
    readonly distinctSnapshots: number
    readonly intents: number
    readonly mutationEvents: number
    readonly reconciliations: number
    readonly riskDecisions: number
    readonly shadowDecisions: number
    readonly snapshots: number
    readonly unfinishedCycles: number
  }
  readonly cycle:
    | {
        readonly cycle_id: string
        readonly decision_hash: string | null
        readonly snapshot_id: string | null
        readonly state: string
        readonly terminal_at: Date | null
      }
    | undefined
  readonly reconciliation:
    | {
        readonly content_hash: string
        readonly reconciliation_id: string
        readonly status: string
      }
    | undefined
  readonly shadow:
    | {
        readonly cycle_id: string
        readonly decision_hash: string
        readonly document: unknown
      }
    | undefined
  readonly snapshot:
    | {
        readonly manifest: unknown
        readonly snapshot_id: string
      }
    | undefined
}

const readDueDurabilityRows = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [counts] = yield* sql<DueDurabilityRows['counts']>`
    SELECT
      (SELECT count(*)::integer FROM autonomous_cycles WHERE account_id = ${dueAccountId}) AS "cycles",
      (
        SELECT count(*)::integer
        FROM autonomous_cycles
        WHERE account_id = ${dueAccountId}
          AND state NOT IN (${CycleState.NoTrade}, ${CycleState.Completed}, ${CycleState.Blocked})
      ) AS "unfinishedCycles",
      (SELECT count(*)::integer FROM snapshot_references WHERE snapshot_id = ${dueSnapshotId}) AS "snapshots",
      (
        SELECT count(DISTINCT snapshot_id)::integer
        FROM snapshot_references
        WHERE snapshot_id = ${dueSnapshotId}
      ) AS "distinctSnapshots",
      (
        SELECT count(*)::integer
        FROM autonomous_cycle_shadow_decisions AS decision
        JOIN autonomous_cycles AS cycle USING (cycle_id)
        WHERE cycle.account_id = ${dueAccountId}
      ) AS "shadowDecisions",
      (
        SELECT count(DISTINCT decision.decision_hash)::integer
        FROM autonomous_cycle_shadow_decisions AS decision
        JOIN autonomous_cycles AS cycle USING (cycle_id)
        WHERE cycle.account_id = ${dueAccountId}
      ) AS "distinctShadowDecisions",
      (SELECT count(*)::integer FROM reconciliations WHERE account_id = ${dueAccountId}) AS "reconciliations",
      (
        SELECT count(DISTINCT content_hash)::integer
        FROM reconciliations
        WHERE account_id = ${dueAccountId}
      ) AS "distinctReconciliations",
      (SELECT count(*)::integer FROM intents WHERE account_id = ${dueAccountId}) AS "intents",
      (
        SELECT count(*)::integer
        FROM risk_decisions AS decision
        JOIN intents AS intent USING (intent_id)
        WHERE intent.account_id = ${dueAccountId}
      ) AS "riskDecisions",
      (
        SELECT count(*)::integer
        FROM mutation_events AS mutation
        JOIN intents AS intent USING (intent_id)
        WHERE intent.account_id = ${dueAccountId}
      ) AS "mutationEvents",
      (SELECT count(*)::integer FROM orders WHERE account_id = ${dueAccountId}) AS "brokerOrders",
      (
        SELECT count(*)::integer
        FROM broker_events
        WHERE account_id = ${dueAccountId} AND event_kind = 'ORDER'
      ) AS "brokerOrderEvents",
      (SELECT count(*)::integer FROM broker_events WHERE account_id = ${dueAccountId}) AS "brokerEvents",
      (
        SELECT count(DISTINCT event_id)::integer
        FROM broker_events
        WHERE account_id = ${dueAccountId}
      ) AS "distinctBrokerEvents"
  `
  if (counts === undefined) return yield* Effect.die(new Error('durability count query returned no row'))
  const [cycle] = yield* sql<NonNullable<DueDurabilityRows['cycle']>>`
    SELECT cycle_id, state, snapshot_id, decision_hash, terminal_at
    FROM autonomous_cycles
    WHERE account_id = ${dueAccountId}
  `
  const [snapshot] = yield* sql<NonNullable<DueDurabilityRows['snapshot']>>`
    SELECT snapshot_id, manifest
    FROM snapshot_references
    WHERE snapshot_id = ${dueSnapshotId}
  `
  const [shadow] = yield* sql<NonNullable<DueDurabilityRows['shadow']>>`
    SELECT decision.cycle_id, decision.decision_hash, decision.document
    FROM autonomous_cycle_shadow_decisions AS decision
    JOIN autonomous_cycles AS cycle USING (cycle_id)
    WHERE cycle.account_id = ${dueAccountId}
  `
  const [reconciliation] = yield* sql<NonNullable<DueDurabilityRows['reconciliation']>>`
    SELECT reconciliation_id, content_hash, status
    FROM reconciliations
    WHERE account_id = ${dueAccountId}
  `
  return { counts, cycle, reconciliation, shadow, snapshot }
})

const installShadowEvidenceFailure = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`
    CREATE FUNCTION pr13354_reject_shadow_evidence()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'pr13354 injected shadow evidence failure';
    END
    $function$
  `
  yield* sql`
    CREATE TRIGGER pr13354_reject_shadow_evidence
    BEFORE INSERT ON autonomous_cycle_shadow_decisions
    FOR EACH ROW EXECUTE FUNCTION pr13354_reject_shadow_evidence()
  `
})

const removeShadowEvidenceFailure = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP TRIGGER pr13354_reject_shadow_evidence ON autonomous_cycle_shadow_decisions`
  yield* sql`DROP FUNCTION pr13354_reject_shadow_evidence()`
})

const installTerminalTransitionFailure = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`
    CREATE FUNCTION pr13354_reject_terminal_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.state = 'ACTIVE' AND NEW.state IN ('NO_TRADE', 'COMPLETED') THEN
        RAISE EXCEPTION 'pr13354 injected terminal transition failure';
      END IF;
      RETURN NEW;
    END
    $function$
  `
  yield* sql`
    CREATE TRIGGER pr13354_reject_terminal_transition
    BEFORE UPDATE OF state ON autonomous_cycles
    FOR EACH ROW
    EXECUTE FUNCTION pr13354_reject_terminal_transition()
  `
})

const removeTerminalTransitionFailure = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP TRIGGER pr13354_reject_terminal_transition ON autonomous_cycles`
  yield* sql`DROP FUNCTION pr13354_reject_terminal_transition()`
})

const productionDuePass = (control: DueIoControl, phase: 'ACQUIRE_AND_DUE' | 'DUE' = 'DUE') =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(phase === 'ACQUIRE_AND_DUE' ? dueAcquisitionAt : dueObservedAt))
      yield* ensureDueObserveAuthority
      if (phase === 'DUE') {
        const context = yield* makeProductionDueContext
        return yield* runAutonomousCycleUntilSettled(context).pipe(
          Effect.provideService(BrokerRead, dueBrokerRead(control)),
          Effect.provideService(MarketData, dueMarketData(control)),
        )
      }
      const advanceRequested = yield* Deferred.make<void>()
      const advanceCompleted = yield* Deferred.make<void>()
      yield* Deferred.await(advanceRequested).pipe(
        Effect.andThen(TestClock.setTime(Date.parse(dueObservedAt))),
        Effect.andThen(Deferred.succeed(advanceCompleted, undefined)),
        Effect.forkScoped,
      )
      const context = yield* makeProductionDueContext
      return yield* runAutonomousCycleUntilSettled(context).pipe(
        Effect.provideService(BrokerRead, dueBrokerRead(control)),
        Effect.provideService(
          MarketData,
          dueMarketData(
            control,
            Deferred.succeed(advanceRequested, undefined).pipe(Effect.andThen(Deferred.await(advanceCompleted))),
          ),
        ),
      )
    }),
  ).pipe(Effect.provide(TestClock.layer()))

const runProductionDuePass = (runtime: ReturnType<typeof makeAutonomousRuntime>, control: DueIoControl) =>
  runtime.runPromise(productionDuePass(control))

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
    readonly executionPolicy?: CycleExecutionPolicy
    readonly executionCloseAt?: string
    readonly executionOpenAt?: string
    readonly executionSessionDate?: IsoDate
    readonly qualificationRunId?: string
    readonly signalSessionDate?: IsoDate
    readonly submissionWindowMs?: number
  } = {},
): LegacyCycleDraft => {
  const signalSessionDate = options.signalSessionDate ?? '2026-03-06'
  const executionSessionDate = options.executionSessionDate ?? '2026-03-09'
  const executionPolicy = (() => {
    if (options.executionPolicy !== undefined) return options.executionPolicy
    const executionPolicyResult = makeCycleExecutionPolicy({
      schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
      strategyExecutionModelHash: 'c'.repeat(64),
      submissionWindowMs: options.submissionWindowMs ?? 30 * 60 * 1_000,
      submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
    })
    expect(Result.isSuccess(executionPolicyResult)).toBe(true)
    if (Result.isFailure(executionPolicyResult)) return expect.unreachable(executionPolicyResult.failure.message)
    return executionPolicyResult.success
  })()

  const executionCalendarResult = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: executionSessionDate,
    openAt: options.executionOpenAt ?? '2026-03-09T13:30:00.000Z',
    closeAt: options.executionCloseAt ?? '2026-03-09T20:00:00.000Z',
  })
  expect(Result.isSuccess(executionCalendarResult)).toBe(true)
  if (Result.isFailure(executionCalendarResult)) return expect.unreachable(executionCalendarResult.failure.message)
  const executionCalendar = executionCalendarResult.success

  const identityResult = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: options.qualificationRunId ?? 'a'.repeat(64),
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
  expect(Result.isSuccess(identityResult)).toBe(true)
  if (Result.isFailure(identityResult)) return expect.unreachable(identityResult.failure.message)
  const windowResult = makeCycleWindow(signalSession(signalSessionDate), executionCalendar, executionPolicy)
  expect(Result.isSuccess(windowResult)).toBe(true)
  if (Result.isFailure(windowResult)) return expect.unreachable(windowResult.failure.message)
  const draftResult = makeCycleDraft(identityResult.success, windowResult.success)
  expect(Result.isSuccess(draftResult)).toBe(true)
  if (Result.isFailure(draftResult)) return expect.unreachable(draftResult.failure.message)
  if (!isLegacyCycleDraft(draftResult.success)) return expect.unreachable('expected a legacy cycle draft')
  return draftResult.success
}

const makePlannedDraft = (accountId: string, executionPolicy: CycleExecutionPolicy): LegacyCycleDraft =>
  makeDraft(accountId, {
    executionPolicy,
    executionSessionDate: '2026-04-01',
    executionOpenAt: '2026-04-01T13:30:00.000Z',
    executionCloseAt: '2026-04-01T20:00:00.000Z',
  })

type HistoricalV2CycleDraft = Extract<LegacyCycleDraft, { readonly schemaVersion: 'bayn.autonomous-cycle.v2' }>

const isHistoricalV2CycleDraft = (draft: CycleDraft): draft is HistoricalV2CycleDraft =>
  draft.schemaVersion === 'bayn.autonomous-cycle.v2' &&
  draft.identity.schemaVersion === 'bayn.autonomous-cycle-identity.v2' &&
  draft.window.schemaVersion === 'bayn.autonomous-cycle-window.v2'

const makeHistoricalV2Draft = (accountId = 'paper-account-historical-v2'): HistoricalV2CycleDraft => {
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  const executionCalendar = Result.getOrThrow(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-03-09',
      openAt: '2026-03-09T13:30:00.000Z',
      closeAt: '2026-03-09T20:00:00.000Z',
    }),
  )
  const identity = Result.getOrThrow(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v2',
      strategyName: 'opening-drive-momentum',
      qualificationRunId: '2'.repeat(64),
      strategyProtocolHash: defaultOpeningDriveProtocolHash,
      accountId,
      signalSessionDate: '2026-03-06',
      signalCalendarVersion,
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = Result.getOrThrow(makeCycleWindow(signalSession('2026-03-06'), executionCalendar, executionPolicy))
  const draft = Result.getOrThrow(makeCycleDraft(identity, window))
  if (!isHistoricalV2CycleDraft(draft)) {
    return expect.unreachable('expected a historical version 2 cycle draft')
  }
  return draft
}

const makeIntradayDraft = (
  accountId = 'paper-account-intraday',
  qualificationRunId = '1'.repeat(64),
): IntradayCycleDraft => {
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  const executionCalendar = Result.getOrThrow(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-03-09',
      openAt: '2026-03-09T13:30:00.000Z',
      closeAt: '2026-03-09T20:00:00.000Z',
    }),
  )
  const identity = Result.getOrThrow(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'opening-drive-momentum',
      qualificationRunId,
      strategyProtocolHash: defaultOpeningDriveProtocolHash,
      accountId,
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = Result.getOrThrow(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = Result.getOrThrow(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) return expect.unreachable('expected an intraday cycle draft')
  return draft
}

const makeFullSessionIntradayDraft = (
  accountId = 'paper-account-full-session-intraday',
  qualificationRunId = '4'.repeat(64),
): IntradayCycleDraft => {
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const executionCalendar = Result.getOrThrow(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-03-09',
      openAt: '2026-03-09T13:30:00.000Z',
      closeAt: '2026-03-09T20:00:00.000Z',
    }),
  )
  const identity = Result.getOrThrow(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId,
      strategyProtocolHash: canonicalHashV1(defaultIntradayMomentumProtocolDocument),
      accountId,
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = Result.getOrThrow(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = Result.getOrThrow(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) return expect.unreachable('expected a full-session intraday cycle draft')
  return draft
}

const monthEndExecutionWindow = (
  evaluatedAt: string,
): {
  readonly evaluationAt: string
  readonly executionOpenAt: string
  readonly executionSessionDate: IsoDate
  readonly snapshotBoundAt: string
  readonly signalSessionDate: IsoDate
} => {
  const evaluated = DateTime.makeUnsafe(evaluatedAt)
  const execution = DateTime.add(evaluated, { minutes: 44 })
  let signal = DateTime.subtract(DateTime.startOf(execution, 'month'), { days: 1 })
  while ([0, 6].includes(DateTime.getPartUtc(signal, 'weekDay'))) signal = DateTime.subtract(signal, { days: 1 })
  const executionSessionDate = DateTime.formatIsoDate(execution) as IsoDate
  return {
    evaluationAt: evaluatedAt,
    executionOpenAt: DateTime.formatIso(execution),
    executionSessionDate,
    snapshotBoundAt: DateTime.formatIso(DateTime.subtract(evaluated, { minutes: 2 })),
    signalSessionDate: DateTime.formatIsoDate(signal) as IsoDate,
  }
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

const seedTerminalQualificationSnapshot = (
  draft: CycleDraft,
  snapshotId: string,
  verdict: 'QUALIFIED' | 'REJECTED' = 'QUALIFIED',
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const lockId = '1'.repeat(64)
    const sourceRevision = '2'.repeat(40)
    const imageRepository = 'registry.example.test/lab/bayn'
    const imageDigest = `sha256:${'3'.repeat(64)}`
    const resultHash = '4'.repeat(64)
    const analysisHash = '5'.repeat(64)

    yield* ensureSnapshotReference(sql, makeInputManifest(snapshotId))
    yield* sql`
      INSERT INTO protocol_locks (
        protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
      ) VALUES (
        ${draft.identity.strategyProtocolHash}, 'bayn.risk-balanced-trend.protocol.v4',
        'risk-balanced-trend', ${'6'.repeat(64)}, ${'7'.repeat(64)}, ${sql.json({ fixture: true })}
      )
    `
    yield* sql`
      INSERT INTO evaluation_runs (
        run_id, protocol_hash, snapshot_id, evaluation_schema_version, source_revision,
        image_repository, image_digest, strategy_name, initial_capital_micros,
        expected_artifact_count, expected_event_count, expected_gate_count, status, completed_at
      ) VALUES (
        ${draft.identity.qualificationRunId}, ${draft.identity.strategyProtocolHash}, ${snapshotId},
        'bayn.evaluation.v6', ${sourceRevision}, ${imageRepository}, ${imageDigest}, 'risk-balanced-trend',
        1000000000, 1, 0, 1, 'COMPLETE', '2026-03-06T20:58:00.000Z'
      )
    `
    yield* sql`
      INSERT INTO qualification_locks (
        lock_id, schema_version, candidate_run_id, protocol_hash, snapshot_id,
        source_revision, image_repository, image_digest, payload
      ) VALUES (
        ${lockId}, 'bayn.qualification-lock.v3', ${draft.identity.qualificationRunId},
        ${draft.identity.strategyProtocolHash}, ${snapshotId}, ${sourceRevision}, ${imageRepository}, ${imageDigest},
        ${sql.json({
          schemaVersion: 'bayn.qualification-lock.v3',
          lockId,
          candidateRunId: draft.identity.qualificationRunId,
          protocolHash: draft.identity.strategyProtocolHash,
          sourceRevision,
          image: { repository: imageRepository, digest: imageDigest },
          data: { snapshotId },
        })}
      )
    `
    yield* sql`
      INSERT INTO qualification_results (
        lock_id, schema_version, run_id, verdict, committed_at, analysis_hash, result_hash, payload
      ) VALUES (
        ${lockId}, 'bayn.qualification-result.v2', ${draft.identity.qualificationRunId}, ${verdict},
        '2026-03-06T20:58:30.000Z', ${analysisHash}, ${resultHash},
        ${sql.json({
          schemaVersion: 'bayn.qualification-result.v2',
          lockId,
          runId: draft.identity.qualificationRunId,
          verdict,
          analysis: { analysisHash },
          resultHash,
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
const decisionAt = '2026-03-09T13:00:00.000Z'
const plannedDecisionAt = '2026-04-01T13:00:00.000Z'
const terminalAt = '2026-03-09T13:01:00.000Z'

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
    targets:
      options.blockedReason === undefined
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
  const targetPlan = {
    ...targetPlanMaterial,
    outputHash: canonicalHashV1(targetPlanMaterial),
  }
  const result = makeObserveShadowDecisionDocument({
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
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable(result.failure.message)
  return result.success
}

const makeIntradayShadowDecision = (draft: IntradayCycleDraft) => {
  const universe = ['AMD', 'NVDA'] as const
  const sourceTopics = {
    bars: 'torghut.bars.1m.v1',
    quotes: 'torghut.quotes.v1',
    trades: 'torghut.trades.v1',
  }
  const calendarMaterial = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: {
      start: draft.identity.executionSessionDate,
      end: draft.identity.executionSessionDate,
    },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: draft.identity.executionSessionDate,
        openAt: draft.window.executionOpenAt,
        closeAt: draft.window.executionCloseAt,
      },
    ],
  }
  const snapshotMaterial = {
    schemaVersion: 'bayn.intraday-market-snapshot.v1' as const,
    sessionDate: draft.identity.executionSessionDate,
    calendar: { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) },
    rangeStartAt: draft.window.executionOpenAt,
    rangeEndAt: '2026-03-09T13:35:00.000Z',
    observedAt: draft.window.submissionOpenAt,
    universeId: 'opening-drive-fixture-v1',
    universeSymbolHash: sha256(universe.join(',')),
    universe,
    symbols: universe,
    feed: 'sip' as const,
    delayClass: 'real_time_consolidated' as const,
    sourceTopics,
    archiveWatermarks: Object.values(sourceTopics).map((sourceTopic, index) => ({
      sourceTopic,
      sourcePartition: 0,
      inclusiveLastOffset: String(10 + index),
    })),
    maximumQuoteAgeMs: 5_000,
    minimumWatermarkLagMs: 1_000,
    barCount: 10,
    quoteCount: 2,
    tradeCount: 2,
    barsContentHash: '8'.repeat(64),
    quotesContentHash: '9'.repeat(64),
    tradesContentHash: 'a'.repeat(64),
    lineage: Object.values(sourceTopics).map((sourceTopic, index) => ({
      sourceTopic,
      sourcePartition: 0,
      firstOffset: String(1 + index),
      lastOffset: String(10 + index),
      recordCount: index === 0 ? 10 : 2,
    })),
  }
  const contentHash = canonicalHashV1(snapshotMaterial)
  const { schemaVersion: snapshotSchemaVersion, ...material } = snapshotMaterial
  const executionMarketData = {
    schemaVersion: 'bayn.execution-market-data-binding.v2' as const,
    snapshotSchemaVersion,
    ...material,
    contentHash,
    snapshotId: canonicalHashV1({ ...snapshotMaterial, contentHash }),
  }
  const base = makeShadowDecision(draft, executionMarketData.snapshotId, {
    createdAt: '2026-03-09T13:36:00.000Z',
    snapshotContentHash: executionMarketData.contentHash,
  })
  const { contentHash: _baseContentHash, ...baseMaterial } = base
  const result = makeObserveShadowDecisionDocument({
    ...baseMaterial,
    bindings: {
      ...baseMaterial.bindings,
      snapshotFinalizedAt: executionMarketData.observedAt,
      executionMarketData,
    },
  })
  if (Result.isFailure(result)) throw new Error(`${result.failure.message}: ${String(result.failure.cause)}`)
  return result.success
}

const makeIntradaySnapshotReference = (
  document: ReturnType<typeof makeIntradayShadowDecision>,
): ArchiveVerifiedIntradaySnapshotReference => {
  const binding = document.bindings.executionMarketData
  if (binding?.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
    return expect.unreachable('intraday store fixture requires archive market-data binding v2')
  }
  const { schemaVersion: _bindingSchemaVersion, snapshotSchemaVersion, ...manifest } = binding
  return {
    schemaVersion: 'bayn.intraday-snapshot-reference.v1',
    manifest: { schemaVersion: snapshotSchemaVersion, ...manifest },
  } as unknown as ArchiveVerifiedIntradaySnapshotReference
}

const makePaperNoTradeDecision = (
  draft: CycleDraft,
  boundSnapshotId: string,
  authorityGenerationHash = 'a'.repeat(64),
) => {
  const observe = makeShadowDecision(draft, boundSnapshotId)
  const result = makeExecutionDecisionDocument({
    schemaVersion: 'bayn.paper-cycle-decision.v1',
    mode: 'PAPER',
    dispatchable: true,
    bindings: {
      ...observe.bindings,
      qualificationRunId: draft.identity.qualificationRunId,
      authorityGenerationHash,
    },
    targetPlan: observe.targetPlan,
    deltaRisk: [],
    orderedIntentIds: [],
    createdAt: observe.createdAt,
    submissionCutoffAt: observe.submissionCutoffAt,
    expiresAt: observe.expiresAt,
  })
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable(result.failure.message)
  return result.success
}

const plannedPaperGenerationHash = 'a'.repeat(64)
const plannedPaperAccountingHash = '8'.repeat(64)

const plannedPaperReconciliation = (
  draft: CycleDraft,
  observedAt = plannedDecisionAt,
  orders: ReconciliationPassResult['brokerState']['orders'] = [],
): ReconciliationPassResult => {
  const account = {
    schemaVersion: 'bayn.paper-account-snapshot.v1' as const,
    accountId: draft.identity.accountId,
    status: AccountStatus.Active,
    currency: 'USD' as const,
    cashMicros: '1000000000',
    equityMicros: '1000000000',
    buyingPowerMicros: '1000000000',
    observedAt,
  }
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions: [],
      positionsObservedAt: observedAt,
      orders,
      ordersObservedAt: observedAt,
      accountingHash: plannedPaperAccountingHash,
    }),
  )
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId: draft.identity.accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: observedAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material,
  })
  const reconciliation = {
    ...material,
    reconciliationId,
    contentHash: canonicalHashV1({ ...material, reconciliationId }),
  }
  return {
    report: {
      reconciliation,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    brokerState: {
      account,
      positions: [],
      positionsObservedAt: observedAt,
      orders,
      ordersObservedAt: observedAt,
      accountingHash: plannedPaperAccountingHash,
      reconciliation,
      unknownOrderCount: 0,
    },
    riskContext: {
      tradingDate: draft.identity.executionSessionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: plannedPaperGenerationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: draft.window.submissionOpenAt,
      },
      authorityObservedAt: observedAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: account.equityMicros,
      peakEquityMicros: account.equityMicros,
    },
  }
}

const plannedExecutionDecisionPlan = (draft: LegacyCycleDraft): DecisionPlan => {
  const targetWeights = Object.fromEntries(
    fixtureProtocol.universe.map((symbol, index) => [symbol, index === 0 ? 0.5 : 0]),
  )
  return {
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: draft.identity.signalSessionDate,
    covarianceWindow: {
      returnCount: 1,
      firstSession: draft.identity.signalSessionDate,
      lastSession: draft.identity.signalSessionDate,
      sessionsHash: '7'.repeat(64),
    },
    estimatedAnnualizedPortfolioVolatility: 0.1,
    exposureScale: 1,
    targetWeights,
    signals: fixtureProtocol.universe.map((symbol, index) => ({
      symbol,
      horizons: [{ horizonSessions: 1, return: index === 0 ? 0.1 : 0, normalizedTrend: index === 0 ? 1 : 0 }],
      dailyVolatility: 0.1,
      annualizedVolatility: 0.1,
      compositeScore: index === 0 ? 1 : 0,
      positiveScore: index === 0 ? 1 : 0,
      eligible: true,
      uncappedWeight: index === 0 ? 0.5 : 0,
      cappedWeight: index === 0 ? 0.5 : 0,
      targetWeight: index === 0 ? 0.5 : 0,
    })),
  }
}

const plannedPaperSnapshot = (
  draft: LegacyCycleDraft,
  boundSnapshotId: string,
  snapshotFinalizedAt: string,
): MarketDataSnapshot => {
  const source = makeSnapshot(1_129)
  const sourceSessions = [...new Set(source.bars.map((bar) => bar.sessionDate))].sort()
  const sourceLastSession = sourceSessions.at(-1)
  if (sourceLastSession === undefined) throw new RangeError('planned PAPER fixture has no source sessions')
  const sessionOffsetMs =
    Date.parse(`${draft.identity.signalSessionDate}T00:00:00.000Z`) - Date.parse(`${sourceLastSession}T00:00:00.000Z`)
  const shiftSession = (session: IsoDate): IsoDate =>
    utcDateFromEpochMillis(Date.parse(`${session}T00:00:00.000Z`) + sessionOffsetMs) as IsoDate
  const sessions = sourceSessions.map(shiftSession)
  const firstSession = sessions.at(0)
  const lastSession = sessions.at(-1)
  if (firstSession === undefined || lastSession === undefined) {
    throw new RangeError('planned PAPER fixture has no shifted sessions')
  }
  const bars = source.bars.map((bar) => ({ ...bar, sessionDate: shiftSession(bar.sessionDate) }))
  const { hash: _sourceManifestHash, ...sourceManifest } = source.manifest
  const material: Omit<InputManifest, 'hash'> = {
    ...sourceManifest,
    bounds: {
      ...sourceManifest.bounds,
      dataStart: firstSession,
      dataEnd: lastSession,
      lookbackStart: firstSession,
      evaluationStart: shiftSession(sourceManifest.bounds.evaluationStart),
      evaluationEnd: lastSession,
    },
    rowCount: bars.length,
    sessionCount: sessions.length,
    firstSession,
    lastSession,
    symbols: sourceManifest.symbols.map((coverage) => ({
      ...coverage,
      rows: sessions.length,
      firstSession,
      lastSession,
    })),
    finalizedSnapshot: {
      ...sourceManifest.finalizedSnapshot,
      snapshotId: boundSnapshotId,
      publicationId: boundSnapshotId,
      calendarVersion: signalCalendarVersion,
      finalizedAt: snapshotFinalizedAt,
      requestedStart: firstSession,
      firstSession,
      lastSession,
      asOfSession: draft.identity.signalSessionDate,
      rowCount: bars.length,
      sessionCount: sessions.length,
      contentHash: boundSnapshotId,
    },
  }
  return {
    bars,
    manifest: { ...material, hash: canonicalHashV1(material) },
  }
}

const plannedPaperMarketData = (
  draft: LegacyCycleDraft,
  boundSnapshotId: string,
  snapshotFinalizedAt = acquireAt,
): MarketDataService => {
  const unused = Effect.die(new Error('planned PAPER persistence fixture used an unrelated market-data capability'))
  const snapshot = plannedPaperSnapshot(draft, boundSnapshotId, snapshotFinalizedAt)
  return {
    check: unused,
    inspect: unused,
    inspectCyclePublications: unused,
    inspectPublication: () => unused,
    inspectSnapshotPublication: () => unused,
    loadSnapshotPublication: (request) => {
      expect(request).toEqual({
        snapshotId: boundSnapshotId,
        signalSessionDate: draft.identity.signalSessionDate,
        signalCalendarVersion: draft.identity.signalCalendarVersion,
      })
      return Effect.succeed(snapshot)
    },
    load: unused,
  }
}

const plannedPaperBrokerRead = (draft: LegacyCycleDraft, observedAt = decisionAt): BrokerReadShape => {
  const unused = Effect.die(new Error('planned PAPER persistence fixture used an unrelated broker capability'))
  return {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar: (query) => {
      const signalOpenAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) - 6.5 * 60 * 60 * 1_000)
      const material = {
        schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
        source: 'alpaca-v2-calendar' as const,
        requestedRange: query,
        timeZone: 'UTC' as const,
        sessions: [
          {
            date: draft.identity.signalSessionDate,
            openAt: signalOpenAt,
            closeAt: draft.window.signalCloseAt,
          },
          {
            date: draft.identity.executionSessionDate,
            openAt: draft.window.executionOpenAt,
            closeAt: draft.window.executionCloseAt,
          },
        ],
      }
      return Effect.succeed({
        value: { ...material, normalizedResponseHash: canonicalHashV1(material) },
        evidence: {
          requestId: 'planned-paper-calendar',
          status: 200,
          contentHash: '6'.repeat(64),
          observedAt,
        },
      })
    },
  }
}

const buildPlannedExecutionDecision = (
  cycle: AutonomousCycle,
  boundSnapshotId: string,
  options: {
    readonly evaluatedAt?: string
    readonly snapshotFinalizedAt?: string
    readonly transformPolicy?: (policy: Policy) => Policy
  } = {},
) =>
  Effect.gen(function* () {
    if (!isLegacyAutonomousCycle(cycle)) {
      return yield* Effect.die(new Error('planned execution fixture requires a legacy cycle'))
    }
    const legacyCycle: LegacyAutonomousCycle = cycle
    const evaluatedAt = options.evaluatedAt ?? plannedDecisionAt
    const sourcePolicy = yield* loadObserveRiskPolicy(legacyCycle.identity.accountId, fixtureProtocol.universe)
    const policy = options.transformPolicy?.(sourcePolicy) ?? sourcePolicy
    const reconciliation = plannedPaperReconciliation(legacyCycle, evaluatedAt)
    const decision = plannedExecutionDecisionPlan(legacyCycle)
    yield* TestClock.setTime(Date.parse(evaluatedAt))
    const document = yield* buildMutationShadowCycleDecision({
      authorityGenerationHash: plannedPaperGenerationHash,
      cycle: legacyCycle,
      executionModel: fixtureProtocol.executionModel,
      policy,
      reconcile: Effect.succeed(reconciliation),
      strategy: {
        definition: { ...dueStrategy.definition, decide: () => Result.succeed(decision) },
        provenance: dueStrategy.provenance,
      },
    }).pipe(
      Effect.provideService(BrokerRead, plannedPaperBrokerRead(legacyCycle, evaluatedAt)),
      Effect.provideService(
        MarketData,
        plannedPaperMarketData(legacyCycle, boundSnapshotId, options.snapshotFinalizedAt),
      ),
    )
    return { document, reconciliation }
  })

const buildPlannedObserveDecision = (cycle: AutonomousCycle, boundSnapshotId: string) =>
  Effect.gen(function* () {
    if (!isLegacyAutonomousCycle(cycle)) {
      return yield* Effect.die(new Error('planned observe fixture requires a legacy cycle'))
    }
    const legacyCycle: LegacyAutonomousCycle = cycle
    const evaluatedAt = plannedDecisionAt
    const policy = yield* loadObserveRiskPolicy(legacyCycle.identity.accountId, fixtureProtocol.universe)
    const paperReconciliation = plannedPaperReconciliation(legacyCycle, evaluatedAt)
    const authority = paperReconciliation.riskContext.authority
    if (authority === null) return yield* Effect.die(new Error('planned OBSERVE fixture requires authority'))
    const reconciliation: ReconciliationPassResult = {
      ...paperReconciliation,
      riskContext: {
        ...paperReconciliation.riskContext,
        authority: {
          ...authority,
          maximum: Authority.Observe,
          effective: Authority.Observe,
        },
      },
    }
    const decision = plannedExecutionDecisionPlan(legacyCycle)
    yield* TestClock.setTime(Date.parse(evaluatedAt))
    const document = yield* buildObserveCycleDecision({
      authorityGenerationHash: plannedPaperGenerationHash,
      cycle: legacyCycle,
      executionModel: fixtureProtocol.executionModel,
      policy,
      reconcile: Effect.succeed(reconciliation),
      strategy: {
        definition: { ...dueStrategy.definition, decide: () => Result.succeed(decision) },
        provenance: dueStrategy.provenance,
      },
    }).pipe(
      Effect.provideService(BrokerRead, plannedPaperBrokerRead(legacyCycle, evaluatedAt)),
      Effect.provideService(MarketData, plannedPaperMarketData(legacyCycle, boundSnapshotId)),
    )
    return { document, reconciliation }
  })

const insertReconciliation = (result: ReconciliationPassResult) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const reconciliation = result.report.reconciliation
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
        ${sql.json(encodeSqlJson(reconciliation.discrepancies))},
        ${reconciliation.reconciledAt}
      )
    `
    const [stored] = yield* sql<{ discrepancy_type: string }>`
      SELECT jsonb_typeof(discrepancies) AS discrepancy_type
      FROM reconciliations
      WHERE reconciliation_id = ${reconciliation.reconciliationId}
    `
    if (stored?.discrepancy_type !== 'array') {
      return yield* Effect.die(
        new Error('PAPER lifecycle reconciliation fixture must persist discrepancies as JSON array'),
      )
    }
  })

const insertQualifiedPaperLineage = (
  document: ExecutionDecisionDocument,
  options: { readonly deniedIntent?: boolean } = {},
) =>
  Effect.gen(function* () {
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk === undefined) {
      return yield* Effect.die(new Error('terminal PAPER failure fixture requires one ordered intent'))
    }
    const intent = yield* planExecutionIntent(
      {
        schemaVersion: 'bayn.paper-intent-plan.v1',
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
        createdAt: document.createdAt,
      },
      {
        authority: {
          schemaVersion: 'bayn.paper-authority.v1',
          generationHash: document.bindings.authorityGenerationHash,
          maximum: Authority.Execution,
          effective: Authority.Execution,
          kill: KillState.Clear,
          version: 1,
          updatedAt: document.createdAt,
        },
      },
    )
    const sql = yield* PgClient.PgClient
    const brokerIdentity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: document.bindings.accountId,
      }),
    )
    const observeGenerationHash = '9'.repeat(64)
    const qualificationLockId = '1'.repeat(64)
    const qualificationResultHash = '2'.repeat(64)
    const qualificationAnalysisHash = '3'.repeat(64)
    const qualificationExecutionPolicyHash = '4'.repeat(64)
    const strategyBehaviorHash = '5'.repeat(64)
    const strategyParameterHash = '6'.repeat(64)
    const sourceRevision = '7'.repeat(40)
    const imageRepository = 'registry.example.test/lab/bayn'
    const imageDigest = `sha256:${'8'.repeat(64)}`
    const proofPlanHash = canonicalHashV1({
      schemaVersion: 'bayn.paper-terminalization-proof-plan.v1',
      cycleId: document.bindings.cycleId,
      decisionHash: document.contentHash,
    })
    const intentCreatedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) - 1_000)
    const submitStartedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 1)
    const deniedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 2)
    const mutationId = canonicalHashV1({ intentId: intent.intentId, operation: 'SUBMIT' })
    const requestHash = canonicalHashV1({ intentId: intent.intentId, request: 'pretransmit-denied' })

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO protocol_locks (
            protocol_hash,
            schema_version,
            strategy_name,
            behavior_hash,
            parameter_hash,
            parameters,
            created_at
          ) VALUES (
            ${document.bindings.strategyProtocolHash},
            'bayn.risk-balanced-trend.protocol.v4',
            ${document.bindings.strategyName},
            ${strategyBehaviorHash},
            ${strategyParameterHash},
            ${sql.json({ fixture: 'terminal-paper-cycle' })},
            ${intentCreatedAt}
          )
        `
        yield* sql`
          INSERT INTO evaluation_runs (
            run_id,
            protocol_hash,
            snapshot_id,
            evaluation_schema_version,
            source_revision,
            image_repository,
            image_digest,
            strategy_name,
            initial_capital_micros,
            expected_artifact_count,
            expected_event_count,
            expected_gate_count,
            status,
            created_at,
            completed_at
          ) VALUES (
            ${document.bindings.qualificationRunId},
            ${document.bindings.strategyProtocolHash},
            ${document.bindings.snapshotId},
            'bayn.evaluation.v6',
            ${sourceRevision},
            ${imageRepository},
            ${imageDigest},
            ${document.bindings.strategyName},
            1000000000,
            1,
            0,
            1,
            'COMPLETE',
            ${intentCreatedAt},
            ${document.createdAt}
          )
        `
        yield* sql`
          INSERT INTO qualification_locks (
            lock_id,
            schema_version,
            candidate_run_id,
            protocol_hash,
            snapshot_id,
            source_revision,
            image_repository,
            image_digest,
            payload,
            created_at
          ) VALUES (
            ${qualificationLockId},
            'bayn.qualification-lock.v3',
            ${document.bindings.qualificationRunId},
            ${document.bindings.strategyProtocolHash},
            ${document.bindings.snapshotId},
            ${sourceRevision},
            ${imageRepository},
            ${imageDigest},
            ${sql.json({
              schemaVersion: 'bayn.qualification-lock.v3',
              lockId: qualificationLockId,
              candidateRunId: document.bindings.qualificationRunId,
              protocolHash: document.bindings.strategyProtocolHash,
              sourceRevision,
              image: { repository: imageRepository, digest: imageDigest },
              data: { snapshotId: document.bindings.snapshotId },
            })},
            ${intentCreatedAt}
          )
        `
        yield* sql`
          INSERT INTO qualification_results (
            lock_id,
            schema_version,
            run_id,
            verdict,
            committed_at,
            analysis_hash,
            result_hash,
            payload
          ) VALUES (
            ${qualificationLockId},
            'bayn.qualification-result.v2',
            ${document.bindings.qualificationRunId},
            'QUALIFIED',
            ${document.createdAt},
            ${qualificationAnalysisHash},
            ${qualificationResultHash},
            ${sql.json({
              schemaVersion: 'bayn.qualification-result.v2',
              lockId: qualificationLockId,
              runId: document.bindings.qualificationRunId,
              verdict: 'QUALIFIED',
              analysis: { analysisHash: qualificationAnalysisHash },
              resultHash: qualificationResultHash,
            })}
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash,
            schema_version,
            previous_generation_hash,
            maximum,
            authority_version,
            account_id,
            broker_identity_schema_version,
            broker_identity_hash,
            broker_provider,
            broker_environment,
            activated_at
          ) VALUES (
            ${observeGenerationHash},
            'bayn.authority-generation-history.v1',
            NULL,
            'OBSERVE',
            1,
            ${document.bindings.accountId},
            ${brokerIdentity.schemaVersion},
            ${brokerIdentity.identityHash},
            ${brokerIdentity.provider},
            ${brokerIdentity.environment},
            ${intentCreatedAt}
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash,
            schema_version,
            activation_schema_version,
            previous_generation_hash,
            maximum,
            authority_version,
            qualification_run_id,
            qualification_lock_id,
            qualification_result_hash,
            protocol_hash,
            qualification_execution_policy_hash,
            qualification_source_revision,
            qualification_image_repository,
            qualification_image_digest,
            activation_source_revision,
            activation_image_repository,
            activation_image_digest,
            strategy_name,
            strategy_behavior_hash,
            strategy_parameter_hash,
            strategy_parameter_schema_version,
            account_id,
            broker_identity_schema_version,
            broker_identity_hash,
            broker_provider,
            broker_environment,
            risk_policy_hash,
            proof_plan_hash,
            reconciliation_id,
            reconciliation_content_hash,
            activated_at
          ) VALUES (
            ${document.bindings.authorityGenerationHash},
            'bayn.authority-generation-history.v1',
            'bayn.paper-authority-generation.v2',
            ${observeGenerationHash},
            'PAPER',
            2,
            ${document.bindings.qualificationRunId},
            ${qualificationLockId},
            ${qualificationResultHash},
            ${document.bindings.strategyProtocolHash},
            ${qualificationExecutionPolicyHash},
            ${sourceRevision},
            ${imageRepository},
            ${imageDigest},
            ${sourceRevision},
            ${imageRepository},
            ${imageDigest},
            ${document.bindings.strategyName},
            ${strategyBehaviorHash},
            ${strategyParameterHash},
            'bayn.risk-balanced-trend.protocol.v4',
            ${document.bindings.accountId},
            ${brokerIdentity.schemaVersion},
            ${brokerIdentity.identityHash},
            ${brokerIdentity.provider},
            ${brokerIdentity.environment},
            ${document.bindings.policyHash},
            ${proofPlanHash},
            ${document.bindings.reconciliationId},
            ${document.bindings.reconciliationHash},
            ${document.createdAt}
          )
        `
        if (options.deniedIntent === true) {
          yield* sql`
            INSERT INTO intents (
            intent_id,
            schema_version,
            authority_generation_hash,
            strategy_name,
            cycle_id,
            decision_hash,
            policy_hash,
            account_id,
            client_order_id,
            symbol,
            side,
            order_type,
            time_in_force,
            quantity_micros,
            notional_limit_micros,
            state,
            created_at,
            updated_at
            ) VALUES (
            ${intent.intentId},
            ${intent.schemaVersion},
            ${intent.authorityGenerationHash},
            ${intent.strategyName},
            ${intent.cycleId},
            ${intent.decisionHash},
            ${intent.policyHash},
            ${intent.accountId},
            ${intent.clientOrderId},
            ${intent.symbol},
            ${intent.side},
            ${intent.orderType},
            ${intent.timeInForce},
            ${intent.quantityMicros},
            ${intent.notionalLimitMicros},
            'PLANNED',
            ${intentCreatedAt},
            ${intentCreatedAt}
            )
          `
          yield* sql`
            INSERT INTO risk_decisions (
            decision_id,
            schema_version,
            input_hash,
            intent_id,
            policy_hash,
            outcome,
            reason_codes,
            decided_at,
            expires_at
            ) VALUES (
            ${risk.evaluation.decision.decisionId},
            ${risk.evaluation.decision.schemaVersion},
            ${risk.evaluation.decision.inputHash},
            ${risk.evaluation.decision.intentId},
            ${risk.evaluation.decision.policyHash},
            ${risk.evaluation.decision.outcome},
            ${risk.evaluation.decision.reasonCodes},
            ${risk.evaluation.decision.decidedAt},
            ${risk.evaluation.decision.expiresAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET
              risk_decision_id = ${risk.evaluation.decision.decisionId},
              state = 'APPROVED',
              state_version = state_version + 1,
              updated_at = ${risk.evaluation.decision.decidedAt}
            WHERE intent_id = ${intent.intentId}
          `
          yield* sql`
            INSERT INTO mutation_events (
            event_id,
            schema_version,
            mutation_id,
            intent_id,
            sequence,
            operation,
            event_type,
            request_hash,
            consistency_delay_ms,
            occurred_at
            ) VALUES (
            ${canonicalHashV1({ mutationId, sequence: 1, eventType: 'SUBMIT_STARTED' })},
            'bayn.paper-mutation-event.v1',
            ${mutationId},
            ${intent.intentId},
            1,
            'SUBMIT',
            'SUBMIT_STARTED',
            ${requestHash},
            1000,
            ${submitStartedAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET
              state = 'IO_STARTED',
              state_version = state_version + 1,
              updated_at = ${submitStartedAt}
            WHERE intent_id = ${intent.intentId}
          `
          yield* sql`
            INSERT INTO mutation_events (
            event_id,
            schema_version,
            mutation_id,
            intent_id,
            sequence,
            operation,
            event_type,
            request_hash,
            consistency_delay_ms,
            occurred_at
            ) VALUES (
            ${canonicalHashV1({ mutationId, sequence: 2, eventType: 'SUBMIT_DENIED' })},
            'bayn.paper-mutation-event.v1',
            ${mutationId},
            ${intent.intentId},
            2,
            'SUBMIT',
            'SUBMIT_DENIED',
            ${requestHash},
            1000,
            ${deniedAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET
              state = 'TERMINAL',
              terminal_outcome = 'REJECTED',
              state_version = state_version + 1,
              updated_at = ${deniedAt}
            WHERE intent_id = ${intent.intentId}
          `
        }
      }),
    )

    return { deniedAt, intent }
  })

const insertSupersedingObserveGeneration = (document: ExecutionDecisionDocument) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const generationHash = canonicalHashV1({
      schemaVersion: 'bayn.superseding-observe-generation-fixture.v1',
      previousGenerationHash: document.bindings.authorityGenerationHash,
      cycleId: document.bindings.cycleId,
    })
    const brokerIdentity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: document.bindings.accountId,
      }),
    )
    const activatedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 10_000)
    yield* sql`
      INSERT INTO authority_generations (
        generation_hash,
        schema_version,
        previous_generation_hash,
        maximum,
        authority_version,
        account_id,
        broker_identity_schema_version,
        broker_identity_hash,
        broker_provider,
        broker_environment,
        activated_at
      ) VALUES (
        ${generationHash},
        'bayn.authority-generation-history.v1',
        ${document.bindings.authorityGenerationHash},
        'OBSERVE',
        3,
        ${document.bindings.accountId},
        ${brokerIdentity.schemaVersion},
        ${brokerIdentity.identityHash},
        ${brokerIdentity.provider},
        ${brokerIdentity.environment},
        ${activatedAt}
      )
    `
    return { activatedAt, generationHash }
  })

interface TerminalPlannedPaperIntentFixture {
  readonly brokerOrderPrefix: string
  readonly latestMutation: 'accepted' | 'recovered' | 'started'
  readonly orderType?: OrderType
  readonly requestLabel: string
  readonly responseContentHash: string
  readonly terminalOutcome: 'CANCELED' | 'FILLED'
  readonly timeInForce?: TimeInForce
}

const insertTerminalPlannedPaperIntent = (
  document: ExecutionDecisionDocument,
  fixture: TerminalPlannedPaperIntentFixture,
) =>
  Effect.gen(function* () {
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk === undefined) {
      return yield* Effect.die(new Error('terminal PAPER completion fixture requires one ordered intent'))
    }
    const intent = yield* planExecutionIntent(
      {
        schemaVersion: 'bayn.paper-intent-plan.v1',
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
        createdAt: document.createdAt,
      },
      {
        authority: {
          schemaVersion: 'bayn.paper-authority.v1',
          generationHash: document.bindings.authorityGenerationHash,
          maximum: Authority.Execution,
          effective: Authority.Execution,
          kill: KillState.Clear,
          version: 1,
          updatedAt: document.createdAt,
        },
      },
    )
    const sql = yield* PgClient.PgClient
    const intentCreatedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) - 1)
    const submitStartedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 1)
    const acceptedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 2)
    const recoveredAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 3)
    const terminalAt = utcInstantFromEpochMillis(
      Date.parse(document.createdAt) + (fixture.latestMutation === 'recovered' ? 4 : 3),
    )
    const mutationId = canonicalHashV1({ intentId: intent.intentId, operation: 'SUBMIT' })
    const requestHash = canonicalHashV1({ intentId: intent.intentId, request: fixture.requestLabel })
    const brokerOrderId = `${fixture.brokerOrderPrefix}-${intent.intentId.slice(0, 24)}`
    const orderType = fixture.orderType ?? intent.orderType
    const timeInForce = fixture.timeInForce ?? intent.timeInForce

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO intents (
            intent_id, schema_version, authority_generation_hash, strategy_name,
            cycle_id, decision_hash, policy_hash, account_id, client_order_id,
            symbol, side, order_type, time_in_force, quantity_micros,
            notional_limit_micros, state, created_at, updated_at
          ) VALUES (
            ${intent.intentId}, ${intent.schemaVersion}, ${intent.authorityGenerationHash},
            ${intent.strategyName}, ${intent.cycleId}, ${intent.decisionHash},
            ${intent.policyHash}, ${intent.accountId}, ${intent.clientOrderId},
            ${intent.symbol}, ${intent.side}, ${orderType}, ${timeInForce},
            ${intent.quantityMicros}, ${intent.notionalLimitMicros}, 'PLANNED',
            ${intentCreatedAt}, ${intentCreatedAt}
          )
        `
        yield* sql`
          INSERT INTO risk_decisions (
            decision_id, schema_version, input_hash, intent_id, policy_hash,
            outcome, reason_codes, decided_at, expires_at
          ) VALUES (
            ${risk.evaluation.decision.decisionId}, ${risk.evaluation.decision.schemaVersion},
            ${risk.evaluation.decision.inputHash}, ${risk.evaluation.decision.intentId},
            ${risk.evaluation.decision.policyHash}, ${risk.evaluation.decision.outcome},
            ${risk.evaluation.decision.reasonCodes}, ${risk.evaluation.decision.decidedAt},
            ${risk.evaluation.decision.expiresAt}
          )
        `
        yield* sql`
          UPDATE intents
          SET
            risk_decision_id = ${risk.evaluation.decision.decisionId},
            state = 'APPROVED',
            state_version = state_version + 1,
            updated_at = ${risk.evaluation.decision.decidedAt}
          WHERE intent_id = ${intent.intentId}
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence,
            operation, event_type, request_hash, consistency_delay_ms, occurred_at
          ) VALUES (
            ${canonicalHashV1({ mutationId, sequence: 1, eventType: 'SUBMIT_STARTED' })},
            'bayn.paper-mutation-event.v1', ${mutationId}, ${intent.intentId}, 1,
            'SUBMIT', 'SUBMIT_STARTED', ${requestHash}, 1000, ${submitStartedAt}
          )
        `
        yield* sql`
          UPDATE intents
          SET state = 'IO_STARTED', state_version = state_version + 1, updated_at = ${submitStartedAt}
          WHERE intent_id = ${intent.intentId}
        `
        if (fixture.latestMutation === 'accepted') {
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence,
              operation, event_type, request_hash, consistency_delay_ms,
              broker_order_id, request_id, response_status, response_content_hash, occurred_at
            ) VALUES (
              ${canonicalHashV1({ mutationId, sequence: 2, eventType: 'SUBMIT_ACCEPTED' })},
              'bayn.paper-mutation-event.v1', ${mutationId}, ${intent.intentId}, 2,
              'SUBMIT', 'SUBMIT_ACCEPTED', ${requestHash}, 1000,
              ${brokerOrderId}, ${fixture.requestLabel}, 200, ${fixture.responseContentHash}, ${acceptedAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET state = 'ACKNOWLEDGED', state_version = state_version + 1, updated_at = ${acceptedAt}
            WHERE intent_id = ${intent.intentId}
          `
        }
        if (fixture.latestMutation === 'recovered') {
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence,
              operation, event_type, request_hash, consistency_delay_ms, occurred_at
            ) VALUES (
              ${canonicalHashV1({ mutationId, sequence: 2, eventType: 'SUBMIT_UNKNOWN' })},
              'bayn.paper-mutation-event.v1', ${mutationId}, ${intent.intentId}, 2,
              'SUBMIT', 'SUBMIT_UNKNOWN', ${requestHash}, 1000, ${acceptedAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET state = 'UNKNOWN', state_version = state_version + 1, updated_at = ${acceptedAt}
            WHERE intent_id = ${intent.intentId}
          `
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence,
              operation, event_type, request_hash, consistency_delay_ms,
              broker_order_id, request_id, response_status, response_content_hash, occurred_at
            ) VALUES (
              ${canonicalHashV1({ mutationId, sequence: 3, eventType: 'RECOVERY_FOUND' })},
              'bayn.paper-mutation-event.v1', ${mutationId}, ${intent.intentId}, 3,
              'SUBMIT', 'RECOVERY_FOUND', ${requestHash}, 1000,
              ${brokerOrderId}, ${fixture.requestLabel}, 200, ${fixture.responseContentHash}, ${recoveredAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET state = 'RECOVERED', state_version = state_version + 1, updated_at = ${recoveredAt}
            WHERE intent_id = ${intent.intentId}
          `
        }
        yield* sql`
          UPDATE intents
          SET
            state = 'TERMINAL',
            terminal_outcome = ${fixture.terminalOutcome},
            state_version = state_version + 1,
            updated_at = ${terminalAt}
          WHERE intent_id = ${intent.intentId}
        `
      }),
    )
    return { acceptedAt, brokerOrderId, intent, mutationId, requestHash, terminalAt }
  })

const insertFilledPlannedPaperIntent = (
  document: ExecutionDecisionDocument,
  latestMutation: 'accepted' | 'started' = 'accepted',
) =>
  insertTerminalPlannedPaperIntent(document, {
    brokerOrderPrefix: 'filled',
    latestMutation,
    requestLabel: 'filled-completion',
    responseContentHash: 'a'.repeat(64),
    terminalOutcome: 'FILLED',
  }).pipe(Effect.map((fixture) => ({ ...fixture, filledAt: fixture.terminalAt })))

const settleStartedPaperSubmit = (
  filled: Effect.Success<ReturnType<typeof insertFilledPlannedPaperIntent>>,
  occurredAt: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`
      INSERT INTO mutation_events (
        event_id, schema_version, mutation_id, intent_id, sequence,
        operation, event_type, request_hash, consistency_delay_ms,
        broker_order_id, request_id, response_status, response_content_hash, occurred_at
      ) VALUES (
        ${canonicalHashV1({ mutationId: filled.mutationId, sequence: 2, eventType: 'SUBMIT_ACCEPTED' })},
        'bayn.paper-mutation-event.v1', ${filled.mutationId}, ${filled.intent.intentId}, 2,
        'SUBMIT', 'SUBMIT_ACCEPTED', ${filled.requestHash}, 1000,
        ${filled.brokerOrderId}, 'filled-completion-recovery', 200, ${'b'.repeat(64)}, ${occurredAt}
      )
    `
  })

const insertBenignZeroFillIocPlannedIntent = (
  document: ExecutionDecisionDocument,
  latestMutation: 'accepted' | 'recovered' = 'accepted',
) =>
  insertTerminalPlannedPaperIntent(document, {
    brokerOrderPrefix: 'zero-fill',
    latestMutation,
    orderType: OrderType.Limit,
    requestLabel: 'zero-fill-ioc-completion',
    responseContentHash: 'c'.repeat(64),
    terminalOutcome: 'CANCELED',
    timeInForce: TimeInForce.ImmediateOrCancel,
  }).pipe(Effect.map((fixture) => ({ ...fixture, canceledAt: fixture.terminalAt })))

const insertBenignZeroFillIocOrder = (
  fixture: Effect.Success<ReturnType<typeof insertBenignZeroFillIocPlannedIntent>>,
  observedAt: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const eventId = canonicalHashV1({ brokerOrderId: fixture.brokerOrderId, observedAt })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO broker_events (
            event_id, schema_version, content_hash, event_kind, broker, account_id,
            source_event_id, source_sequence, occurred_at, observed_at
          ) VALUES (
            ${eventId}, 'bayn.paper-broker-event.v1', ${canonicalHashV1({ eventId, fixture: 'zero-fill-ioc' })},
            'ORDER', 'ALPACA', ${fixture.intent.accountId}, ${`zero-fill-${fixture.brokerOrderId}`}, 1,
            ${observedAt}, ${observedAt}
          )
        `
        yield* sql`
          INSERT INTO orders (
            event_id, account_id, schema_version, broker_order_id, client_order_id,
            intent_id, symbol, side, order_type, time_in_force, quantity_micros,
            filled_quantity_micros, limit_price_micros, status
          ) VALUES (
            ${eventId}, ${fixture.intent.accountId}, 'bayn.paper-order.v1', ${fixture.brokerOrderId},
            ${fixture.intent.clientOrderId}, ${fixture.intent.intentId}, ${fixture.intent.symbol},
            ${fixture.intent.side}, 'LIMIT', 'IOC', ${fixture.intent.quantityMicros}, 0, 1000000, 'CANCELED'
          )
        `
      }),
    )
    return {
      schemaVersion: 'bayn.paper-order.v1' as const,
      accountId: fixture.intent.accountId,
      brokerOrderId: fixture.brokerOrderId,
      clientOrderId: fixture.intent.clientOrderId,
      intentId: fixture.intent.intentId,
      symbol: fixture.intent.symbol,
      side: fixture.intent.side,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantityMicros: fixture.intent.quantityMicros,
      filledQuantityMicros: '0',
      limitPriceMicros: '1000000',
      status: OrderStatus.Canceled,
      observedAt,
    }
  })

type SupersededMutationFixture = 'submit-accepted' | 'submit-unknown' | 'cancel-accepted' | 'cancel-unknown'

const insertUnfinishedPlannedPaperMutation = (
  document: ExecutionDecisionDocument,
  fixture: SupersededMutationFixture,
) =>
  Effect.gen(function* () {
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk === undefined) {
      return yield* Effect.die(new Error('superseded mutation fixture requires one ordered intent'))
    }
    const intent = yield* planExecutionIntent(
      {
        schemaVersion: 'bayn.paper-intent-plan.v1',
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
        createdAt: document.createdAt,
      },
      {
        authority: {
          schemaVersion: 'bayn.paper-authority.v1',
          generationHash: document.bindings.authorityGenerationHash,
          maximum: Authority.Execution,
          effective: Authority.Execution,
          kill: KillState.Clear,
          version: 1,
          updatedAt: document.createdAt,
        },
      },
    )
    const sql = yield* PgClient.PgClient
    const intentCreatedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) - 1)
    const submitStartedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 1)
    const submitOutcomeAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 2)
    const cancelStartedAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 3)
    const cancelOutcomeAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 4)
    const submitMutationId = canonicalHashV1({ intentId: intent.intentId, operation: 'SUBMIT' })
    const cancelMutationId = canonicalHashV1({ intentId: intent.intentId, operation: 'CANCEL' })
    const submitRequestHash = canonicalHashV1({ intentId: intent.intentId, fixture, operation: 'SUBMIT' })
    const cancelRequestHash = canonicalHashV1({ intentId: intent.intentId, fixture, operation: 'CANCEL' })
    const brokerOrderId = `superseded-${intent.intentId.slice(0, 24)}`
    const submitAccepted = fixture === 'submit-accepted' || fixture.startsWith('cancel-')
    const cancelFixture = fixture.startsWith('cancel-')

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO intents (
            intent_id, schema_version, authority_generation_hash, strategy_name,
            cycle_id, decision_hash, policy_hash, account_id, client_order_id,
            symbol, side, order_type, time_in_force, quantity_micros,
            notional_limit_micros, state, created_at, updated_at
          ) VALUES (
            ${intent.intentId}, ${intent.schemaVersion}, ${intent.authorityGenerationHash},
            ${intent.strategyName}, ${intent.cycleId}, ${intent.decisionHash},
            ${intent.policyHash}, ${intent.accountId}, ${intent.clientOrderId},
            ${intent.symbol}, ${intent.side}, ${intent.orderType}, ${intent.timeInForce},
            ${intent.quantityMicros}, ${intent.notionalLimitMicros}, 'PLANNED',
            ${intentCreatedAt}, ${intentCreatedAt}
          )
        `
        yield* sql`
          INSERT INTO risk_decisions (
            decision_id, schema_version, input_hash, intent_id, policy_hash,
            outcome, reason_codes, decided_at, expires_at
          ) VALUES (
            ${risk.evaluation.decision.decisionId}, ${risk.evaluation.decision.schemaVersion},
            ${risk.evaluation.decision.inputHash}, ${risk.evaluation.decision.intentId},
            ${risk.evaluation.decision.policyHash}, ${risk.evaluation.decision.outcome},
            ${risk.evaluation.decision.reasonCodes}, ${risk.evaluation.decision.decidedAt},
            ${risk.evaluation.decision.expiresAt}
          )
        `
        yield* sql`
          UPDATE intents
          SET
            risk_decision_id = ${risk.evaluation.decision.decisionId},
            state = 'APPROVED',
            state_version = state_version + 1,
            updated_at = ${risk.evaluation.decision.decidedAt}
          WHERE intent_id = ${intent.intentId}
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence,
            operation, event_type, request_hash, consistency_delay_ms, occurred_at
          ) VALUES (
            ${canonicalHashV1({ submitMutationId, sequence: 1, eventType: 'SUBMIT_STARTED' })},
            'bayn.paper-mutation-event.v1', ${submitMutationId}, ${intent.intentId}, 1,
            'SUBMIT', 'SUBMIT_STARTED', ${submitRequestHash}, 1000, ${submitStartedAt}
          )
        `
        yield* sql`
          UPDATE intents
          SET state = 'IO_STARTED', state_version = state_version + 1, updated_at = ${submitStartedAt}
          WHERE intent_id = ${intent.intentId}
        `
        if (submitAccepted) {
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence,
              operation, event_type, request_hash, consistency_delay_ms,
              broker_order_id, request_id, response_status, response_content_hash, occurred_at
            ) VALUES (
              ${canonicalHashV1({ submitMutationId, sequence: 2, eventType: 'SUBMIT_ACCEPTED' })},
              'bayn.paper-mutation-event.v1', ${submitMutationId}, ${intent.intentId}, 2,
              'SUBMIT', 'SUBMIT_ACCEPTED', ${submitRequestHash}, 1000, ${brokerOrderId},
              ${`${fixture}-submit`}, 200, ${canonicalHashV1({ fixture, response: 'submit' })}, ${submitOutcomeAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET state = 'ACKNOWLEDGED', state_version = state_version + 1, updated_at = ${submitOutcomeAt}
            WHERE intent_id = ${intent.intentId}
          `
        } else {
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence,
              operation, event_type, request_hash, consistency_delay_ms, occurred_at
            ) VALUES (
              ${canonicalHashV1({ submitMutationId, sequence: 2, eventType: 'SUBMIT_UNKNOWN' })},
              'bayn.paper-mutation-event.v1', ${submitMutationId}, ${intent.intentId}, 2,
              'SUBMIT', 'SUBMIT_UNKNOWN', ${submitRequestHash}, 1000, ${submitOutcomeAt}
            )
          `
          yield* sql`
            UPDATE intents
            SET state = 'UNKNOWN', state_version = state_version + 1, updated_at = ${submitOutcomeAt}
            WHERE intent_id = ${intent.intentId}
          `
        }
        if (cancelFixture) {
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence,
              operation, event_type, request_hash, consistency_delay_ms, broker_order_id, occurred_at
            ) VALUES (
              ${canonicalHashV1({ cancelMutationId, sequence: 1, eventType: 'CANCEL_STARTED' })},
              'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${intent.intentId}, 1,
              'CANCEL', 'CANCEL_STARTED', ${cancelRequestHash}, 1000, ${brokerOrderId}, ${cancelStartedAt}
            )
          `
          if (fixture === 'cancel-accepted') {
            yield* sql`
              INSERT INTO mutation_events (
                event_id, schema_version, mutation_id, intent_id, sequence,
                operation, event_type, request_hash, consistency_delay_ms,
                broker_order_id, request_id, response_status, response_content_hash, occurred_at
              ) VALUES (
                ${canonicalHashV1({ cancelMutationId, sequence: 2, eventType: 'CANCEL_ACCEPTED' })},
                'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${intent.intentId}, 2,
                'CANCEL', 'CANCEL_ACCEPTED', ${cancelRequestHash}, 1000, ${brokerOrderId},
                ${`${fixture}-cancel`}, 204, ${canonicalHashV1({ fixture, response: 'cancel' })}, ${cancelOutcomeAt}
              )
            `
          } else {
            yield* sql`
              INSERT INTO mutation_events (
                event_id, schema_version, mutation_id, intent_id, sequence,
                operation, event_type, request_hash, consistency_delay_ms, broker_order_id, occurred_at
              ) VALUES (
                ${canonicalHashV1({ cancelMutationId, sequence: 2, eventType: 'CANCEL_UNKNOWN' })},
                'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${intent.intentId}, 2,
                'CANCEL', 'CANCEL_UNKNOWN', ${cancelRequestHash}, 1000, ${brokerOrderId}, ${cancelOutcomeAt}
              )
            `
          }
        }
      }),
    )
    return { intent, mutationCount: cancelFixture ? 4 : 2 }
  })

const settleSupersededMutation = (
  document: ExecutionDecisionDocument,
  intentId: string,
  fixture: SupersededMutationFixture,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const operation = fixture.startsWith('cancel-') ? 'CANCEL' : 'SUBMIT'
    const mutationId = canonicalHashV1({ intentId, operation })
    const requestHash = canonicalHashV1({ intentId, fixture, operation })
    const brokerOrderId = `superseded-${intentId.slice(0, 24)}`
    const recoveredAt = utcInstantFromEpochMillis(Date.parse(document.createdAt) + 11_000)
    const terminalAt =
      fixture === 'submit-unknown' ? utcInstantFromEpochMillis(Date.parse(recoveredAt) + 1) : recoveredAt
    const terminalOutcome = operation === 'CANCEL' ? 'CANCELED' : 'FILLED'
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence,
            operation, event_type, request_hash, consistency_delay_ms,
            broker_order_id, request_id, response_status, response_content_hash, occurred_at
          ) VALUES (
            ${canonicalHashV1({ mutationId, sequence: 3, eventType: 'RECOVERY_FOUND' })},
            'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 3,
            ${operation}, 'RECOVERY_FOUND', ${requestHash}, 1000, ${brokerOrderId},
            ${`${fixture}-recovery`}, 200, ${canonicalHashV1({ fixture, response: 'recovery' })}, ${recoveredAt}
          )
        `
        if (fixture === 'submit-unknown') {
          yield* sql`
            UPDATE intents
            SET
              state = 'RECOVERED',
              state_version = state_version + 1,
              updated_at = ${recoveredAt}
            WHERE intent_id = ${intentId}
              AND state = 'UNKNOWN'
          `
        }
        yield* sql`
          UPDATE intents
          SET
            state = 'TERMINAL',
            terminal_outcome = ${terminalOutcome},
            state_version = state_version + 1,
            updated_at = ${terminalAt}
          WHERE intent_id = ${intentId}
        `
      }),
    )
    return { recoveredAt: terminalAt }
  })

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

const runnerContext = (accountId: string): CycleRunContext => {
  const executionPolicy = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'c'.repeat(64),
    submissionWindowMs: 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  expect(Result.isSuccess(executionPolicy)).toBe(true)
  if (Result.isFailure(executionPolicy)) return expect.unreachable(executionPolicy.failure.message)
  return {
    qualificationRunId: 'a'.repeat(64),
    strategyProtocolHash: 'b'.repeat(64),
    accountId,
    executionPolicy: executionPolicy.success,
    buildDecision: () =>
      Effect.die({
        _tag: 'UnexpectedDecisionBuild',
        message: 'runner integration fixture built an unexpected decision',
      }),
  }
}

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
    accountConfiguration: unused,
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

  test('upgrades historical version 2 cycles without reinterpreting their durable contract', async () => {
    const draft = makeHistoricalV2Draft()
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({ loader: migrationLoaderBeforeIntradayNativeCycles, table: 'schema_migrations' })
        yield* sql`
          INSERT INTO autonomous_cycles (
            cycle_id, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, account_id,
            signal_session_date, signal_calendar_version,
            execution_policy_schema_version, execution_policy_hash,
            strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
            window_schema_version, execution_calendar_schema_version,
            execution_calendar_source, execution_calendar_hash, execution_session_date,
            signal_close_at, publication_deadline_at, submission_open_at,
            execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
            decision_hash, terminal_reason, state_version,
            created_at, updated_at, terminal_at
          ) VALUES (
            ${draft.identity.cycleId}, ${draft.schemaVersion}, ${draft.identity.schemaVersion},
            ${draft.identity.strategyName}, ${draft.identity.qualificationRunId},
            ${draft.identity.strategyProtocolHash}, ${draft.identity.accountId},
            ${draft.identity.signalSessionDate}, ${draft.identity.signalCalendarVersion},
            ${draft.identity.executionPolicy.schemaVersion}, ${draft.identity.executionPolicy.executionPolicyHash},
            ${draft.identity.executionPolicy.strategyExecutionModelHash},
            ${draft.identity.executionPolicy.submissionWindowMs},
            ${draft.identity.executionPolicy.submissionCutoffAfterOpenMs},
            ${draft.window.schemaVersion}, ${draft.window.executionCalendarSchemaVersion},
            ${draft.window.executionCalendarSource}, ${draft.window.executionCalendarHash},
            ${draft.window.executionSessionDate}, ${draft.window.signalCloseAt},
            ${draft.window.publicationDeadlineAt}, ${draft.window.submissionOpenAt},
            ${draft.window.executionOpenAt}, ${draft.window.executionCloseAt},
            ${draft.window.submissionCutoffAt}, ${CycleState.Pending}, NULL, NULL, NULL, 1,
            ${acquireAt}, ${acquireAt}, NULL
          )
        `
        const [before] = yield* sql<{ readonly row: unknown }>`
          SELECT to_jsonb(cycle) AS row
          FROM autonomous_cycles AS cycle
          WHERE cycle_id = ${draft.identity.cycleId}
        `

        yield* PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' })

        const [after] = yield* sql<{
          readonly after_open_ms: number | null
          readonly row: unknown
        }>`
          SELECT
            submission_cutoff_after_open_ms AS after_open_ms,
            to_jsonb(cycle) - ARRAY[
              'submission_cutoff_after_open_ms',
              'warmup_after_open_ms',
              'submission_cutoff_before_close_ms'
            ] AS row
          FROM autonomous_cycles AS cycle
          WHERE cycle_id = ${draft.identity.cycleId}
        `
        const store = yield* CycleStore
        const recovered = yield* store.read(draft.identity.cycleId)
        const bound = yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        return {
          activated,
          after,
          before: {
            row:
              typeof before.row === 'object' && before.row !== null
                ? Object.fromEntries(
                    Object.entries(before.row).filter(([key]) => key !== 'submission_cutoff_after_open_ms'),
                  )
                : before.row,
          },
          bound,
          recovered,
        }
      }),
    )

    expect(observed.after.after_open_ms).toBeNull()
    expect(observed.after.row).toEqual(observed.before.row)
    expect(observed.recovered).toEqual(
      Option.some({
        ...draft,
        state: CycleState.Pending,
        bindings: {},
        stateVersion: 1,
        createdAt: acquireAt,
        updatedAt: acquireAt,
      }),
    )
    expect(observed.bound.cycle).toMatchObject({
      schemaVersion: 'bayn.autonomous-cycle.v2',
      state: CycleState.Pending,
      bindings: { snapshotId: snapshotA },
    })
    expect(observed.activated.cycle).toMatchObject({
      schemaVersion: 'bayn.autonomous-cycle.v2',
      state: CycleState.Active,
      bindings: { snapshotId: snapshotA },
    })
  }, 30_000)

  test('preserves a terminal version 2 cycle as the intraday execution authority slot', async () => {
    const accountId = 'paper-account-v2-intraday-authority-slot'
    const historical = makeHistoricalV2Draft(accountId)
    const intraday = makeIntradayDraft(accountId, historical.identity.qualificationRunId)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(historical, acquireAt)
        const blocked = yield* store.block(
          historical.identity.cycleId,
          CycleTerminalReason.MissedSubmission,
          historical.window.submissionCutoffAt,
        )
        const authoritySlot = yield* store.readAuthoritySlot({
          qualificationRunId: intraday.identity.qualificationRunId,
          accountId,
          executionSessionDate: intraday.identity.executionSessionDate,
        })
        const duplicate = yield* Effect.exit(store.acquire(intraday, intraday.window.submissionOpenAt))
        const sql = yield* PgClient.PgClient
        const [count] = yield* sql<{ readonly count: number }>`
          SELECT count(*)::integer AS count
          FROM autonomous_cycles
          WHERE qualification_run_id = ${intraday.identity.qualificationRunId}
            AND account_id = ${accountId}
            AND execution_session_date = ${intraday.identity.executionSessionDate}
        `
        return { authoritySlot, blocked, count: count.count, duplicate }
      }),
    )

    expect(observed.blocked.cycle).toMatchObject({
      schemaVersion: 'bayn.autonomous-cycle.v2',
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedSubmission,
    })
    expect(observed.authoritySlot).toEqual(Option.some(observed.blocked.cycle))
    expect(Exit.isFailure(observed.duplicate)).toBe(true)
    if (Exit.isFailure(observed.duplicate)) {
      expect(Cause.pretty(observed.duplicate.cause)).toContain(
        'stored cycle differs from deterministic acquisition input',
      )
    }
    expect(observed.count).toBe(1)
  })

  test('persists and recovers the versioned intraday cycle without changing legacy rows', async () => {
    const draft = makeIntradayDraft()
    const document = makeIntradayShadowDecision(draft)
    const snapshotReference = makeIntradaySnapshotReference(document)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const receipt = yield* store.acquire(draft, acquireAt)
        const standaloneSnapshot = yield* Effect.exit(
          store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt),
        )
        const activated = yield* store.activate(draft.identity.cycleId, draft.window.submissionOpenAt)
        yield* insertShadowReconciliation(draft)
        const missingReference = yield* Effect.exit(
          store.bindDecision(draft.identity.cycleId, document, document.createdAt),
        )
        const bound = yield* store.bindDecision(draft.identity.cycleId, document, document.createdAt, {
          intradaySnapshotReferences: [snapshotReference],
        })
        const replay = yield* store.bindDecision(draft.identity.cycleId, structuredClone(document), document.createdAt)
        const conflictingReference = {
          ...snapshotReference,
          manifest: { ...snapshotReference.manifest, contentHash: 'f'.repeat(64) },
        } as ArchiveVerifiedIntradaySnapshotReference
        const conflictingEvidence = yield* Effect.exit(
          store.bindDecision(draft.identity.cycleId, structuredClone(document), document.createdAt, {
            intradaySnapshotReferences: [conflictingReference],
          }),
        )
        const authoritySlot = yield* store.readAuthoritySlot({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
          executionSessionDate: draft.identity.executionSessionDate,
        })
        const sql = yield* PgClient.PgClient
        const [row] = yield* sql<{
          schema_version: string
          execution_policy_schema_version: string
          submission_cutoff_before_open_ms: number | null
          submission_cutoff_after_open_ms: number | null
        }>`
          SELECT
            schema_version,
            execution_policy_schema_version,
            submission_cutoff_before_open_ms,
            submission_cutoff_after_open_ms
          FROM autonomous_cycles
          WHERE cycle_id = ${draft.identity.cycleId}
        `
        const [dailyReference] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM snapshot_references
          WHERE snapshot_id = ${document.bindings.snapshotId}
        `
        const [intradayReference] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM intraday_snapshot_references
          WHERE snapshot_id = ${document.bindings.snapshotId}
            AND content_hash = ${document.bindings.snapshotContentHash}
        `
        return {
          activated,
          authoritySlot,
          bound,
          conflictingEvidence,
          dailyReferenceCount: dailyReference.count,
          intradayReferenceCount: intradayReference.count,
          missingReference,
          receipt,
          replay,
          row,
          standaloneSnapshot,
        }
      }),
    )

    expect(observed.receipt).toMatchObject({
      created: true,
      cycle: {
        schemaVersion: 'bayn.autonomous-cycle.v3',
        identity: {
          schemaVersion: 'bayn.autonomous-cycle-identity.v3',
          strategyName: 'opening-drive-momentum',
          executionPolicy: {
            schemaVersion: 'bayn.autonomous-cycle-execution-policy.v2',
            submissionCutoffAfterOpenMs: 1_800_000,
          },
        },
        window: {
          schemaVersion: 'bayn.autonomous-cycle-window.v3',
          submissionOpenAt: '2026-03-09T13:35:01.000Z',
          submissionCutoffAt: '2026-03-09T14:00:00.000Z',
        },
      },
    })
    expect(Exit.isFailure(observed.standaloneSnapshot)).toBe(true)
    expect(observed.activated).toMatchObject({ changed: true, cycle: { state: CycleState.Active, bindings: {} } })
    expect(Exit.isFailure(observed.missingReference)).toBe(true)
    if (Exit.isFailure(observed.missingReference)) {
      expect(Cause.pretty(observed.missingReference.cause)).toContain(
        'decision does not match its durable market-data and exact reconciliation evidence',
      )
    }
    expect(observed.bound).toMatchObject({
      changed: true,
      cycle: {
        state: CycleState.Active,
        stateVersion: 3,
        bindings: {
          snapshotId: document.bindings.snapshotId,
          decisionHash: document.contentHash,
        },
      },
    })
    expect(observed.replay).toEqual({ changed: false, cycle: observed.bound.cycle })
    expect(Exit.isFailure(observed.conflictingEvidence)).toBe(true)
    if (Exit.isFailure(observed.conflictingEvidence)) {
      expect(Cause.pretty(observed.conflictingEvidence.cause)).toContain(
        'stored intraday snapshot reference diverged from the archive-verified manifest',
      )
    }
    expect(observed.authoritySlot).toEqual(Option.some(observed.bound.cycle))
    expect(observed.dailyReferenceCount).toBe(0)
    expect(observed.intradayReferenceCount).toBe(1)
    expect(observed.row).toEqual({
      schema_version: 'bayn.autonomous-cycle.v3',
      execution_policy_schema_version: 'bayn.autonomous-cycle-execution-policy.v2',
      submission_cutoff_before_open_ms: null,
      submission_cutoff_after_open_ms: 1_800_000,
    })
  })

  test('persists and recovers full-session intraday policy bounds without rewriting historical cycles', async () => {
    const draft = makeFullSessionIntradayDraft()
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const receipt = yield* store.acquire(draft, '2026-03-09T17:00:00.000Z')
        const authoritySlot = yield* store.readAuthoritySlot({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
          executionSessionDate: draft.identity.executionSessionDate,
        })
        const sql = yield* PgClient.PgClient
        const [row] = yield* sql<{
          schema_version: string
          execution_policy_schema_version: string
          submission_window_ms: number
          submission_cutoff_before_open_ms: number | null
          submission_cutoff_after_open_ms: number | null
          warmup_after_open_ms: number | null
          submission_cutoff_before_close_ms: number | null
        }>`
          SELECT
            schema_version,
            execution_policy_schema_version,
            submission_window_ms,
            submission_cutoff_before_open_ms,
            submission_cutoff_after_open_ms,
            warmup_after_open_ms,
            submission_cutoff_before_close_ms
          FROM autonomous_cycles
          WHERE cycle_id = ${draft.identity.cycleId}
        `
        const missingWarmup = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET warmup_after_open_ms = NULL
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const missingCutoff = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET submission_cutoff_before_close_ms = NULL
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        return { authoritySlot, missingCutoff, missingWarmup, receipt, row }
      }),
    )

    expect(observed.receipt).toMatchObject({
      created: true,
      cycle: {
        schemaVersion: 'bayn.autonomous-cycle.v3',
        identity: {
          strategyName: 'intraday-momentum',
          executionPolicy: {
            schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
            warmupAfterOpenMs: 1_800_000,
            submissionCutoffBeforeCloseMs: 3_600_000,
          },
        },
        window: {
          submissionOpenAt: '2026-03-09T14:00:00.000Z',
          submissionCutoffAt: '2026-03-09T19:00:00.000Z',
        },
      },
    })
    expect(observed.authoritySlot).toEqual(Option.some(observed.receipt.cycle))
    expect(Exit.isFailure(observed.missingWarmup)).toBe(true)
    expect(Exit.isFailure(observed.missingCutoff)).toBe(true)
    expect(observed.row).toEqual({
      schema_version: 'bayn.autonomous-cycle.v3',
      execution_policy_schema_version: 'bayn.autonomous-cycle-execution-policy.v3',
      submission_window_ms: 18_000_000,
      submission_cutoff_before_open_ms: null,
      submission_cutoff_after_open_ms: null,
      warmup_after_open_ms: 1_800_000,
      submission_cutoff_before_close_ms: 3_600_000,
    })
  })

  test('admits an intraday decision only against exact durable authority and risk context', async () => {
    const draft = makeFullSessionIntradayDraft()
    const forgedReconciledAt = '2026-03-09T16:58:00.000Z'
    const observedAt = '2026-03-09T17:00:00.000Z'
    const parentAuthorityUpdatedAt = '2026-03-09T16:58:30.000Z'
    const reconciliation = plannedPaperReconciliation(draft, observedAt)
    const reconciledRiskContext = reconciliation.riskContext
    if (reconciledRiskContext.authority === null || reconciledRiskContext.authorityObservedAt === null) {
      throw new Error('intraday risk-context fixture requires execution authority')
    }
    const authorityUpdatedAt = '2026-03-09T16:59:00.000Z'
    const parentAuthorityGenerationHash = 'e'.repeat(64)
    const authorityGenerationHash = 'f'.repeat(64)
    const policyHash = '9'.repeat(64)
    const riskContext = {
      ...reconciledRiskContext,
      authority: {
        ...reconciledRiskContext.authority,
        generationHash: authorityGenerationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
        updatedAt: authorityUpdatedAt,
      },
      authorityObservedAt: authorityUpdatedAt,
      unknownMutationCount: 1,
    }
    const snapshotId = 'b'.repeat(64)
    const snapshotContentHash = 'c'.repeat(64)
    const document = {
      mode: 'PAPER',
      createdAt: observedAt,
      bindings: {
        accountId: draft.identity.accountId,
        snapshotId,
        snapshotContentHash,
        snapshotFinalizedAt: observedAt,
        planningBrokerStateHash: reconciliation.report.reconciliation.observedHash,
        reconciliationId: reconciliation.report.reconciliation.reconciliationId,
        reconciliationHash: reconciliation.report.reconciliation.contentHash,
        policyHash,
        executionMarketData: { snapshotId, contentHash: snapshotContentHash, observedAt },
        riskContext,
      },
      deltaRisk: [{ facts: { state: { reconciliation: reconciliation.report.reconciliation } } }],
    } as unknown as ExecutionDecisionDocument

    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const brokerIdentity = Result.getOrThrow(
          makeBrokerIdentity({
            schemaVersion: 'bayn.broker-identity.v2',
            provider: BrokerProvider.Alpaca,
            environment: BrokerEnvironment.Sandbox,
            accountId: draft.identity.accountId,
          }),
        )
        const durableReconciliation = reconciliation.report.reconciliation
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${durableReconciliation.reconciliationId}, ${durableReconciliation.schemaVersion},
            ${durableReconciliation.accountId}, ${durableReconciliation.expectedHash},
            ${durableReconciliation.observedHash}, ${durableReconciliation.contentHash},
            ${durableReconciliation.status}, ${sql.json(encodeSqlJson(durableReconciliation.discrepancies))},
            ${durableReconciliation.reconciledAt}
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, previous_generation_hash, maximum,
            authority_version, account_id, broker_identity_schema_version,
            broker_identity_hash, broker_provider, broker_environment, activated_at
          ) VALUES (
            ${parentAuthorityGenerationHash}, 'bayn.authority-generation-history.v1', NULL, 'OBSERVE', 1,
            ${draft.identity.accountId}, ${brokerIdentity.schemaVersion}, ${brokerIdentity.identityHash},
            ${brokerIdentity.provider}, ${brokerIdentity.environment}, ${parentAuthorityUpdatedAt}
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, activation_schema_version, previous_generation_hash,
            maximum, authority_version, activation_source_revision, activation_image_repository,
            activation_image_digest, strategy_name, strategy_behavior_hash, strategy_parameter_hash,
            strategy_parameter_schema_version, strategy_protocol_hash, account_id,
            broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
            risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
            research_plan_hash, activated_at
          ) VALUES (
            ${authorityGenerationHash}, 'bayn.authority-generation-history.v1',
            'bayn.paper-authority-generation.v3', ${parentAuthorityGenerationHash}, 'PAPER', 2,
            ${'1'.repeat(40)}, 'registry.example.test/lab/bayn', ${`sha256:${'2'.repeat(64)}`},
            'intraday-momentum', ${'3'.repeat(64)}, ${'4'.repeat(64)},
            'bayn.intraday-momentum.protocol.v1', ${draft.identity.strategyProtocolHash},
            ${draft.identity.accountId}, ${brokerIdentity.schemaVersion}, ${brokerIdentity.identityHash},
            ${brokerIdentity.provider}, ${brokerIdentity.environment}, ${policyHash}, ${'5'.repeat(64)},
            ${durableReconciliation.reconciliationId}, ${durableReconciliation.contentHash},
            ${'6'.repeat(64)}, ${authorityUpdatedAt}
          )
        `
        yield* sql`
          INSERT INTO authority_state (
            singleton, schema_version, generation_hash, maximum, effective, kill_state,
            reason, version, updated_at
          ) VALUES (
            true, ${riskContext.authority.schemaVersion}, ${parentAuthorityGenerationHash},
            'OBSERVE', 'OBSERVE', ${riskContext.authority.kill}, NULL, 1, ${parentAuthorityUpdatedAt}
          )
        `
        yield* sql`
          UPDATE authority_state
          SET
            generation_hash = ${authorityGenerationHash},
            maximum = 'PAPER',
            effective = 'PAPER',
            version = 2,
            updated_at = ${authorityUpdatedAt}
          WHERE singleton
        `
        const intentId = '1'.repeat(64)
        const mutationId = '2'.repeat(64)
        const mutationRequestHash = '3'.repeat(64)
        yield* sql`
          INSERT INTO intents (
            intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
            decision_hash, policy_hash, account_id, client_order_id, symbol, side, order_type, time_in_force,
            quantity_micros, notional_limit_micros, state, terminal_outcome, state_version, created_at, updated_at
          ) VALUES (
            ${intentId}, 'bayn.paper-intent.v3', ${authorityGenerationHash}, NULL, 'intraday-momentum',
            ${draft.identity.cycleId}, ${'4'.repeat(64)}, ${'5'.repeat(64)}, ${draft.identity.accountId},
            'bayn-risk-cutoff-test', 'SPY', 'BUY', 'LIMIT', 'IOC', 1000000, 1000000,
            'PLANNED', NULL, 1, '2026-03-09T16:59:30.000Z', '2026-03-09T16:59:30.000Z'
          )
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'6'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 1,
            'SUBMIT', 'SUBMIT_STARTED', ${mutationRequestHash}, 1000, NULL, NULL, NULL, NULL,
            '2026-03-09T16:59:30.000Z'
          )
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, request_id, response_status,
            response_content_hash, occurred_at
          ) VALUES (
            ${'7'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 2,
            'SUBMIT', 'SUBMIT_REJECTED', ${mutationRequestHash}, 1000, NULL, 'risk-cutoff-rejection', 422,
            ${'8'.repeat(64)}, '2026-03-09T17:00:30.000Z'
          )
        `
        yield* sql`
          INSERT INTO valuations (
            valuation_id, schema_version, account_id, source_hash, cash_micros,
            long_market_value_micros, short_market_value_micros, equity_micros, as_of
          ) VALUES
            (
              ${'1'.repeat(64)}, 'bayn.paper-valuation.v1', ${draft.identity.accountId}, ${'2'.repeat(64)},
              ${riskContext.dayStartEquityMicros}, 0, 0, ${riskContext.dayStartEquityMicros},
              ${forgedReconciledAt}
            ),
            (
              ${'d'.repeat(64)}, 'bayn.paper-valuation.v1', ${draft.identity.accountId}, ${'e'.repeat(64)},
              ${riskContext.dayStartEquityMicros}, 0, 0, ${riskContext.dayStartEquityMicros}, ${observedAt}
            )
        `
        const queries = makeCycleQueries(sql)
        const exact = yield* queries.decisionEvidenceMatches(document)
        const forged = yield* queries.decisionEvidenceMatches({
          ...document,
          bindings: {
            ...document.bindings,
            riskContext: {
              ...riskContext,
              authority: { ...riskContext.authority, version: riskContext.authority.version + 1 },
            },
          },
        })
        const forgedReconciliationCutoff = yield* queries.decisionEvidenceMatches({
          ...document,
          deltaRisk: [
            {
              facts: {
                state: {
                  reconciliation: { ...durableReconciliation, reconciledAt: forgedReconciledAt },
                },
              },
            },
          ],
        } as unknown as ExecutionDecisionDocument)
        const forgedPolicyHash = yield* queries.decisionEvidenceMatches({
          ...document,
          bindings: { ...document.bindings, policyHash: 'a'.repeat(64) },
        } as unknown as ExecutionDecisionDocument)
        return { exact, forged, forgedPolicyHash, forgedReconciliationCutoff }
      }),
    )

    expect(observed).toEqual({
      exact: true,
      forged: false,
      forgedPolicyHash: false,
      forgedReconciliationCutoff: false,
    })
  })

  test('fences standalone cycle mutations across ready execution runtimes and hands ownership off', async () => {
    const owner = makeWriterFencedRuntime()
    const standby = makeWriterFencedRuntime()
    const draft = makeDraft('paper-account-cycle-writer-fence')

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const transactionStarted = yield* Deferred.make<void>()
        const releaseTransaction = yield* Deferred.make<void>()
        const ownerTransaction = yield* Effect.forkChild(
          Effect.promise(() =>
            owner.runPromise(
              Effect.flatMap(WriterFence, (fence) =>
                fence.transaction(
                  Deferred.succeed(transactionStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseTransaction)),
                  ),
                ),
              ),
            ),
          ),
          { startImmediately: true },
        )
        yield* Deferred.await(transactionStarted)

        const busy = yield* Effect.promise(() =>
          standby.runPromiseExit(Effect.flatMap(CycleStore, (store) => store.acquire(draft, acquireAt))),
        )
        yield* Deferred.succeed(releaseTransaction, undefined)
        yield* Fiber.join(ownerTransaction)
        const handedOff = yield* Effect.promise(() =>
          standby.runPromiseExit(Effect.flatMap(CycleStore, (store) => store.acquire(draft, acquireAt))),
        )
        return { busy, handedOff }
      }).pipe(
        Effect.ensuring(
          Effect.all([Effect.promise(() => owner.dispose()), Effect.promise(() => standby.dispose())], {
            concurrency: 'unbounded',
          }).pipe(Effect.asVoid),
        ),
      ),
    )

    expect(Exit.isFailure(observed.busy)).toBe(true)
    if (Exit.isFailure(observed.busy)) {
      expect(Cause.pretty(observed.busy.cause)).toContain(
        'autonomous cycle mutation could not acquire the PostgreSQL writer fence',
      )
      expect(Cause.pretty(observed.busy.cause)).toContain(
        'another PostgreSQL transaction owns the execution writer fence',
      )
    }
    expect(Exit.isSuccess(observed.handedOff)).toBe(true)
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
    expect(
      [...result.concurrent, result.restarted].some(
        (pass) => pass.outcome === 'RECOVERED' && pass.action === 'ACTIVATED',
      ),
    ).toBe(true)
    expect(result.restarted).toMatchObject({
      outcome: 'RECOVERED',
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
    if (result.restarted.outcome !== 'RECOVERED') return expect.unreachable('restart must recover the active cycle')
    expect(['ACTIVATED', 'WAITING']).toContain(result.restarted.action)
    expect(result.count).toBe(1)
    expect(queries).toHaveLength(result.readsAfterConcurrent)
    expect(queries.length).toBeGreaterThanOrEqual(1)
    expect(queries.length).toBeLessThanOrEqual(2)
    expect(queries.every((query) => query.start === '2026-01-30' && query.end === '2026-03-01')).toBe(true)
  })

  test('resumes an exact publication binding after a crash between acquire and bind', async () => {
    const context = runnerContext('aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb')
    const publication = runnerPublication()
    const executionSession = selectNextExecutionSession('2026-01-30', runnerCalendar())
    expect(executionSession).toBeDefined()
    if (executionSession === undefined)
      return expect.unreachable('runner calendar fixture must contain an execution session')
    const draftResult = makeDueCycleDraft(
      { ...context, signalSession: publication.inspection.signalSession },
      runnerCalendar(),
      executionSession,
    )
    expect(Result.isSuccess(draftResult)).toBe(true)
    if (Result.isFailure(draftResult)) return expect.unreachable(draftResult.failure.message)
    expect(draftResult.success).toBeDefined()
    if (draftResult.success === undefined) return expect.unreachable('runner fixture must produce a month-end cycle')
    const draft = draftResult.success
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

    const readiness = results.map((result) => {
      if (result.readiness === undefined) throw new Error('legacy month-end acquisition must include readiness')
      return result.readiness
    })
    expect(readiness.map((result) => result.cycle.state)).toEqual(cases.map((boundary) => boundary.state))
    expect(readiness.map((result) => result.cycle.updatedAt)).toEqual(cases.map((boundary) => boundary.observedAt))
    for (const result of readiness.slice(1)) {
      expect(result.cycle).toMatchObject({
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.MissedPublication,
      })
    }
    expect(
      readiness.every(
        (result) =>
          result.cycle.window.submissionOpenAt < result.cycle.window.submissionCutoffAt &&
          result.cycle.window.submissionCutoffAt < result.cycle.window.executionOpenAt,
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
      const cause = Cause.pretty(result.missingReference.cause)
      expect(cause).toContain('stored snapshot reference diverged from the finalized Signal publication')
      expect(cause).toContain('snapshot reference mismatch at manifestHash')
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

  test('binds a qualified cycle only to the exact snapshot sealed by its terminal qualification', async () => {
    const draft = makeDraft('paper-account-qualified-snapshot')

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const sql = yield* PgClient.PgClient

        yield* seedTerminalQualificationSnapshot(draft, snapshotA)

        yield* store.acquire(draft, acquireAt)
        const wrongSnapshot = yield* Effect.exit(
          store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt),
        )
        const afterWrong = yield* store.read(draft.identity.cycleId)
        const exactSnapshot = yield* store.bindSnapshot(
          draft.identity.cycleId,
          makeInputManifest(snapshotA),
          snapshotAt,
        )
        const [wrongReference] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM snapshot_references WHERE snapshot_id = ${snapshotB}
        `
        return { afterWrong, exactSnapshot, wrongReferenceCount: wrongReference.count, wrongSnapshot }
      }),
    )

    expect(Exit.isFailure(result.wrongSnapshot)).toBe(true)
    if (Exit.isFailure(result.wrongSnapshot)) {
      expect(Cause.pretty(result.wrongSnapshot.cause)).toContain(
        'autonomous cycle snapshot does not match its terminal qualified dataset',
      )
    }
    expect(result.wrongReferenceCount).toBe(0)
    expect(Option.isSome(result.afterWrong)).toBe(true)
    if (Option.isSome(result.afterWrong)) expect(result.afterWrong.value.bindings).toEqual({})
    expect(result.exactSnapshot).toMatchObject({ changed: true, cycle: { bindings: { snapshotId: snapshotA } } })
  })

  test('rejects a new snapshot binding for a rejected qualification result', async () => {
    const draft = makeDraft('paper-account-rejected-snapshot')

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore

        yield* seedTerminalQualificationSnapshot(draft, snapshotA, 'REJECTED')
        yield* store.acquire(draft, acquireAt)
        return yield* Effect.exit(store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt))
      }),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        'autonomous cycle snapshot does not match its terminal qualified dataset',
      )
    }
  })

  test('refuses to install qualified snapshot enforcement over incompatible pending history', async () => {
    const draft = makeDraft('paper-account-qualified-snapshot-migration')

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const sql = yield* PgClient.PgClient

        yield* seedTerminalQualificationSnapshot(draft, snapshotA)
        yield* sql`DROP TRIGGER autonomous_cycle_qualified_snapshot_binding ON autonomous_cycles`
        yield* sql`DROP FUNCTION enforce_qualified_cycle_snapshot_binding()`
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)

        const migration = yield* Effect.exit(qualifiedCycleSnapshotBinding)
        const [history] = yield* sql<{ snapshot_id: string; state: string }>`
          SELECT snapshot_id, state FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
        `
        const [installed] = yield* sql<{ installed: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'autonomous_cycle_qualified_snapshot_binding'
          ) AS installed
        `
        return { history, installed: installed.installed, migration }
      }),
    )

    expect(Exit.isFailure(result.migration)).toBe(true)
    if (Exit.isFailure(result.migration)) {
      expect(Cause.pretty(result.migration.cause)).toContain(
        'qualified cycle snapshot binding migration found incompatible history',
      )
    }
    expect(result.history).toEqual({ snapshot_id: snapshotB, state: CycleState.Pending })
    expect(result.installed).toBe(false)
  })

  test('refuses to install qualified snapshot enforcement over incompatible completed history', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const draft = makePlannedDraft('paper-account-qualified-snapshot-completed-migration', executionPolicy)
    const completedAt = utcInstantFromEpochMillis(Date.parse(plannedDecisionAt) + 1_000)

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const sql = yield* PgClient.PgClient

        yield* seedTerminalQualificationSnapshot(draft, snapshotA)
        yield* sql`DROP TRIGGER autonomous_cycle_qualified_snapshot_binding ON autonomous_cycles`
        yield* sql`DROP FUNCTION enforce_qualified_cycle_snapshot_binding()`
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        const planned = yield* buildPlannedObserveDecision(activated.cycle, snapshotB)
        if (planned.document.targetPlan.status !== TargetPlanStatus.Planned) {
          return yield* Effect.die(new Error('completed migration fixture requires a planned OBSERVE decision'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* store.bindDecision(draft.identity.cycleId, planned.document, plannedDecisionAt)
        yield* store.finish(draft.identity.cycleId, CycleState.Completed, completedAt)

        const migration = yield* Effect.exit(qualifiedCycleSnapshotBinding)
        const [history] = yield* sql<{ snapshot_id: string; state: string }>`
          SELECT snapshot_id, state FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
        `
        const [installed] = yield* sql<{ installed: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'autonomous_cycle_qualified_snapshot_binding'
          ) AS installed
        `
        return { history, installed: installed.installed, migration }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(result.migration)).toBe(true)
    if (Exit.isFailure(result.migration)) {
      expect(Cause.pretty(result.migration.cause)).toContain(
        'qualified cycle snapshot binding migration found incompatible history',
      )
    }
    expect(result.history).toEqual({ snapshot_id: snapshotB, state: CycleState.Completed })
    expect(result.installed).toBe(false)
  })

  test('installs qualified snapshot enforcement over completed rejected history', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const draft = makePlannedDraft('paper-account-rejected-snapshot-migration', executionPolicy)
    const completedAt = utcInstantFromEpochMillis(Date.parse(plannedDecisionAt) + 1_000)

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const sql = yield* PgClient.PgClient

        yield* seedTerminalQualificationSnapshot(draft, snapshotA, 'REJECTED')
        yield* sql`DROP TRIGGER autonomous_cycle_qualified_snapshot_binding ON autonomous_cycles`
        yield* sql`DROP FUNCTION enforce_qualified_cycle_snapshot_binding()`
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        const planned = yield* buildPlannedObserveDecision(activated.cycle, snapshotB)
        if (planned.document.targetPlan.status !== TargetPlanStatus.Planned) {
          return yield* Effect.die(new Error('rejected migration fixture requires a planned OBSERVE decision'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* store.bindDecision(draft.identity.cycleId, planned.document, plannedDecisionAt)
        yield* store.finish(draft.identity.cycleId, CycleState.Completed, completedAt)

        yield* qualifiedCycleSnapshotBinding
        const [history] = yield* sql<{ snapshot_id: string; state: string }>`
          SELECT snapshot_id, state FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
        `
        const [installed] = yield* sql<{ installed: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'autonomous_cycle_qualified_snapshot_binding'
          ) AS installed
        `
        return { history, installed: installed.installed }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.history).toEqual({ snapshot_id: snapshotB, state: CycleState.Completed })
    expect(result.installed).toBe(true)
  })

  test('refuses to install qualified snapshot enforcement over pending rejected history', async () => {
    const draft = makeDraft('paper-account-rejected-pending-migration')

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const sql = yield* PgClient.PgClient

        yield* seedTerminalQualificationSnapshot(draft, snapshotA, 'REJECTED')
        yield* sql`DROP TRIGGER autonomous_cycle_qualified_snapshot_binding ON autonomous_cycles`
        yield* sql`DROP FUNCTION enforce_qualified_cycle_snapshot_binding()`
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt)

        const migration = yield* Effect.exit(qualifiedCycleSnapshotBinding)
        const [installed] = yield* sql<{ installed: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'autonomous_cycle_qualified_snapshot_binding'
          ) AS installed
        `
        return { installed: installed.installed, migration }
      }),
    )

    expect(Exit.isFailure(result.migration)).toBe(true)
    if (Exit.isFailure(result.migration)) {
      expect(Cause.pretty(result.migration.cause)).toContain(
        'qualified cycle snapshot binding migration found incompatible history',
      )
    }
    expect(result.installed).toBe(false)
  })

  test('locks cycle writers from qualified-history validation through trigger installation', async () => {
    const draft = makeDraft('paper-account-qualified-snapshot-migration-race')
    const blocker = makeRuntime()
    const writer = makeRuntime()

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CycleStore
          const sql = yield* PgClient.PgClient

          yield* seedTerminalQualificationSnapshot(draft, snapshotA)
          yield* sql`DROP TRIGGER autonomous_cycle_qualified_snapshot_binding ON autonomous_cycles`
          yield* sql`DROP FUNCTION enforce_qualified_cycle_snapshot_binding()`
          yield* store.acquire(draft, acquireAt)

          const qualificationLockHeld = yield* Deferred.make<void>()
          const releaseQualificationLock = yield* Deferred.make<void>()
          const blockerFiber = yield* Effect.forkChild(
            Effect.promise(() =>
              blocker.runPromise(
                Effect.gen(function* () {
                  const blockerSql = yield* PgClient.PgClient
                  yield* blockerSql.withTransaction(
                    Effect.gen(function* () {
                      yield* blockerSql`LOCK TABLE qualification_results IN ACCESS EXCLUSIVE MODE`
                      yield* Deferred.succeed(qualificationLockHeld, undefined)
                      yield* Deferred.await(releaseQualificationLock)
                    }),
                  )
                }),
              ),
            ),
            { startImmediately: true },
          )
          yield* Deferred.await(qualificationLockHeld)

          return yield* Effect.gen(function* () {
            const migrationFiber = yield* Effect.forkChild(Effect.exit(qualifiedCycleSnapshotBinding), {
              startImmediately: true,
            })

            let migrationLockHeld = false
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const [lock] = yield* sql<{ held: boolean }>`
                SELECT EXISTS (
                  SELECT 1
                  FROM pg_locks AS held_lock
                  JOIN pg_class AS relation ON relation.oid = held_lock.relation
                  WHERE held_lock.pid <> pg_backend_pid()
                    AND held_lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                    AND relation.relname = 'autonomous_cycles'
                    AND held_lock.mode = 'ShareRowExclusiveLock'
                    AND held_lock.granted
                ) AS held
              `
              if (lock.held) {
                migrationLockHeld = true
                break
              }
              yield* Effect.sleep(Duration.millis(10))
            }
            if (!migrationLockHeld) {
              return yield* Effect.die(
                new Error('qualified snapshot migration did not lock cycle writers before validating history'),
              )
            }

            const writerFiber = yield* Effect.forkChild(
              Effect.promise(() =>
                writer.runPromiseExit(
                  Effect.flatMap(CycleStore, (writerStore) =>
                    writerStore.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotB), snapshotAt),
                  ),
                ),
              ),
              { startImmediately: true },
            )

            let writerBlocked = false
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const [activity] = yield* sql<{ blocked: boolean }>`
                SELECT EXISTS (
                  SELECT 1
                  FROM pg_stat_activity
                  WHERE pid <> pg_backend_pid()
                    AND datname = current_database()
                    AND wait_event_type = 'Lock'
                    AND query ILIKE '%UPDATE autonomous_cycles%'
                ) AS blocked
              `
              if (activity.blocked) {
                writerBlocked = true
                break
              }
              yield* Effect.sleep(Duration.millis(10))
            }
            if (!writerBlocked) {
              return yield* Effect.die(new Error('concurrent cycle writer did not wait for migration enforcement'))
            }

            yield* Deferred.succeed(releaseQualificationLock, undefined)
            yield* Fiber.join(blockerFiber)
            const migration = yield* Fiber.join(migrationFiber)
            const write = yield* Fiber.join(writerFiber)
            const [history] = yield* sql<{ snapshot_id: string | null }>`
              SELECT snapshot_id FROM autonomous_cycles WHERE cycle_id = ${draft.identity.cycleId}
            `
            const [wrongReference] = yield* sql<{ count: number }>`
              SELECT count(*)::integer AS count FROM snapshot_references WHERE snapshot_id = ${snapshotB}
            `
            const [trigger] = yield* sql<{ installed: boolean }>`
              SELECT EXISTS (
                SELECT 1 FROM pg_trigger WHERE tgname = 'autonomous_cycle_qualified_snapshot_binding'
              ) AS installed
            `
            return {
              history,
              migration,
              triggerInstalled: trigger.installed,
              write,
              wrongReferenceCount: wrongReference.count,
            }
          }).pipe(Effect.ensuring(Deferred.succeed(releaseQualificationLock, undefined).pipe(Effect.ignore)))
        }),
      )

      expect(Exit.isSuccess(result.migration)).toBe(true)
      expect(Exit.isFailure(result.write)).toBe(true)
      if (Exit.isFailure(result.write)) {
        expect(Cause.pretty(result.write.cause)).toContain(
          'autonomous cycle snapshot does not match its terminal qualified dataset',
        )
      }
      expect(result.history.snapshot_id).toBeNull()
      expect(result.wrongReferenceCount).toBe(0)
      expect(result.triggerInstalled).toBe(true)
    } finally {
      await blocker.dispose()
      await writer.dispose()
    }
  }, 15_000)

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

  test('persists and recovers one immutable PAPER no-trade decision across store restart', async () => {
    const draft = makeDraft('paper-account-paper-decision-restart')
    const document = makePaperNoTradeDecision(draft, snapshotA)

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        yield* store.activate(draft.identity.cycleId, activeAt)
        yield* insertShadowReconciliation(draft)
        yield* store.bindDecision(draft.identity.cycleId, document, decisionAt)
      }),
    )

    await runtime.dispose()
    runtime = makeRuntime()

    const recovered = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        return yield* store.readDecisionDocument(draft.identity.cycleId)
      }),
    )

    expect(Option.isSome(recovered)).toBe(true)
    if (Option.isNone(recovered)) return expect.unreachable('PAPER decision must survive store restart')
    expect(recovered.value).toEqual(document)
    expect(recovered.value).toMatchObject({
      mode: 'PAPER',
      dispatchable: true,
      bindings: { authorityGenerationHash: 'a'.repeat(64) },
      orderedIntentIds: [],
    })
  })

  test('projects a research PAPER generation into exact forward-performance strategy evidence', async () => {
    const researchPlanHash = '7'.repeat(64)
    const parentGenerationHash = '6'.repeat(64)
    const accountId = 'paper-account-research-forward-performance'
    const draft = makeDraft(accountId, { qualificationRunId: researchPlanHash })
    const reconciliation = shadowReconciliation(draft)
    const sourceRevision = '1'.repeat(40)
    const imageRepository = 'registry.example.com/lab/bayn'
    const imageDigest = `sha256:${'2'.repeat(64)}`
    const strategyBehaviorHash = '3'.repeat(64)
    const strategyParameterHash = '4'.repeat(64)
    const riskPolicyHash = '2'.repeat(64)
    const brokerIdentity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId,
      }),
    )
    const generation = Result.getOrThrow(
      makeResearchCapitalGrantGenerationResult({
        schemaVersion: 'bayn.paper-authority-generation.v3',
        maximum: Authority.Execution,
        previousGenerationHash: parentGenerationHash,
        grant: { _tag: 'Research', planHash: researchPlanHash },
        activationSourceRevision: sourceRevision,
        activationImageRepository: imageRepository,
        activationImageDigest: imageDigest,
        strategyName: draft.identity.strategyName,
        strategyBehaviorHash,
        strategyParameterHash,
        strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v3',
        strategyProtocolHash: draft.identity.strategyProtocolHash,
        accountId,
        brokerIdentityHash: brokerIdentity.identityHash,
        riskPolicyHash,
        proofPlanHash: researchPlanHash,
        reconciliationId: reconciliation.reconciliationId,
        reconciliationContentHash: reconciliation.contentHash,
      }),
    )
    const document = makePaperNoTradeDecision(draft, snapshotA, generation.generationHash)

    const evidence = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const sql = yield* PgClient.PgClient
        yield* insertShadowReconciliation(draft)
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, previous_generation_hash, maximum,
            authority_version, activated_at
          ) VALUES (
            ${parentGenerationHash}, 'bayn.authority-generation-history.v1', NULL,
            'OBSERVE', 1, '2026-03-06T21:00:00.000Z'
          )
        `
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, activation_schema_version,
            previous_generation_hash, maximum, authority_version,
            activation_source_revision, activation_image_repository, activation_image_digest,
            strategy_name, strategy_behavior_hash, strategy_parameter_hash,
            strategy_parameter_schema_version, strategy_protocol_hash, account_id,
            broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
            risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
            research_plan_hash, activated_at
          ) VALUES (
            ${generation.generationHash}, 'bayn.authority-generation-history.v1', ${generation.schemaVersion},
            ${generation.previousGenerationHash}, 'PAPER', 2,
            ${generation.activationSourceRevision}, ${generation.activationImageRepository},
            ${generation.activationImageDigest}, ${generation.strategyName}, ${generation.strategyBehaviorHash},
            ${generation.strategyParameterHash}, ${generation.strategyParameterSchemaVersion},
            ${generation.strategyProtocolHash}, ${generation.accountId}, ${brokerIdentity.schemaVersion},
            ${brokerIdentity.identityHash}, ${brokerIdentity.provider}, ${brokerIdentity.environment},
            ${generation.riskPolicyHash}, ${generation.proofPlanHash}, ${generation.reconciliationId},
            ${generation.reconciliationContentHash}, ${generation.grant.planHash},
            '2026-03-06T21:02:30.000Z'
          )
        `
        yield* store.acquire(draft, '2026-03-06T21:03:00.000Z')
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), '2026-03-06T21:04:00.000Z')
        yield* store.activate(draft.identity.cycleId, '2026-03-06T21:05:00.000Z')
        yield* store.bindDecision(draft.identity.cycleId, document, decisionAt)
        yield* store.finish(draft.identity.cycleId, CycleState.NoTrade, terminalAt)
        return yield* readForwardPerformancePostgres(sql, accountId, generation.generationHash)
      }),
    )

    expect(evidence.cycles).toEqual([
      expect.objectContaining({
        cycleId: draft.identity.cycleId,
        qualificationRunId: researchPlanHash,
        strategyProtocolHash: draft.identity.strategyProtocolHash,
        state: CycleState.NoTrade,
      }),
    ])
    expect(evidence.strategy).toEqual({
      qualificationRunId: researchPlanHash,
      strategyName: draft.identity.strategyName,
      strategyProtocolHash: draft.identity.strategyProtocolHash,
      strategyBehaviorHash,
      strategyParameterHash,
      strategyParameterSchemaVersion: generation.strategyParameterSchemaVersion,
      sourceRevision,
      imageRepository,
      imageDigest,
    })
    expect(evidence.unclosedCycleCount).toBe(0)
  })

  test('terminalizes an expired untouched PAPER plan and releases oldest-unfinished selection', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const draft = makePlannedDraft('paper-account-expired-planned', executionPolicy)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA)
        if (
          planned.document.targetPlan.status !== TargetPlanStatus.Planned ||
          planned.document.deltaRisk.length === 0
        ) {
          return yield* Effect.die(new Error('PAPER expiry fixture requires a planned mutation'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* insertQualifiedPaperLineage(planned.document)
        yield* store.bindDecision(draft.identity.cycleId, planned.document, plannedDecisionAt)

        const riskExpiresAt = planned.document.deltaRisk[0]?.evaluation.decision.expiresAt
        if (riskExpiresAt === undefined) return yield* Effect.die(new Error('PAPER risk expiry is missing'))
        const beforeRiskExpiry = utcInstantFromEpochMillis(Date.parse(riskExpiresAt) - 1)
        const beforeSubmissionCutoff = utcInstantFromEpochMillis(Date.parse(draft.window.submissionCutoffAt) - 1)
        const sql = yield* PgClient.PgClient
        const directEarlyRisk = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Risk},
            state_version = state_version + 1,
            updated_at = ${beforeRiskExpiry},
            terminal_at = ${beforeRiskExpiry}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directEarlyCutoff = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.MissedSubmission},
            state_version = state_version + 1,
            updated_at = ${beforeSubmissionCutoff},
            terminal_at = ${beforeSubmissionCutoff}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directWrongReason = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Reconciliation},
            state_version = state_version + 1,
            updated_at = ${riskExpiresAt},
            terminal_at = ${riskExpiresAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)

        const blocked = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, riskExpiresAt)
        const replayed = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, riskExpiresAt)
        const unfinished = yield* store.readOldestUnfinished({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
        })
        const [counts] = yield* sql<{
          authorityGenerations: number
          authorityStates: number
          intents: number
          mutations: number
          orders: number
        }>`
          SELECT
            (
              SELECT count(*)::integer
              FROM authority_generations
              WHERE account_id = ${draft.identity.accountId}
            ) AS "authorityGenerations",
            (SELECT count(*)::integer FROM authority_state) AS "authorityStates",
            (SELECT count(*)::integer FROM intents WHERE account_id = ${draft.identity.accountId}) AS intents,
            (
              SELECT count(*)::integer
              FROM mutation_events AS event
              JOIN intents AS intent USING (intent_id)
              WHERE intent.account_id = ${draft.identity.accountId}
            ) AS mutations,
            (SELECT count(*)::integer FROM orders WHERE account_id = ${draft.identity.accountId}) AS orders
        `
        const [migration] = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name
          FROM schema_migrations
          WHERE migration_id = 21
        `
        return {
          blocked,
          counts,
          directEarlyCutoff,
          directEarlyRisk,
          directWrongReason,
          document: planned.document,
          migration,
          replayed,
          unfinished,
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.document).toMatchObject({
      mode: 'PAPER',
      dispatchable: true,
      targetPlan: { status: TargetPlanStatus.Planned },
    })
    expect(Exit.isFailure(result.directEarlyRisk)).toBe(true)
    expect(Exit.isFailure(result.directEarlyCutoff)).toBe(true)
    expect(Exit.isFailure(result.directWrongReason)).toBe(true)
    expect(result.blocked.changed).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.Risk,
    })
    expect(result.replayed.changed).toBe(false)
    expect(result.replayed.cycle).toEqual(result.blocked.cycle)
    expect(Option.isNone(result.unfinished)).toBe(true)
    expect(result.counts).toEqual({
      authorityGenerations: 2,
      authorityStates: 0,
      intents: 0,
      mutations: 0,
      orders: 0,
    })
    expect(result.migration).toEqual({ migration_id: 21, name: 'expired_paper_cycle_terminalization' })
  })

  test('terminalizes a PAPER cycle whose immutable authority generation has a durable descendant', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const draft = makePlannedDraft('paper-account-superseded-generation', executionPolicy)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA)
        if (planned.document.targetPlan.status !== TargetPlanStatus.Planned) {
          return yield* Effect.die(new Error('superseded PAPER fixture requires a planned decision'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* insertQualifiedPaperLineage(planned.document)
        yield* store.bindDecision(draft.identity.cycleId, planned.document, plannedDecisionAt)
        const successor = yield* insertSupersedingObserveGeneration(planned.document)
        const directWrongReason = yield* Effect.exit(
          store.block(draft.identity.cycleId, CycleTerminalReason.Risk, successor.activatedAt),
        )
        const blocked = yield* store.block(
          draft.identity.cycleId,
          CycleTerminalReason.ProvenanceMismatch,
          successor.activatedAt,
        )
        const replayed = yield* store.block(
          draft.identity.cycleId,
          CycleTerminalReason.ProvenanceMismatch,
          successor.activatedAt,
        )
        const unfinished = yield* store.readOldestUnfinished({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
        })
        const sql = yield* PgClient.PgClient
        const [counts] = yield* sql<{
          authorityGenerations: number
          authorityStates: number
          intents: number
          mutations: number
          orders: number
        }>`
          SELECT
            (
              SELECT count(*)::integer
              FROM authority_generations
              WHERE account_id = ${draft.identity.accountId}
            ) AS "authorityGenerations",
            (SELECT count(*)::integer FROM authority_state) AS "authorityStates",
            (SELECT count(*)::integer FROM intents WHERE account_id = ${draft.identity.accountId}) AS intents,
            (
              SELECT count(*)::integer
              FROM mutation_events AS event
              JOIN intents AS intent USING (intent_id)
              WHERE intent.account_id = ${draft.identity.accountId}
            ) AS mutations,
            (SELECT count(*)::integer FROM orders WHERE account_id = ${draft.identity.accountId}) AS orders
        `
        return { blocked, counts, directWrongReason, replayed, successor, unfinished }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(result.directWrongReason)).toBe(true)
    expect(result.blocked.changed).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.ProvenanceMismatch,
      terminalAt: result.successor.activatedAt,
    })
    expect(result.replayed.changed).toBe(false)
    expect(result.replayed.cycle).toEqual(result.blocked.cycle)
    expect(Option.isNone(result.unfinished)).toBe(true)
    expect(result.counts).toEqual({
      authorityGenerations: 3,
      authorityStates: 0,
      intents: 0,
      mutations: 0,
      orders: 0,
    })
  })

  test('atomically rolls back a rejected PAPER block and commits a settled PAPER block with restriction', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const atomicRuntime = makeAutonomousRuntime()
    try {
      const result = await atomicRuntime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const writerFence = yield* WriterFence
          const [clock] = yield* sql<{ evaluated_at: string }>`
          SELECT to_char(
            (clock_timestamp() - interval '1 minute') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS evaluated_at
        `
          if (clock === undefined) return yield* Effect.die(new Error('database Clock returned no row'))
          const {
            evaluationAt: evaluatedAt,
            executionOpenAt,
            executionSessionDate,
            signalSessionDate,
            snapshotBoundAt,
          } = monthEndExecutionWindow(clock.evaluated_at)
          const draft = makeDraft('paper-account-atomic-terminalization', {
            executionPolicy,
            executionCloseAt: `${executionSessionDate}T23:59:59.999Z`,
            executionOpenAt,
            executionSessionDate,
            signalSessionDate,
          })
          const acquisitionAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) + 60_000)
          const activatedAt = utcInstantFromEpochMillis(Date.parse(snapshotBoundAt) + 1_000)
          const manifest = makeInputManifest(snapshotA, {
            asOfSession: signalSessionDate,
            finalizedAt: snapshotBoundAt,
            lastSession: signalSessionDate,
          })
          const store = yield* CycleStore
          const blockedCycleIntentStore = yield* BlockedCycleIntentStore
          yield* store.acquire(draft, acquisitionAt)
          yield* store.bindSnapshot(draft.identity.cycleId, manifest, snapshotBoundAt)
          const activated = yield* store.activate(draft.identity.cycleId, activatedAt)
          const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA, {
            evaluatedAt,
            snapshotFinalizedAt: snapshotBoundAt,
          })
          if (planned.document.targetPlan.status !== TargetPlanStatus.Planned) {
            return yield* Effect.die(new Error('atomic terminalization fixture requires a planned PAPER decision'))
          }
          yield* insertReconciliation(planned.reconciliation)
          yield* insertQualifiedPaperLineage(planned.document)
          const unfinished = yield* insertUnfinishedPlannedPaperMutation(planned.document, 'cancel-unknown')
          const bound = yield* store.bindDecision(draft.identity.cycleId, planned.document, evaluatedAt)
          yield* sql`
          INSERT INTO authority_state (
            schema_version, generation_hash, maximum, effective, kill_state,
            reason, version, updated_at
          ) VALUES (
            'bayn.paper-authority.v1', ${'9'.repeat(64)},
            'OBSERVE', 'OBSERVE', 'CLEAR', NULL, 1,
            ${utcInstantFromEpochMillis(Date.parse(planned.document.createdAt) - 1_000)}
          )
        `
          yield* sql`
          UPDATE authority_state
          SET
            generation_hash = ${planned.document.bindings.authorityGenerationHash},
            maximum = 'PAPER',
            effective = 'PAPER',
            version = 2,
            updated_at = ${planned.document.createdAt}
          WHERE singleton
        `

          const terminalization = yield* Effect.exit(
            terminalizeBlockedExecutionCycle(
              bound.cycle,
              {
                _tag: 'Block',
                reason: CycleTerminalReason.MissedSubmission,
                observedAt: draft.window.submissionCutoffAt,
              },
              planned.document.bindings.authorityGenerationHash,
              blockedCycleIntentStore,
            ),
          )
          const [authorityAfterRejectedBlock] = yield* sql<{
            effective: string
            kill_state: string
            reason: string | null
            version: string
          }>`
          SELECT effective, kill_state, reason, version
          FROM authority_state
          WHERE singleton
        `
          const cycleAfterRejectedBlock = yield* store.read(draft.identity.cycleId)
          const settled = yield* settleSupersededMutation(
            planned.document,
            unfinished.intent.intentId,
            'cancel-unknown',
          )
          const committed = yield* terminalizeBlockedExecutionCycle(
            bound.cycle,
            {
              _tag: 'Block',
              reason: CycleTerminalReason.Risk,
              observedAt: settled.recoveredAt,
            },
            planned.document.bindings.authorityGenerationHash,
            blockedCycleIntentStore,
          )
          const staleIntentId = canonicalHashV1({ cycleId: draft.identity.cycleId, fixture: 'stale-approved' })
          const staleDecisionId = canonicalHashV1({ intentId: staleIntentId, fixture: 'risk-decision' })
          const staleInputHash = canonicalHashV1({ intentId: staleIntentId, fixture: 'risk-input' })
          const [staleTiming] = yield* sql<{ decided_at: string; observed_at: string }>`
            SELECT
              to_char(
                clock_timestamp() AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS decided_at,
              to_char(
                greatest(clock_timestamp(), cycle.terminal_at + interval '1 hour') AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS observed_at
            FROM autonomous_cycles AS cycle
            WHERE cycle.cycle_id = ${draft.identity.cycleId}
          `
          if (staleTiming === undefined) return yield* Effect.die(new Error('stale intent timing is unavailable'))
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, authority_generation_hash, strategy_name,
              cycle_id, decision_hash, policy_hash, account_id, client_order_id,
              symbol, side, order_type, time_in_force, quantity_micros,
              notional_limit_micros, state, created_at, updated_at
            )
            SELECT
              ${staleIntentId}, source.schema_version, source.authority_generation_hash, source.strategy_name,
              source.cycle_id, source.decision_hash, source.policy_hash, source.account_id,
              ${`stale-${staleIntentId.slice(0, 24)}`}, 'ZZZ', source.side, source.order_type,
              source.time_in_force, source.quantity_micros, source.notional_limit_micros,
              'PLANNED', ${staleTiming.decided_at}::timestamptz - interval '1 millisecond',
              ${staleTiming.decided_at}::timestamptz - interval '1 millisecond'
            FROM intents AS source
            WHERE source.intent_id = ${unfinished.intent.intentId}
          `
          yield* writerFence.transaction(
            sql`
              INSERT INTO risk_decisions (
                decision_id, schema_version, input_hash, intent_id, policy_hash,
                outcome, reason_codes, decided_at, expires_at
              )
              SELECT
                ${staleDecisionId}, source.schema_version, ${staleInputHash}, ${staleIntentId}, source.policy_hash,
                'APPROVED', ARRAY[]::text[], ${staleTiming.decided_at}::timestamptz,
                ${staleTiming.decided_at}::timestamptz + interval '1 hour'
              FROM risk_decisions AS source
              WHERE source.intent_id = ${unfinished.intent.intentId}
            `.pipe(
              Effect.andThen(sql`
                UPDATE intents
                SET
                  risk_decision_id = ${staleDecisionId},
                  state = 'APPROVED',
                  state_version = state_version + 1,
                  updated_at = ${staleTiming.decided_at}::timestamptz
                WHERE intent_id = ${staleIntentId}
              `),
            ),
          )
          const settlement = yield* writerFence.transaction(
            blockedCycleIntentStore.settleCurrentTerminalGeneration({
              accountId: draft.identity.accountId,
              observedAt: staleTiming.observed_at,
            }),
          )
          const replay = yield* writerFence.transaction(
            blockedCycleIntentStore.settleCurrentTerminalGeneration({
              accountId: draft.identity.accountId,
              observedAt: utcInstantFromEpochMillis(Date.parse(staleTiming.observed_at) + 1),
            }),
          )
          const [staleIntent] = yield* sql<{ state: string; terminal_outcome: string | null }>`
            SELECT state, terminal_outcome
            FROM intents
            WHERE intent_id = ${staleIntentId}
          `
          const [authorityAfterCommittedBlock] = yield* sql<{
            effective: string
            kill_state: string
            reason: string | null
            version: string
          }>`
          SELECT effective, kill_state, reason, version
          FROM authority_state
          WHERE singleton
        `
          return {
            authorityAfterCommittedBlock,
            authorityAfterRejectedBlock,
            committed,
            cycleAfterRejectedBlock,
            replay,
            settlement,
            staleIntent,
            terminalization,
          }
        }).pipe(Effect.provide(TestClock.layer())),
      )

      expect(Exit.isFailure(result.terminalization)).toBe(true)
      if (Exit.isFailure(result.terminalization)) {
        expect(Cause.squash(result.terminalization.cause)).toMatchObject({
          failure: 'store',
          message: 'blocked execution cycle finalization failed',
        })
      }
      expect(result.authorityAfterRejectedBlock).toEqual({
        effective: 'PAPER',
        kill_state: 'CLEAR',
        reason: null,
        version: '2',
      })
      expect(Option.getOrUndefined(result.cycleAfterRejectedBlock)).toMatchObject({ state: CycleState.Active })
      expect(result.committed).toMatchObject({ action: 'BLOCKED', cycle: { state: CycleState.Blocked } })
      if (result.committed.outcome !== 'RECOVERED' || result.committed.action !== 'BLOCKED') {
        return expect.unreachable('settled PAPER terminalization must return a blocked recovery receipt')
      }
      expect(result.authorityAfterCommittedBlock).toMatchObject({
        effective: 'OBSERVE',
        kill_state: 'ACTIVE',
        version: '3',
      })
      expect(result.authorityAfterCommittedBlock?.reason).toContain(
        `bound cycle ${result.committed.cycle.identity.cycleId} blocked: BLOCKED_RISK`,
      )
      expect(result.settlement).toMatchObject({
        _tag: 'TerminalGenerationSettled',
        authorityGenerationHash: plannedPaperGenerationHash,
        blockedCycleCount: 1,
        blockedIntentCount: 0,
        expiredIntentCount: 1,
        intentCount: 2,
        terminalIntentCount: 2,
      })
      expect(result.replay).toMatchObject({
        _tag: 'TerminalGenerationSettled',
        blockedIntentCount: 0,
        expiredIntentCount: 0,
        intentCount: 2,
        terminalIntentCount: 2,
      })
      expect(result.staleIntent).toEqual({ state: 'TERMINAL', terminal_outcome: 'EXPIRED' })
    } finally {
      await atomicRuntime.dispose()
    }
  }, 15_000)

  test.each(['submit-accepted', 'submit-unknown', 'cancel-accepted', 'cancel-unknown'] as const)(
    'keeps superseded %s mutation history recoverable before an exact idempotent provenance block',
    async (fixture) => {
      const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [clock] = yield* sql<{ evaluated_at: string }>`
            SELECT to_char(
              (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS evaluated_at
          `
          if (clock === undefined) return yield* Effect.die(new Error('database Clock returned no row'))
          const {
            evaluationAt: evaluatedAt,
            executionOpenAt,
            executionSessionDate,
            signalSessionDate,
            snapshotBoundAt,
          } = monthEndExecutionWindow(clock.evaluated_at)
          const draft = makeDraft(`paper-account-superseded-${fixture}`, {
            executionPolicy,
            executionCloseAt: `${executionSessionDate}T23:59:59.999Z`,
            executionOpenAt,
            executionSessionDate,
            signalSessionDate,
          })
          const acquisitionAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) + 60_000)
          const activatedAt = utcInstantFromEpochMillis(Date.parse(snapshotBoundAt) + 1_000)
          const manifest = makeInputManifest(snapshotA, {
            asOfSession: signalSessionDate,
            finalizedAt: snapshotBoundAt,
            lastSession: signalSessionDate,
          })
          const store = yield* CycleStore
          yield* store.acquire(draft, acquisitionAt)
          yield* store.bindSnapshot(draft.identity.cycleId, manifest, snapshotBoundAt)
          const activated = yield* store.activate(draft.identity.cycleId, activatedAt)
          const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA, {
            evaluatedAt,
            snapshotFinalizedAt: snapshotBoundAt,
          })
          if (planned.document.targetPlan.status !== TargetPlanStatus.Planned) {
            return yield* Effect.die(new Error('superseded mutation fixture requires a planned PAPER decision'))
          }
          yield* insertReconciliation(planned.reconciliation)
          yield* insertQualifiedPaperLineage(planned.document)
          const unfinishedMutation = yield* insertUnfinishedPlannedPaperMutation(planned.document, fixture)
          yield* store.bindDecision(draft.identity.cycleId, planned.document, evaluatedAt)
          const successor = yield* insertSupersedingObserveGeneration(planned.document)
          const rotatedQualificationRunId = 'e'.repeat(64)
          const earlierSignalSessionDate = DateTime.makeUnsafe(`${signalSessionDate}T00:00:00.000Z`).pipe(
            DateTime.subtract({ days: 1 }),
            DateTime.formatIsoDate,
          ) as IsoDate
          const currentDraft = makeDraft(draft.identity.accountId, {
            executionCloseAt: `${signalSessionDate}T23:59:59.999Z`,
            executionOpenAt: `${signalSessionDate}T20:00:00.000Z`,
            executionPolicy,
            executionSessionDate: signalSessionDate,
            qualificationRunId: rotatedQualificationRunId,
            signalSessionDate: earlierSignalSessionDate,
          })
          yield* store.acquire(
            currentDraft,
            utcInstantFromEpochMillis(Date.parse(currentDraft.window.signalCloseAt) + 60_000),
          )
          const recoveryScope = {
            qualificationRunId: rotatedQualificationRunId,
            accountId: draft.identity.accountId,
          }
          const premature = yield* Effect.exit(
            store.block(draft.identity.cycleId, CycleTerminalReason.ProvenanceMismatch, successor.activatedAt),
          )
          const unfinishedBeforeRecovery = yield* store.readOldestUnfinished(recoveryScope)
          const settled = yield* settleSupersededMutation(planned.document, unfinishedMutation.intent.intentId, fixture)
          const unfinishedReadyToTerminalize = yield* store.readOldestUnfinished(recoveryScope)
          const blocked = yield* store.block(
            draft.identity.cycleId,
            CycleTerminalReason.ProvenanceMismatch,
            settled.recoveredAt,
          )
          const replayed = yield* store.block(
            draft.identity.cycleId,
            CycleTerminalReason.ProvenanceMismatch,
            settled.recoveredAt,
          )
          const unfinishedAfterRecovery = yield* store.readOldestUnfinished(recoveryScope)
          const [counts] = yield* sql<{
            authorityGenerations: number
            authorityStates: number
            intents: number
            mutations: number
            orders: number
          }>`
            SELECT
              (
                SELECT count(*)::integer
                FROM authority_generations
                WHERE account_id = ${draft.identity.accountId}
              ) AS "authorityGenerations",
              (SELECT count(*)::integer FROM authority_state) AS "authorityStates",
              (SELECT count(*)::integer FROM intents WHERE account_id = ${draft.identity.accountId}) AS intents,
              (
                SELECT count(*)::integer
                FROM mutation_events AS event
                JOIN intents AS intent USING (intent_id)
                WHERE intent.account_id = ${draft.identity.accountId}
              ) AS mutations,
              (SELECT count(*)::integer FROM orders WHERE account_id = ${draft.identity.accountId}) AS orders
          `
          return {
            blocked,
            counts,
            premature,
            replayed,
            unfinishedAfterRecovery,
            unfinishedBeforeRecovery,
            unfinishedReadyToTerminalize,
            unfinishedMutation,
            currentDraft,
            rotatedQualificationRunId,
          }
        }).pipe(Effect.provide(TestClock.layer())),
      )

      expect(Exit.isFailure(result.premature)).toBe(true)
      expect(Option.isSome(result.unfinishedBeforeRecovery)).toBe(true)
      if (Option.isSome(result.unfinishedBeforeRecovery)) {
        expect(result.unfinishedBeforeRecovery.value.identity.cycleId).toBe(result.blocked.cycle.identity.cycleId)
        expect(result.unfinishedBeforeRecovery.value.identity.qualificationRunId).not.toBe(
          result.rotatedQualificationRunId,
        )
      }
      expect(Option.isSome(result.unfinishedReadyToTerminalize)).toBe(true)
      if (Option.isSome(result.unfinishedReadyToTerminalize)) {
        expect(result.unfinishedReadyToTerminalize.value.identity.cycleId).toBe(result.blocked.cycle.identity.cycleId)
      }
      expect(result.blocked.changed).toBe(true)
      expect(result.blocked.cycle).toMatchObject({
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.ProvenanceMismatch,
      })
      expect(result.replayed.changed).toBe(false)
      expect(result.replayed.cycle).toEqual(result.blocked.cycle)
      expect(Option.isSome(result.unfinishedAfterRecovery)).toBe(true)
      if (Option.isSome(result.unfinishedAfterRecovery)) {
        expect(result.unfinishedAfterRecovery.value.identity.cycleId).toBe(result.currentDraft.identity.cycleId)
      }
      expect(result.counts).toEqual({
        authorityGenerations: 3,
        authorityStates: 0,
        intents: 1,
        mutations: result.unfinishedMutation.mutationCount + 1,
        orders: 0,
      })
    },
    15_000,
  )

  test('rejects PAPER risk terminalization until a durable cancel outcome is recovered', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const [clock] = yield* sql<{ evaluated_at: string }>`
          SELECT to_char(
            (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS evaluated_at
        `
        if (clock === undefined) return yield* Effect.die(new Error('database Clock returned no row'))
        const {
          evaluationAt: evaluatedAt,
          executionOpenAt,
          executionSessionDate,
          signalSessionDate,
          snapshotBoundAt,
        } = monthEndExecutionWindow(clock.evaluated_at)
        const draft = makeDraft('paper-account-unresolved-cancel-terminalization', {
          executionPolicy,
          executionCloseAt: `${executionSessionDate}T23:59:59.999Z`,
          executionOpenAt,
          executionSessionDate,
          signalSessionDate,
        })
        const acquisitionAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) + 60_000)
        const activatedAt = utcInstantFromEpochMillis(Date.parse(snapshotBoundAt) + 1_000)
        const manifest = makeInputManifest(snapshotA, {
          asOfSession: signalSessionDate,
          finalizedAt: snapshotBoundAt,
          lastSession: signalSessionDate,
        })
        const store = yield* CycleStore
        yield* store.acquire(draft, acquisitionAt)
        yield* store.bindSnapshot(draft.identity.cycleId, manifest, snapshotBoundAt)
        const activated = yield* store.activate(draft.identity.cycleId, activatedAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA, {
          evaluatedAt,
          snapshotFinalizedAt: snapshotBoundAt,
        })
        if (planned.document.targetPlan.status !== TargetPlanStatus.Planned) {
          return yield* Effect.die(new Error('unresolved cancel fixture requires a planned PAPER decision'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* insertQualifiedPaperLineage(planned.document)
        const unfinished = yield* insertUnfinishedPlannedPaperMutation(planned.document, 'submit-accepted')
        yield* store.bindDecision(draft.identity.cycleId, planned.document, evaluatedAt)

        const cancelMutationId = canonicalHashV1({
          intentId: unfinished.intent.intentId,
          operation: 'CANCEL',
        })
        const cancelRequestHash = canonicalHashV1({
          intentId: unfinished.intent.intentId,
          fixture: 'cancel-terminalization',
          operation: 'CANCEL',
        })
        const brokerOrderId = `superseded-${unfinished.intent.intentId.slice(0, 24)}`
        const cancelStartedAt = utcInstantFromEpochMillis(Date.parse(planned.document.createdAt) + 3)
        const cancelUnknownAt = utcInstantFromEpochMillis(Date.parse(planned.document.createdAt) + 4)
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence,
            operation, event_type, request_hash, consistency_delay_ms, broker_order_id, occurred_at
          ) VALUES
          (
            ${canonicalHashV1({ mutationId: cancelMutationId, sequence: 1, eventType: 'CANCEL_STARTED' })},
            'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${unfinished.intent.intentId}, 1,
            'CANCEL', 'CANCEL_STARTED', ${cancelRequestHash}, 1000, ${brokerOrderId}, ${cancelStartedAt}
          ),
          (
            ${canonicalHashV1({ mutationId: cancelMutationId, sequence: 2, eventType: 'CANCEL_UNKNOWN' })},
            'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${unfinished.intent.intentId}, 2,
            'CANCEL', 'CANCEL_UNKNOWN', ${cancelRequestHash}, 1000, ${brokerOrderId}, ${cancelUnknownAt}
          )
        `
        const terminalAt = utcInstantFromEpochMillis(Date.parse(planned.document.createdAt) + 5)
        yield* sql`
          UPDATE intents
          SET
            state = 'TERMINAL',
            terminal_outcome = 'EXPIRED',
            state_version = state_version + 1,
            updated_at = ${terminalAt}
          WHERE intent_id = ${unfinished.intent.intentId}
        `
        const unresolvedBlock = yield* Effect.exit(
          store.block(draft.identity.cycleId, CycleTerminalReason.Risk, terminalAt),
        )

        const recoveryAt = utcInstantFromEpochMillis(Date.parse(planned.document.createdAt) + 11_000)
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence,
            operation, event_type, request_hash, consistency_delay_ms,
            broker_order_id, request_id, response_status, response_content_hash, occurred_at
          ) VALUES (
            ${canonicalHashV1({ mutationId: cancelMutationId, sequence: 3, eventType: 'RECOVERY_FOUND' })},
            'bayn.paper-mutation-event.v1', ${cancelMutationId}, ${unfinished.intent.intentId}, 3,
            'CANCEL', 'RECOVERY_FOUND', ${cancelRequestHash}, 1000, ${brokerOrderId},
            'cancel-terminalization-recovery', 200, ${canonicalHashV1({ response: 'cancel-recovered' })}, ${recoveryAt}
          )
        `
        const blocked = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, recoveryAt)
        return { blocked, unresolvedBlock }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(result.unresolvedBlock)).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.Risk,
    })
  }, 15_000)

  test('binds and terminalizes a real PAPER risk block without intent or broker mutation state', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const draft = makePlannedDraft('paper-account-risk-blocked', executionPolicy)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA, {
          transformPolicy: (policy) => ({ ...policy, maxOrderNotionalMicros: '1' }),
        })
        if (
          planned.document.targetPlan.status !== TargetPlanStatus.Planned ||
          planned.document.riskBlock === undefined ||
          planned.document.deltaRisk.length === 0
        ) {
          return yield* Effect.die(new Error('PAPER risk-block fixture requires exact blocked cumulative evidence'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* insertQualifiedPaperLineage(planned.document)
        const bound = yield* store.bindDecision(draft.identity.cycleId, planned.document, plannedDecisionAt)
        const bindingReplay = yield* store.bindDecision(draft.identity.cycleId, planned.document, plannedDecisionAt)

        const sql = yield* PgClient.PgClient
        const directCompleted = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Completed},
            state_version = state_version + 1,
            updated_at = ${plannedDecisionAt},
            terminal_at = ${plannedDecisionAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const storeCompleted = yield* Effect.exit(
          store.finish(draft.identity.cycleId, CycleState.Completed, plannedDecisionAt),
        )
        const directWrongReason = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Reconciliation},
            state_version = state_version + 1,
            updated_at = ${plannedDecisionAt},
            terminal_at = ${plannedDecisionAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)

        const blocked = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, plannedDecisionAt)
        const blockReplay = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, plannedDecisionAt)
        const unfinished = yield* store.readOldestUnfinished({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
        })
        const [counts] = yield* sql<{
          authorityGenerations: number
          authorityStates: number
          intents: number
          mutations: number
          orders: number
        }>`
          SELECT
            (
              SELECT count(*)::integer
              FROM authority_generations
              WHERE account_id = ${draft.identity.accountId}
            ) AS "authorityGenerations",
            (SELECT count(*)::integer FROM authority_state) AS "authorityStates",
            (SELECT count(*)::integer FROM intents WHERE account_id = ${draft.identity.accountId}) AS intents,
            (
              SELECT count(*)::integer
              FROM mutation_events AS event
              JOIN intents AS intent USING (intent_id)
              WHERE intent.account_id = ${draft.identity.accountId}
            ) AS mutations,
            (SELECT count(*)::integer FROM orders WHERE account_id = ${draft.identity.accountId}) AS orders
        `
        return {
          bindingReplay,
          blockReplay,
          blocked,
          bound,
          counts,
          directCompleted,
          directWrongReason,
          document: planned.document,
          storeCompleted,
          unfinished,
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(result.document).toMatchObject({
      mode: 'PAPER',
      dispatchable: false,
      targetPlan: { status: TargetPlanStatus.Planned },
      riskBlock: {
        intentId: result.document.orderedIntentIds.at(-1),
        decisionId: result.document.deltaRisk.at(-1)?.evaluation.decision.decisionId,
      },
    })
    expect(result.document.riskBlock?.reasonCodes).toContain(Reason.OrderNotionalExceeded)
    expect(result.document.riskBlock?.reasonCodes).not.toContain(Reason.AuthorityNotGranted)
    expect(result.document.deltaRisk.at(-1)?.evaluation.decision.outcome).toBe(RiskOutcome.Blocked)
    expect(result.bound.changed).toBe(true)
    expect(result.bindingReplay.changed).toBe(false)
    expect(result.bindingReplay.cycle).toEqual(result.bound.cycle)
    expect(Exit.isFailure(result.directCompleted)).toBe(true)
    expect(Exit.isFailure(result.storeCompleted)).toBe(true)
    expect(Exit.isFailure(result.directWrongReason)).toBe(true)
    expect(result.blocked.changed).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.Risk,
      terminalAt: plannedDecisionAt,
    })
    expect(result.blockReplay.changed).toBe(false)
    expect(result.blockReplay.cycle).toEqual(result.blocked.cycle)
    expect(Option.isNone(result.unfinished)).toBe(true)
    expect(result.counts).toEqual({
      authorityGenerations: 2,
      authorityStates: 0,
      intents: 0,
      mutations: 0,
      orders: 0,
    })
  })

  test('rejects the account-neutral authority reason as a durable risk terminalization', async () => {
    const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
    const draft = makePlannedDraft('account-neutral-authority-risk-blocked', executionPolicy)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(draft, acquireAt)
        yield* store.bindSnapshot(draft.identity.cycleId, makeInputManifest(snapshotA), snapshotAt)
        const activated = yield* store.activate(draft.identity.cycleId, activeAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotA, {
          transformPolicy: (policy) => ({ ...policy, maxOrderNotionalMicros: '1' }),
        })
        const blockedIndex = planned.document.deltaRisk.length - 1
        const blockedRisk = planned.document.deltaRisk[blockedIndex]
        if (blockedRisk === undefined || planned.document.riskBlock === undefined) {
          return yield* Effect.die(new Error('authority terminalization fixture requires blocked risk evidence'))
        }

        const gates = blockedRisk.evaluation.gates.map((gate) => ({
          ...gate,
          passed: gate.name !== Gate.Authority,
        }))
        const { decisionId: _decisionId, ...decisionMaterial } = blockedRisk.evaluation.decision
        const authorityDecisionMaterial = {
          ...decisionMaterial,
          reasonCodes: [Reason.AuthorityNotGranted],
        }
        const authorityDecision = {
          ...authorityDecisionMaterial,
          decisionId: canonicalHashV1(authorityDecisionMaterial),
        }
        const deltaRisk = planned.document.deltaRisk.map((risk, index) =>
          index === blockedIndex
            ? { ...risk, evaluation: { ...risk.evaluation, decision: authorityDecision, gates } }
            : risk,
        )
        const { contentHash: _contentHash, ...documentMaterial } = planned.document
        const authorityDocumentMaterial = {
          ...documentMaterial,
          deltaRisk,
          riskBlock: {
            intentId: authorityDecision.intentId,
            decisionId: authorityDecision.decisionId,
            reasonCodes: authorityDecision.reasonCodes,
          },
        }
        const authorityDocument = {
          ...authorityDocumentMaterial,
          contentHash: canonicalHashV1(authorityDocumentMaterial),
        }

        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO autonomous_cycle_shadow_decisions (
                cycle_id, schema_version, document, created_at
              ) VALUES (
                ${draft.identity.cycleId}, ${authorityDocument.schemaVersion},
                ${sql.json(authorityDocument)}, ${authorityDocument.createdAt}
              )
            `
            yield* sql`
              UPDATE autonomous_cycles
              SET
                decision_hash = ${authorityDocument.contentHash},
                state_version = state_version + 1,
                updated_at = ${plannedDecisionAt}
              WHERE cycle_id = ${draft.identity.cycleId}
            `
          }),
        )
        const terminalization = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Risk},
            state_version = state_version + 1,
            updated_at = ${plannedDecisionAt},
            terminal_at = ${plannedDecisionAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const [persisted] = yield* sql<{ state: string; terminal_reason: string | null }>`
          SELECT state, terminal_reason
          FROM autonomous_cycles
          WHERE cycle_id = ${draft.identity.cycleId}
        `
        return { persisted, terminalization }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(result.terminalization)).toBeTrue()
    expect(result.persisted).toEqual({ state: CycleState.Active, terminal_reason: null })
  })

  test('terminalizes a known denied PAPER intent and releases oldest-unfinished selection immediately', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const [clock] = yield* sql<{ evaluated_at: string }>`
          SELECT to_char(
            (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS evaluated_at
        `
        if (clock === undefined) return yield* Effect.die(new Error('database Clock returned no row'))
        const {
          evaluationAt: evaluatedAt,
          executionOpenAt,
          executionSessionDate,
          signalSessionDate,
          snapshotBoundAt,
        } = monthEndExecutionWindow(clock.evaluated_at)
        const executionCloseAt = `${executionSessionDate}T23:59:59.999Z`
        const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
        const draft = makeDraft('paper-account-terminal-denied', {
          executionPolicy,
          executionCloseAt,
          executionOpenAt,
          executionSessionDate,
          signalSessionDate,
        })
        const acquisitionAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) + 60_000)
        const activatedAt = utcInstantFromEpochMillis(Date.parse(snapshotBoundAt) + 1_000)
        const manifest = makeInputManifest(snapshotB, {
          asOfSession: signalSessionDate,
          finalizedAt: snapshotBoundAt,
          lastSession: signalSessionDate,
        })

        const store = yield* CycleStore
        yield* store.acquire(draft, acquisitionAt)
        yield* store.bindSnapshot(draft.identity.cycleId, manifest, snapshotBoundAt)
        const activated = yield* store.activate(draft.identity.cycleId, activatedAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotB, {
          evaluatedAt,
          snapshotFinalizedAt: snapshotBoundAt,
        })
        if (
          planned.document.targetPlan.status !== TargetPlanStatus.Planned ||
          planned.document.deltaRisk.length === 0
        ) {
          return yield* Effect.die(new Error('terminal PAPER failure fixture requires a planned mutation'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* store.bindDecision(draft.identity.cycleId, planned.document, evaluatedAt)
        const denied = yield* insertQualifiedPaperLineage(planned.document, { deniedIntent: true })
        const prematureAt = utcInstantFromEpochMillis(Date.parse(denied.deniedAt) - 1)

        const directPremature = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Risk},
            state_version = state_version + 1,
            updated_at = ${prematureAt},
            terminal_at = ${prematureAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const directWrongReason = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Blocked},
            terminal_reason = ${CycleTerminalReason.Reconciliation},
            state_version = state_version + 1,
            updated_at = ${denied.deniedAt},
            terminal_at = ${denied.deniedAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)

        const blocked = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, denied.deniedAt)
        const replayed = yield* store.block(draft.identity.cycleId, CycleTerminalReason.Risk, denied.deniedAt)
        const unfinished = yield* store.readOldestUnfinished({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
        })
        const [counts] = yield* sql<{
          authorityGenerations: number
          authorityStates: number
          intents: number
          mutations: number
          orders: number
        }>`
          SELECT
            (
              SELECT count(*)::integer
              FROM authority_generations
              WHERE account_id = ${draft.identity.accountId}
            ) AS "authorityGenerations",
            (SELECT count(*)::integer FROM authority_state) AS "authorityStates",
            (SELECT count(*)::integer FROM intents WHERE account_id = ${draft.identity.accountId}) AS intents,
            (
              SELECT count(*)::integer
              FROM mutation_events AS event
              JOIN intents AS intent USING (intent_id)
              WHERE intent.account_id = ${draft.identity.accountId}
            ) AS mutations,
            (SELECT count(*)::integer FROM orders WHERE account_id = ${draft.identity.accountId}) AS orders
        `
        return {
          blocked,
          counts,
          denied,
          directPremature,
          directWrongReason,
          replayed,
          unfinished,
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(result.directPremature)).toBe(true)
    expect(Exit.isFailure(result.directWrongReason)).toBe(true)
    expect(result.denied.intent.state).toBe(IntentState.Planned)
    expect(result.blocked.changed).toBe(true)
    expect(result.blocked.cycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.Risk,
      terminalAt: result.denied.deniedAt,
    })
    expect(result.replayed.changed).toBe(false)
    expect(result.replayed.cycle).toEqual(result.blocked.cycle)
    expect(Option.isNone(result.unfinished)).toBe(true)
    expect(result.counts).toEqual({
      authorityGenerations: 2,
      authorityStates: 0,
      intents: 1,
      mutations: 2,
      orders: 0,
    })
  })

  test('requires terminal-filled PAPER intents and later exact reconciliation before completion', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const [clock] = yield* sql<{ evaluated_at: string }>`
          SELECT to_char(
            (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS evaluated_at
        `
        if (clock === undefined) return yield* Effect.die(new Error('database Clock returned no row'))
        const {
          evaluationAt: evaluatedAt,
          executionOpenAt,
          executionSessionDate,
          signalSessionDate,
          snapshotBoundAt,
        } = monthEndExecutionWindow(clock.evaluated_at)
        const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
        const draft = makeDraft('paper-account-completion-proof', {
          executionPolicy,
          executionCloseAt: `${executionSessionDate}T23:59:59.999Z`,
          executionOpenAt,
          executionSessionDate,
          signalSessionDate,
        })
        const acquisitionAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) + 60_000)
        const activatedAt = utcInstantFromEpochMillis(Date.parse(snapshotBoundAt) + 1_000)
        const manifest = makeInputManifest(snapshotB, {
          asOfSession: signalSessionDate,
          finalizedAt: snapshotBoundAt,
          lastSession: signalSessionDate,
        })

        const store = yield* CycleStore
        yield* store.acquire(draft, acquisitionAt)
        yield* store.bindSnapshot(draft.identity.cycleId, manifest, snapshotBoundAt)
        const activated = yield* store.activate(draft.identity.cycleId, activatedAt)
        const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotB, {
          evaluatedAt,
          snapshotFinalizedAt: snapshotBoundAt,
        })
        if (
          planned.document.targetPlan.status !== TargetPlanStatus.Planned ||
          planned.document.riskBlock !== undefined
        ) {
          return yield* Effect.die(new Error('PAPER completion fixture requires a dispatchable planned decision'))
        }
        yield* insertReconciliation(planned.reconciliation)
        yield* insertQualifiedPaperLineage(planned.document)
        yield* store.bindDecision(draft.identity.cycleId, planned.document, evaluatedAt)

        const directPremature = yield* Effect.exit(sql`
          UPDATE autonomous_cycles
          SET
            state = ${CycleState.Completed},
            state_version = state_version + 1,
            updated_at = ${evaluatedAt},
            terminal_at = ${evaluatedAt}
          WHERE cycle_id = ${draft.identity.cycleId}
        `)
        const storePremature = yield* Effect.exit(
          store.finish(draft.identity.cycleId, CycleState.Completed, evaluatedAt),
        )

        const filled = yield* insertFilledPlannedPaperIntent(planned.document, 'started')
        const unresolvedReconciledAt = utcInstantFromEpochMillis(Date.parse(filled.filledAt) + 1)
        yield* insertReconciliation(plannedPaperReconciliation(activated.cycle, unresolvedReconciledAt))
        const unresolvedStarted = yield* Effect.exit(
          store.finish(draft.identity.cycleId, CycleState.Completed, unresolvedReconciledAt),
        )
        const settledAt = utcInstantFromEpochMillis(Date.parse(unresolvedReconciledAt) + 1)
        yield* settleStartedPaperSubmit(filled, settledAt)
        const reconciledAt = utcInstantFromEpochMillis(Date.parse(settledAt) + 1)
        yield* insertReconciliation(plannedPaperReconciliation(activated.cycle, reconciledAt))
        const completed = yield* store.finish(draft.identity.cycleId, CycleState.Completed, reconciledAt)
        const replayed = yield* store.finish(draft.identity.cycleId, CycleState.Completed, reconciledAt)
        const unfinished = yield* store.readOldestUnfinished({
          qualificationRunId: draft.identity.qualificationRunId,
          accountId: draft.identity.accountId,
        })
        const [counts] = yield* sql<{
          authorityGenerations: number
          authorityStates: number
          intents: number
          mutations: number
          orders: number
        }>`
          SELECT
            (
              SELECT count(*)::integer
              FROM authority_generations
              WHERE account_id = ${draft.identity.accountId}
            ) AS "authorityGenerations",
            (SELECT count(*)::integer FROM authority_state) AS "authorityStates",
            (SELECT count(*)::integer FROM intents WHERE account_id = ${draft.identity.accountId}) AS intents,
            (
              SELECT count(*)::integer
              FROM mutation_events AS event
              JOIN intents AS intent USING (intent_id)
              WHERE intent.account_id = ${draft.identity.accountId}
            ) AS mutations,
            (SELECT count(*)::integer FROM orders WHERE account_id = ${draft.identity.accountId}) AS orders
        `
        return {
          completed,
          counts,
          directPremature,
          filled,
          reconciledAt,
          replayed,
          storePremature,
          unfinished,
          unresolvedStarted,
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(Exit.isFailure(result.directPremature)).toBe(true)
    expect(Exit.isFailure(result.storePremature)).toBe(true)
    expect(Exit.isFailure(result.unresolvedStarted)).toBe(true)
    expect(result.completed.changed).toBe(true)
    expect(result.completed.cycle).toMatchObject({
      state: CycleState.Completed,
      terminalAt: result.reconciledAt,
    })
    expect(result.replayed.changed).toBe(false)
    expect(result.replayed.cycle).toEqual(result.completed.cycle)
    expect(Option.isNone(result.unfinished)).toBe(true)
    expect(result.filled.intent.state).toBe(IntentState.Planned)
    expect(result.counts).toEqual({
      authorityGenerations: 2,
      authorityStates: 0,
      intents: 1,
      mutations: 2,
      orders: 0,
    })
  })

  test.each(['accepted', 'recovered'] as const)(
    'completes a terminal zero-fill LIMIT/IOC through a %s submit path only after exact order and reconciliation evidence',
    async (submitPath) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [clock] = yield* sql<{ evaluated_at: string }>`
          SELECT to_char(
            (clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS evaluated_at
        `
          if (clock === undefined) return yield* Effect.die(new Error('database Clock returned no row'))
          const {
            evaluationAt: evaluatedAt,
            executionOpenAt,
            executionSessionDate,
            signalSessionDate,
            snapshotBoundAt,
          } = monthEndExecutionWindow(clock.evaluated_at)
          const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel))
          const draft = makeDraft(`paper-account-zero-fill-ioc-completion-${submitPath}`, {
            executionPolicy,
            executionCloseAt: `${executionSessionDate}T23:59:59.999Z`,
            executionOpenAt,
            executionSessionDate,
            signalSessionDate,
          })
          const acquisitionAt = utcInstantFromEpochMillis(Date.parse(draft.window.signalCloseAt) + 60_000)
          const activatedAt = utcInstantFromEpochMillis(Date.parse(snapshotBoundAt) + 1_000)
          const manifest = makeInputManifest(snapshotB, {
            asOfSession: signalSessionDate,
            finalizedAt: snapshotBoundAt,
            lastSession: signalSessionDate,
          })

          const store = yield* CycleStore
          yield* store.acquire(draft, acquisitionAt)
          yield* store.bindSnapshot(draft.identity.cycleId, manifest, snapshotBoundAt)
          const activated = yield* store.activate(draft.identity.cycleId, activatedAt)
          const planned = yield* buildPlannedExecutionDecision(activated.cycle, snapshotB, {
            evaluatedAt,
            snapshotFinalizedAt: snapshotBoundAt,
          })
          if (
            planned.document.targetPlan.status !== TargetPlanStatus.Planned ||
            planned.document.riskBlock !== undefined
          ) {
            return yield* Effect.die(new Error('zero-fill IOC fixture requires a dispatchable planned decision'))
          }
          yield* insertReconciliation(planned.reconciliation)
          yield* insertQualifiedPaperLineage(planned.document)
          yield* store.bindDecision(draft.identity.cycleId, planned.document, evaluatedAt)

          const zeroFill = yield* insertBenignZeroFillIocPlannedIntent(planned.document, submitPath)
          const missingOrderReconciledAt = utcInstantFromEpochMillis(Date.parse(zeroFill.canceledAt) + 1)
          yield* insertReconciliation(plannedPaperReconciliation(activated.cycle, missingOrderReconciledAt))
          const withoutOrder = yield* Effect.exit(
            store.finish(draft.identity.cycleId, CycleState.Completed, missingOrderReconciledAt),
          )

          const orderObservedAt = utcInstantFromEpochMillis(Date.parse(missingOrderReconciledAt) + 1)
          const order = yield* insertBenignZeroFillIocOrder(zeroFill, orderObservedAt)
          const withoutPostOrderReconciliation = yield* Effect.exit(
            store.finish(draft.identity.cycleId, CycleState.Completed, orderObservedAt),
          )

          const reconciledAt = utcInstantFromEpochMillis(Date.parse(orderObservedAt) + 1)
          yield* insertReconciliation(plannedPaperReconciliation(activated.cycle, reconciledAt, [order]))
          const completed = yield* store.finish(draft.identity.cycleId, CycleState.Completed, reconciledAt)
          const replayed = yield* store.finish(draft.identity.cycleId, CycleState.Completed, reconciledAt)
          const unfinished = yield* store.readOldestUnfinished({
            qualificationRunId: draft.identity.qualificationRunId,
            accountId: draft.identity.accountId,
          })
          return { completed, reconciledAt, replayed, unfinished, withoutOrder, withoutPostOrderReconciliation }
        }).pipe(Effect.provide(TestClock.layer())),
      )

      expect(Exit.isFailure(result.withoutOrder)).toBe(true)
      expect(Exit.isFailure(result.withoutPostOrderReconciliation)).toBe(true)
      expect(result.completed).toMatchObject({
        changed: true,
        cycle: { state: CycleState.Completed, terminalAt: result.reconciledAt },
      })
      expect(result.replayed).toEqual({ changed: false, cycle: result.completed.cycle })
      expect(Option.isNone(result.unfinished)).toBe(true)
    },
  )

  test('finishes the exact no-trade decision once after cutoff and preserves terminal history across runtimes', async () => {
    const draft = makeDraft()
    const shadowDecision = makeShadowDecision(draft, snapshotA)
    const afterCutoff = utcInstantFromEpochMillis(Date.parse(draft.window.submissionCutoffAt) + 1)
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
          SET updated_at = ${utcInstantFromEpochMillis(Date.parse(afterCutoff) + 1)}, state_version = state_version + 1
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
          utcInstantFromEpochMillis(Date.parse(afterCutoffDraft.window.submissionCutoffAt) + 1),
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

  test('persists and replays one production OBSERVE due cycle across PostgreSQL process restart', async () => {
    const io = makeDueIoControl()
    const firstRuntime = makeAutonomousRuntime()
    let restartedRuntime: ReturnType<typeof makeAutonomousRuntime> | undefined

    try {
      await firstRuntime.runPromise(installShadowEvidenceFailure)
      const shadowFailure = await firstRuntime.runPromiseExit(productionDuePass(io, 'ACQUIRE_AND_DUE'))
      expect(Exit.isFailure(shadowFailure)).toBe(true)
      if (Exit.isFailure(shadowFailure)) {
        expect(Cause.pretty(shadowFailure.cause)).toContain('pr13354 injected shadow evidence failure')
      }
      const afterShadowFailure = await firstRuntime.runPromise(readDueDurabilityRows)
      expect(afterShadowFailure.counts).toMatchObject({
        cycles: 1,
        snapshots: 1,
        distinctSnapshots: 1,
        shadowDecisions: 0,
        distinctShadowDecisions: 0,
        reconciliations: 1,
        distinctReconciliations: 1,
        unfinishedCycles: 1,
        intents: 0,
        riskDecisions: 0,
        mutationEvents: 0,
        brokerOrders: 0,
        brokerOrderEvents: 0,
        brokerEvents: 1,
        distinctBrokerEvents: 1,
      })
      expect(afterShadowFailure.cycle).toMatchObject({
        state: CycleState.Active,
        snapshot_id: dueSnapshotId,
        decision_hash: null,
        terminal_at: null,
      })

      await firstRuntime.runPromise(removeShadowEvidenceFailure)
      await firstRuntime.runPromise(installTerminalTransitionFailure)
      const terminalFailure = await firstRuntime.runPromiseExit(productionDuePass(io))
      expect(Exit.isFailure(terminalFailure)).toBe(true)
      if (Exit.isFailure(terminalFailure)) {
        expect(Cause.pretty(terminalFailure.cause)).toContain('pr13354 injected terminal transition failure')
      }
      const afterTerminalFailure = await firstRuntime.runPromise(readDueDurabilityRows)
      expect(afterTerminalFailure.counts).toMatchObject({
        cycles: 1,
        snapshots: 1,
        distinctSnapshots: 1,
        shadowDecisions: 1,
        distinctShadowDecisions: 1,
        reconciliations: 1,
        distinctReconciliations: 1,
        unfinishedCycles: 1,
        intents: 0,
        riskDecisions: 0,
        mutationEvents: 0,
        brokerOrders: 0,
        brokerOrderEvents: 0,
        brokerEvents: 1,
        distinctBrokerEvents: 1,
      })
      expect(afterTerminalFailure.cycle).toMatchObject({
        state: CycleState.Active,
        snapshot_id: dueSnapshotId,
        decision_hash: afterTerminalFailure.shadow?.decision_hash,
        terminal_at: null,
      })

      await firstRuntime.runPromise(removeTerminalTransitionFailure)
      const settled = await runProductionDuePass(firstRuntime, io)
      expect(settled.outcome).toBe('RECOVERED')
      if (settled.outcome !== 'RECOVERED') return expect.unreachable(settled.outcome)
      expect([CycleState.NoTrade, CycleState.Completed]).toContain(settled.cycle.state)
      expect(settled.action).toBe(
        settled.cycle.state === CycleState.NoTrade ? CycleState.NoTrade : CycleState.Completed,
      )

      const terminalRows = await firstRuntime.runPromise(readDueDurabilityRows)
      expect(terminalRows.counts).toEqual({
        cycles: 1,
        unfinishedCycles: 0,
        snapshots: 1,
        distinctSnapshots: 1,
        shadowDecisions: 1,
        distinctShadowDecisions: 1,
        reconciliations: 1,
        distinctReconciliations: 1,
        intents: 0,
        riskDecisions: 0,
        mutationEvents: 0,
        brokerOrders: 0,
        brokerOrderEvents: 0,
        brokerEvents: 1,
        distinctBrokerEvents: 1,
      })
      expect(terminalRows.cycle).toMatchObject({
        cycle_id: settled.cycle.identity.cycleId,
        state: settled.cycle.state,
        snapshot_id: dueSnapshotId,
        decision_hash: terminalRows.shadow?.decision_hash,
      })
      expect(terminalRows.cycle?.terminal_at).not.toBeNull()
      expect(terminalRows.snapshot).toEqual({
        snapshot_id: dueSnapshotId,
        manifest: dueManifest.finalizedSnapshot,
      })
      expect(terminalRows.reconciliation).toMatchObject({ status: ReconciliationStatus.Exact })
      expect(terminalRows.shadow?.cycle_id).toBe(settled.cycle.identity.cycleId)
      const shadowDocument = terminalRows.shadow?.document as
        | {
            readonly bindings: {
              readonly accountId: string
              readonly cycleId: string
              readonly reconciliationHash: string
              readonly reconciliationId: string
              readonly snapshotId: string
            }
            readonly contentHash: string
            readonly dispatchable: boolean
            readonly mode: string
            readonly targetPlan: { readonly status: string }
          }
        | undefined
      expect(shadowDocument).toMatchObject({
        mode: 'OBSERVE',
        dispatchable: false,
        contentHash: terminalRows.shadow?.decision_hash,
        bindings: {
          accountId: dueAccountId,
          cycleId: settled.cycle.identity.cycleId,
          snapshotId: dueSnapshotId,
          reconciliationId: terminalRows.reconciliation?.reconciliation_id,
          reconciliationHash: terminalRows.reconciliation?.content_hash,
        },
      })
      expect(shadowDocument?.targetPlan.status).toBe(
        settled.cycle.state === CycleState.NoTrade ? TargetPlanStatus.NoTrade : TargetPlanStatus.Planned,
      )

      const ioBeforeRestart = { ...io }
      await firstRuntime.dispose()

      const processRestart = await restartGithubPostgres18Process()
      if (isGithubActions) {
        expect(processRestart).toMatchObject({
          containerId: expect.any(String),
          image: expect.stringMatching(/^postgres:18(?:-|$)/),
          startedAtBefore: expect.any(String),
          startedAtAfter: expect.any(String),
        })
        expect(processRestart?.startedAtAfter).not.toBe(processRestart?.startedAtBefore)
      }

      restartedRuntime = makeAutonomousRuntime()
      const restarted = await runProductionDuePass(restartedRuntime, io)
      expect(restarted).toMatchObject({
        outcome: 'ALREADY_TERMINAL',
        cycle: {
          identity: { cycleId: settled.cycle.identity.cycleId },
          state: settled.cycle.state,
          bindings: {
            snapshotId: dueSnapshotId,
            decisionHash: terminalRows.shadow?.decision_hash,
          },
        },
      })
      expect(io).toEqual({
        ...ioBeforeRestart,
        discoveryReads: ioBeforeRestart.discoveryReads + 1,
      })

      const restartedRows = await restartedRuntime.runPromise(readDueDurabilityRows)
      expect(restartedRows).toEqual(terminalRows)
    } finally {
      await firstRuntime.dispose()
      if (restartedRuntime !== undefined) await restartedRuntime.dispose()
    }
  }, 60_000)
})
