import { Cause, Clock, Duration, Effect, Exit, Layer, Option, Ref, Schedule } from 'effect'

import type { RuntimeConfig } from './config'
import { makeRuntimeProvenance, type FinalizedSnapshotProvenance, type RuntimeProvenance } from './contracts'
import {
  EvidenceStore,
  type QualificationRecord,
  type RecoveredEvaluationEvidence,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { formatError, operationalError, type Component, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { makeHttpLayer } from './http'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { makeQualificationResult } from './qualification'
import { summarizeEvaluation } from './risk-balanced-trend'
import {
  initialState,
  type DependencyHealth,
  type RuntimeEvidence,
  type RuntimeHealth,
  type RuntimeState,
} from './runtime-state'
import type { Strategy } from './strategy-service'

const withinDeadline = <A, R>(
  effect: Effect.Effect<A, OperationalError, R>,
  timeoutMs: number,
  component: Component,
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(operationalError(component, operation, `${operation} timed out after ${timeoutMs}ms`)),
    }),
  )

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

const databaseOperation = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>, operation: string) =>
  effect.pipe(
    Effect.mapError((cause) => operationalError('database', operation, `PostgreSQL ${operation} failed`, cause)),
  )

const provenanceFromStored = (stored: StoredEvaluationEvidence): RuntimeProvenance => {
  if (
    stored.protocol.strategyName !== 'risk-balanced-trend' ||
    stored.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v2'
  ) {
    throw new Error('stored evaluation uses an unsupported strategy contract')
  }
  return makeRuntimeProvenance({
    sourceRevision: stored.run.sourceRevision,
    image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
    strategy: {
      name: stored.protocol.strategyName,
      behaviorHash: stored.protocol.behaviorHash,
      parameterHash: stored.protocol.parameterHash,
      parameterSchemaVersion: stored.protocol.schemaVersion,
    },
  })
}

const recoverPinnedQualification = (
  config: RuntimeConfig,
  runId: string,
  state: Ref.Ref<RuntimeState>,
  strategy: Strategy,
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
          canonicalHashV1(executionProvenance.strategy) !== canonicalHashV1(strategy.provenance.strategy) ||
          canonicalHashV1(stored.protocol.parameters) !== canonicalHashV1(strategy.parameters)
        ) {
          throw new Error('compiled strategy differs from the pinned qualification protocol')
        }
        if (
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
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore> =>
  (config.qualificationRunId === undefined
    ? evaluateAndJournal(config, state, strategy)
    : recoverPinnedQualification(config, config.qualificationRunId, state, strategy)
  ).pipe(Effect.catch((error) => failStartup(state, error)))

interface ProbeResult<A> {
  readonly value: A | null
  readonly error: string | null
}

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<ProbeResult<A>, never, R> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return { value: exit.value, error: null }
    if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt
    const errors = Cause.prettyErrors(exit.cause).map((error) => error.message)
    return { value: null, error: errors.join('; ') || 'unknown probe failure' }
  })

const ensureSignalIdentity = (
  snapshot: FinalizedSnapshotProvenance,
  evidence: RuntimeEvidence | null,
): Effect.Effect<void, OperationalError> =>
  Effect.try({
    try: () => {
      if (evidence === null) throw new Error('startup evidence is unavailable')
      if (snapshot.snapshotId !== evidence.evaluation.input.snapshotId) {
        throw new Error('configured Signal snapshot differs from the active run')
      }
      if (snapshot.publicationId !== evidence.evaluation.input.publicationId) {
        throw new Error('configured Signal publication differs from the active run')
      }
    },
    catch: (cause) => operationalError('market-data', 'check-identity', 'Signal identity check failed', cause),
  })

const durableMaterial = (evidence: RuntimeEvidence | RecoveredEvaluationEvidence) => ({
  evaluation: evidence.evaluation,
  reconciliation: evidence.reconciliation,
  persistence: {
    runId: evidence.persistence.runId,
    artifactCount: evidence.persistence.artifactCount,
    eventCount: evidence.persistence.eventCount,
    gateCount: evidence.persistence.gateCount,
  },
})

