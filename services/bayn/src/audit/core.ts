import { Result } from 'effect'

import { riskBalancedTrendTerminalReplayBehaviorHashes } from '../behavior'
import { makeRuntimeProvenanceResult, type RuntimeProvenance } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import type { QualificationLock, QualificationResult } from '../qualification'
import {
  reconcileMarkedEquity,
  renderSimulationReconciliationIssues,
  type MarkedEquityProof,
} from '../simulation-reconciliation'
import type { SimulationTrace } from '../types'
import type {
  AuditCanonicalizationSubject,
  AuditCheck,
  AuditDatabaseSnapshot,
  QualificationAuditFailure,
  QualificationAuditInput,
  SignalAccessRecord,
} from './audit'
import { evaluateReference, type ReferenceEvaluation } from './reference'
import { auditContract } from './audit'

export const MICROS_STRING = '1000000'

export const hashAuditMaterial = (
  subject: AuditCanonicalizationSubject,
  value: unknown,
): Result.Result<string, QualificationAuditFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): QualificationAuditFailure => ({ _tag: 'AuditCanonicalizationFailed', subject, cause }),
  )

export const sameAuditMaterial = (
  subject: AuditCanonicalizationSubject,
  left: unknown,
  right: unknown,
): Result.Result<boolean, QualificationAuditFailure> =>
  Result.gen(function* () {
    const leftHash = yield* hashAuditMaterial(subject, left)
    const rightHash = yield* hashAuditMaterial(subject, right)
    return leftHash === rightHash
  })

export const auditHashMatches = (
  subject: AuditCanonicalizationSubject,
  value: unknown,
  expectedHash: string,
): Result.Result<boolean, QualificationAuditFailure> =>
  Result.map(hashAuditMaterial(subject, value), (actualHash) => actualHash === expectedHash)

export const expectedResultReason = (gateName: string): string =>
  `EVALUATION_${gateName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}_FAILED`

export const makeAuditCheck = (name: string, passed: boolean, evidence: string): AuditCheck => ({
  name,
  passed,
  evidence,
})

export const makePolicyDocuments = (lock: QualificationLock) =>
  (
    [
      ['benchmark', lock.policies.benchmark],
      ['execution', lock.policies.execution],
      ['thresholds', lock.policies.thresholds],
      ['uncertainty', lock.policies.uncertainty],
    ] as const
  ).map(([name, policy]) => ({ name, ...policy }))

export const makeEvaluationSummary = (
  input: QualificationAuditInput,
  reference: ReferenceEvaluation,
  trace: SimulationTrace,
  markedEquity: MarkedEquityProof['reconciliation'],
) => ({
  schemaVersion: auditContract.summarySchemaVersion,
  runId: reference.runId,
  evaluationSchemaVersion: auditContract.evaluationSchemaVersion,
  codeRevision: input.database.run.sourceRevision,
  protocolHash: reference.protocolHash,
  initialCapitalMicros: input.protocol.initialCapitalMicros,
  input: {
    snapshotId: input.manifest.finalizedSnapshot.snapshotId,
    publicationId: input.manifest.finalizedSnapshot.publicationId,
    manifestHash: input.manifest.hash,
    bounds: input.manifest.bounds,
    rowCount: input.manifest.rowCount,
    sessionCount: input.manifest.sessionCount,
    symbols: input.manifest.symbols.map((coverage) => coverage.symbol),
  },
  strategy: reference.strategy.metrics,
  buyAndHold: reference.buyAndHold.metrics,
  directVolTiming: reference.directVolTiming.metrics,
  doubleCostStrategy: reference.doubleCostStrategy.metrics,
  verdict: reference.verdict,
  eventCount: reference.strategy.events.length,
  signalDecisionCount: reference.strategy.decisions.length,
  orderCount: trace.orders.length,
  cashChangeCount: trace.cashChanges.length,
  dailyMarkCount: trace.dailyMarks.length,
  benchmarkSeriesCounts: {
    buyAndHold: reference.buyAndHold.daily.length,
    directVolTiming: reference.directVolTiming.daily.length,
    doubleCostStrategy: reference.doubleCostStrategy.daily.length,
  },
  markedEquityReconciliation: markedEquity,
})

const hasTerminalCloseEvent = (database: AuditDatabaseSnapshot): boolean =>
  database.events.some(({ payload }) => payload.kind === 'decision' && payload.terminalClose === true)

/**
 * Terminal liquidation is part of the v4 behavior identity, not a property of whether the
 * strategy happened to need a closing decision on its final session. The event marker remains
 * the compatibility path for v6 evidence written before that identity was persisted.
 */
export const usesTerminalReplaySemantics = (database: AuditDatabaseSnapshot): boolean =>
  riskBalancedTrendTerminalReplayBehaviorHashes.includes(database.protocol.behaviorHash) ||
  hasTerminalCloseEvent(database)

export type MarkedEquityAuditMaterial =
  | { readonly _tag: 'Available'; readonly proof: MarkedEquityProof }
  | { readonly _tag: 'Unavailable'; readonly evidence: string }

