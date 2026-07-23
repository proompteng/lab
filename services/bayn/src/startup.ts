import { Effect, Option, Ref } from 'effect'

import type { RuntimeConfig } from './config'
import { makeRuntimeProvenance, makeStrategyProtocolHash, type RuntimeProvenance } from './contracts'
import { EvidenceStore, type StoredEvaluationEvidence } from './db/evidence-store'
import { formatError, operationalError, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { databaseOperation, withinDeadline } from './operations'
import { makeQualificationResult } from './qualification'
import { summarizeEvaluation } from './risk-balanced-trend'
import type { RuntimeState } from './runtime-state'
import type { Strategy } from './strategy'

const failStartup = (state: Ref.Ref<RuntimeState>, error: OperationalError): Effect.Effect<void> =>
  Effect.logError('Bayn startup failed').pipe(
    Effect.annotateLogs({
      service: 'bayn',
      component: error.component,
      operation: error.operation,
      error: error.message,
    }),
    Effect.andThen(
      Ref.update(
        state,
        (current): RuntimeState => ({
          ...current,
          status: 'FAILED',
          evidence: null,
          error: formatError(error),
        }),
      ),
    ),
  )

const provenanceFromStored = (stored: StoredEvaluationEvidence): RuntimeProvenance => {
  if (
    stored.protocol.strategyName !== 'risk-balanced-trend' ||
    (stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v2' &&
      stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v3')
  ) {
    throw new Error('stored evaluation uses an unsupported strategy contract')
  }
  const provenance = makeRuntimeProvenance({
    sourceRevision: stored.run.sourceRevision,
    image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
    strategy: {
      name: stored.protocol.strategyName,
      behaviorHash: stored.protocol.behaviorHash,
      parameterHash: stored.protocol.parameterHash,
      parameterSchemaVersion: stored.protocol.schemaVersion,
    },
  })
  if (
    canonicalHashV1(stored.protocol.parameters) !== provenance.strategy.parameterHash ||
    stored.protocol.protocolHash !== makeStrategyProtocolHash(provenance.strategy) ||
    stored.run.protocolHash !== stored.protocol.protocolHash
  ) {
    throw new Error('stored evaluation protocol does not match its own provenance')
  }
  return provenance
}

const recoverPinnedQualification = (
  config: RuntimeConfig,
  runId: string,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, EvidenceStore> =>
  Effect.gen(function* () {
    const evidenceStore = yield* EvidenceStore
    yield* Effect.logInfo('Bayn pinned qualification recovery started').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId,
        currentSourceRevision: config.build.sourceRevision,
        currentImageDigest: config.build.imageDigest,
      }),
    )
    const [storedOption, qualificationOption] = yield* withinDeadline(
      databaseOperation(
        Effect.all([evidenceStore.read(runId), evidenceStore.readQualification(runId)]),
        'read-pinned-qualification',
      ),
      config.operationTimeoutMs,
      'database',
      'read-pinned-qualification',
    )
    if (Option.isNone(storedOption)) {
      return yield* Effect.fail(
        operationalError('database', 'read-pinned-qualification', `pinned evaluation ${runId} is missing`),
      )
    }
    if (Option.isNone(qualificationOption) || qualificationOption.value.state !== 'TERMINAL') {
      return yield* Effect.fail(
        operationalError('database', 'read-pinned-qualification', `pinned qualification ${runId} is not terminal`),
      )
    }
    const stored = storedOption.value
    const qualification = qualificationOption.value
    const executionProvenance = yield* Effect.try({
      try: () => provenanceFromStored(stored),
      catch: (cause) =>
        operationalError(
          'database',
          'recover-pinned-qualification',
          'stored qualification provenance is invalid',
          cause,
        ),
    })
    yield* Effect.try({
      try: () => {
        if (stored.run.runId !== runId || qualification.result.runId !== runId) {
          throw new Error('stored evaluation and terminal qualification run IDs differ')
        }
        if (
          qualification.lock.candidateRunId !== runId ||
          qualification.lock.protocolHash !== stored.run.protocolHash ||
          qualification.lock.sourceRevision !== executionProvenance.sourceRevision ||
          canonicalHashV1(qualification.lock.image) !== canonicalHashV1(executionProvenance.image)
        ) {
          throw new Error('qualification lock differs from the stored execution provenance')
        }
        if (
          qualification.lock.data.snapshotId !== config.clickhouse.snapshotId ||
          qualification.lock.data.lastSession !== config.clickhouse.publicationAsOf ||
          qualification.lock.data.calendarVersion !== config.clickhouse.calendarVersion ||
          canonicalHashV1(qualification.lock.data.bounds) !== canonicalHashV1(config.clickhouse.bounds)
        ) {
          throw new Error('configured Signal snapshot differs from the pinned qualification')
        }
      },
      catch: (cause) =>
        operationalError('database', 'recover-pinned-qualification', 'pinned qualification binding failed', cause),
    })
    const recoveredOption = yield* withinDeadline(
      databaseOperation(evidenceStore.recover(runId, executionProvenance), 'recover-pinned-qualification'),
      config.operationTimeoutMs,
      'database',
      'recover-pinned-qualification',
    )
    if (Option.isNone(recoveredOption)) {
      return yield* Effect.fail(
        operationalError('database', 'recover-pinned-qualification', `pinned evaluation ${runId} is missing`),
      )
    }
    const recovered = recoveredOption.value
    yield* Effect.try({
      try: () => {
        if (
          recovered.evaluation.runId !== runId ||
          recovered.reconciliation.runId !== runId ||
          recovered.persistence.runId !== runId ||
          canonicalHashV1(recovered.evaluation.verdict) !== canonicalHashV1(qualification.result.evaluationVerdict)
        ) {
          throw new Error('recovered evidence differs from the terminal qualification')
        }
      },
      catch: (cause) =>
        operationalError('database', 'recover-pinned-qualification', 'pinned qualification recovery failed', cause),
    })
    yield* Ref.update(
      state,
      (current): RuntimeState => ({
        ...current,
        evidence: {
          startupMode: 'pinned',
          provenance: executionProvenance,
          evaluation: recovered.evaluation,
          reconciliation: recovered.reconciliation,
          persistence: recovered.persistence,
          qualification: qualification.result,
        },
        error: null,
      }),
    )
    yield* Effect.logInfo('Bayn pinned qualification recovered').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId,
        qualification: qualification.result.verdict,
        executionSourceRevision: executionProvenance.sourceRevision,
        executionImageDigest: executionProvenance.image.digest,
      }),
    )
  }).pipe(Effect.withLogSpan('startup'))

