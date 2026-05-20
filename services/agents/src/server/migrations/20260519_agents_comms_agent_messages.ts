import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

const SCHEMA = 'agents_comms'
const TABLE = 'agent_messages'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.raw(SCHEMA)};`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref(`${SCHEMA}.${TABLE}`)} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_run_uid TEXT,
      agent_run_name TEXT,
      agent_run_namespace TEXT,
      run_id TEXT,
      step_id TEXT,
      agent_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      channel TEXT,
      stage TEXT,
      content TEXT NOT NULL,
      attrs JSONB NOT NULL DEFAULT '{}'::JSONB,
      dedupe_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_agent_messages_run_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (run_id, timestamp);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_agent_messages_agent_run_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (agent_run_uid, timestamp);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_agent_messages_agent_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (agent_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_agent_messages_channel_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (channel, timestamp);
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_messages_dedupe_key_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (dedupe_key);
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
