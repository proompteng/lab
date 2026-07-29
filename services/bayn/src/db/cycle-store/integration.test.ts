import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime, Option, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import {
  AccountStatus as BrokerAccountStatus,
  BrokerRead,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type ReadEvidence,
} from '../../broker/alpaca'
import { unusedAssetBySymbol } from '../../broker/alpaca-test-support'
import type { RuntimeConfig } from '../../config'
import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type CycleDraft,
} from '../../cycle'
import {
  CycleDecisionBuildError,
  makeDueCycleDraft,
  runAutonomousCyclePass,
  selectNextExecutionSession,
  type CycleRunContext,
  type CycleRunResult,
} from '../../cycle-runner'
import { runAutonomousCycleUntilSettled } from '../../cycle-runner/program'
import { AuthorityGenerationStore, ExecutionStoreLive } from '../execution-store'
import { WriterFenceLive } from '../../execution/writer-fence'
import { canonicalHashV1, sha256 } from '../../hash'
import { Journal, type JournalService } from '../../ledger'
import {
  MarketData,
  type FinalizedPublicationInspection,
  type MarketDataService,
  type SignalSessionRow,
} from '../../market-data'
import {
  buildObserveCycleDecision,
  loadObserveRiskPolicy,
  prepareObserveStartup,
  type ObserveDecisionFailure,
} from '../../observe-composition'
import { Authority, ReconciliationStatus } from '../../execution/contracts'
import { runOnce } from '../../reconciler'
import { makeObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import { makeStrategy } from '../../strategy'
import { TargetPlanReason, TargetPlanStatus } from '../../target-planner'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from '../../test-fixtures'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type InputManifest,
  type IsoDate,
  type Protocol,
} from '../../types'
import { PostgresClientLive } from '../evidence-store'
import { migrationLoader } from '../migrations'
import { CycleStore, CycleStoreLive, type CycleStoreShape } from '.'

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
  if (process.env.GITHUB_ACTIONS !== 'true') return undefined

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

const dueAccountId = '13354000-0000-4000-8000-000000000054'
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
const dueStrategy = makeStrategy(dueProtocol, makeTestProvenance(dueProtocol))

const autonomousRuntimeConfig: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  maximumAuthority: Authority.Observe,
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
    Layer.mergeAll(CycleStoreLive, ExecutionStoreLive(autonomousRuntimeConfig)).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(Layer.succeed(Journal, autonomousJournal)),
      Layer.provideMerge(PostgresClientLive(autonomousRuntimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const weekdaySessions = (start: IsoDate, count: number): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  const cursor = new Date(`${start}T00:00:00.000Z`)
  while (sessions.length < count) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) sessions.push(cursor.toISOString().slice(0, 10) as IsoDate)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
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
      maximumAuthority: Authority.Observe,
      pollIntervalMs: 30_000,
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
    | import('../execution-store').BrokerEventStore
    | import('../execution-store').FillAccountingStore
    | import('../execution-store').ValuationStore
    | import('../execution-store').ReconciliationStore
    | import('../execution-store').AuthorityRestrictionStore
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
    readonly executionCloseAt?: string
    readonly executionOpenAt?: string
    readonly executionSessionDate?: IsoDate
    readonly signalSessionDate?: IsoDate
    readonly submissionWindowMs?: number
  } = {},
): CycleDraft => {
  const signalSessionDate = options.signalSessionDate ?? '2026-03-06'
  const executionSessionDate = options.executionSessionDate ?? '2026-03-09'
  const executionPolicyResult = makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: 'c'.repeat(64),
    submissionWindowMs: options.submissionWindowMs ?? 30 * 60 * 1_000,
    submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
  })
  expect(Result.isSuccess(executionPolicyResult)).toBe(true)
  if (Result.isFailure(executionPolicyResult)) return expect.unreachable(executionPolicyResult.failure.message)
  const executionPolicy = executionPolicyResult.success

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
  expect(Result.isSuccess(identityResult)).toBe(true)
  if (Result.isFailure(identityResult)) return expect.unreachable(identityResult.failure.message)
  const windowResult = makeCycleWindow(signalSession(signalSessionDate), executionCalendar, executionPolicy)
  expect(Result.isSuccess(windowResult)).toBe(true)
  if (Result.isFailure(windowResult)) return expect.unreachable(windowResult.failure.message)
  const draftResult = makeCycleDraft(identityResult.success, windowResult.success)
  expect(Result.isSuccess(draftResult)).toBe(true)
  if (Result.isFailure(draftResult)) return expect.unreachable(draftResult.failure.message)
  return draftResult.success
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
const decisionAt = '2026-03-09T13:00:00.000Z'
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
      if (process.env.GITHUB_ACTIONS === 'true') {
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
        signalSessionDate: dueSignalDate,
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
