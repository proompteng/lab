import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Ref, Schedule } from 'effect'

import type { BrokerReadShape } from './broker/alpaca'
import type { RuntimeConfig } from './config'
import type { FinalizedSnapshotProvenance } from './contracts'
import {
  CycleOperationsCondition,
  deriveCycleOperationsStatus,
  unknownCycleOperationsStatus,
} from './cycle-observability'
import type { CycleRunnerError } from './cycle-runner'
import { CycleObservability } from './db/cycle-observability'
import { EvidenceStore, type QualificationRecord, type RecoveredEvaluationEvidence } from './db/evidence-store'
import { operationalError, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { databaseOperation, withinDeadline } from './operations'
import type {
  BrokerConfiguration,
  BrokerStatus,
  CycleRunnerStatus,
  DependencyHealth,
  RuntimeEvidence,
  RuntimeHealth,
  RuntimeState,
} from './runtime-state'

interface ProbeResult {
  readonly error: string | null
}

interface BrokerProbeResult extends ProbeResult {
  readonly accountId: string | null
}

interface ValueProbeResult<A> extends ProbeResult {
  readonly value: A | null
}

export interface BrokerProbe extends BrokerConfiguration {
  readonly read: BrokerReadShape
}

export type CycleRunnerFiber = Fiber.Fiber<void, CycleRunnerError>

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<ProbeResult, never, R> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return { error: null }
    if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt
    const errors = Cause.prettyErrors(exit.cause).map((error) => error.message)
    return { error: errors.join('; ') || 'unknown probe failure' }
  })

const observeBroker = (read: BrokerReadShape, timeoutMs: number): Effect.Effect<BrokerProbeResult> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      read.account.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new Error(`Alpaca account probe timed out after ${timeoutMs}ms`)),
        }),
      ),
    )
    if (Exit.isSuccess(exit)) return { accountId: exit.value.value.id, error: null }
    if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt
    const errors = Cause.prettyErrors(exit.cause).map((error) => error.message)
    return { accountId: null, error: errors.join('; ') || 'unknown broker probe failure' }
  })

const observeValue = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<ValueProbeResult<A>, never, R> =>
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

const dependencyHealth = (result: ProbeResult, checkedAt: string): DependencyHealth => ({
  status: result.error === null ? 'AVAILABLE' : 'UNAVAILABLE',
  checkedAt,
  error: result.error,
})

const inspectCycleRunner = (
  enabled: boolean,
  fiber: CycleRunnerFiber | undefined,
  checkedAt: string,
): Effect.Effect<CycleRunnerStatus> => {
  if (!enabled) {
    return Effect.succeed({ enabled: false, status: 'DISABLED', checkedAt, error: null })
  }
  if (fiber === undefined) {
    return Effect.succeed({
      enabled: true,
      status: 'FAILED',
      checkedAt,
      error: 'autonomous cycle loop is enabled but its sole runner fiber is missing',
    })
  }
  return Effect.sync(() => fiber.pollUnsafe()).pipe(
    Effect.map((exit): CycleRunnerStatus => {
      if (exit === undefined) return { enabled: true, status: 'RUNNING', checkedAt, error: null }
      return {
        enabled: true,
        status: 'FAILED',
        checkedAt,
        error: Exit.isSuccess(exit)
          ? 'autonomous cycle loop exited unexpectedly'
          : `autonomous cycle loop failed: ${Cause.pretty(exit.cause)}`,
      }
    }),
  )
}

