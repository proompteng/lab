import { Result } from 'effect'

import type { RuntimeConfig } from '../config'
import { historicalSandboxAuthority } from '../execution/legacy-authority'
import type { FinalizedSnapshotProvenance } from '../contracts'
import {
  CycleOperationsCondition,
  deriveCycleOperationsStatusResult,
  renderCycleOperationsStatusFailure,
  type CycleOperationsProjection,
  type CycleOperationsStatus,
  unknownCycleOperationsStatus,
} from '../cycle-observability'
import { Authority } from '../execution/contracts'
import type { QualificationRecord, RecoveredEvaluationEvidence } from '../db/evidence-store'
import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../hash'
import type {
  AutonomousCycleLoopStatus,
  BrokerConfiguration,
  BrokerStatus,
  DependencyHealth,
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
        runtime.paperActivation?._tag === 'Realized' || runtime.paperActivation?._tag === 'Completed'
          ? Authority.Paper
          : historicalSandboxAuthority(config.execution),
        config,
      ),
      {
        onFailure: (failure) => ({
          ...unknownCycleOperationsStatus(renderCycleOperationsStatusFailure(failure)),
          checkedAt: null,
        }),
        onSuccess: (status) => status,
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
  failures: HealthFailureSummary,
): RuntimeState => {
  if (!evidenceAvailable) return { ...current, health, cycle, broker }
  if (failures.messages.length === 0) {
    return { ...current, status: 'READY', health, cycle, broker, error: null }
  }
  return { ...current, status: 'DEGRADED', health, cycle, broker, error: failures.messages.join('; ') }
}

export const deriveHealthTransition = (current: RuntimeState, input: HealthTransitionInput): HealthTransition => {
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
    input.cycleFiber,
    input.clock,
    input.config.cycleStallThresholdMs,
    input.broker !== undefined,
  )
  const cycleObservation = publicCycleObservation(input.results.cycle)
  const cycle = deriveCycleStatus(cycleObservation, input.config, current, input.clock)
  const broker = deriveBrokerStatus(current.broker, input.broker, input.results.broker, checkedAt)
  const health = deriveRuntimeHealth(current, { ...input.results, cycle: cycleObservation }, cycleRunner, checkedAt)
  const failures = summarizeHealthFailures(health, broker, cycle, clockError)
  const next = deriveNextRuntimeState(current, input.evidenceAvailable, health, cycle, broker, failures)
  return {
    current,
    next,
    health,
    failedDependencies: failures.failedDependencies,
    checkedAt,
    clockFailure,
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
