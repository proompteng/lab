import { PgMigrator } from '@effect/sql-pg'

import evaluationEvidence from '../../migrations/0001_evaluation_evidence'
import qualificationLock from '../../migrations/0002_qualification_lock'
import evidenceImmutability from '../../migrations/0003_evidence_immutability'
import executionEvents from '../../migrations/0004_execution_events'
import lockedQualification from '../../migrations/0005_locked_qualification'

export const migrationLoader = PgMigrator.fromRecord({
  '1_evaluation_evidence': evaluationEvidence,
  '2_qualification_lock': qualificationLock,
  '3_evidence_immutability': evidenceImmutability,
  '4_execution_events': executionEvents,
  '5_locked_qualification': lockedQualification,
})
