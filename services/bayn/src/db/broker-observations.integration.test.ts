import { canonicalHashV1Result, sha256 } from '../hash'
import { ValkeyCacheError } from '../valkey-cache'
import { valkeyFixture } from '../testing/valkey-fixture'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Clock, Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Ref, Result, Schema, Tracer } from 'effect'
import { TestClock } from 'effect/testing'
import type { Statement } from 'effect/sql/Statement'

import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import {
  BrokerObservations,
  observedBrokerState,
  type BrokerObservationTicket,
} from '../broker/alpaca/observed-snapshot'
import { makeProjectedBrokerRead } from '../broker/alpaca/snapshot-cache'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { checkHealth } from '../health/program'
import { readinessResponseDecision, runtimeHealthFreshnessLeaseMs, statusReadinessResponseDecision } from '../http'
import { initialState } from '../runtime-state'
import {
  prepareClonedPostgres,
  type PostgresTestDatabase,
  type PostgresTestTemplate,
} from '../testing/postgres-template.test-support'
import { config as runtimeConfig } from '../testing/runtime-fixtures'
import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { BrokerEnvironment } from '../broker/identity'
import type { BrokerNotification } from '../broker/notifications'
import {
  brokerActivityVersion,
  brokerActivityCompletionHash,
  brokerActivityPrefixEvidence,
  brokerActivityRangeRequestHash,
  projectBrokerActivity,
  type BrokerActivityCatchupComplete,
  type BrokerActivityCursorState,
  type BrokerActivityEvent,
  type BrokerActivityHeartbeat,
  type BrokerActivityHeartbeatReceipt,
  type BrokerActivityReceipt,
} from '../broker/activities'
import { BrokerStreamReconciliationReason } from '../broker/trade-update-projection'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import { BrokerObservationClaimStatus, makeBrokerObservationStore } from './broker-observations'
import { postgresHealthCheck, PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { migrationLoader } from './migrations'

let cacheFixture = valkeyFixture()
const accountId = 'broker-observations-test-account'
const revision = 'a'.repeat(40)
const generationHash = 'b'.repeat(64)
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55449/bayn_broker_observations_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 5000,
      postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
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
const sourceEvent = (
  eventId: string,
  receivedAt: string,
  sessionId = `test-${eventId.slice(0, 8)}`,
): BrokerNotification => ({
  _tag: 'SessionReady',
  schemaVersion: 'bayn.broker-notification.v1',
  eventId,
  receivedAt,
  session: {
    identityHash: '1'.repeat(64),
    accountId,
    environment: BrokerEnvironment.Sandbox,
    credentialHash: '2'.repeat(64),
    sessionId,
    sourceRevision: revision,
    verifiedAt: receivedAt,
    authenticatedAt: receivedAt,
    subscribedAt: receivedAt,
  },
})
const tradeSourceEvent = (eventId: string, receivedAt: string, sessionId: string): BrokerNotification => ({
  ...sourceEvent(eventId, receivedAt, sessionId),
  _tag: 'TradeUpdate',
  frameJson: '{"stream":"trade_updates","data":{}}',
})
const activityRef = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`
const activityCursor = (value: number) => value.toString().padStart(26, '0')
const activitySession = {
  identityHash: '1'.repeat(64),
  accountId,
  environment: BrokerEnvironment.Sandbox,
  credentialHash: '2'.repeat(64),
  sessionId: 'durable-activity-session',
  sourceRevision: revision,
  verifiedAt: '2026-11-21T16:00:00.000Z',
  connectedAt: '2026-11-21T16:00:00.000Z',
  requestId: 'durable-activity-request',
} as const
const activityEvent = (
  sequence: number,
  reference: number,
  executionType: 'fill' | 'trade_correct' | 'trade_bust',
  previous?: number,
): BrokerActivityEvent => {
  const sourceEventId = activityCursor(sequence)
  const activityJson = JSON.stringify({
    activity_type: 'TRD',
    event_id: sourceEventId,
    ref_id: activityRef(reference),
    ...(previous === undefined ? {} : { previous_id: activityRef(previous) }),
    executed_at: `2026-11-21T16:00:0${sequence}.123456789Z`,
    price: String(100 + sequence),
    qty: '1',
    details: {
      order_id: activityRef(99),
      cum_qty: '1',
      leaves_qty: '0',
      symbol: 'AAPL',
      side: 'buy',
      execution_type: executionType,
      order_status: 'filled',
    },
  })
  const contentHash = sha256(activityJson)
  return {
    _tag: 'Event',
    schemaVersion: brokerActivityVersion,
    eventId: sha256(`${activitySession.identityHash}\nactivity\n${sourceEventId}\n${contentHash}`),
    session: activitySession,
    receivedAt: `2026-11-21T16:00:0${sequence}.500Z`,
    sourceEventId,
    contentHash,
    refId: activityRef(reference),
    ...(previous === undefined ? {} : { previousRefId: activityRef(previous) }),
    activityType: 'TRD',
    activityJson,
  }
}
const canonicalActivityEvent = (sequence: number, reference: number, netAmount = '100.00'): BrokerActivityEvent => {
  const sourceEventId = activityCursor(sequence)
  const activityJson = JSON.stringify({
    activity_type: 'JNLC',
    event_id: sourceEventId,
    ref_id: activityRef(reference),
    account_id: accountId,
    status: 'executed',
    executed_at: `2026-11-21T16:00:0${sequence}.123456789Z`,
    settle_date: '2026-11-21',
    currency: 'USD',
    net_amount: netAmount,
    details: { system_date: '2026-11-21' },
  })
  const contentHash = sha256(activityJson)
  return {
    _tag: 'Event',
    schemaVersion: brokerActivityVersion,
    eventId: sha256(`${activitySession.identityHash}\nactivity\n${sourceEventId}\n${contentHash}`),
    session: activitySession,
    receivedAt: `2026-11-21T16:00:0${sequence}.500Z`,
    sourceEventId,
    contentHash,
    refId: activityRef(reference),
    activityType: 'JNLC',
    activityJson,
  }
}
const nonTradeActivityEvent = (
  sequence: number,
  reference: number,
  activityType: 'FEE' | 'FUTURE_TYPE',
): BrokerActivityEvent => {
  const sourceEventId = activityCursor(sequence)
  const activityJson = JSON.stringify({
    activity_type: activityType,
    event_id: sourceEventId,
    ref_id: activityRef(reference),
    account_id: accountId,
    status: 'executed',
    currency: 'USD',
    net_amount: '-0.02',
    details: { system_date: '2026-11-21' },
  })
  const contentHash = sha256(activityJson)
  return {
    _tag: 'Event',
    schemaVersion: brokerActivityVersion,
    eventId: sha256(`${activitySession.identityHash}\nactivity\n${sourceEventId}\n${contentHash}`),
    session: activitySession,
    receivedAt: `2026-11-21T16:00:0${sequence}.500Z`,
    sourceEventId,
    contentHash,
    refId: activityRef(reference),
    activityType,
    activityJson,
  }
}
const redeliveredActivity = (event: BrokerActivityEvent, sequence: number): BrokerActivityEvent => {
  const sourceEventId = activityCursor(sequence)
  const activityJson = JSON.stringify({ ...(JSON.parse(event.activityJson) as object), event_id: sourceEventId })
  const contentHash = sha256(activityJson)
  return {
    ...event,
    sourceEventId,
    contentHash,
    activityJson,
    receivedAt: `2026-11-21T16:00:0${sequence}.500Z`,
    eventId: sha256(`${event.session.identityHash}\nactivity\n${sourceEventId}\n${contentHash}`),
  }
}
const conflictingSourceActivity = (event: BrokerActivityEvent): BrokerActivityEvent => {
  const activityJson = JSON.stringify({ ...(JSON.parse(event.activityJson) as object), price: '999.99' })
  const contentHash = sha256(activityJson)
  return {
    ...event,
    contentHash,
    activityJson,
    receivedAt: '2026-11-21T16:00:08.500Z',
    eventId: sha256(`${event.session.identityHash}\nactivity\n${event.sourceEventId}\n${contentHash}`),
  }
}
const activityWithJson = (event: BrokerActivityEvent, activityJson: string): BrokerActivityEvent => {
  const contentHash = sha256(activityJson)
  return {
    ...event,
    activityJson,
    contentHash,
    eventId: sha256(`${event.session.identityHash}\nactivity\n${event.sourceEventId}\n${contentHash}`),
  }
}
// Reproduce the old byte-only admission's durable state without altering any retained source witness.
const retainLegacyActivityConflict = (
  sql: PgClient.PgClient,
  original: BrokerActivityEvent,
  replay: BrokerActivityEvent,
) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO broker_activity_source_conflicts(
      account_id,source_event_id,retained_source_event_hash,conflicting_source_event_hash,
      transport_event_id,source_revision,session_id,request_id,received_at,activity_json
    ) VALUES (
      ${accountId},${original.sourceEventId},${original.contentHash},${replay.contentHash},
      ${replay.eventId},${revision},${replay.session.sessionId},${replay.session.requestId},
      ${replay.receivedAt}::timestamptz,${replay.activityJson}
    )`
    yield* sql`UPDATE broker_activity_cursors SET fill_fee_complete = false,
      session_id = NULL, request_id = NULL, heartbeat_at = NULL WHERE account_id = ${accountId}`
    yield* sql`UPDATE broker_observations SET generation = generation + 1, available = false
      WHERE account_id = ${accountId}`
  })
const activityCatchup = (
  events: readonly BrokerActivityEvent[],
  replayUntilId = events.at(-1)?.sourceEventId ?? activityCursor(0),
): BrokerActivityCatchupComplete => {
  const cursor = events.at(-1)?.sourceEventId ?? null
  const replayFromId = activityCursor(0)
  const evidence = brokerActivityPrefixEvidence(
    events.map(({ sourceEventId, contentHash: sourceEventHash }) => ({ sourceEventId, sourceEventHash })),
  )
  const rangeRequestHash = brokerActivityRangeRequestHash({
    identityHash: activitySession.identityHash,
    sessionId: activitySession.sessionId,
    requestId: activitySession.requestId,
    replayFromId,
    replayUntilId,
  })
  const completionHash = brokerActivityCompletionHash({ rangeRequestHash, cursor, ...evidence })
  const receivedAt = '2026-11-21T16:00:09.000Z'
  return {
    _tag: 'CatchupComplete',
    schemaVersion: brokerActivityVersion,
    eventId: sha256(
      `${activitySession.identityHash}\nactivity-catchup\n${activitySession.sessionId}\n${cursor ?? 'empty'}\n${replayFromId}\n${replayUntilId}\n${evidence.eventCount}\n${evidence.prefixHash}\n${rangeRequestHash}\n${completionHash}\n${receivedAt}`,
    ),
    session: activitySession,
    receivedAt,
    cursor,
    replayFromId,
    replayUntilId,
    ...evidence,
    rangeRequestHash,
    completionHash,
  }
}
const accepted = <A>(result: unknown): A => {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('_tag' in result) ||
    result._tag !== 'Accepted' ||
    !('receipt' in result)
  )
    throw new Error('Expected accepted broker activity persistence')
  return result.receipt as A
}
const activityHeartbeat = (cursor: string | null): BrokerActivityHeartbeat => {
  const receivedAt = new Date().toISOString()
  return {
    _tag: 'Heartbeat',
    schemaVersion: brokerActivityVersion,
    eventId: sha256(
      `${activitySession.identityHash}\nactivity-heartbeat\n${activitySession.sessionId}\n${cursor ?? 'empty'}\n${receivedAt}`,
    ),
    session: activitySession,
    receivedAt,
    cursor,
  }
}
const advanceToTicket = (ticket: BrokerObservationTicket, delta = 0) =>
  TestClock.setTime(Date.parse(ticket.startedAt) + delta)

const publishFresh = (store: ReturnType<typeof makeBrokerObservationStore>) =>
  Effect.gen(function* () {
    const ticket = yield* claim(store)
    yield* advanceToTicket(ticket)
    const value = snapshot(ticket)
    yield* store.publish(ticket, value, 0)
    return { ticket, value }
  })

const readWithPendingFences = <A, E>(read: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const result = yield* read.pipe(Effect.result, Effect.provideService(Tracer.Tracer, tracer))
    const fence = spans.find((span) => span.name === 'bayn.broker.observation.fence')
    const attributes = Object.fromEntries(
      [...(fence?.attributes ?? [])].filter(([key]) => key.startsWith('bayn.broker.observation.pending.')),
    )
    return { result, attributes }
  })

