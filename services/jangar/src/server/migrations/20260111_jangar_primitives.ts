import type { Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // Agents primitives moved to services/agents. Keep this migration name registered
  // so existing Jangar databases do not try to replay historical migration state.
}
