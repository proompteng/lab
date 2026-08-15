import { Result } from 'effect'

import type { RuntimeConfig } from '../config'
import type { FinalizedSnapshotProvenance } from '../contracts'
import {
  CycleOperationsCondition,
  CycleOperationsReason,
  deriveCycleOperationsStatusResult,
  renderCycleOperationsStatusFailure,
  type CycleOperationsProjection,
  type CycleOperationsStatus,
  unknownCycleOperationsStatus,
} from '../cycle/observability'
import { CycleState, CycleTerminalReason } from '../cycle'
import { CycleNotDueReason, type CycleRunResult } from '../cycle/runner/model'
import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'
import type { QualificationRecord, RecoveredEvaluationEvidence } from '../db/evidence-store'
import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../hash'
import type {
  AutonomousCycleLoopStatus,
  BrokerConfiguration,
  BrokerStatus,
  DependencyHealth,
  ExecutionControllerRuntimeStatus,
  RuntimeEvidence,
  RuntimeHealth,
  RuntimeState,
} from '../runtime-state'
import type {
  AutonomousCycleFiberObservation,
  BrokerHealthObservation,
  DurableEvidenceFailure,
  HealthDependencyName,
  HealthFailureSummary,
  HealthLogDecision,
  HealthProbeClock,
  HealthProbeResults,
  HealthTransition,
  HealthTransitionInput,
  ProbeResult,
  SignalIdentityFailure,
} from './model'
import { Pipeable } from '../pipeable'

export interface ResearchCapitalBootstrapPassObservation {
  readonly result: 'SUCCESS' | 'FAILURE'
  readonly outcome?: CycleRunResult['outcome']
  readonly notDueReason?: CycleNotDueReason
  readonly cadenceDecision?: {
    readonly signalSessionDate: string | null
    readonly executionSessionDate: string | null
  }
}

const observesMissedOrNewerBootstrap = (
  last: NonNullable<CycleOperationsStatus['last']>,
  cadence: NonNullable<ResearchCapitalBootstrapPassObservation['cadenceDecision']> | undefined,
): boolean => {
  if (cadence === undefined || cadence.signalSessionDate === null || cadence.executionSessionDate === null) return false
  const exact =
    cadence.signalSessionDate === last.signalSessionDate && cadence.executionSessionDate === last.executionSessionDate
  const newer =
    cadence.signalSessionDate > last.signalSessionDate && cadence.executionSessionDate > last.executionSessionDate
  return exact || newer
}

/**
 * A research activation that starts after its first publication deadline must wait for a newer publication. The
 * immutable missed cycle remains visible, but it is no longer an operational failure after a matching NOT_DUE pass
 * and fresh exact reconciliation prove that no mutation is pending. Every other blocked-cycle state remains failed.
 */
export const projectResearchCapitalBootstrapWaiting = (
  status: CycleOperationsStatus,
  enabled: boolean,
  lastPass: ResearchCapitalBootstrapPassObservation | null,
): CycleOperationsStatus => {
  const last = status.last
  const cadence = lastPass?.cadenceDecision
  if (
    !enabled ||
    status.condition !== CycleOperationsCondition.Failed ||
    status.reason !== CycleOperationsReason.LastCycleBlocked ||
    status.current !== null ||
    last?.phase !== CycleState.Blocked ||
    last.terminalReason !== CycleTerminalReason.MissedPublication ||
    status.authority?.maximum !== Authority.Execution ||
    status.authority.effective !== Authority.Execution ||
    status.authority.kill !== KillState.Clear ||
    status.reconciliation?.status !== ReconciliationStatus.Exact ||
    status.reconciliation.discrepancyCount !== 0 ||
    !status.reconciliation.coversLatestMutation ||
    status.mutations.unresolvedCount !== 0 ||
    lastPass?.result !== 'SUCCESS' ||
    lastPass.outcome !== 'NOT_DUE' ||
    lastPass.notDueReason !== CycleNotDueReason.StaleExecutionBootstrap ||
    !observesMissedOrNewerBootstrap(last, cadence)
  ) {
    return status
  }
  return {
    ...status,
    condition: CycleOperationsCondition.Waiting,
    reason: CycleOperationsReason.StaleExecutionBootstrapSkipped,
    alerts: { ...status.alerts, cycleFailed: false },
  }
}

