import type { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { decodeCycles, type TerminalCycleRow } from './model'
import { generationScope } from './scope'

export const readForwardPerformanceCycles = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash?: string,
) =>
  sql<Record<string, unknown>>`
    SELECT
      cycle_id,
      qualification_run_id,
      strategy_name,
      strategy_protocol_hash,
      account_id,
      execution_policy_hash,
      strategy_execution_model_hash,
      state,
      submission_open_at,
      terminal_at
    FROM autonomous_cycles AS cycle
    WHERE cycle.account_id = ${accountId}
      AND cycle.state IN ('COMPLETED', 'NO_TRADE')
      AND ${generationScope(sql, accountId, authorityGenerationHash, 'cycle')}
    ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
  `.pipe(Effect.flatMap(decodeCycles))

// Reread the captured identity in the same snapshot; a JavaScript Date would discard timestamp microseconds.
export const firstCapturedCycleQuery = (
  sql: PgClient.PgClient,
  cycles: readonly (typeof TerminalCycleRow.Type)[],
) => sql`
  SELECT cycle.submission_open_at
  FROM autonomous_cycles AS cycle
  WHERE cycle.cycle_id = ${cycles[0]?.cycle_id ?? null}
`
