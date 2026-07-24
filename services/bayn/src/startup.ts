import { Effect, Option, Ref, Result } from 'effect'

import type { RuntimeConfig } from './config'
import { makeRuntimeProvenance, makeStrategyProtocolHash, type RuntimeProvenance } from './contracts'
import {
  EvidenceStore,
  type EvidenceStoreService,
  type PersistenceReceipt,
  type QualificationOpen,
  type QualificationRecord,
  type RecoveredEvaluationEvidence,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { OperationalError, formatError, type Component } from './errors'
import { canonicalHashV1 } from './hash'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataInspection, type MarketDataService, type MarketDataSnapshot } from './market-data'
import { databaseOperation, withinDeadline } from './operations'
import { makeQualificationResult, type QualificationLock, type QualificationResult } from './qualification'
import { summarizeEvaluation } from './risk-balanced-trend'
import type { RuntimeEvidence, RuntimeState } from './runtime-state'
import type { Strategy } from './strategy'
import type { EvaluationResult, ReconciliationResult } from './types'

type TerminalQualificationRecord = Extract<QualificationRecord, { readonly state: 'TERMINAL' }>

interface StartupDependencies {
  readonly marketData: MarketDataService
  readonly journal: JournalService
  readonly evidenceStore: EvidenceStoreService
}

interface EvaluationWorkflow {
  readonly config: RuntimeConfig
  readonly strategy: Strategy
  readonly dependencies: StartupDependencies
}

interface CandidateQualification {
  readonly inspection: MarketDataInspection
  readonly lock: QualificationLock
}

type QualificationPath =
  | { readonly _tag: 'EvaluateAcquired' }
  | {
      readonly _tag: 'RecoverTerminal'
      readonly runId: string
      readonly result: QualificationResult
    }

interface EvaluationEvidence {
  readonly evaluation: EvaluationResult
  readonly reconciliation: ReconciliationResult
  readonly qualification: QualificationResult
}

interface PinnedQualificationFacts {
  readonly stored: Option.Option<StoredEvaluationEvidence>
  readonly qualification: Option.Option<QualificationRecord>
}

interface PinnedQualificationDecision {
  readonly _tag: 'RecoverPinned'
  readonly executionProvenance: RuntimeProvenance
  readonly qualification: TerminalQualificationRecord
}

type StartupCompletion =
  | {
      readonly _tag: 'PinnedRecovered'
      readonly evidence: RuntimeEvidence
    }
  | {
      readonly _tag: 'TerminalRecovered'
      readonly evidence: RuntimeEvidence
    }
  | {
      readonly _tag: 'Evaluated'
      readonly evidence: RuntimeEvidence
      readonly markedEquityDifferenceMicros: string
    }

type StartupCanonicalizationContext =
  | { readonly target: 'stored-protocol-parameters'; readonly side: 'stored' }
  | { readonly target: 'qualification-lock'; readonly side: 'expected' | 'observed' }
  | { readonly target: 'pinned-lock'; readonly side: 'lock' | 'runtime' }
  | { readonly target: 'pinned-snapshot'; readonly side: 'lock' | 'configured' }
  | { readonly target: 'pinned-verdict' | 'terminal-verdict'; readonly side: 'qualification' | 'recovered' }
  | { readonly target: 'locked-manifest'; readonly side: 'inspection' | 'loaded' }

type StartupCanonicalizationFailure = StartupCanonicalizationContext & { readonly cause: unknown }
type StartupCanonicalizationInput = readonly [context: StartupCanonicalizationContext, value: unknown]

type StartupQualificationFailure =
  | {
      readonly reason: 'evidence-missing'
      readonly phase: 'read-pinned' | 'recover-pinned' | 'recover-terminal'
      readonly runId: string
    }
  | {
      readonly reason: 'pinned-not-terminal'
      readonly runId: string
      readonly observedState: 'MISSING' | 'OPENED_INCOMPLETE'
    }
  | { readonly reason: 'opened-incomplete'; readonly lockId: string }

