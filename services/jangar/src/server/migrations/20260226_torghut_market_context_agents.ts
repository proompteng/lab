import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL CHECK (domain IN ('fundamentals', 'news')),
      as_of TIMESTAMPTZ NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      quality_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      risk_flags TEXT[] NOT NULL DEFAULT '{}'::text[],
      provider TEXT NOT NULL DEFAULT '',
      run_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS torghut_market_context_snapshots_symbol_domain_idx
    ON torghut_market_context_snapshots(symbol, domain);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_snapshots_domain_as_of_idx
    ON torghut_market_context_snapshots(domain, as_of DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_snapshots_symbol_as_of_idx
    ON torghut_market_context_snapshots(symbol, as_of DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_market_context_dispatch_state (
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL CHECK (domain IN ('fundamentals', 'news')),
      last_dispatched_at TIMESTAMPTZ,
      last_run_name TEXT,
      last_status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(symbol, domain)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_market_context_dispatch_state_dispatched_idx
    ON torghut_market_context_dispatch_state(last_dispatched_at DESC);
  `.execute(db)
}
