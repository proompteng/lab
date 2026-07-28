import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { runDatabase } from './errors'
import { makeEvidenceStatements } from './evidence-statements'
import type { EvidenceStoreService } from './model'
import { makeEvidencePersistenceProgram } from './persist-program'
import { makeQualificationPrograms } from './qualification-program'
import { makeQualificationStatements } from './qualification-statements'
import { makeEvidenceReadPrograms } from './read-program'
import { makeEvidenceReferencePrograms } from './reference-programs'

export const makeEvidenceStore = (sql: PgClient.PgClient): EvidenceStoreService => {
  const evidenceStatements = makeEvidenceStatements(sql)
  const qualificationStatements = makeQualificationStatements(sql)
  const references = makeEvidenceReferencePrograms(sql, evidenceStatements)
  const reads = makeEvidenceReadPrograms(evidenceStatements, references)
  const qualifications = makeQualificationPrograms(sql, qualificationStatements, references)

  return {
    check: runDatabase('health', evidenceStatements.health(undefined).pipe(Effect.asVoid)),
    persist: makeEvidencePersistenceProgram(sql, evidenceStatements, qualificationStatements, references),
    ...reads,
    ...qualifications,
  } satisfies EvidenceStoreService
}
