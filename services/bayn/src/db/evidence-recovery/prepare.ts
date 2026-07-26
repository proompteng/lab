import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult, type RuntimeProvenance } from '../../contracts'
import { SimulatedOrdersArtifactSchema } from '../../evidence-contracts'
import { requiredArtifact } from './artifacts'
import {
  decodeCashChangesArtifact,
  decodeDailyPerformanceSeriesArtifact,
  decodeDailyPositionMarksArtifact,
  decodeEquitySeriesArtifact,
  decodeEvaluationEvents,
  decodeEvaluationSummary,
  decodeInputManifestArtifact,
  decodeMarkedEquityReconciliation,
  decodeQualificationArtifactManifest,
  decodeReconciliationResult,
  decodeSignalDecisionsArtifact,
  decodeSimulatedOrdersArtifact,
} from './decoders'
import {
  evidenceRecoveryContract,
  type ArtifactIndex,
  type EvidenceRecoveryIssue,
  type InitialDecodedArtifacts,
  type PreparedEvidenceRecovery,
  type RemainingDecodedArtifacts,
  type StoredArtifact,
  type StoredEvidenceRows,
  type StoredEvaluationEvidence,
} from './model'
import { canonicalHash, mismatch, recoveryFailure } from './shared'
import { toStoredEvidence, validateStoredGraph } from './stored'

const validateEvidenceContract = (stored: StoredEvaluationEvidence): Result.Result<void, EvidenceRecoveryIssue> => {
  if (stored.run.strategyName !== evidenceRecoveryContract.strategyName) {
    return mismatch('contract', ['strategyName'], stored.run.strategyName, evidenceRecoveryContract.strategyName)
  }
  if (stored.run.evaluationSchemaVersion !== evidenceRecoveryContract.evaluationSchemaVersion) {
    return mismatch(
      'contract',
      ['evaluationSchemaVersion'],
      stored.run.evaluationSchemaVersion,
      evidenceRecoveryContract.evaluationSchemaVersion,
    )
  }
  return Result.void
}

const validateArtifactSet = (
  artifacts: readonly StoredArtifact[],
): Result.Result<ArtifactIndex, EvidenceRecoveryIssue> => {
  const artifactIndex = new Map<string, StoredArtifact>()
  const artifactCounts = new Map<string, number>()
  for (const artifact of artifacts) {
    const observedCount = (artifactCounts.get(artifact.name) ?? 0) + 1
    artifactCounts.set(artifact.name, observedCount)
    if (observedCount > 1) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: { _tag: 'DuplicateArtifact', name: artifact.name, observedCount, expectedCount: 1 },
      })
    }
    artifactIndex.set(artifact.name, artifact)
  }

  for (const required of evidenceRecoveryContract.artifacts) {
    if (!artifactIndex.has(required.name)) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: {
          _tag: 'MissingArtifact',
          name: required.name,
          expectedSchemaVersion: required.schemaVersion,
        },
      })
    }
  }
  for (const artifact of artifacts) {
    if (!evidenceRecoveryContract.artifacts.some((required) => required.name === artifact.name)) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: {
          _tag: 'ExtraArtifact',
          name: artifact.name,
          observedSchemaVersion: artifact.schemaVersion,
        },
      })
    }
  }
  for (const required of evidenceRecoveryContract.artifacts) {
    const artifact = artifactIndex.get(required.name)
    if (artifact !== undefined && artifact.schemaVersion !== required.schemaVersion) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: {
          _tag: 'WrongArtifactSchema',
          name: required.name,
          observedSchemaVersion: artifact.schemaVersion,
          expectedSchemaVersion: required.schemaVersion,
        },
      })
    }
  }
  return Result.succeed(artifactIndex)
}

