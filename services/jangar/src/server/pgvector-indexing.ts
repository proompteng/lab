import { type Kysely, sql } from 'kysely'

import type { Database } from './db'

export const MAX_PGVECTOR_ANN_DIMENSION = 2000

export const supportsPgvectorAnnIndex = (dimension: number) =>
  Number.isFinite(dimension) && dimension > 0 && dimension <= MAX_PGVECTOR_ANN_DIMENSION

export const createPgvectorAnnIndexIfSupported = async (
  db: Kysely<Database>,
  dimension: number,
  ddl: string,
  context: string,
) => {
  if (!supportsPgvectorAnnIndex(dimension)) {
    console.log('[jangar:pgvector]', {
      event: 'skip_ann_index',
      context,
      dimension,
      maxSupportedDimension: MAX_PGVECTOR_ANN_DIMENSION,
    })
    return false
  }

  await sql.raw(ddl).execute(db)
  return true
}