type StartupBindingMismatch =
  | {
      readonly binding: 'qualification-lock'
      readonly expected: QualificationLock
      readonly observed: QualificationLock
    }
  | {
      readonly binding: 'pinned-run'
      readonly expectedRunId: string
      readonly storedRunId: string
      readonly qualificationRunId: string
    }
  | {
      readonly binding: 'pinned-lock'
      readonly expected: {
        readonly candidateRunId: string
        readonly protocolHash: string
        readonly sourceRevision: string
        readonly image: RuntimeProvenance['image']
      }
      readonly observed: {
        readonly candidateRunId: string
        readonly protocolHash: string
        readonly sourceRevision: string
        readonly image: RuntimeProvenance['image']
      }
    }
  | {
      readonly binding: 'pinned-snapshot'
      readonly expected: {
        readonly snapshotId: string
        readonly lastSession: string
        readonly calendarVersion: string
        readonly bounds: RuntimeConfig['clickhouse']['bounds']
      }
      readonly observed: {
        readonly snapshotId: string
        readonly lastSession: string
        readonly calendarVersion: string
        readonly bounds: QualificationLock['data']['bounds']
      }
    }
  | {
      readonly binding: 'recovery'
      readonly phase: 'pinned' | 'terminal'
      readonly expectedRunId: string
      readonly recoveredRunIds: {
        readonly evaluation: string
        readonly reconciliation: string
        readonly persistence: string
      }
      readonly expectedVerdict: QualificationResult['evaluationVerdict']
      readonly recoveredVerdict: RecoveredEvaluationEvidence['evaluation']['verdict']
    }
  | {
      readonly binding: 'terminal-run'
      readonly terminalRunId: string
      readonly qualificationRunId: string
    }
  | {
      readonly binding: 'locked-manifest'
      readonly inspectedManifestHash: string
      readonly loadedManifestHash: string
    }
  | {
      readonly binding: 'evaluation-run'
      readonly lockedRunId: string
      readonly evaluationRunId: string
    }

export type StartupDecisionFailure =
  | {
      readonly _tag: 'StoredProvenanceInvalid'
      readonly identity: {
        readonly runId: string
        readonly strategyName: string
        readonly schemaVersion: string
      }
      readonly issue:
        | { readonly reason: 'unsupported-contract' }
        | { readonly reason: 'malformed'; readonly cause: unknown }
        | {
            readonly reason: 'protocol-mismatch'
            readonly stored: {
              readonly parameterHash: string
              readonly protocolHash: string
              readonly runProtocolHash: string
            }
            readonly computed: { readonly parameterHash: string; readonly protocolHash: string }
          }
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly details: StartupCanonicalizationFailure
    }
  | {
      readonly _tag: 'QualificationStateInvalid'
      readonly details: StartupQualificationFailure
    }
  | {
      readonly _tag: 'BindingMismatch'
      readonly details: StartupBindingMismatch
    }
  | {
      readonly _tag: 'StrategyOperationFailed'
      readonly operation: 'prepare-lock' | 'evaluate' | 'analyze' | 'qualify'
      readonly strategyName: string
      readonly cause: unknown
    }

const failStartupState = (current: RuntimeState, error: OperationalError): RuntimeState => ({
  ...current,
  status: 'FAILED',
  evidence: null,
  error: formatError(error),
})

const completeStartupState = (current: RuntimeState, completion: StartupCompletion): RuntimeState => ({
  ...current,
  evidence: completion.evidence,
  error: null,
})

const failStartup = (state: Ref.Ref<RuntimeState>, error: OperationalError): Effect.Effect<void> =>
  Effect.logError('Bayn startup failed').pipe(
    Effect.annotateLogs({
      service: 'bayn',
      component: error.component,
      operation: error.operation,
      error: error.message,
    }),
    Effect.andThen(Ref.update(state, (current) => failStartupState(current, error))),
  )

const causeMessage = (cause: unknown): string => {
  const rendered = Result.try({
    try: () => String(cause instanceof Error ? cause.message : cause),
    catch: () => undefined,
  })
  return Result.isSuccess(rendered) ? rendered.success : 'unrenderable cause'
}

