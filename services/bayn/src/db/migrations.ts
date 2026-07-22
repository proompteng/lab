import { PgMigrator } from '@effect/sql-pg'

import initialSchema from '../../migrations/0001_initial_schema'

export const migrationLoader = PgMigrator.fromRecord({
  '1_initial_schema': initialSchema,
})