// Exercise the production projection, health pass and both HTTP readiness decisions.
// Ledger/cycle/controller probes are healthy fixtures; no broker or ledger I/O is permitted.
const rolloutReadiness = (sql: PgClient.PgClient, store: ReturnType<typeof makeBrokerObservationStore>) =>
  Effect.gen(function* () {
    const unexpected = () => Effect.die('Rollout readiness must not perform direct broker I/O')
    let directBrokerCalls = 0
    const directBroker = () => Effect.sync(() => directBrokerCalls++).pipe(Effect.andThen(unexpected()))
    const read = yield* makeProjectedBrokerRead({
      account: directBroker(),
      accountConfiguration: directBroker(),
      positions: directBroker(),
      orders: directBroker,
      orderById: directBroker,
      orderByClientId: directBroker,
      assetBySymbol: directBroker,
      feeActivities: directBroker,
      fillActivities: directBroker,
      marketCalendar: directBroker,
    }).pipe(Effect.provideService(BrokerObservations, store))
    const broker = {
      read,
      expectedAccountId: accountId,
      executionEligible: false,
      executionDisabledReason: 'READ_ONLY',
    }
    const controller = { controllerKey: 'a'.repeat(64), planHash: 'c'.repeat(64) }
    const state = yield* Ref.make(
      initialState({
        broker,
        autonomousCycleLoopConfigured: true,
        autonomousCycleLoopOwner: 'Restate',
        executionController: controller,
      }),
    )
    const at = yield* currentUtcInstant
    yield* checkHealth(
      runtimeConfig,
      state,
      {
        postgresql: postgresHealthCheck(sql),
        journal: {
          check: Effect.void,
          post: unexpected,
          verifyAccount: unexpected,
          journalAndReconcile: unexpected,
          checkRun: unexpected,
        },
        cycleObservability: {
          read: () =>
            Effect.succeed({
              current: null,
              last: null,
              unfinishedCycleCount: 0,
              authority: null,
              reconciliation: null,
              mutations: {
                eventCount: 0,
                recoveryFoundCount: 0,
                approvedIntentCount: 0,
                acknowledgedIntentCount: 0,
                unresolvedCount: 0,
                oldestUnresolvedAt: null,
                latestOccurredAt: null,
              },
            }),
        },
      },
      broker,
      undefined,
      { _tag: 'Exact', bindingId: generationHash },
      {
        controllerKey: controller.controllerKey,
        read: () =>
          Effect.succeed({
            operational: {
              schemaVersion: 'bayn.execution-controller-health.v1',
              ...controller,
              sourceRevision: runtimeConfig.build.sourceRevision,
              active: true,
              epoch: 1,
              nextSequence: 2,
              nextDueAt: utcInstantFromEpochMillis(Date.parse(at) + 30_000),
            },
            status: {
              schemaVersion: 1,
              ...controller,
              active: true,
              epoch: 1,
              nextSequence: 2,
              lastSequence: 1,
              lastOutcome: ExecutionControllerOutcome.Waiting,
              lastReceiptHash: 'd'.repeat(64),
              completedAt: at,
              nextDueAt: utcInstantFromEpochMillis(Date.parse(at) + 30_000),
              lastPass: { result: 'SUCCESS', outcome: 'WINDOW_CLOSED', observedAt: at },
            },
          }),
      },
    )
    expect(directBrokerCalls).toBe(0)
    const current = yield* Ref.get(state)
    const freshness = { nowMs: yield* Clock.currentTimeMillis, leaseMs: runtimeHealthFreshnessLeaseMs(runtimeConfig) }
    return {
      current,
      status: statusReadinessResponseDecision(current, freshness),
      trading: readinessResponseDecision(current, freshness),
      freshness,
    }
  })
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
  let template: PostgresTestTemplate
  let database: PostgresTestDatabase
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(async () => {
    template = await prepareClonedPostgres(testUrl, async (url) => {
      const schema = makeRuntime(url)
      try {
        await schema.runPromise(postgresMigrations)
      } finally {
        await schema.dispose()
      }
    })
  })
  beforeEach(async () => {
    cacheFixture = valkeyFixture()
    database = await template.clone()
    runtime = makeRuntime(database.url)
  })
  afterEach(async () => {
    try {
      await runtime?.dispose()
    } finally {
      await database?.dispose()
    }
  })
  afterAll(async () => template?.dispose())
  const run = <A>(
    exercise: (
      sql: PgClient.PgClient,
      store: ReturnType<typeof makeBrokerObservationStore>,
    ) => Effect.gen.Return<A, unknown>,
  ) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* exercise(sql, makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache))
      }).pipe(Effect.provide(TestClock.layer())),
    )

  test('a notification after the final history read fences publication and the prior ready cut before owner delivery', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const first = yield* claim(store)
      yield* advanceToTicket(first)
      expect(yield* store.publish(first, snapshot(first), 0)).toBe(true)
      expect(yield* store.readState).toEqual(observedBrokerState(snapshot(first)))

      // The complete provider history has already been read; ingress arrives before its SQL publication.
      const second = yield* claim(store)
      yield* advanceToTicket(second)
      const capturedBeforeNotification = snapshot(second)
      const receipt = sourceEvent('d'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) - 10_000))
      expect(yield* store.recordNotification(receipt)).toEqual({ covered: false })
      expect(yield* store.isSessionBoundaryCovered(receipt.session.sessionId)).toBe(false)
      expect(yield* store.publish(second, capturedBeforeNotification, 0)).toBe(false)
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
      expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
      yield* store.failed(second, 0)

      const next = yield* claim(store)
      yield* advanceToTicket(next)
      expect(yield* store.publish(next, snapshot(next), 0)).toBe(true)
      expect(yield* store.isSessionBoundaryCovered(receipt.session.sessionId)).toBe(false)
      yield* (yield* store.readForReconciliation).complete
      expect(yield* store.isSessionBoundaryCovered(receipt.session.sessionId)).toBe(true)
      expect(yield* store.readState).toEqual(observedBrokerState(snapshot(next)))
      expect(yield* store.recordNotification({ ...receipt, receivedAt: next.startedAt })).toEqual({ covered: true })
      const retained = yield* sql`SELECT event_id, source_revision,
          to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
          recorded_at > ${second.startedAt}::timestamptz AS "arrivedDuringCapture"
          FROM broker_source_events WHERE account_id = ${accountId}`
      expect(retained).toEqual([
        {
          event_id: receipt.eventId,
          source_revision: revision,
          receivedAt: receipt.receivedAt,
          arrivedDuringCapture: true,
        },
      ])
    }))

  test('concurrent republication retains one receipt and a foreign account cannot revoke a canonical cut', async () =>
    run(function* (sql, store) {
      const receipt = sourceEvent('e'.repeat(64), '2026-11-01T00:00:00.000Z')
      const records = yield* Effect.all([store.recordNotification(receipt), store.recordNotification(receipt)], {
        concurrency: 2,
      })
      expect(records).toEqual([{ covered: false }, { covered: false }])
      yield* store.activate(0)
      const ticket = yield* claim(store)
      yield* advanceToTicket(ticket)
      expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(true)
      const foreign = makeBrokerObservationStore(sql, 'another-account', revision, 60_000, cacheFixture.cache)
      expect(yield* foreign.recordNotification(receipt)).toEqual({ covered: false })
      expect(yield* store.readState).toEqual(observedBrokerState(snapshot(ticket)))
      expect(yield* store.recordNotification(receipt)).toEqual({ covered: true })
      expect(
        yield* sql`SELECT account_id, COUNT(*)::integer AS count FROM broker_source_events GROUP BY account_id ORDER BY account_id`,
      ).toEqual([
        { account_id: 'another-account', count: 1 },
        { account_id: accountId, count: 1 },
      ])
    }))

  test('financial reconciliation, not snapshot publication, opens a replacement stream session', async () =>
    run(function* (_sql, store) {
      yield* store.activate(0)
      const firstBoundary = sourceEvent('1'.repeat(64), '2026-11-21T00:00:00.000Z', 'first-session')
      expect(yield* store.recordNotification(firstBoundary)).toEqual({ covered: false })
      const first = yield* claim(store)
      yield* advanceToTicket(first)
      expect(yield* store.publish(first, snapshot(first), 0)).toBe(true)

      const firstRead = yield* store.readForReconciliation
      const staleCompletion = firstRead.complete
      expect(yield* store.isSessionBoundaryCovered(firstBoundary.session.sessionId)).toBe(false)
      yield* firstRead.complete
      expect(yield* store.isSessionBoundaryCovered(firstBoundary.session.sessionId)).toBe(true)

      const replacementBoundary = sourceEvent('2'.repeat(64), '2026-11-21T00:00:01.000Z', 'replacement-session')
      expect(yield* store.recordNotification(replacementBoundary)).toEqual({ covered: false })
      yield* staleCompletion
      expect(yield* store.isSessionBoundaryCovered(replacementBoundary.session.sessionId)).toBe(false)

      const replacement = yield* claim(store)
      yield* advanceToTicket(replacement)
      expect(yield* store.publish(replacement, snapshot(replacement), 0)).toBe(true)
      const replacementRead = yield* store.readForReconciliation
      expect(yield* store.isSessionBoundaryCovered(replacementBoundary.session.sessionId)).toBe(false)
      yield* replacementRead.complete
      expect(yield* store.isSessionBoundaryCovered(replacementBoundary.session.sessionId)).toBe(true)
    }))

  test('new-revision ingress revokes the predecessor cut before Restate ownership handoff', async () =>
    run(function* (sql, predecessor) {
      yield* predecessor.activate(0)
      const published = yield* claim(predecessor)
      yield* advanceToTicket(published)
      expect(yield* predecessor.publish(published, snapshot(published), 0)).toBe(true)

      const stale = yield* claim(predecessor)
      yield* advanceToTicket(stale)
      const successorRevision = 'b'.repeat(40)
      const successor = makeBrokerObservationStore(sql, accountId, successorRevision, 60_000, cacheFixture.cache)
      const notification = sourceEvent('5'.repeat(64), stale.startedAt)
      const successorNotification = {
        ...notification,
        session: { ...notification.session, sourceRevision: successorRevision },
      }
      expect(yield* successor.recordNotification(successorNotification)).toEqual({ covered: false })
      expect(
        yield* sql`SELECT source_revision,available,generation FROM broker_observations
            WHERE account_id = ${accountId}`,
      ).toEqual([{ source_revision: revision, available: false, generation: stale.generation + 1 }])
      expect(Result.isFailure(yield* predecessor.readState.pipe(Effect.result))).toBe(true)
      expect(yield* predecessor.publish(stale, snapshot(stale), 0)).toBe(false)

      yield* successor.activate(0)
      const recovered = yield* claim(successor)
      yield* advanceToTicket(recovered)
      expect(yield* successor.publish(recovered, snapshot(recovered), 0)).toBe(true)
      expect(yield* successor.isNotificationCovered(successorNotification.eventId)).toBe(true)
      expect(yield* successor.readState).toEqual(observedBrokerState(snapshot(recovered)))
    }))

  test('new-revision ingress fences an unavailable predecessor capture exactly once', async () =>
    run(function* (sql, predecessor) {
      yield* predecessor.activate(0)
      const inFlight = yield* claim(predecessor)
      yield* advanceToTicket(inFlight)
      const successorRevision = 'b'.repeat(40)
      const successor = makeBrokerObservationStore(sql, accountId, successorRevision, 60_000, cacheFixture.cache)
      const notification = sourceEvent('6'.repeat(64), inFlight.startedAt)
      const successorNotification = {
        ...notification,
        session: { ...notification.session, sourceRevision: successorRevision },
      }

      expect(yield* successor.recordNotification(successorNotification)).toEqual({ covered: false })
      const [{ generation }] = yield* sql`SELECT generation FROM broker_observations WHERE account_id = ${accountId}`
      expect(generation).toBe(inFlight.generation + 1)
      expect(yield* predecessor.publish(inFlight, snapshot(inFlight), 0)).toBe(false)
      expect(yield* successor.recordNotification(successorNotification)).toEqual({ covered: false })
      expect(yield* sql`SELECT generation FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation },
      ])
    }))

  test('replays the first immutable source projection receipt instead of recomputing it', async () =>
    run(function* (sql, store) {
      const event = sourceEvent('6'.repeat(64), '2026-11-01T00:00:00.000Z')
      yield* store.recordNotification(event)
      expect(yield* store.readNotification(event.eventId)).toEqual(event)
      expect(yield* store.readProjectionBacklog).toMatchObject({ pending: 1 })
      expect(
        yield* makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
          .readProjectionBacklog,
      ).toMatchObject({ pending: 1 })

      const first = {
        _tag: 'Projected',
        eventId: event.eventId,
        observedAt: event.receivedAt,
        orderEventId: '3'.repeat(64),
        fillEventId: '4'.repeat(64),
      } as const
      const retained = yield* store.recordProjection(first)
      expect(retained).toEqual(first)
      expect(yield* store.readSourceProjection(event.eventId)).toEqual(retained)
      expect(yield* store.readProjectionBacklog).toEqual({ pending: 0, oldestPendingSeconds: 0 })

      expect(
        yield* store.recordProjection({
          _tag: 'ReconcileRequired',
          eventId: event.eventId,
          observedAt: event.receivedAt,
          reason: BrokerStreamReconciliationReason.ProjectionConflict,
        }),
      ).toEqual(retained)
      expect(
        Result.isFailure(
          yield* sql`UPDATE broker_source_event_projections SET reason = 'INVALID_FRAME'
              WHERE account_id = ${accountId} AND event_id = ${event.eventId}`.pipe(Effect.result),
        ),
      ).toBe(true)
    }))

  test('durably resumes the activity prefix and applies correction and bust reversal without replica history', async () =>
    run(function* (sql, store) {
      const original = activityEvent(1, 1, 'fill')
      const originalReceipt = accepted<BrokerActivityReceipt>(
        yield* store.recordActivity(original, projectBrokerActivity(original)),
      )
      expect(originalReceipt).toMatchObject({ cursor: original.sourceEventId, replayed: false, projection: 'Fill' })
      expect(
        accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([original]))),
      ).toEqual({
        cursor: original.sourceEventId,
        caughtUp: true,
        replayFromId: activityCursor(0),
        replayUntilId: original.sourceEventId,
        completionHash: activityCatchup([original]).completionHash,
        fillFeeComplete: true,
        sourceRevision: revision,
      })
      expect(
        accepted<BrokerActivityHeartbeatReceipt>(
          yield* store.recordActivityHeartbeat(activityHeartbeat(original.sourceEventId)),
        ),
      ).toEqual({
        cursor: original.sourceEventId,
        caughtUp: true,
        replayFromId: activityCursor(0),
        replayUntilId: original.sourceEventId,
        completionHash: activityCatchup([original]).completionHash,
        fillFeeComplete: true,
        sourceRevision: revision,
        activated: true,
      })
      expect((yield* store.readAccountActivity).fills.map(({ value }) => value.priceAtoms)).toEqual(['101000000000'])
      yield* sql`UPDATE broker_activity_cursors SET heartbeat_at = clock_timestamp() - interval '2 minutes'
          WHERE account_id = ${accountId}`
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
      expect(
        accepted<BrokerActivityHeartbeatReceipt>(
          yield* store.recordActivityHeartbeat(activityHeartbeat(original.sourceEventId)),
        ),
      ).toMatchObject({ activated: false })
      expect((yield* store.readAccountActivity).fills).toHaveLength(1)

      const correction = activityEvent(2, 2, 'trade_correct', 1)
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(correction, projectBrokerActivity(correction))),
      ).toMatchObject({
        cursor: correction.sourceEventId,
        projection: 'Fill',
      })
      const corrected = yield* store.readAccountActivity
      expect(corrected.fills.map(({ value }) => [value.activityId, value.priceAtoms])).toEqual([
        [`20261121110002123::${activityRef(2)}`, '102000000000'],
      ])

      const bust = activityEvent(3, 3, 'trade_bust', 2)
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(bust, projectBrokerActivity(bust))),
      ).toMatchObject({
        cursor: bust.sourceEventId,
        projection: 'Bust',
      })
      expect((yield* store.readAccountActivity).fills).toEqual([])
      expect(yield* store.readActivityCursor).toEqual({
        cursor: bust.sourceEventId,
        caughtUp: true,
        replayFromId: activityCursor(0),
        replayUntilId: original.sourceEventId,
        completionHash: activityCatchup([original]).completionHash,
        fillFeeComplete: true,
        sourceRevision: revision,
      })

      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(bust, projectBrokerActivity(bust))),
      ).toMatchObject({
        cursor: bust.sourceEventId,
        replayed: true,
        projection: 'Bust',
      })
      expect(
        yield* sql`SELECT source_event_id,outcome,ref_id::text AS ref_id,previous_ref_id::text AS previous_ref_id
            FROM broker_activity_event_projections WHERE account_id = ${accountId}
            ORDER BY source_event_id COLLATE "C"`,
      ).toEqual([
        { source_event_id: activityCursor(1), outcome: 'FILL', ref_id: activityRef(1), previous_ref_id: null },
        {
          source_event_id: activityCursor(2),
          outcome: 'FILL',
          ref_id: activityRef(2),
          previous_ref_id: activityRef(1),
        },
        {
          source_event_id: activityCursor(3),
          outcome: 'BUST',
          ref_id: activityRef(3),
          previous_ref_id: activityRef(2),
        },
      ])
      expect(
        Result.isFailure(
          yield* sql`UPDATE broker_activity_events SET activity_json = activity_json
              WHERE account_id = ${accountId} AND source_event_id = ${original.sourceEventId}`.pipe(Effect.result),
        ),
      ).toBe(true)
      expect(
        yield* sql`SELECT activity_json AS "activityJson" FROM broker_activity_events
            WHERE account_id = ${accountId} AND source_event_id = ${original.sourceEventId}`,
      ).toEqual([{ activityJson: original.activityJson }])
    }))

  test('each fresh financial activity atomically revokes the observation generation while exact replay is inert', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const published = yield* claim(store)
      yield* advanceToTicket(published)
      expect(yield* store.publish(published, snapshot(published), 0)).toBe(true)

      const inFlight = yield* claim(store)
      yield* advanceToTicket(inFlight)
      const staleReconciliation = yield* store.readForReconciliation
      const original = activityEvent(1, 1, 'fill')
      const events = [
        original,
        redeliveredActivity(original, 2),
        nonTradeActivityEvent(3, 4, 'FEE'),
        activityEvent(4, 2, 'trade_correct', 1),
        activityEvent(5, 3, 'trade_bust', 2),
        canonicalActivityEvent(6, 5),
        activityEvent(7, 1, 'fill'),
        nonTradeActivityEvent(8, 6, 'FUTURE_TYPE'),
      ]

      for (const event of events) {
        const [before] = yield* sql<{ generation: number }>`SELECT generation FROM broker_observations
            WHERE account_id = ${accountId}`
        if (before === undefined) throw new Error('Missing broker observation owner')
        const first = accepted<BrokerActivityReceipt>(yield* store.recordActivity(event, projectBrokerActivity(event)))
        expect(first.replayed).toBe(false)
        const [revoked] = yield* sql<{ generation: number; available: boolean }>`SELECT generation,available
            FROM broker_observations WHERE account_id = ${accountId}`
        expect(revoked).toEqual({ generation: before.generation + 1, available: false })
        expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)

        expect(
          accepted<BrokerActivityReceipt>(yield* store.recordActivity(event, projectBrokerActivity(event))),
        ).toMatchObject({ replayed: true })
        const [replayed] = yield* sql<{ generation: number; available: boolean }>`SELECT generation,available
            FROM broker_observations WHERE account_id = ${accountId}`
        expect(replayed).toEqual(revoked)
      }

      expect(yield* store.publish(inFlight, snapshot(inFlight), 0)).toBe(false)
      yield* staleReconciliation.complete
      const [final] = yield* sql<{ reconciled: boolean }>`SELECT
          financial_reconciliation_fence_at IS NOT NULL AS reconciled
          FROM broker_observations WHERE account_id = ${accountId}`
      expect(final).toEqual({ reconciled: false })
    }))

  test.each(['whitespace', 'key order', 'string escape', 'exact decimal spelling'] as const)(
    'accepts a full-content-equivalent live replay with %s and preserves the original bytes',
    async (representation) =>
      run(function* (sql, store) {
        yield* store.activate(0)
        const base = activityEvent(1, 1, 'fill')
        const original =
          representation === 'exact decimal spelling'
            ? activityWithJson(base, `${base.activityJson.slice(0, -1)},"exact":9007199254740992.1234567890123456789}`)
            : base
        const replayJson =
          representation === 'whitespace'
            ? JSON.stringify(JSON.parse(original.activityJson), null, 2)
            : representation === 'key order'
              ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(original.activityJson)).reverse()))
              : representation === 'string escape'
                ? original.activityJson.replace('AAPL', '\\u0041APL')
                : original.activityJson.replace(
                    '9007199254740992.1234567890123456789',
                    '9007199254740992.123456789012345678900',
                  )
        const replay = activityWithJson(original, replayJson)
        expect(replay.contentHash).not.toBe(original.contentHash)
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
        accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([original])))
        const before = yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`
        expect(
          accepted<BrokerActivityReceipt>(yield* store.recordActivity(replay, projectBrokerActivity(replay))),
        ).toMatchObject({ replayed: true, projection: 'Fill', fillFeeComplete: true })
        expect(
          yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`,
        ).toEqual(before)
        expect(
          yield* sql`SELECT source_event_hash,activity_json FROM broker_activity_events WHERE account_id = ${accountId}`,
        ).toEqual([{ source_event_hash: original.contentHash, activity_json: original.activityJson }])
        expect(
          yield* sql`SELECT count(*)::int AS count FROM broker_activity_event_projections WHERE account_id = ${accountId}`,
        ).toEqual([{ count: 1 }])
        expect(
          yield* sql`SELECT count(*)::int AS count FROM broker_activity_source_conflicts WHERE account_id = ${accountId}`,
        ).toEqual([{ count: 0 }])
      }),
  )

  test.each([
    ['nested unknown field', '{"nested":{"code":"A"}}', '{"nested":{"code":"B"}}'],
    ['large integer', '9007199254740992', '9007199254740993'],
    ['precise decimal', '9007199254740992.1234567890123456789', '9007199254740992.1234567890123456790'],
    ['JSON value type', '1', '"1"'],
    ['null versus missing', 'null', undefined],
    ['array order', '[1,2]', '[2,1]'],
  ] as const)('rejects changed complete source content: %s', async (_name, first, changed) =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const base = activityEvent(1, 1, 'fill')
      const original = activityWithJson(base, `${base.activityJson.slice(0, -1)},"unprojected":${first}}`)
      const conflict = activityWithJson(
        original,
        changed === undefined ? base.activityJson : `${base.activityJson.slice(0, -1)},"unprojected":${changed}}`,
      )
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      expect(yield* store.recordActivity(conflict, projectBrokerActivity(conflict))).toEqual({
        _tag: 'SourceConflict',
        eventId: conflict.eventId,
      })
      expect(
        yield* sql`SELECT source_event_hash,activity_json FROM broker_activity_events WHERE account_id = ${accountId}`,
      ).toEqual([{ source_event_hash: original.contentHash, activity_json: original.activityJson }])
      expect((yield* store.readActivityCursor).fillFeeComplete).toBe(false)
    }),
  )

  test('a fresh heartbeat repairs only historical equivalent conflicts once without changing raw or coverage evidence', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const original = activityEvent(1, 1, 'fill')
      const fee = nonTradeActivityEvent(2, 2, 'FEE')
      for (const event of [original, fee])
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(event, projectBrokerActivity(event)))
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([original, fee])))
      accepted<BrokerActivityHeartbeatReceipt>(
        yield* store.recordActivityHeartbeat(activityHeartbeat(fee.sourceEventId)),
      )
      const replay = activityWithJson(original, JSON.stringify(JSON.parse(original.activityJson), null, 2))
      yield* retainLegacyActivityConflict(sql, original, replay)
      const sourceRows =
        yield* sql`SELECT * FROM broker_activity_events WHERE account_id = ${accountId} ORDER BY source_event_id`
      const projectionRows =
        yield* sql`SELECT * FROM broker_activity_event_projections WHERE account_id = ${accountId} ORDER BY source_event_id`
      const conflicts = yield* sql`SELECT * FROM broker_activity_source_conflicts WHERE account_id = ${accountId}`
      const coverage = yield* sql`SELECT * FROM broker_activity_coverage_receipts WHERE account_id = ${accountId}`
      const cursorProof =
        yield* sql`SELECT last_source_event_id,last_source_event_hash,coverage_status,replay_from_id,replay_until_id,
          bootstrap_event_count,bootstrap_prefix_hash,range_request_hash,completion_hash FROM broker_activity_cursors WHERE account_id = ${accountId}`
      const [before] = yield* sql<{
        generation: number
      }>`SELECT generation FROM broker_observations WHERE account_id = ${accountId}`
      if (before === undefined) throw new Error('Missing broker observation owner')
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(replay, projectBrokerActivity(replay))),
      ).toMatchObject({
        replayed: true,
        fillFeeComplete: false,
      })
      const heartbeat = activityHeartbeat(fee.sourceEventId)
      expect(accepted<BrokerActivityHeartbeatReceipt>(yield* store.recordActivityHeartbeat(heartbeat))).toMatchObject({
        activated: true,
        fillFeeComplete: true,
        caughtUp: true,
        cursor: fee.sourceEventId,
      })
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
      expect(accepted<BrokerActivityHeartbeatReceipt>(yield* store.recordActivityHeartbeat(heartbeat))).toMatchObject({
        activated: false,
        fillFeeComplete: true,
      })
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])
      const cut = yield* store.readAccountActivity
      expect(cut.fills).toHaveLength(1)
      expect([...cut.feeCounts.values()]).toEqual([1])
      expect(
        yield* sql`SELECT * FROM broker_activity_events WHERE account_id = ${accountId} ORDER BY source_event_id`,
      ).toEqual(sourceRows)
      expect(
        yield* sql`SELECT * FROM broker_activity_event_projections WHERE account_id = ${accountId} ORDER BY source_event_id`,
      ).toEqual(projectionRows)
      expect(yield* sql`SELECT * FROM broker_activity_source_conflicts WHERE account_id = ${accountId}`).toEqual(
        conflicts,
      )
      expect(yield* sql`SELECT * FROM broker_activity_coverage_receipts WHERE account_id = ${accountId}`).toEqual(
        coverage,
      )
      expect(
        yield* sql`SELECT last_source_event_id,last_source_event_hash,coverage_status,replay_from_id,replay_until_id,
          bootstrap_event_count,bootstrap_prefix_hash,range_request_hash,completion_hash FROM broker_activity_cursors WHERE account_id = ${accountId}`,
      ).toEqual(cursorProof)
      expect(
        Result.isFailure(
          yield* sql`UPDATE broker_activity_source_conflicts SET activity_json = activity_json
          WHERE account_id = ${accountId}`.pipe(Effect.result),
        ),
      ).toBe(true)
    }))

  test('repair from an old authenticated heartbeat cannot make the activity view readable', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const original = activityEvent(1, 1, 'fill')
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([original])))
      const replay = activityWithJson(original, JSON.stringify(JSON.parse(original.activityJson), null, 2))
      yield* retainLegacyActivityConflict(sql, original, replay)
      const heartbeat = activityHeartbeat(original.sourceEventId)
      const receivedAt = new Date(Date.parse(heartbeat.receivedAt) - 120_000).toISOString()
      const old = {
        ...heartbeat,
        receivedAt,
        eventId: sha256(
          `${heartbeat.session.identityHash}\nactivity-heartbeat\n${heartbeat.session.sessionId}\n${heartbeat.cursor}\n${receivedAt}`,
        ),
      }
      expect(accepted<BrokerActivityHeartbeatReceipt>(yield* store.recordActivityHeartbeat(old)).fillFeeComplete).toBe(
        true,
      )
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
      accepted<BrokerActivityHeartbeatReceipt>(yield* store.recordActivityHeartbeat(heartbeat))
      expect((yield* store.readAccountActivity).fills).toHaveLength(1)
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
    }))

  test.each([
    'genuine conflict',
    'unsupported projection',
    'poisoned coverage',
    'retired revision',
    'cursor mismatch',
  ] as const)('equivalent historical conflicts cannot repair %s', async (blocker) =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const original = activityEvent(1, 1, 'fill')
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      const boundary = activityCatchup([original])
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(boundary))
      const replay = activityWithJson(original, JSON.stringify(JSON.parse(original.activityJson), null, 2))
      yield* retainLegacyActivityConflict(sql, original, replay)
      let cursor = original.sourceEventId
      if (blocker === 'genuine conflict') {
        const changed = conflictingSourceActivity(original)
        expect((yield* store.recordActivity(changed, projectBrokerActivity(changed)))._tag).toBe('SourceConflict')
      }
      if (blocker === 'unsupported projection') {
        const unsupported = nonTradeActivityEvent(2, 2, 'FUTURE_TYPE')
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(unsupported, projectBrokerActivity(unsupported)))
        cursor = unsupported.sourceEventId
      }
      if (blocker === 'poisoned coverage') {
        expect(
          (yield* store.recordActivityCatchup({ ...boundary, eventId: 'f'.repeat(64), prefixHash: 'f'.repeat(64) }))
            ._tag,
        ).toBe('CoverageConflict')
        accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(boundary))
      }
      const heartbeat = activityHeartbeat(cursor)
      if (blocker === 'retired revision') {
        const retiredRevision = 'b'.repeat(40)
        const retired = makeBrokerObservationStore(sql, accountId, retiredRevision, 60_000, cacheFixture.cache)
        expect(
          yield* retired.recordActivityHeartbeat({
            ...heartbeat,
            session: { ...heartbeat.session, sourceRevision: retiredRevision },
          }),
        ).toEqual({
          _tag: 'RetiredRevision',
          activeSourceRevision: revision,
        })
      } else if (blocker === 'cursor mismatch') {
        expect(
          Result.isFailure(
            yield* store.recordActivityHeartbeat(activityHeartbeat(activityCursor(9))).pipe(Effect.result),
          ),
        ).toBe(true)
      } else {
        expect(
          accepted<BrokerActivityHeartbeatReceipt>(yield* store.recordActivityHeartbeat(heartbeat)).fillFeeComplete,
        ).toBe(false)
      }
      expect((yield* store.readActivityCursor).fillFeeComplete).toBe(false)
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
    }),
  )

  test('retains authenticated source equivocation, poisons readiness once and preserves the original event', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const original = activityEvent(1, 1, 'fill')
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([original])))
      accepted<BrokerActivityHeartbeatReceipt>(
        yield* store.recordActivityHeartbeat(activityHeartbeat(original.sourceEventId)),
      )
      const published = yield* claim(store)
      yield* advanceToTicket(published)
      expect(yield* store.publish(published, snapshot(published), 0)).toBe(true)

      const [before] = yield* sql<{ generation: number }>`SELECT generation FROM broker_observations
          WHERE account_id = ${accountId}`
      if (before === undefined) throw new Error('Missing broker observation owner')
      const conflict = conflictingSourceActivity(original)
      expect(yield* store.recordActivity(conflict, projectBrokerActivity(conflict))).toEqual({
        _tag: 'SourceConflict',
        eventId: conflict.eventId,
      })
      expect(
        yield* sql`SELECT retained_source_event_hash,conflicting_source_event_hash,transport_event_id
            FROM broker_activity_source_conflicts WHERE account_id = ${accountId}`,
      ).toEqual([
        {
          retained_source_event_hash: original.contentHash,
          conflicting_source_event_hash: conflict.contentHash,
          transport_event_id: conflict.eventId,
        },
      ])
      expect(
        yield* sql`SELECT source_event_hash,activity_json FROM broker_activity_events
            WHERE account_id = ${accountId} AND source_event_id = ${original.sourceEventId}`,
      ).toEqual([{ source_event_hash: original.contentHash, activity_json: original.activityJson }])
      expect(
        yield* sql`SELECT coverage_status,fill_fee_complete,session_id,request_id,heartbeat_at
            FROM broker_activity_cursors WHERE account_id = ${accountId}`,
      ).toEqual([
        {
          coverage_status: 'COMPLETE',
          fill_fee_complete: false,
          session_id: null,
          request_id: null,
          heartbeat_at: null,
        },
      ])
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])

      expect(yield* store.recordActivity(conflict, projectBrokerActivity(conflict))).toEqual({
        _tag: 'SourceConflict',
        eventId: conflict.eventId,
      })
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])
    }))

  test('retains independently recomputed coverage evidence and poisons a false completion idempotently', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const original = activityEvent(1, 1, 'fill')
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      const published = yield* claim(store)
      yield* advanceToTicket(published)
      expect(yield* store.publish(published, snapshot(published), 0)).toBe(true)
      const [before] = yield* sql<{ generation: number }>`SELECT generation FROM broker_observations
          WHERE account_id = ${accountId}`
      if (before === undefined) throw new Error('Missing broker observation owner')

      const valid = activityCatchup([original])
      const prefixHash = 'f'.repeat(64)
      const completionHash = brokerActivityCompletionHash({
        rangeRequestHash: valid.rangeRequestHash,
        cursor: valid.cursor,
        eventCount: valid.eventCount,
        prefixHash,
      })
      const poisoned = {
        ...valid,
        prefixHash,
        completionHash,
        eventId: sha256(
          `${valid.session.identityHash}\nactivity-catchup\n${valid.session.sessionId}\n${valid.cursor ?? 'empty'}\n${valid.replayFromId}\n${valid.replayUntilId}\n${valid.eventCount}\n${prefixHash}\n${valid.rangeRequestHash}\n${completionHash}\n${valid.receivedAt}`,
        ),
      }
      expect(yield* store.recordActivityCatchup(poisoned)).toEqual({
        _tag: 'CoverageConflict',
        eventId: poisoned.eventId,
      })
      expect(
        yield* sql`SELECT status,reason,cursor,replay_from_id,replay_until_id,event_count,prefix_hash,
              observed_cursor,observed_event_count,observed_prefix_hash,
              range_request_hash,observed_range_request_hash,completion_hash,observed_completion_hash
            FROM broker_activity_coverage_receipts WHERE account_id = ${accountId}`,
      ).toEqual([
        {
          status: 'POISONED',
          reason: 'CATCHUP_BOUNDARY_CONFLICT',
          cursor: original.sourceEventId,
          replay_from_id: poisoned.replayFromId,
          replay_until_id: poisoned.replayUntilId,
          event_count: 1n,
          prefix_hash: prefixHash,
          observed_cursor: original.sourceEventId,
          observed_event_count: 1n,
          observed_prefix_hash: valid.prefixHash,
          range_request_hash: valid.rangeRequestHash,
          observed_range_request_hash: valid.rangeRequestHash,
          completion_hash: completionHash,
          observed_completion_hash: valid.completionHash,
        },
      ])
      expect(
        yield* sql`SELECT coverage_status,fill_fee_complete,session_id,heartbeat_at
            FROM broker_activity_cursors WHERE account_id = ${accountId}`,
      ).toEqual([{ coverage_status: 'POISONED', fill_fee_complete: true, session_id: null, heartbeat_at: null }])
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])

      expect(yield* store.recordActivityCatchup(poisoned)).toEqual({
        _tag: 'CoverageConflict',
        eventId: poisoned.eventId,
      })
      expect(yield* sql`SELECT count(*)::integer AS count FROM broker_activity_coverage_receipts`).toEqual([
        { count: 1 },
      ])
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
    }))

  test('retains a late publication and poisons the finite range it contradicts idempotently', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const original = activityEvent(1, 1, 'fill')
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      const boundary = activityCatchup([original], activityCursor(3))
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(boundary))
      accepted<BrokerActivityHeartbeatReceipt>(
        yield* store.recordActivityHeartbeat(activityHeartbeat(original.sourceEventId)),
      )
      const published = yield* claim(store)
      yield* advanceToTicket(published)
      expect(yield* store.publish(published, snapshot(published), 0)).toBe(true)
      const [before] = yield* sql<{ generation: number }>`SELECT generation FROM broker_observations
          WHERE account_id = ${accountId}`
      if (before === undefined) throw new Error('Missing broker observation owner')

      const late = activityEvent(2, 2, 'fill')
      expect(yield* store.recordActivity(late, projectBrokerActivity(late))).toEqual({
        _tag: 'CoverageConflict',
        eventId: late.eventId,
      })
      const observedEvidence = brokerActivityPrefixEvidence(
        [original, late].map(({ sourceEventId, contentHash: sourceEventHash }) => ({
          sourceEventId,
          sourceEventHash,
        })),
      )
      const observedCompletionHash = brokerActivityCompletionHash({
        rangeRequestHash: boundary.rangeRequestHash,
        cursor: late.sourceEventId,
        ...observedEvidence,
      })
      expect(
        yield* sql`SELECT status,reason,cursor,replay_from_id,replay_until_id,event_count,prefix_hash,
              observed_cursor,observed_event_count,observed_prefix_hash,
              range_request_hash,observed_range_request_hash,completion_hash,observed_completion_hash
            FROM broker_activity_coverage_receipts
            WHERE account_id = ${accountId} AND status = 'POISONED'`,
      ).toEqual([
        {
          status: 'POISONED',
          reason: 'LATE_PUBLICATION',
          cursor: original.sourceEventId,
          replay_from_id: boundary.replayFromId,
          replay_until_id: boundary.replayUntilId,
          event_count: 1n,
          prefix_hash: boundary.prefixHash,
          observed_cursor: late.sourceEventId,
          observed_event_count: 2n,
          observed_prefix_hash: observedEvidence.prefixHash,
          range_request_hash: boundary.rangeRequestHash,
          observed_range_request_hash: boundary.rangeRequestHash,
          completion_hash: boundary.completionHash,
          observed_completion_hash: observedCompletionHash,
        },
      ])
      expect(
        yield* sql`SELECT last_source_event_id,coverage_status,fill_fee_complete,session_id,request_id,heartbeat_at
            FROM broker_activity_cursors WHERE account_id = ${accountId}`,
      ).toEqual([
        {
          last_source_event_id: late.sourceEventId,
          coverage_status: 'POISONED',
          fill_fee_complete: true,
          session_id: null,
          request_id: null,
          heartbeat_at: null,
        },
      ])
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])
      expect(yield* store.recordActivity(late, projectBrokerActivity(late))).toEqual({
        _tag: 'CoverageConflict',
        eventId: late.eventId,
      })
      expect(yield* sql`SELECT count(*)::integer AS count FROM broker_activity_coverage_receipts`).toEqual([
        { count: 2 },
      ])
      expect(yield* sql`SELECT generation,available FROM broker_observations WHERE account_id = ${accountId}`).toEqual([
        { generation: before.generation + 1, available: false },
      ])
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
    }))

  test('fences retired revision activity before it can create durable evidence', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const retiredRevision = 'b'.repeat(40)
      const retired = makeBrokerObservationStore(sql, accountId, retiredRevision, 60_000, cacheFixture.cache)
      const current = activityEvent(1, 1, 'fill')
      const event = { ...current, session: { ...current.session, sourceRevision: retiredRevision } }
      expect(yield* retired.recordActivity(event, projectBrokerActivity(event))).toEqual({
        _tag: 'RetiredRevision',
        activeSourceRevision: revision,
      })
      expect(yield* sql`SELECT count(*)::integer AS count FROM broker_activity_events`).toEqual([{ count: 0 }])
      expect(yield* sql`SELECT count(*)::integer AS count FROM broker_activity_cursors`).toEqual([{ count: 0 }])
    }))

  test('serializes activity append behind the same writer fence as final order authorization', async () =>
    run(function* (sql, store) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.activate(0)
          const blocker = yield* sql.reserve
          yield* blocker.executeUnprepared('BEGIN', [], undefined)
          yield* Effect.addFinalizer(() => blocker.executeUnprepared('ROLLBACK', [], undefined).pipe(Effect.ignore))
          yield* blocker.executeValues('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [1_111_578_958, 1])
          const event = activityEvent(1, 1, 'fill')
          const append = yield* store
            .recordActivity(event, projectBrokerActivity(event))
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          expect(append.pollUnsafe()).toBeUndefined()
          yield* blocker.executeUnprepared('COMMIT', [], undefined)
          expect(accepted<BrokerActivityReceipt>(yield* Fiber.join(append))).toMatchObject({
            eventId: event.eventId,
            cursor: event.sourceEventId,
          })
        }),
      )
    }))

  test('deduplicates only an economically identical activity reference and closes on a conflict', async () =>
    run(function* (_sql, store) {
      const original = activityEvent(1, 1, 'fill')
      accepted<BrokerActivityReceipt>(yield* store.recordActivity(original, projectBrokerActivity(original)))
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([original])))
      accepted<BrokerActivityHeartbeatReceipt>(
        yield* store.recordActivityHeartbeat(activityHeartbeat(original.sourceEventId)),
      )

      const duplicate = redeliveredActivity(original, 2)
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(duplicate, projectBrokerActivity(duplicate))),
      ).toMatchObject({
        projection: 'Duplicate',
        fillFeeComplete: true,
      })
      expect((yield* store.readAccountActivity).fills).toHaveLength(1)

      const conflict = activityEvent(3, 1, 'fill')
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(conflict, projectBrokerActivity(conflict))),
      ).toMatchObject({
        projection: 'ReconcileRequired',
        fillFeeComplete: false,
      })
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
    }))

  test('keeps the fill and fee cut complete across an equivalent cash journal republication', async () =>
    run(function* (sql, store) {
      const journal = canonicalActivityEvent(1, 1)
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(journal, projectBrokerActivity(journal))),
      ).toMatchObject({
        cursor: journal.sourceEventId,
        projection: 'CanonicalOnly',
        fillFeeComplete: true,
      })
      accepted<BrokerActivityCursorState>(yield* store.recordActivityCatchup(activityCatchup([journal])))
      accepted<BrokerActivityHeartbeatReceipt>(
        yield* store.recordActivityHeartbeat(activityHeartbeat(journal.sourceEventId)),
      )
      const duplicate = redeliveredActivity(journal, 2)
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(duplicate, projectBrokerActivity(duplicate))),
      ).toMatchObject({
        cursor: duplicate.sourceEventId,
        projection: 'Duplicate',
        fillFeeComplete: true,
      })
      const cut = yield* store.readAccountActivity
      expect(cut.fills).toEqual([])
      expect([...cut.feeCounts]).toEqual([])
      expect(
        yield* sql`SELECT outcome,reason FROM broker_activity_event_projections
            WHERE account_id = ${accountId} AND source_event_id = ${journal.sourceEventId}`,
      ).toEqual([{ outcome: 'CANONICAL_ONLY', reason: 'OUTSIDE_FILL_FEE_VIEW' }])

      const conflict = redeliveredActivity(canonicalActivityEvent(1, 1, '101.00'), 3)
      expect(
        accepted<BrokerActivityReceipt>(yield* store.recordActivity(conflict, projectBrokerActivity(conflict))),
      ).toMatchObject({
        cursor: conflict.sourceEventId,
        projection: 'ReconcileRequired',
        fillFeeComplete: false,
      })
      expect(Result.isFailure(yield* store.readAccountActivity.pipe(Effect.result))).toBe(true)
    }))

  test('migrates legacy receipts and fences predecessor order writes before any payload redelivery', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 206))),
          table: 'schema_migrations',
        })
        const event = sourceEvent('5'.repeat(64), '2026-11-01T00:00:00.000Z')
        yield* sql`INSERT INTO broker_notification_receipts(account_id,event_id,source_revision,received_at)
          VALUES (${accountId},${event.eventId},${revision},${event.receivedAt}::timestamptz)`
        const legacyOrderEventId = '6'.repeat(64)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO broker_events(
              event_id,schema_version,content_hash,event_kind,broker,account_id,source_event_id,source_sequence,
              occurred_at,observed_at
            ) VALUES (
              ${legacyOrderEventId},'bayn.paper-broker-event.v1',${'7'.repeat(64)},'ORDER','ALPACA',${accountId},
              'order:legacy-order:2026-11-01T00:00:00.000900Z',0,
              ${event.receivedAt}::timestamptz,${event.receivedAt}::timestamptz
            )`
            yield* sql`INSERT INTO orders(
              event_id,account_id,schema_version,broker_order_id,client_order_id,symbol,side,order_type,time_in_force,
              quantity_atoms,filled_quantity_atoms,status
            ) VALUES (
              ${legacyOrderEventId},${accountId},'bayn.order.v3','legacy-order','legacy-client','AAPL','BUY','MARKET','DAY',
              1000000000,0,'NEW'
            )`
          }),
        )
        const [{ receiptTableOid }] =
          yield* sql`SELECT 'broker_notification_receipts'::regclass::oid::integer AS "receiptTableOid"`

        yield* Effect.scoped(
          Effect.gen(function* () {
            const predecessor = yield* sql.reserve
            yield* predecessor.executeUnprepared(
              `PREPARE predecessor_order_insert(text,text,text,text,text,text,text,text,text,numeric,numeric,text) AS
                INSERT INTO orders(
                  event_id,account_id,schema_version,broker_order_id,client_order_id,symbol,side,order_type,
                  time_in_force,quantity_atoms,filled_quantity_atoms,status
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [],
              undefined,
            )
            yield* postgresMigrations

            const predecessorInsert = (
              eventId: string,
              contentHash: string,
              updatedAt: string,
              status: 'PENDING' | 'CANCELED',
            ) =>
              Effect.gen(function* () {
                yield* predecessor.executeValues('BEGIN', [])
                const result = yield* Effect.gen(function* () {
                  yield* predecessor.executeValues(
                    `INSERT INTO broker_events(
                      event_id,schema_version,content_hash,event_kind,broker,account_id,source_event_id,
                      source_sequence,occurred_at,observed_at
                    ) VALUES ($1,'bayn.paper-broker-event.v1',$2,'ORDER','ALPACA',$3,$4,1,$5::timestamptz,$5::timestamptz)`,
                    [eventId, contentHash, accountId, `order:legacy-order:${updatedAt}`, event.receivedAt],
                  )
                  yield* predecessor.executeUnprepared(
                    `EXECUTE predecessor_order_insert(
                      '${eventId}','broker-observations-test-account','bayn.order.v3','legacy-order',
                      'legacy-client-${status.toLowerCase()}','AAPL','BUY','MARKET','DAY',1000000000,0,'${status}'
                    )`,
                    [],
                    undefined,
                  )
                }).pipe(Effect.result)
                yield* predecessor.executeValues(Result.isSuccess(result) ? 'COMMIT' : 'ROLLBACK', [])
                return result
              })

            expect(
              Result.isFailure(
                yield* predecessorInsert('8'.repeat(64), '9'.repeat(64), '2026-11-01T00:00:00.000100Z', 'PENDING'),
              ),
            ).toBe(true)
            const successor = yield* predecessorInsert(
              'a'.repeat(64),
              'b'.repeat(64),
              '2026-11-01T00:00:00.001Z',
              'CANCELED',
            )
            expect(Result.isSuccess(successor)).toBe(true)
          }),
        )

        const store = makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache)
        expect(yield* sql`SELECT 'broker_notification_receipts'::regclass::oid::integer AS "receiptTableOid"`).toEqual([
          { receiptTableOid },
        ])
        expect(yield* sql`SELECT broker_updated_at FROM orders WHERE event_id = ${legacyOrderEventId}`).toEqual([
          { broker_updated_at: '2026-11-01T00:00:00.000900000Z' },
        ])
        expect(
          yield* sql`SELECT status,broker_updated_at FROM orders
            WHERE account_id = ${accountId} AND broker_order_id = 'legacy-order'
            ORDER BY broker_updated_at COLLATE "C"`,
        ).toEqual([
          { status: 'NEW', broker_updated_at: '2026-11-01T00:00:00.000900000Z' },
          { status: 'CANCELED', broker_updated_at: '2026-11-01T00:00:00.001000000Z' },
        ])
        const drainingEventId = '3'.repeat(64)
        yield* sql`INSERT INTO broker_notification_receipts(account_id,event_id,source_revision,received_at)
          VALUES (${accountId},${drainingEventId},${revision},${event.receivedAt}::timestamptz)`
        expect(
          yield* sql`SELECT event_id FROM broker_notification_receipts
            WHERE account_id = ${accountId} AND event_id = ${drainingEventId}`,
        ).toEqual([{ event_id: drainingEventId }])
        expect(
          Result.isFailure(
            yield* sql`UPDATE broker_notification_receipts SET received_at = received_at
              WHERE account_id = ${accountId} AND event_id = ${drainingEventId}`.pipe(Effect.result),
          ),
        ).toBe(true)
        expect(yield* store.recordNotification(event)).toEqual({ covered: false })
        expect(yield* store.readSourceProjection(event.eventId)).toEqual({
          _tag: 'ReconcileRequired',
          eventId: event.eventId,
          observedAt: event.receivedAt,
          reason: BrokerStreamReconciliationReason.LegacyReceipt,
        })
        expect(Result.isFailure(yield* store.readNotification(event.eventId).pipe(Effect.result))).toBe(true)
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO broker_source_events(
              account_id,event_id,source_revision,received_at,event_kind,session_id,notification
            ) VALUES (
              ${accountId},${'4'.repeat(64)},${revision},${event.receivedAt}::timestamptz,
              'TradeUpdate','invalid-null-payload',NULL
            )`.pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          yield* sql`SELECT event_kind, notification, outcome, reason
            FROM broker_source_events JOIN broker_source_event_projections USING (account_id,event_id)
            WHERE account_id = ${accountId} AND event_id = ${event.eventId}`,
        ).toEqual([
          {
            event_kind: 'LEGACY_RECEIPT',
            notification: null,
            outcome: 'RECONCILE_REQUIRED',
            reason: 'LEGACY_RECEIPT',
          },
        ])
      }),
    ))

  test('a failed trade projection poisons only its broker session while canonical coverage is an explicit no-op', async () =>
    run(function* (_sql, store) {
      const receivedAt = '2026-11-01T00:00:00.000Z'
      const cleanSession = 'clean-session'
      const boundary = sourceEvent('7'.repeat(64), receivedAt, cleanSession)
      const covered = tradeSourceEvent('8'.repeat(64), receivedAt, cleanSession)
      yield* store.recordNotification(boundary)
      yield* store.recordNotification(covered)
      yield* store.recordProjection({
        _tag: 'ReconcileRequired',
        eventId: boundary.eventId,
        observedAt: boundary.receivedAt,
        reason: BrokerStreamReconciliationReason.SessionBoundary,
      })
      expect(yield* store.hasSessionProjectionGap(cleanSession)).toBe(false)

      yield* store.activate(0)
      const ticket = yield* claim(store)
      yield* advanceToTicket(ticket)
      expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(true)
      expect(yield* store.isNotificationCovered(covered.eventId)).toBe(true)
      const coveredReceipt = {
        _tag: 'CanonicallyCovered',
        eventId: covered.eventId,
        observedAt: covered.receivedAt,
      } as const
      expect(yield* store.recordProjection(coveredReceipt)).toEqual(coveredReceipt)
      expect(yield* store.readSourceProjection(covered.eventId)).toEqual(coveredReceipt)
      expect(yield* store.hasSessionProjectionGap(cleanSession)).toBe(false)

      const poisonedSession = 'poisoned-session'
      const invalid = tradeSourceEvent('9'.repeat(64), receivedAt, poisonedSession)
      yield* store.recordNotification(invalid)
      yield* store.recordProjection({
        _tag: 'ReconcileRequired',
        eventId: invalid.eventId,
        observedAt: invalid.receivedAt,
        reason: BrokerStreamReconciliationReason.InvalidFill,
      })
      expect(yield* store.hasSessionProjectionGap(poisonedSession)).toBe(true)

      const recovery = yield* claim(store)
      yield* advanceToTicket(recovery)
      expect(yield* store.publish(recovery, snapshot(recovery), 0)).toBe(true)
      expect(yield* store.isNotificationCovered(invalid.eventId)).toBe(true)
      expect(yield* store.hasSessionProjectionGap(poisonedSession)).toBe(true)
      expect(yield* store.hasSessionProjectionGap('replacement-session')).toBe(false)
    }))

  test('consecutive poll tickets share a generation boundary until a durable invalidation', async () =>
    run(function* (_sql, store) {
      yield* store.activate(0)
      const { ticket: first } = yield* publishFresh(store)
      const second = yield* claim(store)
      expect(second.generation).toBe(first.generation + 1)
      yield* advanceToTicket(second)
      yield* store.publish(second, snapshot(second), 0)
      yield* store.invalidate
      const next = yield* claim(store)
      expect(next.generation).toBeGreaterThan(second.generation + 1)
    }))

  test('hard migration removes the database payload and compact reads retain the exact parent snapshot', async () =>
    run(function* (sql, store) {
      const columns = yield* sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'broker_observations' AND column_name = 'payload'`
      expect(columns).toEqual([])
      yield* store.activate(0)
      const { value } = yield* publishFresh(store)
      expect(yield* store.readState).toEqual(observedBrokerState(value))
      yield* sql`UPDATE broker_observations SET snapshot_hash = ${'0'.repeat(64)} WHERE account_id = ${accountId}`
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
    }))

  test.each([60_000, 60_001])('expired available metadata at %sms fails before reading cache bytes', async (ageMs) =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket, value } = yield* publishFresh(store)
      let reads = 0
      const measured = makeBrokerObservationStore(sql, accountId, revision, 60_000, {
        ...cacheFixture.cache,
        get: (key) => Effect.sync(() => reads++).pipe(Effect.andThen(cacheFixture.cache.get(key))),
      })
      yield* advanceToTicket(ticket, 59_999)
      expect(yield* measured.read).toEqual(value)
      expect(yield* measured.readState).toEqual(observedBrokerState(value))
      expect(reads).toBe(2)
      reads = 0
      yield* advanceToTicket(ticket, ageMs)
      for (const read of [measured.read, measured.readState]) {
        const failure = yield* Effect.flip(read)
        expect(failure.kind).toBe(BrokerReadErrorKind.Timeout)
        expect(failure.retryable).toBe(true)
        expect(failure.observationFailure).toBeUndefined()
      }
      expect(reads).toBe(0)
    }),
  )

  test.each([60_000, 60_001])('expired available submission metadata at %sms skips cache bytes', async (ageMs) =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket, value } = yield* publishFresh(store)
      const intentId = 'd'.repeat(64)
      yield* reserve(sql, intentId, utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 1))
      let reads = 0
      const measured = makeBrokerObservationStore(sql, accountId, revision, 60_000, {
        ...cacheFixture.cache,
        get: (key) => Effect.sync(() => reads++).pipe(Effect.andThen(cacheFixture.cache.get(key))),
      })
      yield* advanceToTicket(ticket, 59_999)
      expect(yield* measured.readForSubmit(intentId)).toEqual(observedBrokerState(value))
      expect(reads).toBe(1)
      reads = 0
      yield* advanceToTicket(ticket, ageMs)
      const failure = yield* Effect.flip(measured.readForSubmit(intentId))
      expect(failure.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(failure.retryable).toBe(true)
      expect(failure.observationFailure).toBeUndefined()
      expect(reads).toBe(0)
    }),
  )

  test('missing or corrupt Valkey bytes fail without a database payload fallback', async () =>
    run(function* (_sql, store) {
      yield* store.activate(0)
      const { ticket } = yield* publishFresh(store)
      cacheFixture.values.clear()
      expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
      yield* store.publish(ticket, snapshot(ticket), 0)
      for (const [key, value] of cacheFixture.values)
        if (key.startsWith('bayn:broker:state:')) cacheFixture.values.set(key, { ...value, value: 'invalid-json' })
      expect(Result.isFailure(yield* store.readState.pipe(Effect.result))).toBe(true)
    }))

  test('failed cache publication cannot expose availability or settle a capture claim', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const ticket = yield* claim(store)
      yield* advanceToTicket(ticket)
      const failed = makeBrokerObservationStore(sql, accountId, revision, 60_000, {
        ...cacheFixture.cache,
        putAll: () => Effect.fail(new ValkeyCacheError({ operation: 'put', message: 'replica unavailable' })),
      })
      expect(Result.isFailure(yield* failed.publish(ticket, snapshot(ticket), 0).pipe(Effect.result))).toBe(true)
      const rows =
        yield* sql`SELECT available, snapshot_hash, state_hash FROM broker_observations WHERE account_id = ${accountId}`
      expect(rows).toEqual([{ available: false, snapshot_hash: null, state_hash: null }])
      const captures = yield* sql`SELECT settled FROM broker_observation_captures WHERE account_id = ${accountId}`
      expect(captures).toEqual([{ settled: false }])
    }))

  test('a capture is claimed only once across restarts, later captures and source rotation', async () =>
    run(function* (sql, store) {
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
    }))

  test('activation adopts the legacy deadline and source rotation cannot shorten it', async () =>
    run(function* (sql, store) {
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
    }))

  test('concurrent captures share one durable quota reservation across worker restarts', async () =>
    run(function* (sql, store) {
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
    }))

  test('an early notification cannot start HTTP before the original mutation deadline while the account turn is held', async () =>
    run(function* (sql, store) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.activate(0)
          const [timing] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                occurredAt: Schema.String,
                deadlineMs: Schema.Number,
              }),
            ]),
          )(
            yield* sql`WITH timing AS (SELECT clock_timestamp() AS occurred_at)
          SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
            ceil(EXTRACT(EPOCH FROM occurred_at + interval '1 second') * 1000)::double precision AS "deadlineMs"
          FROM timing`,
          )
          yield* reserve(sql, '1'.repeat(64), timing.occurredAt)
          const released = yield* Deferred.make<void>()
          let accountCompleted = false
          const accountTurn = yield* Deferred.await(released).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                accountCompleted = true
              }),
            ),
            Effect.forkScoped,
          )
          const until = (afterMs: number) => sql`SELECT pg_sleep(GREATEST(0,
          EXTRACT(EPOCH FROM ${timing.occurredAt}::timestamptz + ${afterMs} * interval '1 millisecond' - clock_timestamp())))`
          yield* until(50)
          yield* store.recordNotification(
            sourceEvent('2'.repeat(64), new Date(Date.parse(timing.occurredAt) + 50).toISOString()),
          )
          yield* until(150)
          const captureId = randomUUID()
          expect(yield* store.begin(captureId, timing.deadlineMs + 180_000)).toEqual({
            status: BrokerObservationClaimStatus.QuotaWait,
            nextPollNotBeforeMs: timing.deadlineMs,
          })
          yield* until(250)
          expect(yield* store.begin(captureId, timing.deadlineMs + 180_000)).toEqual({
            status: BrokerObservationClaimStatus.QuotaWait,
            nextPollNotBeforeMs: timing.deadlineMs,
          })
          expect(accountCompleted).toBe(false)
          expect(
            yield* sql`SELECT capture_id FROM broker_observation_captures WHERE account_id = ${accountId}`,
          ).toEqual([])
          yield* until(1000)
          const admitted = yield* store.begin(captureId, timing.deadlineMs + 180_000)
          if (admitted.status !== BrokerObservationClaimStatus.Reserved)
            throw new Error('Original mutation deadline did not admit its capture')
          yield* advanceToTicket(admitted.ticket)
          expect(yield* store.publish(admitted.ticket, snapshot(admitted.ticket), 0)).toBe(true)
          expect(yield* store.readState).toEqual(observedBrokerState(snapshot(admitted.ticket)))
          expect(
            yield* sql`SELECT capture_id FROM broker_observation_captures WHERE account_id = ${accountId}`,
          ).toEqual([{ capture_id: captureId }])
          expect(accountCompleted).toBe(false)
          yield* Deferred.succeed(released, undefined)
          yield* Fiber.join(accountTurn)
          expect(accountCompleted).toBe(true)
        }),
      )
    }))

  test.each(['quota', 'mutation'] as const)(
    'capture admission retains the later %s deadline and ignores another account',
    async (later) =>
      run(function* (sql, store) {
        const [timing] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              occurredAt: Schema.String,
              mutationDeadlineMs: Schema.Number,
            }),
          ]),
        )(
          yield* sql`WITH timing AS (SELECT clock_timestamp() AS occurred_at)
        SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
          ceil(EXTRACT(EPOCH FROM occurred_at + interval '1 second') * 1000)::double precision AS "mutationDeadlineMs"
        FROM timing`,
        )
        const quotaDeadline = timing.mutationDeadlineMs + (later === 'quota' ? 5_000 : -500)
        yield* store.activate(quotaDeadline)
        yield* reserve(sql, '1'.repeat(64), timing.occurredAt)
        expect(yield* store.begin(randomUUID(), timing.mutationDeadlineMs + 180_000)).toEqual({
          status: BrokerObservationClaimStatus.QuotaWait,
          nextPollNotBeforeMs: Math.max(quotaDeadline, timing.mutationDeadlineMs),
        })
        expect(yield* sql`SELECT capture_id FROM broker_observation_captures WHERE account_id = ${accountId}`).toEqual(
          [],
        )
        const unrelated = makeBrokerObservationStore(sql, 'unrelated-account', revision, 60_000, cacheFixture.cache)
        yield* unrelated.activate(0)
        expect((yield* unrelated.begin(randomUUID(), 0)).status).toBe(BrokerObservationClaimStatus.Reserved)
      }),
  )

  test('a raced invalidation settles only its own quota after completed HTTP', async () =>
    run(function* (sql, store) {
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
    }))

  test('publication retains measured HTTP debt instead of the lost-worker reservation', async () =>
    run(function* (sql, store) {
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
    }))

  test('starts unavailable, publishes a complete cut and survives a reader restart', async () =>
    run(function* (sql, store) {
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
    }))
  test('publishes current broker state during fee settlement and fences reconciliation and normal submission', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const held = yield* claim(store)
      yield* advanceToTicket(held)
      const pending = { ...snapshot(held), pendingCashFeeCount: 2 }
      expect(yield* store.publish(held, pending, 0)).toBe(true)
      const restarted = makeBrokerObservationStore(sql, accountId, revision, 60_000, cacheFixture.cache)
      expect(yield* restarted.readState).toEqual(observedBrokerState(pending))
      const readiness = yield* rolloutReadiness(sql, restarted)
      expect(readiness.status.status).toBe(200)
      expect(readiness.trading.status).toBe(503)
      expect(readiness.current.broker?.readAvailable).toBe(false)
      expect(yield* Effect.flip(restarted.read)).toMatchObject({
        kind: BrokerReadErrorKind.ObservationPending,
        observationFailure: 'CASH_FEES_PENDING',
      })

      const intentId = 'd'.repeat(64)
      yield* reserve(sql, intentId, utcInstantFromEpochMillis(Date.parse(held.startedAt) + 1))
      yield* advanceToTicket(held, 2)
      expect(yield* Effect.flip(restarted.readForSubmit(intentId))).toMatchObject({
        kind: BrokerReadErrorKind.ObservationPending,
        observationFailure: 'CASH_FEES_PENDING',
      })
    }))
  test('persists source precision and hashes across a reader restart', async () =>
    run(function* (sql, store) {
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
    }))
  test('rejects an undecodable cut before publishing availability or payload', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const ticket = yield* claim(store)
      yield* advanceToTicket(ticket)
      const malformed = observedBrokerSnapshotFixture(accountId, ticket.startedAt, '2026-02-30T17:15:20.123456Z')
      expect(Result.isFailure(yield* store.publish(ticket, malformed, 0).pipe(Effect.result))).toBe(true)
      const rows =
        yield* sql`SELECT available, state_hash, snapshot_hash FROM broker_observations WHERE account_id = ${accountId}`
      expect(rows).toEqual([{ available: false, state_hash: null, snapshot_hash: null }])
    }))
  test.each(['invalidate', 'failed', 'new-ticket', 'revision'] as const)(
    'rejects late publication after %s',
    async (change) =>
      run(function* (sql, store) {
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
  )

  test('replaying an unfinished capture invalidates the old cut and fences its late publication', async () =>
    run(function* (_sql, store) {
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
    }))

  test('replay preserves a published lost result and cannot invalidate a newer cut', async () =>
    run(function* (_sql, store) {
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
    }))

  test('interrupting the owned unfinished capture fences its old cut without releasing unknown HTTP debt', async () =>
    run(function* (sql, store) {
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
    }))

  test.each(['newer-capture', 'newer-revision', 'published', 'unclaimed'] as const)(
    'an interrupted poll preserves the successful %s observation',
    async (change) =>
      run(function* (sql, store) {
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
  )

  test('latest poll failure closes a previously fresh projection and cannot overwrite a newer poll', async () =>
    run(function* (_sql, store) {
      yield* store.activate(0)
      yield* publishFresh(store)
      const second = yield* claim(store)
      yield* store.failed(second, 0)
      expect(Result.isFailure(yield* store.read.pipe(Effect.result))).toBe(true)
      const { ticket: third } = yield* publishFresh(store)
      yield* store.failed(second, 0)
      expect(yield* store.read).toEqual(snapshot(third))
    }))
  const pendingFixture = (
    sql: PgClient.PgClient,
    store: ReturnType<typeof makeBrokerObservationStore>,
    mask: number,
    offsetMs = 1,
  ) =>
    Effect.gen(function* () {
      yield* store.activate(0)
      const ticket = yield* claim(store)
      yield* advanceToTicket(ticket)
      expect(yield* store.publish(ticket, snapshot(ticket), 0)).toBe(true)
      // Give all three fixture boundaries the same exact millisecond. Production
      // publication continues to use its own independently recorded timestamps.
      yield* sql`UPDATE broker_observations SET completed_at = ${ticket.startedAt}::timestamptz,
        notification_fence_at = ${ticket.startedAt}::timestamptz WHERE account_id = ${accountId}`
      const at = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + offsetMs)
      if ((mask & 1) !== 0) yield* reserve(sql, '9'.repeat(64), at)
      if ((mask & 2) !== 0)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO broker_events (event_id, schema_version, content_hash, event_kind, broker, account_id,
              source_event_id, source_sequence, occurred_at, observed_at) VALUES (${'7'.repeat(64)}, 'bayn.paper-broker-event.v1',
              ${'7'.repeat(64)}, 'FILL', 'ALPACA', ${accountId}, 'pending-fill', 1, ${at}, ${at})`
            yield* sql`INSERT INTO fills (event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id,
              symbol, side, quantity_atoms, price_atoms, fee_micros, source_timestamp)
              VALUES (${'7'.repeat(64)}, ${accountId}, 'bayn.fill.v2', 'pending-fill', 'pending-order', 'pending-client',
              'AAPL', 'BUY', '1000000000', '100000000000', '0', ${at.replace('Z', '000000Z')})`
          }),
        )
      if ((mask & 4) !== 0)
        yield* sql`INSERT INTO broker_source_events (account_id, event_id, source_revision, received_at, recorded_at, event_kind)
          VALUES (${accountId}, ${'8'.repeat(64)}, ${revision}, ${at}::timestamptz, ${at}::timestamptz, 'LEGACY_RECEIPT')`
      yield* advanceToTicket(ticket, 1000)
      return ticket
    })

  test.each([1, 2, 3, 4, 5, 6, 7])(
    'projects the selected pending cut fence mask %s without admitting it',
    async (mask) =>
      run(function* (sql, store) {
        yield* pendingFixture(sql, store, mask)
        const { result, attributes } = yield* readWithPendingFences(store.readState)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.kind).toBe(BrokerReadErrorKind.ObservationPending)
          expect(result.failure.retryable).toBe(true)
        }
        expect(attributes).toEqual({
          'bayn.broker.observation.pending.newer_mutation': (mask & 1) !== 0,
          'bayn.broker.observation.pending.newer_broker_event': (mask & 2) !== 0,
          'bayn.broker.observation.pending.newer_notification': (mask & 4) !== 0,
        })
      }),
  )

  test.each([
    [1, -1, false],
    [1, 0, true],
    [1, 1, true],
    [2, -1, false],
    [2, 0, false],
    [2, 1, true],
    [4, -1, false],
    [4, 0, false],
    [4, 1, true],
  ] as const)('retains fence %s boundary %s semantics', async (mask, offsetMs, pending) =>
    run(function* (sql, store) {
      yield* pendingFixture(sql, store, mask, offsetMs)
      const { result, attributes } = yield* readWithPendingFences(store.readState)
      expect(Result.isFailure(result)).toBe(pending)
      if (Result.isFailure(result)) expect(result.failure.kind).toBe(BrokerReadErrorKind.ObservationPending)
      expect(attributes).toEqual(
        pending
          ? {
              'bayn.broker.observation.pending.newer_mutation': mask === 1,
              'bayn.broker.observation.pending.newer_broker_event': mask === 2,
              'bayn.broker.observation.pending.newer_notification': mask === 4,
            }
          : {},
      )
    }),
  )

  test.each(['future-completion', 'inverted-poll', 'expired', 'foreign-revision'] as const)(
    'does not label an excluded %s cut with pending fences',
    async (condition) =>
      run(function* (sql, store) {
        const ticket = yield* pendingFixture(sql, store, 7)
        if (condition === 'future-completion')
          yield* sql`UPDATE broker_observations SET completed_at = ${ticket.startedAt}::timestamptz + interval '2 seconds' WHERE account_id = ${accountId}`
        if (condition === 'inverted-poll')
          yield* sql`UPDATE broker_observations SET completed_at = ${ticket.startedAt}::timestamptz - interval '1 millisecond' WHERE account_id = ${accountId}`
        if (condition === 'expired') yield* advanceToTicket(ticket, 60_000)
        const reader =
          condition === 'foreign-revision'
            ? makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
            : store
        const { result, attributes } = yield* readWithPendingFences(reader.readState)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.kind).toBe(BrokerReadErrorKind.Timeout)
          expect(result.failure.observationFailure).toBe('NO_ADMISSIBLE_CUT')
        }
        expect(attributes).toEqual({})
      }),
  )

  test.each([1, 4])(
    'bounds diagnostic query work against the same pending cut with retained history: %s',
    async (mask) =>
      run(function* (sql, store) {
        const ticket = yield* pendingFixture(sql, store, mask)
        if (mask === 4)
          yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(ticket.startedAt) - 60_000))
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Migrated indexes and column constraints, isolated from other fixtures.
            // These tables contain synthetic read-path history, not financial postings.
            yield* sql`CREATE TEMP TABLE mutation_events (LIKE public.mutation_events INCLUDING ALL) ON COMMIT DROP`
            yield* sql`INSERT INTO mutation_events SELECT * FROM public.mutation_events`
            yield* sql`INSERT INTO mutation_events
              (event_id,schema_version,mutation_id,intent_id,sequence,operation,event_type,request_hash,consistency_delay_ms,occurred_at)
              SELECT md5('mutation-' || n) || md5(n::text), 'bayn.paper-mutation-event.v1',
                ${'9'.repeat(64)}, ${'9'.repeat(64)}, n + 1, 'SUBMIT', 'RECOVERY_UNKNOWN', ${'f'.repeat(64)}, 1000,
                ${ticket.startedAt}::timestamptz - interval '60 seconds'
              FROM generate_series(1,8192) AS n`
            yield* sql`CREATE TEMP TABLE broker_events (LIKE public.broker_events INCLUDING ALL) ON COMMIT DROP`
            yield* sql`CREATE TRIGGER broker_event_projection_hash BEFORE INSERT ON pg_temp.broker_events
              FOR EACH ROW EXECUTE FUNCTION initialize_broker_event_projection_hash()`
            yield* sql`INSERT INTO broker_events
              (event_id,schema_version,content_hash,event_kind,broker,account_id,source_event_id,source_sequence,occurred_at,observed_at)
              SELECT md5('event-' || n) || md5(n::text), 'bayn.paper-broker-event.v1', md5(n::text) || md5('content-' || n),
                'ACCOUNT', 'ALPACA', CASE WHEN n <= 4096 THEN ${accountId} ELSE 'foreign-account' END,
                'history-' || n, n, ${ticket.startedAt}::timestamptz - interval '60 seconds',
                ${ticket.startedAt}::timestamptz + CASE WHEN n <= 4096 THEN interval '-60 seconds' ELSE interval '60 seconds' END
              FROM generate_series(1,8192) AS n`
            yield* sql`CREATE TEMP TABLE broker_source_events (LIKE public.broker_source_events INCLUDING ALL) ON COMMIT DROP`
            yield* sql`INSERT INTO broker_source_events SELECT * FROM public.broker_source_events`
            yield* sql`INSERT INTO broker_source_events(account_id,event_id,source_revision,received_at,recorded_at,event_kind)
              SELECT CASE WHEN n <= 4096 THEN ${accountId} ELSE 'foreign-account' END,
                md5('receipt-' || n) || md5(n::text), ${revision},
                ${ticket.startedAt}::timestamptz - interval '60 seconds',
                ${ticket.startedAt}::timestamptz + CASE WHEN n <= 4096 THEN interval '-60 seconds' ELSE interval '60 seconds' END,
                'LEGACY_RECEIPT'
              FROM generate_series(1,8192) AS n`
            yield* sql`ANALYZE mutation_events`
            yield* sql`ANALYZE broker_events`
            yield* sql`ANALYZE broker_source_events`
            yield* sql`ANALYZE intents`
            yield* sql`ANALYZE broker_observations`
            const reads: Statement<Record<string, unknown>>[] = []
            const monitored = new Proxy(sql, {
              apply(target, receiver, argumentsList) {
                const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
                reads.push(statement)
                return statement
              },
            })
            const reader = makeBrokerObservationStore(monitored, accountId, revision, 60_000, cacheFixture.cache)
            // Store construction also builds the lazy invalidate statement;
            // it is not executed by readState and is not part of this read path.
            reads.length = 0
            const { result, attributes } = yield* readWithPendingFences(reader.readState)
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) expect(result.failure.kind).toBe(BrokerReadErrorKind.ObservationPending)
            expect(attributes).toEqual({
              'bayn.broker.observation.pending.newer_mutation': mask === 1,
              'bayn.broker.observation.pending.newer_broker_event': false,
              'bayn.broker.observation.pending.newer_notification': mask === 4,
            })
            expect(reads).toHaveLength(2)
            const pending = reads[1]
            if (pending === undefined) throw new Error('Expected the existing pending query')
            const [query, parameters] = pending.compile()
            // PostgreSQL prunes the three unused diagnostic projections here;
            // the parameters, predicates, selected row and snapshot stay identical.
            const baselineQuery = `SELECT snapshot_hash,state_hash,"observedAt" FROM (${query}) AS pending`
            const decodeCut = Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  snapshot_hash: Schema.String,
                  state_hash: Schema.String,
                  observedAt: Schema.String,
                }),
              ),
            )
            const baselineRows = yield* sql.unsafe(baselineQuery, parameters).pipe(Effect.flatMap(decodeCut))
            const diagnosticRows = yield* sql.unsafe(query, parameters).pipe(Effect.flatMap(decodeCut))
            expect(diagnosticRows).toEqual(baselineRows)
            const explain = (statement: string) =>
              sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, parameters).pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Array(
                      Schema.Struct({
                        'QUERY PLAN': Schema.Array(
                          Schema.Struct({
                            Plan: Schema.Record(Schema.String, Schema.Unknown),
                            'Execution Time': Schema.Number,
                          }),
                        ),
                      }),
                    ),
                  ),
                ),
                Effect.map((rows) => {
                  const plan = rows[0]?.['QUERY PLAN'][0]
                  if (plan === undefined) throw new Error('Missing pending-cut query plan')
                  const blocks = [
                    'Shared Hit Blocks',
                    'Shared Read Blocks',
                    'Local Hit Blocks',
                    'Local Read Blocks',
                  ].reduce((sum, key) => sum + Number(plan.Plan[key] ?? 0), 0)
                  expect(plan.Plan['Actual Rows']).toBe(1)
                  return { blocks, executionMs: plan['Execution Time'], plan: plan.Plan }
                }),
              )
            for (const reversed of [false, true, false]) {
              const first = yield* explain(reversed ? query : baselineQuery)
              const second = yield* explain(reversed ? baselineQuery : query)
              const baseline = reversed ? second : first
              const diagnostic = reversed ? first : second
              yield* Effect.logInfo('Pending-cut diagnostic query plan sample', {
                mask,
                historyRowsPerTable: 8192,
                diagnosticFirst: reversed,
                baselineBlocks: baseline.blocks,
                diagnosticBlocks: diagnostic.blocks,
                baselineExecutionMs: baseline.executionMs,
                diagnosticExecutionMs: diagnostic.executionMs,
                plans: JSON.stringify({ baseline: baseline.plan, diagnostic: diagnostic.plan }),
              })
              // The extra projection probes are not free. Bound their logical
              // read amplification without asserting timing on a shared CI host.
              expect(diagnostic.blocks).toBeLessThanOrEqual(baseline.blocks * 3 + 64)
            }
          }),
        )
      }),
  )

  test('waits for a post-mutation cut only within the lifetime of a successful observation', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket: first } = yield* publishFresh(store)
      yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
      yield* advanceToTicket(first, 1000)
      expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.ObservationPending)
      yield* store.invalidate
      expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.ObservationPending)
      yield* advanceToTicket(first, 60_000)
      const expired = yield* Effect.flip(store.read)
      expect(expired.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(expired.observationFailure).toBe('NO_ADMISSIBLE_CUT')
    }))
  test('does not classify a failed poll, foreign revision or corrupt invalidated cut as an expected wait', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket: first } = yield* publishFresh(store)
      yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
      yield* advanceToTicket(first, 1000)
      const foreign = makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
      expect((yield* Effect.flip(foreign.read)).kind).toBe(BrokerReadErrorKind.Timeout)
      yield* sql`UPDATE broker_observations SET snapshot_hash = ${'0'.repeat(64)} WHERE account_id = ${accountId}`
      const corrupt = yield* Effect.flip(store.read)
      expect(corrupt.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(corrupt.observationFailure).toBeUndefined()
      yield* sql`UPDATE broker_observations SET snapshot_hash = ${Result.getOrThrow(canonicalHashV1Result(snapshot(first)))} WHERE account_id = ${accountId}`
      yield* sql`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM
          ${first.startedAt}::timestamptz + interval '1001 milliseconds' - clock_timestamp())))`
      const second = yield* claim(store)
      yield* store.failed(second, 0)
      expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.Timeout)
    }))
  test.each(['failed', 'interrupted'] as const)(
    'status routing stays independent of exact-revision trading readiness through a %s handoff poll',
    async (failure) =>
      run(function* (sql, store) {
        yield* store.activate(0)
        const { ticket: first } = yield* publishFresh(store)
        yield* sql`INSERT INTO authority_generations
          (generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${generationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${first.startedAt})`
        const authorityBefore = yield* sql`SELECT * FROM authority_generations ORDER BY generation_hash`
        const successor = makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
        const assertReadiness = (reader: typeof store, tradingStatus: 200 | 503) =>
          Effect.gen(function* () {
            const health = yield* rolloutReadiness(sql, reader)
            expect(health.status).toMatchObject({ status: 200, body: { ready: true } })
            expect(health.trading).toMatchObject({ status: tradingStatus, body: { ready: tradingStatus === 200 } })
            if (tradingStatus === 503) expect(health.current.broker?.readAvailable).toBe(false)
            return health
          })

        // A prepared status API may route before ownership moves, but cannot read a foreign cut.
        yield* assertReadiness(store, 200)
        yield* assertReadiness(successor, 503)
        expect(yield* store.readState).toEqual(observedBrokerState(snapshot(first)))

        yield* successor.activate(0)
        const captureId = randomUUID()
        const pending = yield* claim(successor, captureId)
        yield* advanceToTicket(pending)
        if (failure === 'failed') yield* successor.failed(pending, 0)
        else yield* successor.interrupt(captureId)
        yield* assertReadiness(store, 503)
        yield* assertReadiness(successor, 503)
        expect(yield* store.publish(first, snapshot(first), 0)).toBe(false)

        const next = yield* claim(successor)
        yield* advanceToTicket(next)
        yield* successor.publish(next, snapshot(next), 0)
        yield* assertReadiness(successor, 200)
        yield* assertReadiness(store, 503)

        yield* advanceToTicket(next, 60_000)
        const stale = yield* assertReadiness(successor, 503)
        expect(stale.current.broker?.error).toContain('stale-observation')
        yield* assertReadiness(store, 503)
        expect(
          statusReadinessResponseDecision(stale.current, {
            ...stale.freshness,
            nowMs: stale.freshness.nowMs + stale.freshness.leaseMs,
          }),
        ).toMatchObject({ status: 503, body: { ready: false } })
        expect(yield* sql`SELECT * FROM authority_generations ORDER BY generation_hash`).toEqual(authorityBefore)
      }),
  )

  test('revision handoff blocks both readers until fresh publication and never admits the predecessor again', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket: first, value: previous } = yield* publishFresh(store)
      expect(yield* store.readState).toEqual(observedBrokerState(previous))
      yield* sql`INSERT INTO authority_generations
          (generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${generationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${first.startedAt})`
      const authorityBefore = yield* sql`SELECT * FROM authority_generations ORDER BY generation_hash`

      const successor = makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
      yield* successor.activate(0)
      for (const reader of [store, successor]) {
        const unavailable = yield* Effect.flip(reader.readState)
        expect(unavailable.kind).toBe(BrokerReadErrorKind.Timeout)
        expect(unavailable.observationFailure).toBe('NO_ADMISSIBLE_CUT')
      }

      const next = yield* claim(successor)
      yield* advanceToTicket(next)
      const current = snapshot(next)
      yield* successor.publish(next, current, 0)
      expect(yield* successor.readState).toEqual(observedBrokerState(current))
      const predecessor = yield* Effect.flip(store.readState)
      expect(predecessor.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(predecessor.observationFailure).toBe('NO_ADMISSIBLE_CUT')
      expect(yield* store.publish(first, previous, 0)).toBe(false)
      expect(yield* successor.readState).toEqual(observedBrokerState(current))

      yield* advanceToTicket(next, 60_000)
      expect((yield* Effect.flip(successor.readState)).message).toContain('stale-observation')
      expect(yield* sql`SELECT * FROM authority_generations ORDER BY generation_hash`).toEqual(authorityBefore)
    }))

  test.each(['absent', 'same-revision', 'foreign-revision'] as const)(
    'unavailable observation identifies only a verified foreign revision: %s',
    async (state) =>
      run(function* (sql, store) {
        if (state === 'same-revision') yield* store.activate(0)
        if (state === 'foreign-revision')
          yield* makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache).activate(0)
        const unavailable = yield* Effect.flip(store.readState)
        expect(unavailable.kind).toBe(BrokerReadErrorKind.Timeout)
        expect(unavailable.retryable).toBe(true)
        expect(unavailable.observationFailure).toBe('NO_ADMISSIBLE_CUT')
        expect(unavailable.message).toBe(
          state === 'foreign-revision'
            ? 'Broker observation source revision differs from this runtime'
            : 'Broker observation is unavailable or invalidated by a mutation',
        )
        expect(unavailable.message).not.toContain(accountId)
      }),
  )

  test('activation cannot classify a predecessor revision cut as a successful current-revision wait', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket: first } = yield* publishFresh(store)
      yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
      yield* advanceToTicket(first, 1000)
      const successor = makeBrokerObservationStore(sql, accountId, 'b'.repeat(40), 60_000, cacheFixture.cache)
      yield* successor.activate(0)
      expect((yield* Effect.flip(successor.read)).kind).toBe(BrokerReadErrorKind.Timeout)
    }))
  test('a failed poll at the previous completion timestamp remains a failure after a mutation', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket: first } = yield* publishFresh(store)
      yield* reserve(sql, '9'.repeat(64), utcInstantFromEpochMillis(Date.parse(first.startedAt) + 1))
      yield* advanceToTicket(first, 1000)
      yield* sql`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM
          ${first.startedAt}::timestamptz + interval '1001 milliseconds' - clock_timestamp())))`
      const second = { ...(yield* claim(store)), startedAt: first.startedAt }
      yield* store.failed(second, 0)
      expect((yield* Effect.flip(store.read)).kind).toBe(BrokerReadErrorKind.Timeout)
    }))
  test('permits only the currently reserved intent start and denies concurrent starts', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket } = yield* publishFresh(store)
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
    }))
  test('rejects mixed, corrupt and foreign-account persisted bytes', async () =>
    run(function* (_sql, store) {
      yield* store.activate(0)
      const { ticket } = yield* publishFresh(store)
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
    }))
  test.each(['SUBMIT_STARTED', 'SUBMIT_UNKNOWN'] as const)(
    'retains reconciliation evidence while an old unresolved %s blocks submission',
    async (eventType) =>
      run(function* (sql, store) {
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
  )
  test.each([500, 2000])(
    'requires a settled mutation to precede the poll by the consistency delay: %s ms',
    async (ageMs) =>
      run(function* (sql, store) {
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
  )
  test('a retained fill invalidates the published cut and rejects a late poll', async () =>
    run(function* (sql, store) {
      yield* store.activate(0)
      const { ticket } = yield* publishFresh(store)
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
    }))
})
