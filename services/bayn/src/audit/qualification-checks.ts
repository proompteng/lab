import { Result } from 'effect'

import type { AuditCheck, QualificationAuditFailure, QualificationAuditReport } from './audit'
import {
  auditHashMatches,
  expectedResultReason,
  hashAuditMaterial,
  makeAuditCheck,
  sameAuditMaterial,
  type QualificationAuditFacts,
} from './core'
import { Pipeable } from '../pipeable'

export const auditQualificationBindings = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
    const { database, input, lock, policyDocuments, policySetHash, reference, result } = facts
    const { lockId, ...lockMaterial } = lock
    const { resultHash, ...resultMaterial } = result
    const analysis = result.analysis
    const { analysisHash, ...analysisMaterial } = analysis
    const lockData = lock.data
    const lockContractBinding =
      lock.schemaVersion === 'bayn.qualification-lock.v3' &&
      lock.universeId === input.protocol.universeId &&
      lock.universeSymbolHash === input.protocol.universeSymbolHash &&
      lockData.inputManifestHash === input.manifest.hash
    const economicPass = reference.verdict.gates.every((gate) => gate.passed)
    const analysisPass = analysis.status === 'PASS'
    const expectedQualification = economicPass && analysisPass ? 'QUALIFIED' : 'REJECTED'
    const expectedEconomicReasons = reference.verdict.gates
      .filter((gate) => !gate.passed)
      .map((gate) => expectedResultReason(gate.name))
    const expectedReasonCodes = [...new Set([...expectedEconomicReasons, ...analysis.reasonCodes])].sort()
    const lockHashMatches = yield* auditHashMatches({ scope: 'lock', name: 'document' }, lockMaterial, lockId)
    const lockImageMatches = yield* sameAuditMaterial({ scope: 'lock', name: 'image' }, lock.image, {
      repository: database.run.imageRepository,
      digest: database.run.imageDigest,
    })
    const lockUniverseMatches = yield* sameAuditMaterial(
      { scope: 'lock', name: 'universe' },
      lock.universe,
      input.protocol.universe,
    )
    const lockBoundsMatch = yield* sameAuditMaterial(
      { scope: 'lock', name: 'bounds' },
      lockData.bounds,
      input.manifest.bounds,
    )
    const policyNamesMatch = yield* sameAuditMaterial(
      { scope: 'policy', name: 'names' },
      policyDocuments.map((policy) => policy.name),
      ['benchmark', 'execution', 'thresholds', 'uncertainty'],
    )
    const policyHashes = yield* Result.all(
      policyDocuments.map((policy) =>
        auditHashMatches({ scope: 'policy', name: policy.name }, policy.content, policy.contentHash),
      ),
    )
    const priorLineageMatches = yield* sameAuditMaterial(
      { scope: 'lineage', name: 'prior-trials' },
      lock.priorTrialRunIds,
      [...database.priorTrialRunIds].sort(),
    )
    const analysisHashMatches = yield* auditHashMatches(
      { scope: 'analysis', name: 'document' },
      analysisMaterial,
      analysisHash,
    )
    const resultHashMatches = yield* auditHashMatches({ scope: 'result', name: 'document' }, resultMaterial, resultHash)
    const analysisLineageMatches = yield* sameAuditMaterial(
      { scope: 'analysis', name: 'prior-trials' },
      analysis.priorTrialRunIds,
      lock.priorTrialRunIds,
    )
    const evaluationVerdictMatches = yield* sameAuditMaterial(
      { scope: 'result', name: 'evaluation-verdict' },
      result.evaluationVerdict,
      reference.verdict,
    )
    const reasonCodesMatch = yield* sameAuditMaterial(
      { scope: 'result', name: 'reason-codes' },
      result.reasonCodes,
      expectedReasonCodes,
    )
    return [
      makeAuditCheck('lock-hash', lockHashMatches, `lockId=${lockId}`),
      makeAuditCheck(
        'qualification-row-binding',
        database.qualification.storedLockId === lockId &&
          database.qualification.storedAnalysisHash === analysis.analysisHash &&
          database.qualification.storedResultHash === resultHash &&
          database.qualification.storedVerdict === result.verdict,
        `storedResultHash=${database.qualification.storedResultHash}`,
      ),
      makeAuditCheck(
        'lock-candidate-binding',
        lock.candidateRunId === database.run.runId &&
          lock.protocolHash === database.run.protocolHash &&
          lock.sourceRevision === database.run.sourceRevision &&
          lockImageMatches &&
          lockContractBinding &&
          lockUniverseMatches,
        `candidateRunId=${String(lock.candidateRunId)}`,
      ),
      makeAuditCheck(
        'lock-data-binding',
        lockData.snapshotId === input.manifest.finalizedSnapshot.snapshotId &&
          lockData.publicationId === input.manifest.finalizedSnapshot.publicationId &&
          lockData.contentHash === input.manifest.finalizedSnapshot.contentHash &&
          lockData.sessionsContentHash === input.manifest.finalizedSnapshot.sessionsContentHash &&
          lockData.selectedSessionCount === reference.strategy.metrics.observations &&
          lockData.selectedRebalanceCount === reference.strategy.decisions.length &&
          lockBoundsMatch,
        `snapshotId=${String(lockData.snapshotId)}`,
      ),
      makeAuditCheck(
        'lock-policy-hashes',
        policyNamesMatch && policyHashes.every(Boolean),
        `${policyDocuments.length} policies policySetHash=${policySetHash}`,
      ),
      makeAuditCheck(
        'locked-prior-trial-lineage',
        priorLineageMatches,
        `${database.priorTrialRunIds.length} prior trials`,
      ),
      makeAuditCheck('analysis-hash', analysisHashMatches, `analysisHash=${analysisHash}`),
      makeAuditCheck('result-hash', resultHashMatches, `resultHash=${resultHash}`),
      makeAuditCheck(
        'analysis-lineage',
        analysis.runId === database.run.runId &&
          analysisLineageMatches &&
          analysis.candidateOrdinal === database.priorTrialRunIds.length + 1,
        `candidateOrdinal=${String(analysis.candidateOrdinal)}`,
      ),
      makeAuditCheck(
        'terminal-result-binding',
        result.lockId === lockId &&
          result.runId === database.run.runId &&
          result.verdict === expectedQualification &&
          evaluationVerdictMatches &&
          reasonCodesMatch,
        `verdict=${String(result.verdict)} reasons=${result.reasonCodes.join(',')}`,
      ),
    ]
  })

