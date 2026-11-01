import { canonicalHashV1Result } from '../hash'
import { ValkeyCacheError } from '../valkey-cache'
import { valkeyFixture } from '../testing/valkey-fixture'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { observedBrokerState, type BrokerObservationTicket } from '../broker/alpaca/observed-snapshot'
import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { BrokerObservationClaimStatus, makeBrokerObservationStore } from './broker-observations'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

let cacheFixture = valkeyFixture()
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
const claim = (store: ReturnType<typeof makeBrokerObservationStore>, captureId = randomUUID()) =>
  store
    .begin(captureId, 0)
    .pipe(
      Effect.flatMap((claim) =>
        claim.status === BrokerObservationClaimStatus.Reserved
          ? Effect.succeed(claim.ticket)
          : Effect.die('Expected a new capture claim'),
      ),
    )
const snapshot = (ticket: BrokerObservationTicket) => observedBrokerSnapshotFixture(accountId, ticket.startedAt)
const advanceToTicket = (ticket: BrokerObservationTicket, delta = 0) =>
  TestClock.setTime(Date.parse(ticket.startedAt) + delta)
const reserve = (sql: PgClient.PgClient, id: string, at: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
    VALUES (${generationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${at}) ON CONFLICT DO NOTHING`
    yield* sql`INSERT INTO intents (intent_id, schema_version, authority_generation_hash, strategy_name, cycle_id, decision_hash, policy_hash,
    account_id, client_order_id, symbol, side, order_type, time_in_force, quantity_atoms, notional_limit_micros, limit_price_micros, state, created_at, updated_at)
    VALUES (${id}, 'bayn.execution-intent.v5', ${generationHash}, 'intraday-momentum', ${'c'.repeat(64)}, ${id}, ${'e'.repeat(64)},
      ${accountId}, ${id.slice(0, 32)}, 'AAPL', 'BUY', 'LIMIT', 'DAY', 1000000, 1000000000, 1000000000000, 'PLANNED', ${at}, ${at})`
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
  beforeEach(async () => {
    cacheFixture = valkeyFixture()
    return runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
  })
  afterAll(async () => runtime?.dispose())
  const run = <A, E>(
    effect: (sql: PgClient.PgClient, store: ReturnType<typeof makeBrokerObservationStore>) => Effect.Effect<A, E>,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* effect(sql, makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache))
      }).pipe(Effect.provide(TestClock.layer())),
    )

  test('hard migration removes the database payload and compact reads retain the exact parent snapshot', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        const columns = yield* sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'broker_observations' AND column_name = 'payload'`
        expect(columns).toEqual([])
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        const value = snapshot(ticket)
        yield* store.publish(ticket, value, 0)
        expect(yield* store.readState).toEqual(observedBrokerState(value))
        yield* sql`UPDATE broker_observations SET snapshot_hash = ${'0'.repeat(64)} WHERE account_id = ${accountId}`
        expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
      }),
    ))

  test('missing or corrupt Valkey bytes fail without a database payload fallback', async () =>
    run((_sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket), 0)
        cacheFixture.values.clear()
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
        yield* store.publish(ticket, snapshot(ticket), 0)
        for (const [key, value] of cacheFixture.values)
          if (key.startsWith('bayn:broker:state:')) cacheFixture.values.set(key, { ...value, value: 'invalid-json' })
        expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
      }),
    ))

  test('failed cache publication cannot expose availability or settle a capture claim', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        const failed = makeBrokerObservationStore(sql, accountId, revision, 60_000, {
          ...cacheFixture.cache,
          put: () => Effect.fail(new ValkeyCacheError({ operation: 'put', message: 'replica unavailable' })),
        })
        expect(Result.isFailure(yield* failed.publish(ticket, snapshot(ticket), 0).pipe(Effect.result))).toBe(true)
        const rows =
          yield* sql`SELECT available, snapshot_hash, state_hash FROM broker_observations WHERE account_id = ${accountId}`
        expect(rows).toEqual([{ available: false, snapshot_hash: null, state_hash: null }])
        const captures = yield* sql`SELECT settled FROM broker_observation_captures WHERE account_id = ${accountId}`
        expect(captures).toEqual([{ settled: false }])
      }),
    ))

  test('a capture is claimed only once across restarts, later captures and source rotation', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const captureId = randomUUID()
        expect(yield* store.begin(captureId, 0)).toBeDefined()
        expect((yield* store.begin(captureId, 0)).status).toBe(BrokerObservationClaimStatus.AlreadyClaimed)
        yield* claim(store)
        const restarted = makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache)
        expect((yield* restarted.begin(captureId, 0)).status).toBe(BrokerObservationClaimStatus.AlreadyClaimed)
        const rotated = makeBrokerObservationStore(sql, accountId, 'f'.repeat(40), 60_000, cacheFixture.cache)
        yield* rotated.activate(0)
        expect(Result.isFailure(yield* restarted.begin(randomUUID(), 0).pipe(Effect.result))).toBe(true)
        expect((yield* rotated.begin(captureId, 0)).status).toBe(BrokerObservationClaimStatus.AlreadyClaimed)
        expect(yield* rotated.begin(randomUUID(), 0)).toBeDefined()
      }),
    ))

  test('activation adopts the legacy deadline and source rotation cannot shorten it', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        const [{ deadline }] = yield* sql<{
          deadline: number
        }>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision + 180000 AS deadline`
        if (deadline === undefined) throw new Error('Missing database clock')
        const reservedUntil = Math.ceil(deadline)
        yield* store.activate(reservedUntil)
        expect(yield* store.begin(randomUUID(), reservedUntil + 1)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: reservedUntil,
        })
        const rotated = makeBrokerObservationStore(sql, accountId, 'f'.repeat(40), 60_000, cacheFixture.cache)
        yield* rotated.activate(0)
        expect(yield* rotated.begin(randomUUID(), reservedUntil + 1)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: reservedUntil,
        })
        const rows = yield* sql`SELECT capture_id FROM broker_observation_captures WHERE account_id = ${accountId}`
        expect(rows).toHaveLength(0)
      }),
    ))

  test('concurrent captures share one durable quota reservation across worker restarts', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const [{ deadline }] = yield* sql<{
          deadline: number
        }>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision + 180000 AS deadline`
        if (deadline === undefined) throw new Error('Missing database clock')
        const reservedUntil = Math.ceil(deadline)
        const results = yield* Effect.all(
          [store.begin(randomUUID(), reservedUntil), store.begin(randomUUID(), reservedUntil)],
          { concurrency: 2 },
        )
        expect(results.filter((r) => r.status === BrokerObservationClaimStatus.Reserved)).toHaveLength(1)
        expect(results.filter((r) => r.status === BrokerObservationClaimStatus.QuotaWait)).toHaveLength(1)
        const restarted = makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache)
        expect(yield* restarted.begin(randomUUID(), reservedUntil)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: reservedUntil,
        })
        expect(
          yield* sql`SELECT capture_id FROM broker_observation_captures WHERE account_id = ${accountId}`,
        ).toHaveLength(1)
      }),
    ))

  test('a raced invalidation settles only its own quota after completed HTTP', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const [{ deadline }] = yield* sql<{
          deadline: number
        }>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision + 180000 AS deadline`
        if (deadline === undefined) throw new Error('Missing database clock')
        const reservedUntil = Math.ceil(deadline)
        const captured = yield* store.begin(randomUUID(), reservedUntil)
        if (captured.status !== BrokerObservationClaimStatus.Reserved) throw new Error('Missing capture')
        yield* advanceToTicket(captured.ticket)
        yield* store.invalidate
        expect(yield* store.publish(captured.ticket, snapshot(captured.ticket), 0)).toBe(false)
        yield* store.failed(captured.ticket, 0)
        const successor = yield* store.begin(randomUUID(), reservedUntil)
        expect(successor.status).toBe(BrokerObservationClaimStatus.Reserved)
        yield* store.failed(captured.ticket, 0)
        expect(yield* store.begin(randomUUID(), reservedUntil)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: reservedUntil,
        })
      }),
    ))

  test('publication retains measured HTTP debt instead of the lost-worker reservation', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const [{ deadline }] = yield* sql<{
          deadline: number
        }>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision + 180000 AS deadline`
        if (deadline === undefined) throw new Error('Missing database clock')
        const reservedUntil = Math.ceil(deadline)
        const captureId = randomUUID()
        const captured = yield* store.begin(captureId, reservedUntil)
        if (captured.status !== BrokerObservationClaimStatus.Reserved) throw new Error('Missing capture')
        yield* advanceToTicket(captured.ticket)
        const measuredUntil = reservedUntil - 120000
        expect(yield* store.publish(captured.ticket, snapshot(captured.ticket), measuredUntil)).toBe(true)
        expect(yield* store.begin(captureId, reservedUntil)).toEqual({
          status: BrokerObservationClaimStatus.AlreadyClaimed,
          nextPollNotBeforeMs: measuredUntil,
        })
        expect(yield* store.begin(randomUUID(), reservedUntil)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: measuredUntil,
        })
        expect(yield* store.read).toEqual(snapshot(captured.ticket))
      }),
    ))

  test('starts unavailable, publishes a complete cut and survives a reader restart', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(true)
        const restarted = makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache)
        expect(yield* restarted.read).toEqual(snapshot(ticket))
        expect(Result.getOrThrow(canonicalHashV1Result(yield* restarted.read))).toBe(
          Result.getOrThrow(canonicalHashV1Result(snapshot(ticket))),
        )
        yield* advanceToTicket(ticket, 60_000)
        expect(Result.isFailure(yield* restarted.read.pipe(Effect.result))).toBe(true)
      }),
    ))
  test('persists source precision and hashes across a reader restart', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        const value = observedBrokerSnapshotFixture(accountId, ticket.startedAt, '2026-09-29T17:15:20.123456Z')
        expect(yield* store.publish(ticket, value, 0)).toBe(true)
        const restarted = makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache)
        const read = yield* restarted.read
        expect(read).toEqual(value)
        expect(read.snapshot.history.orders.rows[0]?.value.createdAt).toBe('2026-09-29T17:15:20.123456Z')
        expect(read.recentFills.value.items[0]?.transactionTime).toBe('2026-09-29T17:15:20.123456Z')
        expect(Result.getOrThrow(canonicalHashV1Result(read))).toBe(Result.getOrThrow(canonicalHashV1Result(value)))
      }),
    ))
  test('rejects an undecodable cut before publishing availability or payload', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        const malformed = observedBrokerSnapshotFixture(accountId, ticket.startedAt, '2026-02-30T17:15:20.123456Z')
        expect(Result.isFailure(yield* store.publish(ticket, malformed, 0).pipe(Effect.result))).toBe(true)
        const rows =
          yield* sql`SELECT available, state_hash, snapshot_hash FROM broker_observations WHERE account_id = ${accountId}`
        expect(rows).toEqual([{ available: false, state_hash: null, snapshot_hash: null }])
      }),
    ))
  test.each(['invalidate', 'failed', 'new-ticket', 'revision'] as const)(
    'rejects late publication after %s',
    async (change) =>
      run((sql, store) =>
        Effect.gen(function* () {
          yield* store.activate(0)
          const ticket = yield* claim(store)
          yield* advanceToTicket(ticket)
          if (change === 'invalidate') yield* store.invalidate
          if (change === 'failed') {
            const next = yield* claim(store)
            yield* store.failed(next, 0)
          }
          if (change === 'new-ticket') yield* claim(store)
          if (change === 'revision')
            yield* makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache).activate(0)
          expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(false)
          expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        }),
      ),
  )

  test('replaying an unfinished capture invalidates the old cut and fences its late publication', async () =>
    run((_sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const previous = yield* claim(store)
        yield* advanceToTicket(previous)
        expect(yield* store.publish(previous, snapshot(previous), 0)).toBe(true)
        const captureId = randomUUID()
        const unfinished = yield* claim(store, captureId)
        yield* advanceToTicket(unfinished)
        expect(Result.isSuccess(yield* store.read.pipe(Effect.result))).toBe(true)
        expect((yield* store.begin(captureId, 0)).status).toBe(BrokerObservationClaimStatus.AlreadyClaimed)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(yield* store.publish(unfinished, snapshot(unfinished), 0)).toBe(false)
      }),
    ))

  test('replay preserves a published lost result and cannot invalidate a newer cut', async () =>
    run((_sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const captureId = randomUUID()
        const published = yield* claim(store, captureId)
        yield* advanceToTicket(published)
        expect(yield* store.publish(published, snapshot(published), 0)).toBe(true)
        expect((yield* store.begin(captureId, 0)).status).toBe(BrokerObservationClaimStatus.AlreadyClaimed)
        expect(yield* store.read).toEqual(snapshot(published))
        const oldPending = randomUUID()
        yield* store.begin(oldPending, 0)
        const current = yield* claim(store)
        yield* advanceToTicket(current)
        expect(yield* store.publish(current, snapshot(current), 0)).toBe(true)
        expect((yield* store.begin(oldPending, 0)).status).toBe(BrokerObservationClaimStatus.AlreadyClaimed)
        expect(yield* store.read).toEqual(snapshot(current))
      }),
    ))

  test('interrupting the owned unfinished capture fences its old cut without releasing unknown HTTP debt', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const previous = yield* claim(store)
        yield* advanceToTicket(previous)
        expect(yield* store.publish(previous, snapshot(previous), 0)).toBe(true)
        const [{ deadline }] = yield* sql<{
          deadline: number
        }>`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::double precision + 180000 AS deadline`
        if (deadline === undefined) throw new Error('Missing database clock')
        const reservedUntil = Math.ceil(deadline)
        const captureId = randomUUID()
        const captured = yield* store.begin(captureId, reservedUntil)
        if (captured.status !== BrokerObservationClaimStatus.Reserved) throw new Error('Missing capture')
        yield* advanceToTicket(captured.ticket)
        expect(yield* store.read).toEqual(snapshot(previous))
        yield* store.interrupt(captureId)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(yield* store.publish(captured.ticket, snapshot(captured.ticket), 0)).toBe(false)
        expect(yield* store.begin(randomUUID(), reservedUntil)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: reservedUntil,
        })
      }),
    ))

  test.each(['newer-capture', 'newer-revision', 'published', 'unclaimed'] as const)(
    'an interrupted poll preserves the successful %s observation',
    async (change) =>
      run((sql, store) =>
        Effect.gen(function* () {
          yield* store.activate(0)
          const captureId = randomUUID()
          const predecessor = yield* claim(store, captureId)
          let currentStore = store
          let current = predecessor
          if (change === 'newer-revision') {
            currentStore = makeBrokerObservationStore(sql, accountId, 'f'.repeat(40), 60_000, cacheFixture.cache)
            yield* currentStore.activate(0)
          }
          if (change === 'newer-capture' || change === 'newer-revision') current = yield* claim(currentStore)
          yield* advanceToTicket(current)
          expect(yield* currentStore.publish(current, snapshot(current), 0)).toBe(true)
          yield* store.interrupt(change === 'unclaimed' ? randomUUID() : captureId)
          expect(yield* currentStore.read).toEqual(snapshot(current))
          expect(yield* currentStore.readState).toEqual(observedBrokerState(snapshot(current)))
        }),
      ),
  )

  test('latest poll failure closes a previously fresh projection and cannot overwrite a newer poll', async () =>
    run((_sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const first = yield* claim(store)
        yield* advanceToTicket(first)
        yield* store.publish(first, snapshot(first), 0)
        const second = yield* claim(store)
        yield* store.failed(second, 0)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        const third = yield* claim(store)
        yield* advanceToTicket(third)
        yield* store.publish(third, snapshot(third), 0)
        yield* store.failed(second, 0)
        expect(yield* store.read).toEqual(snapshot(third))
      }),
    ))
  test('waits for a post-mutation cut only within the lifetime of a successful observation', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const first = yield* claim(store)
        yield* advanceToTicket(first)
        yield* store.publish(first, snapshot(first), 0)
        yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
        yield* advanceToTicket(first, 1000)
        expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.ObservationPending)
        yield* store.invalidate
        expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.ObservationPending)
        yield* advanceToTicket(first, 60_000)
        const expired = yield* Effect.flip(store.read)
        expect(expired.kind).toBe(BrokerReadErrorKind.Timeout)
        expect(expired.observationFailure).toBe('NO_ADMISSIBLE_CUT')
      }),
    ))
  test('does not classify a failed poll, foreign revision or corrupt invalidated cut as an expected wait', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const first = yield* claim(store)
        yield* advanceToTicket(first)
        yield* store.publish(first, snapshot(first), 0)
        yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
        yield* advanceToTicket(first, 1000)
        const foreign = makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
        expect((yield* Effect.flip(foreign.read)).kind).toBe(BrokerReadErrorKind.Timeout)
        yield* sql`UPDATE broker_observations SET snapshot_hash = ${'0'.repeat(64)} WHERE account_id = ${accountId}`
        const corrupt = yield* Effect.flip(store.read)
        expect(corrupt.kind).toBe(BrokerReadErrorKind.Timeout)
        expect(corrupt.observationFailure).toBeUndefined()
        yield* sql`UPDATE broker_observations SET snapshot_hash = ${Result.getOrThrow(canonicalHashV1Result(snapshot(first)))} WHERE account_id = ${accountId}`
        const second = yield* claim(store)
        yield* store.failed(second, 0)
        expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.Timeout)
      }),
    ))
  test('activation cannot classify a predecessor revision cut as a successful current-revision wait', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const first = yield* claim(store)
        yield* advanceToTicket(first)
        yield* store.publish(first, snapshot(first), 0)
        yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
        yield* advanceToTicket(first, 1000)
        const successor = makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
        yield* successor.activate(0)
        expect((yield* Effect.flip(successor.read)).kind).toBe(BrokerReadErrorKind.Timeout)
      }),
    ))
  test('a failed poll at the previous completion timestamp remains a failure after a mutation', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const first = yield* claim(store)
        yield* advanceToTicket(first)
        yield* store.publish(first, snapshot(first), 0)
        yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
        yield* advanceToTicket(first, 1000)
        const second = { ...(yield* claim(store)), startedAt: first.startedAt }
        yield* store.failed(second, 0)
        expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.Timeout)
      }),
    ))
  test('permits only the currently reserved intent start and denies concurrent starts', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket), 0)
        const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 1)
        const firstId = '1'.repeat(64)
        const secondId = '2'.repeat(64)
        yield* reserve(sql, firstId, at)
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(yield* store.readForSubmit(firstId)).toEqual(observedBrokerState(snapshot(ticket)))
        expect(Result.isFailure(yield* store.readForSubmit(secondId).pipe(Effect.result))).toBe(true)
        yield* reserve(sql, secondId, at)
        expect(Result.isFailure(yield* store.readForSubmit(firstId).pipe(Effect.result))).toBe(true)
        expect(Result.isFailure(yield* store.readForSubmit(secondId).pipe(Effect.result))).toBe(true)
      }),
    ))
  test('rejects mixed, corrupt and foreign-account persisted bytes', async () =>
    run((_sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket), 0)
        yield* Effect.sync(() => {
          for (const [key, entry] of cacheFixture.values)
            if (key.startsWith('bayn:broker:snapshot:')) {
              const changed = JSON.parse(entry.value)
              changed.snapshot.account.value.cashMicros = '0'
              cacheFixture.values.set(key, { ...entry, value: JSON.stringify(changed) })
            }
        })
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        const foreign = observedBrokerSnapshotFixture('other-account', ticket.startedAt)
        expect(Result.isFailure(yield* store.publish(ticket, foreign, 0).pipe(Effect.result))).toBe(true)
      }),
    ))
  test.each(['SUBMIT_STARTED', 'SUBMIT_UNKNOWN'] as const)(
    'retains reconciliation evidence while an old unresolved %s blocks submission',
    async (eventType) =>
      run((sql, store) =>
        Effect.gen(function* () {
          yield* store.activate(0)
          const ticket = yield* claim(store)
          yield* advanceToTicket(ticket)
          const id = '3'.repeat(64)
          const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) - 10_000)
          yield* reserve(sql, id, at)
          if (eventType === 'SUBMIT_UNKNOWN')
            yield* sql`INSERT INTO mutation_events
        (event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type, request_hash, consistency_delay_ms, occurred_at)
        VALUES (${'4'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${id}, ${id}, 2, 'SUBMIT', ${eventType}, ${'f'.repeat(64)}, 1000, ${at})`
          expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(true)
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
          yield* store.activate(0)
          const ticket = yield* claim(store)
          yield* advanceToTicket(ticket)
          const id = '5'.repeat(64)
          const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) - ageMs)
          yield* reserve(sql, id, at)
          yield* sql`INSERT INTO mutation_events
        (event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type, request_hash, consistency_delay_ms, occurred_at)
        VALUES (${'6'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${id}, ${id}, 2, 'SUBMIT', 'SUBMIT_REJECTED', ${'f'.repeat(64)}, 1000, ${at})`
          expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(ageMs > 1000)
        }),
      ),
  )
  test('a retained fill invalidates the published cut and rejects a late poll', async () =>
    run((sql, store) =>
      Effect.gen(function* () {
        yield* store.activate(0)
        const ticket = yield* claim(store)
        yield* advanceToTicket(ticket)
        yield* store.publish(ticket, snapshot(ticket), 0)
        const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 1)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO broker_events (event_id, schema_version, content_hash, event_kind, broker, account_id,
          source_event_id, source_sequence, occurred_at, observed_at) VALUES (${'7'.repeat(64)}, 'bayn.paper-broker-event.v1',
          ${'7'.repeat(64)}, 'FILL', 'ALPACA', ${accountId}, 'new-fill', 1, ${at}, ${at})`
            yield* sql`INSERT INTO fills (event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id,
          symbol, side, quantity_atoms, price_atoms, fee_micros, source_timestamp)
          VALUES (${'7'.repeat(64)}, ${accountId}, 'bayn.fill.v2', 'new-fill', 'new-order', 'new-client',
          'AAPL', 'BUY', '1000000000', '100000000000', '0', ${at.replace('Z', '000000Z')})`
          }),
        )
        expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
        expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(false)
      }),
    ))
})