interface StartupFailurePresentation {
  readonly component: Component
  readonly operation: string
  readonly message: string
}

const presentFailure = (component: Component, operation: string, message: string): StartupFailurePresentation => ({
  component,
  operation,
  message,
})

const renderCanonicalizationFailure = (
  failure: Extract<StartupDecisionFailure, { readonly _tag: 'CanonicalizationFailed' }>,
): StartupFailurePresentation => {
  const detail = causeMessage(failure.details.cause)
  switch (failure.details.target) {
    case 'stored-protocol-parameters':
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `stored qualification provenance is invalid: ${detail}`,
      )
    case 'qualification-lock':
      return presentFailure('database', 'open-qualification', `qualification lock binding failed: ${detail}`)
    case 'pinned-lock':
    case 'pinned-snapshot':
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `pinned qualification binding failed: ${detail}`,
      )
    case 'pinned-verdict':
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `pinned qualification recovery failed: ${detail}`,
      )
    case 'terminal-verdict':
      return presentFailure('database', 'recover-qualification', `qualification recovery failed: ${detail}`)
    case 'locked-manifest':
      return presentFailure('market-data', 'load-locked', `locked Signal load failed: ${detail}`)
  }
}

const startupFailurePresentation = (failure: StartupDecisionFailure): StartupFailurePresentation => {
  switch (failure._tag) {
    case 'StoredProvenanceInvalid': {
      const detail =
        failure.issue.reason === 'unsupported-contract'
          ? 'stored evaluation uses an unsupported strategy contract'
          : failure.issue.reason === 'malformed'
            ? causeMessage(failure.issue.cause)
            : 'stored evaluation protocol does not match its own provenance'
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `stored qualification provenance is invalid: ${detail}`,
      )
    }
    case 'CanonicalizationFailed':
      return renderCanonicalizationFailure(failure)
    case 'QualificationStateInvalid':
      switch (failure.details.reason) {
        case 'evidence-missing':
          return failure.details.phase === 'recover-terminal'
            ? presentFailure(
                'database',
                'recover-evaluation',
                `terminal qualification run ${failure.details.runId} is missing`,
              )
            : presentFailure(
                'database',
                failure.details.phase === 'read-pinned' ? 'read-pinned-qualification' : 'recover-pinned-qualification',
                `pinned evaluation ${failure.details.runId} is missing`,
              )
        case 'pinned-not-terminal':
          return presentFailure(
            'database',
            'read-pinned-qualification',
            `pinned qualification ${failure.details.runId} is not terminal`,
          )
        case 'opened-incomplete':
          return presentFailure(
            'database',
            'open-qualification',
            `qualification ${failure.details.lockId} was opened without a terminal result`,
          )
      }
    case 'BindingMismatch':
      switch (failure.details.binding) {
        case 'qualification-lock':
          return presentFailure(
            'database',
            'open-qualification',
            'qualification lock binding failed: store returned a different candidate lock',
          )
        case 'pinned-run':
          return presentFailure(
            'database',
            'recover-pinned-qualification',
            'pinned qualification binding failed: stored evaluation and terminal qualification run IDs differ',
          )
        case 'pinned-lock':
          return presentFailure(
            'database',
            'recover-pinned-qualification',
            'pinned qualification binding failed: qualification lock differs from the stored execution provenance',
          )
        case 'pinned-snapshot':
          return presentFailure(
            'database',
            'recover-pinned-qualification',
            'pinned qualification binding failed: configured Signal snapshot differs from the pinned qualification',
          )
        case 'recovery':
          return failure.details.phase === 'pinned'
            ? presentFailure(
                'database',
                'recover-pinned-qualification',
                'pinned qualification recovery failed: recovered evidence differs from the terminal qualification',
              )
            : presentFailure(
                'database',
                'recover-qualification',
                'qualification recovery failed: terminal qualification differs from the recovered evaluation',
              )
        case 'terminal-run':
          return presentFailure(
            'database',
            'recover-qualification',
            'qualification recovery failed: terminal lock and result run IDs differ',
          )
        case 'locked-manifest':
          return presentFailure(
            'market-data',
            'load-locked',
            'locked Signal load failed: loaded Signal manifest differs from the locked inspection',
          )
        case 'evaluation-run':
          return presentFailure('strategy', 'evaluate', 'evaluation run identity differs from the qualification lock')
      }
    case 'StrategyOperationFailed': {
      const label = {
        'prepare-lock': 'lock preparation',
        evaluate: 'evaluation',
        analyze: 'analysis',
        qualify: 'qualification',
      }[failure.operation]
      return presentFailure(
        'strategy',
        failure.operation,
        `${failure.strategyName} ${label} failed: ${causeMessage(failure.cause)}`,
      )
    }
  }
}

