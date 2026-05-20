import { type Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // Legacy codex_judge column normalization is now handled by the Agents-owned
  // projection backfill when a retired codex_judge schema is present.
}

export const down = async (_db: Kysely<Database>) => {}
