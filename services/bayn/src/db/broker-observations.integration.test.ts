import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { observedBrokerSnapshotHash, type BrokerObservationTicket } from '../broker/alpaca/observed-snapshot'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { makeBrokerObservationStore } from './broker-observations'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const accountId = 'broker-observations-test-account'
const revision = 'a'.repeat(40)
const generationHash = 'b'.repeat(64)
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55449/bayn_broker_observations_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 5000,
      postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
const snapshot = (ticket: BrokerObservationTicket) => observedBrokerSnapshotFixture(accountId, ticket.startedAt)
const advanceToTicket = (ticket: BrokerObservationTicket, delta = 0) =>
  TestClock.setTime(Date.parse(ticket.startedAt) + delta)
const reserve = (sql: PgClient.PgClient, id: string, at: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
    VALUES (${generationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${at}) ON CONFLICT DO NOTHING`
    yield* sql`INSERT INTO intents (intent_id, schema_version, authority_generation_hash, strategy_name, cycle_id, decision_hash, policy_hash,
    account_id, client_order_id, symbol, side, order_type, time_in_force, quantity_micros, notional_limit_micros, state, created_at, updated_at)
    VALUES (${id}, 'bayn.paper-intent.v3', ${generationHash}, 'intraday-momentum', ${'c'.repeat(64)}, ${id}, ${'e'.repeat(64)},
      ${accountId}, ${id.slice(0, 32)}, 'AAPL', 'BUY', 'LIMIT', 'IOC', 1000000, 1000000000, 'PLANNED', ${at}, ${at})`
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO risk_decisions (decision_id, schema_version, input_hash, intent_id, policy_hash, outcome, reason_codes, decided_at, expires_at)
      VALUES (${id}, 'bayn.paper-risk-decision.v1', ${'f'.repeat(64)}, ${id}, ${'e'.repeat(64)}, 'APPROVED', ARRAY[]::text[], ${at}, '2099-01-01T00:00:00Z')`
        yield* sql`UPDATE intents SET risk_decision_id = ${id}, state = 'APPROVED', state_version = 2, updated_at = updated_at + interval '1 millisecond' WHERE intent_id = ${id}`
      }),
    )
    yield* sql`UPDATE intents SET state = 'IO_STARTED', state_version = 3, updated_at = updated_at + interval '1 millisecond' WHERE intent_id = ${id}`
    yield* sql`INSERT INTO mutation_events (event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type, request_hash, consistency_delay_ms, occurred_at)
    VALUES (${id}, 'bayn.paper-mutation-event.v1', ${id}, ${id}, 1, 'SUBMIT', 'SUBMIT_STARTED', ${'f'.repeat(64)}, 1000, ${at})`
  })

