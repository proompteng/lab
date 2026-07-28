import { Result } from 'effect'

import {
  EquitySeriesArtifactSchema,
  EvaluationSummarySchema,
  MarkedEquityReconciliationSchema,
} from '../../evidence-contracts'
import type { MarkedEquityProof } from '../../simulation-reconciliation'
import { requiredArtifact } from './artifacts'
import {
  type EvidenceRecoveryIssue,
  type PreparedEvidenceRecovery,
  type RecoveredEvaluationEvidence,
  type RecoveryPath,
  type StoredEvaluationEvidence,
  type StoredSnapshotRow,
} from './model'
import {
  reconcileRecoveredEvidence,
  validateRecoveredReconciliationShape,
  validateRecoveredSnapshotReference,
} from './reconciliation-proof'
import { canonicalHash, mismatch } from './shared'

const componentMismatch = (
  path: RecoveryPath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, EvidenceRecoveryIssue> => mismatch('components', path, observed, expected)

const validateEvaluationIdentity = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation, inputManifest } = prepared.decoded
    const facts = [
      [['evaluation', 'runId'], evaluation.runId, prepared.runId],
      [['evaluation', 'codeRevision'], evaluation.codeRevision, prepared.provenance.sourceRevision],
      [['evaluation', 'protocolHash'], evaluation.protocolHash, prepared.stored.run.protocolHash],
      [
        ['evaluation', 'initialCapitalMicros'],
        evaluation.initialCapitalMicros,
        prepared.stored.run.initialCapitalMicros,
      ],
      [['evaluation', 'input', 'snapshotId'], evaluation.input.snapshotId, prepared.stored.run.snapshotId],
      [['evaluation', 'input', 'snapshotId'], evaluation.input.snapshotId, inputManifest.finalizedSnapshot.snapshotId],
      [
        ['evaluation', 'input', 'publicationId'],
        evaluation.input.publicationId,
        inputManifest.finalizedSnapshot.publicationId,
      ],
      [['evaluation', 'input', 'manifestHash'], evaluation.input.manifestHash, inputManifest.hash],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* componentMismatch(path, observed, expected)
    }
  })

const validateEvaluationInput = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation, inputManifest } = prepared.decoded
    const evaluationBoundsHash = yield* canonicalHash('evaluation-bounds', evaluation.input.bounds, 'evaluation')
    const manifestBoundsHash = yield* canonicalHash('evaluation-bounds', inputManifest.bounds, 'input-manifest')
    if (evaluationBoundsHash !== manifestBoundsHash) {
      return yield* componentMismatch(['evaluation', 'input', 'boundsHash'], evaluationBoundsHash, manifestBoundsHash)
    }
    const facts = [
      [['evaluation', 'input', 'rowCount'], evaluation.input.rowCount, inputManifest.rowCount],
      [['evaluation', 'input', 'sessionCount'], evaluation.input.sessionCount, inputManifest.sessionCount],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* componentMismatch(path, observed, expected)
    }
    const evaluationSymbolsHash = yield* canonicalHash(
      'evaluation-input-symbols',
      evaluation.input.symbols,
      'evaluation',
    )
    const manifestSymbolsHash = yield* canonicalHash(
      'evaluation-input-symbols',
      inputManifest.symbols.map((coverage) => coverage.symbol),
      'input-manifest',
    )
    if (evaluationSymbolsHash !== manifestSymbolsHash) {
      return yield* componentMismatch(
        ['evaluation', 'input', 'symbolsHash'],
        evaluationSymbolsHash,
        manifestSymbolsHash,
      )
    }
  })

const validateEvaluationEvents = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  const { evaluation } = prepared.decoded
  if (evaluation.eventCount !== prepared.stored.run.eventCount) {
    return componentMismatch(['evaluation', 'eventCount'], evaluation.eventCount, prepared.stored.run.eventCount)
  }
  if (evaluation.eventCount !== prepared.decoded.events.length) {
    return componentMismatch(['evaluation', 'eventCount'], evaluation.eventCount, prepared.decoded.events.length)
  }
  return Result.void
}

