import { Effect, Ref, Result } from 'effect'

import type { RuntimeConfig } from '../config'
import type { EvidenceStoreService } from '../db/evidence-store'
import { OperationalError, formatError } from '../errors'
import type { MarketDataInspection } from '../market-data'
import { databaseOperation, withinDeadline } from '../operations'
import type { RuntimeState } from '../runtime-state'
import type { StrategyRuntime } from '../strategy'
import type { EvaluationResult } from '../types'
import {
  decidePinnedQualification,
  decidePinnedRecovery,
  decideQualificationPath,
  decideTerminalRecovery,
  evaluateLockedSnapshot,
  evaluatedCompletion,
  prepareQualificationLock,
  qualifyEvaluation,
} from './decisions'
import type {
  CandidateQualification,
  EvaluationEvidence,
  EvaluationWorkflow,
  PinnedQualificationFacts,
  QualificationPath,
  StartupDependencies,
  StartupCompletion,
  StartupDecisionFailure,
} from './model'
import { renderStartupDecisionFailure } from './presentation'
import { Pipeable } from '../pipeable'

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

const fromStartupDecision = <A>(
  decision: Result.Result<A, StartupDecisionFailure>,
): Effect.Effect<A, OperationalError> => Effect.fromResult(decision).pipe(Effect.mapError(renderStartupDecisionFailure))

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
      fromStartupDecision(
        prepareQualificationLock(workflow.strategy, workflow.strategy.provenance, inspection, priorTrialRunIds),
      ),
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
        parameters: workflow.strategy.definition.parameters,
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
      fromStartupDecision(
        evaluateLockedSnapshot(
          workflow.strategy,
          workflow.strategy.provenance,
          candidate.inspection,
          candidate.lock,
          snapshot,
        ),
      ),
    ),
    Effect.tap((evaluation) =>
      Effect.logInfo('Bayn strategy evaluation completed').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: evaluation.runId,
          strategy: workflow.strategy.definition.name,
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
        parameters: workflow.strategy.definition.parameters,
        evaluation: evidence.evaluation,
        reconciliation: evidence.reconciliation,
        qualification: { lock: candidate.lock, result: evidence.qualification },
      }),
      'persist-evaluation',
    ),
    workflow.config.operationTimeoutMs,
    'database',
    'persist-evaluation',
  ).pipe(Effect.map((persistence) => evaluatedCompletion(workflow.strategy.provenance, evidence, persistence)))

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
  evidenceStore: EvidenceStoreService,
): Effect.Effect<void, OperationalError> =>
  Effect.logInfo('Bayn pinned qualification recovery started').pipe(
    Effect.annotateLogs({
      service: 'bayn',
      runId,
      currentSourceRevision: config.build.sourceRevision,
      currentImageDigest: config.build.imageDigest,
    }),
    Effect.andThen(
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

const logEvaluationStart = (config: RuntimeConfig, strategy: StrategyRuntime): Effect.Effect<void> =>
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
  strategy: StrategyRuntime,
  dependencies: StartupDependencies,
): Effect.Effect<void, OperationalError> =>
  logEvaluationStart(config, strategy).pipe(
    Effect.andThen(runEvaluationWorkflow({ config, strategy, dependencies })),
    Effect.flatMap((completion) => publishStartupCompletion(state, completion)),
    Effect.withLogSpan('startup'),
  )

const runStartupDataFirst = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  strategy: StrategyRuntime,
  dependencies: StartupDependencies,
): Effect.Effect<void, OperationalError> =>
  (config.qualificationRunId === undefined
    ? evaluateAndJournal(config, state, strategy, dependencies)
    : recoverPinnedQualification(config, config.qualificationRunId, state, dependencies.evidenceStore)
  ).pipe(Effect.catch((error) => (error.retryable ? Effect.fail(error) : failStartup(state, error))))

export const runStartup = Pipeable.dual(4, runStartupDataFirst)
