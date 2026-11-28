import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`SET LOCAL lock_timeout = '5s';`.execute(db)
  await sql`ALTER TABLE public.torghut_market_context_runs ALTER COLUMN provider DROP DEFAULT;`.execute(db)
  await sql`ALTER TABLE public.torghut_market_context_snapshots ALTER COLUMN provider DROP DEFAULT;`.execute(db)
}
