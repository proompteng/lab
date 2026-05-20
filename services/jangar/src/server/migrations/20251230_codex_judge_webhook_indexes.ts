import { type Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // Codex run projections moved to services/agents. Keep this historical
  // migration name registered without mutating Jangar-owned schemas.
}

export const down = async (_db: Kysely<Database>) => {}
