import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS torghut_control_plane;`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.simulation_runs (
      run_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      workflow_name TEXT,
      workflow_uid TEXT,
      namespace TEXT NOT NULL DEFAULT 'torghut',
      status TEXT NOT NULL DEFAULT 'submitted',
      workflow_phase TEXT,
      lane TEXT NOT NULL DEFAULT 'equity',
      profile TEXT NOT NULL DEFAULT 'smoke',
      cache_policy TEXT NOT NULL DEFAULT 'prefer_cache',
      priority TEXT NOT NULL DEFAULT 'interactive',
      candidate_ref TEXT,
      strategy_ref TEXT,
      dataset_id TEXT,
      artifact_root TEXT,
      output_root TEXT,
      manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
      manifest_digest TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      submitted_by TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_simulation_runs_status_idx
    ON torghut_control_plane.simulation_runs(status, updated_at DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_simulation_runs_dataset_idx
    ON torghut_control_plane.simulation_runs(dataset_id, created_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.simulation_run_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id TEXT NOT NULL REFERENCES torghut_control_plane.simulation_runs(run_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id, seq)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_simulation_run_events_run_idx
    ON torghut_control_plane.simulation_run_events(run_id, created_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.simulation_artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id TEXT NOT NULL REFERENCES torghut_control_plane.simulation_runs(run_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'expected',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (run_id, name)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_simulation_artifacts_run_idx
    ON torghut_control_plane.simulation_artifacts(run_id, updated_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.dataset_cache (
      cache_key TEXT PRIMARY KEY,
      lane TEXT NOT NULL,
      window_start TIMESTAMPTZ,
      window_end TIMESTAMPTZ,
      source_digest TEXT,
      schema_digest TEXT,
      code_digest TEXT,
      dump_format TEXT NOT NULL,
      artifact_path TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      hit_count BIGINT NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_dataset_cache_lane_updated_idx
    ON torghut_control_plane.dataset_cache(lane, updated_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.simulation_campaigns (
      campaign_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.simulation_campaigns;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.dataset_cache;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.simulation_artifacts;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.simulation_run_events;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_control_plane.simulation_runs;
  `.execute(db)
}
