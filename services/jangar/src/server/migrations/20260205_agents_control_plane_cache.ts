import type { Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // Agents control-plane cache moved to services/agents.
}
