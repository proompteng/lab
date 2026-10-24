import { orderRequestBody } from '../../broker/alpaca-mutations/decisions'
import { makeAuthorityPostgres } from '../../db/execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from '../../db/execution-store/observe-authority'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'
import type { Statement } from 'effect/sql/Statement'

import { recoverPreopenAuthorityCycle } from '../../../migrations/0057_recover_preopen_authority_cycle'
import { recoverIntradayAuthorityCycle } from '../../../migrations/0071_recover_intraday_authority_cycle'
import { recoverExpiredNativeEntryAdmission } from '../../../migrations/0101_reclassify_expired_native_entry'
import shadowDecisionGenerationIndex from '../../../migrations/0104_shadow_decision_generation_index'
import { canRearmUnusedCycle } from '../../cycle/runner/calendar-decisions'
import { continuousExecutionPolicy, continuousMarketHours, tradingWindow } from '../../market-hours'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../../broker/identity'
import { CycleState, CycleTerminalReason } from '../../cycle/model'
import {
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from '../../cycle/construction'
import { CycleStore } from '../../cycle/store/model'
import { CycleStoreLive } from '../../cycle/store/postgres'
import { Authority, KillState, OrderSide, OrderType, TimeInForce } from '../../execution/contracts'
import {
  strategyProtocolCutoverRestrictionReason,
  executionActivationExpiredRestrictionReason,
  executionMandateCompletedRestrictionReason,
  legacyExecutionActivationExpiredRestrictionReason,
  legacyV1CompletedRestrictionReason,
} from '../../execution/mandate'
import { PostgresClientLive } from '../../db/postgres-client'
import { postgresMigrations } from '../../db/postgres-migrations'
import { canonicalHashV1Result } from '../../hash'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import { restrictAuthority } from '../../db/reconciliation'
import { MutationOperation } from '../../broker/alpaca-mutations/model'
import { makeMutationEventPostgres } from '../mutations/postgres/events'
import { makeMutationStartPostgres } from '../mutations/postgres/start'
import { makeMutationOutcomePostgres } from '../mutations/postgres/outcome'
import { SubmissionDenialReason } from '../submission-denial'
import { WriterFence, WriterFenceLive } from '../writer-fence'
import { recoverTerminalGenerationToObserve } from '../../blocked-generation-recovery'
import { operationalError } from '../../errors'
import { intradayMomentumExecutionModel } from '../../strategy/intraday-momentum/protocol'
import { defaultJevProtocolDocument } from '../../jev/protocol'
import { BlockedCycleIntentStore } from './blocked-cycle'
import { BlockedCycleIntentStoreLive } from './blocked-cycle-postgres'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const accountId = 'preopen-authority-recovery-test'
const planHash = '1'.repeat(64)
const brokerIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const instant = (epochMillis: number): string => new Date(epochMillis).toISOString()

const makeFixture = (openSession = false) => {
  const now = Date.now()
  const session = new Date(now + (openSession ? 0 : 24 * 60 * 60_000))
  const executionSessionDate = session.toISOString().slice(0, 10)
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
      source: 'alpaca-v2-calendar',
      date: executionSessionDate,
      openAt: `${executionSessionDate}T${openSession ? '00:00:00.000' : '13:30:00.000'}Z`,
      closeAt: `${executionSessionDate}T${openSession ? '23:59:59.999' : '20:00:00.000'}Z`,
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const sessionPolicy = openSession
    ? value(
        makeCycleExecutionPolicy({
          schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
          strategyExecutionModelHash: executionPolicy.strategyExecutionModelHash,
          warmupAfterOpenMs: 0,
          submissionCutoffBeforeCloseMs: 0,
        }),
      )
    : executionPolicy
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v4',
      entryAttemptOrdinal: 1,
      strategyName: 'jev',
      qualificationRunId: planHash,
      strategyProtocolHash: Result.getOrThrow(canonicalHashV1Result({ strategy: 'jev', version: 2 })),
      accountId,
      executionSessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy: sessionPolicy,
    }),
  )
  const cycle = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, sessionPolicy))))
  return {
    cycle,
    generationActivatedAt: instant(now - 5 * 60_000),
    acquiredAt: instant(now - 3 * 60_000 - 5_000),
    cycleActivatedAt: instant(now - 3 * 60_000),
    restrictedAt: instant(now - 2 * 60_000),
    reconciledAt: instant(now - 60_000),
    positionsObservedAt: instant(now - 90_000),
  }
}

const makeExpiredNativeFixture = () => {
  const original = makeFixture(true)
  const date = instant(Date.now() - 24 * 60 * 60_000).slice(0, 10)
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
      source: 'alpaca-v2-calendar',
      date,
      openAt: `${date}T00:00:00.000Z`,
      closeAt: `${date}T23:59:59.999Z`,
    }),
  )
  const policy = original.cycle.identity.executionPolicy
  if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('Expected native policy')
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v4',
      entryAttemptOrdinal: 1,
      strategyName: original.cycle.identity.strategyName,
      qualificationRunId: planHash,
      strategyProtocolHash: original.cycle.identity.strategyProtocolHash,
      accountId,
      executionSessionDate: date,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy: policy,
    }),
  )
  const cycle = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, policy))))
  return {
    ...original,
    cycle,
    generationActivatedAt: `${date}T00:59:00.000Z`,
    acquiredAt: `${date}T01:00:00.000Z`,
    cycleActivatedAt: `${date}T01:00:01.000Z`,
    restrictedAt: cycle.window.submissionCutoffAt,
  }
}