const validateEvaluationFacts = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    yield* validateEvaluationIdentity(prepared)
    yield* validateEvaluationInput(prepared)
    yield* validateEvaluationEvents(prepared)
  })

const validateSignalDecisions = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { decoded } = prepared
    const decisions = decoded.signalDecisions.items
    const events = decoded.events.filter((event) => event.kind === 'decision')
    if (decoded.evaluation.signalDecisionCount !== decisions.length) {
      return yield* componentMismatch(
        ['evaluation', 'signalDecisionCount'],
        decoded.evaluation.signalDecisionCount,
        decisions.length,
      )
    }
    if (decisions.length !== events.length) {
      return yield* componentMismatch(['signalDecisions', 'length'], decisions.length, events.length)
    }
    for (const [index, decision] of decisions.entries()) {
      const event = events[index]
      if (event === undefined) {
        return yield* componentMismatch(['signalDecisions', index], decision, 'decision event')
      }
      const facts = [
        ['decisionId', decision.decisionId, event.id],
        ['signalDate', decision.signalDate, event.signalDate],
        ['executionDate', decision.executionDate, event.executionDate],
      ] as const
      for (const [path, observed, expected] of facts) {
        if (observed !== expected) {
          return yield* componentMismatch(['signalDecisions', index, path], observed, expected)
        }
      }
      const decisionWeightsHash = yield* canonicalHash(
        'signal-target-weights',
        decision.targetWeights,
        `decision:${decision.decisionId}`,
      )
      const eventWeightsHash = yield* canonicalHash('signal-target-weights', event.targetWeights, `event:${event.id}`)
      if (decisionWeightsHash !== eventWeightsHash) {
        return yield* componentMismatch(
          ['signalDecisions', index, 'targetWeightsHash'],
          decisionWeightsHash,
          eventWeightsHash,
        )
      }
    }
  })

const validateSimulationCardinality = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  const facts = [
    [['evaluation', 'orderCount'], decoded.evaluation.orderCount, decoded.orders.items.length],
    [['evaluation', 'cashChangeCount'], decoded.evaluation.cashChangeCount, decoded.cashChanges.items.length],
    [['evaluation', 'dailyMarkCount'], decoded.evaluation.dailyMarkCount, decoded.dailyMarks.items.length],
    [['evaluation', 'dailyMarkCount'], decoded.evaluation.dailyMarkCount, decoded.evaluation.strategy.observations],
  ] as const
  for (const [path, observed, expected] of facts) {
    if (observed !== expected) return componentMismatch(path, observed, expected)
  }
  return Result.void
}

const validateBenchmarkCardinality = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  const facts = [
    [
      ['evaluation', 'benchmarkSeriesCounts', 'buyAndHold'],
      decoded.evaluation.benchmarkSeriesCounts.buyAndHold,
      decoded.buyAndHoldSeries.items.length,
    ],
    [
      ['evaluation', 'benchmarkSeriesCounts', 'directVolTiming'],
      decoded.evaluation.benchmarkSeriesCounts.directVolTiming,
      decoded.directVolatilitySeries.items.length,
    ],
    [
      ['evaluation', 'benchmarkSeriesCounts', 'doubleCostStrategy'],
      decoded.evaluation.benchmarkSeriesCounts.doubleCostStrategy,
      decoded.doubleCostSeries.items.length,
    ],
  ] as const
  for (const [path, observed, expected] of facts) {
    if (observed !== expected) return componentMismatch(path, observed, expected)
  }
  return Result.void
}

const validateBenchmarkDates = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  const candidateDates = decoded.dailyMarks.items.map((point) => point.sessionDate)
  const series = [
    ['buyAndHold', decoded.buyAndHoldSeries.items],
    ['directVolTiming', decoded.directVolatilitySeries.items],
    ['doubleCostStrategy', decoded.doubleCostSeries.items],
  ] as const
  for (const [name, points] of series) {
    if (points.length !== candidateDates.length) {
      return componentMismatch(['benchmarkSeries', name, 'length'], points.length, candidateDates.length)
    }
    for (const [index, point] of points.entries()) {
      if (point.sessionDate !== candidateDates[index]) {
        return componentMismatch(
          ['benchmarkSeries', name, index, 'sessionDate'],
          point.sessionDate,
          candidateDates[index],
        )
      }
    }
  }
  return Result.void
}