describePostgres('Durable per-account broker observations', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Observation integration tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    ),
  )
  afterAll(async () => runtime?.dispose())
  const run = <A, E>(
    effect: (sql: PgClient.PgClient, store: ReturnType<typeof makeBrokerObservationStore>) => Effect.Effect<A, E>,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* effect(sql, makeBrokerObservationStore(sql, accountId, revision, 60_000))
      }).pipe(Effect.provide(TestClock.layer())),
    )

  test('starts unavailable, publishes a complete cut and survives a reader restart', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        const ticket = yield* store.begin
        yield* advanceToTicket(ticket)
        expect(yield* store.publish(ticket, snapshot(ticket))).toBe(true)
        const restarted = makeBrokerObservationStore(sql, accountId, revision, 60_000)
        expect(yield* restarted.read).toEqual(snapshot(ticket))
        expect(observedBrokerSnapshotHash(yield* restarted.read)).toBe(observedBrokerSnapshotHash(snapshot(ticket)))
        yield* advanceToTicket(ticket, 60_000)
        expect(Result.isFailure(yield* restarted.read.pipe(Effect.result))).toBe(true)
      }),
    ))
  test.each(['invalidate', 'failed', 'new-ticket', 'revision'] as const)(
    'rejects late publication after %s',
    async (change) =>
      run((sql, store) =>
        Effect.gen(function* () {
          yield* store.activate
          const ticket = yield* store.begin
          yield* advanceToTicket(ticket)
          if (change === 'invalidate') yield* store.invalidate
          if (change === 'failed') {
            const next = yield* store.begin
            yield* store.failed(next)
          }
          if (change === 'new-ticket') yield* store.begin
          if (change === 'revision') yield* makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000).activate
          expect(yield* store.publish(ticket, snapshot(ticket))).toBe(false)
          expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        }),
      ),
  )
  test('latest poll failure closes a previously fresh projection and cannot overwrite a newer poll', async () =>
    run((_sql, store) =>
      Effect.gen(function* () {
        yield* store.activate
        const first = yield* store.begin
        yield* advanceToTicket(first)
        yield* store.publish(first, snapshot(first))
        const second = yield* store.begin
        yield* store.failed(second)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        const third = yield* store.begin
        yield* advanceToTicket(third)
        yield* store.publish(third, snapshot(third))
        yield* store.failed(second)
        expect(yield* store.read).toEqual(snapshot(third))
      }),
    ))
  test('permits only the currently reserved intent start and denies concurrent starts', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate
        const ticket = yield* store.begin
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket))
        const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 1)
        const firstId = '1'.repeat(64)
        const secondId = '2'.repeat(64)
        yield* reserve(sql, firstId, at)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(yield* store.readForSubmit(firstId)).toEqual(snapshot(ticket))
        expect(Result.isFailure(yield* store.readForSubmit(secondId).pipe(Effect.result))).toBe(true)
        yield* reserve(sql, secondId, at)
        expect(Result.isFailure(yield* store.readForSubmit(firstId).pipe(Effect.result))).toBe(true)
        expect(Result.isFailure(yield* store.readForSubmit(secondId).pipe(Effect.result))).toBe(true)
      }),
    ))
  test('rejects mixed, corrupt and foreign-account persisted bytes', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate
        const ticket = yield* store.begin
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket))
        yield* sql`UPDATE broker_observations SET payload = jsonb_set(payload, '{snapshot,account,value,cashMicros}', '"0"'::jsonb)`
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        const foreign = observedBrokerSnapshotFixture('other-account', ticket.startedAt)
        expect(Result.isFailure(yield* store.publish(ticket, foreign).pipe(Effect.result))).toBe(true)
      }),
    ))
  test.each(['SUBMIT_STARTED', 'SUBMIT_UNKNOWN'] as const)(
    'retains reconciliation evidence while an old unresolved %s blocks submission',
    async (eventType) =>
      run((sql, store) =>
        Effect.gen(function* () {
          yield* store.activate
          const ticket = yield* store.begin
          yield* advanceToTicket(ticket)
          const id = '3'.repeat(64)
          const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) - 10_000)
          yield* reserve(sql, id, at)
          if (eventType === 'SUBMIT_UNKNOWN')
            yield* sql`INSERT INTO mutation_events
        (event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type, request_hash, consistency_delay_ms, occurred_at)
        VALUES (${'4'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${id}, ${id}, 2, 'SUBMIT', ${eventType}, ${'f'.repeat(64)}, 1000, ${at})`
          expect(yield* store.publish(ticket, snapshot(ticket))).toBe(true)
          expect(yield* store.read).toEqual(snapshot(ticket))
          const candidate = '8'.repeat(64)
          yield* reserve(sql, candidate, utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 1))
          expect(Result.isFailure(yield* store.readForSubmit(candidate).pipe(Effect.result))).toBe(true)
        }),
      ),
  )
  test.each([500, 2000])(
    'requires a settled mutation to precede the poll by the consistency delay: %s ms',
    async (ageMs) =>
      run((sql, store) =>
        Effect.gen(function* () {
          yield* store.activate
          const ticket = yield* store.begin
          yield* advanceToTicket(ticket)
          const id = '5'.repeat(64)
          const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) - ageMs)
          yield* reserve(sql, id, at)
          yield* sql`INSERT INTO mutation_events
        (event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type, request_hash, consistency_delay_ms, occurred_at)
        VALUES (${'6'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${id}, ${id}, 2, 'SUBMIT', 'SUBMIT_REJECTED', ${'f'.repeat(64)}, 1000, ${at})`
          expect(yield* store.publish(ticket, snapshot(ticket))).toBe(ageMs > 1000)
        }),
      ),
  )
  test('a retained fill invalidates the published cut and rejects a late poll', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate
        const ticket = yield* store.begin
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket))
        const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 1)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO broker_events (event_id, schema_version, content_hash, event_kind, broker, account_id,
          source_event_id, source_sequence, occurred_at, observed_at) VALUES (${'7'.repeat(64)}, 'bayn.paper-broker-event.v1',
          ${'7'.repeat(64)}, 'FILL', 'ALPACA', ${accountId}, 'new-fill', 1, ${at}, ${at})`
            yield* sql`INSERT INTO fills (event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id,
          symbol, side, quantity_micros, price_micros, fee_micros, source_timestamp)
          VALUES (${'7'.repeat(64)}, ${accountId}, 'bayn.paper-fill.v1', 'new-fill', 'new-order', 'new-client',
          'AAPL', 'BUY', '1000000', '100000000', '0', ${at.replace('Z', '000000Z')})`
          }),
        )
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(yield* store.publish(ticket, snapshot(ticket))).toBe(false)
      }),
    ))
})
