import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Fiber, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { prepareCancel } from '../../broker/alpaca-mutations/decisions'
import { MutationOperation } from '../../broker/alpaca-mutations/model'
import { PostgresClientLive } from '../../db/postgres-client'
import { canonicalHashV1Result } from '../../hash'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import { reconciliationIncompleteRestrictionReason } from '../authority'
import { legacyMutationEventSchemaVersion } from '../legacy-wire'
import { WriterFence, WriterFenceLive } from '../writer-fence'
import { mutationIdResult } from './decisions'
import { MutationStore, MutationEventType, type ExpiredEntryCancellationAdmission } from './model'
import { MutationStoreLive } from './program'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}
const accountId = 'expired-entry-admission-account'
const generationHash = 'a'.repeat(64)
const intentId = 'b'.repeat(64)
const otherGenerationHash = 'c'.repeat(64)
const policyHash = 'd'.repeat(64)
const clientOrderId = 'entry-parent-client'
const brokerOrderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const cancelRequestHash = Result.getOrThrow(prepareCancel(brokerOrderId)).requestHash
const makeRuntime = () =>
  ManagedRuntime.make(
    MutationStoreLive.pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

// Use the actual mutation adapters and PostgreSQL writer fence with the columns they consume.
// The main migrated-schema integration suite separately validates database constraints and migrations.
const seed = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* sql`CREATE TABLE authority_generations (
    generation_hash text PRIMARY KEY, account_id text, maximum text, risk_policy_hash text, strategy_name text
  )`
  yield* sql`CREATE TABLE authority_state (
    singleton boolean PRIMARY KEY, generation_hash text, maximum text, effective text, kill_state text,
    reason text, version integer, updated_at timestamptz
  )`
  yield* sql`CREATE TABLE intents (
    intent_id text PRIMARY KEY, authority_generation_hash text, account_id text, policy_hash text,
    strategy_name text, side text, state text, updated_at timestamptz, risk_decision_id text, client_order_id text
  )`
  yield* sql`CREATE TABLE risk_decisions (
    decision_id text PRIMARY KEY, intent_id text, outcome text, decided_at timestamptz, expires_at timestamptz
  )`
  yield* sql`CREATE FUNCTION execution_account_now(text) RETURNS timestamptz LANGUAGE sql VOLATILE
    AS 'SELECT clock_timestamp()'`
  yield* sql`CREATE TABLE mutation_events (
    event_id text PRIMARY KEY, schema_version text, mutation_id text, intent_id text, sequence integer,
    operation text, event_type text, request_hash text, request_body jsonb, consistency_delay_ms integer,
    broker_order_id text, request_id text, response_status integer, response_content_hash text,
    occurred_at timestamptz, denial_reason text, routing jsonb, UNIQUE(mutation_id, sequence)
  )`
  for (const hash of [generationHash, otherGenerationHash])
    yield* sql`INSERT INTO authority_generations VALUES (${hash}, ${accountId}, 'PAPER', ${policyHash}, 'jev')`
  yield* sql`INSERT INTO authority_state VALUES (
    true, ${generationHash}, 'PAPER', 'OBSERVE', 'ACTIVE', ${reconciliationIncompleteRestrictionReason}, 2,
    '2026-01-01T00:00:00Z'
  )`
  yield* sql`INSERT INTO intents VALUES (
    ${intentId}, ${generationHash}, ${accountId}, ${policyHash}, 'jev', 'BUY', 'ACKNOWLEDGED',
    '2026-01-01T00:00:00Z', ${'e'.repeat(64)}, ${clientOrderId}
  )`
  const material = {
    schemaVersion: legacyMutationEventSchemaVersion,
    mutationId: Result.getOrThrow(mutationIdResult(intentId, MutationOperation.Submit)),
    intentId,
    sequence: 2,
    operation: MutationOperation.Submit,
    eventType: MutationEventType.SubmitAccepted,
    requestHash: 'f'.repeat(64),
    consistencyDelayMs: 1_000,
    brokerOrderId,
    requestId: 'accepted-parent',
    responseStatus: 200,
    responseContentHash: '1'.repeat(64),
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
  yield* sql`INSERT INTO mutation_events (
    event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type, request_hash,
    consistency_delay_ms, broker_order_id, request_id, response_status, response_content_hash, occurred_at
  ) VALUES (
    ${Result.getOrThrow(canonicalHashV1Result(material))}, ${material.schemaVersion}, ${material.mutationId},
    ${intentId}, 2, 'SUBMIT', 'SUBMIT_ACCEPTED', ${material.requestHash}, 1000, ${brokerOrderId},
    'accepted-parent', 200, ${material.responseContentHash}, ${material.occurredAt}
  )`
})