export const renderStartupDecisionFailure = (failure: StartupDecisionFailure): OperationalError =>
  new OperationalError({
    ...startupFailurePresentation(failure),
    retryable: false,
    cause: failure,
  })

const fromStartupDecision = <A>(
  decision: Result.Result<A, StartupDecisionFailure>,
): Effect.Effect<A, OperationalError> => Effect.fromResult(decision).pipe(Effect.mapError(renderStartupDecisionFailure))

const canonicalStartupHash = (
  context: StartupCanonicalizationContext,
  value: unknown,
): Result.Result<string, StartupDecisionFailure> =>
  Result.try({
    try: () => canonicalHashV1(value),
    catch: (cause): StartupDecisionFailure => ({
      _tag: 'CanonicalizationFailed',
      details: { ...context, cause },
    }),
  })

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
      stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v3')
  ) {
    return Result.fail({
      _tag: 'StoredProvenanceInvalid',
      identity,
      issue: { reason: 'unsupported-contract' },
    })
  }
  const parameterSchemaVersion =
    stored.protocol.schemaVersion === 'bayn.risk-balanced-trend.protocol.v2'
      ? 'bayn.risk-balanced-trend.protocol.v2'
      : 'bayn.risk-balanced-trend.protocol.v3'
  const provenanceResult = Result.try({
    try: () =>
      makeRuntimeProvenance({
        sourceRevision: stored.run.sourceRevision,
        image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
        strategy: {
          name: 'risk-balanced-trend',
          behaviorHash: stored.protocol.behaviorHash,
          parameterHash: stored.protocol.parameterHash,
          parameterSchemaVersion,
        },
      }),
    catch: (cause): StartupDecisionFailure => ({
      _tag: 'StoredProvenanceInvalid',
      identity,
      issue: { reason: 'malformed', cause },
    }),
  })
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

const prepareQualificationLock = (
  strategy: Strategy,
  inspection: MarketDataInspection,
  priorTrialRunIds: readonly string[],
): Result.Result<QualificationLock, StartupDecisionFailure> =>
  Result.try({
    try: () => strategy.prepareLock(inspection.manifest, inspection.sessionDates, priorTrialRunIds),
    catch: (cause): StartupDecisionFailure => ({
      _tag: 'StrategyOperationFailed',
      operation: 'prepare-lock',
      strategyName: strategy.name,
      cause,
    }),
  })

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
  const evaluationResult = Result.try({
    try: () => strategy.evaluate(snapshot.bars, snapshot.manifest),
    catch: (cause): StartupDecisionFailure => ({
      _tag: 'StrategyOperationFailed',
      operation: 'evaluate',
      strategyName: strategy.name,
      cause,
    }),
  })
  if (Result.isFailure(evaluationResult)) return evaluationResult
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
  return evaluationResult
}

