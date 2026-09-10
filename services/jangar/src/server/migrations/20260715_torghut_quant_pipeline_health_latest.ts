import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

const TABLE = 'torghut_control_plane.quant_pipeline_health_latest'

export const up = async (db: Kysely<Database>) => {
  // Pipeline health is derived state. The legacy append-only table grew to tens
  // of GiB even though every reader asks only for the newest row per scope.
  // Start the replacement empty so this migration stays constant-time; the
  // running quant loop repopulates every active scope within one sampling cycle.
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.table(TABLE)} (
      strategy_id UUID NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      "window" TEXT NOT NULL,
      stage TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      lag_seconds INTEGER NOT NULL,
      as_of TIMESTAMPTZ NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (strategy_id, account, "window", stage)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_quant_pipeline_health_latest_freshness_idx
    ON ${sql.table(TABLE)} (account, "window", updated_at DESC);
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)};`.execute(db)
}
