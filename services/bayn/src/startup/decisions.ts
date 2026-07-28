import { Option, pipe, Result } from 'effect'

import type { RuntimeConfig } from '../config'
import { makeRuntimeProvenanceResult, makeStrategyProtocolHash, type RuntimeProvenance } from '../contracts'
import type {
  PersistenceReceipt,
  QualificationOpen,
  RecoveredEvaluationEvidence,
  StoredEvaluationEvidence,
} from '../db/evidence-store'
import { canonicalHashV1Result } from '../hash'
import type { MarketDataInspection, MarketDataSnapshot } from '../market-data'
import {
  runQualificationPipeline,
  type QualificationLock,
  type QualificationPipelineFailure,
  type QualificationResult,
} from '../qualification'
import { prepareQualificationSeries } from '../qualification-statistics'
import { summarizeEvaluation } from '../risk-balanced-trend'
import type { Strategy } from '../strategy'
import type { EvaluationResult, ReconciliationResult } from '../types'
import type {
  EvaluationEvidence,
  PinnedQualificationDecision,
  PinnedQualificationFacts,
  QualificationPath,
  StartupCanonicalizationContext,
  StartupCanonicalizationInput,
  StartupCompletion,
  StartupDecisionFailure,
} from './model'

const canonicalStartupHash = (
  context: StartupCanonicalizationContext,
  value: unknown,
): Result.Result<string, StartupDecisionFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError(
      (cause): StartupDecisionFailure => ({
        _tag: 'CanonicalizationFailed',
        details: { ...context, cause },
      }),
    ),
  )

const validateCanonicalBinding = (
  left: StartupCanonicalizationInput,
  right: StartupCanonicalizationInput,
  mismatch: Extract<StartupDecisionFailure, { readonly _tag: 'BindingMismatch' }>,
): Result.Result<void, StartupDecisionFailure> => {
  const leftHash = canonicalStartupHash(left[0], left[1])
  if (Result.isFailure(leftHash)) return Result.fail(leftHash.failure)
  const rightHash = canonicalStartupHash(right[0], right[1])
  if (Result.isFailure(rightHash)) return Result.fail(rightHash.failure)
  return leftHash.success === rightHash.success ? Result.succeed(undefined) : Result.fail(mismatch)
}

