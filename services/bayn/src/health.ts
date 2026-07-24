import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Ref, Result, Schedule } from 'effect'

import type { BrokerReadShape } from './broker/alpaca'
import type { RuntimeConfig } from './config'
import type { FinalizedSnapshotProvenance } from './contracts'
import {
  CycleOperationsCondition,
  deriveCycleOperationsStatus,
  type CycleOperationsProjection,
  type CycleOperationsStatus,
  unknownCycleOperationsStatus,
} from './cycle-observability'
import { CycleObservability } from './db/cycle-observability'
import { EvidenceStore, type QualificationRecord, type RecoveredEvaluationEvidence } from './db/evidence-store'
import { OperationalError, operationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { databaseOperation, withinDeadline } from './operations'
import type {
  AutonomousCycleLoopStatus,
  BrokerConfiguration,
  BrokerStatus,
  DependencyHealth,
  RuntimeEvidence,
  RuntimeHealth,
  RuntimeState,
} from './runtime-state'

type ProbeResult<A> =
  | { readonly _tag: 'Available'; readonly value: A }
  | { readonly _tag: 'Unavailable'; readonly error: string }

interface HealthProbeResults {
  readonly postgresql: ProbeResult<void>
  readonly signal: ProbeResult<void>
  readonly tigerBeetle: ProbeResult<void>
  readonly durableEvidence: ProbeResult<void>
  readonly cycle: ProbeResult<CycleOperationsProjection>
  readonly broker: ProbeResult<string> | null
}

export type SignalIdentityFailure =
  | { readonly _tag: 'EvidenceUnavailable' }
  | {
      readonly _tag: 'SnapshotMismatch'
      readonly observedSnapshotId: string
      readonly expectedSnapshotId: string
    }
  | {
      readonly _tag: 'PublicationMismatch'
      readonly observedPublicationId: string
      readonly expectedPublicationId: string
    }

export type DurableEvidenceFailure =
  | { readonly _tag: 'EvidenceUnavailable' }
  | { readonly _tag: 'RunMissing'; readonly runId: string }
  | {
      readonly _tag: 'TerminalQualificationMissing'
      readonly runId: string
      readonly observedState: Exclude<QualificationRecord['state'], 'TERMINAL'> | null
    }
  | {
      readonly _tag: 'RunMismatch'
      readonly runId: string
      readonly observedDurableHash: string
      readonly expectedDurableHash: string
    }
  | {
      readonly _tag: 'TerminalQualificationMismatch'
      readonly runId: string
      readonly observedQualificationHash: string
      readonly expectedQualificationHash: string
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly runId: string
      readonly material:
        | 'EXPECTED_DURABLE_EVIDENCE'
        | 'OBSERVED_DURABLE_EVIDENCE'
        | 'EXPECTED_QUALIFICATION'
        | 'OBSERVED_QUALIFICATION'
      readonly cause: unknown
    }

export type HealthDependencyName = keyof RuntimeHealth['dependencies'] | 'broker'

export type AutonomousCycleFiberObservation =
  | { readonly _tag: 'NotProvided' }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'ExitedSuccessfully' }
  | { readonly _tag: 'ExitedWithFailure'; readonly error: string }

interface HealthTransitionInput {
  readonly config: RuntimeConfig
  readonly evidenceAvailable: boolean
  readonly results: HealthProbeResults
  readonly broker: BrokerConfiguration | undefined
  readonly cycleFiber: AutonomousCycleFiberObservation
  readonly checkedAt: string
  readonly checkedAtMs: number
}

interface HealthFailureSummary {
  readonly failedDependencies: readonly HealthDependencyName[]
  readonly messages: readonly string[]
}

export interface HealthTransition {
  readonly current: RuntimeState
  readonly next: RuntimeState
  readonly health: RuntimeHealth
  readonly failedDependencies: readonly HealthDependencyName[]
  readonly checkedAt: string
}

type LogAnnotation = string | number | boolean

export interface HealthLogDecision {
  readonly _tag: 'RuntimeStatusChanged' | 'CycleOperationsChanged'
  readonly level: 'INFO' | 'WARNING'
  readonly message: string
  readonly annotations: Readonly<Record<string, LogAnnotation>>
}

