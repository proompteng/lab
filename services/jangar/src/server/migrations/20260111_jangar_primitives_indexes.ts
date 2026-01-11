import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`CREATE INDEX IF NOT EXISTS agent_runs_external_run_id_idx ON agent_runs(external_run_id);`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS orchestration_runs_external_run_id_idx
    ON orchestration_runs(external_run_id);
  `.execute(db)
}
