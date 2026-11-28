import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'

export enum FeePostingKind {
  Accrual = 'ACCRUAL',
  Activity = 'ACTIVITY',
}

export const readAcknowledgedFeePostings = (sql: PgClient.PgClient, accountId: string, kind: FeePostingKind) =>
  sql`SELECT source_id FROM broker_fee_posting_acknowledgements
    WHERE account_id=${accountId} AND source_kind=${kind}`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ source_id: StrictNonEmptyStringSchema })),
        strictParseOptions,
      ),
    ),
    Effect.map((rows) => new Set(rows.map((row) => row.source_id))),
  )

export const acknowledgeFeePosting = (
  sql: PgClient.PgClient,
  accountId: string,
  kind: FeePostingKind,
  sourceId: string,
  planHash: string,
) => sql`INSERT INTO broker_fee_posting_acknowledgements(account_id,source_kind,source_id,ledger_plan_hash)
  VALUES(${accountId},${kind},${sourceId},${planHash})`
