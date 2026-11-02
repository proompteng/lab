import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { prepareCashSettlement, StoredCashSettlementSchema, verifyCashSettlement } from '../accounting/cash-settlement'
import { SignedMicrosSchema } from '../execution/contracts'
import { hashLedgerPlanResult } from '../ledger-plan'
import type { JournalService } from '../ledger'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import type { BrokerSnapshot } from './reconciliation'
import { ReconciliationStoreError } from './reconciliation'

type Identity = { readonly clusterId: bigint; readonly ledger: number }

const invariant = (cause: unknown) =>
  new ReconciliationStoreError({
    operation: 'reconcile',
    failure: 'invariant',
    message: 'Broker cash settlement evidence is invalid',
    cause,
  })
const queryFailure = (cause: unknown) =>
  cause instanceof ReconciliationStoreError
    ? cause
    : new ReconciliationStoreError({
        operation: 'reconcile',
        failure: 'query',
        message: 'Broker cash settlement persistence failed',
        cause,
      })
const fromResult = <A, E>(result: Result.Result<A, E>) => Effect.fromResult(result).pipe(Effect.mapError(invariant))

const decodeStored = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Array(StoredCashSettlementSchema),
    strictParseOptions,
  )(value).pipe(Effect.mapError(invariant))

export const readCashSettlements = (sql: PgClient.PgClient, accountId: string) =>
  sql`
    SELECT settlement_id,data,rounding_delta_micros::text AS rounding_delta_micros,
      content_hash,ledger_plan_hash,tigerbeetle_cluster_id::text AS tigerbeetle_cluster_id,
      tigerbeetle_ledger::integer AS tigerbeetle_ledger,posted_at IS NOT NULL AS posted
    FROM broker_cash_settlements WHERE account_id=${accountId} ORDER BY transaction_id COLLATE "C"
  `.pipe(Effect.flatMap(decodeStored), Effect.mapError(queryFailure))

export const prepareCashSettlements = (sql: PgClient.PgClient, snapshot: BrokerSnapshot, identity: Identity) =>
  Effect.gen(function* () {
    const transactions = yield* sql`
      SELECT t.transaction_id,t.content_hash,t.broker_event_id,t.cash_delta_micros::text AS cash_delta_micros,
        to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
      FROM accounting_transactions t
      WHERE t.account_id=${snapshot.account.accountId}
        AND mod(t.cash_delta_micros,${snapshot.cashReportingQuantumMicros}::numeric)<>0
        AND NOT EXISTS(SELECT 1 FROM broker_cash_settlements s WHERE s.transaction_id=t.transaction_id)
      ORDER BY t.transaction_id COLLATE "C"
    `.pipe(
      Effect.flatMap((rows) =>
        fromResult(
          Schema.decodeUnknownResult(
            Schema.Array(
              Schema.Struct({
                transaction_id: Sha256Schema,
                content_hash: Sha256Schema,
                broker_event_id: Sha256Schema,
                cash_delta_micros: SignedMicrosSchema,
                occurred_at: UtcInstantSchema,
              }),
            ),
            strictParseOptions,
          )(rows),
        ),
      ),
    )
    for (const transaction of transactions) {
      const prepared = yield* fromResult(
        prepareCashSettlement(
          {
            schemaVersion: 'bayn.broker-cash-settlement.v1',
            accountId: snapshot.account.accountId,
            transactionId: transaction.transaction_id,
            transactionContentHash: transaction.content_hash,
            brokerEventId: transaction.broker_event_id,
            cashDeltaMicros: transaction.cash_delta_micros,
            occurredAt: transaction.occurred_at,
            cashReportingQuantumMicros: snapshot.cashReportingQuantumMicros,
            precisionAccountEventId: snapshot.accountEventId,
            observedAt: snapshot.account.observedAt,
          },
          identity.ledger,
        ),
      )
      const planHash = yield* fromResult(hashLedgerPlanResult(prepared.plan))
      yield* sql`INSERT INTO broker_cash_settlements(settlement_id,transaction_id,account_id,precision_account_event_id,
        rounding_delta_micros,data,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger)
        VALUES(${prepared.settlementId},${transaction.transaction_id},${snapshot.account.accountId},${snapshot.accountEventId},
          ${prepared.roundingDeltaMicros},${sql.json(prepared.data)},${prepared.contentHash},${planHash},
          ${identity.clusterId.toString()},${identity.ledger})`
    }
  }).pipe(Effect.mapError(queryFailure))

export const postCashSettlements = (
  sql: PgClient.PgClient,
  journal: JournalService,
  accountId: string,
  identity: Identity,
) =>
  Effect.gen(function* () {
    const records = yield* readCashSettlements(sql, accountId)
    const verified = yield* Effect.forEach(records, (record) =>
      fromResult(verifyCashSettlement(record, accountId, identity)),
    )
    const posted: string[] = []
    for (const settlement of verified) {
      if (settlement.posted) continue
      yield* journal.post(settlement.plan).pipe(
        Effect.mapError(
          (cause) =>
            new ReconciliationStoreError({
              operation: 'reconcile',
              failure: 'ledger',
              message: 'Broker cash settlement ledger posting failed',
              cause,
            }),
        ),
      )
      posted.push(settlement.settlementId)
    }
    if (posted.length > 0)
      yield* sql`UPDATE broker_cash_settlements SET posted_at=clock_timestamp()
      WHERE account_id=${accountId} AND settlement_id IN ${sql.in(posted)} AND posted_at IS NULL`
    return {
      plans: verified.map((settlement) => settlement.plan),
      settlements: verified.map((settlement) => settlement.data),
      cashDeltaMicros: verified
        .reduce((sum, settlement) => sum + BigInt(settlement.roundingDeltaMicros), 0n)
        .toString(),
    }
  }).pipe(Effect.mapError(queryFailure))

export type CashSettlementAccounting = Effect.Success<ReturnType<typeof postCashSettlements>>