export const validateSignalIdentity = (
  snapshot: FinalizedSnapshotProvenance,
  evidence: RuntimeEvidence | null,
): Result.Result<void, SignalIdentityFailure> => {
  if (evidence === null) {
    return Result.fail({ _tag: 'EvidenceUnavailable' })
  }
  if (snapshot.snapshotId !== evidence.evaluation.input.snapshotId) {
    return Result.fail({
      _tag: 'SnapshotMismatch',
      observedSnapshotId: snapshot.snapshotId,
      expectedSnapshotId: evidence.evaluation.input.snapshotId,
    })
  }
  if (snapshot.publicationId !== evidence.evaluation.input.publicationId) {
    return Result.fail({
      _tag: 'PublicationMismatch',
      observedPublicationId: snapshot.publicationId,
      expectedPublicationId: evidence.evaluation.input.publicationId,
    })
  }
  return Result.succeed(undefined)
}

export const renderSignalIdentityFailure = (failure: SignalIdentityFailure): string => {
  switch (failure._tag) {
    case 'EvidenceUnavailable':
      return 'startup evidence is unavailable'
    case 'SnapshotMismatch':
      return `configured Signal snapshot ${failure.observedSnapshotId} differs from active run snapshot ${failure.expectedSnapshotId}`
    case 'PublicationMismatch':
      return `configured Signal publication ${failure.observedPublicationId} differs from active run publication ${failure.expectedPublicationId}`
  }
  const exhaustive: never = failure
  return exhaustive
}

export interface BrokerProbe extends BrokerConfiguration {
  readonly read: BrokerReadShape
}

const probeFailureMessage = <E>(cause: Cause.Cause<E>, fallback: string): string => {
  const errors = Cause.prettyErrors(cause).map((error) => error.message)
  return errors.join('; ') || fallback
}

const observe = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback = 'unknown probe failure',
): Effect.Effect<ProbeResult<A>, never, R> =>
  Effect.flatMap(Effect.exit(effect), (exit): Effect.Effect<ProbeResult<A>> => {
    if (Exit.isSuccess(exit)) return Effect.succeed({ _tag: 'Available', value: exit.value })
    if (Cause.hasInterrupts(exit.cause)) return Effect.interrupt
    return Effect.succeed({ _tag: 'Unavailable', error: probeFailureMessage(exit.cause, fallback) })
  })

const observeBroker = (read: BrokerReadShape, timeoutMs: number): Effect.Effect<ProbeResult<string>> =>
  Effect.map(
    observe(
      read.account.pipe(
        Effect.map((value) => ({ _tag: 'AccountRead' as const, value })),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.succeed({ _tag: 'TimedOut' as const }),
        }),
      ),
      'unknown broker probe failure',
    ),
    (result): ProbeResult<string> => {
      if (result._tag === 'Unavailable') return result
      if (result.value._tag === 'TimedOut') {
        return {
          _tag: 'Unavailable',
          error: `Alpaca account probe timed out after ${timeoutMs}ms`,
        }
      }
      return { _tag: 'Available', value: result.value.value.value.id }
    },
  )

export const ensureSignalIdentity = (
  snapshot: FinalizedSnapshotProvenance,
  evidence: RuntimeEvidence | null,
): Effect.Effect<void, OperationalError> =>
  Effect.mapError(
    Effect.fromResult(validateSignalIdentity(snapshot, evidence)),
    (failure) =>
      new OperationalError({
        component: 'market-data',
        operation: 'check-identity',
        message: `Signal identity check failed: ${renderSignalIdentityFailure(failure)}`,
        retryable: false,
        cause: failure,
      }),
  )

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

const canonicalHashResult = (
  runId: string,
  material: Extract<DurableEvidenceFailure, { readonly _tag: 'CanonicalizationFailed' }>['material'],
  value: unknown,
): Result.Result<string, DurableEvidenceFailure> =>
  Result.try({
    try: () => canonicalHashV1(value),
    catch: (cause): DurableEvidenceFailure => ({ _tag: 'CanonicalizationFailed', runId, material, cause }),
  })

