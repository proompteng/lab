import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE INDEX IF NOT EXISTS torghut_qm_latest_account_window_idx
    ON torghut_control_plane.quant_metrics_latest(account, "window");
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    DROP INDEX IF EXISTS torghut_control_plane.torghut_qm_latest_account_window_idx;
  `.execute(db)
}
