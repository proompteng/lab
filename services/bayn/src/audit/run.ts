import { Result } from 'effect'

import { type QualificationAuditFailure, type QualificationAuditInput, type QualificationAuditReport } from './audit'
import { makeAuditFacts } from './core'
import { auditSignalAndRepository, auditStoredEvidence } from './evidence-checks'
import { auditQualificationBindings, makeAuditReport } from './qualification-checks'
import { auditArtifactManifest, auditReferenceArtifacts } from './reference-checks'

export const auditQualification = (
  input: QualificationAuditInput,
): Result.Result<QualificationAuditReport, QualificationAuditFailure> =>
  Result.gen(function* () {
    const facts = yield* makeAuditFacts(input)
    const artifactManifestChecks = yield* auditArtifactManifest(facts)
    const storedEvidenceChecks = yield* auditStoredEvidence(facts)
    const referenceArtifactChecks = yield* auditReferenceArtifacts(facts)
    const qualificationBindingChecks = yield* auditQualificationBindings(facts)
    const checks = [
      ...storedEvidenceChecks,
      ...referenceArtifactChecks,
      ...artifactManifestChecks,
      ...qualificationBindingChecks,
      ...auditSignalAndRepository(facts),
    ]
    return yield* makeAuditReport(facts, checks)
  })