const validateSignalIdentityDataFirst = (
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

export const validateSignalIdentity = Pipeable.dual(2, validateSignalIdentityDataFirst)

export const renderSignalIdentityFailure = (failure: SignalIdentityFailure): string => {
  switch (failure._tag) {
    case 'EvidenceUnavailable':
      return 'startup evidence is unavailable'
    case 'SnapshotMismatch':
      return `configured Signal snapshot ${failure.observedSnapshotId} differs from active run snapshot ${failure.expectedSnapshotId}`
    case 'PublicationMismatch':
      return `configured Signal publication ${failure.observedPublicationId} differs from active run publication ${failure.expectedPublicationId}`
  }
}

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
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): DurableEvidenceFailure => ({ _tag: 'CanonicalizationFailed', runId, material, cause }),
  )

const validateDurableEvidenceDataFirst = (
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

export const validateDurableEvidence = Pipeable.dual(3, validateDurableEvidenceDataFirst)

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
      return `canonicalization of ${failure.material} for run ${failure.runId} failed: ${renderCanonicalJsonFailure(failure.cause)}`
  }
}

const dependencyHealth = <A>(result: ProbeResult<A>, checkedAt: string | null): DependencyHealth => ({
  status: result._tag === 'Available' ? 'AVAILABLE' : 'UNAVAILABLE',
  checkedAt,
  error: result._tag === 'Available' ? null : result.error,
})

const redactCycleObservationError = (error: string): string =>
  error.includes('configured account ') && error.includes(' differs from the projected current or last cycle')
    ? 'configured account binding differs from the projected current or last cycle'
    : error

const publicCycleObservation = (
  result: ProbeResult<CycleOperationsProjection>,
): ProbeResult<CycleOperationsProjection> =>
  result._tag === 'Available'
    ? result
    : {
        _tag: 'Unavailable',
        error: redactCycleObservationError(result.error),
      }

const cycleLoopHealth = (
  previous: DependencyHealth,
  loop: AutonomousCycleLoopStatus,
  controller: ExecutionControllerRuntimeStatus | undefined,
  controllerResult: HealthProbeResults['executionController'],
  fiber: AutonomousCycleFiberObservation,
  clock: HealthProbeClock,
  stallThresholdMs: number,
  required: boolean,
): DependencyHealth => {
  const checkedAt = clock._tag === 'Available' ? clock.checkedAt : null
  const available = (): DependencyHealth => ({ status: 'AVAILABLE', checkedAt, error: null })
  const unavailable = (error: string): DependencyHealth => ({ status: 'UNAVAILABLE', checkedAt, error })
  if (!loop.configured) {
    return required ? unavailable('broker-configured Bayn runtime has no autonomous cycle loop') : available()
  }
  if (loop.owner === 'Restate') {
    if (controller === undefined || controllerResult === null || controllerResult === undefined) {
      return unavailable('Restate execution controller has no configured status projection')
    }
    if (controllerResult._tag === 'Unavailable') {
      return unavailable(controllerResult.error)
    }
    const status = controllerResult.value
    if (status === null) return unavailable('Restate execution controller has not completed its first durable pass')
    if (status.controllerKey !== controller.controllerKey) {
      return unavailable('Restate execution-controller projection identity differs from the configured controller')
    }
    if (status.planHash !== controller.planHash) {
      return unavailable('Restate execution-controller projection plan differs from the configured controller')
    }
    if (!status.active) return unavailable('Restate execution controller is durably inactive')
    const completedAtMs = Date.parse(status.completedAt)
    const nextDueAtMs = status.nextDueAt === undefined ? Number.NaN : Date.parse(status.nextDueAt)
    if (!Number.isFinite(completedAtMs) || !Number.isFinite(nextDueAtMs) || nextDueAtMs < completedAtMs) {
      return unavailable('Restate execution-controller projection has an invalid completion schedule')
    }
    if (clock._tag === 'Unavailable') return previous
    if (completedAtMs > clock.checkedAtMs) {
      return unavailable('Restate execution-controller completion time is in the future')
    }
    const overdueMs = clock.checkedAtMs - nextDueAtMs
    if (overdueMs >= stallThresholdMs) {
      return unavailable(`Restate execution controller is overdue by ${overdueMs}ms`)
    }
    return available()
  }
  if (fiber._tag === 'NotProvided') return unavailable('configured autonomous cycle loop has no scoped fiber')
  if (fiber._tag === 'ExitedSuccessfully') return unavailable('autonomous cycle loop exited unexpectedly')
  if (fiber._tag === 'ExitedWithFailure') return unavailable(`autonomous cycle loop failed: ${fiber.error}`)
  if (loop.lastPass?.result === 'FAILURE') {
    return unavailable(`${loop.lastPass.operation}/${loop.lastPass.failure}: ${loop.lastPass.message}`)
  }
  const progressAt = loop.lastPass?.observedAt ?? loop.startedAt
  if (progressAt === null) return unavailable('autonomous cycle loop start time is unavailable')
  if (clock._tag === 'Unavailable') return previous
  const ageMs = clock.checkedAtMs - Date.parse(progressAt)
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return unavailable('autonomous cycle loop progress time is invalid or in the future')
  }
  if (ageMs >= stallThresholdMs) {
    return unavailable(`autonomous cycle loop has not completed a successful pass for ${ageMs}ms`)
  }
  return available()
}

