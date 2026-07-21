import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Cause, Clock, Duration, Effect, Exit, Layer, Option, Ref, Schedule } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import { makeRuntimeProvenance, type FinalizedSnapshotProvenance, type RuntimeProvenance } from './contracts'
import {
  EvidenceStore,
  type EvidenceStoreService,
  type PersistenceReceipt,
  type QualificationRecord,
  type RecoveredEvaluationEvidence,
  type StoredEvaluationEvidence,
} from './db/evidence-store'
import { formatError, operationalError, type Component, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { makeQualificationResult, type QualificationResult } from './qualification'
import { summarizeEvaluation } from './strategy'
import { Strategy } from './strategy-service'
import type { EvaluationSummary, ReconciliationResult } from './types'

export interface RuntimeEvidence {
  readonly startupMode: 'evaluated' | 'pinned' | 'recovered'
  readonly provenance: RuntimeProvenance
  readonly evaluation: EvaluationSummary
  readonly reconciliation: ReconciliationResult
  readonly persistence: PersistenceReceipt
  readonly qualification: QualificationResult
}

export interface DependencyHealth {
  readonly status: 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE'
  readonly checkedAt: string | null
  readonly error: string | null
}

export interface RuntimeHealth {
  readonly sequence: number
  readonly checkedAt: string | null
  readonly dependencies: {
    readonly postgresql: DependencyHealth
    readonly signal: DependencyHealth
    readonly tigerBeetle: DependencyHealth
    readonly evidence: DependencyHealth
  }
}

export interface RuntimeState {
  readonly status: 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED'
  readonly evidence: RuntimeEvidence | null
  readonly health: RuntimeHealth
  readonly error: string | null
}

const unknownDependency = (): DependencyHealth => ({ status: 'UNKNOWN', checkedAt: null, error: null })

export const initialState = (): RuntimeState => ({
  status: 'STARTING',
  evidence: null,
  health: {
    sequence: 0,
    checkedAt: null,
    dependencies: {
      postgresql: unknownDependency(),
      signal: unknownDependency(),
      tigerBeetle: unknownDependency(),
      evidence: unknownDependency(),
    },
  },
  error: null,
})

const allAvailable = (health: RuntimeHealth): boolean =>
  Object.values(health.dependencies).every((dependency) => dependency.status === 'AVAILABLE')

const isReady = (state: RuntimeState): boolean =>
  state.status === 'READY' && state.evidence !== null && allAvailable(state.health)

const json = (value: unknown): string =>
  JSON.stringify(value, (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested))

const verifiedState = (evidence: RuntimeEvidence | null, dependency: DependencyHealth) => {
  if (evidence === null || dependency.status === 'UNKNOWN') return 'UNKNOWN'
  return dependency.status === 'AVAILABLE' ? 'CURRENT' : 'INVALID'
}

const publicState = (
  state: RuntimeState,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
) => {
  let economic = 'UNKNOWN'
  let accounting = 'UNKNOWN'
  if (state.evidence !== null) {
    economic = state.evidence.qualification.verdict
    if (state.health.dependencies.tigerBeetle.status === 'AVAILABLE') accounting = 'EXACT'
    if (state.health.dependencies.tigerBeetle.status === 'UNAVAILABLE') accounting = 'UNAVAILABLE'
  }

  return {
    service: 'bayn',
    operational: {
      status: state.status,
      ready: isReady(state),
      probeSequence: state.health.sequence,
      checkedAt: state.health.checkedAt,
    },
    dependencies: state.health.dependencies,
    data: {
      status: verifiedState(state.evidence, state.health.dependencies.signal),
      input: state.evidence?.evaluation.input ?? null,
    },
    evidence: {
      status: verifiedState(state.evidence, state.health.dependencies.evidence),
      runId: state.evidence?.evaluation.runId ?? null,
      startupMode: state.evidence?.startupMode ?? null,
      persistence: state.evidence?.persistence ?? null,
    },
    economic: {
      status: economic,
      verdict: state.evidence?.qualification.evaluationVerdict ?? null,
    },
    qualification: {
      status: state.evidence?.qualification.verdict ?? 'UNKNOWN',
      executable: state.evidence?.qualification.verdict === 'QUALIFIED',
      lockId: state.evidence?.qualification.lockId ?? null,
      resultHash: state.evidence?.qualification.resultHash ?? null,
      analysisHash: state.evidence?.qualification.analysis.analysisHash ?? null,
      candidateOrdinal: state.evidence?.qualification.analysis.candidateOrdinal ?? null,
      reasonCodes: state.evidence?.qualification.reasonCodes ?? [],
      executionProvenance: state.evidence?.provenance ?? null,
    },
    accounting: {
      status: accounting,
      reconciliation: state.evidence?.reconciliation ?? null,
    },
    authority: {
      maximum: 'observe',
      brokerOrders: false,
      capitalPromotion: false,
    },
    build: {
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      verification: provenanceVerification,
    },
    error: state.error,
  }
}

const jsonResponse = (body: unknown, status = 200, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.text(json(body), { status, contentType: 'application/json', headers })

export const makeHttpLayer = (
  config: Pick<RuntimeConfig, 'host' | 'operationTimeoutMs' | 'port'>,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  evidenceStore: EvidenceStoreService,
): ReturnType<typeof NodeHttpServer.layer> => {
  const ready = Ref.get(state).pipe(
    Effect.map((current) => {
      const ready = isReady(current)
      const failedDependencies = Object.entries(current.health.dependencies)
        .filter(([, dependency]) => dependency.status !== 'AVAILABLE')
        .map(([name]) => name)
      return jsonResponse(
        {
          ready,
          status: current.status,
          checkedAt: current.health.checkedAt,
          probeSequence: current.health.sequence,
          failedDependencies,
        },
        ready ? 200 : 503,
      )
    }),
  )
  const status = Ref.get(state).pipe(
    Effect.map((current) => jsonResponse(publicState(current, provenance, provenanceVerification))),
  )
  const historicalEvaluation = HttpRouter.params.pipe(
    Effect.flatMap(({ runId }) => {
      if (runId === undefined || !/^[0-9a-f]{64}$/.test(runId)) {
        return Effect.succeed(jsonResponse({ error: 'invalid_run_id' }, 400))
      }
      return evidenceStore.read(runId).pipe(
        Effect.timeoutOrElse({
          duration: config.operationTimeoutMs,
          orElse: () => Effect.fail(new Error(`evidence read timed out after ${config.operationTimeoutMs}ms`)),
        }),
        Effect.map((stored) =>
          Option.match(stored, {
            onNone: () => jsonResponse({ error: 'evaluation_not_found' }, 404),
            onSome: (evidence) => jsonResponse(evidence),
          }),
        ),
        Effect.catch((error) =>
          Effect.logError('Bayn historical evidence read failed').pipe(
            Effect.annotateLogs({ service: 'bayn', runId, error: error.message }),
            Effect.as(jsonResponse({ error: 'evidence_unavailable' }, 503)),
          ),
        ),
      )
    }),
  )
  const fallback = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.succeed(
      request.method === 'GET'
        ? jsonResponse({ error: 'not_found' }, 404)
        : jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET' }),
    )
  const routes: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.addAll([
    HttpRouter.route<never, never>('GET', '/livez', jsonResponse({ service: 'bayn', live: true })),
    HttpRouter.route<never, never>('GET', '/readyz', ready),
    HttpRouter.route<never, never>('GET', '/v1/status', status),
    HttpRouter.route('GET', '/v1/evaluations/:runId', historicalEvaluation),
    HttpRouter.route<never, never>('*', '*', fallback),
  ] as const)

  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { host: config.host, port: config.port })),
  )
}

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