export const qualifyEvaluation = (
  strategy: Strategy,
  lock: QualificationLock,
  evaluation: EvaluationResult,
  reconciliation: ReconciliationResult,
): Result.Result<EvaluationEvidence, StartupDecisionFailure> => {
  const analysisResult = Result.try({
    try: () => strategy.analyze(evaluation, lock.priorTrialRunIds),
    catch: (cause): StartupDecisionFailure => ({
      _tag: 'StrategyOperationFailed',
      operation: 'analyze',
      strategyName: strategy.name,
      cause,
    }),
  })
  if (Result.isFailure(analysisResult)) return Result.fail(analysisResult.failure)
  const qualificationResult = Result.try({
    try: () => makeQualificationResult(lock, evaluation.verdict, analysisResult.success),
    catch: (cause): StartupDecisionFailure => ({
      _tag: 'StrategyOperationFailed',
      operation: 'qualify',
      strategyName: strategy.name,
      cause,
    }),
  })
  return Result.isFailure(qualificationResult)
    ? Result.fail(qualificationResult.failure)
    : Result.succeed({ evaluation, reconciliation, qualification: qualificationResult.success })
}

const evaluatedCompletion = (
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

const readPinnedQualification = (
  config: RuntimeConfig,
  runId: string,
  evidenceStore: EvidenceStoreService,
): Effect.Effect<PinnedQualificationFacts, OperationalError> =>
  withinDeadline(
    databaseOperation(
      Effect.all({
        stored: evidenceStore.read(runId),
        qualification: evidenceStore.readQualification(runId),
      }),
      'read-pinned-qualification',
    ),
    config.operationTimeoutMs,
    'database',
    'read-pinned-qualification',
  )

const checkStartupDependencies = (workflow: EvaluationWorkflow): Effect.Effect<void, OperationalError> =>
  withinDeadline(
    workflow.dependencies.journal.check,
    workflow.config.operationTimeoutMs,
    'journal',
    'connectivity-check',
  ).pipe(
    Effect.andThen(
      withinDeadline(
        databaseOperation(workflow.dependencies.evidenceStore.check, 'health-check'),
        workflow.config.operationTimeoutMs,
        'database',
        'health-check',
      ),
    ),
  )

const inspectSignalSnapshot = (workflow: EvaluationWorkflow): Effect.Effect<MarketDataInspection, OperationalError> =>
  withinDeadline(
    workflow.dependencies.marketData.inspect,
    workflow.config.operationTimeoutMs,
    'market-data',
    'inspect',
  ).pipe(
    Effect.tap((inspection) =>
      Effect.logInfo('Bayn signal snapshot inspected').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          inputManifestHash: inspection.manifest.hash,
          rowCount: inspection.manifest.rowCount,
        }),
      ),
    ),
  )

const prepareQualification = (
  workflow: EvaluationWorkflow,
  inspection: MarketDataInspection,
): Effect.Effect<CandidateQualification, OperationalError> =>
  withinDeadline(
    databaseOperation(workflow.dependencies.evidenceStore.listPriorTrials, 'list-prior-trials'),
    workflow.config.operationTimeoutMs,
    'database',
    'list-prior-trials',
  ).pipe(
    Effect.flatMap((priorTrialRunIds) =>
      fromStartupDecision(prepareQualificationLock(workflow.strategy, inspection, priorTrialRunIds)),
    ),
    Effect.map((lock) => ({ inspection, lock })),
  )

const openQualification = (
  workflow: EvaluationWorkflow,
  candidate: CandidateQualification,
): Effect.Effect<QualificationPath, OperationalError> =>
  withinDeadline(
    databaseOperation(
      workflow.dependencies.evidenceStore.openQualification({
        lock: candidate.lock,
        inputManifest: candidate.inspection.manifest,
        parameters: workflow.strategy.parameters,
        provenance: workflow.strategy.provenance,
      }),
      'open-qualification',
    ),
    workflow.config.operationTimeoutMs,
    'database',
    'open-qualification',
  ).pipe(Effect.flatMap((opened) => fromStartupDecision(decideQualificationPath(candidate.lock, opened))))

const recoverTerminalQualification = (
  workflow: EvaluationWorkflow,
  path: Extract<QualificationPath, { readonly _tag: 'RecoverTerminal' }>,
): Effect.Effect<StartupCompletion, OperationalError> =>
  withinDeadline(
    databaseOperation(
      workflow.dependencies.evidenceStore.recover(path.runId, workflow.strategy.provenance),
      'recover-evaluation',
    ),
    workflow.config.operationTimeoutMs,
    'database',
    'recover-evaluation',
  ).pipe(
    Effect.flatMap((recovered) =>
      fromStartupDecision(decideTerminalRecovery(workflow.strategy.provenance, path, recovered)),
    ),
  )