const seedExecutionAuthority = (sql: PgClient.PgClient, fixture: ReturnType<typeof makeFixture>) => {
  const observeGenerationHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'observe' }))
  const executionGenerationHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' }))
  const reconciliationId = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'activation' }))
  const reconciliationHash = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'activation-content' }))
  const stateHash = Result.getOrThrow(canonicalHashV1Result({ state: 'flat' }))
  const observeActivatedAt = instant(Date.parse(fixture.generationActivatedAt) - 2_000)
  const activationReconciledAt = instant(Date.parse(fixture.generationActivatedAt) - 1_000)
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO reconciliations (
        reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
        content_hash, status, discrepancies, reconciled_at
      ) VALUES (
        ${reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId}, ${stateHash}, ${stateHash},
        ${reconciliationHash}, 'EXACT', ${sql.json([])}, ${activationReconciledAt}
      )
    `
    yield* sql`
      INSERT INTO authority_generations (
        generation_hash, schema_version, previous_generation_hash, maximum,
        authority_version, activated_at
      ) VALUES (
        ${observeGenerationHash}, 'bayn.authority-generation-history.v1', NULL,
        'OBSERVE', 1, ${observeActivatedAt}
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
        ${executionGenerationHash}, 'bayn.authority-generation-history.v1',
        'bayn.paper-authority-generation.v3', ${observeGenerationHash}, 'PAPER', 2,
        ${'2'.repeat(40)}, 'registry.example.test/lab/bayn', ${`sha256:${'3'.repeat(64)}`},
        'jev', ${'4'.repeat(64)}, ${'5'.repeat(64)},
        ${defaultJevProtocolDocument.schemaVersion}, ${fixture.cycle.identity.strategyProtocolHash}, ${accountId},
        'bayn.broker-identity.v2', ${brokerIdentity.identityHash}, 'alpaca', 'sandbox', ${'7'.repeat(64)},
        ${planHash}, ${reconciliationId}, ${reconciliationHash}, ${planHash},
        ${fixture.generationActivatedAt}
      )
    `
    yield* sql`
      INSERT INTO authority_state (
        schema_version, generation_hash, maximum, effective, kill_state, reason, version, updated_at
      ) VALUES (
        'bayn.paper-authority.v1', ${observeGenerationHash}, 'OBSERVE', 'OBSERVE',
        'CLEAR', NULL, 1, ${observeActivatedAt}
      )
    `
    yield* sql`
      UPDATE authority_state
      SET
        generation_hash = ${executionGenerationHash},
        maximum = 'PAPER',
        effective = 'PAPER',
        version = 2,
        updated_at = ${fixture.generationActivatedAt}
      WHERE singleton
    `
  })
}

const seedRepairableCycle = (
  sql: PgClient.PgClient,
  cycles: CycleStore['Service'],
  fixture: ReturnType<typeof makeFixture>,
) =>
  Effect.gen(function* () {
    yield* seedExecutionAuthority(sql, fixture)
    yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
    yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
    yield* cycles.block(fixture.cycle.identity.cycleId, CycleTerminalReason.Authority, fixture.restrictedAt)
    yield* sql`
      INSERT INTO position_snapshots (
        snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
      ) VALUES (
        ${Result.getOrThrow(canonicalHashV1Result({ positions: 'flat' }))}, 'bayn.paper-position-snapshot.v1', ${accountId},
        ${Result.getOrThrow(canonicalHashV1Result({ positions: 'source' }))}, ${fixture.positionsObservedAt}, 0,
        ${Result.getOrThrow(canonicalHashV1Result({ positions: 'content' }))}
      )
    `
    const exactHash = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'current-flat' }))
    yield* sql`
      INSERT INTO reconciliations (
        reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
        content_hash, status, discrepancies, reconciled_at
      ) VALUES (
        ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'current' }))}, 'bayn.paper-reconciliation.v1',
        ${accountId}, ${exactHash}, ${exactHash}, ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'current-content' }))},
        'EXACT', ${sql.json([])}, ${fixture.reconciledAt}
      )
    `
  })

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, BlockedCycleIntentStoreLive).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
})

describePostgres('PostgreSQL authority cycle recovery', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(resetDatabase)
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test.each(['clear', 'operator', 'position'] as const)(
    'native expired-entry migration requires clear flat authority: %s',
    async (scenario) => {
      const fixture = makeExpiredNativeFixture()
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const cycles = yield* CycleStore
          yield* seedRepairableCycle(sql, cycles, fixture)
          if (scenario === 'operator')
            yield* sql`UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',
        reason='operator stop',version=version+1,updated_at=clock_timestamp() WHERE singleton`
          if (scenario === 'position')
            yield* sql`INSERT INTO position_snapshots
        (snapshot_id,schema_version,account_id,source_hash,observed_at,position_count,content_hash,ingestion_order_trusted)
        VALUES (${'9'.repeat(64)},'bayn.paper-position-snapshot.v1',${accountId},${'9'.repeat(64)},
        ${instant(Date.parse(fixture.reconciledAt) - 1)},1,${'9'.repeat(64)},true)`
          const before = Option.getOrThrow(yield* cycles.read(fixture.cycle.identity.cycleId))
          const repair = yield* Effect.all([recoverExpiredNativeEntryAdmission, recoverExpiredNativeEntryAdmission], {
            concurrency: 2,
          }).pipe(Effect.result)
          const first = Option.getOrThrow(yield* cycles.read(fixture.cycle.identity.cycleId))
          const replay = yield* recoverExpiredNativeEntryAdmission.pipe(Effect.result)
          const repeated = Option.getOrThrow(yield* cycles.read(fixture.cycle.identity.cycleId))
          const triggers =
            yield* sql`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='autonomous_cycles'::regclass
        AND tgname IN ('autonomous_cycle_lifecycle','autonomous_cycles_unused_entry_admission') ORDER BY tgname`
          return { before, first, repeated, triggers, repair, replay }
        }),
      )
      expect(Result.isSuccess(result.repair)).toBe(scenario === 'clear')
      expect(Result.isSuccess(result.replay)).toBe(scenario === 'clear')
      expect(result.first.state).toBe(CycleState.Blocked)
      expect(result.first.terminalReason).toBe(
        scenario === 'clear' ? CycleTerminalReason.UnusedEntryExpired : CycleTerminalReason.Authority,
      )
      expect(result.first.stateVersion).toBe(result.before.stateVersion + (scenario === 'clear' ? 1 : 0))
      expect(result.repeated).toEqual(result.first)
      expect(result.triggers).toEqual([
        { tgname: 'autonomous_cycle_lifecycle', tgenabled: 'O' },
        { tgname: 'autonomous_cycles_unused_entry_admission', tgenabled: 'O' },
      ])
      if (scenario === 'clear') {
        const policy = fixture.cycle.identity.executionPolicy
        if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
          throw new Error('Expected native policy')
        const at = instant(Date.now())
        const session = value(
          tradingWindow(continuousMarketHours, at, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
        )
        if (session === null) throw new Error('Expected continuous session')
        expect(
          canRearmUnusedCycle(
            result.first,
            {
              cycleBindingId: planHash,
              strategyName: 'jev',
              strategyProtocolHash: fixture.cycle.identity.strategyProtocolHash,
              accountId,
              executionPolicy: policy,
            },
            continuousMarketHours,
            session,
            at,
          ),
        ).toBe(true)
      }
    },
  )

  test('a failed native expiry migration restores the terminal row and both lifecycle guards', async () => {
    const fixture = makeExpiredNativeFixture()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedRepairableCycle(sql, cycles, fixture)
        const before = yield* cycles.read(fixture.cycle.identity.cycleId)
        yield* sql`CREATE FUNCTION reject_fixture_expiry() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'fixture expiry write failure' USING ERRCODE='23514'; END $body$`
        yield* sql`CREATE TRIGGER reject_fixture_expiry AFTER UPDATE ON autonomous_cycles
        FOR EACH ROW EXECUTE FUNCTION reject_fixture_expiry()`
        const failed = yield* recoverExpiredNativeEntryAdmission.pipe(Effect.result)
        const after = yield* cycles.read(fixture.cycle.identity.cycleId)
        const triggers = yield* sql`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='autonomous_cycles'::regclass
        AND tgname IN ('autonomous_cycle_lifecycle','autonomous_cycles_unused_entry_admission') ORDER BY tgname`
        return { before, after, failed, triggers }
      }),
    )
    expect(Result.isFailure(result.failed)).toBe(true)
    expect(result.after).toEqual(result.before)
    expect(result.triggers).toEqual([
      { tgname: 'autonomous_cycle_lifecycle', tgenabled: 'O' },
      { tgname: 'autonomous_cycles_unused_entry_admission', tgenabled: 'O' },
    ])
  })

  test('reads and locks capital authority persisted with the active intraday protocol', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* seedExecutionAuthority(sql, makeFixture())
        const authority = makeAuthorityPostgres(sql)
        const rows = yield* authority.readGeneration(
          Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
        )
        const locked = yield* sql.withTransaction(authority.lockCapitalGrant(accountId))
        return { rows, locked }
      }),
    )
    expect(result.rows[0]?.strategy_parameter_schema_version).toBe('bayn.jev.protocol.v22')
    expect(result.locked.history.strategy_parameter_schema_version).toBe('bayn.jev.protocol.v22')
    expect(result.locked.current.generationHash).toBe(result.rows[0]?.generation_hash)
  })

  test.each(
    [
      executionActivationExpiredRestrictionReason,
      legacyExecutionActivationExpiredRestrictionReason,
      strategyProtocolCutoverRestrictionReason,
    ].flatMap((reason) =>
      [
        'no-cycle',
        'unused-preopen-cycle',
        ...(reason === strategyProtocolCutoverRestrictionReason ? ['expired-unused-cycle'] : []),
      ].map((scenario) => ({ reason, scenario })),
    ),
  )(
    'recovers a flat restricted generation through the production coordinator: $scenario / $reason',
    async ({ reason, scenario }) => {
      const fixture = scenario === 'expired-unused-cycle' ? makeExpiredNativeFixture() : makeFixture()
      const generationHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' }))
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const cycles = yield* CycleStore
          const blocked = yield* BlockedCycleIntentStore
          const fence = yield* WriterFence
          yield* seedExecutionAuthority(sql, fixture)
          if (scenario !== 'no-cycle') {
            yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
            yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
          }
          yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
  reason = ${reason}, version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
          const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
          let reconciliations = 0
          const reconcile = Effect.gen(function* () {
            // Reaching here proves that settlement did not require the new reconciliation in advance.
            reconciliations += 1
            expect(yield* authority.readAuthorityState).toMatchObject({
              generationHash,
              effective: Authority.Observe,
              kill: KillState.Active,
            })
            expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_forward_performance_receipts`).toEqual([
              { count: 0 },
            ])
            const exactHash = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'zero-expiry-current' }))
            yield* sql`INSERT INTO position_snapshots (
    snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
  ) VALUES (
    ${exactHash}, 'bayn.paper-position-snapshot.v1', ${accountId}, ${exactHash}, clock_timestamp(), 0, ${exactHash}
  )`
            yield* sql`INSERT INTO reconciliations (
    reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
    content_hash, status, discrepancies, reconciled_at
  ) VALUES (
    ${exactHash}, 'bayn.paper-reconciliation.v1', ${accountId}, ${exactHash}, ${exactHash},
    ${exactHash}, 'EXACT', ${sql.json([])}, clock_timestamp()
  )`
          }).pipe(
            Effect.mapError((cause) =>
              operationalError({
                component: 'database',
                operation: 'reconcile-test-fixture',
                message: 'failed to reconcile test fixture',
                cause,
              }),
            ),
          )
          const recover = recoverTerminalGenerationToObserve({
            accountId,
            blockedIntents: blocked,
            authorityStore: authority,
            writerFence: fence,
            reconcileAfterSettlement: reconcile,
          })
          const result = yield* recover
          expect(result).toMatchObject({
            _tag: 'RolledOver',
            previousGenerationHash: generationHash,
            terminalIntentCount: 0,
          })
          const state = yield* authority.readAuthorityState
          expect(state).toMatchObject({
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: KillState.Clear,
          })
          expect(state.generationHash).not.toBe(generationHash)
          if (scenario !== 'no-cycle') {
            expect(Option.getOrThrow(yield* cycles.read(fixture.cycle.identity.cycleId)).state).toBe(CycleState.Blocked)
          }
          expect(yield* recover).toEqual({ _tag: 'NotRequired' })
          expect(reconciliations).toBe(1)
          expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_forward_performance_receipts`).toEqual([
            { count: 0 },
          ])
        }).pipe(Effect.provide(WriterFenceLive)),
      )
    },
  )

  test('retains capital-sizing cutover authority when a cycle already has decision evidence', async () => {
    const now = Date.now()
    const fixture = {
      ...makeFixture(true),
      acquiredAt: instant(now - 5_000),
      cycleActivatedAt: instant(now - 4_000),
      restrictedAt: instant(now - 2_000),
      reconciledAt: instant(now - 1_000),
    }
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        const snapshotId = Result.getOrThrow(canonicalHashV1Result({ snapshot: 'capital-cutover-existing' }))
        const decisionHash = Result.getOrThrow(canonicalHashV1Result({ decision: 'capital-cutover-existing' }))
        const decisionAt = instant(Date.parse(fixture.cycleActivatedAt) + 1000)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO autonomous_cycle_shadow_decisions(cycle_id,schema_version,document,created_at)
  VALUES (${fixture.cycle.identity.cycleId},'bayn.paper-cycle-decision.v2',${sql.json({
    schemaVersion: 'bayn.paper-cycle-decision.v2',
    mode: 'PAPER',
    dispatchable: true,
    bindings: {
      cycleId: fixture.cycle.identity.cycleId,
      authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
    },
    contentHash: decisionHash,
    createdAt: decisionAt,
    orderedIntentIds: [],
    targetPlan: { status: 'NO_TRADE', intentTargets: [] },
  })},${decisionAt})`
            yield* sql`UPDATE autonomous_cycles SET snapshot_id=${snapshotId},decision_hash=${decisionHash},state_version=state_version+1,
  updated_at=${decisionAt} WHERE cycle_id=${fixture.cycle.identity.cycleId}`
          }),
        )
        yield* sql`UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',
  reason=${strategyProtocolCutoverRestrictionReason},version=version+1,updated_at=${fixture.restrictedAt} WHERE singleton`
        const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
        const before = yield* authority.readAuthorityState
        const result = yield* recoverTerminalGenerationToObserve({
          accountId,
          blockedIntents: yield* BlockedCycleIntentStore,
          authorityStore: authority,
          writerFence: yield* WriterFence,
          reconcileAfterSettlement: Effect.die('an unsettled cycle cannot reach authority reconciliation'),
        })
        expect(result).toEqual({ _tag: 'NotRequired' })
        expect(yield* authority.readAuthorityState).toEqual(before)
        expect(Option.getOrThrow(yield* cycles.read(fixture.cycle.identity.cycleId))).toMatchObject({
          state: CycleState.Active,
          bindings: { snapshotId, decisionHash },
        })
      }).pipe(Effect.provide(WriterFenceLive)),
    )
  })

  test.each([executionActivationExpiredRestrictionReason, strategyProtocolCutoverRestrictionReason])(
    'retains the restriction when fresh recovery reconciliation fails: %s',
    async (reason) => {
      const fixture = makeFixture()
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const blocked = yield* BlockedCycleIntentStore
          const fence = yield* WriterFence
          yield* seedExecutionAuthority(sql, fixture)
          yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
  reason = ${reason}, version = version + 1,
  updated_at = ${fixture.restrictedAt} WHERE singleton`
          const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
          const before = yield* authority.readAuthorityState
          const error = operationalError({
            component: 'database',
            operation: 'reconcile-test-fixture',
            message: 'injected unavailable reconciliation',
          })
          const result = yield* recoverTerminalGenerationToObserve({
            accountId,
            blockedIntents: blocked,
            authorityStore: authority,
            writerFence: fence,
            reconcileAfterSettlement: Effect.fail(error),
          }).pipe(Effect.result)
          expect(result).toEqual(Result.fail(error))
          expect(yield* authority.readAuthorityState).toEqual(before)
          expect(yield* sql`SELECT count(*)::integer AS count FROM autonomous_forward_performance_receipts`).toEqual([
            { count: 0 },
          ])
        }).pipe(Effect.provide(WriterFenceLive)),
      )
    },
  )
  test('generation settlement avoids decoding unrelated historical decision evidence', async () => {
    const fixture = makeFixture(true)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* seedExecutionAuthority(sql, fixture)
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = 'execution cycle loop restricted effective authority: run-cycle-pass: mutation autonomous cycle pass did not complete or reconcile within 30000ms',
          version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
              cycle_id text PRIMARY KEY, decision_hash text NOT NULL, document jsonb NOT NULL,
              created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ON COMMIT DROP`
            yield* sql`INSERT INTO autonomous_cycle_shadow_decisions
              SELECT md5(n::text) || md5('cycle-' || n::text),
                md5('decision-' || n::text) || md5(n::text),
                jsonb_build_object(
                  'schemaVersion', 'bayn.paper-cycle-decision.v2', 'mode', 'PAPER',
                  'bindings', jsonb_build_object('authorityGenerationHash', md5(n::text) || md5(n::text)),
                  'retainedEvidence', (SELECT jsonb_agg(md5(k::text)) FROM generate_series(1, 2048) AS k)
                )
              FROM generate_series(1, 256) AS n`
            yield* shadowDecisionGenerationIndex
            yield* sql`ANALYZE autonomous_cycle_shadow_decisions`
            let lookup: Statement<Record<string, unknown>> | undefined
            const monitored = new Proxy(sql, {
              apply(target, receiver, argumentsList) {
                const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
                if (statement.compile()[0].includes('WITH current_generation AS MATERIALIZED')) lookup = statement
                return statement
              },
            })
            const settle = Effect.gen(function* () {
              const blocked = yield* BlockedCycleIntentStore
              return yield* blocked.settleCurrentTerminalGeneration({ accountId, observedAt: fixture.reconciledAt })
            }).pipe(
              Effect.provide(
                Layer.fresh(BlockedCycleIntentStoreLive).pipe(
                  Layer.provide(Layer.succeed(PgClient.PgClient, monitored)),
                ),
              ),
            )
            expect(yield* settle).toMatchObject({
              _tag: 'TerminalGenerationSettled',
              authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
              intentCount: 0,
              terminalIntentCount: 0,
            })
            if (lookup === undefined) throw new Error('Settlement did not inspect the current generation')
            const [query, parameters] = lookup.compile()
            const explanation = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters)
            const plans = yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Record(Schema.String, Schema.Unknown) })),
                }),
              ),
            )(explanation)
            const root = plans[0]?.['QUERY PLAN'][0]?.Plan
            if (root === undefined) throw new Error('PostgreSQL did not return the settlement query plan')
            const touchedBlocks = [
              'Shared Hit Blocks',
              'Shared Read Blocks',
              'Local Hit Blocks',
              'Local Read Blocks',
            ].reduce((sum, key) => sum + Number(root[key] ?? 0), 0)
            expect(touchedBlocks).toBeLessThan(128)
            yield* sql`INSERT INTO autonomous_cycle_shadow_decisions
              SELECT ${'f'.repeat(64)}, ${'e'.repeat(64)},
                jsonb_set(document, '{bindings,authorityGenerationHash}',
                  to_jsonb(${Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' }))}::text))
              FROM autonomous_cycle_shadow_decisions LIMIT 1`
            expect(yield* settle).toEqual({ _tag: 'NoTerminalGeneration' })
          }),
        )
      }),
    )
  })

  test.each([
    { decisionEvidence: 'zero-target', terminalAfterRestriction: false },
    { decisionEvidence: 'planned-target', terminalAfterRestriction: false },
    { decisionEvidence: 'zero-target', terminalAfterRestriction: true },
    { decisionEvidence: 'planned-target', terminalAfterRestriction: true },
    ...(
      [
        'account',
        'qualification',
        'strategy',
        'protocol',
        'snapshot',
        'cutoff',
        'missing',
        'created-before-cycle',
        'created-before-open',
        'created-after-update',
      ] as const
    ).flatMap((decisionEvidence) => [
      { decisionEvidence, terminalAfterRestriction: false },
      { decisionEvidence, terminalAfterRestriction: true },
    ]),
  ] as const)(
    'settles only zero-target NO_TRADE generations: decisionEvidence=$decisionEvidence terminalAfterRestriction=$terminalAfterRestriction',
    async ({ decisionEvidence, terminalAfterRestriction }) => {
      const now = Date.now()
      const fixture = {
        ...makeFixture(decisionEvidence !== 'created-before-open'),
        acquiredAt: instant(now - 20_000),
        cycleActivatedAt: instant(now - 19_000),
        restrictedAt: instant(now - 16_000),
        reconciledAt: instant(now - 10_000),
        positionsObservedAt: instant(now - 12_000),
      }
      const generationHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' }))
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const cycles = yield* CycleStore
          const blocked = yield* BlockedCycleIntentStore
          yield* seedExecutionAuthority(sql, fixture)
          for (const ordinal of [1, 2]) {
            const original = fixture.cycle.identity
            const identity = value(
              makeCycleIdentity({
                schemaVersion: 'bayn.autonomous-cycle-identity.v4',
                entryAttemptOrdinal: ordinal,
                strategyName: original.strategyName,
                qualificationRunId: original.qualificationRunId,
                strategyProtocolHash: original.strategyProtocolHash,
                accountId,
                executionSessionDate: original.executionSessionDate,
                executionCalendarSchemaVersion: original.executionCalendarSchemaVersion,
                executionCalendarSource: original.executionCalendarSource,
                executionCalendarHash: original.executionCalendarHash,
                executionPolicy: original.executionPolicy,
              }),
            )
            const draft = value(makeCycleDraft(identity, fixture.cycle.window))
            const cycleId = draft.identity.cycleId
            const snapshotId = Result.getOrThrow(canonicalHashV1Result({ snapshot: ordinal }))
            const decisionHash = Result.getOrThrow(canonicalHashV1Result({ decision: ordinal }))
            const decisionAt = instant(Date.parse(fixture.cycleActivatedAt) + ordinal * 1000)
            const terminalAt = instant(
              Date.parse(fixture.restrictedAt) + (ordinal === 2 && terminalAfterRestriction ? 1000 : -1000),
            )
            const documentAt =
              ordinal === 2 && decisionEvidence === 'created-before-cycle'
                ? instant(Date.parse(fixture.acquiredAt) - 1000)
                : ordinal === 2 && decisionEvidence === 'created-after-update'
                  ? instant(Date.parse(terminalAt) + 1000)
                  : decisionAt
            yield* cycles.acquire(draft, fixture.acquiredAt)
            yield* cycles.activate(cycleId, fixture.cycleActivatedAt)
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO autonomous_cycle_shadow_decisions(cycle_id,schema_version,document,created_at)
            VALUES (${cycleId},'bayn.paper-cycle-decision.v2',${sql.json({
              schemaVersion: 'bayn.paper-cycle-decision.v2',
              mode: 'PAPER',
              dispatchable: true,
              bindings: {
                cycleId,
                authorityGenerationHash: generationHash,
                ...(ordinal === 2 && decisionEvidence === 'missing'
                  ? {}
                  : {
                      accountId: ordinal === 2 && decisionEvidence === 'account' ? 'another-account' : accountId,
                      qualificationRunId:
                        ordinal === 2 && decisionEvidence === 'qualification'
                          ? 'a'.repeat(64)
                          : identity.qualificationRunId,
                      strategyName:
                        ordinal === 2 && decisionEvidence === 'strategy' ? 'another-strategy' : identity.strategyName,
                      strategyProtocolHash:
                        ordinal === 2 && decisionEvidence === 'protocol'
                          ? 'b'.repeat(64)
                          : identity.strategyProtocolHash,
                      snapshotId: ordinal === 2 && decisionEvidence === 'snapshot' ? 'c'.repeat(64) : snapshotId,
                    }),
              },
              submissionCutoffAt:
                ordinal === 2 && decisionEvidence === 'cutoff'
                  ? instant(Date.parse(draft.window.submissionCutoffAt) - 1000)
                  : draft.window.submissionCutoffAt,
              contentHash: decisionHash,
              createdAt: documentAt,
              orderedIntentIds: [],
              targetPlan: {
                status: 'NO_TRADE',
                intentTargets: ordinal === 2 && decisionEvidence === 'planned-target' ? [{ symbol: 'AAPL' }] : [],
              },
            })},${documentAt})`
                yield* sql`UPDATE autonomous_cycles SET snapshot_id=${snapshotId},decision_hash=${decisionHash},state_version=state_version+1,
            updated_at=${decisionAt} WHERE cycle_id=${cycleId}`
                yield* sql`UPDATE autonomous_cycles SET state='NO_TRADE',state_version=state_version+1,
            updated_at=${terminalAt},terminal_at=${terminalAt} WHERE cycle_id=${cycleId}`
              }),
            )
          }
          yield* sql`UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',
        reason='execution cycle loop restricted effective authority: run-cycle-pass: pass timeout',
        version=version+1,updated_at=${fixture.restrictedAt} WHERE singleton`
          const result = yield* blocked.settleCurrentTerminalGeneration({ accountId, observedAt: fixture.reconciledAt })
          expect(result._tag).toBe(
            decisionEvidence === 'zero-target' ? 'TerminalGenerationSettled' : 'NoTerminalGeneration',
          )
          if (decisionEvidence === 'zero-target') {
            const rollover = yield* recoverTerminalGenerationToObserve({
              accountId,
              blockedIntents: blocked,
              authorityStore: makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity),
              writerFence: yield* WriterFence,
              reconcileAfterSettlement: Effect.gen(function* () {
                yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,observed_at,position_count,content_hash)
              VALUES (${'a'.repeat(64)},'bayn.paper-position-snapshot.v1',${accountId},${'b'.repeat(64)},clock_timestamp(),0,${'c'.repeat(64)})`
                yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
              VALUES (${'d'.repeat(64)},'bayn.paper-reconciliation.v1',${accountId},${'e'.repeat(64)},${'e'.repeat(64)},${'f'.repeat(64)},'EXACT','[]'::jsonb,clock_timestamp())`
              }).pipe(
                Effect.mapError((cause) =>
                  operationalError({
                    component: 'database',
                    operation: 'reconcile',
                    message: 'Test reconciliation failed',
                    cause,
                  }),
                ),
              ),
            })
            expect(rollover._tag).toBe('RolledOver')
            expect(yield* sql`SELECT effective,kill_state FROM authority_state`).toEqual([
              { effective: 'OBSERVE', kill_state: 'CLEAR' },
            ])
          }
        }).pipe(Effect.provide(WriterFenceLive)),
      )
    },
  )

  test('recovers a generation restricted before its first cycle only after fresh exact reconciliation', async () => {
    const fixture = makeFixture(true)
    const successorHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'unused-successor' }))
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const blocked = yield* BlockedCycleIntentStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = 'execution cycle loop restricted effective authority: run-cycle-pass: mutation autonomous cycle pass did not complete or reconcile within 30000ms',
          version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
        const settlement = yield* blocked.settleCurrentTerminalGeneration({
          accountId,
          observedAt: fixture.reconciledAt,
        })

        expect(settlement).toMatchObject({
          _tag: 'TerminalGenerationSettled',
          authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
          blockedCycleCount: 0,
          intentCount: 0,
          terminalIntentCount: 0,
        })

        const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
        const rotate = authority.ensureAuthorityGeneration({
          generationHash: successorHash,
          maximum: Authority.Observe,
        })
        const stale = yield* rotate.pipe(Effect.flip)
        expect(stale.failure).toBe('invariant')
        expect(yield* authority.readAuthorityState).toMatchObject({
          generationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
          effective: Authority.Observe,
          kill: KillState.Active,
        })

        const exactHash = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'unused-generation-exact' }))
        yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'unused-generation' }))}, 'bayn.paper-reconciliation.v1',
          ${accountId}, ${exactHash}, ${exactHash}, ${exactHash},
          'EXACT', ${sql.json([])}, ${fixture.reconciledAt}
        )`
        expect(yield* rotate).toMatchObject({
          generationHash: successorHash,
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Clear,
        })
        expect(yield* blocked.settleCurrentTerminalGeneration({ accountId, observedAt: fixture.reconciledAt })).toEqual(
          {
            _tag: 'NoTerminalGeneration',
          },
        )
      }),
    )
  })

  test.each(['settled', 'submillisecond', 'stale', 'position', 'unresolved', 'operator'] as const)(
    'recovers restricted OBSERVE after historical trading only with settled fresh evidence: %s',
    async (scenario) => {
      const fixture = makeFixture(true)
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* seedExecutionAuthority(sql, fixture)
          const executionHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' }))
          const intentId = Result.getOrThrow(canonicalHashV1Result({ intent: 'prior-trade' }))
          const riskId = Result.getOrThrow(canonicalHashV1Result({ risk: 'prior-trade' }))
          const mutationId = Result.getOrThrow(canonicalHashV1Result({ mutation: 'prior-trade' }))
          const occurredAt = instant(Date.parse(fixture.generationActivatedAt) + 1_000)
          yield* sql`INSERT INTO intents (
          intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
          decision_hash, policy_hash, account_id, client_order_id, symbol, side, order_type, time_in_force,
          quantity_atoms, notional_limit_micros, limit_price_micros, state, state_version, created_at, updated_at
        ) VALUES (
          ${intentId}, 'bayn.execution-intent.v5', ${executionHash}, NULL, 'jev',
          ${fixture.cycle.identity.cycleId}, ${'0'.repeat(64)}, ${'7'.repeat(64)}, ${accountId}, 'prior-trade',
          'AAPL', 'BUY', 'LIMIT', 'DAY', 1000000, 1000000000, 1000000000000, 'PLANNED', 1, ${occurredAt}, ${occurredAt}
        )`
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO risk_decisions (
            decision_id, schema_version, input_hash, intent_id, policy_hash, outcome, reason_codes, decided_at, expires_at
          ) VALUES (
            ${riskId}, 'bayn.paper-risk-decision.v1', ${'b'.repeat(64)}, ${intentId}, ${'7'.repeat(64)},
            'APPROVED', ARRAY[]::text[], ${occurredAt}, '2099-01-01T00:00:00Z'
          )`
              yield* sql`UPDATE intents SET risk_decision_id = ${riskId}, state = 'APPROVED', state_version = 2, updated_at = updated_at + interval '1 millisecond'
            WHERE intent_id = ${intentId}`
            }),
          )
          yield* sql`UPDATE intents SET state = 'IO_STARTED', state_version = 3, updated_at = updated_at + interval '1 millisecond' WHERE intent_id = ${intentId}`
          yield* sql`INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
          request_hash, consistency_delay_ms, occurred_at
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ event: 1 }))}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 1,
          'SUBMIT', 'SUBMIT_STARTED', ${'8'.repeat(64)}, 1000, ${occurredAt}
        )`
          yield* sql`INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
          request_hash, consistency_delay_ms, broker_order_id, request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ event: 2 }))}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 2,
          'SUBMIT', 'SUBMIT_ACCEPTED', ${'8'.repeat(64)}, 1000, 'prior-order', 'prior-request', 200, ${'9'.repeat(64)}, ${occurredAt}
        )`
          yield* sql`UPDATE intents SET state = 'ACKNOWLEDGED', state_version = 4, updated_at = updated_at + interval '1 millisecond' WHERE intent_id = ${intentId}`
          yield* sql`UPDATE intents SET state = 'TERMINAL', terminal_outcome = 'CANCELED', state_version = 5, updated_at = updated_at + interval '1 millisecond'
          WHERE intent_id = ${intentId}`
          yield* sql`INSERT INTO position_snapshots (
          snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ snapshot: 'prior-flat' }))}, 'bayn.paper-position-snapshot.v1', ${accountId},
          ${'a'.repeat(64)}, ${fixture.positionsObservedAt}, 0, ${'a'.repeat(64)}
        )`
          yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash,
          status, discrepancies, reconciled_at
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'prior-flat' }))}, 'bayn.paper-reconciliation.v1', ${accountId},
          ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, 'EXACT', '[]'::jsonb, ${fixture.reconciledAt}
        )`
          const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
          const successor = yield* authority.ensureAuthorityGeneration({
            generationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'settled-observe' })),
            maximum: Authority.Observe,
          })
          expect(successor.kill).toBe(KillState.Clear)
          const restrictionClock =
            scenario === 'submillisecond'
              ? sql`date_trunc('milliseconds', greatest(clock_timestamp(), updated_at)) + interval '1 millisecond'`
              : sql`greatest(clock_timestamp(), updated_at + interval '1 millisecond')`
          const evidenceClock =
            scenario === 'submillisecond'
              ? sql`(SELECT updated_at + interval '1500 microseconds' FROM authority_state WHERE singleton)`
              : sql`clock_timestamp()`
          yield* sql`UPDATE authority_state SET kill_state = 'ACTIVE', effective = 'OBSERVE',
          reason = ${scenario === 'operator' ? 'operator hold' : 'reconciliation pass incomplete'},
          version = version + 1, updated_at = ${restrictionClock} WHERE singleton`
          if (scenario === 'position') {
            yield* sql`INSERT INTO position_snapshots (
            snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
          ) VALUES (
            ${Result.getOrThrow(canonicalHashV1Result({ snapshot: 'still-held' }))}, 'bayn.paper-position-snapshot.v1', ${accountId},
            ${'b'.repeat(64)}, clock_timestamp(), 1, ${'b'.repeat(64)}
          )`
          }
          if (scenario === 'unresolved') {
            yield* sql`INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, occurred_at
          ) VALUES (
            ${Result.getOrThrow(canonicalHashV1Result({ event: 3 }))}, 'bayn.paper-mutation-event.v1',
            ${Result.getOrThrow(canonicalHashV1Result({ mutation: 'unknown' }))}, ${intentId}, 1,
            'CANCEL', 'CANCEL_STARTED', ${'8'.repeat(64)}, 1000, 'prior-order', clock_timestamp()
          )`
          }
          if (scenario !== 'stale') {
            if (scenario !== 'position') {
              yield* sql`INSERT INTO position_snapshots (
              snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
            ) VALUES (
              ${Result.getOrThrow(canonicalHashV1Result({ snapshot: 'after-restriction' }))}, 'bayn.paper-position-snapshot.v1', ${accountId},
              ${'c'.repeat(64)}, ${evidenceClock}, 0, ${'c'.repeat(64)}
            )`
            }
            yield* sql`INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash,
            status, discrepancies, reconciled_at
          ) VALUES (
            ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'after-restriction' }))}, 'bayn.paper-reconciliation.v1', ${accountId},
            ${'b'.repeat(64)}, ${'b'.repeat(64)}, ${'b'.repeat(64)}, 'EXACT', '[]'::jsonb, ${evidenceClock}
          )`
          }
          const recoveryAuthority = makeObserveAuthorityInterpreter(
            sql,
            makeAuthorityPostgres(sql, {
              now:
                scenario === 'submillisecond'
                  ? sql`(SELECT updated_at + interval '1900 microseconds' FROM authority_state WHERE singleton)`
                  : sql`clock_timestamp()`,
            }),
            brokerIdentity,
          )
          const recovered = yield* recoveryAuthority.ensureAuthorityGeneration({
            generationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'recovered-observe' })),
            maximum: Authority.Observe,
          })
          expect(recovered.kill).toBe(
            scenario === 'settled' || scenario === 'submillisecond' ? KillState.Clear : KillState.Active,
          )
          if (scenario === 'submillisecond') {
            expect(
              yield* sql`SELECT
                state.updated_at = generation.activated_at AS matching_instant,
                extract(microseconds FROM state.updated_at - date_trunc('milliseconds', state.updated_at))::integer AS submillisecond
              FROM authority_state AS state
              JOIN authority_generations AS generation USING (generation_hash)
              WHERE state.singleton`,
            ).toEqual([{ matching_instant: true, submillisecond: 900 }])
          }
          expect(recovered.effective).toBe(Authority.Observe)
          expect(yield* sql`SELECT count(*)::integer AS count FROM mutation_events`).toEqual([
            { count: scenario === 'unresolved' ? 3 : 2 },
          ])
          expect(
            yield* sql`SELECT observe_recovery_account_settled(
              ${Result.getOrThrow(canonicalHashV1Result({ generation: 'observe' }))}, ${accountId}, ${fixture.reconciledAt}
            ) AS settled`,
          ).toEqual([{ settled: false }])
          expect(
            yield* sql`SELECT observe_recovery_account_settled(
              ${recovered.generationHash}, 'different-account', ${fixture.reconciledAt}
            ) AS settled`,
          ).toEqual([{ settled: false }])
        }),
      )
    },
  )

  test.each([
    { reason: 'operator kill switch', requestedAccount: accountId },
    {
      reason: 'execution cycle loop restricted effective authority: pass timeout',
      requestedAccount: 'another-account',
    },
  ])(
    'does not recover an unused generation for $reason with account $requestedAccount',
    async ({ reason, requestedAccount }) => {
      const fixture = makeFixture(true)
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const blocked = yield* BlockedCycleIntentStore
          yield* seedExecutionAuthority(sql, fixture)
          yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = ${reason}, version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
          expect(
            yield* blocked.settleCurrentTerminalGeneration({
              accountId: requestedAccount,
              observedAt: fixture.reconciledAt,
            }),
          ).toEqual({
            _tag: 'NoTerminalGeneration',
          })
        }),
      )
    },
  )

  test.each([
    executionMandateCompletedRestrictionReason,
    executionActivationExpiredRestrictionReason,
    legacyV1CompletedRestrictionReason,
    legacyExecutionActivationExpiredRestrictionReason,
  ])('retires an unused preopen cycle when a receipted mandate is restricted for %s', async (reason) => {
    const fixture = makeFixture()
    const generationHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' }))
    const successorHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'retired-successor' }))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        const blocked = yield* BlockedCycleIntentStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* sql`INSERT INTO autonomous_forward_performance_receipts (
          authority_generation_hash, cycle_id, document, created_at
        ) VALUES (
          ${generationHash}, ${fixture.cycle.identity.cycleId}, ${sql.json({
            schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
            authorityGenerationHash: generationHash,
            cycleId: fixture.cycle.identity.cycleId,
            contentHash: Result.getOrThrow(canonicalHashV1Result({ performance: 'retired' })),
            receiptHash: Result.getOrThrow(canonicalHashV1Result({ receipt: 'retired' })),
            receipt: { receiptHash: Result.getOrThrow(canonicalHashV1Result({ receipt: 'retired' })) },
            createdAt: fixture.restrictedAt,
          })}, ${fixture.restrictedAt}
        )`
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = ${reason}, version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
        const exactHash = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'retired-exact' }))
        yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'retired' }))}, 'bayn.paper-reconciliation.v1',
          ${accountId}, ${exactHash}, ${exactHash}, ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'retired-content' }))},
          'EXACT', ${sql.json([])}, ${fixture.reconciledAt}
        )`
        const settlement = yield* blocked.settleCurrentTerminalGeneration({
          accountId,
          observedAt: fixture.reconciledAt,
        })
        if (settlement._tag !== 'TerminalGenerationSettled') return yield* Effect.die('expected settlement')
        expect(settlement.preserveCyclePlanHash).toBeUndefined()
        const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
        const rotated = yield* authority.ensureAuthorityGeneration({
          generationHash: successorHash,
          maximum: Authority.Observe,
          ...(settlement.preserveCyclePlanHash === undefined
            ? {}
            : { preserveCyclePlanHash: settlement.preserveCyclePlanHash }),
        })
        return { rotated, cycle: yield* cycles.read(fixture.cycle.identity.cycleId) }
      }),
    )
    expect(result.rotated).toMatchObject({
      generationHash: successorHash,
      effective: Authority.Observe,
      kill: KillState.Clear,
    })
    expect(Option.getOrThrow(result.cycle).state).toBe(CycleState.Blocked)
    expect(Option.getOrThrow(result.cycle).terminalReason).toBe(CycleTerminalReason.ProvenanceMismatch)
  })

  test.each(
    ['before', 'after'].flatMap((timing) =>
      [
        'execution cycle loop restricted effective authority: source rollover',
        'reconciliation pass incomplete',
        `reconciliation discrepancy ${'8'.repeat(64)}`,
      ].map((reason) => ({ timing, reason })),
    ),
  )(
    'preserves an untouched same-plan cycle created $timing the restriction for $reason',
    async ({ timing, reason }) => {
      const fixture = makeFixture()
      if (timing === 'after') {
        fixture.acquiredAt = instant(Date.parse(fixture.restrictedAt) + 1_000)
        fixture.cycleActivatedAt = instant(Date.parse(fixture.restrictedAt) + 2_000)
      }
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const cycles = yield* CycleStore
          const blockedCycles = yield* BlockedCycleIntentStore
          yield* seedExecutionAuthority(sql, fixture)
          yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
          yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
          yield* sql`
          UPDATE authority_state
          SET
            effective = 'OBSERVE',
            kill_state = 'ACTIVE',
            reason = ${reason},
            version = version + 1,
            updated_at = ${fixture.restrictedAt}
          WHERE singleton
        `
          const settlement = yield* blockedCycles.settleCurrentTerminalGeneration({
            accountId,
            observedAt: fixture.reconciledAt,
          })
          return { settlement, cycle: yield* cycles.read(fixture.cycle.identity.cycleId) }
        }),
      )

      expect(result.settlement).toEqual({
        _tag: 'TerminalGenerationSettled',
        authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
        preserveCyclePlanHash: planHash,
        blockedCycleCount: 0,
        blockedIntentCount: 0,
        expiredIntentCount: 0,
        intentCount: 0,
        terminalIntentCount: 0,
      })
      const preserved = Option.getOrThrow(result.cycle)
      expect(preserved.state).toBe(CycleState.Active)
      expect(preserved.terminalReason).toBeUndefined()
    },
  )

  test('preserves an untouched cycle after open while a failed generation settles', async () => {
    const fixture = makeFixture()
    const observedAt = instant(Date.parse(fixture.cycle.window.submissionOpenAt) + 60_000)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        const blocked = yield* BlockedCycleIntentStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
        reason = 'execution cycle loop restricted effective authority: pass timeout',
        version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
        const settled = yield* blocked.settleCurrentTerminalGeneration({ accountId, observedAt })
        const expired = yield* blocked.settleCurrentTerminalGeneration({
          accountId,
          observedAt: fixture.cycle.window.submissionCutoffAt,
        })
        return { settled, expired, cycle: yield* cycles.read(fixture.cycle.identity.cycleId) }
      }),
    )
    expect(result.settled).toMatchObject({
      _tag: 'TerminalGenerationSettled',
      preserveCyclePlanHash: planHash,
      blockedCycleCount: 0,
    })
    expect(result.expired).toEqual({ _tag: 'NoTerminalGeneration' })
    expect(Option.getOrThrow(result.cycle).state).toBe(CycleState.Active)
  })

  test.each([
    'execution cycle loop restricted effective authority: pass timeout',
    'reconciliation pass incomplete',
    `reconciliation discrepancy ${'8'.repeat(64)}`,
  ])('rotates a generation restricted for %s with an untouched open-session cycle before cutoff', async (reason) => {
    const fixture = makeFixture(true)
    const successorHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'open-session-successor' }))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        const blocked = yield* BlockedCycleIntentStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = ${reason},
          version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
        const settlement = yield* blocked.settleCurrentTerminalGeneration({
          accountId,
          observedAt: fixture.reconciledAt,
        })
        if (settlement._tag !== 'TerminalGenerationSettled') return yield* Effect.die('expected settlement')
        const preserveCyclePlanHash = settlement.preserveCyclePlanHash
        if (preserveCyclePlanHash === undefined) return yield* Effect.die('expected preserved cycle')
        const exactHash = Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'post-settlement-exact' }))
        const reconciledAt = instant(Date.parse(fixture.reconciledAt) + 1_000)
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'post-settlement' }))}, 'bayn.paper-reconciliation.v1',
            ${accountId}, ${exactHash}, ${exactHash},
            ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'post-settlement-content' }))},
            'EXACT', ${sql.json([])}, ${reconciledAt}
          )
        `
        const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
        const rotated = yield* authority.ensureAuthorityGeneration({
          generationHash: successorHash,
          maximum: Authority.Observe,
          preserveCyclePlanHash,
        })
        return { rotated, cycle: yield* cycles.read(fixture.cycle.identity.cycleId) }
      }),
    )
    expect(result.rotated).toMatchObject({
      generationHash: successorHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
    })
    expect(Option.getOrThrow(result.cycle).state).toBe(CycleState.Active)
  })

  test('preserves a fee-restricted unused session and refuses rollover until a later exact reconciliation', async () => {
    const fixture = makeFixture()
    const successorHash = Result.getOrThrow(canonicalHashV1Result({ generation: 'fee-reconciliation-successor' }))
    const discrepancyId = '8'.repeat(64)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        const blocked = yield* BlockedCycleIntentStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = ${`reconciliation discrepancy ${discrepancyId}`},
          version = version + 1, updated_at = ${fixture.restrictedAt} WHERE singleton`
        const discrepancy = {
          discrepancyId,
          kind: 'CASH',
          identity: accountId,
          expected: '99939.01',
          observed: '99941.23',
          evidenceHash: Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'fees-awaiting-broker-cash' })),
          firstObservedAt: fixture.restrictedAt,
          lastObservedAt: fixture.reconciledAt,
        }
        yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at
        ) VALUES (
          ${discrepancyId}, 'bayn.paper-reconciliation.v1', ${accountId},
          ${Result.getOrThrow(canonicalHashV1Result({ cash: discrepancy.expected }))}, ${Result.getOrThrow(canonicalHashV1Result({ cash: discrepancy.observed }))},
          ${Result.getOrThrow(canonicalHashV1Result(discrepancy))}, 'DISCREPANCY', ${sql.json([discrepancy])},
          ${fixture.reconciledAt}
        )`
        const settlement = yield* blocked.settleCurrentTerminalGeneration({
          accountId,
          observedAt: fixture.reconciledAt,
        })
        if (settlement._tag !== 'TerminalGenerationSettled' || settlement.preserveCyclePlanHash === undefined) {
          return yield* Effect.die('expected an untouched preserved cycle')
        }
        const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
        const request = {
          generationHash: successorHash,
          maximum: Authority.Observe,
          preserveCyclePlanHash: settlement.preserveCyclePlanHash,
        }
        const inexactRollover = yield* authority.ensureAuthorityGeneration(request).pipe(Effect.result)
        const restrictedState =
          yield* sql`SELECT generation_hash, effective, kill_state FROM authority_state WHERE singleton`
        const restrictedCycle = yield* cycles.read(fixture.cycle.identity.cycleId)
        const exactHash = Result.getOrThrow(canonicalHashV1Result({ cash: discrepancy.expected }))
        yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at
        ) VALUES (
          ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'fees-reflected' }))}, 'bayn.paper-reconciliation.v1',
          ${accountId}, ${exactHash}, ${exactHash}, ${Result.getOrThrow(canonicalHashV1Result({ reconciliation: 'fees-reflected-content' }))},
          'EXACT', ${sql.json([])}, ${instant(Date.parse(fixture.reconciledAt) + 1_000)}
        )`
        const rotated = yield* authority.ensureAuthorityGeneration(request)
        return {
          settlement,
          inexactRollover,
          restrictedState,
          restrictedCycle,
          rotated,
          cycle: yield* cycles.read(fixture.cycle.identity.cycleId),
        }
      }),
    )
    expect(result.settlement).toMatchObject({ preserveCyclePlanHash: planHash, blockedCycleCount: 0 })
    expect(Result.isFailure(result.inexactRollover)).toBe(true)
    expect(result.restrictedState).toEqual([
      {
        generation_hash: Result.getOrThrow(canonicalHashV1Result({ generation: 'execution' })),
        effective: 'OBSERVE',
        kill_state: 'ACTIVE',
      },
    ])
    expect(Option.getOrThrow(result.restrictedCycle).state).toBe(CycleState.Active)
    expect(result.rotated).toMatchObject({
      generationHash: successorHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
    })
    expect(Option.getOrThrow(result.cycle).state).toBe(CycleState.Active)
    expect(Option.getOrThrow(result.cycle).bindings.decisionHash).toBeUndefined()
  })

  test('retired repair cannot reopen a current native terminal cycle and leaves its lifecycle trigger enabled', async () => {
    const fixture = makeFixture(true)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedRepairableCycle(sql, cycles, fixture)
        const before = yield* cycles.read(fixture.cycle.identity.cycleId)
        yield* Effect.all([recoverIntradayAuthorityCycle, recoverIntradayAuthorityCycle], { concurrency: 2 })
        const first = yield* cycles.read(fixture.cycle.identity.cycleId)
        yield* recoverIntradayAuthorityCycle
        const triggers = yield* sql`SELECT tgenabled FROM pg_trigger
        WHERE tgrelid = 'autonomous_cycles'::regclass AND tgname = 'autonomous_cycle_lifecycle'`
        return { before, first, repeated: yield* cycles.read(fixture.cycle.identity.cycleId), triggers }
      }),
    )
    expect(result.first).toEqual(result.before)
    expect(result.repeated).toEqual(result.first)
    expect(result.triggers).toEqual([{ tgenabled: 'O' }])
  })

  test('does not repair an open session with an active manual restriction', async () => {
    const fixture = makeFixture(true)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedRepairableCycle(sql, cycles, fixture)
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
        reason = 'operator stop', version = version + 1, updated_at = clock_timestamp() WHERE singleton`
        yield* recoverIntradayAuthorityCycle
        return yield* cycles.read(fixture.cycle.identity.cycleId)
      }),
    )
    expect(Option.getOrThrow(result).state).toBe(CycleState.Blocked)
  })

  test('retired repair preserves a current native cycle blocked by authority before its window', async () => {
    const fixture = makeFixture()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedRepairableCycle(sql, cycles, fixture)
        yield* recoverPreopenAuthorityCycle
        const repaired = yield* cycles.read(fixture.cycle.identity.cycleId)
        yield* recoverPreopenAuthorityCycle
        return { repaired, replayed: yield* cycles.read(fixture.cycle.identity.cycleId) }
      }),
    )

    const repaired = Option.getOrThrow(result.repaired)
    expect(repaired.state).toBe(CycleState.Blocked)
    expect(repaired.terminalReason).toBe(CycleTerminalReason.Authority)
    expect(repaired.terminalAt).toBe(fixture.restrictedAt)
    expect(result.replayed).toEqual(result.repaired)
  })

  test.each([
    { name: 'preopen writer fence', repair: recoverPreopenAuthorityCycle, tableLock: false },
    { name: 'intraday writer fence', repair: recoverIntradayAuthorityCycle, tableLock: false },
    { name: 'intraday table lock', repair: recoverIntradayAuthorityCycle, tableLock: true },
  ])('rechecks the window after waiting for the $name', async ({ repair, tableLock }) => {
    const fixture = makeFixture()
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const cycles = yield* CycleStore
          yield* seedRepairableCycle(sql, cycles, fixture)
          yield* sql`ALTER TABLE autonomous_cycles DISABLE TRIGGER autonomous_cycle_lifecycle`
          yield* sql`
            WITH timing AS (
              SELECT clock_timestamp() AS observed_at
            )
            UPDATE autonomous_cycles AS cycle
            SET
              execution_session_date = (timing.observed_at AT TIME ZONE 'UTC')::date,
              execution_open_at = timing.observed_at,
              submission_open_at = timing.observed_at + interval '150 milliseconds',
              submission_cutoff_at = timing.observed_at + interval '500 milliseconds',
              execution_close_at = timing.observed_at + interval '501 milliseconds',
              submission_window_ms = 350,
              warmup_after_open_ms = 150,
              submission_cutoff_before_close_ms = 1
            FROM timing
            WHERE cycle_id = ${fixture.cycle.identity.cycleId}
          `
          yield* sql`ALTER TABLE autonomous_cycles ENABLE TRIGGER autonomous_cycle_lifecycle`

          const writer = yield* sql.reserve
          yield* writer.executeUnprepared('BEGIN', [], undefined)
          yield* Effect.addFinalizer(() => writer.executeUnprepared('ROLLBACK', [], undefined).pipe(Effect.ignore))
          if (tableLock) {
            yield* writer.executeUnprepared('LOCK TABLE autonomous_cycles IN SHARE ROW EXCLUSIVE MODE', [], undefined)
          } else {
            yield* writer.executeValues('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [1_111_578_958, 1])
          }

          const repairing = yield* repair.pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.sleep('650 millis')
          expect(repairing.pollUnsafe()).toBeUndefined()
          const blockedRows = yield* writer.executeValues('SELECT state FROM autonomous_cycles WHERE cycle_id = $1', [
            fixture.cycle.identity.cycleId,
          ])
          expect(blockedRows).toEqual([['BLOCKED']])

          yield* writer.executeUnprepared('ROLLBACK', [], undefined)
          yield* Fiber.join(repairing)
          const afterRepairRows = yield* sql<{ readonly state: string }>`
            SELECT state
            FROM autonomous_cycles
            WHERE cycle_id = ${fixture.cycle.identity.cycleId}
          `
          expect(afterRepairRows).toEqual([{ state: 'BLOCKED' }])
        }),
      ),
    )
  })

  test.each([
    { name: 'preopen', repair: recoverPreopenAuthorityCycle, openSession: false },
    { name: 'intraday', repair: recoverIntradayAuthorityCycle, openSession: true },
  ])('keeps $name blocked history without fresh flat reconciliation', async ({ repair, openSession }) => {
    const fixture = makeFixture(openSession)
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* cycles.block(fixture.cycle.identity.cycleId, CycleTerminalReason.Authority, fixture.restrictedAt)
        yield* repair
        return yield* cycles.read(fixture.cycle.identity.cycleId)
      }),
    )

    const blocked = Option.getOrThrow(stored)
    expect(blocked.state).toBe(CycleState.Blocked)
    expect(blocked.terminalReason).toBe(CycleTerminalReason.Authority)
  })
})

