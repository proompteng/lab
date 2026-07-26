import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import type { BrokerEventInput, PositionSnapshotInput } from '../../broker/observations'
import { Broker } from '../../paper'
import type { EventReceipt, PaperStoreError, PositionSnapshotReceipt } from './contract'
import {
  decideBrokerEventAppend,
  decideNextSourceSequence,
  decidePositionSnapshotInsert,
  finishPositionSnapshot,
  planPositionSnapshot,
  validateStoredPositionSnapshot,
} from './decisions'
import { failPaperStore, liftPaperDecision, runPaperOperation } from './errors'
import {
  decodeBrokerEvent,
  decodeEventIdRows,
  decodeEventInput,
  decodeEventRows,
  decodeLastSequence,
  decodePositionSnapshotInput,
  decodePositionSnapshotRows,
  decodeSnapshotIdRows,
} from './rows'

export interface BrokerEventInterpreter {
  readonly append: (
    input: BrokerEventInput,
    positionSnapshotId?: string,
  ) => Effect.Effect<EventReceipt, PaperStoreError>
  readonly ingest: (input: BrokerEventInput) => Effect.Effect<EventReceipt, PaperStoreError>
  readonly ingestPositions: (input: PositionSnapshotInput) => Effect.Effect<PositionSnapshotReceipt, PaperStoreError>
}

