import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Schema } from 'effect'

import auditReaderGrants from '../../migrations/0226_audit_reader_grants'
import auditReaderViewGrant from '../../migrations/0227_audit_reader_view_grant'
import executionQualityAuditViews from '../../migrations/0230_execution_quality_audit_views'
import { BaynKnowledge, strictKnowledge } from '../../tools/auto-ontology-knowledge'
import { localPostgresTestUrl } from '../../tools/postgres-test-databases'
import { Broker, OrderSide, OrderStatus } from '../execution/contracts'
import { sha256 } from '../hash'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { auditReaderGrantedRelnames } from './audit-reader-allowlist.test-support'
import { postgresMigrations } from './postgres-migrations'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const seedJson: unknown = await Bun.file(
  new URL('../../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url),
).json()
const seed = Schema.decodeUnknownSync(BaynKnowledge, strictKnowledge)(seedJson)
const auditLayer = () =>
  PgClient.layer({
    url: Redacted.make(localPostgresTestUrl(baynTestPostgresUrl).toString()),
    maxConnections: 1,
  }).pipe(Layer.provideMerge(NodeServices.layer))

const qualityAccount = 'fixture-execution-quality'
const qualityStrategy = 'bayn.intraday-alpha-policy.v3'
const seedExecutionQuality = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const cycle = sha256('quality-cycle')
  const intent = sha256('quality-intent')
  const generation = sha256('quality-generation')
  const parentGeneration = sha256('quality-observe')
  const reconciliation = sha256('quality-reconciliation')
  const hash = sha256('quality-fixture')
  const at = '2026-11-25T14:30:00Z'
  yield* sql`INSERT INTO public.reconciliations (reconciliation_id, schema_version, account_id, expected_hash,
    observed_hash, content_hash, status, discrepancies, reconciled_at)
    VALUES (${reconciliation}, 'bayn.paper-reconciliation.v1', ${qualityAccount}, ${hash}, ${hash}, ${hash}, 'EXACT', '[]', ${at})`
  yield* sql`INSERT INTO public.authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
    VALUES (${parentGeneration}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${at})`
  yield* sql`INSERT INTO public.authority_generations (generation_hash, schema_version, activation_schema_version,
    previous_generation_hash, maximum, authority_version, activation_source_revision, activation_image_repository,
    activation_image_digest, strategy_name, strategy_behavior_hash, strategy_parameter_hash, strategy_parameter_schema_version,
    strategy_protocol_hash, account_id, broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
    risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash, research_plan_hash, activated_at)
    VALUES (${generation}, 'bayn.authority-generation-history.v1', 'bayn.paper-authority-generation.v3',
    ${parentGeneration}, 'PAPER', 2, ${hash.slice(0, 40)}, 'registry.example/bayn', ${`sha256:${hash}`},
    'jev', ${hash}, ${hash}, ${qualityStrategy}, ${hash}, ${qualityAccount}, 'bayn.broker-identity.v2', ${hash}, 'alpaca',
    'sandbox', ${hash}, ${hash}, ${reconciliation}, ${hash}, ${hash}, ${at})`
  yield* sql`INSERT INTO public.autonomous_cycles (cycle_id, schema_version, identity_schema_version, strategy_name,
    qualification_run_id, strategy_protocol_hash, account_id, execution_policy_schema_version, execution_policy_hash,
    strategy_execution_model_hash, submission_window_ms, warmup_after_open_ms, submission_cutoff_before_close_ms,
    window_schema_version, execution_calendar_schema_version, execution_calendar_source, execution_calendar_hash,
    execution_session_date, submission_open_at, execution_open_at, execution_close_at, submission_cutoff_at,
    state, state_version, created_at, updated_at)
    VALUES (${cycle}, 'bayn.autonomous-cycle.v4', 'bayn.autonomous-cycle-identity.v4', 'jev',
    ${hash}, ${hash}, ${qualityAccount}, 'bayn.autonomous-cycle-execution-policy.v3', ${hash},
    ${hash}, 21600000, 600000, 1200000, 'bayn.autonomous-cycle-window.v3',
    'bayn.alpaca-market-calendar-observation.v2', 'alpaca-v2-calendar', ${hash}, '2026-11-25',
    '2026-11-25T14:40:00Z', ${at}, '2026-11-25T21:00:00Z', '2026-11-25T20:40:00Z', 'PENDING', 1, ${at}, ${at})`
  yield* sql`INSERT INTO public.intents (intent_id, schema_version, account_id, client_order_id, symbol, side,
    order_type, time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state,
    created_at, updated_at, cycle_id, strategy_name, decision_hash, policy_hash, authority_generation_hash)
    VALUES (${intent}, 'bayn.execution-intent.v5', ${qualityAccount}, 'entry-client', 'QQQ', ${OrderSide.Buy}, 'LIMIT',
    'DAY', 3000000000, 300000000, 100000000, 'PLANNED', ${at}, ${at}, ${cycle}, 'jev', ${hash}, ${hash}, ${generation})`
  const expiresAt = '2026-11-25T21:00:00Z'
  const decision = {
    schemaVersion: 'bayn.paper-cycle-decision.v2',
    contentHash: sha256('quality-decision'),
    mode: 'PAPER',
    createdAt: at,
    expiresAt,
    submissionCutoffAt: expiresAt,
    bindings: {
      cycleId: cycle,
      accountId: qualityAccount,
      strategyDecisionHash: hash,
      policyHash: hash,
      authorityGenerationHash: generation,
    },
    orderedIntentIds: [intent],
    targetPlan: { targets: [{ symbol: 'QQQ', referencePriceMicros: '97000000' }] },
  }
  yield* sql`INSERT INTO public.autonomous_cycle_paper_close_replans (content_hash, cycle_id, document, created_at, expires_at)
    VALUES (${hash}, ${cycle}, ${sql.json({
      schemaVersion: 'bayn.paper-cycle-closure.v1',
      contentHash: hash,
      cycleId: cycle,
      createdAt: at,
      expiresAt,
      document: decision,
    })}, ${at}, ${expiresAt})`
  const submit = sha256('quality-submit')
  yield* sql`INSERT INTO public.mutation_events (event_id, schema_version, mutation_id, intent_id, sequence,
    operation, event_type, request_hash, consistency_delay_ms, occurred_at)
    VALUES (${submit}, 'bayn.paper-mutation-event.v1', ${submit}, ${intent}, 1, 'SUBMIT', 'SUBMIT_STARTED',
      ${hash}, 1000, '2026-11-25T14:40:00Z')`
  // Seed the retained admission in this rolled-back transaction. The writer trigger requires a prior commit.
  yield* sql`ALTER TABLE public.execution_decision_admissions DISABLE TRIGGER execution_decision_admission_guard`
  yield* sql`INSERT INTO public.execution_decision_admissions (event_id, decision_id) VALUES (${submit}, ${decision.contentHash})`
  yield* sql`ALTER TABLE public.execution_decision_admissions ENABLE TRIGGER execution_decision_admission_guard`

  let sequence = 0
  const event = (kind: 'ORDER' | 'FILL', account: string, id: string, timestamp: string) =>
    Effect.gen(function* () {
      const eventId = sha256(`${account}:${kind}:${id}:${timestamp}`)
      yield* sql`INSERT INTO public.broker_events (event_id, schema_version, content_hash, event_kind, broker,
        account_id, source_event_id, source_sequence, occurred_at, observed_at)
        VALUES (${eventId}, 'bayn.paper-broker-event.v1', ${hash}, ${kind}, ${Broker.Alpaca}, ${account},
          ${kind === 'ORDER' ? `order:${id}:${timestamp}` : `fill:${id}`}, ${++sequence}, ${timestamp}, ${timestamp})`
      return eventId
    })
  const order = (
    id: string,
    status: OrderStatus,
    timestamp: string,
    options: {
      readonly filled?: number
      readonly limit?: number
      readonly side?: OrderSide
      readonly parent?: string
      readonly account?: string
      readonly symbol?: string
      readonly unbound?: boolean
    } = {},
  ) =>
    Effect.gen(function* () {
      const account = options.account ?? qualityAccount
      const eventId = yield* event('ORDER', account, id, timestamp)
      yield* sql`INSERT INTO public.orders (event_id, account_id, schema_version, broker_order_id, client_order_id, intent_id,
        symbol, side, order_type, time_in_force, quantity_atoms, filled_quantity_atoms, limit_price_micros,
        parent_broker_order_id, status, broker_updated_at)
        VALUES (${eventId}, ${account}, 'bayn.order.v3', ${id}, ${options.parent === undefined ? 'entry-client' : 'child-client'},
        ${options.parent === undefined && options.symbol === undefined && options.unbound !== true ? intent : null}, ${options.symbol ?? 'QQQ'},
        ${options.side ?? OrderSide.Buy}, 'LIMIT', 'DAY', 3000000000, ${(options.filled ?? 0) * 1_000_000_000},
        ${options.limit ?? 100_000_000}, ${options.parent ?? null}, ${status}, ${timestamp})`
    })
  const fill = (
    id: string,
    orderId: string,
    timestamp: string,
    symbol: string,
    side: OrderSide,
    quantity: number,
    price: number,
    fee: number,
  ) =>
    Effect.gen(function* () {
      const eventId = yield* event('FILL', qualityAccount, id, timestamp)
      yield* sql`INSERT INTO public.fills (event_id, account_id, schema_version, fill_id, broker_order_id,
        client_order_id, symbol, side, quantity_atoms, price_atoms, fee_micros, source_timestamp)
        VALUES (${eventId}, ${qualityAccount}, 'bayn.fill.v2', ${id}, ${orderId},
        ${side === OrderSide.Buy ? 'entry-client' : 'child-client'}, ${symbol}, ${side}, ${quantity * 1_000_000_000},
        ${price * 1_000_000_000}, ${fee}, ${timestamp})`
    })
  // The latest provider update crosses New York midnight, but older versions arrived later.
  yield* order('entry', OrderStatus.Filled, '2026-11-26T05:01:00.000000000Z', { filled: 3, limit: 101_000_000 })
  yield* order('entry', OrderStatus.PartiallyFilled, '2026-11-26T04:57:00.000000000Z', { filled: 1 })
  yield* order('entry', OrderStatus.New, '2026-11-26T04:55:00.000000000Z', { unbound: true })
  yield* order('retry', OrderStatus.Canceled, '2026-11-26T04:58:00.000000000Z')
  yield* order('child', OrderStatus.Canceled, '2026-11-26T04:59:00.000000000Z', {
    side: OrderSide.Sell,
    parent: 'entry',
    filled: 1,
    limit: 101_000_000,
  })
  yield* order('expired', OrderStatus.Expired, '2026-11-26T04:59:00.000000000Z')
  yield* order('pending', OrderStatus.Pending, '2026-11-26T04:58:00.000000000Z', { symbol: 'SMH' })
  yield* order('unmatched', OrderStatus.New, '2026-11-26T04:58:00.000000000Z', {
    account: 'other-fixture',
    symbol: 'SMH',
  })
  yield* fill('entry-one', 'entry', '2026-11-26T04:56:00.000000000Z', 'QQQ', OrderSide.Buy, 1, 99, 100_000)
  yield* fill('entry-two', 'entry', '2026-11-26T04:58:00.000000000Z', 'QQQ', OrderSide.Buy, 2, 98, 195_000)
  yield* fill('exit-one', 'child', '2026-11-26T04:58:30.000000000Z', 'QQQ', OrderSide.Sell, 1, 102, 0)
  yield* fill('no-order', 'unmatched', '2026-11-26T04:59:00.000000000Z', 'SMH', OrderSide.Buy, 1, 50, 0)
  yield* fill('after-bound', 'unmatched', '2026-11-26T05:00:00.000000000Z', 'SMH', OrderSide.Buy, 1, 50, 0)
})

