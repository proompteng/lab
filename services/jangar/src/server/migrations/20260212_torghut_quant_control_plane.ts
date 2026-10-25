import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

// Torghut quant performance control plane stores (Jangar-owned).
//
// Notes:
// - Source of truth remains Torghut (+ upstream market/TA telemetry when wired).
// - This schema is a read-optimized cache for near-real-time snapshot/series APIs.
// - Metrics are versioned via formula_version so dashboards can reason about drift.
export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS torghut_control_plane;`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.quant_metrics_latest (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id UUID NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      "window" TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      quality TEXT NOT NULL DEFAULT 'good',
      unit TEXT NOT NULL DEFAULT '',
      value_numeric NUMERIC,
      value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      formula_version TEXT NOT NULL,
      as_of TIMESTAMPTZ NOT NULL,
      freshness_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS torghut_qm_latest_uniq
    ON torghut_control_plane.quant_metrics_latest(strategy_id, account, "window", metric_name);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_qm_latest_strategy_window_idx
    ON torghut_control_plane.quant_metrics_latest(strategy_id, "window");
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.quant_metrics_series (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id UUID NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      "window" TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      quality TEXT NOT NULL DEFAULT 'good',
      unit TEXT NOT NULL DEFAULT '',
      value_numeric NUMERIC,
      value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      formula_version TEXT NOT NULL,
      as_of TIMESTAMPTZ NOT NULL,
      freshness_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_qm_series_lookup_idx
    ON torghut_control_plane.quant_metrics_series(strategy_id, account, "window", metric_name, as_of DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_qm_series_as_of_idx
    ON torghut_control_plane.quant_metrics_series(as_of DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.quant_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      alert_id TEXT NOT NULL,
      strategy_id UUID NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'warning',
      metric_name TEXT NOT NULL,
      "window" TEXT NOT NULL,
      threshold_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      state TEXT NOT NULL DEFAULT 'open',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS torghut_quant_alerts_uniq
    ON torghut_control_plane.quant_alerts(alert_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_quant_alerts_strategy_state_idx
    ON torghut_control_plane.quant_alerts(strategy_id, state, opened_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_control_plane.quant_pipeline_health (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id UUID NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL,
      ok BOOLEAN NOT NULL DEFAULT true,
      lag_seconds INTEGER NOT NULL DEFAULT 0,
      as_of TIMESTAMPTZ NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_quant_pipeline_health_latest_idx
    ON torghut_control_plane.quant_pipeline_health(strategy_id, account, stage, as_of DESC);
  `.execute(db)
}
