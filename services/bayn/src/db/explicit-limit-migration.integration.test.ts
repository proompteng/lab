import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import type { SqlClient } from 'effect/sql'

import explicitLimitMigration from '../../migrations/0121_explicit_limit_intents'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { migrationLoader } from './migrations'
import { PostgresClientLive } from './postgres-client'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 10_000,
      postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )

const insertIntent = (
  terms: {
    readonly legacy?: boolean
    readonly terminal?: boolean
    readonly symbol?: string
    readonly orderType?: string
    readonly timeInForce?: string
    readonly side?: string
    readonly quantity?: string
    readonly price?: string | null
    readonly notional?: string
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const identity = 'a'.repeat(64)
    const common = {
      intent_id: identity,
      schema_version: terms.legacy === true ? 'bayn.paper-intent.v3' : 'bayn.execution-intent.v4',
      risk_decision_id: terms.terminal === true ? 'b'.repeat(64) : null,
      authority_generation_hash: 'c'.repeat(64),
      strategy_name: 'jev',
      cycle_id: 'd'.repeat(64),
      decision_hash: 'e'.repeat(64),
      policy_hash: 'f'.repeat(64),
      account_id: 'paper-migration-test',
      client_order_id: 'b1_' + 'A'.repeat(43),
      symbol: terms.symbol ?? 'AAPL',
      side: terms.side ?? 'BUY',
      order_type: terms.orderType ?? 'LIMIT',
      time_in_force: terms.timeInForce ?? 'DAY',
      quantity_atoms: terms.quantity ?? '1000',
      notional_limit_micros: terms.notional ?? '101',
      state: terms.terminal === true ? 'TERMINAL' : 'PLANNED',
      terminal_outcome: terms.terminal === true ? 'FILLED' : null,
      created_at: '2026-10-18T12:00:00.000Z',
      updated_at: '2026-10-18T12:00:00.000Z',
    }
    yield* sql`INSERT INTO intents ${sql.insert(
      terms.legacy === true
        ? common
        : {
            ...common,
            limit_price_micros: terms.price === undefined ? '100010000' : terms.price,
          },
    )}`
  })