export const validateDurableEvidence = (
  recovered: RecoveredEvaluationEvidence | null,
  qualification: QualificationRecord | null,
  evidence: RuntimeEvidence | null,
): Result.Result<void, DurableEvidenceFailure> => {
  if (evidence === null) {
    return Result.fail({ _tag: 'EvidenceUnavailable' })
  }
  if (recovered === null) {
    return Result.fail({
      _tag: 'RunMissing',
      runId: evidence.evaluation.runId,
    })
  }
  if (qualification === null || qualification.state !== 'TERMINAL') {
    return Result.fail({
      _tag: 'TerminalQualificationMissing',
      runId: evidence.evaluation.runId,
      observedState: qualification?.state ?? null,
    })
  }

  const durableHashes = Result.all({
    expected: canonicalHashResult(evidence.evaluation.runId, 'EXPECTED_DURABLE_EVIDENCE', durableMaterial(evidence)),
    observed: canonicalHashResult(evidence.evaluation.runId, 'OBSERVED_DURABLE_EVIDENCE', durableMaterial(recovered)),
  })
  if (Result.isFailure(durableHashes)) return Result.fail(durableHashes.failure)
  const expectedRunHash = durableHashes.success.expected
  const observedRunHash = durableHashes.success.observed
  if (observedRunHash !== expectedRunHash) {
    return Result.fail({
      _tag: 'RunMismatch',
      runId: evidence.evaluation.runId,
      observedDurableHash: observedRunHash,
      expectedDurableHash: expectedRunHash,
    })
  }

  const qualificationHashes = Result.all({
    expected: canonicalHashResult(evidence.evaluation.runId, 'EXPECTED_QUALIFICATION', evidence.qualification),
    observed: canonicalHashResult(evidence.evaluation.runId, 'OBSERVED_QUALIFICATION', qualification.result),
  })
  if (Result.isFailure(qualificationHashes)) return Result.fail(qualificationHashes.failure)
  const expectedQualificationHash = qualificationHashes.success.expected
  const observedQualificationHash = qualificationHashes.success.observed
  if (observedQualificationHash !== expectedQualificationHash) {
    return Result.fail({
      _tag: 'TerminalQualificationMismatch',
      runId: evidence.evaluation.runId,
      observedQualificationHash,
      expectedQualificationHash,
    })
  }
  return Result.succeed(undefined)
}

export const renderDurableEvidenceFailure = (failure: DurableEvidenceFailure): string => {
  switch (failure._tag) {
    case 'EvidenceUnavailable':
      return 'startup evidence is unavailable'
    case 'RunMissing':
      return `durable run ${failure.runId} is missing`
    case 'TerminalQualificationMissing':
      return failure.observedState === null
        ? `terminal qualification ${failure.runId} is missing`
        : `qualification ${failure.runId} is ${failure.observedState}, expected TERMINAL`
    case 'RunMismatch':
      return `durable run ${failure.runId} hash ${failure.observedDurableHash} differs from active proof hash ${failure.expectedDurableHash}`
    case 'TerminalQualificationMismatch':
      return `terminal qualification ${failure.runId} hash ${failure.observedQualificationHash} differs from active proof hash ${failure.expectedQualificationHash}`
    case 'CanonicalizationFailed':
      return `canonicalization of ${failure.material} for run ${failure.runId} failed: ${String(failure.cause)}`
  }
  const exhaustive: never = failure
  return exhaustive
}

export const ensureDurableEvidence = (
  recovered: RecoveredEvaluationEvidence | null,
  qualification: QualificationRecord | null,
  evidence: RuntimeEvidence | null,
): Effect.Effect<void, OperationalError> =>
  Effect.mapError(
    Effect.fromResult(validateDurableEvidence(recovered, qualification, evidence)),
    (failure) =>
      new OperationalError({
        component: 'database',
        operation: 'verify-evidence',
        message: `durable evidence verification failed: ${renderDurableEvidenceFailure(failure)}`,
        retryable: false,
        cause: failure,
      }),
  )

const dependencyHealth = <A>(result: ProbeResult<A>, checkedAt: string): DependencyHealth => ({
  status: result._tag === 'Available' ? 'AVAILABLE' : 'UNAVAILABLE',
  checkedAt,
  error: result._tag === 'Available' ? null : result.error,
})

