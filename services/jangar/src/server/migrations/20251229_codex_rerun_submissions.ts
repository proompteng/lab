import { type Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // AgentRun rerun submissions moved to services/agents.
}