const loadAndEvaluate = (
  workflow: EvaluationWorkflow,
  candidate: CandidateQualification,
): Effect.Effect<EvaluationResult, OperationalError> =>
  withinDeadline(workflow.dependencies.marketData.load, workflow.config.operationTimeoutMs, 'market-data', 'load').pipe(
    Effect.flatMap((snapshot) =>
      fromStartupDecision(evaluateLockedSnapshot(workflow.strategy, candidate.inspection, candidate.lock, snapshot)),
    ),
    Effect.tap((evaluation) =>
      Effect.logInfo('Bayn strategy evaluation completed').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: evaluation.runId,
          strategy: workflow.strategy.name,
          verdict: evaluation.verdict.status,
          eventCount: evaluation.events.length,
        }),
      ),
    ),
  )

const persistEvaluation = (
  workflow: EvaluationWorkflow,
  candidate: CandidateQualification,
  evidence: EvaluationEvidence,
): Effect.Effect<StartupCompletion, OperationalError> =>
  withinDeadline(
    databaseOperation(
      workflow.dependencies.evidenceStore.persist({
        provenance: workflow.strategy.provenance,
        parameters: workflow.strategy.parameters,
        evaluation: evidence.evaluation,
        reconciliation: evidence.reconciliation,
        qualification: { lock: candidate.lock, result: evidence.qualification },
      }),
      'persist-evaluation',
    ),
    workflow.config.operationTimeoutMs,
    'database',
    'persist-evaluation',
  ).pipe(Effect.map((persistence) => evaluatedCompletion(workflow.strategy, evidence, persistence)))

const evaluateAcquiredQualification = (
  workflow: EvaluationWorkflow,
  candidate: CandidateQualification,
): Effect.Effect<StartupCompletion, OperationalError> =>
  loadAndEvaluate(workflow, candidate).pipe(
    Effect.flatMap((evaluation) =>
      withinDeadline(
        workflow.dependencies.journal.journalAndReconcile(evaluation),
        workflow.config.operationTimeoutMs,
        'journal',
        'journal-and-reconcile',
      ).pipe(
        Effect.flatMap((reconciliation) =>
          fromStartupDecision(qualifyEvaluation(workflow.strategy, candidate.lock, evaluation, reconciliation)),
        ),
      ),
    ),
    Effect.flatMap((evidence) => persistEvaluation(workflow, candidate, evidence)),
  )

const runQualificationPath = (
  workflow: EvaluationWorkflow,
  candidate: CandidateQualification,
  path: QualificationPath,
): Effect.Effect<StartupCompletion, OperationalError> =>
  path._tag === 'RecoverTerminal'
    ? recoverTerminalQualification(workflow, path)
    : evaluateAcquiredQualification(workflow, candidate)

const logStartupCompletion = (completion: StartupCompletion): Effect.Effect<void> => {
  switch (completion._tag) {
    case 'PinnedRecovered':
      return Effect.logInfo('Bayn pinned qualification recovered').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: completion.evidence.evaluation.runId,
          qualification: completion.evidence.qualification.verdict,
          executionSourceRevision: completion.evidence.provenance.sourceRevision,
          executionImageDigest: completion.evidence.provenance.image.digest,
        }),
      )
    case 'TerminalRecovered':
      return Effect.logInfo('Bayn startup proof recovered').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: completion.evidence.evaluation.runId,
          qualification: completion.evidence.qualification.verdict,
          artifactCount: completion.evidence.persistence.artifactCount,
          eventCount: completion.evidence.persistence.eventCount,
          gateCount: completion.evidence.persistence.gateCount,
        }),
      )
    case 'Evaluated':
      return Effect.logInfo('Bayn startup proof is durable').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: completion.evidence.evaluation.runId,
          accountCount: completion.evidence.reconciliation.accountCount,
          transferCount: completion.evidence.reconciliation.transferCount,
          persistenceDeduplicated: completion.evidence.persistence.deduplicated,
          qualification: completion.evidence.qualification.verdict,
          qualificationResultHash: completion.evidence.qualification.resultHash,
          markedEquityDifferenceMicros: completion.markedEquityDifferenceMicros,
        }),
      )
  }
}

