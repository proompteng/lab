import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL,
      as_of TIMESTAMPTZ NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      risk_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      provider TEXT NOT NULL DEFAULT 'codex-spark',
      run_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS torghut_market_context_snapshots_symbol_domain_uidx
    ON torghut_market_context_snapshots(symbol, domain);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_snapshots_as_of_idx
    ON torghut_market_context_snapshots(as_of DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_snapshots_updated_at_idx
    ON torghut_market_context_snapshots(updated_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_dispatch_state (
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL,
      last_dispatched_at TIMESTAMPTZ,
      last_run_name TEXT,
      last_status TEXT,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, domain)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_dispatch_state_updated_at_idx
    ON torghut_market_context_dispatch_state(updated_at DESC);
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`
    DROP TABLE IF EXISTS torghut_market_context_dispatch_state;
  `.execute(db)

  await sql`
    DROP TABLE IF EXISTS torghut_market_context_snapshots;
  `.execute(db)
}
