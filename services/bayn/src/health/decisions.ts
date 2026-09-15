import { Result } from 'effect'

import type { RuntimeConfig } from '../config'
import {
  CycleOperationsCondition,
  deriveCycleOperationsStatusResult,
  renderCycleOperationsStatusFailure,
  type CycleOperationsProjection,
  type CycleOperationsStatus,
  unknownCycleOperationsStatus,
} from '../cycle/observability'
import { Authority } from '../execution/contracts'
import { executionControllerStatusHasCompletion } from '../execution/controller-status'
import type {
  AutonomousCycleLoopStatus,
  BrokerConfiguration,
  BrokerStatus,
  DependencyHealth,
  ExecutionControllerRuntimeStatus,
  RuntimeHealth,
  RuntimeState,
} from '../runtime-state'
import type {
  AutonomousCycleFiberObservation,
  BrokerHealthObservation,
  HealthDependencyName,
  HealthFailureSummary,
  HealthLogDecision,
  HealthProbeClock,
  HealthProbeResults,
  HealthTransition,
  HealthTransitionInput,
  ProbeResult,
} from './model'
import { Pipeable } from '../pipeable'

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
      return unavailable('Restate lifecycle has no configured execution-controller projection')
    }
    if (controllerResult._tag === 'Unavailable') {
      return unavailable(controllerResult.error)
    }
    const status = controllerResult.value
    if (status === null) return unavailable('Restate lifecycle has not completed its first durable pass')
    if (status.controllerKey !== controller.controllerKey) {
      return unavailable('Restate execution-controller projection identity differs from the configured controller')
    }
    if (status.planHash !== controller.planHash) {
      return unavailable('Restate execution-controller projection plan differs from the configured controller')
    }
    if (!status.active) return unavailable('Restate execution controller is durably inactive')
    if (!executionControllerStatusHasCompletion(status)) {
      return unavailable('Restate lifecycle has not completed its first durable pass')
    }
    if (loop.lastPass?.result === 'FAILURE') {
      return unavailable(`${loop.lastPass.operation}/${loop.lastPass.failure}: ${loop.lastPass.message}`)
    }
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

const deriveAutonomousCycleLoop = (
  current: AutonomousCycleLoopStatus,
  controller: ExecutionControllerRuntimeStatus | undefined,
): AutonomousCycleLoopStatus => {
  if (current.owner !== 'Restate' || controller?.readAvailable !== true || controller.status === null) return current
  const status = controller.status
  return executionControllerStatusHasCompletion(status) && status.lastPass !== undefined
    ? { ...current, lastPass: status.lastPass }
    : { ...current, lastPass: null }
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
  if (current.status === 'FAILED') return projected
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
  const cycleObservation = publicCycleObservation(input.results.cycle)
  const executionController = deriveExecutionControllerStatus(
    current.executionController,
    input.results.executionController,
    checkedAt,
  )
  const autonomousCycleLoop = deriveAutonomousCycleLoop(current.autonomousCycleLoop, executionController)
  const cycleRunner = cycleLoopHealth(
    current.health.dependencies.cycleRunner,
    autonomousCycleLoop,
    executionController,
    input.results.executionController,
    input.cycleFiber,
    input.clock,
    input.config.cycleStallThresholdMs,
    input.broker !== undefined,
  )
  const projectedCurrent: RuntimeState =
    executionController === undefined
      ? { ...current, autonomousCycleLoop }
      : { ...current, autonomousCycleLoop, executionController }
  const cycle = deriveCycleStatus(cycleObservation, input.config, projectedCurrent, input.clock)
  const broker = deriveBrokerStatus(current.broker, input.broker, input.results.broker, checkedAt)
  const health = deriveRuntimeHealth(current, { ...input.results, cycle: cycleObservation }, cycleRunner, checkedAt)
  const failures = summarizeHealthFailures(health, broker, cycle, clockError)
  const next = deriveNextRuntimeState(projectedCurrent, health, cycle, broker, executionController, failures)
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
