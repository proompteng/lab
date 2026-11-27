import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { BrokerEnvironment } from '../broker/identity'
import type { BrokerNotification } from '../broker/notifications'
import { sha256 } from '../hash'
import { valkeyFixture } from '../testing/valkey-fixture'
import { utcInstantFromEpochMillis } from '../time'
import { BrokerObservationClaimStatus, makeBrokerObservationStore } from './broker-observations'
import {
  atObservation,
  describeNativeJevPostgres,
  replayAccountId,
  seedManagedPosition,
} from './jev-native-postgres.test-support'

const revision = 'a'.repeat(40)
const parentId = 'protected-parent'
const childId = 'protected-stop-child'
const childClientId = 'broker-generated-child'
type ProtectionIdentityConflict =
  | 'parent intent'
  | 'parent client'
  | 'nested parent'
  | 'parent symbol'
  | 'parent side'
  | 'parent quantity'
  | 'parent limit'
  | 'child intent'
  | 'child side'
  | 'child stop'
  | 'child limit'
  | 'child quantity'
  | 'child symbol'
  | 'child duration'

const seedProtectionIntent = Effect.gen(function* () {
  // Reuse the real native fixture: its cycle, immutable pre-entry plan and protected intent must pass every
  // production admission guard. Only the append-only broker observations below are varied by each adversary.
  const { portfolio } = yield* seedManagedPosition({ nativeProtection: 'strategy' })
  const intentId = portfolio.entryIntentIds[0]
  if (intentId === undefined) throw new Error('Expected a native protected entry intent')
  const sql = yield* PgClient.PgClient
  const [intent] = yield* sql<{
    client_order_id: string
    quantity_atoms: string
    limit_price_micros: string
    protection: { stopPriceMicros: string; stopLimitPriceMicros: string; profitLimitPriceMicros: string }
  }>`SELECT client_order_id,quantity_atoms::text,limit_price_micros::text,protection
      FROM intents WHERE intent_id = ${intentId} AND account_id = ${replayAccountId}`
  if (intent === undefined) throw new Error('Expected retained immutable protection terms')
  return { intentId, intent }
})

const retainProtectionIdentity = (
  { intentId, intent }: Effect.Success<typeof seedProtectionIntent>,
  observedAt: string,
  conflict?: ProtectionIdentityConflict,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const foreignIntentId = sha256('unrelated-protection-binding-intent')
    if (conflict === 'parent intent' || conflict === 'child intent')
      yield* sql`INSERT INTO intents (
        intent_id,schema_version,authority_generation_hash,strategy_name,cycle_id,decision_hash,policy_hash,
        account_id,client_order_id,symbol,side,order_type,time_in_force,quantity_atoms,notional_limit_micros,
        limit_price_micros,state,created_at,updated_at
      ) SELECT ${foreignIntentId},schema_version,authority_generation_hash,strategy_name,cycle_id,${foreignIntentId},policy_hash,
        account_id,'unrelated-client',symbol,side,order_type,time_in_force,quantity_atoms,notional_limit_micros,
        limit_price_micros,'PLANNED',created_at,created_at FROM intents WHERE intent_id = ${intentId}`
    const rows = [
      {
        id: parentId,
        client: conflict === 'parent client' ? 'unrelated-parent-client' : intent.client_order_id,
        intent: conflict === 'parent intent' ? foreignIntentId : intentId,
        parent: conflict === 'nested parent' ? 'another-parent' : null,
        symbol: conflict === 'parent symbol' ? 'MSFT' : 'AAPL',
        side: conflict === 'parent side' ? 'SELL' : 'BUY',
        type: 'LIMIT',
        duration: 'DAY',
        quantity:
          conflict === 'parent quantity' ? (BigInt(intent.quantity_atoms) - 1n).toString() : intent.quantity_atoms,
        limit:
          conflict === 'parent limit' ? (BigInt(intent.limit_price_micros) + 1n).toString() : intent.limit_price_micros,
        stop: null,
      },
      {
        id: childId,
        client: childClientId,
        intent: conflict === 'child intent' ? foreignIntentId : intentId,
        parent: parentId,
        symbol: conflict === 'child symbol' ? 'MSFT' : 'AAPL',
        side: conflict === 'child side' ? 'BUY' : 'SELL',
        type: 'STOP_LIMIT',
        duration: conflict === 'child duration' ? 'GTC' : 'DAY',
        quantity:
          conflict === 'child quantity' ? (BigInt(intent.quantity_atoms) + 1n).toString() : intent.quantity_atoms,
        limit:
          conflict === 'child limit'
            ? (BigInt(intent.protection.stopLimitPriceMicros) + 1n).toString()
            : intent.protection.stopLimitPriceMicros,
        stop:
          conflict === 'child stop'
            ? (BigInt(intent.protection.stopPriceMicros) + 1n).toString()
            : intent.protection.stopPriceMicros,
      },
    ]
    const [sequenceStart] = yield* sql<{ nextSequence: string }>`
      SELECT (COALESCE(MAX(source_sequence), -1) + 1)::text AS "nextSequence"
      FROM broker_events WHERE broker = 'ALPACA' AND account_id = ${replayAccountId}`
    if (sequenceStart === undefined) throw new Error('Expected an account source sequence')
    // The deferred payload constraint requires each broker event and its typed order to commit together.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const [sequence, row] of rows.entries()) {
          const eventId = sha256(row.id)
          yield* sql`INSERT INTO broker_events (
        event_id,schema_version,content_hash,event_kind,broker,account_id,source_event_id,source_sequence,occurred_at,observed_at
      ) VALUES (
        ${eventId},'bayn.paper-broker-event.v1',${eventId},'ORDER','ALPACA',${replayAccountId},
        ${`order:${row.id}:${observedAt}`},${(BigInt(sequenceStart.nextSequence) + BigInt(sequence)).toString()},
        ${observedAt}::timestamptz,${observedAt}::timestamptz
      )`
          yield* sql`INSERT INTO orders (
        event_id,account_id,schema_version,broker_order_id,client_order_id,intent_id,symbol,side,order_type,time_in_force,
        quantity_atoms,filled_quantity_atoms,limit_price_micros,stop_price_micros,parent_broker_order_id,status
      ) VALUES (
        ${eventId},${replayAccountId},'bayn.order.v3',${row.id},${row.client},${row.intent},${row.symbol},${row.side},
        ${row.type},${row.duration},${row.quantity},0,${row.limit},${row.stop},${row.parent},'PENDING'
      )`
        }
      }),
    )
    return { intentId, protection: intent.protection }
  })

