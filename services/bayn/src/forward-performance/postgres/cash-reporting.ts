import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { cashAccrualReportingOffsetMicros, type StoredAccrual } from '../../db/fee-accruals'
import { UnsignedMicrosSchema } from '../../execution/contracts'
import { Sha256Schema, strictParseOptions } from '../../schemas'
import { decodeCount, postgresError } from './model'

export const readUnaccountedCashSettlementCount = (
  sql: PgClient.PgClient,
  accountId: string,
  reconciledAt: Date | undefined,
) =>
  sql`
    SELECT count(*)::integer AS count FROM accounting_transactions t
    WHERE t.account_id=${accountId} AND t.occurred_at<=${reconciledAt ?? null}::timestamptz
      AND mod(t.cash_delta_micros,(
        SELECT reporting.quantum_micros FROM account_cash_reporting reporting
        JOIN account_snapshots a ON a.event_id=reporting.account_event_id
        JOIN broker_events e ON e.event_id=a.event_id
        WHERE e.account_id=${accountId} AND e.event_kind='ACCOUNT'
          AND a.account_id=${accountId} AND e.observed_at<=${reconciledAt ?? null}::timestamptz
        ORDER BY e.observed_at DESC,e.source_sequence DESC LIMIT 1))<>0
      AND NOT EXISTS(SELECT 1 FROM broker_cash_settlements s WHERE s.transaction_id=t.transaction_id
        AND s.posted_at<=${reconciledAt ?? null}::timestamptz)
  `.pipe(
    Effect.flatMap(decodeCount),
    Effect.map(([row]) => row.count),
  )

export const readCashReportingOffsets = (
  sql: PgClient.PgClient,
  accountId: string,
  records: readonly (typeof StoredAccrual.Type)[],
  cuts: { readonly baseline: Date; readonly opening: Date; readonly closing: Date },
) =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
      WITH cuts(name,as_of) AS (VALUES
        ('baseline',${cuts.baseline}::timestamptz),
        ('opening',${cuts.opening}::timestamptz),
        ('closing',${cuts.closing}::timestamptz))
      SELECT cuts.name,a.accrual_id,
        NOT EXISTS(SELECT 1 FROM broker_fee_accruals pending
          LEFT JOIN broker_fee_posting_acknowledgements ack ON ack.account_id=pending.account_id
            AND ack.source_kind='ACCRUAL' AND ack.source_id=pending.accrual_id
          WHERE pending.account_id=${accountId} AND pending.kind='CASH' AND pending.observed_at<=cuts.as_of
            AND (ack.acknowledged_at IS NULL OR ack.acknowledged_at>cuts.as_of))
        AND NOT EXISTS(SELECT 1 FROM broker_fee_accounting pending
          LEFT JOIN broker_fee_posting_acknowledgements ack ON ack.account_id=pending.account_id
            AND ack.source_kind='ACTIVITY' AND ack.source_id=pending.activity_id
          WHERE pending.account_id=${accountId} AND pending.first_observed_at<=cuts.as_of
            AND (ack.acknowledged_at IS NULL OR ack.acknowledged_at>cuts.as_of)) AS posting_time_known,
        (COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m
          JOIN broker_fee_accounting f USING(account_id,activity_id)
          JOIN broker_fee_posting_acknowledgements ack ON ack.account_id=f.account_id
            AND ack.source_kind='ACTIVITY' AND ack.source_id=f.activity_id
          WHERE m.accrual_id=a.accrual_id AND ack.acknowledged_at<=cuts.as_of AND f.first_observed_at<=cuts.as_of),0)
        -COALESCE((SELECT sum(c.cash_debit_micros) FROM broker_fee_match_corrections c
          JOIN broker_fee_posting_acknowledgements ack ON ack.account_id=c.account_id
            AND ack.source_kind='ACTIVITY' AND ack.source_id=c.activity_id AND ack.acknowledged_at<=cuts.as_of
          WHERE c.accrual_id=a.accrual_id AND c.posted_at<=cuts.as_of
            AND (c.data->'readEvidence'->>'observedAt')::timestamptz<=cuts.as_of),0))::text AS matched_cash_micros
      FROM cuts LEFT JOIN broker_fee_accruals a ON a.account_id=${accountId} AND a.kind='CASH'
        AND a.observed_at<=cuts.as_of AND EXISTS(SELECT 1 FROM broker_fee_posting_acknowledgements ack
          WHERE ack.account_id=a.account_id AND ack.source_kind='ACCRUAL' AND ack.source_id=a.accrual_id
            AND ack.acknowledged_at<=cuts.as_of)
      ORDER BY cuts.name,a.accrual_id COLLATE "C"
    `.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              name: Schema.Literals(['baseline', 'opening', 'closing']),
              accrual_id: Schema.NullOr(Sha256Schema),
              posting_time_known: Schema.Boolean,
              matched_cash_micros: UnsignedMicrosSchema,
            }),
          ),
          strictParseOptions,
        ),
      ),
    )
    const byId = new Map(records.map((record) => [record.accrual_id, record]))
    const evidence: Record<keyof typeof cuts, (typeof StoredAccrual.Type)[]> = {
      baseline: [],
      opening: [],
      closing: [],
    }
    const known = { baseline: true, opening: true, closing: true }
    for (const row of rows) {
      known[row.name] &&= row.posting_time_known
      if (row.accrual_id === null) continue
      const record = byId.get(row.accrual_id)
      if (record === undefined || record.data.kind !== 'CASH' || !record.posted)
        return yield* postgresError(new Error('Cash reporting cut lacks its retained posted accrual'))
      evidence[row.name].push({ ...record, matched_cash_micros: row.matched_cash_micros })
    }
    return {
      baseline: known.baseline ? cashAccrualReportingOffsetMicros(evidence.baseline) : undefined,
      opening: known.opening ? cashAccrualReportingOffsetMicros(evidence.opening) : undefined,
      closing: known.closing ? cashAccrualReportingOffsetMicros(evidence.closing) : undefined,
    }
  }).pipe(Effect.mapError(postgresError))
