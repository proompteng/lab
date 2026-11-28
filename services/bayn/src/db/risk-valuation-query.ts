import type { PgClient } from '@effect/sql-pg'

export const firstSessionEquityQuery = (sql: PgClient.PgClient, accountId: string, observedAt: string) => sql`
  SELECT valuation.equity_micros::text AS equity_micros
  FROM valuations AS valuation
  WHERE valuation.account_id = ${accountId}
    AND valuation.as_of <= ${observedAt}::timestamptz
    AND (valuation.as_of AT TIME ZONE 'America/New_York')::date =
      (${observedAt}::timestamptz AT TIME ZONE 'America/New_York')::date
  ORDER BY valuation.as_of, valuation.valuation_id COLLATE "C"
  LIMIT 1
`

export const peakEquityQuery = (sql: PgClient.PgClient, accountId: string, observedAt: string) => sql`
  SELECT max(valuation.equity_micros)::text AS equity_micros
  FROM valuations AS valuation
  WHERE valuation.account_id = ${accountId}
    AND valuation.as_of <= ${observedAt}::timestamptz
`
