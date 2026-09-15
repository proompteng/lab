import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`SET LOCAL lock_timeout = '5s';`.execute(db)
  await sql`SET LOCAL statement_timeout = '60s';`.execute(db)

  // These tables are rebuildable Jangar projections, not authoritative trading data.
  // Keep one database-backed read path while removing WAL replay from the asynchronous
  // replica. After a crash or failover the quant loop repopulates them; readers report
  // empty/stale state until that completes instead of falling back to legacy history.
  await sql`
    DROP INDEX torghut_control_plane.torghut_quant_pipeline_health_latest_freshness_idx;
  `.execute(db)

  await sql`
    ALTER TABLE torghut_control_plane.quant_metrics_latest
    SET (fillfactor = 70);
  `.execute(db)
  await sql`
    ALTER TABLE torghut_control_plane.quant_metrics_latest
    SET UNLOGGED;
  `.execute(db)

  await sql`
    ALTER TABLE torghut_control_plane.quant_pipeline_health_latest
    SET (fillfactor = 70);
  `.execute(db)
  await sql`
    ALTER TABLE torghut_control_plane.quant_pipeline_health_latest
    SET UNLOGGED;
  `.execute(db)

  await sql`ANALYZE torghut_control_plane.quant_metrics_latest;`.execute(db)
  await sql`ANALYZE torghut_control_plane.quant_pipeline_health_latest;`.execute(db)
}

// Intentionally roll-forward only. Re-logging rebuildable cache rows would restore
// the WAL and replica-write amplification this migration removes.