const validateRuntimeIdentity = (
  runId: string,
  provenance: RuntimeProvenance,
  stored: StoredEvaluationEvidence,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const facts = [
      ['runId', stored.run.runId, runId],
      ['evaluationSchemaVersion', stored.run.evaluationSchemaVersion, provenance.contractVersions.evaluation],
      ['sourceRevision', stored.run.sourceRevision, provenance.sourceRevision],
      ['imageRepository', stored.run.imageRepository, provenance.image.repository],
      ['imageDigest', stored.run.imageDigest, provenance.image.digest],
      ['strategyName', stored.run.strategyName, provenance.strategy.name],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('runtime', [path], observed, expected)
    }
    const protocolHash = yield* Result.mapError(
      makeStrategyProtocolHashResult(provenance.strategy),
      (cause): EvidenceRecoveryIssue => ({
        _tag: 'ContractConstructionFailure',
        operation: 'runtime-protocol-hash',
        cause,
      }),
    )
    if (stored.run.protocolHash !== protocolHash) {
      return yield* mismatch('runtime', ['protocolHash'], stored.run.protocolHash, protocolHash)
    }
  })

const decodePayload = <A>(
  artifactName: string,
  schemaVersion: string,
  payload: unknown,
  decoder: (input: unknown) => Result.Result<A, Schema.SchemaError>,
): Result.Result<A, EvidenceRecoveryIssue> =>
  Result.mapError(
    decoder(payload),
    (cause): EvidenceRecoveryIssue => ({
      _tag: 'DecodeFailure',
      artifactName,
      schemaVersion,
      cause,
    }),
  )

const decodeArtifact = <A>(
  artifacts: ArtifactIndex,
  name: string,
  decoder: (input: unknown) => Result.Result<A, Schema.SchemaError>,
): Result.Result<A, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const artifact = yield* requiredArtifact(artifacts, name)
    return yield* decodePayload(artifact.name, artifact.schemaVersion, artifact.payload, decoder)
  })

const decodeCoreArtifacts = (stored: StoredEvaluationEvidence, artifacts: ArtifactIndex) =>
  Result.gen(function* () {
    const evaluation = yield* decodeArtifact(artifacts, 'evaluation-summary', decodeEvaluationSummary)
    const reconciliation = yield* decodeArtifact(artifacts, 'reconciliation', decodeReconciliationResult)
    const markedEquity = yield* decodeArtifact(
      artifacts,
      'marked-equity-reconciliation',
      decodeMarkedEquityReconciliation,
    )
    const equitySeries = yield* decodeArtifact(artifacts, 'equity-series', decodeEquitySeriesArtifact)
    const events = yield* decodePayload(
      'evaluation-events',
      'bayn.evaluation-event.v1[]',
      stored.events.map((event) => event.payload),
      decodeEvaluationEvents,
    )
    return { evaluation, reconciliation, markedEquity, equitySeries, events }
  })

const decodeExecutionArtifacts = (artifacts: ArtifactIndex) =>
  Result.gen(function* () {
    const orders = yield* decodeArtifact(artifacts, 'simulated-orders', decodeSimulatedOrdersArtifact)
    const signalDecisions = yield* decodeArtifact(
      artifacts,
      evidenceRecoveryContract.signalDecisionsArtifactName,
      decodeSignalDecisionsArtifact,
    )
    return { orders, signalDecisions }
  })

const decodeSeriesArtifacts = (artifacts: ArtifactIndex) =>
  Result.gen(function* () {
    const buyAndHoldSeries = yield* decodeArtifact(
      artifacts,
      'buy-and-hold-series',
      decodeDailyPerformanceSeriesArtifact,
    )
    const directVolatilitySeries = yield* decodeArtifact(
      artifacts,
      'direct-volatility-timing-series',
      decodeDailyPerformanceSeriesArtifact,
    )
    const doubleCostSeries = yield* decodeArtifact(
      artifacts,
      'double-cost-strategy-series',
      decodeDailyPerformanceSeriesArtifact,
    )
    return { buyAndHoldSeries, directVolatilitySeries, doubleCostSeries }
  })