export const makeBrokerEventInterpreter = (sql: PgClient.PgClient): BrokerEventInterpreter => {
  const insertPayload = (eventId: string, input: BrokerEventInput, positionSnapshotId?: string) => {
    switch (input._tag) {
      case 'Account':
        return sql`
          INSERT INTO account_snapshots (
            event_id, account_id, schema_version, status, currency,
            cash_micros, equity_micros, buying_power_micros
          ) VALUES (
            ${eventId}, ${input.account.accountId}, ${input.account.schemaVersion}, ${input.account.status},
            ${input.account.currency}, ${input.account.cashMicros}, ${input.account.equityMicros},
            ${input.account.buyingPowerMicros}
          )
        `.pipe(Effect.asVoid)
      case 'Position':
        if (positionSnapshotId === undefined) {
          return failPaperStore('ingest', 'invariant', 'position events require a complete position snapshot')
        }
        return sql`
          INSERT INTO positions (
            event_id, account_id, snapshot_id, schema_version, symbol, quantity_micros,
            average_entry_price_micros, market_price_micros, market_value_micros, unrealized_pnl_micros
          ) VALUES (
            ${eventId}, ${input.position.accountId}, ${positionSnapshotId}, ${input.position.schemaVersion},
            ${input.position.symbol}, ${input.position.quantityMicros}, ${input.position.averageEntryPriceMicros},
            ${input.position.marketPriceMicros}, ${input.position.marketValueMicros}, ${input.position.unrealizedPnlMicros}
          )
        `.pipe(Effect.asVoid)
      case 'Order':
        return sql`
          INSERT INTO orders (
            event_id, account_id, schema_version, broker_order_id, client_order_id, intent_id, symbol,
            side, order_type, time_in_force, quantity_micros, filled_quantity_micros, limit_price_micros, status
          ) VALUES (
            ${eventId}, ${input.order.accountId}, ${input.order.schemaVersion}, ${input.order.brokerOrderId},
            ${input.order.clientOrderId}, ${input.order.intentId ?? null}, ${input.order.symbol}, ${input.order.side},
            ${input.order.orderType}, ${input.order.timeInForce}, ${input.order.quantityMicros},
            ${input.order.filledQuantityMicros}, ${input.order.limitPriceMicros ?? null}, ${input.order.status}
          )
        `.pipe(Effect.asVoid)
      case 'Fill':
        return sql`
          INSERT INTO fills (
            event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id, intent_id,
            symbol, side, quantity_micros, price_micros, fee_micros, source_timestamp
          ) VALUES (
            ${eventId}, ${input.fill.accountId}, ${input.fill.schemaVersion}, ${input.fill.fillId},
            ${input.fill.brokerOrderId}, ${input.fill.clientOrderId}, ${input.fill.intentId ?? null},
            ${input.fill.symbol}, ${input.fill.side}, ${input.fill.quantityMicros}, ${input.fill.priceMicros},
            ${input.fill.feeMicros}, ${input.sourceTimestamp}
          )
        `.pipe(Effect.asVoid)
    }
  }

  const append = (input: BrokerEventInput, positionSnapshotId?: string): Effect.Effect<EventReceipt, PaperStoreError> =>
    runPaperOperation(
      'ingest',
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.broker}:${input.accountId}`}, 0))`
        const existing = yield* sql<Record<string, unknown>>`
          SELECT event_id, event_kind, content_hash, source_sequence::text AS source_sequence
          FROM broker_events
          WHERE broker = ${input.broker}
            AND account_id = ${input.accountId}
            AND source_event_id = ${input.sourceEventId}
        `.pipe(Effect.flatMap(decodeEventRows))
        const decision = yield* liftPaperDecision('ingest', decideBrokerEventAppend(input, existing))
        if (decision._tag === 'ReplayBrokerEvent') return decision.receipt

        const [last] = yield* sql<Record<string, unknown>>`
          SELECT COALESCE(max(source_sequence), -1)::text AS last_sequence
          FROM broker_events
          WHERE broker = ${input.broker} AND account_id = ${input.accountId}
        `.pipe(Effect.flatMap(decodeLastSequence))
        const sourceSequence = yield* liftPaperDecision('ingest', decideNextSourceSequence(last.last_sequence))
        yield* decodeBrokerEvent({
          ...input,
          schemaVersion: 'bayn.paper-broker-event.v1',
          eventId: decision.eventId,
          sourceSequence,
        })
        yield* sql`
          INSERT INTO broker_events (
            event_id, schema_version, content_hash, event_kind, broker, account_id,
            source_event_id, source_sequence, occurred_at, observed_at
          ) VALUES (
            ${decision.eventId}, 'bayn.paper-broker-event.v1', ${input.contentHash}, ${decision.eventKind},
            ${input.broker}, ${input.accountId}, ${input.sourceEventId}, ${sourceSequence},
            ${input.occurredAt}, ${input.observedAt}
          )
        `
        yield* insertPayload(decision.eventId, input, positionSnapshotId)
        return { eventId: decision.eventId, sourceSequence, deduplicated: false }
      }),
    )

  const ingest = (input: BrokerEventInput): Effect.Effect<EventReceipt, PaperStoreError> =>
    runPaperOperation(
      'ingest',
      decodeEventInput(input).pipe(
        Effect.flatMap((decoded) =>
          decoded._tag === 'Position'
            ? failPaperStore('ingest', 'invariant', 'position events require a complete position snapshot')
            : sql.withTransaction(append(decoded)),
        ),
      ),
    )

  const ingestPositions = (input: PositionSnapshotInput): Effect.Effect<PositionSnapshotReceipt, PaperStoreError> =>
    runPaperOperation(
      'positions',
      decodePositionSnapshotInput(input).pipe(
        Effect.flatMap((decoded) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const plan = yield* liftPaperDecision('positions', planPositionSnapshot(decoded))
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${Broker.Alpaca}:${decoded.accountId}`}, 0))`
              const inserted = yield* sql<Record<string, unknown>>`
                INSERT INTO position_snapshots (
                  snapshot_id, schema_version, account_id, source_hash, observed_at, position_count, content_hash
                ) VALUES (
                  ${plan.snapshotId}, 'bayn.paper-position-snapshot.v1', ${decoded.accountId}, ${decoded.sourceHash},
                  ${decoded.observedAt}, ${plan.eventIds.length}, ${plan.contentHash}
                )
                ON CONFLICT (account_id, source_hash, observed_at) DO NOTHING
                RETURNING snapshot_id
              `.pipe(Effect.flatMap(decodeSnapshotIdRows))
              const deduplicated = yield* liftPaperDecision(
                'positions',
                decidePositionSnapshotInsert(inserted.map((row) => row.snapshot_id)),
              )

              if (!deduplicated) {
                yield* Effect.forEach(decoded.positions, (position) => append(position, plan.snapshotId), {
                  discard: true,
                })
              }

              const snapshots = yield* sql<Record<string, unknown>>`
                SELECT
                  snapshot_id, schema_version, account_id, source_hash, observed_at,
                  position_count::integer AS position_count, content_hash
                FROM position_snapshots
                WHERE account_id = ${decoded.accountId}
                  AND source_hash = ${decoded.sourceHash}
                  AND observed_at = ${decoded.observedAt}
              `.pipe(Effect.flatMap(decodePositionSnapshotRows))
              yield* liftPaperDecision('positions', validateStoredPositionSnapshot(decoded, plan, snapshots))

              const storedEvents = yield* sql<Record<string, unknown>>`
                SELECT event_id FROM positions WHERE snapshot_id = ${plan.snapshotId} ORDER BY event_id
              `.pipe(Effect.flatMap(decodeEventIdRows))
              return yield* liftPaperDecision('positions', finishPositionSnapshot(plan, storedEvents, deduplicated))
            }),
          ),
        ),
      ),
    )

  return { append, ingest, ingestPositions }
}