const makeAuditReportDataFirst = (
  facts: QualificationAuditFacts,
  checks: readonly AuditCheck[],
): Result.Result<QualificationAuditReport, QualificationAuditFailure> =>
  Result.gen(function* () {
    const { database, input, lock, policyDocuments, policySetHash, reference, result, sortedAccess, sortedReplicas } =
      facts
    const material = {
      schemaVersion: 'bayn.qualification-audit.v2' as const,
      runId: database.run.runId,
      status: checks.every((value) => value.passed) ? ('PASS' as const) : ('FAIL' as const),
      reference: {
        economicStatus: reference.verdict.status,
        observations: reference.strategy.metrics.observations,
        rebalanceCount: reference.strategy.decisions.length,
      },
      evidence: {
        artifactCount: database.artifacts.length,
        eventCount: database.events.length,
        gateCount: database.gates.length,
        lockId: lock.lockId,
        resultHash: result.resultHash,
      },
      policies: {
        declaredAt: database.qualification.lockCreatedAt,
        lockId: lock.lockId,
        policySetHash,
        documents: policyDocuments,
      },
      contamination: {
        lockCreatedAt: database.qualification.lockCreatedAt,
        resultCommittedAt: database.qualification.resultCommittedAt,
        replicas: sortedReplicas,
        principals: input.signalPrincipals,
        access: sortedAccess,
      },
      repository: { ...input.repository, sourceRevision: database.run.sourceRevision },
      checks,
    }
    const auditHash = yield* hashAuditMaterial({ scope: 'audit', name: 'report' }, material)
    return { ...material, auditHash }
  })

export const makeAuditReport = Pipeable.dual(2, makeAuditReportDataFirst)