const publishStartupCompletion = (state: Ref.Ref<RuntimeState>, completion: StartupCompletion): Effect.Effect<void> =>
  Ref.update(state, (current) => completeStartupState(current, completion)).pipe(
    Effect.andThen(logStartupCompletion(completion)),
  )

const recoverPinnedQualification = (
  config: RuntimeConfig,
  runId: string,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, EvidenceStore> =>
  EvidenceStore.pipe(
    Effect.tap(() =>
      Effect.logInfo('Bayn pinned qualification recovery started').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId,
          currentSourceRevision: config.build.sourceRevision,
          currentImageDigest: config.build.imageDigest,
        }),
      ),
    ),
    Effect.flatMap((evidenceStore) =>
      readPinnedQualification(config, runId, evidenceStore).pipe(
        Effect.flatMap((facts) => fromStartupDecision(decidePinnedQualification(config, runId, facts))),
        Effect.flatMap((decision) =>
          withinDeadline(
            databaseOperation(
              evidenceStore.recover(runId, decision.executionProvenance),
              'recover-pinned-qualification',
            ),
            config.operationTimeoutMs,
            'database',
            'recover-pinned-qualification',
          ).pipe(Effect.flatMap((recovered) => fromStartupDecision(decidePinnedRecovery(decision, recovered)))),
        ),
      ),
    ),
    Effect.flatMap((completion) => publishStartupCompletion(state, completion)),
    Effect.withLogSpan('startup'),
  )

const runEvaluationWorkflow = (workflow: EvaluationWorkflow): Effect.Effect<StartupCompletion, OperationalError> =>
  checkStartupDependencies(workflow).pipe(
    Effect.andThen(inspectSignalSnapshot(workflow)),
    Effect.flatMap((inspection) => prepareQualification(workflow, inspection)),
    Effect.flatMap((candidate) =>
      openQualification(workflow, candidate).pipe(
        Effect.flatMap((path) => runQualificationPath(workflow, candidate, path)),
      ),
    ),
  )

const evaluateAndJournal = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  strategy: Strategy,
): Effect.Effect<void, OperationalError, MarketData | Journal | EvidenceStore> =>
  Effect.all({
    marketData: MarketData,
    journal: Journal,
    evidenceStore: EvidenceStore,
  }).pipe(
    Effect.map(
      (dependencies): EvaluationWorkflow => ({
        config,
        strategy,
        dependencies,
      }),
    ),
    Effect.tap(() =>
      Effect.logInfo('Bayn startup evaluation started').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          sourceRevision: config.build.sourceRevision,
          imageDigest: config.build.imageDigest,
          strategyBehaviorHash: strategy.provenance.strategy.behaviorHash,
          parameterHash: strategy.provenance.strategy.parameterHash,
          snapshotId: config.clickhouse.snapshotId,
          evaluationStart: config.clickhouse.bounds.evaluationStart,
          evaluationEnd: config.clickhouse.bounds.evaluationEnd,
        }),
      ),
    ),
    Effect.flatMap(runEvaluationWorkflow),
    Effect.flatMap((completion) => publishStartupCompletion(state, completion)),
    Effect.withLogSpan('startup'),
  )

export const initialize = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  strategy: Strategy,
): Effect.Effect<void, OperationalError, MarketData | Journal | EvidenceStore> =>
  (config.qualificationRunId === undefined
    ? evaluateAndJournal(config, state, strategy)
    : recoverPinnedQualification(config, config.qualificationRunId, state)
  ).pipe(Effect.catch((error) => (error.retryable ? Effect.fail(error) : failStartup(state, error))))