export const probe = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  cycleRunner?: CycleRunnerFiber,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    const cycleObservability = yield* CycleObservability
    const current = yield* Ref.get(state)
    const evidence = current.evidence
    const [[postgresql, signal, tigerBeetle, durableEvidence, cycleResult], brokerResult] = yield* Effect.all(
      [
        Effect.all(
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
            observeValue(
              evidence === null
                ? Effect.fail(operationalError('database', 'cycle-observability', 'startup evidence is unavailable'))
                : withinDeadline(
                    databaseOperation(
                      cycleObservability.read(evidence.evaluation.runId, broker?.expectedAccountId),
                      'cycle-observability',
                    ),
                    config.operationTimeoutMs,
                    'database',
                    'cycle-observability',
                  ),
            ),
          ],
          { concurrency: 'unbounded' },
        ),
        broker === undefined ? Effect.succeed(undefined) : observeBroker(broker.read, config.operationTimeoutMs),
      ],
      { concurrency: 'unbounded' },
    )
    const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const cycleRunnerStatus = yield* inspectCycleRunner(config.autonomousCycle.enabled, cycleRunner, checkedAt)
    const cycle =
      cycleResult.error === null && cycleResult.value !== null
        ? deriveCycleOperationsStatus(cycleResult.value, Date.parse(checkedAt), config.maximumAuthority, config)
        : {
            ...unknownCycleOperationsStatus(cycleResult.error ?? 'cycle observability probe did not run'),
            checkedAt,
          }
    let brokerStatus: BrokerStatus | null = current.broker
    if (broker !== undefined) {
      const result = brokerResult ?? { accountId: null, error: 'broker probe did not run' }
      const accountBound = result.error === null && result.accountId === broker.expectedAccountId
      const bindingError =
        result.error ??
        (accountBound
          ? null
          : `Alpaca account probe resolved ${result.accountId ?? 'no account'}, expected ${broker.expectedAccountId}`)
      brokerStatus = {
        configured: true,
        expectedAccountId: broker.expectedAccountId,
        accountId: result.accountId,
        accountBound,
        readAvailable: result.error === null,
        checkedAt,
        error: bindingError,
        executionEligible: broker.executionEligible,
        executionDisabledReason: broker.executionDisabledReason,
      }
    }
    const health: RuntimeHealth = {
      sequence: current.health.sequence + 1,
      checkedAt,
      dependencies: {
        postgresql: dependencyHealth(postgresql, checkedAt),
        signal: dependencyHealth(signal, checkedAt),
        tigerBeetle: dependencyHealth(tigerBeetle, checkedAt),
        evidence: dependencyHealth(durableEvidence, checkedAt),
        cycle: dependencyHealth(cycleResult, checkedAt),
        cycleRunner: dependencyHealth(cycleRunnerStatus, checkedAt),
      },
    }
    const dependencyFailures = Object.entries(health.dependencies).filter(([, dependency]) => dependency.error !== null)
    const failedDependencies = dependencyFailures.map(([name]) => name)
    const failureMessages = dependencyFailures.map(([name, dependency]) => `${name}: ${dependency.error}`)
    if (
      brokerStatus !== null &&
      (brokerStatus.error !== null || brokerStatus.accountBound !== true || brokerStatus.readAvailable !== true)
    ) {
      failedDependencies.push('broker')
      failureMessages.push(`broker: ${brokerStatus.error ?? 'account binding unavailable'}`)
    }
    if (cycle.condition === CycleOperationsCondition.Stalled || cycle.condition === CycleOperationsCondition.Failed) {
      if (!failedDependencies.includes('cycle')) failedDependencies.push('cycle')
      failureMessages.push(`cycle: ${cycle.reason}`)
    }
    let next: RuntimeState = { ...current, health, cycle, cycleRunner: cycleRunnerStatus, broker: brokerStatus }
    if (evidence !== null && failureMessages.length === 0) {
      next = {
        ...current,
        status: 'READY',
        health,
        cycle,
        cycleRunner: cycleRunnerStatus,
        broker: brokerStatus,
        error: null,
      }
    } else if (evidence !== null) {
      next = {
        ...current,
        status: 'DEGRADED',
        health,
        cycle,
        cycleRunner: cycleRunnerStatus,
        broker: brokerStatus,
        error: failureMessages.join('; '),
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
          failedDependencies: failedDependencies.join(','),
        }),
      )
    }
    if (next.cycle.condition !== current.cycle.condition || next.cycle.reason !== current.cycle.reason) {
      const cycleObservationAvailable = next.cycle.condition !== CycleOperationsCondition.Unknown
      const log =
        next.cycle.condition === CycleOperationsCondition.Stalled ||
        next.cycle.condition === CycleOperationsCondition.Failed
          ? Effect.logWarning
          : Effect.logInfo
      yield* log(`Bayn cycle operations changed to ${next.cycle.condition}`).pipe(
        Effect.annotateLogs({
          service: 'bayn',
          checkedAt,
          cycleCondition: next.cycle.condition,
          cycleReason: next.cycle.reason,
          currentCycleId: next.cycle.current?.cycleId ?? '',
          currentPhase: next.cycle.current?.phase ?? '',
          signalSessionDate: next.cycle.current?.signalSessionDate ?? '',
          submissionCutoffAt: next.cycle.current?.submissionCutoffAt ?? '',
          attemptAgeMs: next.cycle.attemptAgeMs ?? -1,
          unfinishedCycleCount: cycleObservationAvailable ? next.cycle.unfinishedCycleCount : 'unknown',
          unresolvedMutationCount: cycleObservationAvailable ? next.cycle.mutations.unresolvedCount : 'unknown',
          zeroMutation: cycleObservationAvailable ? next.cycle.zeroMutation : 'unknown',
        }),
      )
    }
    if (next.cycleRunner.status !== current.cycleRunner.status) {
      const log = next.cycleRunner.status === 'FAILED' ? Effect.logWarning : Effect.logInfo
      yield* log(`Bayn autonomous cycle runner changed to ${next.cycleRunner.status}`).pipe(
        Effect.annotateLogs({
          service: 'bayn',
          checkedAt,
          cycleRunnerEnabled: next.cycleRunner.enabled,
          cycleRunnerStatus: next.cycleRunner.status,
          cycleRunnerError: next.cycleRunner.error ?? '',
        }),
      )
    }
  }).pipe(Effect.withLogSpan('health'))

export const monitor = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  cycleRunner?: CycleRunnerFiber,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability> =>
  probe(config, state, broker, cycleRunner).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.healthIntervalMs))),
    Effect.asVoid,
  )