const sampleAutonomousCycleFiber = (fiber: Fiber.Fiber<void, never> | undefined): AutonomousCycleFiberObservation => {
  if (fiber === undefined) return { _tag: 'NotProvided' }
  const exit = fiber.pollUnsafe()
  if (exit === undefined) return { _tag: 'Running' }
  if (Exit.isSuccess(exit)) return { _tag: 'ExitedSuccessfully' }
  return {
    _tag: 'ExitedWithFailure',
    error: probeFailureMessage(exit.cause, Cause.pretty(exit.cause)),
  }
}

const cycleLoopHealth = (
  loop: AutonomousCycleLoopStatus,
  fiber: AutonomousCycleFiberObservation,
  checkedAt: string,
  checkedAtMs: number,
  stallThresholdMs: number,
  required: boolean,
): DependencyHealth => {
  const available = (): DependencyHealth => ({ status: 'AVAILABLE', checkedAt, error: null })
  const unavailable = (error: string): DependencyHealth => ({ status: 'UNAVAILABLE', checkedAt, error })
  if (!loop.configured) {
    return required ? unavailable('broker-configured Bayn runtime has no autonomous cycle loop') : available()
  }
  if (fiber._tag === 'NotProvided') return unavailable('configured autonomous cycle loop has no scoped fiber')
  if (fiber._tag === 'ExitedSuccessfully') return unavailable('autonomous cycle loop exited unexpectedly')
  if (fiber._tag === 'ExitedWithFailure') return unavailable(`autonomous cycle loop failed: ${fiber.error}`)
  if (loop.lastPass?.result === 'FAILURE') {
    return unavailable(`${loop.lastPass.operation}/${loop.lastPass.failure}: ${loop.lastPass.message}`)
  }
  const progressAt = loop.lastPass?.observedAt ?? loop.startedAt
  if (progressAt === null) return unavailable('autonomous cycle loop start time is unavailable')
  const ageMs = checkedAtMs - Date.parse(progressAt)
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return unavailable('autonomous cycle loop progress time is invalid or in the future')
  }
  if (ageMs >= stallThresholdMs) {
    return unavailable(`autonomous cycle loop has not completed a successful pass for ${ageMs}ms`)
  }
  return available()
}

const brokerConfiguration = (broker: BrokerProbe | undefined): BrokerConfiguration | undefined =>
  broker === undefined
    ? undefined
    : {
        expectedAccountId: broker.expectedAccountId,
        executionEligible: broker.executionEligible,
        executionDisabledReason: broker.executionDisabledReason,
      }

const deriveBrokerStatus = (
  current: BrokerStatus | null,
  broker: BrokerConfiguration | undefined,
  result: ProbeResult<string> | null,
  checkedAt: string,
): BrokerStatus | null => {
  if (broker === undefined) return current
  const observed = result ?? { _tag: 'Unavailable', error: 'broker probe did not run' }
  const accountId = observed._tag === 'Available' ? observed.value : null
  const accountBound = observed._tag === 'Available' && accountId === broker.expectedAccountId
  const bindingError =
    observed._tag === 'Unavailable'
      ? observed.error
      : accountBound
        ? null
        : `Alpaca account probe resolved ${accountId}, expected ${broker.expectedAccountId}`
  return {
    configured: true,
    expectedAccountId: broker.expectedAccountId,
    accountId,
    accountBound,
    readAvailable: observed._tag === 'Available',
    checkedAt,
    error: bindingError,
    executionEligible: broker.executionEligible,
    executionDisabledReason: broker.executionDisabledReason,
  }
}

const deriveCycleStatus = (
  result: ProbeResult<CycleOperationsProjection>,
  config: RuntimeConfig,
  checkedAt: string,
  checkedAtMs: number,
): CycleOperationsStatus => {
  if (result._tag === 'Available') {
    return deriveCycleOperationsStatus(result.value, checkedAtMs, config.maximumAuthority, config)
  }
  return { ...unknownCycleOperationsStatus(result.error), checkedAt }
}

const deriveRuntimeHealth = (
  current: RuntimeState,
  results: HealthProbeResults,
  cycleRunner: DependencyHealth,
  checkedAt: string,
): RuntimeHealth => ({
  sequence: current.health.sequence + 1,
  checkedAt,
  dependencies: {
    postgresql: dependencyHealth(results.postgresql, checkedAt),
    signal: dependencyHealth(results.signal, checkedAt),
    tigerBeetle: dependencyHealth(results.tigerBeetle, checkedAt),
    evidence: dependencyHealth(results.durableEvidence, checkedAt),
    cycle: dependencyHealth(results.cycle, checkedAt),
    cycleRunner,
  },
})