const seedProtectionIdentity = (observedAt: string, conflict?: ProtectionIdentityConflict) =>
  Effect.flatMap(seedProtectionIntent, (binding) => retainProtectionIdentity(binding, observedAt, conflict))

describeNativeJevPostgres((postgres) => {
  test('a child discovered after the latest capture claim proves identity without advancing the financial boundary', async () =>
    postgres.runtime.runPromise(
      atObservation(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const binding = yield* seedProtectionIntent
          const store = makeBrokerObservationStore(sql, replayAccountId, revision, 60000, valkeyFixture().cache)
          yield* store.activate(0)
          const boundary: BrokerNotification = {
            _tag: 'SessionReady',
            schemaVersion: 'bayn.broker-notification.v1',
            eventId: '3'.repeat(64),
            receivedAt: '2026-11-01T00:00:00.000Z',
            session: {
              identityHash: '1'.repeat(64),
              accountId: replayAccountId,
              environment: BrokerEnvironment.Sandbox,
              credentialHash: '2'.repeat(64),
              sessionId: 'child-binding-session',
              sourceRevision: revision,
              verifiedAt: '2026-11-01T00:00:00.000Z',
              authenticatedAt: '2026-11-01T00:00:00.000Z',
              subscribedAt: '2026-11-01T00:00:00.000Z',
            },
          }
          yield* store.recordNotification(boundary)
          const claim = yield* store.begin('child-binding-capture', 0)
          if (claim.status !== BrokerObservationClaimStatus.Reserved) throw new Error('Expected a new capture')
          const ticket = claim.ticket
          const observedAt = utcInstantFromEpochMillis(Date.parse(ticket.startedAt) + 10)
          yield* TestClock.setTime(Date.parse(observedAt))
          expect(
            yield* store.publish(ticket, observedBrokerSnapshotFixture(replayAccountId, ticket.startedAt), 0),
          ).toBe(true)
          // Canonical ingestion follows publication. A later provider order observation proves immutable identity,
          // while the capture's notification cutoff still precedes it and financial completion remains separate.
          const { intentId, protection } = yield* retainProtectionIdentity(binding, observedAt)
          const [{ notificationFence }] = yield* sql`SELECT notification_fence_at::text AS "notificationFence"
        FROM broker_observations WHERE account_id = ${replayAccountId}`
          expect(Date.parse(String(notificationFence))).toBeLessThan(Date.parse(observedAt))
          expect(yield* store.readProtectionOrder(childId, childClientId)).toMatchObject({
            accountId: replayAccountId,
            brokerOrderId: childId,
            clientOrderId: childClientId,
            intentId,
            parentBrokerOrderId: parentId,
            side: 'SELL',
            stopPriceMicros: protection.stopPriceMicros,
            limitPriceMicros: protection.stopLimitPriceMicros,
            observedAt,
          })
          expect(yield* store.readProtectionOrder(childId, 'unrelated-client')).toBeUndefined()
          expect(yield* store.readProtectionOrder('unrelated-order', childClientId)).toBeUndefined()
          expect(yield* store.isSessionBoundaryCovered(boundary.session.sessionId)).toBe(false)
          expect(yield* store.readSourceProjection(boundary.eventId)).toBeUndefined()
        }),
      ),
    ))

  test('an exact canonical child identity cannot be reused by a foreign-account store', async () =>
    postgres.runtime.runPromise(
      atObservation(
        Effect.gen(function* () {
          yield* seedProtectionIdentity('2026-11-01T00:00:00.000Z')
          const sql = yield* PgClient.PgClient
          const cache = valkeyFixture().cache
          const own = makeBrokerObservationStore(sql, replayAccountId, revision, 60000, cache)
          const foreign = makeBrokerObservationStore(sql, 'foreign-account', revision, 60000, cache)
          expect(yield* own.readProtectionOrder(childId, childClientId)).toBeDefined()
          expect(yield* foreign.readProtectionOrder(childId, childClientId)).toBeUndefined()
        }),
      ),
    ))

  test.each<ProtectionIdentityConflict>([
    'parent intent',
    'parent client',
    'nested parent',
    'parent symbol',
    'parent side',
    'parent quantity',
    'parent limit',
    'child intent',
    'child side',
    'child stop',
    'child limit',
    'child quantity',
    'child symbol',
    'child duration',
  ])('a conflicting %s cannot supply a protective child binding', async (conflict) =>
    postgres.runtime.runPromise(
      atObservation(
        Effect.gen(function* () {
          yield* seedProtectionIdentity('2026-11-01T00:00:00.000Z', conflict)
          const sql = yield* PgClient.PgClient
          const store = makeBrokerObservationStore(sql, replayAccountId, revision, 60000, valkeyFixture().cache)
          expect(yield* store.readProtectionOrder(childId, childClientId)).toBeUndefined()
        }),
      ),
    ),
  )
})