integration('Bayn audit reader grants', () => {
  test('migrates without CNPG and grants only the audit allowlist including ontology views when its login exists', async () => {
    const rollback = Symbol('discard test role and grants')
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* postgresMigrations
        expect(
          yield* sql`SELECT migration_id, name FROM schema_migrations WHERE migration_id IN (226, 227, 230) ORDER BY migration_id`,
        ).toEqual([
          { migration_id: 226, name: 'audit_reader_grants' },
          { migration_id: 227, name: 'audit_reader_view_grant' },
          { migration_id: 230, name: 'execution_quality_audit_views' },
        ])
        expect(yield* sql`SELECT rolname FROM pg_roles WHERE rolname = 'bayn_audit_ro'`).toEqual([])

        // PostgreSQL roles are cluster-wide. Roll the test role back even on success.
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE ROLE bayn_audit_ro LOGIN NOINHERIT`
              // Require the migrations' explicit schema grant rather than PostgreSQL's default grant to PUBLIC.
              yield* sql`REVOKE USAGE ON SCHEMA public FROM PUBLIC`
              yield* auditReaderGrants
              yield* auditReaderViewGrant
              yield* auditReaderViewGrant
              yield* executionQualityAuditViews
              yield* executionQualityAuditViews
              yield* sql`SET LOCAL ROLE bayn_audit_ro`
              expect(
                yield* sql`
                SELECT has_schema_privilege('public', 'USAGE') AS usage,
                  has_schema_privilege('public', 'CREATE') AS create
              `,
              ).toEqual([{ usage: true, create: false }])
              const granted = yield* sql<{ readonly relname: string; readonly full_table: boolean }>`
                  SELECT c.relname, has_table_privilege(c.oid, 'SELECT') AS full_table
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
                    AND has_any_column_privilege(c.oid, 'SELECT')
                  ORDER BY c.relname COLLATE "C"
                `
              expect(granted).toEqual(auditReaderGrantedRelnames.map((relname) => ({ relname, full_table: true })))
              const grantedSet = new Set(granted.map(({ relname }) => `public.${relname}`))
              const ontologyRelations = [
                ...new Set(seed.analyses.flatMap(({ referencedTables }) => referencedTables)),
              ].toSorted()
              expect(ontologyRelations.filter((relation) => !grantedSet.has(relation))).toEqual([])
              expect(
                yield* sql`
                SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
                  AND (has_table_privilege(c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
                    OR has_any_column_privilege(c.oid, 'INSERT, UPDATE, REFERENCES, SELECT WITH GRANT OPTION'))
              `,
              ).toEqual([])
              expect(yield* sql`SELECT 1 FROM public.orders LIMIT 0`).toEqual([])
              expect(yield* sql`SELECT 1 FROM public.broker_fee_accounting_evidence LIMIT 0`).toEqual([])
              for (const analysis of seed.analyses) {
                const rows = yield* sql.unsafe(analysis.sql, [
                  'fixture-account',
                  '2026-11-25T05:00:00Z',
                  '2026-11-26T05:00:00Z',
                ])
                expect(rows).toEqual([])
              }
              const deniedUnderlying = yield* sql
                .withTransaction(sql`SELECT 1 FROM public.broker_fee_match_corrections LIMIT 0`)
                .pipe(Effect.result)
              expect(deniedUnderlying).toMatchObject({
                _tag: 'Failure',
                failure: { reason: { cause: { code: '42501' } } },
              })
              const deniedAdmission = yield* sql
                .withTransaction(sql`SELECT 1 FROM public.execution_decision_admissions LIMIT 0`)
                .pipe(Effect.result)
              expect(deniedAdmission).toMatchObject({
                _tag: 'Failure',
                failure: { reason: { cause: { code: '42501' } } },
              })
              const write = yield* sql.withTransaction(sql`DELETE FROM public.orders WHERE false`).pipe(Effect.result)
              expect(write).toMatchObject({ _tag: 'Failure', failure: { reason: { cause: { code: '42501' } } } })
              return yield* Effect.fail(rollback)
            }),
          )
          .pipe(Effect.flip)
        expect(result).toBe(rollback)
      }).pipe(Effect.provide(auditLayer())),
    )
  }, 30_000)

  test('saved execution analyses read distinct orders, weighted price metrics and fill fee drag as the audit role', async () => {
    const rollback = Symbol('discard execution quality fixtures and test role')
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* postgresMigrations
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* seedExecutionQuality
              yield* sql`CREATE ROLE bayn_audit_ro LOGIN NOINHERIT`
              yield* executionQualityAuditViews
              yield* sql`SET LOCAL ROLE bayn_audit_ro`
              const analysis = (name: string) => {
                const query = seed.analyses.find((item) => item.name === `Bayn: ${name}`)
                if (query === undefined) throw new Error(`Missing saved analysis: ${name}`)
                return sql.unsafe<Record<string, unknown>>(query.sql, [
                  qualityAccount,
                  '2026-11-25T05:00:00Z',
                  '2026-11-26T05:00:00Z',
                ])
              }
              const orders = yield* analysis('Daily execution order churn')
              expect(orders).toHaveLength(2)
              const boundOrders = orders.find((row) => row['symbol'] === 'QQQ')
              expect(boundOrders).toMatchObject({
                strategy_name: 'jev',
                strategy_parameter_schema_version: qualityStrategy,
                order_count: 4n,
                filled_orders: 1n,
                canceled_orders: 2n,
                expired_orders: 1n,
                partially_filled_orders: 0n,
                partially_executed_orders: 1n,
                filled_intents: 1n,
              })
              expect(Number(boundOrders?.['cancel_ratio'])).toBeCloseTo(2 / 3, 12)
              expect(Number(boundOrders?.['partial_fill_rate'])).toBe(0.25)
              expect(Number(boundOrders?.['orders_per_filled_intent'])).toBe(4)
              expect(orders.find((row) => row['symbol'] === 'SMH')).toMatchObject({
                strategy_name: null,
                pending_orders: 1n,
                cancel_ratio: null,
                orders_per_filled_intent: null,
              })

              const fills = yield* analysis('Daily execution fill slippage')
              expect(fills).toHaveLength(3)
              const buy = fills.find((row) => row['symbol'] === 'QQQ' && row['side'] === OrderSide.Buy)
              expect(buy).toMatchObject({
                fill_count: 2n,
                limit_benchmark_fill_count: 2n,
                reference_benchmark_fill_count: 2n,
              })
              expect(Number(buy?.['total_notional_micros'])).toBe(295_000_000)
              expect(Number(buy?.['fill_fee_bps'])).toBe(10)
              expect(Number(buy?.['limit_price_improvement_bps'])).toBeCloseTo(50_000 / 300, 10)
              expect(Number(buy?.['reference_slippage_bps'])).toBeCloseTo(40_000 / 291, 10)
              const sell = fills.find((row) => row['side'] === OrderSide.Sell)
              expect(sell).toMatchObject({
                strategy_name: 'jev',
                fill_count: 1n,
                reference_benchmark_fill_count: 0n,
                reference_slippage_bps: null,
              })
              expect(Number(sell?.['limit_price_improvement_bps'])).toBeCloseTo(10_000 / 101, 10)
              expect(fills.find((row) => row['symbol'] === 'SMH')).toMatchObject({
                strategy_name: null,
                fill_count: 1n,
                limit_benchmark_fill_count: 0n,
                limit_price_improvement_bps: null,
                reference_benchmark_fill_count: 0n,
                reference_slippage_bps: null,
              })

              const fees = yield* analysis('Session fill fee drag')
              expect(fees).toHaveLength(2)
              const strategyFees = fees.find((row) => row['symbol'] === 'QQQ')
              expect(strategyFees).toMatchObject({ fill_count: '3', total_fill_fee_micros: '295000' })
              expect(Number(strategyFees?.['total_notional_micros'])).toBe(397_000_000)
              expect(Number(strategyFees?.['fill_fee_bps'])).toBeCloseTo((295_000 * 10_000) / 397_000_000, 10)
              return yield* Effect.fail(rollback)
            }),
          )
          .pipe(Effect.flip)
        expect(result).toBe(rollback)
      }).pipe(Effect.provide(auditLayer())),
    )
  }, 30_000)
})
