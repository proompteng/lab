import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

const SCHEMA = 'workflow_comms'
const TABLE = 'agent_messages'

export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.raw(SCHEMA)};`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref(`${SCHEMA}.${TABLE}`)} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_uid TEXT,
      workflow_name TEXT,
      workflow_namespace TEXT,
      run_id UUID,
      step_id TEXT,
      agent_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      channel TEXT,
      stage TEXT,
      content TEXT NOT NULL,
      attrs JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS workflow_agent_messages_run_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (run_id, timestamp);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS workflow_agent_messages_workflow_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (workflow_uid, timestamp);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS workflow_agent_messages_agent_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (agent_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS workflow_agent_messages_channel_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (channel, timestamp);
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