const ClockRows = Schema.Tuple([Schema.Struct({ observed_at: Schema.String, valid_until: Schema.String })])
const observeAdmission = (validForMs = 30_000) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const [clock] = yield* sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
      to_char((clock_timestamp() + ${validForMs} * interval '1 millisecond') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_until
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ClockRows)))
    return {
      accountId,
      authorityGenerationHash: generationHash,
      authorityVersion: 2,
      intentId,
      clientOrderId,
      brokerOrderId,
      observedAt: clock.observed_at,
      validUntil: clock.valid_until,
    } satisfies ExpiredEntryCancellationAdmission
  })
const begin = (admission: ExpiredEntryCancellationAdmission, occurredAt = admission.observedAt) =>
  MutationStore.pipe(
    Effect.flatMap((store) =>
      store.beginCancel(intentId, cancelRequestHash, brokerOrderId, 1_000, occurredAt, admission),
    ),
  )
const cancelStarts = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return yield* sql`SELECT event_id, event_type FROM mutation_events WHERE operation = 'CANCEL' ORDER BY sequence`
})
const durableState = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    authority: yield* sql`SELECT * FROM authority_state`,
    intents: yield* sql`SELECT * FROM intents`,
    cancellations: yield* cancelStarts,
  }
})

const expectAdmissionRejected = (result: unknown) =>
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'MutationStoreError', failure: 'authority' },
  })