const provenanceFromStored = (
  stored: StoredEvaluationEvidence,
): Result.Result<RuntimeProvenance, StartupDecisionFailure> => {
  const identity = {
    runId: stored.run.runId,
    strategyName: stored.protocol.strategyName,
    schemaVersion: stored.protocol.schemaVersion,
  }
  if (
    stored.protocol.strategyName !== 'risk-balanced-trend' ||
    (stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v2' &&
      stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v3' &&
      stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v4')
  ) {
    return Result.fail({
      _tag: 'StoredProvenanceInvalid',
      identity,
      issue: { reason: 'unsupported-contract' },
    })
  }
  const parameterSchemaVersion = stored.protocol.schemaVersion
  const provenanceResult = pipe(
    makeRuntimeProvenanceResult({
      sourceRevision: stored.run.sourceRevision,
      image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
      strategy: {
        name: 'risk-balanced-trend',
        behaviorHash: stored.protocol.behaviorHash,
        parameterHash: stored.protocol.parameterHash,
        parameterSchemaVersion,
      },
    }),
    Result.mapError(
      (cause): StartupDecisionFailure => ({
        _tag: 'StoredProvenanceInvalid',
        identity,
        issue: { reason: 'malformed', cause: cause.cause },
      }),
    ),
  )
  if (Result.isFailure(provenanceResult)) return provenanceResult
  const provenance = provenanceResult.success
  const parameterHashResult = canonicalStartupHash(
    { target: 'stored-protocol-parameters', side: 'stored' },
    stored.protocol.parameters,
  )
  if (Result.isFailure(parameterHashResult)) return Result.fail(parameterHashResult.failure)
  const protocolHash = makeStrategyProtocolHash(provenance.strategy)
  if (
    parameterHashResult.success !== provenance.strategy.parameterHash ||
    stored.protocol.protocolHash !== protocolHash ||
    stored.run.protocolHash !== stored.protocol.protocolHash
  ) {
    return Result.fail({
      _tag: 'StoredProvenanceInvalid',
      identity,
      issue: {
        reason: 'protocol-mismatch',
        stored: {
          parameterHash: stored.protocol.parameterHash,
          protocolHash: stored.protocol.protocolHash,
          runProtocolHash: stored.run.protocolHash,
        },
        computed: {
          parameterHash: parameterHashResult.success,
          protocolHash,
        },
      },
    })
  }
  return Result.succeed(provenance)
}

export const decidePinnedQualification = (
  config: RuntimeConfig,
  runId: string,
  facts: PinnedQualificationFacts,
): Result.Result<PinnedQualificationDecision, StartupDecisionFailure> => {
  if (Option.isNone(facts.stored)) {
    return Result.fail({
      _tag: 'QualificationStateInvalid',
      details: { reason: 'evidence-missing', phase: 'read-pinned', runId },
    })
  }
  if (Option.isNone(facts.qualification) || facts.qualification.value.state !== 'TERMINAL') {
    return Result.fail({
      _tag: 'QualificationStateInvalid',
      details: {
        reason: 'pinned-not-terminal',
        runId,
        observedState: Option.isNone(facts.qualification) ? 'MISSING' : 'OPENED_INCOMPLETE',
      },
    })
  }
  const stored = facts.stored.value
  const qualification = facts.qualification.value
  const provenanceResult = provenanceFromStored(stored)
  if (Result.isFailure(provenanceResult)) return Result.fail(provenanceResult.failure)
  const executionProvenance = provenanceResult.success
  if (stored.run.runId !== runId || qualification.result.runId !== runId) {
    return Result.fail({
      _tag: 'BindingMismatch',
      details: {
        binding: 'pinned-run',
        expectedRunId: runId,
        storedRunId: stored.run.runId,
        qualificationRunId: qualification.result.runId,
      },
    })
  }
  const expectedLock = {
    candidateRunId: runId,
    protocolHash: stored.run.protocolHash,
    sourceRevision: executionProvenance.sourceRevision,
    image: executionProvenance.image,
  }
  const observedLock = {
    candidateRunId: qualification.lock.candidateRunId,
    protocolHash: qualification.lock.protocolHash,
    sourceRevision: qualification.lock.sourceRevision,
    image: qualification.lock.image,
  }
  const lockBinding = validateCanonicalBinding(
    [{ target: 'pinned-lock', side: 'lock' }, observedLock],
    [{ target: 'pinned-lock', side: 'runtime' }, expectedLock],
    {
      _tag: 'BindingMismatch',
      details: { binding: 'pinned-lock', expected: expectedLock, observed: observedLock },
    },
  )
  if (Result.isFailure(lockBinding)) return Result.fail(lockBinding.failure)
  const expectedSnapshot = {
    snapshotId: config.clickhouse.snapshotId,
    lastSession: config.clickhouse.publicationAsOf,
    calendarVersion: config.clickhouse.calendarVersion,
    bounds: config.clickhouse.bounds,
  }
  const observedSnapshot = {
    snapshotId: qualification.lock.data.snapshotId,
    lastSession: qualification.lock.data.lastSession,
    calendarVersion: qualification.lock.data.calendarVersion,
    bounds: qualification.lock.data.bounds,
  }
  const snapshotBinding = validateCanonicalBinding(
    [{ target: 'pinned-snapshot', side: 'lock' }, observedSnapshot],
    [{ target: 'pinned-snapshot', side: 'configured' }, expectedSnapshot],
    {
      _tag: 'BindingMismatch',
      details: { binding: 'pinned-snapshot', expected: expectedSnapshot, observed: observedSnapshot },
    },
  )
  if (Result.isFailure(snapshotBinding)) return Result.fail(snapshotBinding.failure)
  return Result.succeed({
    _tag: 'RecoverPinned',
    executionProvenance,
    qualification,
  })
}

export const decidePinnedRecovery = (
  decision: PinnedQualificationDecision,
  recovered: Option.Option<RecoveredEvaluationEvidence>,
): Result.Result<StartupCompletion, StartupDecisionFailure> => {
  const runId = decision.qualification.result.runId
  const recoveredResult = validateRecoveredEvaluation(
    {
      phase: 'pinned',
      missingRunId: runId,
      expectedRunId: runId,
      expectedVerdict: decision.qualification.result.evaluationVerdict,
    },
    recovered,
  )
  if (Result.isFailure(recoveredResult)) return Result.fail(recoveredResult.failure)
  const evidence = recoveredResult.success
  return Result.succeed({
    _tag: 'PinnedRecovered',
    evidence: {
      startupMode: 'pinned',
      provenance: decision.executionProvenance,
      evaluation: evidence.evaluation,
      reconciliation: evidence.reconciliation,
      persistence: evidence.persistence,
      qualification: decision.qualification.result,
    },
  })
}

export const prepareQualificationLock = (
  strategy: Strategy,
  inspection: MarketDataInspection,
  priorTrialRunIds: readonly string[],
): Result.Result<QualificationLock, StartupDecisionFailure> =>
  Result.mapError(
    strategy.prepareLock(inspection.manifest, inspection.sessionDates, priorTrialRunIds),
    (cause): StartupDecisionFailure => ({
      _tag: 'StrategyOperationFailed',
      operation: 'prepare-lock',
      strategyName: strategy.name,
      cause,
    }),
  )

export const decideQualificationPath = (
  expectedLock: QualificationLock,
  opened: QualificationOpen,
): Result.Result<QualificationPath, StartupDecisionFailure> => {
  if (opened.state === 'OPENED_INCOMPLETE') {
    return Result.fail({
      _tag: 'QualificationStateInvalid',
      details: { reason: 'opened-incomplete', lockId: opened.lock.lockId },
    })
  }
  const lockBinding = validateCanonicalBinding(
    [{ target: 'qualification-lock', side: 'expected' }, expectedLock],
    [{ target: 'qualification-lock', side: 'observed' }, opened.lock],
    {
      _tag: 'BindingMismatch',
      details: {
        binding: 'qualification-lock',
        expected: expectedLock,
        observed: opened.lock,
      },
    },
  )
  if (Result.isFailure(lockBinding)) return Result.fail(lockBinding.failure)
  if (opened.state === 'ACQUIRED') return Result.succeed({ _tag: 'EvaluateAcquired' })
  if (opened.lock.candidateRunId !== opened.result.runId) {
    return Result.fail({
      _tag: 'BindingMismatch',
      details: {
        binding: 'terminal-run',
        terminalRunId: opened.lock.candidateRunId,
        qualificationRunId: opened.result.runId,
      },
    })
  }
  return Result.succeed({
    _tag: 'RecoverTerminal',
    runId: opened.lock.candidateRunId,
    result: opened.result,
  })
}

interface RecoveryExpectation {
  readonly phase: 'pinned' | 'terminal'
  readonly missingRunId: string
  readonly expectedRunId: string
  readonly expectedVerdict: QualificationResult['evaluationVerdict']
}

const validateRecoveredEvaluation = (
  expectation: RecoveryExpectation,
  recovered: Option.Option<RecoveredEvaluationEvidence>,
): Result.Result<RecoveredEvaluationEvidence, StartupDecisionFailure> => {
  if (Option.isNone(recovered)) {
    return Result.fail({
      _tag: 'QualificationStateInvalid',
      details: {
        reason: 'evidence-missing',
        phase: expectation.phase === 'pinned' ? 'recover-pinned' : 'recover-terminal',
        runId: expectation.missingRunId,
      },
    })
  }
  const evidence = recovered.value
  const mismatch: StartupDecisionFailure = {
    _tag: 'BindingMismatch',
    details: {
      binding: 'recovery',
      phase: expectation.phase,
      expectedRunId: expectation.expectedRunId,
      recoveredRunIds: {
        evaluation: evidence.evaluation.runId,
        reconciliation: evidence.reconciliation.runId,
        persistence: evidence.persistence.runId,
      },
      expectedVerdict: expectation.expectedVerdict,
      recoveredVerdict: evidence.evaluation.verdict,
    },
  }
  const runMatches =
    evidence.evaluation.runId === expectation.expectedRunId &&
    evidence.reconciliation.runId === expectation.expectedRunId &&
    evidence.persistence.runId === expectation.expectedRunId
  if (!runMatches) return Result.fail(mismatch)
  const verdictBinding = validateCanonicalBinding(
    [
      {
        target: expectation.phase === 'pinned' ? 'pinned-verdict' : 'terminal-verdict',
        side: 'qualification',
      },
      expectation.expectedVerdict,
    ],
    [
      {
        target: expectation.phase === 'pinned' ? 'pinned-verdict' : 'terminal-verdict',
        side: 'recovered',
      },
      evidence.evaluation.verdict,
    ],
    mismatch,
  )
  return Result.isFailure(verdictBinding) ? Result.fail(verdictBinding.failure) : Result.succeed(evidence)
}

export const decideTerminalRecovery = (
  provenance: RuntimeProvenance,
  path: Extract<QualificationPath, { readonly _tag: 'RecoverTerminal' }>,
  recovered: Option.Option<RecoveredEvaluationEvidence>,
): Result.Result<StartupCompletion, StartupDecisionFailure> => {
  if (path.runId !== path.result.runId) {
    return Result.fail({
      _tag: 'BindingMismatch',
      details: {
        binding: 'terminal-run',
        terminalRunId: path.runId,
        qualificationRunId: path.result.runId,
      },
    })
  }
  const runId = path.runId
  const recoveredResult = validateRecoveredEvaluation(
    {
      phase: 'terminal',
      missingRunId: runId,
      expectedRunId: runId,
      expectedVerdict: path.result.evaluationVerdict,
    },
    recovered,
  )
  if (Result.isFailure(recoveredResult)) return Result.fail(recoveredResult.failure)
  const evidence = recoveredResult.success
  return Result.succeed({
    _tag: 'TerminalRecovered',
    evidence: {
      startupMode: 'recovered',
      provenance,
      evaluation: evidence.evaluation,
      reconciliation: evidence.reconciliation,
      persistence: evidence.persistence,
      qualification: path.result,
    },
  })
}

export const evaluateLockedSnapshot = (
  strategy: Strategy,
  inspection: MarketDataInspection,
  lock: QualificationLock,
  snapshot: MarketDataSnapshot,
): Result.Result<EvaluationResult, StartupDecisionFailure> => {
  const inspectedManifestHashResult = canonicalStartupHash(
    { target: 'locked-manifest', side: 'inspection' },
    inspection.manifest,
  )
  if (Result.isFailure(inspectedManifestHashResult)) return Result.fail(inspectedManifestHashResult.failure)
  const loadedManifestHashResult = canonicalStartupHash(
    { target: 'locked-manifest', side: 'loaded' },
    snapshot.manifest,
  )
  if (Result.isFailure(loadedManifestHashResult)) return Result.fail(loadedManifestHashResult.failure)
  if (loadedManifestHashResult.success !== inspectedManifestHashResult.success) {
    return Result.fail({
      _tag: 'BindingMismatch',
      details: {
        binding: 'locked-manifest',
        inspectedManifestHash: inspectedManifestHashResult.success,
        loadedManifestHash: loadedManifestHashResult.success,
      },
    })
  }
  const evaluationResult = strategy.evaluate(snapshot.bars, snapshot.manifest)
  if (Result.isFailure(evaluationResult)) {
    return Result.fail({
      _tag: 'StrategyOperationFailed',
      operation: 'evaluate',
      strategyName: strategy.name,
      cause: evaluationResult.failure,
    })
  }
  if (evaluationResult.success.runId !== lock.candidateRunId) {
    return Result.fail({
      _tag: 'BindingMismatch',
      details: {
        binding: 'evaluation-run',
        lockedRunId: lock.candidateRunId,
        evaluationRunId: evaluationResult.success.runId,
      },
    })
  }
  return Result.succeed(evaluationResult.success)
}

const qualificationPipelineFailure = (
  strategyName: string,
  cause: QualificationPipelineFailure,
): StartupDecisionFailure => {
  switch (cause._tag) {
    case 'QualificationCanonicalizationFailed':
    case 'QualificationSchemaInvalid':
    case 'QualificationRunIdMismatch':
    case 'QualificationPriorTrialLineageMismatch':
      return {
        _tag: 'StrategyOperationFailed',
        operation: 'qualify',
        strategyName,
        cause,
      }
    default:
      return {
        _tag: 'StrategyOperationFailed',
        operation: 'analyze',
        strategyName,
        cause,
      }
  }
}

export const qualifyEvaluation = (
  strategy: Strategy,
  lock: QualificationLock,
  evaluation: EvaluationResult,
  reconciliation: ReconciliationResult,
): Result.Result<EvaluationEvidence, StartupDecisionFailure> => {
  const seriesResult = pipe(
    prepareQualificationSeries(evaluation),
    Result.mapError(
      (cause): StartupDecisionFailure => ({
        _tag: 'StrategyOperationFailed',
        operation: 'analyze',
        strategyName: strategy.name,
        cause,
      }),
    ),
  )
  if (Result.isFailure(seriesResult)) return Result.fail(seriesResult.failure)
  const qualification = pipe(
    runQualificationPipeline({
      lock,
      evaluationVerdict: evaluation.verdict,
      series: seriesResult.success,
    }),
    Result.mapError((cause) => qualificationPipelineFailure(strategy.name, cause)),
  )
  return Result.isFailure(qualification)
    ? Result.fail(qualification.failure)
    : Result.succeed({ evaluation, reconciliation, qualification: qualification.success.result })
}

export const evaluatedCompletion = (
  strategy: Strategy,
  evidence: EvaluationEvidence,
  persistence: PersistenceReceipt,
): StartupCompletion => ({
  _tag: 'Evaluated',
  evidence: {
    startupMode: 'evaluated',
    provenance: strategy.provenance,
    evaluation: summarizeEvaluation(evidence.evaluation),
    reconciliation: evidence.reconciliation,
    persistence,
    qualification: evidence.qualification,
  },
  markedEquityDifferenceMicros: evidence.evaluation.markedEquityReconciliation.differenceMicros,
})
