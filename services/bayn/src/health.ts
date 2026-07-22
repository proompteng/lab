import { Cause, Clock, Duration, Effect, Exit, Option, Ref, Schedule } from 'effect'

import type { RuntimeConfig } from './config'
import type { FinalizedSnapshotProvenance } from './contracts'
import { EvidenceStore, type QualificationRecord, type RecoveredEvaluationEvidence } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { WriterFence } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { databaseOperation, withinDeadline } from './operations'
import type { DependencyHealth, RuntimeEvidence, RuntimeHealth, RuntimeState } from './runtime-state'

interface ProbeResult {
  readonly error: string | null
}

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<ProbeResult, never, R> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return { error: null }
    if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt
    const errors = Cause.prettyErrors(exit.cause).map((error) => error.message)
    return { error: errors.join('; ') || 'unknown probe failure' }
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

const dependencyHealth = (result: ProbeResult, checkedAt: string): DependencyHealth => ({
  status: result.error === null ? 'AVAILABLE' : 'UNAVAILABLE',
  checkedAt,
  error: result.error,
})

export const probe = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | WriterFence> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    const writerFence = yield* WriterFence
    const current = yield* Ref.get(state)
    const evidence = current.evidence
    const [postgresql, signal, tigerBeetle, durableEvidence] = yield* Effect.all(
      [
        observe(
          withinDeadline(
            databaseOperation(
              Effect.all([evidenceStore.check, writerFence.check], { concurrency: 'unbounded' }).pipe(Effect.asVoid),
              'continuous-health',
            ),
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
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | WriterFence> =>
  probe(config, state).pipe(Effect.repeat(Schedule.spaced(Duration.millis(config.healthIntervalMs))), Effect.asVoid)