const summarizeHealthFailures = (
  health: RuntimeHealth,
  broker: BrokerStatus | null,
  cycle: CycleOperationsStatus,
): HealthFailureSummary => {
  const dependencyFailures = (
    Object.entries(health.dependencies) as readonly [keyof RuntimeHealth['dependencies'], DependencyHealth][]
  ).filter(([, dependency]) => dependency.error !== null)
  const dependencyNames = dependencyFailures.map(([name]) => name)
  const brokerFailure =
    broker !== null && (broker.error !== null || broker.accountBound !== true || broker.readAvailable !== true)
      ? `broker: ${broker.error ?? 'account binding unavailable'}`
      : null
  const cycleFailure =
    cycle.condition === CycleOperationsCondition.Stalled || cycle.condition === CycleOperationsCondition.Failed
      ? `cycle: ${cycle.reason}`
      : null
  const brokerDependencies: readonly HealthDependencyName[] = brokerFailure === null ? [] : ['broker']
  const cycleDependencies: readonly HealthDependencyName[] =
    cycleFailure === null || dependencyNames.includes('cycle') ? [] : ['cycle']
  return {
    failedDependencies: [...dependencyNames, ...brokerDependencies, ...cycleDependencies],
    messages: [
      ...dependencyFailures.map(([name, dependency]) => `${name}: ${dependency.error}`),
      ...(brokerFailure === null ? [] : [brokerFailure]),
      ...(cycleFailure === null ? [] : [cycleFailure]),
    ],
  }
}

const deriveNextRuntimeState = (
  current: RuntimeState,
  evidenceAvailable: boolean,
  health: RuntimeHealth,
  cycle: CycleOperationsStatus,
  broker: BrokerStatus | null,
  failures: HealthFailureSummary,
): RuntimeState => {
  if (!evidenceAvailable) return { ...current, health, cycle, broker }
  if (failures.messages.length === 0) {
    return { ...current, status: 'READY', health, cycle, broker, error: null }
  }
  return { ...current, status: 'DEGRADED', health, cycle, broker, error: failures.messages.join('; ') }
}

export const deriveHealthTransition = (current: RuntimeState, input: HealthTransitionInput): HealthTransition => {
  const cycleRunner = cycleLoopHealth(
    current.autonomousCycleLoop,
    input.cycleFiber,
    input.checkedAt,
    input.checkedAtMs,
    input.config.cycleStallThresholdMs,
    input.broker !== undefined,
  )
  const cycle = deriveCycleStatus(input.results.cycle, input.config, input.checkedAt, input.checkedAtMs)
  const broker = deriveBrokerStatus(current.broker, input.broker, input.results.broker, input.checkedAt)
  const health = deriveRuntimeHealth(current, input.results, cycleRunner, input.checkedAt)
  const failures = summarizeHealthFailures(health, broker, cycle)
  const next = deriveNextRuntimeState(current, input.evidenceAvailable, health, cycle, broker, failures)
  return {
    current,
    next,
    health,
    failedDependencies: failures.failedDependencies,
    checkedAt: input.checkedAt,
  }
}

const runtimeStatusLogDecision = (transition: HealthTransition): HealthLogDecision | null => {
  if (transition.next.status === transition.current.status) return null
  return {
    _tag: 'RuntimeStatusChanged',
    level: transition.next.status === 'READY' ? 'INFO' : 'WARNING',
    message: `Bayn health changed to ${transition.next.status}`,
    annotations: {
      service: 'bayn',
      checkedAt: transition.checkedAt,
      probeSequence: transition.health.sequence,
      failedDependencies: transition.failedDependencies.join(','),
    },
  }
}

