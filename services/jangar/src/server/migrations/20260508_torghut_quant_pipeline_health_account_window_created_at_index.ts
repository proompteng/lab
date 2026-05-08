import { type Kysely } from 'kysely'

import type { Database } from '../db'

export const up = async (_db: Kysely<Database>) => {
  // Keep the migration name registered without running heavyweight DDL from the serving control plane.
}

export const down = async (_db: Kysely<Database>) => {
  // The hotfix migration does not own an index to drop.
}