describePostgres('PostgreSQL expired-entry cancellation admission', () => {
  let owner: ReturnType<typeof makeRuntime>
  let contender: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    owner = makeRuntime()
    contender = makeRuntime()
  })
  beforeEach(async () => {
    await owner.runPromise(seed)
  })
  afterAll(async () => {
    await owner?.dispose()
    await contender?.dispose()
  })

  test.each(['clear', 'restricted'] as const)(
    'commits one independently visible start for an exact %s owner',
    async (mode) => {
      if (mode === 'clear')
        await owner.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql`UPDATE authority_state SET effective = 'PAPER', kill_state = 'CLEAR', reason = NULL`
          }),
        )
      const token = await owner.runPromise(observeAdmission())
      const state = await owner.runPromise(durableState)
      const admitted = await owner.runPromise(begin(token))
      expect(admitted).toMatchObject({
        started: true,
        event: { eventType: MutationEventType.CancelStarted, brokerOrderId },
      })
      expect(await contender.runPromise(cancelStarts)).toEqual([
        { event_id: admitted.event.eventId, event_type: 'CANCEL_STARTED' },
      ])
      expect(await owner.runPromise(durableState)).toEqual({
        ...state,
        cancellations: [{ event_id: admitted.event.eventId, event_type: 'CANCEL_STARTED' }],
      })
    },
  )

  test.each(['operator-hold', 'version', 'generation', 'intent-generation', 'client', 'sell'] as const)(
    'rejects %s drift before committing cancellation',
    async (change) => {
      const token = await owner.runPromise(observeAdmission())
      await owner.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          if (change === 'operator-hold') yield* sql`UPDATE authority_state SET reason = 'operator hold'`
          if (change === 'version') yield* sql`UPDATE authority_state SET version = 3`
          if (change === 'generation') yield* sql`UPDATE authority_state SET generation_hash = ${otherGenerationHash}`
          if (change === 'intent-generation')
            yield* sql`UPDATE intents SET authority_generation_hash = ${otherGenerationHash}`
          if (change === 'client') yield* sql`UPDATE intents SET client_order_id = 'foreign-client'`
          if (change === 'sell') yield* sql`UPDATE intents SET side = 'SELL'`
        }),
      )
      const state = await owner.runPromise(durableState)
      expectAdmissionRejected(await owner.runPromise(begin(token).pipe(Effect.result)))
      expect(await owner.runPromise(durableState)).toEqual(state)
      expect(await owner.runPromise(cancelStarts)).toEqual([])
    },
  )

  test.each(['account', 'intent', 'parent', 'expired', 'future'] as const)(
    'rejects an invalid %s token with no durable start',
    async (change) => {
      const valid = await owner.runPromise(observeAdmission())
      const token = {
        ...valid,
        ...(change === 'account' ? { accountId: 'foreign-account' } : {}),
        ...(change === 'intent' ? { intentId: '9'.repeat(64) } : {}),
        ...(change === 'parent' ? { brokerOrderId: 'foreign-parent' } : {}),
        ...(change === 'expired' ? { validUntil: valid.observedAt } : {}),
        ...(change === 'future' ? { observedAt: valid.validUntil } : {}),
      }
      const state = await owner.runPromise(durableState)
      expectAdmissionRejected(await owner.runPromise(begin(token, valid.observedAt).pipe(Effect.result)))
      expect(await owner.runPromise(durableState)).toEqual(state)
    },
  )

  test.each(['authority', 'intent'] as const)(
    'checks the live clock after waiting on the %s row lock',
    async (locked) => {
      const result = await contender.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const connection = yield* sql.reserve
            yield* Effect.acquireRelease(connection.executeUnprepared('BEGIN', [], undefined), () =>
              connection.executeUnprepared('ROLLBACK', [], undefined).pipe(Effect.orDie),
            )
            {
              yield* connection.executeUnprepared(
                locked === 'authority'
                  ? 'SELECT singleton FROM authority_state FOR UPDATE'
                  : 'SELECT intent_id FROM intents FOR UPDATE',
                [],
                undefined,
              )
              const token = yield* Effect.promise(() => owner.runPromise(observeAdmission(500)))
              const pending = yield* Effect.promise((signal) =>
                owner.runPromise(begin(token).pipe(Effect.result), { signal }),
              ).pipe(Effect.forkChild({ startImmediately: true }))
              yield* Effect.sleep('650 millis')
              expect(pending.pollUnsafe()).toBeUndefined()
              yield* connection.executeUnprepared('ROLLBACK', [], undefined)
              return yield* Fiber.join(pending)
            }
          }),
        ),
      )
      expectAdmissionRejected(result)
      expect(await owner.runPromise(cancelStarts)).toEqual([])
      const fresh = await owner.runPromise(observeAdmission())
      expect((await owner.runPromise(begin(fresh))).started).toBe(true)
    },
    15_000,
  )

  test('retains an already committed replay after its observation expires and authority changes', async () => {
    const token = await owner.runPromise(observeAdmission())
    const first = await owner.runPromise(begin(token))
    await owner.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE authority_state SET reason = 'operator hold', version = 3`
      }),
    )
    const replay = await contender.runPromise(begin({ ...token, validUntil: token.observedAt }))
    expect(replay).toEqual({ event: first.event, started: false })
    expect(await owner.runPromise(cancelStarts)).toHaveLength(1)
  })

  test('rejects an ambient transaction before cancellation can be admitted', async () => {
    const token = await owner.runPromise(observeAdmission())
    const result = await owner.runPromise(
      Effect.gen(function* () {
        const fence = yield* WriterFence
        return yield* fence.transaction(begin(token)).pipe(Effect.result)
      }),
    )
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'MutationStoreError', failure: 'invariant' } })
    expect(await owner.runPromise(cancelStarts)).toEqual([])
  })
})
