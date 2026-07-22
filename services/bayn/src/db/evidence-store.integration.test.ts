import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { canonicalHashV1 } from '../hash'
import { buildLedgerPlan } from '../ledger'
import { makeQualificationResult } from '../qualification'
import { evaluateRiskBalancedTrend } from '../risk-balanced-trend'
import { makeStrategy } from '../strategy-service'
import { makeSnapshot, makeTestProvenance, fixtureProtocol } from '../test-fixtures'
import type { Protocol } from '../types'
import {
  DatabaseError,
  EvidenceStore,
  EvidenceStoreLive,
  PostgresClientLive,
  type PersistEvaluationInput,
} from './evidence-store'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe

const makeConfig = (url = testUrl): RuntimeConfig => ({
  host: '127.0.0.1',
  port: 8080,
  build: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: 'c'.repeat(64),
    strategyParameterHash: 'd'.repeat(64),
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: 5_000,
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-07-17',
    calendarVersion: 'fixture-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2018-01-02',
      dataEnd: '2026-07-17',
      lookbackStart: '2018-01-02',
      evaluationStart: '2019-01-02',
      evaluationEnd: '2026-07-17',
    },
  },
  postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7_001 },
})

const makeEvidenceRuntime = (config = makeConfig()) =>
  ManagedRuntime.make(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))

const makeClientRuntime = (config = makeConfig()) =>
  ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer)))

const riskBalancedTrendSnapshot = makeSnapshot(800)

const makeInput = (
  sourceRevision = 'a'.repeat(40),
  behaviorHash = 'd'.repeat(64),
  protocol: Protocol = fixtureProtocol,
): PersistEvaluationInput => {
  const provenance = makeTestProvenance(protocol, { sourceRevision, behaviorHash })
  const evaluation = evaluateRiskBalancedTrend(
    riskBalancedTrendSnapshot.bars,
    riskBalancedTrendSnapshot.manifest,
    protocol,
    provenance,
  )
  const ledger = buildLedgerPlan(evaluation, 7_001)
  return {
    provenance,
    parameters: protocol,
    evaluation,
    reconciliation: {
      runId: evaluation.runId,
      accountCount: ledger.accounts.length,
      transferCount: ledger.transfers.length,
      exact: true,
    },
  }
}

const makeLockedInput = (input: PersistEvaluationInput, priorTrialRunIds: readonly string[] = []) => {
  const strategy = makeStrategy(fixtureProtocol, input.provenance)
  const sessionDates = [...new Set(riskBalancedTrendSnapshot.bars.map((bar) => bar.sessionDate))].sort()
  const lock = strategy.prepareLock(input.evaluation.inputManifest, sessionDates, priorTrialRunIds)
  const result = makeQualificationResult(
    lock,
    input.evaluation.verdict,
    strategy.analyze(input.evaluation, priorTrialRunIds),
  )
  return {
    open: {
      lock,
      inputManifest: input.evaluation.inputManifest,
      parameters: input.parameters,
      provenance: input.provenance,
    },
    persist: { ...input, qualification: { lock, result } },
    lock,
    result,
  }
}