const validateSignalAndSeriesFacts = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    yield* validateSignalDecisions(prepared)
    yield* validateSimulationCardinality(prepared)
    yield* validateBenchmarkCardinality(prepared)
    yield* validateBenchmarkDates(prepared)
  })

const validateMetricArtifact = (
  prepared: PreparedEvidenceRecovery,
  artifactName: 'buy-and-hold' | 'direct-volatility-timing' | 'double-cost-strategy' | 'strategy',
  value: unknown,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const artifact = yield* requiredArtifact(prepared.artifacts, artifactName)
    const expectedHash = yield* canonicalHash('evaluation-metric', value, artifactName)
    if (artifact.contentHash !== expectedHash) {
      return yield* componentMismatch(['artifacts', artifactName, 'contentHash'], artifact.contentHash, expectedHash)
    }
  })

const validateMarkedEquityBinding = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<string, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation, markedEquity } = prepared.decoded
    if (evaluation.markedEquityReconciliation.runId !== prepared.runId) {
      return yield* componentMismatch(
        ['evaluation', 'markedEquityReconciliation', 'runId'],
        evaluation.markedEquityReconciliation.runId,
        prepared.runId,
      )
    }
    const evaluationHash = yield* canonicalHash(
      'evaluation-marked-equity',
      evaluation.markedEquityReconciliation,
      'evaluation',
    )
    const artifactHash = yield* canonicalHash('evaluation-marked-equity', markedEquity, 'artifact')
    if (evaluationHash !== artifactHash) {
      return yield* componentMismatch(['evaluation', 'markedEquityReconciliation'], evaluationHash, artifactHash)
    }
    return artifactHash
  })

const validateMetricArtifacts = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation } = prepared.decoded
    yield* validateMetricArtifact(prepared, 'strategy', evaluation.strategy)
    yield* validateMetricArtifact(prepared, 'buy-and-hold', evaluation.buyAndHold)
    yield* validateMetricArtifact(prepared, 'direct-volatility-timing', evaluation.directVolTiming)
    yield* validateMetricArtifact(prepared, 'double-cost-strategy', evaluation.doubleCostStrategy)
  })

const validateRecoveredGates = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { gates } = prepared.stored
    const expectedGates = prepared.decoded.evaluation.verdict.gates
    if (gates.length !== expectedGates.length) {
      return yield* componentMismatch(['gates', 'length'], gates.length, expectedGates.length)
    }
    for (const [index, gate] of gates.entries()) {
      const expectedGate = expectedGates[index]
      if (expectedGate === undefined) return yield* componentMismatch(['gates', index], gate, 'evaluation gate')
      const observedHash = yield* canonicalHash(
        'gate-outcome',
        { name: gate.name, passed: gate.passed, actual: gate.actual, required: gate.required },
        `stored:${index}`,
      )
      const expectedHash = yield* canonicalHash('gate-outcome', expectedGate, `evaluation:${index}`)
      if (observedHash !== expectedHash) {
        return yield* componentMismatch(['gates', index], observedHash, expectedHash)
      }
    }
  })

const validateRecoveredEvents = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  for (const [index, event] of prepared.stored.events.entries()) {
    const decodedEvent = prepared.decoded.events[index]
    if (decodedEvent === undefined) return componentMismatch(['events', index], event, 'decoded event')
    if (event.id !== decodedEvent.id) return componentMismatch(['events', index, 'id'], event.id, decodedEvent.id)
    if (event.kind !== decodedEvent.kind) {
      return componentMismatch(['events', index, 'kind'], event.kind, decodedEvent.kind)
    }
  }
  return Result.void
}

const validateRecoveredIdentity = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  const { evaluation, markedEquity, equitySeries } = prepared.decoded
  if (markedEquity.runId !== prepared.runId) {
    return componentMismatch(['markedEquity', 'runId'], markedEquity.runId, prepared.runId)
  }
  if (equitySeries.items.length !== evaluation.dailyMarkCount) {
    return componentMismatch(['equitySeries', 'length'], equitySeries.items.length, evaluation.dailyMarkCount)
  }
  return Result.void
}

