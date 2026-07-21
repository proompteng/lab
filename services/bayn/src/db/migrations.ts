import { PgMigrator } from '@effect/sql-pg'

import evaluationEvidence from '../../migrations/0001_evaluation_evidence'
import qualificationLock from '../../migrations/0002_qualification_lock'
import evidenceImmutability from '../../migrations/0003_evidence_immutability'

export const migrationLoader = PgMigrator.fromRecord({
  '1_evaluation_evidence': evaluationEvidence,
  '2_qualification_lock': qualificationLock,
  '3_evidence_immutability': evidenceImmutability,
})