const decodeInitialArtifacts = (
  stored: StoredEvaluationEvidence,
  artifacts: ArtifactIndex,
): Result.Result<InitialDecodedArtifacts, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const core = yield* decodeCoreArtifacts(stored, artifacts)
    const execution = yield* decodeExecutionArtifacts(artifacts)
    const series = yield* decodeSeriesArtifacts(artifacts)
    const artifactManifest = yield* decodeArtifact(
      artifacts,
      'qualification-artifact-manifest',
      decodeQualificationArtifactManifest,
    )
    return { ...core, ...execution, ...series, artifactManifest }
  })

const validateProtocolExecutionLock = (
  provenance: RuntimeProvenance,
  stored: StoredEvaluationEvidence,
  orders: typeof SimulatedOrdersArtifactSchema.Type,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const facts = [
      ['parameterSchemaVersion', stored.protocol.schemaVersion, provenance.strategy.parameterSchemaVersion],
      ['strategyName', stored.protocol.strategyName, provenance.strategy.name],
      ['behaviorHash', stored.protocol.behaviorHash, provenance.strategy.behaviorHash],
      ['parameterHash', stored.protocol.parameterHash, provenance.strategy.parameterHash],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('protocol', [path], observed, expected)
    }
    const parameterHash = yield* canonicalHash('protocol-parameters', stored.protocol.parameters, stored.run.runId)
    if (parameterHash !== provenance.strategy.parameterHash) {
      return yield* mismatch('protocol', ['parameterHash'], parameterHash, provenance.strategy.parameterHash)
    }
    const protocolExecutionHash = yield* canonicalHash(
      'protocol-execution-model',
      stored.protocol.parameters.executionModel,
      stored.run.runId,
    )
    const ordersExecutionHash = yield* canonicalHash(
      'protocol-execution-model',
      orders.executionModel,
      'simulated-orders',
    )
    if (protocolExecutionHash !== ordersExecutionHash) {
      return yield* mismatch('protocol', ['executionModelHash'], ordersExecutionHash, protocolExecutionHash)
    }
    if (orders.costMultiplierMicros !== '1000000') {
      return yield* mismatch('protocol', ['costMultiplierMicros'], orders.costMultiplierMicros, '1000000')
    }
  })

const decodeRemainingArtifacts = (
  artifacts: ArtifactIndex,
): Result.Result<RemainingDecodedArtifacts, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const cashChanges = yield* decodeArtifact(artifacts, 'cash-changes', decodeCashChangesArtifact)
    const dailyMarks = yield* decodeArtifact(artifacts, 'daily-position-marks', decodeDailyPositionMarksArtifact)
    const inputManifest = yield* decodeArtifact(artifacts, 'input-manifest', decodeInputManifestArtifact)
    return { cashChanges, dailyMarks, inputManifest }
  })

type ManifestArtifactName = Exclude<
  (typeof evidenceRecoveryContract.artifacts)[number]['name'],
  'qualification-artifact-manifest'
>

const collectManifestArtifacts = (
  artifacts: ArtifactIndex,
  decoded: InitialDecodedArtifacts & RemainingDecodedArtifacts,
): Result.Result<
  readonly {
    readonly name: string
    readonly schemaVersion: string
    readonly itemCount: number
    readonly contentHash: string
  }[],
  EvidenceRecoveryIssue
