import { PgMigrator } from '@effect/sql-pg'

import evaluationEvidence from '../../migrations/0001_evaluation_evidence'

export const migrationLoader = PgMigrator.fromRecord({
  '1_evaluation_evidence': evaluationEvidence,
})
