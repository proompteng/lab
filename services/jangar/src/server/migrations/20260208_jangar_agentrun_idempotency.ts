import type { Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // AgentRun idempotency moved to services/agents.
}