> =>
  Result.gen(function* () {
    const itemCounts: Readonly<Record<ManifestArtifactName, number>> = {
      'buy-and-hold': 0,
      'buy-and-hold-series': decoded.buyAndHoldSeries.items.length,
      'cash-changes': decoded.cashChanges.items.length,
      'daily-position-marks': decoded.dailyMarks.items.length,
      'direct-volatility-timing': 0,
      'direct-volatility-timing-series': decoded.directVolatilitySeries.items.length,
      'double-cost-strategy': 0,
      'double-cost-strategy-series': decoded.doubleCostSeries.items.length,
      'equity-series': decoded.equitySeries.items.length,
      'evaluation-summary': 0,
      'input-manifest': 0,
      'marked-equity-reconciliation': 0,
      reconciliation: 0,
      'risk-balanced-trend-decisions': decoded.signalDecisions.items.length,
      'simulated-orders': decoded.orders.items.length,
      strategy: 0,
    }
    const references = []
    for (const required of evidenceRecoveryContract.artifacts) {
      if (required.name === 'qualification-artifact-manifest') continue
      const artifact = yield* requiredArtifact(artifacts, required.name)
      references.push({
        name: artifact.name,
        schemaVersion: artifact.schemaVersion,
        itemCount: itemCounts[required.name],
        contentHash: artifact.contentHash,
      })
    }
    return references
  })

const validateArtifactManifest = (
  runId: string,
  stored: StoredEvaluationEvidence,
  artifacts: ArtifactIndex,
  decoded: InitialDecodedArtifacts & RemainingDecodedArtifacts,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const manifestArtifacts = yield* collectManifestArtifacts(artifacts, decoded)
    const eventReferencesHash = yield* canonicalHash(
      'artifact-manifest-expected',
      stored.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
      'events',
    )
    const gateReferencesHash = yield* canonicalHash(
      'artifact-manifest-expected',
      stored.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
      'gates',
    )
    const expected = {
      schemaVersion: 'bayn.qualification-artifact-manifest.v1',
      identity: {
        runId,
        evaluationSchemaVersion: decoded.evaluation.evaluationSchemaVersion,
        protocolHash: stored.run.protocolHash,
        sourceRevision: stored.run.sourceRevision,
        image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
        snapshotId: stored.run.snapshotId,
        publicationId: decoded.inputManifest.finalizedSnapshot.publicationId,
        inputManifestHash: decoded.inputManifest.hash,
        bounds: decoded.inputManifest.bounds,
        calendarVersion: decoded.inputManifest.finalizedSnapshot.calendarVersion,
      },
      execution: {
        parameterSchemaVersion: stored.protocol.schemaVersion,
        parameterHash: stored.protocol.parameterHash,
        simulationSchemaVersion: 'bayn.simulation-trace.v3',
        executionModel: decoded.orders.executionModel,
        costMultiplierMicros: decoded.orders.costMultiplierMicros,
      },
      artifacts: manifestArtifacts,
      events: { count: stored.events.length, contentHash: eventReferencesHash },
      gates: { count: stored.gates.length, contentHash: gateReferencesHash },
    }
    const observedHash = yield* canonicalHash(
      'artifact-manifest-observed',
      decoded.artifactManifest,
      'qualification-artifact-manifest',
    )
    const expectedHash = yield* canonicalHash('artifact-manifest-expected', expected, 'qualification-artifact-manifest')
    if (observedHash !== expectedHash) {
      return yield* mismatch('manifest', ['qualificationArtifactManifest'], observedHash, expectedHash)
    }
  })

export const prepareEvidenceRecovery = (input: {
  readonly runId: string
  readonly provenance: RuntimeProvenance
  readonly rows: StoredEvidenceRows
}): Result.Result<PreparedEvidenceRecovery, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const graph = yield* validateStoredGraph(input.runId, input.rows)
    const stored = toStoredEvidence(graph)
    yield* validateEvidenceContract(stored)
    const artifacts = yield* validateArtifactSet(stored.artifacts)
    yield* validateRuntimeIdentity(input.runId, input.provenance, stored)
    const initialDecoded = yield* decodeInitialArtifacts(stored, artifacts)
    yield* validateProtocolExecutionLock(input.provenance, stored, initialDecoded.orders)
    const remainingDecoded = yield* decodeRemainingArtifacts(artifacts)
    const decoded = { ...initialDecoded, ...remainingDecoded }
    yield* validateArtifactManifest(input.runId, stored, artifacts, decoded)
    return { runId: input.runId, provenance: input.provenance, stored, artifacts, decoded }
  })