describePostgres('PostgreSQL evaluation evidence', () => {
  let runtime: ReturnType<typeof makeEvidenceRuntime>

  beforeAll(async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
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
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('migrates the complete evidence schema', async () => {
    const schema = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const tables = yield* sql<{ table_name: string }>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `
        const migrations = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM schema_migrations ORDER BY migration_id
        `
        return { tables, migrations }
      }),
    )

    expect(schema.tables.map((row) => row.table_name)).toEqual([
      'account_snapshots',
      'accounting_receipts',
      'authority_state',
      'broker_errors',
      'broker_events',
      'evaluation_artifacts',
      'evaluation_events',
      'evaluation_runs',
      'fills',
      'gate_outcomes',
      'intents',
      'orders',
      'positions',
      'protocol_locks',
      'qualification_locks',
      'qualification_results',
      'qualification_trials',
      'rate_limits',
      'reconciliations',
      'risk_decisions',
      'schema_migrations',
      'snapshot_references',
      'status_history',
      'valuations',
    ])
    expect(schema.migrations).toEqual([
      { migration_id: 1, name: 'initial_schema' },
      { migration_id: 2, name: 'paper_contracts' },
      { migration_id: 3, name: 'intent_risk_clock' },
    ])
  })

  test('requires one typed append-only payload and unique broker source ordering', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const insertAccount = (eventId: string, sourceEventId: string, sourceSequence: string, cash = '1000000') =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO broker_events (
                  event_id, schema_version, content_hash, event_kind, broker, account_id,
                  source_event_id, source_sequence, occurred_at, observed_at
                ) VALUES (
                  ${eventId}, 'bayn.paper-broker-event.v1', ${'f'.repeat(64)}, 'ACCOUNT', 'ALPACA',
                  'paper-account-1', ${sourceEventId}, ${sourceSequence},
                  '2026-07-22T06:00:00.000Z', '2026-07-22T06:01:00.000Z'
                )
              `
              yield* sql`
                INSERT INTO account_snapshots (
                  event_id, account_id, schema_version, status, currency,
                  cash_micros, equity_micros, buying_power_micros
                ) VALUES (
                  ${eventId}, 'paper-account-1', 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD',
                  ${cash}, 1000000, 2000000
                )
              `
            }),
          )
        const insertOrder = (
          eventId: string,
          sourceEventId: string,
          sourceSequence: string,
          status: 'NEW' | 'FILLED',
          filledQuantity: string,
        ) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO broker_events (
                  event_id, schema_version, content_hash, event_kind, broker, account_id,
                  source_event_id, source_sequence, occurred_at, observed_at
                ) VALUES (
                  ${eventId}, 'bayn.paper-broker-event.v1', ${'d'.repeat(64)}, 'ORDER', 'ALPACA',
                  'paper-account-1', ${sourceEventId}, ${sourceSequence},
                  '2026-07-22T06:00:00.000Z', '2026-07-22T06:01:00.000Z'
                )
              `
              yield* sql`
                INSERT INTO orders (
                  event_id, account_id, schema_version, broker_order_id, client_order_id, symbol,
                  side, order_type, time_in_force, quantity_micros, filled_quantity_micros, status
                ) VALUES (
                  ${eventId}, 'paper-account-1', 'bayn.paper-order.v1', 'broker-order-1',
                  'client-order-1', 'NVDA', 'BUY', 'MARKET', 'DAY', 1000000, ${filledQuantity}, ${status}
                )
              `
            }),
          )

        yield* insertAccount('1'.repeat(64), 'source-1', '1')
        const duplicateSource = yield* Effect.exit(insertAccount('2'.repeat(64), 'source-1', '2'))
        const duplicateSequence = yield* Effect.exit(insertAccount('3'.repeat(64), 'source-3', '1'))
        const overflow = yield* Effect.exit(
          insertAccount('4'.repeat(64), 'source-4', '4', '170141183460469231731687303715884105728'),
        )
        const missingPayload = yield* Effect.exit(
          sql.withTransaction(
            sql`
              INSERT INTO broker_events (
                event_id, schema_version, content_hash, event_kind, broker, account_id,
                source_event_id, source_sequence, occurred_at, observed_at
              ) VALUES (
                ${'5'.repeat(64)}, 'bayn.paper-broker-event.v1', ${'e'.repeat(64)}, 'FILL', 'ALPACA',
                'paper-account-1', 'source-5', 5,
                '2026-07-22T06:00:00.000Z', '2026-07-22T06:01:00.000Z'
              )
            `,
          ),
        )
        yield* insertOrder('6'.repeat(64), 'source-6', '2', 'NEW', '0')
        yield* insertOrder('7'.repeat(64), 'source-7', '3', 'FILLED', '1000000')
        const inconsistentFill = yield* Effect.exit(insertOrder('8'.repeat(64), 'source-8', '4', 'FILLED', '0'))
        const update = yield* Effect.exit(sql`
          UPDATE account_snapshots SET cash_micros = 2 WHERE event_id = ${'1'.repeat(64)}
        `)
        const deletion = yield* Effect.exit(sql`
          DELETE FROM broker_events WHERE event_id = ${'1'.repeat(64)}
        `)
        const counts = yield* sql<{ events: number; accounts: number; orders: number }>`
          SELECT
            (SELECT count(*)::integer FROM broker_events) AS events,
            (SELECT count(*)::integer FROM account_snapshots) AS accounts,
            (SELECT count(*)::integer FROM orders) AS orders
        `
        return {
          duplicateSequence,
          duplicateSource,
          overflow,
          missingPayload,
          inconsistentFill,
          update,
          deletion,
          counts: counts[0],
        }
      }),
    )

    expect(Exit.isFailure(result.duplicateSource)).toBe(true)
    expect(Exit.isFailure(result.duplicateSequence)).toBe(true)
    expect(Exit.isFailure(result.overflow)).toBe(true)
    expect(Exit.isFailure(result.missingPayload)).toBe(true)
    expect(Exit.isFailure(result.inconsistentFill)).toBe(true)
    expect(Exit.isFailure(result.update)).toBe(true)
    expect(Exit.isFailure(result.deletion)).toBe(true)
    expect(result.counts).toEqual({ events: 3, accounts: 1, orders: 2 })
  })

  test('enforces intent transitions, risk binding, and immutable decisions', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const intentId = '1'.repeat(64)
        const decisionId = '2'.repeat(64)
        yield* sql`
          INSERT INTO intents (
            intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
            time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at
          ) VALUES (
            ${intentId}, 'bayn.paper-intent.v1', 'paper-account-1', 'client-order-1', 'NVDA', 'BUY',
            'MARKET', 'DAY', 1000000, 200000000, 'PLANNED',
            '2026-07-22T06:00:00.000Z', '2026-07-22T06:00:00.000Z'
          )
        `
        const invalidInitial = yield* Effect.exit(sql`
          INSERT INTO intents (
            intent_id, schema_version, risk_decision_id, account_id, client_order_id, symbol, side,
            order_type, time_in_force, quantity_micros, notional_limit_micros, state,
            created_at, updated_at
          ) VALUES (
            ${'3'.repeat(64)}, 'bayn.paper-intent.v1', ${'4'.repeat(64)}, 'paper-account-1',
            'client-order-2', 'NVDA', 'BUY', 'MARKET', 'DAY', 1000000, 200000000, 'APPROVED',
            '2026-07-22T06:00:00.000Z', '2026-07-22T06:00:00.000Z'
          )
        `)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO risk_decisions (
                decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                reason_codes, decided_at, expires_at
              ) VALUES (
                ${decisionId}, 'bayn.paper-risk-decision.v1', ${'5'.repeat(64)}, ${intentId},
                ${'6'.repeat(64)}, 'APPROVED', ARRAY[]::text[],
                '2026-07-22T06:00:30.000Z', '2099-01-01T00:00:00.000Z'
              )
            `
            yield* sql`
              UPDATE intents
              SET state = 'APPROVED', risk_decision_id = ${decisionId}, state_version = 2,
                  updated_at = '2026-07-22T06:00:30.000Z'
              WHERE intent_id = ${intentId}
            `
          }),
        )
        const skipState = yield* Effect.exit(sql`
          UPDATE intents
          SET state = 'ACKNOWLEDGED', state_version = 3, updated_at = '2026-07-22T06:00:40.000Z'
          WHERE intent_id = ${intentId}
        `)
        const changeIdentity = yield* Effect.exit(sql`
          UPDATE intents
          SET state = 'IO_STARTED', symbol = 'AMD', state_version = 3,
              updated_at = '2026-07-22T06:00:40.000Z'
          WHERE intent_id = ${intentId}
        `)
        const expiredIo = yield* Effect.exit(sql`
          UPDATE intents
          SET state = 'IO_STARTED', state_version = 3, updated_at = '2099-01-01T00:00:00.000Z'
          WHERE intent_id = ${intentId}
        `)
        const staleIntentId = '4'.repeat(64)
        const staleDecisionId = '3'.repeat(64)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO intents (
                intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
                time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at
              ) VALUES (
                ${staleIntentId}, 'bayn.paper-intent.v1', 'paper-account-1', 'client-order-stale',
                'NVDA', 'BUY', 'MARKET', 'DAY', 1000000, 200000000, 'PLANNED',
                statement_timestamp() - interval '1 minute', statement_timestamp() - interval '1 minute'
              )
            `
            yield* sql`
              INSERT INTO risk_decisions (
                decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                reason_codes, decided_at, expires_at
              ) VALUES (
                ${staleDecisionId}, 'bayn.paper-risk-decision.v1', ${'4'.repeat(64)}, ${staleIntentId},
                ${'3'.repeat(64)}, 'APPROVED', ARRAY[]::text[],
                statement_timestamp(), statement_timestamp() + interval '500 milliseconds'
              )
            `
            yield* sql`
              UPDATE intents
              SET state = 'APPROVED', risk_decision_id = ${staleDecisionId}, state_version = 2,
                  updated_at = statement_timestamp()
              WHERE intent_id = ${staleIntentId}
            `
          }),
        )
        yield* sql`
          SELECT pg_sleep_until(expires_at + interval '10 milliseconds')
          FROM risk_decisions
          WHERE decision_id = ${staleDecisionId}
        `
        const backdatedExpiredIo = yield* Effect.exit(sql`
          UPDATE intents
          SET state = 'IO_STARTED', state_version = 3,
              updated_at = (
                SELECT expires_at - interval '1 microsecond'
                FROM risk_decisions
                WHERE decision_id = ${staleDecisionId}
              )
          WHERE intent_id = ${staleIntentId}
        `)
        const blockedApproval = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO intents (
                  intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
                  time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at
                ) VALUES (
                  ${'b'.repeat(64)}, 'bayn.paper-intent.v1', 'paper-account-1', 'client-order-4',
                  'AMD', 'BUY', 'MARKET', 'DAY', 1000000, 200000000, 'PLANNED',
                  '2026-07-22T06:00:00.000Z', '2026-07-22T06:00:00.000Z'
                )
              `
              yield* sql`
                INSERT INTO risk_decisions (
                  decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                  reason_codes, decided_at, expires_at
                ) VALUES (
                  ${'c'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'d'.repeat(64)}, ${'b'.repeat(64)},
                  ${'e'.repeat(64)}, 'BLOCKED', ARRAY['KILL_ACTIVE'],
                  '2026-07-22T06:00:30.000Z', '2099-01-01T00:00:00.000Z'
                )
              `
              yield* sql`
                UPDATE intents
                SET state = 'APPROVED', risk_decision_id = ${'c'.repeat(64)}, state_version = 2,
                    updated_at = '2026-07-22T06:00:30.000Z'
                WHERE intent_id = ${'b'.repeat(64)}
              `
            }),
          ),
        )
        const invalidTerminal = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO intents (
                  intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
                  time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at
                ) VALUES (
                  ${'f'.repeat(64)}, 'bayn.paper-intent.v1', 'paper-account-1', 'client-order-5',
                  'AMD', 'BUY', 'MARKET', 'DAY', 1000000, 200000000, 'PLANNED',
                  '2026-07-22T06:00:00.000Z', '2026-07-22T06:00:00.000Z'
                )
              `
              yield* sql`
                INSERT INTO risk_decisions (
                  decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                  reason_codes, decided_at, expires_at
                ) VALUES (
                  ${'0'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'1'.repeat(64)}, ${'f'.repeat(64)},
                  ${'2'.repeat(64)}, 'BLOCKED', ARRAY['KILL_ACTIVE'],
                  '2026-07-22T06:00:30.000Z', '2099-01-01T00:00:00.000Z'
                )
              `
              yield* sql`
                UPDATE intents
                SET state = 'TERMINAL', terminal_outcome = 'FILLED', risk_decision_id = ${'0'.repeat(64)},
                    state_version = 2, updated_at = '2026-07-22T06:00:30.000Z'
                WHERE intent_id = ${'f'.repeat(64)}
              `
            }),
          ),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO intents (
                intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
                time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at
              ) VALUES (
                ${'a'.repeat(64)}, 'bayn.paper-intent.v1', 'paper-account-1', 'client-order-6',
                'AMD', 'BUY', 'MARKET', 'DAY', 1000000, 200000000, 'PLANNED',
                '2026-07-22T06:00:00.000Z', '2026-07-22T06:00:00.000Z'
              )
            `
            yield* sql`
              INSERT INTO risk_decisions (
                decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                reason_codes, decided_at, expires_at
              ) VALUES (
                ${'9'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'8'.repeat(64)}, ${'a'.repeat(64)},
                ${'7'.repeat(64)}, 'BLOCKED', ARRAY['KILL_ACTIVE'],
                '2026-07-22T06:00:30.000Z', '2099-01-01T00:00:00.000Z'
              )
            `
            yield* sql`
              UPDATE intents
              SET state = 'TERMINAL', terminal_outcome = 'BLOCKED', risk_decision_id = ${'9'.repeat(64)},
                  state_version = 2, updated_at = '2026-07-22T06:00:30.000Z'
              WHERE intent_id = ${'a'.repeat(64)}
            `
          }),
        )
        const orphan = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO intents (
                  intent_id, schema_version, account_id, client_order_id, symbol, side, order_type,
                  time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at
                ) VALUES (
                  ${'7'.repeat(64)}, 'bayn.paper-intent.v1', 'paper-account-1', 'client-order-3',
                  'AMD', 'BUY', 'MARKET', 'DAY', 1000000, 200000000, 'PLANNED',
                  '2026-07-22T06:00:00.000Z', '2026-07-22T06:00:00.000Z'
                )
              `
              yield* sql`
                INSERT INTO risk_decisions (
                  decision_id, schema_version, input_hash, intent_id, policy_hash, outcome,
                  reason_codes, decided_at, expires_at
                ) VALUES (
                  ${'8'.repeat(64)}, 'bayn.paper-risk-decision.v1', ${'9'.repeat(64)}, ${'7'.repeat(64)},
                  ${'a'.repeat(64)}, 'BLOCKED', ARRAY['KILL_ACTIVE'],
                  '2026-07-22T06:00:30.000Z', '2099-01-01T00:00:00.000Z'
                )
              `
            }),
          ),
        )
        const mutateDecision = yield* Effect.exit(sql`
          UPDATE risk_decisions SET outcome = 'BLOCKED', reason_codes = ARRAY['CHANGED']
          WHERE decision_id = ${decisionId}
        `)
        const deleteIntent = yield* Effect.exit(sql`DELETE FROM intents WHERE intent_id = ${intentId}`)
        const state = yield* sql<{ state: string; state_version: number; decision_id: string }>`
          SELECT intent.state, intent.state_version::integer, decision.decision_id
          FROM intents AS intent
          JOIN risk_decisions AS decision ON decision.intent_id = intent.intent_id
          WHERE intent.intent_id = ${intentId}
        `
        const blockedState = yield* sql<{ state: string; terminal_outcome: string }>`
          SELECT state, terminal_outcome FROM intents WHERE intent_id = ${'a'.repeat(64)}
        `
        const staleState = yield* sql<{
          database_after_expiry: boolean
          event_before_expiry: boolean
          state: string
          state_version: number
        }>`
          SELECT
            intent.state,
            intent.state_version::integer,
            intent.updated_at < decision.expires_at AS event_before_expiry,
            statement_timestamp() >= decision.expires_at AS database_after_expiry
          FROM intents AS intent
          JOIN risk_decisions AS decision ON decision.decision_id = intent.risk_decision_id
          WHERE intent.intent_id = ${staleIntentId}
        `
        return {
          invalidInitial,
          skipState,
          changeIdentity,
          expiredIo,
          backdatedExpiredIo,
          blockedApproval,
          invalidTerminal,
          orphan,
          mutateDecision,
          deleteIntent,
          state: state[0],
          blockedState: blockedState[0],
          staleState: staleState[0],
        }
      }),
    )

    expect(Exit.isFailure(result.invalidInitial)).toBe(true)
    expect(Exit.isFailure(result.skipState)).toBe(true)
    expect(Exit.isFailure(result.changeIdentity)).toBe(true)
    expect(Exit.isFailure(result.expiredIo)).toBe(true)
    expect(Exit.isFailure(result.backdatedExpiredIo)).toBe(true)
    if (Exit.isFailure(result.backdatedExpiredIo)) {
      expect(Cause.pretty(result.backdatedExpiredIo.cause)).toContain('current risk decision')
    }
    expect(Exit.isFailure(result.blockedApproval)).toBe(true)
    expect(Exit.isFailure(result.invalidTerminal)).toBe(true)
    expect(Exit.isFailure(result.orphan)).toBe(true)
    expect(Exit.isFailure(result.mutateDecision)).toBe(true)
    expect(Exit.isFailure(result.deleteIntent)).toBe(true)
    expect(result.state).toEqual({ state: 'APPROVED', state_version: 2, decision_id: '2'.repeat(64) })
    expect(result.blockedState).toEqual({ state: 'TERMINAL', terminal_outcome: 'BLOCKED' })
    expect(result.staleState).toEqual({
      state: 'APPROVED',
      state_version: 2,
      event_before_expiry: true,
      database_after_expiry: true,
    })
  }, 15_000)

  test('enforces exact accounting evidence and downward-only authority', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const eventId = '1'.repeat(64)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO broker_events (
                event_id, schema_version, content_hash, event_kind, broker, account_id,
                source_event_id, source_sequence, occurred_at, observed_at
              ) VALUES (
                ${eventId}, 'bayn.paper-broker-event.v1', ${'2'.repeat(64)}, 'ACCOUNT', 'ALPACA',
                'paper-account-1', 'source-account-1', 1,
                '2026-07-22T06:00:00.000Z', '2026-07-22T06:01:00.000Z'
              )
            `
            yield* sql`
              INSERT INTO account_snapshots (
                event_id, account_id, schema_version, status, currency,
                cash_micros, equity_micros, buying_power_micros
              ) VALUES (
                ${eventId}, 'paper-account-1', 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD',
                1000000, 1000000, 2000000
              )
            `
          }),
        )
        yield* sql`
          INSERT INTO accounting_receipts (
            receipt_id, schema_version, broker_event_id, tigerbeetle_cluster_id, tigerbeetle_ledger,
            account_ids, transfer_ids, debit_micros, credit_micros, content_hash, recorded_at
          ) VALUES (
            ${'3'.repeat(64)}, 'bayn.paper-accounting-receipt.v1', ${eventId}, 2001, 7001,
            ARRAY[1, 2]::numeric[], ARRAY[3]::numeric[], 1250000, 1250000, ${'4'.repeat(64)},
            '2026-07-22T06:01:00.000Z'
          )
        `
        yield* sql`
          INSERT INTO valuations (
            valuation_id, schema_version, account_id, source_hash, cash_micros,
            long_market_value_micros, short_market_value_micros, equity_micros, as_of
          ) VALUES (
            ${'5'.repeat(64)}, 'bayn.paper-valuation.v1', 'paper-account-1', ${'6'.repeat(64)},
            1000000, 2500000, -500000, 3000000, '2026-07-22T06:01:00.000Z'
          )
        `
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${'7'.repeat(64)}, 'bayn.paper-reconciliation.v1', 'paper-account-1',
            ${'8'.repeat(64)}, ${'8'.repeat(64)}, ${'9'.repeat(64)}, 'EXACT', '[]'::jsonb,
            '2026-07-22T06:01:00.000Z'
          )
        `
        yield* sql`
          INSERT INTO authority_state (
            schema_version, generation_hash, maximum, effective, kill_state, version, updated_at
          ) VALUES (
            'bayn.paper-authority.v1', ${'a'.repeat(64)}, 'OBSERVE', 'OBSERVE', 'CLEAR', 1,
            '2026-07-22T06:00:00.000Z'
          )
        `
        const unbalanced = yield* Effect.exit(sql`
          INSERT INTO accounting_receipts (
            receipt_id, schema_version, broker_event_id, tigerbeetle_cluster_id, tigerbeetle_ledger,
            account_ids, transfer_ids, debit_micros, credit_micros, content_hash, recorded_at
          ) VALUES (
            ${'b'.repeat(64)}, 'bayn.paper-accounting-receipt.v1', ${eventId}, 2001, 7001,
            ARRAY[1, 2]::numeric[], ARRAY[3]::numeric[], 1250000, 1249999, ${'c'.repeat(64)},
            '2026-07-22T06:01:00.000Z'
          )
        `)
        const unordered = yield* Effect.exit(sql`
          INSERT INTO accounting_receipts (
            receipt_id, schema_version, broker_event_id, tigerbeetle_cluster_id, tigerbeetle_ledger,
            account_ids, transfer_ids, debit_micros, credit_micros, content_hash, recorded_at
          ) VALUES (
            ${'d'.repeat(64)}, 'bayn.paper-accounting-receipt.v1', ${eventId}, 2001, 7001,
            ARRAY[2, 1]::numeric[], ARRAY[3]::numeric[], 1250000, 1250000, ${'e'.repeat(64)},
            '2026-07-22T06:01:00.000Z'
          )
        `)
        const nullIdentifier = yield* Effect.exit(sql`
          INSERT INTO accounting_receipts (
            receipt_id, schema_version, broker_event_id, tigerbeetle_cluster_id, tigerbeetle_ledger,
            account_ids, transfer_ids, debit_micros, credit_micros, content_hash, recorded_at
          ) VALUES (
            ${'e'.repeat(64)}, 'bayn.paper-accounting-receipt.v1', ${eventId}, 2001, 7001,
            ARRAY[1, NULL, 2]::numeric[], ARRAY[3]::numeric[], 1250000, 1250000, ${'f'.repeat(64)},
            '2026-07-22T06:01:00.000Z'
          )
        `)
        const badValuation = yield* Effect.exit(sql`
          INSERT INTO valuations (
            valuation_id, schema_version, account_id, source_hash, cash_micros,
            long_market_value_micros, short_market_value_micros, equity_micros, as_of
          ) VALUES (
            ${'f'.repeat(64)}, 'bayn.paper-valuation.v1', 'paper-account-1', ${'0'.repeat(64)},
            1000000, 2500000, -500000, 3000001, '2026-07-22T06:01:00.000Z'
          )
        `)
        const badReconciliation = yield* Effect.exit(sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${'0'.repeat(64)}, 'bayn.paper-reconciliation.v1', 'paper-account-1',
            ${'1'.repeat(64)}, ${'2'.repeat(64)}, ${'3'.repeat(64)}, 'EXACT', '[]'::jsonb,
            '2026-07-22T06:01:00.000Z'
          )
        `)
        yield* sql`
          UPDATE authority_state
          SET generation_hash = ${'b'.repeat(64)}, maximum = 'PAPER', effective = 'PAPER',
              version = 2, updated_at = '2026-07-22T06:01:00.000Z'
        `
        yield* sql`
          UPDATE authority_state
          SET effective = 'OBSERVE', version = 3, updated_at = '2026-07-22T06:02:00.000Z'
        `
        const escalation = yield* Effect.exit(sql`
          UPDATE authority_state
          SET effective = 'PAPER', version = 4, updated_at = '2026-07-22T06:03:00.000Z'
        `)
        yield* sql`
          UPDATE authority_state
          SET kill_state = 'ACTIVE', reason = 'operator kill', version = 4,
              updated_at = '2026-07-22T06:03:00.000Z'
        `
        const clearKill = yield* Effect.exit(sql`
          UPDATE authority_state
          SET kill_state = 'CLEAR', reason = NULL, version = 5,
              updated_at = '2026-07-22T06:04:00.000Z'
        `)
        const mutateReceipt = yield* Effect.exit(sql`
          UPDATE accounting_receipts SET debit_micros = 1 WHERE receipt_id = ${'3'.repeat(64)}
        `)
        const authority = yield* sql<{
          maximum: string
          effective: string
          kill_state: string
          version: number
        }>`
          SELECT maximum, effective, kill_state, version::integer FROM authority_state
        `
        return {
          unbalanced,
          unordered,
          nullIdentifier,
          badValuation,
          badReconciliation,
          escalation,
          clearKill,
          mutateReceipt,
          authority: authority[0],
        }
      }),
    )

    expect(Exit.isFailure(result.unbalanced)).toBe(true)
    expect(Exit.isFailure(result.unordered)).toBe(true)
    expect(Exit.isFailure(result.nullIdentifier)).toBe(true)
    expect(Exit.isFailure(result.badValuation)).toBe(true)
    expect(Exit.isFailure(result.badReconciliation)).toBe(true)
    expect(Exit.isFailure(result.escalation)).toBe(true)
    expect(Exit.isFailure(result.clearKill)).toBe(true)
    expect(Exit.isFailure(result.mutateReceipt)).toBe(true)
    expect(result.authority).toEqual({ maximum: 'PAPER', effective: 'OBSERVE', kill_state: 'ACTIVE', version: 4 })
  })

  test('rejects the legacy migration tracker instead of creating a parallel schema', async () => {
    await runtime.dispose()
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE TABLE bayn_schema_migrations (migration_id integer PRIMARY KEY)`
      }),
    )

    const legacyRuntime = makeEvidenceRuntime()
    const exit = await legacyRuntime.runPromiseExit(Effect.flatMap(EvidenceStore, (store) => store.check))
    await legacyRuntime.dispose()

    const trackers = await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ current_exists: boolean; legacy_exists: boolean }>`
          SELECT
            to_regclass('public.schema_migrations') IS NOT NULL AS current_exists,
            to_regclass('public.bayn_schema_migrations') IS NOT NULL AS legacy_exists
        `
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        return rows[0]
      }),
    )
    await client.dispose()
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('legacy migration tracker is unsupported')
    expect(trackers).toEqual({ current_exists: false, legacy_exists: true })
  })

  test('rejects the retired migration history instead of skipping the initial schema', async () => {
    await runtime.dispose()
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`
          CREATE TABLE schema_migrations (
            migration_id integer PRIMARY KEY,
            created_at timestamptz NOT NULL DEFAULT now(),
            name text NOT NULL
          )
        `
        yield* sql`INSERT INTO schema_migrations (migration_id, name) VALUES (1, 'evaluation_evidence')`
      }),
    )

    const legacyRuntime = makeEvidenceRuntime()
    const exit = await legacyRuntime.runPromiseExit(Effect.flatMap(EvidenceStore, (store) => store.check))
    await legacyRuntime.dispose()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await client.dispose()
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('legacy migration history is unsupported')
  })

  test('accepts only the current protocol contract', async () => {
    const exits = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const unsupported = yield* Effect.exit(sql`
          INSERT INTO protocol_locks (
            protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
          ) VALUES (
            ${'0'.repeat(64)},
            'unsupported.protocol',
            'unsupported',
            ${'1'.repeat(64)},
            ${'2'.repeat(64)},
            '{}'::jsonb
          )
        `)
        const current = yield* Effect.exit(sql`
          INSERT INTO protocol_locks (
            protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
          ) VALUES (
            ${'3'.repeat(64)},
            'bayn.risk-balanced-trend.protocol.v2',
            'risk-balanced-trend',
            ${'4'.repeat(64)},
            ${'5'.repeat(64)},
            '{}'::jsonb
          )
        `)
        return { current, unsupported }
      }),
    )

    expect(Exit.isFailure(exits.unsupported)).toBe(true)
    expect(Exit.isSuccess(exits.current)).toBe(true)
  })

  test('keeps the audit snapshot repeatable-read and rejects writes', async () => {
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE TABLE audit_read_only_probe (id integer PRIMARY KEY)`
        const transaction = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
            const mode = yield* sql<{ isolation: string; read_only: boolean }>`
              SELECT
                current_setting('transaction_isolation') AS isolation,
                current_setting('transaction_read_only') = 'on' AS read_only
            `
            const write = yield* Effect.exit(sql`INSERT INTO audit_read_only_probe (id) VALUES (1)`)
            return { mode: mode[0], write }
          }),
        )
        const rows = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM audit_read_only_probe
        `
        return { ...transaction, rows }
      }),
    )

    expect(observed.mode).toEqual({ isolation: 'repeatable read', read_only: true })
    expect(Exit.isFailure(observed.write)).toBe(true)
    expect(observed.rows).toEqual([{ count: 0 }])
  })

  test('commits one complete run and deduplicates an exact replay', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        const first = yield* store.persist(input)
        const second = yield* store.persist(input)
        const runs = yield* sql<{
          status: string
          artifact_count: number
          event_count: number
          gate_count: number
        }>`
          SELECT
            run.status,
            (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
            (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
            (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count
          FROM evaluation_runs AS run
        `
        const gates = yield* sql<{
          gate_name: string
          actual: unknown
          required: unknown
          actual_type: string
          required_type: string
        }>`
          SELECT
            gate_name,
            actual,
            required,
            jsonb_typeof(actual) AS actual_type,
            jsonb_typeof(required) AS required_type
          FROM gate_outcomes
          WHERE run_id = ${input.evaluation.runId}
          ORDER BY ordinal
        `
        return { first, second, runs, gates }
      }),
    )

    expect(result.first).toMatchObject({ runId: input.evaluation.runId, deduplicated: false })
    expect(result.first.artifactCount).toBe(17)
    expect(result.second).toEqual({ ...result.first, deduplicated: true })
    expect(result.runs).toEqual([
      {
        status: 'COMPLETE',
        artifact_count: result.first.artifactCount,
        event_count: result.first.eventCount,
        gate_count: result.first.gateCount,
      },
    ])
    expect(result.gates).toEqual(
      input.evaluation.verdict.gates.map((gate) => ({
        gate_name: gate.name,
        actual: gate.actual,
        required: gate.required,
        actual_type: typeof gate.actual,
        required_type: typeof gate.required,
      })),
    )
  })

  test('opens one concurrent lock and commits one terminal qualification result', async () => {
    const input = makeInput()
    const qualification = makeLockedInput(input)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        const opened = yield* Effect.all(
          [store.openQualification(qualification.open), store.openQualification(qualification.open)],
          { concurrency: 'unbounded' },
        )
        const before = yield* store.readQualification(input.evaluation.runId)
        const bypass = yield* store.persist(input).pipe(Effect.flip)
        const receipt = yield* store.persist(qualification.persist)
        const terminal = yield* store.readQualification(input.evaluation.runId)
        const reopened = yield* store.openQualification(qualification.open)
        const trials = yield* store.listPriorTrials
        const counts = yield* sql<{
          locks: number
          results: number
          runs: number
          trials: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM qualification_locks) AS locks,
            (SELECT count(*)::integer FROM qualification_results) AS results,
            (SELECT count(*)::integer FROM evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM qualification_trials) AS trials
        `
        return { before, bypass, counts: counts[0], opened, receipt, reopened, terminal, trials }
      }),
    )

    expect(observed.opened.map((result) => result.state).sort()).toEqual(['ACQUIRED', 'OPENED_INCOMPLETE'])
    expect(observed.before).toEqual(Option.some({ state: 'OPENED_INCOMPLETE', lock: qualification.lock }))
    expect(observed.bypass).toMatchObject({ failure: 'invariant', operation: 'persist-qualification' })
    expect(observed.receipt).toMatchObject({ runId: input.evaluation.runId, deduplicated: false })
    expect(observed.terminal).toEqual(
      Option.some({ state: 'TERMINAL', lock: qualification.lock, result: qualification.result }),
    )
    expect(observed.reopened).toEqual({
      state: 'TERMINAL',
      lock: qualification.lock,
      result: qualification.result,
    })
    expect(observed.trials).toEqual([input.evaluation.runId])
    expect(observed.counts).toEqual({ locks: 1, results: 1, runs: 1, trials: 0 })
  })

  test('builds the next candidate lineage from both burned and terminal trials', async () => {
    const burned = makeInput('0'.repeat(40))
    const terminal = makeInput('1'.repeat(40))
    const terminalQualification = makeLockedInput(terminal, [burned.evaluation.runId])
    const candidate = makeInput()
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(burned)
        yield* store.openQualification(terminalQualification.open)
        yield* store.persist(terminalQualification.persist)
        const priorTrialRunIds = yield* store.listPriorTrials
        const strategy = makeStrategy(fixtureProtocol, candidate.provenance)
        const sessionDates = [...new Set(riskBalancedTrendSnapshot.bars.map((bar) => bar.sessionDate))].sort()
        const lock = strategy.prepareLock(candidate.evaluation.inputManifest, sessionDates, priorTrialRunIds)
        return { lock, priorTrialRunIds }
      }),
    )

    expect(observed.priorTrialRunIds).toEqual([burned.evaluation.runId, terminal.evaluation.runId].sort())
    expect(observed.lock.priorTrialRunIds).toEqual(observed.priorTrialRunIds)
  })

  test('rolls back the evaluation graph when terminal qualification insertion fails', async () => {
    const input = makeInput()
    const qualification = makeLockedInput(input)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.openQualification(qualification.open)
        yield* sql`
          CREATE FUNCTION bayn_test_reject_qualification_result()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $function$
          BEGIN
            RAISE EXCEPTION 'injected terminal result failure' USING ERRCODE = 'P0001';
          END
          $function$
        `
        yield* sql`
          CREATE TRIGGER bayn_test_reject_qualification_result
          BEFORE INSERT ON qualification_results
          FOR EACH ROW EXECUTE FUNCTION bayn_test_reject_qualification_result()
        `
        const failure = yield* store.persist(qualification.persist).pipe(Effect.flip)
        const record = yield* store.readQualification(input.evaluation.runId)
        const counts = yield* sql<{
          locks: number
          results: number
          runs: number
          artifacts: number
          events: number
          gates: number
          statuses: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM qualification_locks) AS locks,
            (SELECT count(*)::integer FROM qualification_results) AS results,
            (SELECT count(*)::integer FROM evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM evaluation_artifacts) AS artifacts,
            (SELECT count(*)::integer FROM evaluation_events) AS events,
            (SELECT count(*)::integer FROM gate_outcomes) AS gates,
            (SELECT count(*)::integer FROM status_history) AS statuses
        `
        return { counts: counts[0], failure, record }
      }),
    )

    expect(observed.failure).toBeInstanceOf(DatabaseError)
    expect(observed.record).toEqual(Option.some({ state: 'OPENED_INCOMPLETE', lock: qualification.lock }))
    expect(observed.counts).toEqual({
      locks: 1,
      results: 0,
      runs: 0,
      artifacts: 0,
      events: 0,
      gates: 0,
      statuses: 0,
    })
  })

  test('persists and recovers fee, partial-fill, and nonzero cash-yield evidence', async () => {
    const protocol: Protocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        cash: { ...fixtureProtocol.executionModel.cash, annualYieldBps: 500 },
      },
    }
    const input = makeInput('a'.repeat(40), 'c'.repeat(64), protocol)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(input)
        return {
          stored: yield* store.read(input.evaluation.runId),
          recovered: yield* store.recover(input.evaluation.runId, input.provenance),
        }
      }),
    )

    expect(Option.isSome(result.stored)).toBe(true)
    expect(Option.isSome(result.recovered)).toBe(true)
    if (Option.isNone(result.stored) || Option.isNone(result.recovered)) throw new Error('evidence is missing')
    expect(result.stored.value.events.some((event) => event.kind === 'fee')).toBe(true)
    expect(result.stored.value.events.some((event) => event.kind === 'cash-yield')).toBe(true)
    expect(input.evaluation.simulation.orders.some((order) => order.status === 'partially-filled')).toBe(true)
    expect(result.recovered.value.evaluation.strategy.totalCashYieldMicros).toBe(
      input.evaluation.strategy.totalCashYieldMicros,
    )
    expect(result.recovered.value.evaluation.markedEquityReconciliation.exact).toBe(true)
  })

  test('burns observed runs and preserves qualification state as append-only', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)

        const lock = makeLockedInput(input, [input.evaluation.runId]).lock

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
            payload
          ) VALUES (
            ${lock.lockId},
            ${lock.schemaVersion},
            ${lock.candidateRunId},
            ${lock.protocolHash},
            ${lock.data.snapshotId},
            ${lock.sourceRevision},
            ${lock.image.repository},
            ${lock.image.digest},
            ${sql.json(lock)}
          )
        `

        const trials = yield* sql<{
          run_id: string
          disposition: string
          prelock_observed: boolean
          failed_benchmark: boolean
        }>`
          SELECT
            run_id,
            disposition,
            'PRE_LOCK_RESULT_OBSERVED' = ANY(reason_codes) AS prelock_observed,
            'FAILED_BENCHMARK_GATE' = ANY(reason_codes) AS failed_benchmark
          FROM qualification_trials
        `
        const locks = yield* sql<{ lock_id: string; payload: unknown }>`
          SELECT lock_id, payload FROM qualification_locks
        `
        const results = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM qualification_results
        `
        const trialUpdate = yield* Effect.exit(sql`
          UPDATE qualification_trials SET disposition = 'BURNED' WHERE run_id = ${input.evaluation.runId}
        `)
        const trialDelete = yield* Effect.exit(sql`
          DELETE FROM qualification_trials WHERE run_id = ${input.evaluation.runId}
        `)
        const lockUpdate = yield* Effect.exit(sql`
          UPDATE qualification_locks SET payload = payload WHERE lock_id = ${lock.lockId}
        `)
        const lockDelete = yield* Effect.exit(sql`
          DELETE FROM qualification_locks WHERE lock_id = ${lock.lockId}
        `)
        const divergentLock = yield* Effect.exit(sql`
          INSERT INTO qualification_locks (
            lock_id,
            schema_version,
            candidate_run_id,
            protocol_hash,
            snapshot_id,
            source_revision,
            image_repository,
            image_digest,
            payload
          ) VALUES (
            ${'f'.repeat(64)},
            ${lock.schemaVersion},
            ${lock.candidateRunId},
            ${lock.protocolHash},
            ${lock.data.snapshotId},
            ${lock.sourceRevision},
            ${lock.image.repository},
            ${lock.image.digest},
            ${sql.json(lock)}
          )
        `)
        return { lock, locks, results, trials, trialUpdate, trialDelete, lockUpdate, lockDelete, divergentLock }
      }),
    )

    expect(result.trials).toEqual([
      {
        run_id: input.evaluation.runId,
        disposition: 'BURNED',
        prelock_observed: true,
        failed_benchmark: !input.evaluation.verdict.gates.find((gate) => gate.name === 'benchmark_sharpe_improvement')!
          .passed,
      },
    ])
    expect(result.locks).toEqual([{ lock_id: result.lock.lockId, payload: result.lock }])
    expect(result.results).toEqual([{ count: 0 }])
    expect(Exit.isFailure(result.trialUpdate)).toBe(true)
    expect(Exit.isFailure(result.trialDelete)).toBe(true)
    expect(Exit.isFailure(result.lockUpdate)).toBe(true)
    expect(Exit.isFailure(result.lockDelete)).toBe(true)
    expect(Exit.isFailure(result.divergentLock)).toBe(true)
  })

  test('reads and recovers the complete current evidence contract without evaluating it again', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(input)
        const stored = yield* store.read(input.evaluation.runId)
        const recovered = yield* store.recover(input.evaluation.runId, input.provenance)
        const missing = yield* store.read('f'.repeat(64))
        return { stored, recovered, missing }
      }),
    )

    expect(Option.isSome(result.stored)).toBe(true)
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.protocol).toMatchObject({
        protocolHash: input.evaluation.protocolHash,
        schemaVersion: fixtureProtocol.schemaVersion,
        strategyName: 'risk-balanced-trend',
        behaviorHash: input.provenance.strategy.behaviorHash,
        parameterHash: input.provenance.strategy.parameterHash,
        parameters: fixtureProtocol,
      })
      expect(result.stored.value.run).toMatchObject({
        runId: input.evaluation.runId,
        evaluationSchemaVersion: 'bayn.evaluation.v6',
        artifactCount: 17,
        eventCount: input.evaluation.events.length,
      })
      expect(result.stored.value.artifacts.map((artifact) => artifact.name)).toEqual([
        'buy-and-hold',
        'buy-and-hold-series',
        'cash-changes',
        'daily-position-marks',
        'direct-volatility-timing',
        'direct-volatility-timing-series',
        'double-cost-strategy',
        'double-cost-strategy-series',
        'equity-series',
        'evaluation-summary',
        'input-manifest',
        'marked-equity-reconciliation',
        'qualification-artifact-manifest',
        'reconciliation',
        'risk-balanced-trend-decisions',
        'simulated-orders',
        'strategy',
      ])
      const manifest = result.stored.value.artifacts.find(
        (artifact) => artifact.name === 'qualification-artifact-manifest',
      )
      if (manifest === undefined) throw new Error('qualification artifact manifest is missing')
      expect(manifest.payload).toMatchObject({
        schemaVersion: 'bayn.qualification-artifact-manifest.v1',
        identity: {
          runId: input.evaluation.runId,
          protocolHash: input.evaluation.protocolHash,
          snapshotId: input.evaluation.inputManifest.finalizedSnapshot.snapshotId,
          sourceRevision: input.provenance.sourceRevision,
          image: input.provenance.image,
        },
        events: { count: input.evaluation.events.length },
        gates: { count: input.evaluation.verdict.gates.length },
      })
      expect(canonicalHashV1(manifest.payload)).toBe(manifest.contentHash)
    }
    expect(Option.isSome(result.recovered)).toBe(true)
    if (Option.isSome(result.recovered)) {
      expect(result.recovered.value).toMatchObject({
        evaluation: {
          runId: input.evaluation.runId,
          markedEquityReconciliation: { withinTolerance: true },
        },
        reconciliation: { runId: input.evaluation.runId, exact: true },
        persistence: { runId: input.evaluation.runId, deduplicated: true, artifactCount: 17 },
      })
    }
    expect(Option.isNone(result.missing)).toBe(true)
  })

  test('persists and recovers the complete risk-balanced trend v6 evidence contract', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const receipt = yield* store.persist(input)
        const stored = yield* store.read(input.evaluation.runId)
        const recovered = yield* store.recover(input.evaluation.runId, input.provenance)
        return { receipt, stored, recovered }
      }),
    )

    expect(result.receipt).toMatchObject({ runId: input.evaluation.runId, artifactCount: 17 })
    expect(Option.isSome(result.stored)).toBe(true)
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.protocol).toMatchObject({
        strategyName: 'risk-balanced-trend',
        schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
        parameters: fixtureProtocol,
      })
      expect(result.stored.value.run).toMatchObject({
        evaluationSchemaVersion: 'bayn.evaluation.v6',
        artifactCount: 17,
      })
      expect(result.stored.value.artifacts.map((artifact) => artifact.name)).toContain('risk-balanced-trend-decisions')
      expect(result.stored.value.artifacts.find((artifact) => artifact.name === 'evaluation-summary')).toMatchObject({
        schemaVersion: 'bayn.evaluation-summary.v5',
      })
    }
    expect(Option.isSome(result.recovered)).toBe(true)
    if (Option.isSome(result.recovered)) {
      expect(result.recovered.value).toMatchObject({
        evaluation: {
          schemaVersion: 'bayn.evaluation-summary.v5',
          evaluationSchemaVersion: 'bayn.evaluation.v6',
          runId: input.evaluation.runId,
        },
        reconciliation: { runId: input.evaluation.runId, exact: true },
        persistence: { runId: input.evaluation.runId, deduplicated: true, artifactCount: 17 },
      })
    }
  })

  test('retrieves ordered artifact items through bounded contiguous pages', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(input)
        const items: unknown[] = []
        const pageSizes: number[] = []
        let afterOrdinal = -1
        let contentHash = ''
        while (true) {
          const page = yield* store.readArtifactItems({
            runId: input.evaluation.runId,
            artifactName: 'daily-position-marks',
            afterOrdinal,
            limit: 31,
          })
          if (Option.isNone(page)) throw new Error('daily-position-marks page is missing')
          contentHash = page.value.contentHash
          pageSizes.push(page.value.items.length)
          items.push(...page.value.items.map((item) => item.payload))
          if (page.value.nextAfterOrdinal === null) break
          afterOrdinal = page.value.nextAfterOrdinal
        }
        const scalar = yield* store.readArtifactItems({
          runId: input.evaluation.runId,
          artifactName: 'strategy',
          limit: 1,
        })
        const invalidLimit = yield* store
          .readArtifactItems({
            runId: input.evaluation.runId,
            artifactName: 'daily-position-marks',
            limit: 257,
          })
          .pipe(Effect.flip)
        return { contentHash, invalidLimit, items, pageSizes, scalar }
      }),
    )

    expect(result.items).toEqual([...input.evaluation.simulation.dailyMarks])
    expect(result.contentHash).toBe(
      canonicalHashV1({
        schemaVersion: 'bayn.daily-position-marks.v3',
        items: input.evaluation.simulation.dailyMarks,
      }),
    )
    expect(result.pageSizes.length).toBeGreaterThan(2)
    expect(result.pageSizes.every((size) => size > 0 && size <= 31)).toBe(true)
    expect(Option.isNone(result.scalar)).toBe(true)
    expect(result.invalidLimit).toMatchObject({
      failure: 'invariant',
      operation: 'read-artifact-items',
    })
  })

  test('rejects a simulation whose declared costs diverge from its locked protocol', async () => {
    const input = makeInput()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        return yield* store
          .persist({
            ...input,
            evaluation: {
              ...input.evaluation,
              simulation: {
                ...input.evaluation.simulation,
                executionModel: {
                  ...input.evaluation.simulation.executionModel,
                  priceImpact: {
                    ...input.evaluation.simulation.executionModel.priceImpact,
                    slippageBps: input.evaluation.simulation.executionModel.priceImpact.slippageBps + 1,
                  },
                },
              },
            },
          })
          .pipe(Effect.flip)
      }),
    )

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error.failure).toBe('invariant')
    expect(error.operation).toBe('plan')
    expect(error.message).toContain('simulation execution model does not match')
  })

  test('creates distinct runs when bound runtime provenance changes', async () => {
    const first = makeInput('a'.repeat(40))
    const second = makeInput('d'.repeat(40))
    const receipts = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        return [yield* store.persist(first), yield* store.persist(second)] as const
      }),
    )

    expect(first.evaluation.runId).not.toBe(second.evaluation.runId)
    expect(receipts.map((receipt) => receipt.runId)).toEqual([first.evaluation.runId, second.evaluation.runId])
  })

  test('locks strategy behavior and parameters under a composite protocol identity', async () => {
    const first = makeInput('a'.repeat(40), 'c'.repeat(64))
    const second = makeInput('a'.repeat(40), 'd'.repeat(64))
    const protocols = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(first)
        yield* store.persist(second)
        return yield* sql<{ protocol_hash: string; behavior_hash: string; parameter_hash: string }>`
          SELECT protocol_hash, behavior_hash, parameter_hash
          FROM protocol_locks
          ORDER BY behavior_hash
        `
      }),
    )

    expect(first.evaluation.protocolHash).not.toBe(second.evaluation.protocolHash)
    expect(protocols).toEqual([
      {
        protocol_hash: first.evaluation.protocolHash,
        behavior_hash: first.provenance.strategy.behaviorHash,
        parameter_hash: first.provenance.strategy.parameterHash,
      },
      {
        protocol_hash: second.evaluation.protocolHash,
        behavior_hash: second.provenance.strategy.behaviorHash,
        parameter_hash: second.provenance.strategy.parameterHash,
      },
    ])
  })

  test('rejects updates and deletes across the completed evidence graph', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)
        const artifactUpdate = yield* Effect.exit(sql`
          UPDATE evaluation_artifacts
          SET payload = ${sql.json({ corrupted: true })}
          WHERE run_id = ${input.evaluation.runId} AND artifact_name = 'strategy'
        `)
        const snapshotUpdate = yield* Effect.exit(sql`
          UPDATE snapshot_references
          SET first_session = first_session + 1
          WHERE snapshot_id = ${input.evaluation.inputManifest.finalizedSnapshot.snapshotId}
        `)
        const runUpdate = yield* Effect.exit(sql`
          UPDATE evaluation_runs
          SET initial_capital_micros = initial_capital_micros + 1
          WHERE run_id = ${input.evaluation.runId}
        `)
        const statusUpdate = yield* Effect.exit(sql`
          UPDATE status_history
          SET detail = ${sql.json({ corrupted: true })}
          WHERE run_id = ${input.evaluation.runId} AND status = 'COMPLETE'
        `)
        const eventDelete = yield* Effect.exit(sql`
          DELETE FROM evaluation_events WHERE run_id = ${input.evaluation.runId}
        `)
        const gateDelete = yield* Effect.exit(sql`
          DELETE FROM gate_outcomes WHERE run_id = ${input.evaluation.runId}
        `)
        const protocolDelete = yield* Effect.exit(sql`
          DELETE FROM protocol_locks WHERE protocol_hash = ${input.evaluation.protocolHash}
        `)
        const runDelete = yield* Effect.exit(sql`
          DELETE FROM evaluation_runs WHERE run_id = ${input.evaluation.runId}
        `)
        const read = yield* store.read(input.evaluation.runId)
        return {
          exits: [
            artifactUpdate,
            snapshotUpdate,
            runUpdate,
            statusUpdate,
            eventDelete,
            gateDelete,
            protocolDelete,
            runDelete,
          ],
          read,
        }
      }),
    )

    expect(result.exits.every(Exit.isFailure)).toBe(true)
    expect(Option.isSome(result.read)).toBe(true)
  })

  test('rejects truncation of evidence and qualification tables', async () => {
    const exits = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* Effect.forEach(
          [
            sql`TRUNCATE evaluation_runs CASCADE`,
            sql`TRUNCATE evaluation_artifacts`,
            sql`TRUNCATE qualification_trials`,
            sql`TRUNCATE qualification_locks CASCADE`,
            sql`TRUNCATE qualification_results`,
          ],
          Effect.exit,
        )
      }),
    )

    expect(exits.every(Exit.isFailure)).toBe(true)
  })

  test('rolls back every table when a terminal evidence constraint fails', async () => {
    const input = makeInput()
    const invalid: PersistEvaluationInput = {
      ...input,
      evaluation: {
        ...input.evaluation,
        verdict: {
          ...input.evaluation.verdict,
          gates: input.evaluation.verdict.gates.map((gate, index) => (index === 0 ? { ...gate, name: '' } : gate)),
        },
      },
    }
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const error = yield* store.persist(invalid).pipe(Effect.flip)
        const sql = yield* PgClient.PgClient
        const counts = yield* sql<{
          runs: number
          protocols: number
          snapshots: number
          events: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM protocol_locks) AS protocols,
            (SELECT count(*)::integer FROM snapshot_references) AS snapshots,
            (SELECT count(*)::integer FROM evaluation_events) AS events
        `
        return { error, counts: counts[0] }
      }),
    )

    expect(result.error).toBeInstanceOf(DatabaseError)
    expect(result.error.failure).toBe('constraint')
    expect(result.counts).toEqual({ runs: 0, protocols: 0, snapshots: 0, events: 0 })
  })

  test('cancels an interrupted query and returns its pooled connection', async () => {
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const sleeper = yield* Effect.forkChild(sql`SELECT pg_sleep(30)`)
        yield* Effect.sleep('250 millis')
        yield* Fiber.interrupt(sleeper)
        return yield* sql<{ value: number }>`SELECT 1::integer AS value`.pipe(
          Effect.timeoutOrElse({
            duration: '2 seconds',
            orElse: () => Effect.fail(new Error('PostgreSQL pool did not recover')),
          }),
        )
      }),
    )

    expect(rows).toEqual([{ value: 1 }])
  })

  test('closes the PostgreSQL pool when its managed scope is disposed', async () => {
    const scoped = makeClientRuntime()
    const pid = await scoped.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
        return rows[0].pid
      }),
    )
    await scoped.dispose()

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid = ${pid}
        `
      }),
    )
    expect(rows).toEqual([{ count: 0 }])
  })

  test('reports an unreachable database as a typed availability failure', async () => {
    const invalid = makeEvidenceRuntime(makeConfig('postgresql://bayn:bayn@127.0.0.1:1/bayn_test'))
    try {
      const exit = await invalid.runPromiseExit(Effect.void)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error('unreachable PostgreSQL unexpectedly initialized')
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isNone(failure)) throw new Error(Cause.pretty(exit.cause))
      expect(failure.value).toBeInstanceOf(DatabaseError)
      expect((failure.value as DatabaseError).failure).toBe('unavailable')
    } finally {
      await invalid.dispose()
    }
  })
})
