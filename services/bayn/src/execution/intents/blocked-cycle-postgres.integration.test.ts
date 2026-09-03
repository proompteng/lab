import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'

import { recoverPreopenAuthorityCycle } from '../../../migrations/0057_recover_preopen_authority_cycle'
import {
  CycleState,
  CycleTerminalReason,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from '../../cycle'
import { CycleStore, CycleStoreLive } from '../../cycle/store'
import { PostgresClientLive } from '../../db/postgres-client'
import { postgresMigrations } from '../../db/postgres-migrations'
import { canonicalHashV1 } from '../../hash'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import { intradayMomentumExecutionModel } from '../../strategy/intraday-momentum/protocol'
import { BlockedCycleIntentStore } from './blocked-cycle'
import { BlockedCycleIntentStoreLive } from './blocked-cycle-postgres'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const accountId = 'preopen-authority-recovery-test'
const planHash = '1'.repeat(64)
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

const makeFixture = () => {
  const now = Date.now()
  const session = new Date(now + 24 * 60 * 60_000)
  const executionSessionDate = session.toISOString().slice(0, 10)
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: executionSessionDate,
      openAt: `${executionSessionDate}T13:30:00.000Z`,
      closeAt: `${executionSessionDate}T20:00:00.000Z`,
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: planHash,
      strategyProtocolHash: canonicalHashV1({ strategy: 'intraday-momentum', version: 2 }),
      accountId,
      executionSessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const cycle = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, executionPolicy))))
  if (!isIntradayCycleDraft(cycle)) throw new Error('expected an intraday cycle')
  return {
    cycle,
    generationActivatedAt: instant(now - 5 * 60_000),
    acquiredAt: instant(now - 4 * 60_000),
    cycleActivatedAt: instant(now - 3 * 60_000),
    restrictedAt: instant(now - 2 * 60_000),
    reconciledAt: instant(now - 60_000),
    positionsObservedAt: instant(now - 90_000),
  }
}

const seedExecutionAuthority = (sql: PgClient.PgClient, fixture: ReturnType<typeof makeFixture>) => {
  const observeGenerationHash = canonicalHashV1({ generation: 'observe' })
  const executionGenerationHash = canonicalHashV1({ generation: 'execution' })
  const reconciliationId = canonicalHashV1({ reconciliation: 'activation' })
  const reconciliationHash = canonicalHashV1({ reconciliation: 'activation-content' })
  const stateHash = canonicalHashV1({ state: 'flat' })
  const observeActivatedAt = instant(Date.parse(fixture.generationActivatedAt) - 2_000)
  const activationReconciledAt = instant(Date.parse(fixture.generationActivatedAt) - 1_000)
  return Effect.gen(function* () {
    yield* sql`
      INSERT INTO reconciliations (
        reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
        content_hash, status, discrepancies, reconciled_at
      ) VALUES (
        ${reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId}, ${stateHash}, ${stateHash},
        ${reconciliationHash}, 'EXACT', ${sql.json(encodeSqlJson([]))}, ${activationReconciledAt}
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
        'intraday-momentum', ${'4'.repeat(64)}, ${'5'.repeat(64)},
        'bayn.intraday-momentum.protocol.v2', ${fixture.cycle.identity.strategyProtocolHash}, ${accountId},
        'bayn.broker-identity.v2', ${'6'.repeat(64)}, 'alpaca', 'sandbox', ${'7'.repeat(64)},
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

describePostgres('PostgreSQL preopen authority recovery', () => {
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

  test('settles a restricted generation without destroying its untouched same-plan cycle', async () => {
    const fixture = makeFixture()
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
            reason = 'execution cycle loop restricted effective authority: source rollover',
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
      authorityGenerationHash: canonicalHashV1({ generation: 'execution' }),
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
  })

  test('repairs one clear, flat, reconciled cycle that was blocked by authority before its window', async () => {
    const fixture = makeFixture()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* cycles.block(fixture.cycle.identity.cycleId, CycleTerminalReason.Authority, fixture.restrictedAt)
        yield* sql`
          INSERT INTO position_snapshots (
            snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
          ) VALUES (
            ${canonicalHashV1({ positions: 'flat' })}, 'bayn.paper-position-snapshot.v1', ${accountId},
            ${canonicalHashV1({ positions: 'source' })}, ${fixture.positionsObservedAt}, 0,
            ${canonicalHashV1({ positions: 'content' })}
          )
        `
        const exactHash = canonicalHashV1({ reconciliation: 'current-flat' })
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${canonicalHashV1({ reconciliation: 'current' })}, 'bayn.paper-reconciliation.v1',
            ${accountId}, ${exactHash}, ${exactHash}, ${canonicalHashV1({ reconciliation: 'current-content' })},
            'EXACT', ${sql.json(encodeSqlJson([]))}, ${fixture.reconciledAt}
          )
        `
        yield* recoverPreopenAuthorityCycle
        const repaired = yield* cycles.read(fixture.cycle.identity.cycleId)
        yield* recoverPreopenAuthorityCycle
        return { repaired, replayed: yield* cycles.read(fixture.cycle.identity.cycleId) }
      }),
    )

    const repaired = Option.getOrThrow(result.repaired)
    expect(repaired.state).toBe(CycleState.Active)
    expect(repaired.terminalReason).toBeUndefined()
    expect(repaired.terminalAt).toBeUndefined()
    expect(result.replayed).toEqual(result.repaired)
  })

  test('keeps blocked history when no fresh flat reconciliation proves repair is safe', async () => {
    const fixture = makeFixture()
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const cycles = yield* CycleStore
        yield* seedExecutionAuthority(sql, fixture)
        yield* cycles.acquire(fixture.cycle, fixture.acquiredAt)
        yield* cycles.activate(fixture.cycle.identity.cycleId, fixture.cycleActivatedAt)
        yield* cycles.block(fixture.cycle.identity.cycleId, CycleTerminalReason.Authority, fixture.restrictedAt)
        yield* recoverPreopenAuthorityCycle
        return yield* cycles.read(fixture.cycle.identity.cycleId)
      }),
    )

    const blocked = Option.getOrThrow(stored)
    expect(blocked.state).toBe(CycleState.Blocked)
    expect(blocked.terminalReason).toBe(CycleTerminalReason.Authority)
  })
})