const cycleOperationsLogDecision = (transition: HealthTransition): HealthLogDecision | null => {
  if (
    transition.next.cycle.condition === transition.current.cycle.condition &&
    transition.next.cycle.reason === transition.current.cycle.reason
  ) {
    return null
  }
  const cycle = transition.next.cycle
  const observationAvailable = cycle.condition !== CycleOperationsCondition.Unknown
  return {
    _tag: 'CycleOperationsChanged',
    level:
      cycle.condition === CycleOperationsCondition.Stalled || cycle.condition === CycleOperationsCondition.Failed
        ? 'WARNING'
        : 'INFO',
    message: `Bayn cycle operations changed to ${cycle.condition}`,
    annotations: {
      service: 'bayn',
      checkedAt: transition.checkedAt,
      cycleCondition: cycle.condition,
      cycleReason: cycle.reason,
      currentCycleId: cycle.current?.cycleId ?? '',
      currentPhase: cycle.current?.phase ?? '',
      signalSessionDate: cycle.current?.signalSessionDate ?? '',
      submissionCutoffAt: cycle.current?.submissionCutoffAt ?? '',
      attemptAgeMs: cycle.attemptAgeMs ?? -1,
      unfinishedCycleCount: observationAvailable ? cycle.unfinishedCycleCount : 'unknown',
      unresolvedMutationCount: observationAvailable ? cycle.mutations.unresolvedCount : 'unknown',
      zeroMutation: observationAvailable ? (cycle.zeroMutation ?? 'unknown') : 'unknown',
    },
  }
}

export const deriveHealthLogDecisions = (transition: HealthTransition): readonly HealthLogDecision[] => {
  const runtimeStatus = runtimeStatusLogDecision(transition)
  const cycleOperations = cycleOperationsLogDecision(transition)
  return [...(runtimeStatus === null ? [] : [runtimeStatus]), ...(cycleOperations === null ? [] : [cycleOperations])]
}

const interpretHealthLogs = (decisions: readonly HealthLogDecision[]): Effect.Effect<void> =>
  Effect.forEach(
    decisions,
    (decision) => {
      const log = decision.level === 'INFO' ? Effect.logInfo : Effect.logWarning
      return log(decision.message).pipe(Effect.annotateLogs(decision.annotations))
    },
    { discard: true },
  )

const collectHealthProbeResults = (
  config: RuntimeConfig,
  evidence: RuntimeEvidence | null,
  marketData: MarketData['Service'],
  journal: Journal['Service'],
  evidenceStore: EvidenceStore['Service'],
  cycleObservability: CycleObservability['Service'],
  broker: BrokerProbe | undefined,
): Effect.Effect<HealthProbeResults, never> =>
  Effect.map(
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
                  ensureDurableEvidence(Option.getOrNull(recovered), Option.getOrNull(qualification), evidence),
                ),
              ),
        ),
        observe(
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
        broker === undefined ? Effect.succeed(null) : observeBroker(broker.read, config.operationTimeoutMs),
      ],
      { concurrency: 'unbounded' },
    ),
    ([postgresql, signal, tigerBeetle, durableEvidence, cycle, brokerResult]) => ({
      postgresql,
      signal,
      tigerBeetle,
      durableEvidence,
      cycle,
      broker: brokerResult,
    }),
  )

export const probe = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  autonomousCycleFiber?: Fiber.Fiber<void, never>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    const cycleObservability = yield* CycleObservability
    const initial = yield* Ref.get(state)
    const results = yield* collectHealthProbeResults(
      config,
      initial.evidence,
      marketData,
      journal,
      evidenceStore,
      cycleObservability,
      broker,
    )
    const checkedAtMs = yield* Clock.currentTimeMillis
    const checkedAt = new Date(checkedAtMs).toISOString()
    const cycleFiber = sampleAutonomousCycleFiber(autonomousCycleFiber)
    const transition = yield* Ref.modify(state, (current) => {
      const decision = deriveHealthTransition(current, {
        config,
        evidenceAvailable: initial.evidence !== null,
        results,
        broker: brokerConfiguration(broker),
        cycleFiber,
        checkedAt,
        checkedAtMs,
      })
      return [decision, decision.next] as const
    })
    yield* interpretHealthLogs(deriveHealthLogDecisions(transition))
  }).pipe(Effect.withLogSpan('health'))

export const monitor = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
  broker?: BrokerProbe,
  autonomousCycleFiber?: Fiber.Fiber<void, never>,
): Effect.Effect<void, never, MarketData | Journal | EvidenceStore | CycleObservability> =>
  probe(config, state, broker, autonomousCycleFiber).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.healthIntervalMs))),
    Effect.asVoid,
  )