const deriveExecutionControllerStatus = (
  current: ExecutionControllerRuntimeStatus | undefined,
  result: HealthProbeResults['executionController'],
  checkedAt: string | null,
): ExecutionControllerRuntimeStatus | undefined => {
  if (current === undefined) return undefined
  if (result === null || result === undefined) {
    return {
      ...current,
      status: null,
      readAvailable: false,
      checkedAt,
      error: 'execution controller status probe did not run',
    }
  }
  return result._tag === 'Available'
    ? {
        ...current,
        status: result.value,
        readAvailable: true,
        checkedAt,
        error: null,
      }
    : {
        ...current,
        status: null,
        readAvailable: false,
        checkedAt,
        error: result.error,
      }
}

const deriveBrokerStatus = (
  current: BrokerStatus | null,
  broker: BrokerConfiguration | undefined,
  result: ProbeResult<BrokerHealthObservation> | null,
  checkedAt: string | null,
): BrokerStatus | null => {
  if (broker === undefined) return current
  const observed = result ?? { _tag: 'Unavailable', error: 'broker probe did not run' }
  const accountId = observed._tag === 'Available' ? observed.value.accountId : null
  const accountBound = observed._tag === 'Available' && accountId === broker.expectedAccountId
  const bindingError =
    observed._tag === 'Unavailable'
      ? observed.error
      : accountBound
        ? observed.value.permissionError
        : 'Alpaca account identity drift detected'
  return {
    configured: true,
    expectedAccountId: broker.expectedAccountId,
    accountId,
    accountBound,
    readAvailable: observed._tag === 'Available' && observed.value.permissionError === null,
    checkedAt,
    error: bindingError,
    executionEligible: broker.executionEligible,
    executionDisabledReason: broker.executionDisabledReason,
  }
}

const deriveCycleStatus = (
  result: ProbeResult<CycleOperationsProjection>,
  config: RuntimeConfig,
  runtime: RuntimeState,
  clock: HealthProbeClock,
): CycleOperationsStatus => {
  const clockError =
    clock._tag === 'Unavailable'
      ? renderCycleOperationsStatusFailure({
          _tag: 'CycleOperationsClockInvalid',
          nowMs: clock.observedAtMs,
          cause: clock.failure,
        })
      : null
  if (result._tag === 'Available') {
    if (clock._tag === 'Unavailable') return unknownCycleOperationsStatus(clockError)
    return Result.match(
      deriveCycleOperationsStatusResult(
        result.value,
        clock.checkedAtMs,
        runtime.capitalActivation?._tag === 'Realized' ? Authority.Execution : Authority.Observe,
        config,
      ),
      {
        onFailure: (failure) => ({
          ...unknownCycleOperationsStatus(renderCycleOperationsStatusFailure(failure)),
          checkedAt: null,
        }),
        onSuccess: (status) =>
          projectResearchCapitalBootstrapWaiting(
            status,
            runtime.capitalActivation?._tag === 'Realized' && runtime.capitalActivation.grant === 'Research',
            runtime.autonomousCycleLoop.lastPass,
          ),
      },
    )
  }
  return {
    ...unknownCycleOperationsStatus(clockError === null ? result.error : `${result.error}; ${clockError}`),
    checkedAt: clock._tag === 'Available' ? clock.checkedAt : null,
  }
}

