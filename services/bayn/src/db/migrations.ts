import { PgMigrator } from '@effect/sql-pg'

import initialSchema from '../../migrations/0001_initial_schema'
import paperContracts from '../../migrations/0002_paper_contracts'

export const migrationLoader = PgMigrator.fromRecord({
  '1_initial_schema': initialSchema,
  '2_paper_contracts': paperContracts,
})