export interface QualificationAuditFacts {
  readonly input: QualificationAuditInput
  readonly database: AuditDatabaseSnapshot
  readonly artifact: ReadonlyMap<string, AuditDatabaseSnapshot['artifacts'][number]>
  readonly artifactContentHashes: ReadonlyMap<string, string>
  readonly lock: QualificationLock
  readonly result: QualificationResult
  readonly reference: ReferenceEvaluation
  readonly trace: SimulationTrace
  readonly provenance: RuntimeProvenance
  readonly policyDocuments: ReturnType<typeof makePolicyDocuments>
  readonly policySetHash: string
  readonly sortedReplicas: readonly string[]
  readonly replicaSet: ReadonlySet<string>
  readonly sortedAccess: readonly SignalAccessRecord[]
  readonly publisherSet: ReadonlySet<string>
  readonly markedEquity: MarkedEquityAuditMaterial
}

const makeMarkedEquityAuditMaterial = (
  input: QualificationAuditInput,
  reference: ReferenceEvaluation,
  trace: SimulationTrace,
): MarkedEquityAuditMaterial => {
  const result = reconcileMarkedEquity({
    runId: reference.runId,
    initialCapitalMicros: input.protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: reference.strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: reference.strategy.metrics.endingEquityMicros,
    events: reference.strategy.events,
    simulation: trace,
  })
  return Result.isSuccess(result)
    ? { _tag: 'Available', proof: result.success }
    : {
        _tag: 'Unavailable',
        evidence: `reconciliation unavailable: ${renderSimulationReconciliationIssues(result.failure)}`,
      }
}

export const makeAuditFacts = (
  input: QualificationAuditInput,
): Result.Result<QualificationAuditFacts, QualificationAuditFailure> => {
  const database = input.database
  if (database.protocol.strategyName !== auditContract.name || database.run.strategyName !== auditContract.name) {
    return Result.fail({
      _tag: 'UnsupportedAuditStrategyContract',
      protocolStrategyName: database.protocol.strategyName,
      runStrategyName: database.run.strategyName,
      requiredStrategyName: auditContract.name,
    })
  }
  const supportedSchemaVersions = [
    'bayn.risk-balanced-trend.protocol.v3',
    'bayn.risk-balanced-trend.protocol.v4',
  ] as const
  if (
    database.protocol.schemaVersion !== input.protocol.schemaVersion ||
    !supportedSchemaVersions.some((schemaVersion) => schemaVersion === database.protocol.schemaVersion)
  ) {
    return Result.fail({
      _tag: 'UnsupportedAuditProtocolVersion',
      storedSchemaVersion: database.protocol.schemaVersion,
      suppliedSchemaVersion: input.protocol.schemaVersion,
      supportedSchemaVersions,
    })
  }
  const provenanceResult = makeRuntimeProvenanceResult({
    sourceRevision: database.run.sourceRevision,
    image: { repository: database.run.imageRepository, digest: database.run.imageDigest },
    strategy: {
      name: database.protocol.strategyName,
      behaviorHash: database.protocol.behaviorHash,
      parameterHash: database.protocol.parameterHash,
      parameterSchemaVersion: database.protocol.schemaVersion,
    },
  })
  if (Result.isFailure(provenanceResult)) return Result.fail(provenanceResult.failure)
  // Terminal liquidation was added after the v6 evaluation contract was already persisted.
  // The persisted v4 behavior identity is the durable marker even when a flat strategy emits no
  // terminal-close decision; the event marker preserves legacy v6 evidence semantics.
  const closeAtEnd = usesTerminalReplaySemantics(database)
  const referenceResult = evaluateReference(
    input.bars,
    input.manifest,
    input.protocol,
    provenanceResult.success,
    closeAtEnd,
  )
  if (Result.isFailure(referenceResult)) return Result.fail(referenceResult.failure)
  const reference = referenceResult.success
  const trace = reference.strategy.trace
  if (trace === null) return Result.fail({ _tag: 'ReferenceCandidateTraceMissing', runId: reference.runId })
  const sortedReplicas = [...input.signalReplicas].sort()
  const sortedAccess = [...input.signalAccess].sort((left, right) => {
    if (left.queryStartTime !== right.queryStartTime) return left.queryStartTime < right.queryStartTime ? -1 : 1
    if (left.replica !== right.replica) return left.replica < right.replica ? -1 : 1
    return left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0
  })
  const policyDocuments = makePolicyDocuments(database.qualification.lock)
  const policySetHashResult = hashAuditMaterial({ scope: 'policy', name: 'set' }, policyDocuments)
  if (Result.isFailure(policySetHashResult)) return Result.fail(policySetHashResult.failure)
  const artifactContentHashesResult = Result.all(
    database.artifacts.map((artifact) =>
      Result.map(
        hashAuditMaterial({ scope: 'artifact', name: artifact.name }, artifact.payload),
        (contentHash) => [artifact.name, contentHash] as const,
      ),
    ),
  )
  if (Result.isFailure(artifactContentHashesResult)) return Result.fail(artifactContentHashesResult.failure)
  return Result.succeed({
    input,
    database,
    artifact: new Map(database.artifacts.map((value) => [value.name, value])),
    artifactContentHashes: new Map(artifactContentHashesResult.success),
    lock: database.qualification.lock,
    result: database.qualification.result,
    reference,
    trace,
    provenance: provenanceResult.success,
    policyDocuments,
    policySetHash: policySetHashResult.success,
    sortedReplicas,
    replicaSet: new Set(sortedReplicas),
    sortedAccess,
    publisherSet: new Set(input.signalPrincipals.publishers),
    markedEquity: makeMarkedEquityAuditMaterial(input, reference, trace),
  })
}
