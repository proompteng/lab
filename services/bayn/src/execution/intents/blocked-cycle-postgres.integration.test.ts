import { makeAuthorityPostgres } from '../../db/execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from '../../db/execution-store/observe-authority'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Fiber, Layer, ManagedRuntime, Option, Redacted, Result, Schema } from 'effect'

import { recoverPreopenAuthorityCycle } from '../../../migrations/0057_recover_preopen_authority_cycle'
import { recoverIntradayAuthorityCycle } from '../../../migrations/0071_recover_intraday_authority_cycle'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../../broker/identity'
import {
  CycleState,
  CycleTerminalReason,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from '../../cycle'
import { CycleStore, CycleStoreLive } from '../../cycle/store'
import { Authority, KillState } from '../../execution/contracts'
import { PostgresClientLive } from '../../db/postgres-client'
import { postgresMigrations } from '../../db/postgres-migrations'
import { canonicalHashV1 } from '../../hash'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import {
  defaultIntradayMomentumProtocolDocument,
  intradayMomentumExecutionModel,
} from '../../strategy/intraday-momentum/protocol'
import { BlockedCycleIntentStore } from './blocked-cycle'
import { BlockedCycleIntentStoreLive } from './blocked-cycle-postgres'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
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
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
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
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: planHash,
      strategyProtocolHash: canonicalHashV1({ strategy: 'intraday-momentum', version: 2 }),
      accountId,
      executionSessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy: sessionPolicy,
    }),
  )
  const cycle = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, sessionPolicy))))
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
        ${defaultIntradayMomentumProtocolDocument.schemaVersion}, ${fixture.cycle.identity.strategyProtocolHash}, ${accountId},
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

  test('reads and locks capital authority persisted with the active intraday protocol', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* seedExecutionAuthority(sql, makeFixture())
        const authority = makeAuthorityPostgres(sql)
        const rows = yield* authority.readGeneration(canonicalHashV1({ generation: 'execution' }))
        const locked = yield* sql.withTransaction(authority.lockCapitalGrant(accountId))
        return { rows, locked }
      }),
    )
    expect(result.rows[0]?.strategy_parameter_schema_version).toBe('bayn.intraday-momentum.protocol.v3')
    expect(result.locked.history.strategy_parameter_schema_version).toBe('bayn.intraday-momentum.protocol.v3')
    expect(result.locked.current.generationHash).toBe(result.rows[0]?.generation_hash)
  })

  test('recovers a generation restricted before its first cycle only after fresh exact reconciliation', async () => {
    const fixture = makeFixture(true)
    const successorHash = canonicalHashV1({ generation: 'unused-successor' })
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
          authorityGenerationHash: canonicalHashV1({ generation: 'execution' }),
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
          generationHash: canonicalHashV1({ generation: 'execution' }),
          effective: Authority.Observe,
          kill: KillState.Active,
        })

        const exactHash = canonicalHashV1({ reconciliation: 'unused-generation-exact' })
        yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
          content_hash, status, discrepancies, reconciled_at
        ) VALUES (
          ${canonicalHashV1({ reconciliation: 'unused-generation' })}, 'bayn.paper-reconciliation.v1',
          ${accountId}, ${exactHash}, ${exactHash}, ${exactHash},
          'EXACT', ${sql.json(encodeSqlJson([]))}, ${fixture.reconciledAt}
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

  test.each(['settled', 'stale', 'position', 'unresolved', 'operator'] as const)(
    'recovers restricted OBSERVE after historical trading only with settled fresh evidence: %s',
    async (scenario) => {
      const fixture = makeFixture(true)
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* seedExecutionAuthority(sql, fixture)
          const executionHash = canonicalHashV1({ generation: 'execution' })
          const intentId = canonicalHashV1({ intent: 'prior-trade' })
          const riskId = canonicalHashV1({ risk: 'prior-trade' })
          const mutationId = canonicalHashV1({ mutation: 'prior-trade' })
          const occurredAt = instant(Date.parse(fixture.generationActivatedAt) + 1_000)
          yield* sql`INSERT INTO intents (
          intent_id, schema_version, authority_generation_hash, risk_decision_id, strategy_name, cycle_id,
          decision_hash, policy_hash, account_id, client_order_id, symbol, side, order_type, time_in_force,
          quantity_micros, notional_limit_micros, state, state_version, created_at, updated_at
        ) VALUES (
          ${intentId}, 'bayn.paper-intent.v3', ${executionHash}, NULL, 'intraday-momentum',
          ${fixture.cycle.identity.cycleId}, ${'0'.repeat(64)}, ${'7'.repeat(64)}, ${accountId}, 'prior-trade',
          'AAPL', 'BUY', 'LIMIT', 'IOC', 1000000, 1000000000, 'PLANNED', 1, ${occurredAt}, ${occurredAt}
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
          ${canonicalHashV1({ event: 1 })}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 1,
          'SUBMIT', 'SUBMIT_STARTED', ${'8'.repeat(64)}, 1000, ${occurredAt}
        )`
          yield* sql`INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
          request_hash, consistency_delay_ms, broker_order_id, request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${canonicalHashV1({ event: 2 })}, 'bayn.paper-mutation-event.v1', ${mutationId}, ${intentId}, 2,
          'SUBMIT', 'SUBMIT_ACCEPTED', ${'8'.repeat(64)}, 1000, 'prior-order', 'prior-request', 200, ${'9'.repeat(64)}, ${occurredAt}
        )`
          yield* sql`UPDATE intents SET state = 'ACKNOWLEDGED', state_version = 4, updated_at = updated_at + interval '1 millisecond' WHERE intent_id = ${intentId}`
          yield* sql`UPDATE intents SET state = 'TERMINAL', terminal_outcome = 'CANCELED', state_version = 5, updated_at = updated_at + interval '1 millisecond'
          WHERE intent_id = ${intentId}`
          yield* sql`INSERT INTO position_snapshots (
          snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
        ) VALUES (
          ${canonicalHashV1({ snapshot: 'prior-flat' })}, 'bayn.paper-position-snapshot.v1', ${accountId},
          ${'a'.repeat(64)}, ${fixture.positionsObservedAt}, 0, ${'a'.repeat(64)}
        )`
          yield* sql`INSERT INTO reconciliations (
          reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash,
          status, discrepancies, reconciled_at
        ) VALUES (
          ${canonicalHashV1({ reconciliation: 'prior-flat' })}, 'bayn.paper-reconciliation.v1', ${accountId},
          ${'a'.repeat(64)}, ${'a'.repeat(64)}, ${'a'.repeat(64)}, 'EXACT', '[]'::jsonb, ${fixture.reconciledAt}
        )`
          const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
          const successor = yield* authority.ensureAuthorityGeneration({
            generationHash: canonicalHashV1({ generation: 'settled-observe' }),
            maximum: Authority.Observe,
          })
          expect(successor.kill).toBe(KillState.Clear)
          yield* sql`UPDATE authority_state SET kill_state = 'ACTIVE', effective = 'OBSERVE',
          reason = ${scenario === 'operator' ? 'operator hold' : 'reconciliation pass incomplete'},
          version = version + 1, updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
          WHERE singleton`
          if (scenario === 'position') {
            yield* sql`INSERT INTO position_snapshots (
            snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
          ) VALUES (
            ${canonicalHashV1({ snapshot: 'still-held' })}, 'bayn.paper-position-snapshot.v1', ${accountId},
            ${'b'.repeat(64)}, clock_timestamp(), 1, ${'b'.repeat(64)}
          )`
          }
          if (scenario === 'unresolved') {
            yield* sql`INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
            request_hash, consistency_delay_ms, broker_order_id, occurred_at
          ) VALUES (
            ${canonicalHashV1({ event: 3 })}, 'bayn.paper-mutation-event.v1',
            ${canonicalHashV1({ mutation: 'unknown' })}, ${intentId}, 1,
            'CANCEL', 'CANCEL_STARTED', ${'8'.repeat(64)}, 1000, 'prior-order', clock_timestamp()
          )`
          }
          if (scenario !== 'stale') {
            if (scenario !== 'position') {
              yield* sql`INSERT INTO position_snapshots (
              snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
            ) VALUES (
              ${canonicalHashV1({ snapshot: 'after-restriction' })}, 'bayn.paper-position-snapshot.v1', ${accountId},
              ${'c'.repeat(64)}, clock_timestamp(), 0, ${'c'.repeat(64)}
            )`
            }
            yield* sql`INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash,
            status, discrepancies, reconciled_at
          ) VALUES (
            ${canonicalHashV1({ reconciliation: 'after-restriction' })}, 'bayn.paper-reconciliation.v1', ${accountId},
            ${'b'.repeat(64)}, ${'b'.repeat(64)}, ${'b'.repeat(64)}, 'EXACT', '[]'::jsonb, clock_timestamp()
          )`
          }
          const recovered = yield* authority.ensureAuthorityGeneration({
            generationHash: canonicalHashV1({ generation: 'recovered-observe' }),
            maximum: Authority.Observe,
          })
          expect(recovered.kill).toBe(scenario === 'settled' ? KillState.Clear : KillState.Active)
          expect(recovered.effective).toBe(Authority.Observe)
          expect(yield* sql`SELECT count(*)::integer AS count FROM mutation_events`).toEqual([
            { count: scenario === 'unresolved' ? 3 : 2 },
          ])
          expect(
            yield* sql`SELECT observe_recovery_account_settled(
              ${canonicalHashV1({ generation: 'observe' })}, ${accountId}, ${fixture.reconciledAt}
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

  test.each(['before', 'after'] as const)(
    'preserves an untouched same-plan cycle created %s the restriction',
    async (timing) => {
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

  test('rotates a failed generation with an untouched open-session cycle before cutoff', async () => {
    const fixture = makeFixture(true)
    const successorHash = canonicalHashV1({ generation: 'open-session-successor' })
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
        const settlement = yield* blocked.settleCurrentTerminalGeneration({
          accountId,
          observedAt: fixture.reconciledAt,
        })
        if (settlement._tag !== 'TerminalGenerationSettled') return yield* Effect.die('expected settlement')
        const preserveCyclePlanHash = settlement.preserveCyclePlanHash
        if (preserveCyclePlanHash === undefined) return yield* Effect.die('expected preserved cycle')
        const exactHash = canonicalHashV1({ reconciliation: 'post-settlement-exact' })
        const reconciledAt = instant(Date.parse(fixture.reconciledAt) + 1_000)
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${canonicalHashV1({ reconciliation: 'post-settlement' })}, 'bayn.paper-reconciliation.v1',
            ${accountId}, ${exactHash}, ${exactHash},
            ${canonicalHashV1({ reconciliation: 'post-settlement-content' })},
            'EXACT', ${sql.json(encodeSqlJson([]))}, ${reconciledAt}
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

  test('concurrent repairs reopen an untouched session once and leave its lifecycle trigger enabled', async () => {
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
    expect(Option.getOrThrow(result.first).state).toBe(CycleState.Active)
    expect(Option.getOrThrow(result.first).stateVersion).toBe(Option.getOrThrow(result.before).stateVersion + 1)
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

  test('repairs one clear, flat, reconciled cycle that was blocked by authority before its window', async () => {
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
    expect(repaired.state).toBe(CycleState.Active)
    expect(repaired.terminalReason).toBeUndefined()
    expect(repaired.terminalAt).toBeUndefined()
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
