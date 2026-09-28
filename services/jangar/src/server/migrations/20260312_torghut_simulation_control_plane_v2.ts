import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    ALTER TABLE torghut_control_plane.simulation_runs
    ADD COLUMN IF NOT EXISTS lane_id TEXT,
    ADD COLUMN IF NOT EXISTS cache_key TEXT,
    ADD COLUMN IF NOT EXISTS cache_status TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS run_class TEXT NOT NULL DEFAULT 'interactive',
    ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS final_verdict JSONB NOT NULL DEFAULT '{}'::jsonb;
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_simulation_runs_lane_status_idx
    ON torghut_control_plane.simulation_runs(lane_id, status, updated_at DESC);
  `.execute(db)

  await sql`
    ALTER TABLE torghut_control_plane.dataset_cache
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS chunk_manifest_path TEXT,
    ADD COLUMN IF NOT EXISTS records_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bytes_total BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS built_by_run_id TEXT,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.simulation_campaign_runs (
      campaign_id TEXT NOT NULL REFERENCES torghut_control_plane.simulation_campaigns(campaign_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES torghut_control_plane.simulation_runs(run_id) ON DELETE CASCADE,
      candidate_ref TEXT,
      window_label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, run_id)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_simulation_campaign_runs_run_idx
    ON torghut_control_plane.simulation_campaign_runs(run_id, created_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.simulation_lane_leases (
      lane_id TEXT PRIMARY KEY,
      lane_class TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      run_id TEXT REFERENCES torghut_control_plane.simulation_runs(run_id) ON DELETE SET NULL,
      cache_key TEXT,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    INSERT INTO torghut_control_plane.simulation_lane_leases (lane_id, lane_class, status, metadata)
    VALUES
      ('sim-fast-1', 'interactive', 'available', '{}'::jsonb),
      ('sim-fast-2', 'interactive', 'available', '{}'::jsonb),
      ('sim-fast-3', 'interactive', 'available', '{}'::jsonb),
      ('sim-batch-1', 'batch', 'available', '{}'::jsonb)
    ON CONFLICT (lane_id) DO NOTHING;
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.simulation_lane_leases;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.simulation_campaign_runs;
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS torghut_simulation_runs_lane_status_idx;
  `.execute(db)

  await sql`
    ALTER TABLE torghut_control_plane.dataset_cache
    DROP COLUMN IF EXISTS last_verified_at,
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS built_by_run_id,
    DROP COLUMN IF EXISTS bytes_total,
    DROP COLUMN IF EXISTS records_total,
    DROP COLUMN IF EXISTS chunk_manifest_path,
    DROP COLUMN IF EXISTS status;
  `.execute(db)

  await sql`
    ALTER TABLE torghut_control_plane.simulation_runs
    DROP COLUMN IF EXISTS final_verdict,
    DROP COLUMN IF EXISTS progress,
    DROP COLUMN IF EXISTS run_class,
    DROP COLUMN IF EXISTS cache_status,
    DROP COLUMN IF EXISTS cache_key,
    DROP COLUMN IF EXISTS lane_id;
  `.execute(db)
}
