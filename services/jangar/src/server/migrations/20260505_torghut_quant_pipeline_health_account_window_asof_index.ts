import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE INDEX IF NOT EXISTS torghut_quant_pipeline_health_account_window_asof_idx
    ON torghut_control_plane.quant_pipeline_health
    (account, ((details->>'window')), as_of DESC);
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    DROP INDEX IF EXISTS torghut_control_plane.torghut_quant_pipeline_health_account_window_asof_idx;
  `.execute(db)
}