const provenanceFromStored = (stored: StoredEvaluationEvidence): RuntimeProvenance =>
  makeRuntimeProvenance({
    sourceRevision: stored.run.sourceRevision,
    image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
    strategy: {
      name: stored.protocol.strategyName,
      behaviorHash: stored.protocol.behaviorHash,
      parameterHash: stored.protocol.parameterHash,
      parameterSchemaVersion: stored.protocol.schemaVersion,
    },
  })

const recoverPinnedQualification = (
  config: RuntimeConfig,
  runId: string,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, Strategy | EvidenceStore> =>
  Effect.gen(function* () {
    const strategy = yield* Strategy
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
): Effect.Effect<void, OperationalError, MarketData | Journal | Strategy | EvidenceStore> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const strategy = yield* Strategy
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
): Effect.Effect<void, never, MarketData | Journal | Strategy | EvidenceStore> =>
  (config.qualificationRunId === undefined
    ? evaluateAndJournal(config, state)
    : recoverPinnedQualification(config, config.qualificationRunId, state)
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
): Effect.Effect<never, OperationalError, MarketData | Journal | Strategy | EvidenceStore> =>
  Effect.scoped(
    Effect.gen(function* () {
      const strategy = yield* Strategy
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make(initialState())
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state)
      yield* monitor(config, state).pipe(Effect.forkScoped({ startImmediately: true }))
      return yield* Effect.never
    }),
  )