const expiryFixture = {
  generationHash: 'a'.repeat(64),
  cycleId: 'b'.repeat(64),
  decisionHash: 'c'.repeat(64),
  intentIds: ['d'.repeat(64), 'e'.repeat(64)],
  policyHash: 'f'.repeat(64),
  createdAt: '2026-08-28T14:30:00.000Z',
  expiresAt: '2026-08-28T14:30:10.000Z',
  reservedAt: '2026-08-28T14:30:09.000Z',
  cutoffAt: '2026-08-28T19:55:00.000Z',
} as const

const makeExpiryRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(BlockedCycleIntentStoreLive, WriterFenceLive).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

// Exercise the actual SQL adapters and writer lease independently of the much larger decision-creation fixture.
// These tables retain only the columns those adapters read; the preceding suite validates the migrated schema.
const seedUntouchedExpiry = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* sql`CREATE TABLE autonomous_cycles (
    cycle_id text PRIMARY KEY, state text, decision_hash text, submission_cutoff_at timestamptz, terminal_at timestamptz
  )`
  yield* sql`CREATE TABLE autonomous_cycle_shadow_decisions (cycle_id text, decision_hash text, document jsonb)`
  yield* sql`CREATE TABLE authority_generations (
    generation_hash text PRIMARY KEY, account_id text, maximum text, risk_policy_hash text, strategy_name text
  )`
  yield* sql`CREATE TABLE authority_state (
    singleton boolean PRIMARY KEY, generation_hash text, maximum text, effective text, kill_state text,
    reason text, version integer, updated_at timestamptz
  )`
  yield* sql`CREATE TABLE intents (
    intent_id text PRIMARY KEY, authority_generation_hash text, cycle_id text, account_id text, policy_hash text,
    strategy_name text, side text, state text, terminal_outcome text, state_version integer,
    updated_at timestamptz, risk_decision_id text, client_order_id text, symbol text, order_type text, time_in_force text, quantity_atoms numeric, notional_limit_micros numeric, limit_price_micros numeric, protection jsonb
  )`
  yield* sql`CREATE TABLE risk_decisions (
    decision_id text PRIMARY KEY, intent_id text, outcome text, decided_at timestamptz, expires_at timestamptz
  )`
  yield* sql`CREATE TABLE mutation_events (
    event_id text PRIMARY KEY, schema_version text, mutation_id text, intent_id text, sequence integer,
    operation text, event_type text, request_hash text, request_body jsonb, consistency_delay_ms integer,
    broker_order_id text, request_id text, response_status integer, response_content_hash text, occurred_at timestamptz, denial_reason text
  )`
  yield* sql`CREATE TABLE orders (intent_id text)`
  yield* sql`CREATE TABLE fills (intent_id text)`
  yield* sql`CREATE FUNCTION execution_account_now(text) RETURNS timestamptz LANGUAGE sql STABLE
    AS 'SELECT ''2026-08-28T14:30:09Z''::timestamptz'`
  yield* sql`INSERT INTO authority_generations VALUES (
    ${expiryFixture.generationHash}, ${accountId}, 'PAPER', ${expiryFixture.policyHash}, 'jev'
  )`
  yield* sql`INSERT INTO authority_state VALUES (
    true, ${expiryFixture.generationHash}, 'PAPER', 'PAPER', 'CLEAR', NULL, 1, ${expiryFixture.createdAt}
  )`
  yield* sql`INSERT INTO autonomous_cycles VALUES (
    ${expiryFixture.cycleId}, 'ACTIVE', ${expiryFixture.decisionHash}, ${expiryFixture.cutoffAt}, NULL
  )`
  yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
    ${expiryFixture.cycleId}, ${expiryFixture.decisionHash},
    ${sql.json({
      schemaVersion: 'bayn.paper-cycle-decision.v2',
      mode: 'PAPER',
      bindings: { authorityGenerationHash: expiryFixture.generationHash },
    })}
  )`
  for (const intentId of expiryFixture.intentIds) {
    yield* sql`INSERT INTO intents VALUES (
      ${intentId}, ${expiryFixture.generationHash}, ${expiryFixture.cycleId}, ${accountId}, ${expiryFixture.policyHash},
      'jev', 'BUY', 'APPROVED', NULL, 1, ${expiryFixture.createdAt}, ${intentId},
      ${'b1_' + 'A'.repeat(43)}, 'AAPL', 'LIMIT', 'DAY', 1000000000, 100000000, 100000000
    )`
    yield* sql`INSERT INTO risk_decisions VALUES (
      ${intentId}, ${intentId}, 'APPROVED', ${expiryFixture.createdAt}, ${expiryFixture.expiresAt}
    )`
  }
})

const settleUntouchedExpiry = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const store = yield* BlockedCycleIntentStore
  const fence = yield* WriterFence
  return yield* fence.transaction(
    Effect.gen(function* () {
      yield* sql`UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_at = ${expiryFixture.expiresAt}
        WHERE cycle_id = ${expiryFixture.cycleId}`
      yield* restrictAuthority(
        sql,
        'execution cycle loop restricted effective authority: expired approval',
        expiryFixture.expiresAt,
      )
      return yield* store.terminalizeUntouchedApproved({
        authorityGenerationHash: expiryFixture.generationHash,
        cycleId: expiryFixture.cycleId,
        observedAt: expiryFixture.expiresAt,
      })
    }),
  )
})

const reserveExpiryIntent = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence
  return yield* makeMutationStartPostgres(sql, fence, makeMutationEventPostgres(sql)).begin(
    MutationOperation.Submit,
    expiryFixture.intentIds[0],
    Result.getOrThrow(
      canonicalHashV1Result(
        Result.getOrThrow(
          orderRequestBody({
            clientOrderId: 'b1_' + 'A'.repeat(43),
            symbol: 'AAPL',
            side: OrderSide.Buy,
            orderType: OrderType.Limit,
            timeInForce: TimeInForce.Day,
            quantityAtoms: '1000000000',
            notionalLimitMicros: '100000000',
            limitPriceMicros: '100000000',
          }),
        ),
      ),
    ),
    1_000,
    expiryFixture.reservedAt,
  )
})

const readExpiryState = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    intents: yield* sql`SELECT * FROM intents ORDER BY intent_id`,
    cycles: yield* sql`SELECT * FROM autonomous_cycles`,
    authority: yield* sql`SELECT * FROM authority_state`,
    events: yield* sql`SELECT count(*)::integer AS count FROM mutation_events`,
    mutationRows: yield* sql`SELECT * FROM mutation_events ORDER BY event_id`,
    orders: yield* sql`SELECT * FROM orders`,
    fills: yield* sql`SELECT * FROM fills`,
  }
})

describePostgres('PostgreSQL untouched approval expiry safety', () => {
  let owner: ReturnType<typeof makeExpiryRuntime>
  let contender: ReturnType<typeof makeExpiryRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    owner = makeExpiryRuntime()
    contender = makeExpiryRuntime()
  })
  beforeEach(async () => {
    await owner.runPromise(seedUntouchedExpiry)
  })
  afterAll(async () => {
    await owner?.dispose()
    await contender?.dispose()
  })

  test('atomically retains a decoded denial reason and rejects conflicting database replay', async () => {
    const { event: started } = await owner.runPromise(reserveExpiryIntent)
    const deny = (denialReason: SubmissionDenialReason) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        return yield* makeMutationOutcomePostgres(sql, fence, makeMutationEventPostgres(sql)).appendOutcome(
          { _tag: 'SubmitDenied' },
          started.intentId,
          started.requestHash,
          expiryFixture.expiresAt,
          undefined,
          undefined,
          denialReason,
        )
      })
    const denied = await owner.runPromise(deny(SubmissionDenialReason.ExpiredRiskDecision))
    expect(denied.denialReason).toBe(SubmissionDenialReason.ExpiredRiskDecision)
    const first = await owner.runPromise(readExpiryState)
    expect(first.intents[0]).toMatchObject({ state: 'TERMINAL', terminal_outcome: 'REJECTED', state_version: 3 })
    expect(first.events).toEqual([{ count: 2 }])
    expect(first.mutationRows.find((row) => row['event_type'] === 'SUBMIT_DENIED')).toMatchObject({
      event_id: denied.eventId,
      denial_reason: SubmissionDenialReason.ExpiredRiskDecision,
    })
    const { eventId, ...material } = denied
    expect(eventId).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
    expect(first.orders).toEqual([])
    expect(first.fills).toEqual([])
    expect(await contender.runPromise(deny(SubmissionDenialReason.ExpiredRiskDecision))).toEqual(denied)
    expect(
      await contender.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* makeMutationEventPostgres(sql).latest(started.intentId, MutationOperation.Submit)
        }),
      ),
    ).toEqual(denied)
    expect(
      Result.isFailure(
        await contender.runPromise(deny(SubmissionDenialReason.ExecutionWindowExpired).pipe(Effect.result)),
      ),
    ).toBe(true)
    expect(await owner.runPromise(readExpiryState)).toEqual(first)
  })

  test('rolls a denial and its reason back when the terminal intent transition fails', async () => {
    const { event: started } = await owner.runPromise(reserveExpiryIntent)
    await owner.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE FUNCTION reject_test_terminal_transition() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'synthetic terminal transition failure'; END $body$`
        yield* sql`CREATE TRIGGER reject_test_terminal_transition BEFORE UPDATE ON intents
        FOR EACH ROW WHEN (NEW.state = 'TERMINAL') EXECUTE FUNCTION reject_test_terminal_transition()`
      }),
    )
    const before = await owner.runPromise(readExpiryState)
    const result = await owner.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        return yield* makeMutationOutcomePostgres(sql, fence, makeMutationEventPostgres(sql)).appendOutcome(
          { _tag: 'SubmitDenied' },
          started.intentId,
          started.requestHash,
          expiryFixture.expiresAt,
          undefined,
          undefined,
          SubmissionDenialReason.ExpiredRiskDecision,
        )
      }).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(await owner.runPromise(readExpiryState)).toEqual(before)
  })

  test('expires untouched approvals exactly once without order I/O and preserves manual holds', async () => {
    await owner.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = 'operator kill switch', version = 2`
      }),
    )
    expect(await owner.runPromise(settleUntouchedExpiry)).toEqual({
      blockedIntentCount: 0,
      expiredIntentCount: 2,
      terminalIntentCount: 2,
    })
    const first = await owner.runPromise(readExpiryState)
    expect(first).toMatchObject({
      intents: expiryFixture.intentIds.map(() => ({
        state: 'TERMINAL',
        terminal_outcome: 'EXPIRED',
        state_version: 2,
      })),
      cycles: [{ state: 'BLOCKED' }],
      authority: [{ effective: 'OBSERVE', kill_state: 'ACTIVE', reason: 'operator kill switch', version: 2 }],
      events: [{ count: 0 }],
    })
    expect(await contender.runPromise(settleUntouchedExpiry)).toEqual({
      blockedIntentCount: 0,
      expiredIntentCount: 0,
      terminalIntentCount: 2,
    })
    expect(await owner.runPromise(readExpiryState)).toEqual(first)
  })

  test.each(['mutation', 'order', 'fill', 'started-state'] as const)(
    'rolls back the entire cleanup when %s evidence appears after selection',
    async (evidence) => {
      await owner.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const intentId = expiryFixture.intentIds[1]
          if (evidence === 'mutation')
            yield* sql`INSERT INTO mutation_events(event_id, intent_id) VALUES (${intentId}, ${intentId})`
          if (evidence === 'order') yield* sql`INSERT INTO orders VALUES (${intentId})`
          if (evidence === 'fill') yield* sql`INSERT INTO fills VALUES (${intentId})`
          if (evidence === 'started-state')
            yield* sql`UPDATE intents SET state = 'IO_STARTED' WHERE intent_id = ${intentId}`
        }),
      )
      const before = await owner.runPromise(readExpiryState)
      const result = await owner.runPromise(Effect.result(settleUntouchedExpiry))
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'BlockedCycleIntentStoreError', failure: 'invariant' },
      })
      expect(await owner.runPromise(readExpiryState)).toEqual(before)
    },
  )

  test.each(['reservation', 'expiry'] as const)(
    'fences a competing %s transaction and rechecks durable state on retry',
    async (winner) => {
      type FixtureOperation = Effect.Effect<
        void,
        Effect.Error<typeof reserveExpiryIntent> | Effect.Error<typeof settleUntouchedExpiry>,
        PgClient.PgClient | WriterFence | BlockedCycleIntentStore
      >
      const first: FixtureOperation =
        winner === 'reservation' ? reserveExpiryIntent.pipe(Effect.asVoid) : settleUntouchedExpiry.pipe(Effect.asVoid)
      const second: FixtureOperation =
        winner === 'reservation' ? settleUntouchedExpiry.pipe(Effect.asVoid) : reserveExpiryIntent.pipe(Effect.asVoid)
      const competing = await owner.runPromise(
        Effect.gen(function* () {
          const fence = yield* WriterFence
          const held = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const holding = yield* fence
            .transaction(
              first.pipe(Effect.andThen(Deferred.succeed(held, undefined)), Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild({ startImmediately: true }))
          return yield* Deferred.await(held).pipe(
            Effect.raceFirst(Fiber.join(holding)),
            Effect.andThen(Effect.promise((signal) => contender.runPromise(Effect.result(second), { signal }))),
            Effect.ensuring(Deferred.succeed(release, undefined)),
            Effect.tap(() => Fiber.join(holding)),
            Effect.ensuring(Fiber.interrupt(holding)),
          )
        }),
      )
      expect(competing).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'WriterFenceError', failure: 'busy' },
      })
      const before = await owner.runPromise(readExpiryState)
      expect(Result.isFailure(await contender.runPromise(Effect.result(second)))).toBe(true)
      expect(await owner.runPromise(readExpiryState)).toEqual(before)
      expect(before.events).toEqual([{ count: winner === 'reservation' ? 1 : 0 }])
      expect(before.intents).toMatchObject(
        winner === 'reservation'
          ? [
              { state: 'IO_STARTED', terminal_outcome: null, state_version: 2 },
              { state: 'APPROVED', terminal_outcome: null, state_version: 1 },
            ]
          : expiryFixture.intentIds.map(() => ({ state: 'TERMINAL', terminal_outcome: 'EXPIRED', state_version: 2 })),
      )
    },
  )
})
