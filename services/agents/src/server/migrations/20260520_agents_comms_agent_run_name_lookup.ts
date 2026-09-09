import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

const SCHEMA = 'agents_comms'
const TABLE = 'agent_messages'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`
    CREATE INDEX IF NOT EXISTS agents_agent_messages_agent_run_name_time_idx
    ON ${sql.ref(`${SCHEMA}.${TABLE}`)} (agent_run_namespace, agent_run_name, timestamp);
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
