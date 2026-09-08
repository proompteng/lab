import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_runs (
      request_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL,
      run_name TEXT,
      provider TEXT NOT NULL DEFAULT 'codex-spark',
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_heartbeat_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_runs_symbol_domain_status_idx
    ON torghut_market_context_runs(symbol, domain, status);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_runs_updated_at_idx
    ON torghut_market_context_runs(updated_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_run_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id TEXT NOT NULL REFERENCES torghut_market_context_runs(request_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (request_id, seq)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_run_events_request_created_idx
    ON torghut_market_context_run_events(request_id, created_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id TEXT NOT NULL REFERENCES torghut_market_context_runs(request_id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL,
      seq INTEGER NOT NULL,
      source TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      url TEXT,
      headline TEXT,
      summary TEXT,
      sentiment TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      digest TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (request_id, digest)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_evidence_request_created_idx
    ON torghut_market_context_evidence(request_id, created_at DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_evidence_symbol_domain_idx
    ON torghut_market_context_evidence(symbol, domain, created_at DESC);
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    DROP TABLE IF EXISTS torghut_market_context_evidence;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_market_context_run_events;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_market_context_runs;
  `.execute(db)
}