describePostgres('explicit LIMIT database cutover', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(async () => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Migration tests require a local _test database')
    runtime = makeRuntime()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((migrations) => migrations.filter(([id]) => id < 121))),
          table: 'schema_migrations',
        })
      }),
    )
  })
  afterAll(async () => runtime.dispose())

  const runCase = <A, E>(program: Effect.Effect<A, E, PgClient.PgClient | SqlClient.SqlClient>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // Clone real pre-cutover checks without rewriting immutable historical evidence.
            yield* sql`CREATE TEMP TABLE intents (LIKE public.intents INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE mutation_events (intent_id text, operation text, sequence bigint, event_type text) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycles (decision_hash text, terminal_at timestamptz) ON COMMIT DROP`
            return yield* program
          }),
        )
      }),
    )

  test('preserves historical terminal rows and enforces new writes without validating old bytes', async () =>
    runCase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* insertIntent({ legacy: true, terminal: true, orderType: 'MARKET' })
        const before = yield* sql`SELECT to_jsonb(i) AS row FROM intents i`
        yield* explicitLimitMigration
        const after = yield* sql`SELECT to_jsonb(i) - 'limit_price_micros' AS row FROM intents i`
        expect(after).toEqual(before)
        expect(yield* sql`SELECT limit_price_micros FROM intents`).toEqual([{ limit_price_micros: null }])
        expect(
          yield* sql`SELECT convalidated FROM pg_constraint
        WHERE conrelid='pg_temp.intents'::regclass AND conname IN
          ('intents_schema_version_check','intents_explicit_limit_terms_check')`,
        ).toEqual([{ convalidated: false }, { convalidated: false }])
      }),
    ))

  test('refuses unresolved intent state atomically', async () =>
    runCase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* insertIntent({ legacy: true })
        const result = yield* sql.withTransaction(explicitLimitMigration).pipe(Effect.result)
        expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: { cause: { code: '55000' } } } })
        expect(
          yield* sql`SELECT attname FROM pg_attribute WHERE attrelid='pg_temp.intents'::regclass AND attname='limit_price_micros'`,
        ).toEqual([])
        expect(yield* sql`SELECT state FROM intents`).toEqual([{ state: 'PLANNED' }])
      }),
    ))

  test('refuses a bound unfinished cycle after its intents settle and admits an unbound admission', async () =>
    runCase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* insertIntent({ legacy: true, terminal: true })
        yield* sql`INSERT INTO autonomous_cycles VALUES (${'d'.repeat(64)},NULL),(NULL,NULL)`
        const result = yield* sql.withTransaction(explicitLimitMigration).pipe(Effect.result)
        expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: { cause: { code: '55000' } } } })
        yield* sql`UPDATE autonomous_cycles SET terminal_at=clock_timestamp() WHERE decision_hash IS NOT NULL`
        yield* explicitLimitMigration
      }),
    ))

  test.each(['SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'CANCEL_STARTED', 'CANCEL_UNKNOWN', 'RECOVERY_UNKNOWN'])(
    'refuses the latest unresolved mutation %s even when its intent is terminal',
    async (eventType) =>
      runCase(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* insertIntent({ legacy: true, terminal: true })
          yield* sql`INSERT INTO mutation_events VALUES (${'a'.repeat(64)},'SUBMIT',1,${eventType})`
          const result = yield* sql.withTransaction(explicitLimitMigration).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: { cause: { code: '55000' } } })
          yield* sql`INSERT INTO mutation_events VALUES (${'a'.repeat(64)},'SUBMIT',2,'RECOVERY_FOUND')`
          yield* explicitLimitMigration
        }),
      ),
  )

  test.each([
    { price: null },
    { price: '0' },
    { price: '340282366920938463463374607431768211456' },
    { orderType: 'MARKET' },
    { timeInForce: 'GTC' },
    { timeInForce: 'IOC' },
    { symbol: 'BTC/USD', timeInForce: 'DAY' },
    { notional: '100' },
    { side: 'SELL', notional: '101' },
    { legacy: true },
  ])('rejects invalid new LIMIT terms: %j', async (terms) =>
    runCase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* explicitLimitMigration
        const result = yield* sql.withTransaction(insertIntent(terms)).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: { cause: { code: '23514' } } })
        expect(yield* sql`SELECT intent_id FROM intents`).toEqual([])
      }),
    ),
  )

  test.each([
    { symbol: 'AAPL', side: 'BUY', timeInForce: 'DAY', notional: '101' },
    ...['BTC/USD', 'ETH/USD', 'SOL/USD'].flatMap((symbol) => [
      { symbol, side: 'BUY', timeInForce: 'IOC', notional: '101' },
      { symbol, side: 'SELL', timeInForce: 'IOC', notional: '100' },
    ]),
  ])('retains the exact explicit price and rounded notional: %j', async (terms) =>
    runCase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* explicitLimitMigration
        yield* insertIntent(terms)
        expect(
          yield* sql`SELECT limit_price_micros::text AS price, notional_limit_micros::text AS notional FROM intents`,
        ).toEqual([{ price: '100010000', notional: terms.notional }])
        yield* sql`CREATE TRIGGER explicit_price_immutable BEFORE UPDATE ON intents FOR EACH ROW EXECUTE FUNCTION enforce_intent_transition()`
        const result = yield* sql
          .withTransaction(sql`UPDATE intents SET limit_price_micros=100020000,
      state_version=state_version+1,updated_at=updated_at+interval '1 millisecond'`)
          .pipe(Effect.result)
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { reason: { cause: { code: '55000', message: 'intent immutable fields cannot change' } } },
        })
        expect(yield* sql`SELECT limit_price_micros::text AS price FROM intents`).toEqual([{ price: '100010000' }])
      }),
    ),
  )
})