const evaluateAndJournal = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  strategy: Strategy,
): Effect.Effect<void, OperationalError, MarketData | Journal | EvidenceStore> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    yield* Effect.logInfo('Bayn startup evaluation started').pipe(
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
    yield* withinDeadline(journal.check, config.operationTimeoutMs, 'journal', 'connectivity-check')
    yield* withinDeadline(
      databaseOperation(evidenceStore.check, 'health-check'),
      config.operationTimeoutMs,
      'database',
      'health-check',
    )
    const inspection = yield* withinDeadline(marketData.inspect, config.operationTimeoutMs, 'market-data', 'inspect')
    yield* Effect.logInfo('Bayn signal snapshot inspected').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        inputManifestHash: inspection.manifest.hash,
        rowCount: inspection.manifest.rowCount,
      }),
    )
    const priorTrialRunIds = yield* withinDeadline(
      databaseOperation(evidenceStore.listPriorTrials, 'list-prior-trials'),
      config.operationTimeoutMs,
      'database',
      'list-prior-trials',
    )
    const lock = yield* Effect.try({
      try: () => strategy.prepareLock(inspection.manifest, inspection.sessionDates, priorTrialRunIds),
      catch: (cause) => operationalError('strategy', 'prepare-lock', `${strategy.name} lock preparation failed`, cause),
    })
    const opened = yield* withinDeadline(
      databaseOperation(
        evidenceStore.openQualification({
          lock,
          inputManifest: inspection.manifest,
          parameters: strategy.parameters,
          provenance: strategy.provenance,
        }),
        'open-qualification',
      ),
      config.operationTimeoutMs,
      'database',
      'open-qualification',
    )
    if (opened.state === 'OPENED_INCOMPLETE') {
      return yield* Effect.fail(
        operationalError(
          'database',
          'open-qualification',
          `qualification ${opened.lock.lockId} was opened without a terminal result`,
        ),
      )
    }
    if (opened.state === 'TERMINAL') {
      const recovered = yield* withinDeadline(
        databaseOperation(evidenceStore.recover(lock.candidateRunId, strategy.provenance), 'recover-evaluation'),
        config.operationTimeoutMs,
        'database',
        'recover-evaluation',
      )
      if (Option.isNone(recovered)) {
        return yield* Effect.fail(
          operationalError(
            'database',
            'recover-evaluation',
            `terminal qualification run ${lock.candidateRunId} is missing`,
          ),
        )
      }
      yield* Effect.try({
        try: () => {
          if (
            opened.result.runId !== recovered.value.evaluation.runId ||
            canonicalHashV1(opened.result.evaluationVerdict) !== canonicalHashV1(recovered.value.evaluation.verdict)
          ) {
            throw new Error('terminal qualification differs from the recovered evaluation')
          }
        },
        catch: (cause) => operationalError('database', 'recover-qualification', 'qualification recovery failed', cause),
      })
      yield* Ref.update(
        state,
        (current): RuntimeState => ({
          ...current,
          evidence: {
            startupMode: 'recovered',
            provenance: strategy.provenance,
            evaluation: recovered.value.evaluation,
            reconciliation: recovered.value.reconciliation,
            persistence: recovered.value.persistence,
            qualification: opened.result,
          },
          error: null,
        }),
      )
      yield* Effect.logInfo('Bayn startup proof recovered').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: lock.candidateRunId,
          qualification: opened.result.verdict,
          artifactCount: recovered.value.persistence.artifactCount,
          eventCount: recovered.value.persistence.eventCount,
          gateCount: recovered.value.persistence.gateCount,
        }),
      )
      return
    }
    const snapshot = yield* withinDeadline(marketData.load, config.operationTimeoutMs, 'market-data', 'load')
    yield* Effect.try({
      try: () => {
        if (canonicalHashV1(snapshot.manifest) !== canonicalHashV1(inspection.manifest)) {
          throw new Error('loaded Signal manifest differs from the locked inspection')
        }
      },
      catch: (cause) => operationalError('market-data', 'load-locked', 'locked Signal load failed', cause),
    })
    const evaluation = yield* Effect.try({
      try: () => strategy.evaluate(snapshot.bars, snapshot.manifest),
      catch: (cause) => operationalError('strategy', 'evaluate', `${strategy.name} evaluation failed`, cause),
    })
    if (evaluation.runId !== lock.candidateRunId) {
      return yield* Effect.fail(
        operationalError('strategy', 'evaluate', 'evaluation run identity differs from the qualification lock'),
      )
    }
    yield* Effect.logInfo('Bayn strategy evaluation completed').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId: evaluation.runId,
        strategy: strategy.name,
        verdict: evaluation.verdict.status,
        eventCount: evaluation.events.length,
      }),
    )
    const reconciliation = yield* withinDeadline(
      journal.journalAndReconcile(evaluation),
      config.operationTimeoutMs,
      'journal',
      'journal-and-reconcile',
    )
    const analysis = yield* Effect.try({
      try: () => strategy.analyze(evaluation, lock.priorTrialRunIds),
      catch: (cause) => operationalError('strategy', 'analyze', `${strategy.name} analysis failed`, cause),
    })
    const qualification = yield* Effect.try({
      try: () => makeQualificationResult(lock, evaluation.verdict, analysis),
      catch: (cause) => operationalError('strategy', 'qualify', `${strategy.name} qualification failed`, cause),
    })
    const persistence = yield* withinDeadline(
      databaseOperation(
        evidenceStore.persist({
          provenance: strategy.provenance,
          parameters: strategy.parameters,
          evaluation,
          reconciliation,
          qualification: { lock, result: qualification },
        }),
        'persist-evaluation',
      ),
      config.operationTimeoutMs,
      'database',
      'persist-evaluation',
    )
    yield* Ref.update(
      state,
      (current): RuntimeState => ({
        ...current,
        evidence: {
          startupMode: 'evaluated',
          provenance: strategy.provenance,
          evaluation: summarizeEvaluation(evaluation),
          reconciliation,
          persistence,
          qualification,
        },
        error: null,
      }),
    )
    yield* Effect.logInfo('Bayn startup proof is durable').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId: evaluation.runId,
        accountCount: reconciliation.accountCount,
        transferCount: reconciliation.transferCount,
        persistenceDeduplicated: persistence.deduplicated,
        qualification: qualification.verdict,
        qualificationResultHash: qualification.resultHash,
        markedEquityDifferenceMicros: evaluation.markedEquityReconciliation.differenceMicros,
      }),
    )
  }).pipe(Effect.withLogSpan('startup'))

export const initialize = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  strategy: Strategy,
): Effect.Effect<void, OperationalError, MarketData | Journal | EvidenceStore> =>
  (config.qualificationRunId === undefined
    ? evaluateAndJournal(config, state, strategy)
    : recoverPinnedQualification(config, config.qualificationRunId, state)
  ).pipe(Effect.catch((error) => (error.retryable ? Effect.fail(error) : failStartup(state, error))))
