import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`SET LOCAL lock_timeout = '5s';`.execute(db)

  // The compatibility view owns the insert trigger, so removing the view first
  // releases both physical stores without cascading into unrelated relations.
  await sql`DROP VIEW IF EXISTS torghut_control_plane.quant_metrics_series;`.execute(db)
  await sql`DROP FUNCTION IF EXISTS torghut_control_plane.insert_quant_metrics_series_active();`.execute(db)
  await sql`DROP TABLE IF EXISTS torghut_control_plane.quant_metrics_series_active;`.execute(db)
  await sql`DROP TABLE IF EXISTS torghut_control_plane.quant_metrics_series_legacy;`.execute(db)
}

// This migration intentionally has no down migration. Dropped history cannot
// be reconstructed, and pretending otherwise would make rollback unsafe.
