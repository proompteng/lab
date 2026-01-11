import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_name TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      external_run_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_delivery_id_idx ON agent_runs(delivery_id);`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS memory_resources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      connection_secret JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_resources_name_idx ON memory_resources(memory_name);`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS orchestration_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      orchestration_name TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      external_run_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS orchestration_runs_delivery_id_idx
    ON orchestration_runs(delivery_id);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type TEXT NOT NULL,
      entity_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)
}