const validateReconstructedProof = (
  prepared: PreparedEvidenceRecovery,
  proof: MarkedEquityProof,
  storedMarkedHash: string,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const proofMarkedHash = yield* canonicalHash('marked-equity-proof', proof.reconciliation, 'reconstructed')
    if (proofMarkedHash !== storedMarkedHash) {
      return yield* componentMismatch(['markedEquity', 'proofHash'], proofMarkedHash, storedMarkedHash)
    }
    const proofEquityHash = yield* canonicalHash('recovered-equity-series', proof.equitySeries, 'reconstructed')
    const storedEquityHash = yield* canonicalHash(
      'recovered-equity-series',
      prepared.decoded.equitySeries.items,
      'artifact',
    )
    if (proofEquityHash !== storedEquityHash) {
      return yield* componentMismatch(['equitySeries', 'proofHash'], proofEquityHash, storedEquityHash)
    }
  })

const validateRecoveredComponents = (
  prepared: PreparedEvidenceRecovery,
  proof: MarkedEquityProof,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const storedMarkedHash = yield* validateMarkedEquityBinding(prepared)
    yield* validateMetricArtifacts(prepared)
    yield* validateRecoveredGates(prepared)
    yield* validateRecoveredEvents(prepared)
    yield* validateRecoveredIdentity(prepared)
    yield* validateReconstructedProof(prepared, proof, storedMarkedHash)
  })

const validateFinalPoint = (
  finalPoint: (typeof EquitySeriesArtifactSchema.Type)['items'][number],
  markedEquity: typeof MarkedEquityReconciliationSchema.Type,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const facts = [
    ['evaluatorEquityMicros', finalPoint.evaluatorEquityMicros, markedEquity.evaluatorEndingEquityMicros],
    ['reconstructedEquityMicros', finalPoint.reconstructedEquityMicros, markedEquity.reconstructedEndingEquityMicros],
    ['differenceMicros', finalPoint.differenceMicros, markedEquity.differenceMicros],
  ] as const
  for (const [path, observed, expected] of facts) {
    if (observed !== expected) {
      return componentMismatch(['equitySeries', 'final', path], observed, expected)
    }
  }
  return Result.void
}

const validateTerminalStatus = (
  stored: StoredEvaluationEvidence,
  evaluation: typeof EvaluationSummarySchema.Type,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const complete = stored.statuses[1]
  if (complete?.status !== 'COMPLETE') {
    return mismatch('status', ['complete'], complete?.status, 'COMPLETE')
  }
  if (complete.detail.verdict !== evaluation.verdict.status) {
    return mismatch('status', ['complete', 'verdict'], complete.detail.verdict, evaluation.verdict.status)
  }
  return Result.void
}

export const completeEvidenceRecovery = (
  prepared: PreparedEvidenceRecovery,
  snapshot: StoredSnapshotRow,
): Result.Result<RecoveredEvaluationEvidence, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    yield* validateRecoveredSnapshotReference(snapshot, prepared.decoded.inputManifest)
    const reconciliation = yield* reconcileRecoveredEvidence(prepared)
    yield* validateRecoveredReconciliationShape(prepared)
    const finalPoint = prepared.decoded.equitySeries.items.at(-1)
    if (finalPoint === undefined) {
      return yield* componentMismatch(['equitySeries', 'final'], undefined, 'present')
    }
    yield* validateEvaluationFacts(prepared)
    yield* validateSignalAndSeriesFacts(prepared)
    yield* validateRecoveredComponents(prepared, reconciliation)
    yield* validateFinalPoint(finalPoint, prepared.decoded.markedEquity)
    yield* validateTerminalStatus(prepared.stored, prepared.decoded.evaluation)
    return {
      evaluation: prepared.decoded.evaluation,
      reconciliation: prepared.decoded.reconciliation,
      persistence: {
        runId: prepared.runId,
        deduplicated: true,
        artifactCount: prepared.stored.run.artifactCount,
        eventCount: prepared.stored.run.eventCount,
        gateCount: prepared.stored.run.gateCount,
      },
    }
  })