const ensureDurableEvidence = (
  recovered: Option.Option<RecoveredEvaluationEvidence>,
  qualification: Option.Option<QualificationRecord>,
  evidence: RuntimeEvidence | null,
): Effect.Effect<void, OperationalError> =>
  Effect.try({
    try: () => {
      if (evidence === null) throw new Error('startup evidence is unavailable')
      if (Option.isNone(recovered)) throw new Error(`durable run ${evidence.evaluation.runId} is missing`)
      if (Option.isNone(qualification) || qualification.value.state !== 'TERMINAL') {
        throw new Error(`terminal qualification ${evidence.evaluation.runId} is missing`)
      }
      if (canonicalHashV1(durableMaterial(recovered.value)) !== canonicalHashV1(durableMaterial(evidence))) {
        throw new Error(`durable run ${evidence.evaluation.runId} differs from the active proof`)
      }
      if (canonicalHashV1(qualification.value.result) !== canonicalHashV1(evidence.qualification)) {
        throw new Error(`terminal qualification ${evidence.evaluation.runId} differs from the active proof`)
      }
    },
    catch: (cause) => operationalError('database', 'verify-evidence', 'durable evidence verification failed', cause),
  })

const dependencyHealth = (result: ProbeResult<unknown>, checkedAt: string): DependencyHealth => ({
  status: result.error === null ? 'AVAILABLE' : 'UNAVAILABLE',
  checkedAt,
  error: result.error,
})

export const probe = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    const current = yield* Ref.get(state)
    const evidence = current.evidence
    const [postgresql, signal, tigerBeetle, durableEvidence] = yield* Effect.all(
      [
        observe(
          withinDeadline(
            databaseOperation(evidenceStore.check, 'continuous-health'),
            config.operationTimeoutMs,
            'database',
            'continuous-health',
          ),
        ),
        observe(
          withinDeadline(marketData.check, config.operationTimeoutMs, 'market-data', 'continuous-health').pipe(
            Effect.flatMap((snapshot) => ensureSignalIdentity(snapshot, evidence)),
          ),
        ),
        observe(
          withinDeadline(
            evidence === null ? journal.check : journal.checkRun(evidence.reconciliation),
            config.operationTimeoutMs,
            'journal',
            'continuous-health',
          ),
        ),
        observe(
          evidence === null
            ? Effect.fail(operationalError('database', 'verify-evidence', 'startup evidence is unavailable'))
            : withinDeadline(
                Effect.all([
                  databaseOperation(
                    evidenceStore.recover(evidence.evaluation.runId, evidence.provenance),
                    'continuous-recovery',
                  ),
                  databaseOperation(
                    evidenceStore.readQualification(evidence.evaluation.runId),
                    'continuous-qualification',
                  ),
                ]),
                config.operationTimeoutMs,
                'database',
                'continuous-recovery',
              ).pipe(
                Effect.flatMap(([recovered, qualification]) =>
                  ensureDurableEvidence(recovered, qualification, evidence),
                ),
              ),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const health: RuntimeHealth = {
      sequence: current.health.sequence + 1,
      checkedAt,
      dependencies: {
        postgresql: dependencyHealth(postgresql, checkedAt),
        signal: dependencyHealth(signal, checkedAt),
        tigerBeetle: dependencyHealth(tigerBeetle, checkedAt),
        evidence: dependencyHealth(durableEvidence, checkedAt),
      },
    }
    const failures = Object.entries(health.dependencies).filter(([, dependency]) => dependency.error !== null)
    let next: RuntimeState = { ...current, health }
    if (evidence !== null && failures.length === 0) {
      next = { ...current, status: 'READY', health, error: null }
    } else if (evidence !== null) {
      next = {
        ...current,
        status: 'DEGRADED',
        health,
        error: failures.map(([name, dependency]) => `${name}: ${dependency.error}`).join('; '),
      }
    }
    yield* Ref.set(state, next)

    if (next.status !== current.status) {
      const log = next.status === 'READY' ? Effect.logInfo : Effect.logWarning
      yield* log(`Bayn health changed to ${next.status}`).pipe(
        Effect.annotateLogs({
          service: 'bayn',
          checkedAt,
          probeSequence: health.sequence,
          failedDependencies: failures.map(([name]) => name).join(','),
        }),
      )
    }
  }).pipe(Effect.withLogSpan('health'))

export const monitor = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore> =>
  probe(config, state).pipe(Effect.repeat(Schedule.spaced(Duration.millis(config.healthIntervalMs))), Effect.asVoid)

export const run = (
  config: RuntimeConfig,
  strategy: Strategy,
): Effect.Effect<never, OperationalError, MarketData | Journal | EvidenceStore> =>
  Effect.scoped(
    Effect.gen(function* () {
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make(initialState())
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore.read),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state, strategy)
      yield* monitor(config, state).pipe(Effect.forkScoped({ startImmediately: true }))
      return yield* Effect.never
    }),
  )
