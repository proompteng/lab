import type { Kysely } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (_db: Kysely<AgentsDatabase>) => {
  // Message storage moved to agents_comms.agent_messages in a later migration.
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