const deriveRuntimeHealth = (
  current: RuntimeState,
  results: HealthProbeResults,
  cycleRunner: DependencyHealth,
  checkedAt: string | null,
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
  clockError: string | null,
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
    dependencyNames.includes('cycle') || (clockError !== null && cycle.error === clockError)
      ? null
      : cycle.error !== null
        ? `cycle: ${cycle.error}`
        : cycle.condition === CycleOperationsCondition.Stalled || cycle.condition === CycleOperationsCondition.Failed
          ? `cycle: ${cycle.reason}`
          : null
  const brokerDependencies: readonly HealthDependencyName[] = brokerFailure === null ? [] : ['broker']
  const cycleDependencies: readonly HealthDependencyName[] = cycleFailure === null ? [] : ['cycle']
  const clockDependencies: readonly HealthDependencyName[] = clockError === null ? [] : ['cycle']
  return {
    failedDependencies: [
      ...new Set([...dependencyNames, ...brokerDependencies, ...cycleDependencies, ...clockDependencies]),
    ],
    messages: [
      ...dependencyFailures.map(([name, dependency]) => `${name}: ${dependency.error}`),
      ...(brokerFailure === null ? [] : [brokerFailure]),
      ...(cycleFailure === null ? [] : [cycleFailure]),
      ...(clockError === null ? [] : [`cycle clock: ${clockError}`]),
    ],
  }
}

const deriveNextRuntimeState = (
  current: RuntimeState,
  evidenceAvailable: boolean,
  health: RuntimeHealth,
  cycle: CycleOperationsStatus,
  broker: BrokerStatus | null,
  executionController: ExecutionControllerRuntimeStatus | undefined,
  failures: HealthFailureSummary,
): RuntimeState => {
  const projected =
    executionController === undefined
      ? { ...current, health, cycle, broker }
      : { ...current, health, cycle, broker, executionController }
  if (!evidenceAvailable) return projected
  if (failures.messages.length === 0) {
    return { ...projected, status: 'READY', error: null }
  }
  return {
    ...projected,
    status: 'DEGRADED',
    error: failures.messages.join('; '),
  }
}

const deriveHealthTransitionDataFirst = (current: RuntimeState, input: HealthTransitionInput): HealthTransition => {
  const checkedAt = input.clock._tag === 'Available' ? input.clock.checkedAt : null
  const clockFailure = input.clock._tag === 'Unavailable' ? input.clock.failure : null
  const clockError =
    input.clock._tag === 'Unavailable'
      ? renderCycleOperationsStatusFailure({
          _tag: 'CycleOperationsClockInvalid',
          nowMs: input.clock.observedAtMs,
          cause: input.clock.failure,
        })
      : null
  const cycleRunner = cycleLoopHealth(
    current.health.dependencies.cycleRunner,
    current.autonomousCycleLoop,
    current.executionController,
    input.results.executionController,
    input.cycleFiber,
    input.clock,
    input.config.cycleStallThresholdMs,
    input.broker !== undefined,
  )
  const cycleObservation = publicCycleObservation(input.results.cycle)
  const cycle = deriveCycleStatus(cycleObservation, input.config, current, input.clock)
  const broker = deriveBrokerStatus(current.broker, input.broker, input.results.broker, checkedAt)
  const executionController = deriveExecutionControllerStatus(
    current.executionController,
    input.results.executionController,
    checkedAt,
  )
  const health = deriveRuntimeHealth(current, { ...input.results, cycle: cycleObservation }, cycleRunner, checkedAt)
  const failures = summarizeHealthFailures(health, broker, cycle, clockError)
  const next = deriveNextRuntimeState(
    current,
    input.evidenceAvailable,
    health,
    cycle,
    broker,
    executionController,
    failures,
  )
  return {
    current,
    next,
    health,
    failedDependencies: failures.failedDependencies,
    checkedAt,
    clockFailure,
  }
}

export const deriveHealthTransition = Pipeable.dual(2, deriveHealthTransitionDataFirst)

const runtimeStatusLogDecision = (transition: HealthTransition): HealthLogDecision | null => {
  if (transition.next.status === transition.current.status) return null
  return {
    _tag: 'RuntimeStatusChanged',
    level: transition.next.status === 'READY' ? 'INFO' : 'WARNING',
    message: `Bayn health changed to ${transition.next.status}`,
    annotations: {
      service: 'bayn',
      ...(transition.checkedAt === null ? {} : { checkedAt: transition.checkedAt }),
      probeSequence: transition.health.sequence,
      failedDependencies: transition.failedDependencies.join(','),
    },
  }
}

const cycleOperationsLogDecision = (transition: HealthTransition): HealthLogDecision | null => {
  if (
    transition.next.cycle.condition === transition.current.cycle.condition &&
    transition.next.cycle.reason === transition.current.cycle.reason &&
    transition.next.cycle.error === transition.current.cycle.error
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
      ...(transition.checkedAt === null ? {} : { checkedAt: transition.checkedAt }),
      cycleCondition: cycle.condition,
      cycleReason: cycle.reason,
      ...(cycle.error === null ? {} : { cycleError: cycle.error }),
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
