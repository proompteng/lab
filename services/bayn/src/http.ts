import { createServer } from 'node:http'

import { NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import { Clock, Deferred, Effect, Option, Ref, Result, Scope } from 'effect'
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import {
  CycleOperationsCondition,
  CycleOperationsReason,
  MonthEndCadenceCondition,
  MonthEndCadenceReason,
  projectAutonomousCycleCadenceObservation,
  retainedAutonomousCycleCadenceDecision,
  type AutonomousCycleCadenceFreshness,
} from './cycle/observability'
import { CycleState, CycleTerminalReason } from './cycle'
import { CycleNotDueReason } from './cycle/runner/model'
import type { DatabaseError, EvidenceStoreService } from './db/evidence-store'
import type { OperationalError } from './errors'
import { BrokerAccess, CapitalAuthorityKind } from './execution/authority'
import type { ExecutionPolicy } from './execution/configuration'
import { executionControllerStatusHasCompletion } from './execution/controller-status'
import { databaseOperation, withinDeadline } from './operations'
import { Authority, KillState, ReconciliationStatus } from './execution/contracts'
import { makeQualificationDiagnosisResult } from './qualification-diagnosis'
import { isReady, type DependencyHealth, type RuntimeState } from './runtime-state'
import { Pipeable } from './pipeable'

type ReadEvidence = EvidenceStoreService['read']

export type HttpResponseDecision =
  | {
      readonly _tag: 'Json'
      readonly body: unknown
      readonly status: number
      readonly headers?: Readonly<Record<string, string>>
    }
  | {
      readonly _tag: 'Text'
      readonly body: string
      readonly status: number
      readonly contentType: string
      readonly headers?: Readonly<Record<string, string>>
    }

export type HistoricalRunRequestDecision =
  | { readonly _tag: 'ReadEvidence'; readonly runId: string }
  | { readonly _tag: 'Respond'; readonly response: HttpResponseDecision }

const jsonDecision = (
  body: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): HttpResponseDecision => ({ _tag: 'Json', body, status, ...(headers === undefined ? {} : { headers }) })

const textDecision = (
  body: string,
  contentType: string,
  headers?: Readonly<Record<string, string>>,
): HttpResponseDecision => ({
  _tag: 'Text',
  body,
  status: 200,
  contentType,
  ...(headers === undefined ? {} : { headers }),
})

const verifiedState = (state: RuntimeState, dependency: DependencyHealth) => {
  if (state.evidence === null || dependency.status === 'UNKNOWN') return 'UNKNOWN'
  return dependency.status === 'AVAILABLE' ? 'CURRENT' : 'INVALID'
}

const accountingState = (state: RuntimeState) => {
  if (state.evidence === null || state.health.dependencies.tigerBeetle.status === 'UNKNOWN') return 'UNKNOWN'
  return state.health.dependencies.tigerBeetle.status === 'AVAILABLE' ? 'EXACT' : 'UNAVAILABLE'
}

const publicAuthority = (authority: Authority): 'execution' | 'observe' =>
  authority === Authority.Execution ? 'execution' : 'observe'

const brokerPresentationReason = (broker: NonNullable<RuntimeState['broker']>): string | null => {
  const identityMismatch =
    broker.accountBound === false &&
    (broker.readAvailable === true ||
      broker.error === 'Alpaca account identity drift detected' ||
      broker.error?.includes('Alpaca credential resolved account ') === true ||
      broker.error?.includes('Alpaca account probe resolved ') === true)
  if (identityMismatch) return 'BROKER_ACCOUNT_IDENTITY_MISMATCH'
  if (broker.accountBound === null || broker.readAvailable === null) return 'BROKER_STATUS_NOT_CHECKED'
  if (broker.error?.startsWith('Alpaca account permission drift detected') === true) {
    return 'BROKER_ACCOUNT_PERMISSION_DRIFT'
  }
  if (broker.readAvailable === false) return 'BROKER_READ_UNAVAILABLE'
  if (broker.accountBound === false) return 'BROKER_ACCOUNT_BINDING_UNAVAILABLE'
  return broker.error === null ? null : 'BROKER_STATUS_UNAVAILABLE'
}

const publicBrokerState = (state: RuntimeState) => {
  if (state.broker === null) {
    return {
      configured: false,
      accountBound: false,
      readAvailable: false,
      checkedAt: null,
      executionEligible: false,
      executionDisabledReason: 'ALPACA_NOT_CONFIGURED',
      reasonCode: 'ALPACA_NOT_CONFIGURED',
      error: null,
    } as const
  }
  const reasonCode = brokerPresentationReason(state.broker)
  return {
    configured: true,
    accountBound: state.broker.accountBound,
    readAvailable: state.broker.readAvailable,
    checkedAt: state.broker.checkedAt,
    executionEligible: state.broker.executionEligible,
    executionDisabledReason: state.broker.executionDisabledReason,
    reasonCode,
    error: state.broker.error === null ? null : reasonCode,
  } as const
}

const cyclePresentationReason = (error: string | null): string | null => {
  if (error === null) return null
  return error.includes('configured account ') && error.includes(' differs from the projected current or last cycle')
    ? 'CYCLE_ACCOUNT_IDENTITY_MISMATCH'
    : 'CYCLE_OBSERVATION_UNAVAILABLE'
}

const publicDependencies = (state: RuntimeState) => ({
  ...state.health.dependencies,
  cycle: {
    ...state.health.dependencies.cycle,
    error: cyclePresentationReason(state.health.dependencies.cycle.error),
  },
  cycleRunner: {
    ...state.health.dependencies.cycleRunner,
    error: state.health.dependencies.cycleRunner.error === null ? null : 'CYCLE_RUNNER_UNAVAILABLE',
  },
})

const autonomousCycleCadenceFreshness = (state: RuntimeState): AutonomousCycleCadenceFreshness => {
  const dependency = state.health.dependencies.cycleRunner
  if (dependency.status === 'AVAILABLE') return 'AVAILABLE'
  return dependency.error?.startsWith('autonomous cycle loop has not completed a successful pass for ') === true ||
    dependency.error?.startsWith('Restate execution controller is overdue by ') === true
    ? 'STALE'
    : 'UNAVAILABLE'
}

const autonomousCycleCadenceObservation = (state: RuntimeState) => {
  const lastPass = state.autonomousCycleLoop.lastPass
  const cadenceDecision = retainedAutonomousCycleCadenceDecision(lastPass)
  return projectAutonomousCycleCadenceObservation({
    configured: state.autonomousCycleLoop.configured,
    lastPassResult: lastPass?.result ?? null,
    lastPassOutcome: lastPass?.result === 'SUCCESS' ? lastPass.outcome : null,
    freshness: autonomousCycleCadenceFreshness(state),
    ...(lastPass?.cadence === undefined ? {} : { cadence: lastPass.cadence }),
    ...(cadenceDecision === undefined ? {} : { cadenceDecision }),
  })
}

const publicAutonomousCycleLoop = (state: RuntimeState) => {
  const lastPass = state.autonomousCycleLoop.lastPass
  return {
    configured: state.autonomousCycleLoop.configured,
    owner: state.autonomousCycleLoop.owner ?? 'Process',
    startedAt: state.autonomousCycleLoop.startedAt,
    cadence: autonomousCycleCadenceObservation(state),
    lastPass:
      lastPass === null
        ? null
        : lastPass.result === 'SUCCESS'
          ? {
              result: lastPass.result,
              observedAt: lastPass.observedAt,
              outcome: lastPass.outcome,
              ...(lastPass.cadence === undefined ? {} : { cadence: lastPass.cadence }),
              ...(lastPass.notDueReason === undefined ? {} : { notDueReason: lastPass.notDueReason }),
            }
          : {
              result: lastPass.result,
              observedAt: lastPass.observedAt,
              operation: lastPass.operation,
              failure: lastPass.failure,
              ...(lastPass.cadence === undefined ? {} : { cadence: lastPass.cadence }),
              reasonCode: 'AUTONOMOUS_CYCLE_PASS_FAILED',
            },
  } as const
}

const publicExecutionController = (state: RuntimeState) => {
  const controller = state.executionController
  if (controller === undefined) {
    return {
      configured: false,
      controllerKeyHash: null,
      readAvailable: false,
      checkedAt: null,
      status: null,
      reasonCode: 'EXECUTION_CONTROLLER_NOT_CONFIGURED',
    } as const
  }
  const reasonCode =
    controller.readAvailable === false
      ? 'EXECUTION_CONTROLLER_STATUS_UNAVAILABLE'
      : controller.status === null
        ? 'EXECUTION_CONTROLLER_STATUS_NOT_PROJECTED'
        : executionControllerStatusHasCompletion(controller.status)
          ? null
          : 'EXECUTION_CONTROLLER_FIRST_PASS_PENDING'
  return {
    configured: true,
    controllerKeyHash: controller.controllerKey,
    readAvailable: controller.readAvailable,
    checkedAt: controller.checkedAt,
    status:
      controller.status === null
        ? null
        : executionControllerStatusHasCompletion(controller.status)
          ? {
              active: controller.status.active,
              planHash: controller.status.planHash,
              epoch: controller.status.epoch,
              lastSequence: controller.status.lastSequence,
              lastOutcome: controller.status.lastOutcome,
              lastReceiptHash: controller.status.lastReceiptHash,
              completedAt: controller.status.completedAt,
              nextDueAt: controller.status.nextDueAt ?? null,
            }
          : {
              active: controller.status.active,
              planHash: controller.status.planHash,
              epoch: controller.status.epoch,
              lastSequence: null,
              lastOutcome: null,
              lastReceiptHash: null,
              completedAt: null,
              nextDueAt: null,
            },
    reasonCode,
  } as const
}

const healthFailurePrefixes = [
  'postgresql: ',
  'signal: ',
  'tigerBeetle: ',
  'evidence: ',
  'cycle: ',
  'cycleRunner: ',
  'broker: ',
  'cycle clock: ',
] as const

const publicCycleRunnerFailure = (error: string): string => {
  const prefix = 'cycleRunner: '
  const prefixedAt = error.startsWith(prefix) ? 0 : error.indexOf(`; ${prefix}`)
  if (prefixedAt === -1) return error
  const segmentStart = prefixedAt === 0 ? 0 : prefixedAt + 2
  const contentStart = segmentStart + prefix.length
  const nextSegment = healthFailurePrefixes.reduce((nearest, candidatePrefix) => {
    const candidate = error.indexOf(`; ${candidatePrefix}`, contentStart)
    return candidate === -1 || (nearest !== -1 && candidate >= nearest) ? nearest : candidate
  }, -1)
  return `${error.slice(0, segmentStart)}cycleRunner: CYCLE_RUNNER_UNAVAILABLE${
    nextSegment === -1 ? '' : error.slice(nextSegment)
  }`
}

const publicRuntimeError = (
  state: RuntimeState,
  broker: ReturnType<typeof publicBrokerState>,
  dependencies: ReturnType<typeof publicDependencies>,
): string | null => {
  if (state.error === null) return null
  let publicError = publicCycleRunnerFailure(state.error)
  const brokerError = state.broker?.error
  if (brokerError !== null && brokerError !== undefined) {
    publicError = publicError.replaceAll(brokerError, broker.error ?? 'BROKER_STATUS_UNAVAILABLE')
  }
  if (state.cycle.error !== null) {
    publicError = publicError.replaceAll(
      state.cycle.error,
      cyclePresentationReason(state.cycle.error) ?? 'CYCLE_OBSERVATION_UNAVAILABLE',
    )
  }
  const cycleDependencyError = state.health.dependencies.cycle.error
  if (cycleDependencyError !== null) {
    publicError = publicError.replaceAll(
      cycleDependencyError,
      dependencies.cycle.error ?? 'CYCLE_OBSERVATION_UNAVAILABLE',
    )
  }
  const cycleRunnerError = state.health.dependencies.cycleRunner.error
  if (cycleRunnerError !== null) {
    publicError = publicError.replaceAll(cycleRunnerError, dependencies.cycleRunner.error ?? 'CYCLE_RUNNER_UNAVAILABLE')
  }
  return publicError
}

const publicCycleSnapshot = (snapshot: RuntimeState['cycle']['current']) =>
  snapshot === null
    ? null
    : {
        cycleId: snapshot.cycleId,
        signalSessionDate: snapshot.signalSessionDate,
        executionSessionDate: snapshot.executionSessionDate,
        phase: snapshot.phase,
        snapshotId: snapshot.snapshotId,
        decisionHash: snapshot.decisionHash,
        terminalReason: snapshot.terminalReason,
        submissionOpenAt: snapshot.submissionOpenAt,
        submissionCutoffAt: snapshot.submissionCutoffAt,
        executionOpenAt: snapshot.executionOpenAt,
        executionCloseAt: snapshot.executionCloseAt,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        terminalAt: snapshot.terminalAt,
      }

const publicCycleReconciliation = (reconciliation: RuntimeState['cycle']['reconciliation']) =>
  reconciliation === null
    ? null
    : {
        reconciliationId: reconciliation.reconciliationId,
        status: reconciliation.status,
        discrepancyCount: reconciliation.discrepancyCount,
        reconciledAt: reconciliation.reconciledAt,
        coversLatestMutation: reconciliation.coversLatestMutation,
      }

const publicCycleState = (state: RuntimeState) =>
  state.cycle.condition === CycleOperationsCondition.Unknown
    ? {
        schemaVersion: state.cycle.schemaVersion,
        observationAvailable: false,
        condition: state.cycle.condition,
        reason: state.cycle.reason,
        checkedAt: state.cycle.checkedAt,
        zeroMutation: null,
        error: cyclePresentationReason(state.cycle.error),
      }
    : {
        ...state.cycle,
        current: publicCycleSnapshot(state.cycle.current),
        last: publicCycleSnapshot(state.cycle.last),
        reconciliation: publicCycleReconciliation(state.cycle.reconciliation),
        observationAvailable: true,
        error: cyclePresentationReason(state.cycle.error),
      }

const statusFactsDataFirst = (
  state: RuntimeState,
  execution: ExecutionPolicy,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  runtimeReady = isReady(state),
) => {
  const broker = publicBrokerState(state)
  const dependencies = publicDependencies(state)
  const capitalActivationRealized = state.capitalActivation?._tag === 'Realized'
  const effectiveBrokerAccess = capitalActivationRealized ? BrokerAccess.Mutation : BrokerAccess.ReadOnly
  const effectiveCapitalAuthority = capitalActivationRealized ? CapitalAuthorityKind.Granted : CapitalAuthorityKind.None
  const diagnosis =
    state.evidence === null
      ? null
      : makeQualificationDiagnosisResult(state.evidence.evaluation, state.evidence.qualification)
  const publicDiagnosis = diagnosis === null || Result.isFailure(diagnosis) ? null : diagnosis.success
  return {
    service: 'bayn',
    operational: {
      status: state.status,
      ready: runtimeReady,
      probeSequence: state.health.sequence,
      checkedAt: state.health.checkedAt,
    },
    dependencies,
    data: {
      status: verifiedState(state, state.health.dependencies.signal),
      input: state.evidence?.evaluation.input ?? null,
    },
    evidence: {
      status: verifiedState(state, state.health.dependencies.evidence),
      runId: state.evidence?.evaluation.runId ?? null,
      startupMode: state.evidence?.startupMode ?? null,
      persistence: state.evidence?.persistence ?? null,
    },
    economic: {
      verdict: state.evidence?.qualification.evaluationVerdict ?? null,
    },
    qualification: {
      verdict: state.evidence?.qualification.verdict ?? null,
      lockId: state.evidence?.qualification.lockId ?? null,
      resultHash: state.evidence?.qualification.resultHash ?? null,
      analysisHash: state.evidence?.qualification.analysis.analysisHash ?? null,
      candidateOrdinal: state.evidence?.qualification.analysis.candidateOrdinal ?? null,
      reasonCodes: state.evidence?.qualification.reasonCodes ?? [],
      diagnosis: publicDiagnosis,
      executionProvenance: state.evidence?.provenance ?? null,
    },
    accounting: {
      status: accountingState(state),
      reconciliation: state.evidence?.reconciliation ?? null,
    },
    cycle: publicCycleState(state),
    autonomousCycleLoop: publicAutonomousCycleLoop(state),
    executionController: publicExecutionController(state),
    capitalActivation: state.capitalActivation ?? { _tag: 'NotConfigured' },
    broker,
    authority: {
      brokerEnvironment: execution.brokerIdentity?.environment ?? null,
      brokerAccess: effectiveBrokerAccess,
      capitalAuthority: effectiveCapitalAuthority,
      durable:
        state.cycle.condition === CycleOperationsCondition.Unknown
          ? {
              available: false,
            }
          : state.cycle.authority === null
            ? {
                available: true,
                configured: false,
                maximum: null,
                effective: null,
                kill: null,
                reason: null,
                updatedAt: null,
              }
            : {
                available: true,
                configured: true,
                maximum: publicAuthority(state.cycle.authority.maximum),
                effective: publicAuthority(state.cycle.authority.effective),
                kill: state.cycle.authority.kill.toLowerCase(),
                reason: state.cycle.authority.reason,
                updatedAt: state.cycle.authority.updatedAt,
              },
      brokerOrders: effectiveBrokerAccess === BrokerAccess.Mutation,
      capitalPromotion: effectiveCapitalAuthority !== CapitalAuthorityKind.None,
    },
    build: {
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      verification: provenanceVerification,
    },
    error: publicRuntimeError(state, broker, dependencies),
  } as const
}

export const statusFacts = Pipeable.dual(4, statusFactsDataFirst)

const statusResponseDecisionDataFirst = (
  state: RuntimeState,
  execution: ExecutionPolicy,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
): HttpResponseDecision => jsonDecision(statusFacts(state, execution, provenance, provenanceVerification))

export const statusResponseDecision = Pipeable.dual(4, statusResponseDecisionDataFirst)

const appendFailure = (failures: readonly string[], name: string, failed: boolean): readonly string[] =>
  failed && !failures.includes(name) ? [...failures, name] : failures

export interface RuntimeHealthFreshnessInput {
  readonly nowMs: number
  readonly leaseMs: number
}

export const runtimeHealthFreshnessLeaseMs = (
  config: Pick<RuntimeConfig, 'healthIntervalMs' | 'operationTimeoutMs'>,
): number => {
  // A ready read-only status pass can legitimately spend one operation deadline
  // on its durable projection and another inside checkHealth before publishing a
  // new checkedAt. The schedule delay is measured between completed passes, so
  // the lease must cover that serialized interval + 2 operation deadlines.
  const leaseMs = config.healthIntervalMs + config.operationTimeoutMs * 2
  return Number.isSafeInteger(leaseMs) && leaseMs > 0 ? leaseMs : 0
}

export const runtimeHealthIsFresh = (state: RuntimeState, input: RuntimeHealthFreshnessInput): boolean => {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs <= 0
  ) {
    return false
  }
  const checkedAt = state.health.checkedAt
  if (checkedAt === null) return false
  const checkedAtMs = Date.parse(checkedAt)
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > input.nowMs) return false
  return input.nowMs - checkedAtMs < input.leaseMs
}

const runtimeReadyWithFreshness = (state: RuntimeState, freshness?: RuntimeHealthFreshnessInput): boolean =>
  isReady(state) && (freshness === undefined || runtimeHealthIsFresh(state, freshness))

export const readinessResponseDecision = (
  state: RuntimeState,
  freshness?: RuntimeHealthFreshnessInput,
): HttpResponseDecision => {
  const ready = runtimeReadyWithFreshness(state, freshness)
  const dependencyFailures = Object.entries(state.health.dependencies)
    .filter(([, dependency]) => dependency.status !== 'AVAILABLE')
    .map(([name]) => name)
  const brokerFailures = appendFailure(
    dependencyFailures,
    'broker',
    state.broker !== null && (state.broker.accountBound !== true || state.broker.readAvailable !== true),
  )
  const cycleFailures = appendFailure(
    brokerFailures,
    'cycle',
    state.cycle.condition === CycleOperationsCondition.Unknown ||
      state.cycle.condition === CycleOperationsCondition.Stalled ||
      state.cycle.condition === CycleOperationsCondition.Failed,
  )
  const cycleRunnerFailures = appendFailure(
    cycleFailures,
    'cycleRunner',
    state.autonomousCycleLoop.lastPass?.result === 'FAILURE',
  )
  const capitalActivationFailures = appendFailure(
    cycleRunnerFailures,
    'capitalActivation',
    state.capitalActivation?._tag === 'Pending',
  )
  const failedDependencies = appendFailure(
    capitalActivationFailures,
    'health',
    freshness !== undefined && !runtimeHealthIsFresh(state, freshness),
  )
  return jsonDecision(
    {
      ready,
      status: state.status,
      checkedAt: state.health.checkedAt,
      probeSequence: state.health.sequence,
      failedDependencies,
    },
    ready ? 200 : 503,
  )
}

export const validateHistoricalRunRequest = (runId: string | undefined): HistoricalRunRequestDecision =>
  runId !== undefined && /^[0-9a-f]{64}$/.test(runId)
    ? { _tag: 'ReadEvidence', runId }
    : { _tag: 'Respond', response: jsonDecision({ error: 'invalid_run_id' }, 400) }

export const historicalEvidenceResponseDecision = (stored: Option.Option<unknown>): HttpResponseDecision =>
  Option.match(stored, {
    onNone: () => jsonDecision({ error: 'evaluation_not_found' }, 404),
    onSome: (evidence) => jsonDecision(evidence),
  })

const historicalReadFailureDecisionDataFirst = (runId: string, error: OperationalError) =>
  ({
    response: jsonDecision({ error: 'evidence_unavailable' }, 503),
    log: {
      message: 'Bayn historical evidence read failed',
      cause: error,
      annotations: {
        service: 'bayn',
        runId,
        component: error.component,
        operation: error.operation,
        retryable: error.retryable,
        error: error.message,
      },
    },
  }) as const

export const historicalReadFailureDecision = Pipeable.dual(2, historicalReadFailureDecisionDataFirst)

const readHistoricalEvidenceDataFirst = <A, R>(
  read: Effect.Effect<Option.Option<A>, DatabaseError, R>,
  timeoutMs: number,
): Effect.Effect<Option.Option<A>, OperationalError, R> =>
  withinDeadline(databaseOperation(read, 'read-evidence'), timeoutMs, 'database', 'read-evidence')

export const readHistoricalEvidence = Pipeable.generic<
  <A, R>(
    timeoutMs: number,
  ) => (
    read: Effect.Effect<Option.Option<A>, DatabaseError, R>,
  ) => Effect.Effect<Option.Option<A>, OperationalError, R>,
  typeof readHistoricalEvidenceDataFirst
>(2, readHistoricalEvidenceDataFirst)

export const fallbackResponseDecision = (method: string): HttpResponseDecision =>
  method === 'GET'
    ? jsonDecision({ error: 'not_found' }, 404)
    : jsonDecision({ error: 'method_not_allowed' }, 405, { allow: 'GET' })

const prometheusLabel = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')

const prometheusNumber = (value: number): string => (Number.isFinite(value) ? String(value) : '0')

const microsToPrometheusDollars = (micros: string): string => {
  const value = BigInt(micros)
  const absolute = value < 0n ? -value : value
  const whole = absolute / 1_000_000n
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0')
  return `${value < 0n ? '-' : ''}${whole}.${fraction}`
}

const epochSeconds = (instant: string | null | undefined): number =>
  instant === null || instant === undefined ? 0 : Date.parse(instant) / 1_000

const booleanMetric = (value: boolean | null): number => (value === true ? 1 : 0)

export const executionSessionPreflightReady = (state: RuntimeState, runtimeReady = isReady(state)): boolean => {
  const current = state.cycle.current
  const controller = state.executionController
  return (
    runtimeReady &&
    current !== null &&
    current.phase === CycleState.Active &&
    current.snapshotId !== null &&
    state.capitalActivation?._tag === 'Realized' &&
    state.cycle.authority?.maximum === Authority.Execution &&
    state.cycle.authority.effective === Authority.Execution &&
    state.cycle.authority.kill === KillState.Clear &&
    state.cycle.reconciliation?.status === ReconciliationStatus.Exact &&
    state.cycle.reconciliationCoversLatestMutation === true &&
    state.cycle.mutations.unresolvedCount === 0 &&
    state.broker?.readAvailable === true &&
    state.broker.accountBound === true &&
    controller?.readAvailable === true &&
    controller.status?.active === true
  )
}

const renderPrometheusMetricsDataFirst = (
  state: RuntimeState,
  config: Pick<
    RuntimeConfig,
    'cycleStallThresholdMs' | 'execution' | 'reconciliationStaleThresholdMs' | 'unknownMutationThresholdMs'
  >,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  runtimeReadyOverride?: boolean,
): string => {
  const publicBroker = publicBrokerState(state)
  const runtimeReady = runtimeReadyOverride ?? isReady(state)
  const cycleObservationAvailable = state.cycle.condition !== CycleOperationsCondition.Unknown
  const cyclePhase =
    cycleObservationAvailable === false
      ? 'unknown'
      : (state.cycle.current?.phase ?? state.cycle.last?.phase ?? 'none').toLowerCase()
  const conditions = Object.values(CycleOperationsCondition)
  const reasons = Object.values(CycleOperationsReason)
  const phases = ['unknown', 'none', ...Object.values(CycleState).map((phase) => phase.toLowerCase())]
  const terminalReasons = [
    'unknown',
    'none',
    ...Object.values(CycleTerminalReason).map((reason) => reason.toLowerCase()),
  ]
  const cycleTerminalReason =
    cycleObservationAvailable === false ? 'unknown' : (state.cycle.last?.terminalReason?.toLowerCase() ?? 'none')
  const cycleDecisionBound =
    state.cycle.current?.decisionHash !== null && state.cycle.current?.decisionHash !== undefined
  const sessionPreflightReady = executionSessionPreflightReady(state, runtimeReady)
  const loopResults = ['unknown', 'success', 'failure'] as const
  const loopResult = state.autonomousCycleLoop.lastPass?.result.toLowerCase() ?? 'unknown'
  const notDueReasons = ['unknown', 'none', ...Object.values(CycleNotDueReason).map((reason) => reason.toLowerCase())]
  const loopNotDueReason =
    state.autonomousCycleLoop.lastPass?.result === 'SUCCESS' && state.autonomousCycleLoop.lastPass.outcome === 'NOT_DUE'
      ? (state.autonomousCycleLoop.lastPass.notDueReason?.toLowerCase() ?? 'unknown')
      : 'none'
  const capitalActivationRealized = state.capitalActivation?._tag === 'Realized'
  const effectiveBrokerMutation = capitalActivationRealized
  const effectiveCapitalPromotion = capitalActivationRealized
  const capitalActivationState =
    state.capitalActivation?._tag === 'NotConfigured' || state.capitalActivation === undefined
      ? 'not_configured'
      : state.capitalActivation._tag.toLowerCase()
  const capitalActivationStates = ['not_configured', 'pending', 'realized', 'completed'] as const
  const cadence = autonomousCycleCadenceObservation(state)
  const cadenceConditions = Object.values(MonthEndCadenceCondition)
  const cadenceReasons = Object.values(MonthEndCadenceReason)
  const nextEligibilityStatuses = ['proven', 'unknown'] as const
  const loopHealthy =
    state.autonomousCycleLoop.configured &&
    state.health.dependencies.cycleRunner.status === 'AVAILABLE' &&
    state.autonomousCycleLoop.lastPass?.result !== 'FAILURE'
  const loopLastPassAgeMs =
    state.autonomousCycleLoop.lastPass === null || state.health.checkedAt === null
      ? undefined
      : Math.max(0, Date.parse(state.health.checkedAt) - Date.parse(state.autonomousCycleLoop.lastPass.observedAt))
  const executionController = state.executionController
  const executionControllerOutcomes = ['unknown', 'completed', 'blocked'] as const
  const executionControllerStatus = executionController?.status
  const executionControllerCompletion =
    executionControllerStatus !== null &&
    executionControllerStatus !== undefined &&
    executionControllerStatusHasCompletion(executionControllerStatus)
      ? executionControllerStatus
      : undefined
  const executionControllerOutcome = executionControllerCompletion?.lastOutcome.toLowerCase() ?? 'unknown'
  const effectiveAuthority =
    state.cycle.authority === null ? 'unknown' : publicAuthority(state.cycle.authority.effective)
  const capitalActivationRecoveryOnly =
    capitalActivationRealized &&
    state.cycle.authority?.maximum === Authority.Execution &&
    state.cycle.authority.effective === Authority.Observe &&
    state.cycle.alerts.killActive
  const executionFunnel = state.cycle.execution
  const cycleDecision = executionFunnel?.decision ?? null
  const economics = state.cycle.economics
  const accounting = economics?.accounting
  const forwardPerformance = economics?.forwardPerformance ?? null
  const accountingState =
    accounting === undefined
      ? undefined
      : accounting.fillCount === 0 && accounting.transactionCount === 0
        ? 'idle'
        : accounting.unaccountedFillCount === 0 && accounting.unreceiptedTransactionCount === 0
          ? 'exact'
          : 'gap'
  const forwardPerformanceEvidenceStatuses = ['sufficient', 'insufficient_evidence'] as const
  const forwardPerformanceProfitabilities = ['profitable', 'not_profitable', 'undetermined'] as const
  const forwardPerformanceTotalCostsMicros =
    forwardPerformance?.brokerExecutionFeesMicros === null ||
    forwardPerformance?.brokerExecutionFeesMicros === undefined ||
    forwardPerformance.otherChargedCostsMicros === null
      ? null
      : (
          BigInt(forwardPerformance.brokerExecutionFeesMicros) + BigInt(forwardPerformance.otherChargedCostsMicros)
        ).toString()
  const lines = [
    '# HELP bayn_runtime_ready Whether the bounded runtime state and required dependencies are operationally ready.',
    '# TYPE bayn_runtime_ready gauge',
    `bayn_runtime_ready ${runtimeReady ? 1 : 0}`,
    ...(state.health.checkedAt === null
      ? []
      : [
          '# HELP bayn_runtime_projection_timestamp_seconds Observation time of the runtime projection rendered by this scrape.',
          '# TYPE bayn_runtime_projection_timestamp_seconds gauge',
          `bayn_runtime_projection_timestamp_seconds ${prometheusNumber(epochSeconds(state.health.checkedAt))}`,
        ]),
    '# HELP bayn_cycle_observation_available Whether the bounded PostgreSQL cycle projection is current.',
    '# TYPE bayn_cycle_observation_available gauge',
    `bayn_cycle_observation_available ${cycleObservationAvailable ? 1 : 0}`,
    '# HELP bayn_cycle_condition Current bounded autonomous-cycle operations condition.',
    '# TYPE bayn_cycle_condition gauge',
    ...conditions.map(
      (condition) =>
        `bayn_cycle_condition{condition="${condition.toLowerCase()}"} ${state.cycle.condition === condition ? 1 : 0}`,
    ),
    '# HELP bayn_cycle_reason Current bounded autonomous-cycle operations reason.',
    '# TYPE bayn_cycle_reason gauge',
    ...reasons.map(
      (reason) => `bayn_cycle_reason{reason="${reason.toLowerCase()}"} ${state.cycle.reason === reason ? 1 : 0}`,
    ),
    '# HELP bayn_cycle_phase Current unfinished cycle phase, or the latest terminal phase when idle.',
    '# TYPE bayn_cycle_phase gauge',
    ...phases.map((phase) => `bayn_cycle_phase{phase="${phase}"} ${cyclePhase === phase ? 1 : 0}`),
    '# HELP bayn_cycle_terminal_reason Exact bounded terminal reason of the latest cycle.',
    '# TYPE bayn_cycle_terminal_reason gauge',
    ...terminalReasons.map(
      (reason) => `bayn_cycle_terminal_reason{reason="${reason}"} ${cycleTerminalReason === reason ? 1 : 0}`,
    ),
    ...(cycleObservationAvailable
      ? [
          '# HELP bayn_cycle_unfinished_count Number of unfinished cycles for the bound qualification run.',
          '# TYPE bayn_cycle_unfinished_count gauge',
          `bayn_cycle_unfinished_count ${state.cycle.unfinishedCycleCount}`,
          '# HELP bayn_cycle_attempt_age_seconds Age of the current cycle state transition.',
          '# TYPE bayn_cycle_attempt_age_seconds gauge',
          `bayn_cycle_attempt_age_seconds ${prometheusNumber((state.cycle.attemptAgeMs ?? 0) / 1_000)}`,
          '# HELP bayn_cycle_decision_bound Whether the current durable cycle has an immutable decision binding.',
          '# TYPE bayn_cycle_decision_bound gauge',
          `bayn_cycle_decision_bound ${cycleDecisionBound ? 1 : 0}`,
          '# HELP bayn_cycle_snapshot_bound Whether the current durable cycle has an immutable market-data snapshot binding.',
          '# TYPE bayn_cycle_snapshot_bound gauge',
          `bayn_cycle_snapshot_bound ${state.cycle.current?.snapshotId === null || state.cycle.current === null ? 0 : 1}`,
          '# HELP bayn_cycle_submission_open_timestamp_seconds Bound broker submission-open time.',
          '# TYPE bayn_cycle_submission_open_timestamp_seconds gauge',
          `bayn_cycle_submission_open_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.current?.submissionOpenAt))}`,
          '# HELP bayn_cycle_submission_cutoff_timestamp_seconds Bound broker submission cutoff.',
          '# TYPE bayn_cycle_submission_cutoff_timestamp_seconds gauge',
          `bayn_cycle_submission_cutoff_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.current?.submissionCutoffAt))}`,
          '# HELP bayn_cycle_execution_open_timestamp_seconds Bound current execution-session open.',
          '# TYPE bayn_cycle_execution_open_timestamp_seconds gauge',
          `bayn_cycle_execution_open_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.current?.executionOpenAt))}`,
          '# HELP bayn_cycle_execution_close_timestamp_seconds Bound current execution-session close.',
          '# TYPE bayn_cycle_execution_close_timestamp_seconds gauge',
          `bayn_cycle_execution_close_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.current?.executionCloseAt))}`,
          '# HELP bayn_cycle_last_terminal_timestamp_seconds Latest terminal cycle timestamp.',
          '# TYPE bayn_cycle_last_terminal_timestamp_seconds gauge',
          `bayn_cycle_last_terminal_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.last?.terminalAt))}`,
          ...(cycleDecision === null
            ? []
            : [
                '# HELP bayn_cycle_target_plan_info Exact target-plan status and bounded reason for the observed cycle.',
                '# TYPE bayn_cycle_target_plan_info gauge',
                `bayn_cycle_target_plan_info{status="${cycleDecision.targetPlanStatus.toLowerCase()}",reason="${prometheusLabel((cycleDecision.targetPlanReason ?? 'none').toLowerCase())}"} 1`,
                '# HELP bayn_cycle_decision_dispatchable Whether the observed decision is eligible for broker dispatch.',
                '# TYPE bayn_cycle_decision_dispatchable gauge',
                `bayn_cycle_decision_dispatchable ${cycleDecision.dispatchable ? 1 : 0}`,
                '# HELP bayn_cycle_decision_target_count Number of nonzero target deltas in the observed decision.',
                '# TYPE bayn_cycle_decision_target_count gauge',
                `bayn_cycle_decision_target_count ${cycleDecision.targetCount}`,
                '# HELP bayn_cycle_decision_ordered_intent_count Number of canonical ordered intents in the observed decision.',
                '# TYPE bayn_cycle_decision_ordered_intent_count gauge',
                `bayn_cycle_decision_ordered_intent_count ${cycleDecision.orderedIntentCount}`,
                '# HELP bayn_cycle_decision_timestamp_seconds Creation time of the observed immutable decision.',
                '# TYPE bayn_cycle_decision_timestamp_seconds gauge',
                `bayn_cycle_decision_timestamp_seconds ${prometheusNumber(epochSeconds(cycleDecision.createdAt))}`,
                ...(cycleDecision.marketDataObservedAt === null
                  ? []
                  : [
                      '# HELP bayn_cycle_decision_market_data_records Verified intraday market-data records bound to the observed decision.',
                      '# TYPE bayn_cycle_decision_market_data_records gauge',
                      `bayn_cycle_decision_market_data_records{kind="bars"} ${cycleDecision.barCount}`,
                      `bayn_cycle_decision_market_data_records{kind="quotes"} ${cycleDecision.quoteCount}`,
                      `bayn_cycle_decision_market_data_records{kind="trades"} ${cycleDecision.tradeCount}`,
                      '# HELP bayn_cycle_market_data_observed_timestamp_seconds Observation time of the market-data snapshot bound to the decision.',
                      '# TYPE bayn_cycle_market_data_observed_timestamp_seconds gauge',
                      `bayn_cycle_market_data_observed_timestamp_seconds ${prometheusNumber(epochSeconds(cycleDecision.marketDataObservedAt))}`,
                    ]),
                ...(cycleDecision.riskBlockReason === null
                  ? []
                  : [
                      '# HELP bayn_cycle_risk_block_info First bounded risk reason that stopped dispatch for the observed decision.',
                      '# TYPE bayn_cycle_risk_block_info gauge',
                      `bayn_cycle_risk_block_info{reason="${prometheusLabel(cycleDecision.riskBlockReason.toLowerCase())}"} 1`,
                    ]),
                '# HELP bayn_cycle_risk_block_reason_count Number of distinct risk reasons that stopped dispatch.',
                '# TYPE bayn_cycle_risk_block_reason_count gauge',
                `bayn_cycle_risk_block_reason_count ${cycleDecision.riskBlockReasonCount}`,
              ]),
        ]
      : []),
    '# HELP bayn_cycle_stall_threshold_seconds Configured attempt-stall threshold.',
    '# TYPE bayn_cycle_stall_threshold_seconds gauge',
    `bayn_cycle_stall_threshold_seconds ${prometheusNumber(config.cycleStallThresholdMs / 1_000)}`,
    '# HELP bayn_autonomous_cycle_loop_configured Whether autonomous cycle ownership is configured.',
    '# TYPE bayn_autonomous_cycle_loop_configured gauge',
    `bayn_autonomous_cycle_loop_configured ${state.autonomousCycleLoop.configured ? 1 : 0}`,
    '# HELP bayn_autonomous_cycle_owner Active durable scheduler owner for the Bayn lifecycle.',
    '# TYPE bayn_autonomous_cycle_owner gauge',
    ...(['process', 'restate'] as const).map(
      (owner) =>
        `bayn_autonomous_cycle_owner{owner="${owner}"} ${(state.autonomousCycleLoop.owner ?? 'Process').toLowerCase() === owner ? 1 : 0}`,
    ),
    '# HELP bayn_autonomous_cycle_loop_health_available Whether the configured scoped loop is live and has not failed or stalled.',
    '# TYPE bayn_autonomous_cycle_loop_health_available gauge',
    `bayn_autonomous_cycle_loop_health_available ${loopHealthy ? 1 : 0}`,
    '# HELP bayn_execution_controller_configured Whether a durable Restate execution-controller projection is configured.',
    '# TYPE bayn_execution_controller_configured gauge',
    `bayn_execution_controller_configured ${executionController === undefined ? 0 : 1}`,
    '# HELP bayn_execution_controller_read_available Whether the controller projection was read successfully.',
    '# TYPE bayn_execution_controller_read_available gauge',
    `bayn_execution_controller_read_available ${booleanMetric(executionController?.readAvailable ?? null)}`,
    '# HELP bayn_execution_controller_active Whether the durable Restate execution controller is active.',
    '# TYPE bayn_execution_controller_active gauge',
    `bayn_execution_controller_active ${executionControllerStatus?.active === true ? 1 : 0}`,
    '# HELP bayn_execution_controller_last_outcome Latest durable controller outcome.',
    '# TYPE bayn_execution_controller_last_outcome gauge',
    ...executionControllerOutcomes.map(
      (outcome) =>
        `bayn_execution_controller_last_outcome{outcome="${outcome}"} ${executionControllerOutcome === outcome ? 1 : 0}`,
    ),
    ...(executionControllerStatus === null || executionControllerStatus === undefined
      ? []
      : [
          '# HELP bayn_execution_controller_epoch Active durable controller epoch.',
          '# TYPE bayn_execution_controller_epoch gauge',
          `bayn_execution_controller_epoch ${executionControllerStatus.epoch}`,
        ]),
    ...(executionControllerCompletion === undefined
      ? []
      : [
          '# HELP bayn_execution_controller_last_sequence Latest completed controller sequence.',
          '# TYPE bayn_execution_controller_last_sequence gauge',
          `bayn_execution_controller_last_sequence ${executionControllerCompletion.lastSequence}`,
          '# HELP bayn_execution_controller_last_completion_timestamp_seconds Latest durable controller completion time.',
          '# TYPE bayn_execution_controller_last_completion_timestamp_seconds gauge',
          `bayn_execution_controller_last_completion_timestamp_seconds ${prometheusNumber(epochSeconds(executionControllerCompletion.completedAt))}`,
          '# HELP bayn_execution_controller_next_due_timestamp_seconds Next durable controller due time.',
          '# TYPE bayn_execution_controller_next_due_timestamp_seconds gauge',
          `bayn_execution_controller_next_due_timestamp_seconds ${prometheusNumber(epochSeconds(executionControllerCompletion.nextDueAt))}`,
        ]),
    '# HELP bayn_autonomous_cycle_loop_last_pass Latest bounded autonomous cycle pass result.',
    '# TYPE bayn_autonomous_cycle_loop_last_pass gauge',
    ...loopResults.map(
      (result) => `bayn_autonomous_cycle_loop_last_pass{result="${result}"} ${loopResult === result ? 1 : 0}`,
    ),
    '# HELP bayn_autonomous_cycle_not_due_reason Exact bounded reason for the latest NOT_DUE pass.',
    '# TYPE bayn_autonomous_cycle_not_due_reason gauge',
    ...notDueReasons.map(
      (reason) => `bayn_autonomous_cycle_not_due_reason{reason="${reason}"} ${loopNotDueReason === reason ? 1 : 0}`,
    ),
    ...(state.autonomousCycleLoop.lastPass === null
      ? []
      : [
          '# HELP bayn_autonomous_cycle_loop_last_pass_timestamp_seconds Observation time of the latest cycle pass.',
          '# TYPE bayn_autonomous_cycle_loop_last_pass_timestamp_seconds gauge',
          `bayn_autonomous_cycle_loop_last_pass_timestamp_seconds ${prometheusNumber(epochSeconds(state.autonomousCycleLoop.lastPass.observedAt))}`,
          '# HELP bayn_autonomous_cycle_loop_last_pass_age_seconds Age of the latest cycle pass at the last health probe.',
          '# TYPE bayn_autonomous_cycle_loop_last_pass_age_seconds gauge',
          `bayn_autonomous_cycle_loop_last_pass_age_seconds ${prometheusNumber((loopLastPassAgeMs ?? 0) / 1_000)}`,
        ]),
    '# HELP bayn_autonomous_cycle_cadence_condition Exact bounded month-end cadence interpretation of the latest pass.',
    '# TYPE bayn_autonomous_cycle_cadence_condition gauge',
    ...cadenceConditions.map(
      (condition) =>
        `bayn_autonomous_cycle_cadence_condition{condition="${condition.toLowerCase()}"} ${cadence.condition === condition ? 1 : 0}`,
    ),
    '# HELP bayn_autonomous_cycle_cadence_reason Stable bounded reason for the latest cadence interpretation.',
    '# TYPE bayn_autonomous_cycle_cadence_reason gauge',
    ...cadenceReasons.map(
      (reason) =>
        `bayn_autonomous_cycle_cadence_reason{reason="${reason.toLowerCase()}"} ${cadence.reason === reason ? 1 : 0}`,
    ),
    '# HELP bayn_autonomous_cycle_next_eligibility Whether current retained evidence proves the next eligible session.',
    '# TYPE bayn_autonomous_cycle_next_eligibility gauge',
    ...nextEligibilityStatuses.map(
      (status) =>
        `bayn_autonomous_cycle_next_eligibility{status="${status}"} ${cadence.nextEligibility.status.toLowerCase() === status ? 1 : 0}`,
    ),
    ...(cycleObservationAvailable
      ? [
          '# HELP bayn_mutation_events_total Durable broker mutation event count.',
          '# TYPE bayn_mutation_events_total counter',
          `bayn_mutation_events_total ${state.cycle.mutations.eventCount}`,
          '# HELP bayn_mutation_recovery_found_events_total Durable broker recovery-found event count.',
          '# TYPE bayn_mutation_recovery_found_events_total counter',
          `bayn_mutation_recovery_found_events_total ${state.cycle.mutations.recoveryFoundCount}`,
          '# HELP bayn_unresolved_mutations Durable unresolved broker mutation count.',
          '# TYPE bayn_unresolved_mutations gauge',
          `bayn_unresolved_mutations ${state.cycle.mutations.unresolvedCount}`,
          '# HELP bayn_oldest_unresolved_mutation_age_seconds Age of the oldest unresolved broker mutation.',
          '# TYPE bayn_oldest_unresolved_mutation_age_seconds gauge',
          `bayn_oldest_unresolved_mutation_age_seconds ${prometheusNumber((state.cycle.oldestUnresolvedMutationAgeMs ?? 0) / 1_000)}`,
        ]
      : []),
    ...(cycleObservationAvailable && executionFunnel !== undefined
      ? [
          '# HELP bayn_execution_funnel_count Current or latest terminal cycle count by opportunity-to-fill stage.',
          '# TYPE bayn_execution_funnel_count gauge',
          `bayn_execution_funnel_count{stage="targets"} ${cycleDecision?.targetCount ?? 0}`,
          `bayn_execution_funnel_count{stage="intents"} ${executionFunnel.intentCount}`,
          `bayn_execution_funnel_count{stage="orders"} ${executionFunnel.orderCount}`,
          `bayn_execution_funnel_count{stage="fills"} ${executionFunnel.fillCount}`,
          '# HELP bayn_cycle_intents Current or latest terminal cycle intent count by durable state.',
          '# TYPE bayn_cycle_intents gauge',
          `bayn_cycle_intents{state="planned"} ${executionFunnel.plannedIntentCount}`,
          `bayn_cycle_intents{state="approved"} ${executionFunnel.approvedIntentCount}`,
          `bayn_cycle_intents{state="io_started"} ${executionFunnel.ioStartedIntentCount}`,
          `bayn_cycle_intents{state="acknowledged"} ${executionFunnel.acknowledgedIntentCount}`,
          `bayn_cycle_intents{state="unknown"} ${executionFunnel.unknownIntentCount}`,
          `bayn_cycle_intents{state="terminal"} ${executionFunnel.terminalIntentCount}`,
          `bayn_cycle_intents{state="recovered"} ${executionFunnel.recoveredIntentCount}`,
          '# HELP bayn_cycle_terminal_intents Current or latest terminal cycle intent count by terminal outcome.',
          '# TYPE bayn_cycle_terminal_intents gauge',
          `bayn_cycle_terminal_intents{outcome="filled"} ${executionFunnel.filledIntentCount}`,
          `bayn_cycle_terminal_intents{outcome="canceled"} ${executionFunnel.canceledIntentCount}`,
          `bayn_cycle_terminal_intents{outcome="expired"} ${executionFunnel.expiredIntentCount}`,
          `bayn_cycle_terminal_intents{outcome="rejected"} ${executionFunnel.rejectedIntentCount}`,
          `bayn_cycle_terminal_intents{outcome="blocked"} ${executionFunnel.blockedIntentCount}`,
          '# HELP bayn_cycle_orders Current or latest terminal cycle broker-order count by outcome group.',
          '# TYPE bayn_cycle_orders gauge',
          `bayn_cycle_orders{status="all"} ${executionFunnel.orderCount}`,
          `bayn_cycle_orders{status="open"} ${executionFunnel.openOrderCount}`,
          `bayn_cycle_orders{status="filled"} ${executionFunnel.filledOrderCount}`,
          `bayn_cycle_orders{status="canceled"} ${executionFunnel.canceledOrderCount}`,
          `bayn_cycle_orders{status="expired"} ${executionFunnel.expiredOrderCount}`,
          `bayn_cycle_orders{status="rejected"} ${executionFunnel.rejectedOrderCount}`,
          '# HELP bayn_cycle_fills Current or latest terminal cycle broker-fill count by side.',
          '# TYPE bayn_cycle_fills gauge',
          `bayn_cycle_fills{side="all"} ${executionFunnel.fillCount}`,
          `bayn_cycle_fills{side="buy"} ${executionFunnel.buyFillCount}`,
          `bayn_cycle_fills{side="sell"} ${executionFunnel.sellFillCount}`,
          ...(executionFunnel.latestIntentAt === null
            ? []
            : [
                '# HELP bayn_cycle_latest_intent_timestamp_seconds Latest current-cycle intent creation time.',
                '# TYPE bayn_cycle_latest_intent_timestamp_seconds gauge',
                `bayn_cycle_latest_intent_timestamp_seconds ${prometheusNumber(epochSeconds(executionFunnel.latestIntentAt))}`,
              ]),
          ...(executionFunnel.latestOrderAt === null
            ? []
            : [
                '# HELP bayn_cycle_latest_order_timestamp_seconds Latest current-cycle broker-order observation time.',
                '# TYPE bayn_cycle_latest_order_timestamp_seconds gauge',
                `bayn_cycle_latest_order_timestamp_seconds ${prometheusNumber(epochSeconds(executionFunnel.latestOrderAt))}`,
              ]),
          ...(executionFunnel.latestFillAt === null
            ? []
            : [
                '# HELP bayn_cycle_latest_fill_timestamp_seconds Latest current-cycle broker-fill observation time.',
                '# TYPE bayn_cycle_latest_fill_timestamp_seconds gauge',
                `bayn_cycle_latest_fill_timestamp_seconds ${prometheusNumber(epochSeconds(executionFunnel.latestFillAt))}`,
              ]),
          ...(executionFunnel.maximumOrderAcknowledgementLatencyMs === null
            ? []
            : [
                '# HELP bayn_cycle_order_acknowledgement_latency_seconds Maximum current-cycle intent-to-order acknowledgement latency.',
                '# TYPE bayn_cycle_order_acknowledgement_latency_seconds gauge',
                `bayn_cycle_order_acknowledgement_latency_seconds ${prometheusNumber(executionFunnel.maximumOrderAcknowledgementLatencyMs / 1_000)}`,
              ]),
          ...(executionFunnel.maximumFillLatencyMs === null
            ? []
            : [
                '# HELP bayn_cycle_fill_latency_seconds Maximum current-cycle intent-to-fill latency.',
                '# TYPE bayn_cycle_fill_latency_seconds gauge',
                `bayn_cycle_fill_latency_seconds ${prometheusNumber(executionFunnel.maximumFillLatencyMs / 1_000)}`,
              ]),
          ...(executionFunnel.positionSnapshotObservedAt === null ||
          executionFunnel.positionCount === null ||
          executionFunnel.grossExposureMicros === null ||
          executionFunnel.netExposureMicros === null ||
          executionFunnel.unrealizedPnlMicros === null
            ? []
            : [
                '# HELP bayn_broker_position_snapshot_observed_timestamp_seconds Observation time of the latest complete broker position snapshot.',
                '# TYPE bayn_broker_position_snapshot_observed_timestamp_seconds gauge',
                `bayn_broker_position_snapshot_observed_timestamp_seconds ${prometheusNumber(epochSeconds(executionFunnel.positionSnapshotObservedAt))}`,
                '# HELP bayn_broker_position_count Open positions in the latest complete broker position snapshot.',
                '# TYPE bayn_broker_position_count gauge',
                `bayn_broker_position_count ${executionFunnel.positionCount}`,
                '# HELP bayn_broker_gross_exposure_dollars Gross market exposure in the latest complete broker position snapshot.',
                '# TYPE bayn_broker_gross_exposure_dollars gauge',
                `bayn_broker_gross_exposure_dollars ${microsToPrometheusDollars(executionFunnel.grossExposureMicros)}`,
                '# HELP bayn_broker_net_exposure_dollars Net market exposure in the latest complete broker position snapshot.',
                '# TYPE bayn_broker_net_exposure_dollars gauge',
                `bayn_broker_net_exposure_dollars ${microsToPrometheusDollars(executionFunnel.netExposureMicros)}`,
                '# HELP bayn_broker_unrealized_pnl_dollars Unrealized PnL in the latest complete broker position snapshot.',
                '# TYPE bayn_broker_unrealized_pnl_dollars gauge',
                `bayn_broker_unrealized_pnl_dollars ${microsToPrometheusDollars(executionFunnel.unrealizedPnlMicros)}`,
              ]),
          ...(executionFunnel.cashMicros === null ||
          executionFunnel.equityMicros === null ||
          executionFunnel.buyingPowerMicros === null
            ? []
            : [
                '# HELP bayn_broker_account_dollars Latest broker account value by kind.',
                '# TYPE bayn_broker_account_dollars gauge',
                `bayn_broker_account_dollars{kind="cash"} ${microsToPrometheusDollars(executionFunnel.cashMicros)}`,
                `bayn_broker_account_dollars{kind="equity"} ${microsToPrometheusDollars(executionFunnel.equityMicros)}`,
                `bayn_broker_account_dollars{kind="buying_power"} ${microsToPrometheusDollars(executionFunnel.buyingPowerMicros)}`,
                '# HELP bayn_broker_account_observed_timestamp_seconds Observation time of the latest broker account snapshot.',
                '# TYPE bayn_broker_account_observed_timestamp_seconds gauge',
                `bayn_broker_account_observed_timestamp_seconds ${prometheusNumber(epochSeconds(executionFunnel.accountObservedAt))}`,
              ]),
        ]
      : []),
    '# HELP bayn_zero_mutation_confirmed Whether the current projection confirms zero durable mutation events.',
    '# TYPE bayn_zero_mutation_confirmed gauge',
    `bayn_zero_mutation_confirmed ${state.cycle.zeroMutation === true ? 1 : 0}`,
    '# HELP bayn_unknown_mutation_threshold_seconds Configured unresolved-mutation alert threshold.',
    '# TYPE bayn_unknown_mutation_threshold_seconds gauge',
    `bayn_unknown_mutation_threshold_seconds ${prometheusNumber(config.unknownMutationThresholdMs / 1_000)}`,
    ...(cycleObservationAvailable
      ? [
          '# HELP bayn_reconciliation_available Whether a complete reconciliation exists for the selected account.',
          '# TYPE bayn_reconciliation_available gauge',
          `bayn_reconciliation_available ${booleanMetric(state.cycle.reconciliation !== null)}`,
          '# HELP bayn_reconciliation_exact Whether the latest selected-account reconciliation is exact.',
          '# TYPE bayn_reconciliation_exact gauge',
          `bayn_reconciliation_exact ${booleanMetric(state.cycle.reconciliation?.status === 'EXACT')}`,
          '# HELP bayn_reconciliation_age_seconds Age of the latest selected-account reconciliation.',
          '# TYPE bayn_reconciliation_age_seconds gauge',
          `bayn_reconciliation_age_seconds ${prometheusNumber((state.cycle.reconciliationAgeMs ?? 0) / 1_000)}`,
          '# HELP bayn_reconciliation_covers_latest_mutation Whether reconciliation is at or after the latest selected-account mutation.',
          '# TYPE bayn_reconciliation_covers_latest_mutation gauge',
          `bayn_reconciliation_covers_latest_mutation ${booleanMetric(state.cycle.reconciliationCoversLatestMutation)}`,
        ]
      : []),
    '# HELP bayn_reconciliation_stale_threshold_seconds Configured reconciliation staleness threshold.',
    '# TYPE bayn_reconciliation_stale_threshold_seconds gauge',
    `bayn_reconciliation_stale_threshold_seconds ${prometheusNumber(config.reconciliationStaleThresholdMs / 1_000)}`,
    ...(economics === undefined || accounting === undefined
      ? []
      : [
          '# HELP bayn_accounting_activity_count Current durable broker and accounting activity count by kind.',
          '# TYPE bayn_accounting_activity_count gauge',
          `bayn_accounting_activity_count{kind="fills"} ${accounting.fillCount}`,
          `bayn_accounting_activity_count{kind="transactions"} ${accounting.transactionCount}`,
          `bayn_accounting_activity_count{kind="receipts"} ${accounting.receiptCount}`,
          `bayn_accounting_activity_count{kind="realized_closes"} ${accounting.realizedCloseCount}`,
          '# HELP bayn_accounting_uncovered Durable activity not yet covered by accounting persistence.',
          '# TYPE bayn_accounting_uncovered gauge',
          `bayn_accounting_uncovered{kind="fills"} ${accounting.unaccountedFillCount}`,
          `bayn_accounting_uncovered{kind="transactions"} ${accounting.unreceiptedTransactionCount}`,
          '# HELP bayn_accounting_state Current accounting activity coverage state.',
          '# TYPE bayn_accounting_state gauge',
          ...(['idle', 'exact', 'gap'] as const).map(
            (state) => `bayn_accounting_state{state="${state}"} ${accountingState === state ? 1 : 0}`,
          ),
          ...(accounting.fillCount === 0
            ? []
            : [
                '# HELP bayn_accounting_gross_realized_pnl_dollars Running gross realized PnL from durable accounting transactions.',
                '# TYPE bayn_accounting_gross_realized_pnl_dollars gauge',
                `bayn_accounting_gross_realized_pnl_dollars ${microsToPrometheusDollars(accounting.grossRealizedPnlMicros)}`,
                '# HELP bayn_accounting_execution_fees_dollars Running broker execution fees from durable accounting transactions.',
                '# TYPE bayn_accounting_execution_fees_dollars gauge',
                `bayn_accounting_execution_fees_dollars ${microsToPrometheusDollars(accounting.executionFeesMicros)}`,
                '# HELP bayn_accounting_net_realized_pnl_after_execution_fees_dollars Running realized PnL after recorded execution fees; terminal all-cost proof is separate.',
                '# TYPE bayn_accounting_net_realized_pnl_after_execution_fees_dollars gauge',
                `bayn_accounting_net_realized_pnl_after_execution_fees_dollars ${microsToPrometheusDollars(accounting.netRealizedPnlAfterExecutionFeesMicros)}`,
              ]),
          '# HELP bayn_forward_performance_receipt_available Whether an immutable terminal all-cost performance receipt exists.',
          '# TYPE bayn_forward_performance_receipt_available gauge',
          `bayn_forward_performance_receipt_available ${forwardPerformance === null ? 0 : 1}`,
          ...(forwardPerformance === null
            ? []
            : [
                '# HELP bayn_forward_performance_evidence Terminal performance evidence status.',
                '# TYPE bayn_forward_performance_evidence gauge',
                ...forwardPerformanceEvidenceStatuses.map(
                  (status) =>
                    `bayn_forward_performance_evidence{status="${status}"} ${forwardPerformance.evidenceStatus.toLowerCase() === status ? 1 : 0}`,
                ),
                '# HELP bayn_forward_performance_profitability Terminal profitability after all recorded costs.',
                '# TYPE bayn_forward_performance_profitability gauge',
                ...forwardPerformanceProfitabilities.map(
                  (profitability) =>
                    `bayn_forward_performance_profitability{profitability="${profitability}"} ${forwardPerformance.profitability.toLowerCase() === profitability ? 1 : 0}`,
                ),
                '# HELP bayn_forward_performance_accounting_exact Whether the terminal receipt proves exact accounting receipts and ledger replay.',
                '# TYPE bayn_forward_performance_accounting_exact gauge',
                `bayn_forward_performance_accounting_exact ${forwardPerformance.accountingReceiptsExact && forwardPerformance.ledgerExact ? 1 : 0}`,
                '# HELP bayn_forward_performance_completed_execution_count Completed executions in the terminal performance receipt.',
                '# TYPE bayn_forward_performance_completed_execution_count gauge',
                `bayn_forward_performance_completed_execution_count ${forwardPerformance.completedExecutionCount}`,
                '# HELP bayn_forward_performance_realized_close_count Realized closes in the terminal performance receipt.',
                '# TYPE bayn_forward_performance_realized_close_count gauge',
                `bayn_forward_performance_realized_close_count ${forwardPerformance.realizedCloseCount}`,
                '# HELP bayn_forward_performance_receipt_timestamp_seconds Terminal performance receipt creation time.',
                '# TYPE bayn_forward_performance_receipt_timestamp_seconds gauge',
                `bayn_forward_performance_receipt_timestamp_seconds ${prometheusNumber(epochSeconds(forwardPerformance.createdAt))}`,
                ...(forwardPerformance.grossRealizedPnlMicros === null
                  ? []
                  : [
                      '# HELP bayn_forward_performance_gross_realized_pnl_dollars Terminal gross realized PnL.',
                      '# TYPE bayn_forward_performance_gross_realized_pnl_dollars gauge',
                      `bayn_forward_performance_gross_realized_pnl_dollars ${microsToPrometheusDollars(forwardPerformance.grossRealizedPnlMicros)}`,
                    ]),
                ...(forwardPerformanceTotalCostsMicros === null
                  ? []
                  : [
                      '# HELP bayn_forward_performance_total_costs_dollars Terminal broker fees plus other charged costs.',
                      '# TYPE bayn_forward_performance_total_costs_dollars gauge',
                      `bayn_forward_performance_total_costs_dollars ${microsToPrometheusDollars(forwardPerformanceTotalCostsMicros)}`,
                    ]),
                ...(forwardPerformance.netRealizedPnlAfterCostsMicros === null
                  ? []
                  : [
                      '# HELP bayn_forward_performance_net_realized_pnl_after_costs_dollars Terminal net realized PnL after broker fees, other charged costs, and recorded cash yield.',
                      '# TYPE bayn_forward_performance_net_realized_pnl_after_costs_dollars gauge',
                      `bayn_forward_performance_net_realized_pnl_after_costs_dollars ${microsToPrometheusDollars(forwardPerformance.netRealizedPnlAfterCostsMicros)}`,
                    ]),
                ...(forwardPerformance.netRealizedReturnDecimal === null
                  ? []
                  : [
                      '# HELP bayn_forward_performance_net_realized_return_ratio Terminal net realized return after all recorded costs.',
                      '# TYPE bayn_forward_performance_net_realized_return_ratio gauge',
                      `bayn_forward_performance_net_realized_return_ratio ${forwardPerformance.netRealizedReturnDecimal}`,
                    ]),
              ]),
        ]),
    '# HELP bayn_broker_access Configured broker access capability.',
    '# TYPE bayn_broker_access gauge',
    `bayn_broker_access{access="read-only"} ${effectiveBrokerMutation ? 0 : 1}`,
    `bayn_broker_access{access="mutation"} ${effectiveBrokerMutation ? 1 : 0}`,
    '# HELP bayn_capital_authority Configured capital authority.',
    '# TYPE bayn_capital_authority gauge',
    ...Object.values(CapitalAuthorityKind).map(
      (authority) =>
        `bayn_capital_authority{authority="${authority}"} ${
          capitalActivationRealized
            ? authority === CapitalAuthorityKind.Granted
              ? 1
              : 0
            : config.execution.capitalAuthority._tag === authority
              ? 1
              : 0
        }`,
    ),
    ...(cycleObservationAvailable
      ? [
          '# HELP bayn_authority_effective Durable effective authority when initialized.',
          '# TYPE bayn_authority_effective gauge',
          ...(['unknown', 'observe', 'execution'] as const).map(
            (authority) =>
              `bayn_authority_effective{authority="${authority}"} ${effectiveAuthority === authority ? 1 : 0}`,
          ),
          '# HELP bayn_authority_coherent Whether durable and configured authority agree.',
          '# TYPE bayn_authority_coherent gauge',
          `bayn_authority_coherent ${state.cycle.alerts.authorityIncoherent ? 0 : 1}`,
          '# HELP bayn_authority_kill_active Whether the durable execution kill is active.',
          '# TYPE bayn_authority_kill_active gauge',
          `bayn_authority_kill_active ${state.cycle.alerts.killActive ? 1 : 0}`,
        ]
      : []),
    '# HELP bayn_broker_configured Whether an exact Alpaca account binding is configured.',
    '# TYPE bayn_broker_configured gauge',
    `bayn_broker_configured ${publicBroker.configured ? 1 : 0}`,
    '# HELP bayn_broker_read_available Whether the bounded Alpaca GET probe succeeds.',
    '# TYPE bayn_broker_read_available gauge',
    `bayn_broker_read_available ${booleanMetric(publicBroker.readAvailable)}`,
    '# HELP bayn_broker_account_bound Whether the observed Alpaca account matches the configured identity.',
    '# TYPE bayn_broker_account_bound gauge',
    `bayn_broker_account_bound ${booleanMetric(publicBroker.accountBound)}`,
    '# HELP bayn_broker_orders_enabled Whether broker mutation dispatch is enabled in this runtime.',
    '# TYPE bayn_broker_orders_enabled gauge',
    `bayn_broker_orders_enabled ${effectiveBrokerMutation ? 1 : 0}`,
    '# HELP bayn_capital_promotion_enabled Whether capital promotion is enabled in this runtime.',
    '# TYPE bayn_capital_promotion_enabled gauge',
    `bayn_capital_promotion_enabled ${effectiveCapitalPromotion ? 1 : 0}`,
    '# HELP bayn_capital_activation_state Current capital activation lifecycle state.',
    '# TYPE bayn_capital_activation_state gauge',
    ...capitalActivationStates.map(
      (activationState) =>
        `bayn_capital_activation_state{state="${activationState}"} ${capitalActivationState === activationState ? 1 : 0}`,
    ),
    '# HELP bayn_capital_activation_recovery_only Whether the realized capital runtime is restricted to recovery and close operations.',
    '# TYPE bayn_capital_activation_recovery_only gauge',
    `bayn_capital_activation_recovery_only ${capitalActivationRecoveryOnly ? 1 : 0}`,
    '# HELP bayn_execution_session_preflight_ready Whether durable execution, authority, reconciliation, broker, and controller prerequisites are ready for the current active session.',
    '# TYPE bayn_execution_session_preflight_ready gauge',
    `bayn_execution_session_preflight_ready ${sessionPreflightReady ? 1 : 0}`,
    '# HELP bayn_build_info Verified runtime build provenance.',
    '# TYPE bayn_build_info gauge',
    `bayn_build_info{source_revision="${prometheusLabel(provenance.sourceRevision)}",image_digest="${prometheusLabel(provenance.image.digest)}",verification="${prometheusLabel(provenanceVerification)}"} 1`,
  ]
  return `${lines.join('\n')}\n`
}

export const renderPrometheusMetrics = Pipeable.dual(4, renderPrometheusMetricsDataFirst)

const interpretResponseDecision = (
  decision: HttpResponseDecision,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  decision._tag === 'Json'
    ? HttpServerResponse.json(decision.body, {
        status: decision.status,
        headers: decision.headers,
      }).pipe(Effect.orDie)
    : Effect.succeed(
        HttpServerResponse.text(decision.body, {
          status: decision.status,
          contentType: decision.contentType,
          headers: decision.headers,
        }),
      )

const interpretHistoricalReadFailure = (
  runId: string,
  error: OperationalError,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const decision = historicalReadFailureDecision(runId, error)
  return Effect.logError(decision.log.message, decision.log.cause).pipe(
    Effect.annotateLogs(decision.log.annotations),
    Effect.andThen(interpretResponseDecision(decision.response)),
  )
}

const clientDisconnect = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<never> => {
  const incoming = NodeHttpServerRequest.toIncomingMessage(request)
  const socket = incoming.socket
  return Effect.scoped(
    Deferred.make<void>().pipe(
      Effect.flatMap((disconnected) => {
        const onDisconnect = () => {
          Deferred.doneUnsafe(disconnected, Effect.void)
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            incoming.once('aborted', onDisconnect)
            socket.once('close', onDisconnect)
            if (incoming.aborted || socket.destroyed) onDisconnect()
          }),
          () =>
            Effect.sync(() => {
              incoming.off('aborted', onDisconnect)
              socket.off('close', onDisconnect)
            }),
        ).pipe(Effect.andThen(Deferred.await(disconnected)), Effect.andThen(Effect.interrupt))
      }),
    ),
  )
}

const interruptOnClientDisconnect = <A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => Effect.raceFirst(effect, clientDisconnect(request)).pipe(Effect.interruptible)

type HttpConfig = Pick<
  RuntimeConfig,
  | 'cycleStallThresholdMs'
  | 'execution'
  | 'healthIntervalMs'
  | 'host'
  | 'operationTimeoutMs'
  | 'port'
  | 'reconciliationStaleThresholdMs'
  | 'unknownMutationThresholdMs'
>

export const HttpServerLive = (config: Pick<RuntimeConfig, 'host' | 'port'>) =>
  NodeHttpServer.layer(createServer, { host: config.host, port: config.port })

const registerHttpRoutes = (
  config: HttpConfig,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
  router: HttpRouter.HttpRouter,
  currentTimeMillis: Effect.Effect<number>,
): Effect.Effect<void> => {
  const freshnessLeaseMs = runtimeHealthFreshnessLeaseMs(config)
  const currentStateAndTime = Effect.all({ current: Ref.get(state), nowMs: currentTimeMillis })
  const ready = currentStateAndTime.pipe(
    Effect.map(({ current, nowMs }) => readinessResponseDecision(current, { nowMs, leaseMs: freshnessLeaseMs })),
    Effect.flatMap(interpretResponseDecision),
  )
  const status = currentStateAndTime.pipe(
    Effect.map(({ current, nowMs }) =>
      jsonDecision(
        statusFactsDataFirst(
          current,
          config.execution,
          provenance,
          provenanceVerification,
          runtimeReadyWithFreshness(current, { nowMs, leaseMs: freshnessLeaseMs }),
        ),
      ),
    ),
    Effect.flatMap(interpretResponseDecision),
  )
  const metrics = currentStateAndTime.pipe(
    Effect.map(({ current, nowMs }) =>
      textDecision(
        renderPrometheusMetricsDataFirst(
          current,
          config,
          provenance,
          provenanceVerification,
          runtimeReadyWithFreshness(current, { nowMs, leaseMs: freshnessLeaseMs }),
        ),
        'text/plain; version=0.0.4; charset=utf-8',
        { 'cache-control': 'no-store' },
      ),
    ),
    Effect.flatMap(interpretResponseDecision),
  )
  const historicalEvaluation = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    HttpRouter.params.pipe(
      Effect.map(({ runId }) => validateHistoricalRunRequest(runId)),
      Effect.flatMap((decision) => {
        if (decision._tag === 'Respond') return interpretResponseDecision(decision.response)
        return interruptOnClientDisconnect(
          request,
          readHistoricalEvidence(readEvidence(decision.runId), config.operationTimeoutMs),
        ).pipe(
          Effect.map(historicalEvidenceResponseDecision),
          Effect.flatMap(interpretResponseDecision),
          Effect.catch((error) => interpretHistoricalReadFailure(decision.runId, error)),
        )
      }),
    ),
  )
  const fallback = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    interpretResponseDecision(fallbackResponseDecision(request.method))
  return Effect.gen(function* () {
    yield* router.add('GET', '/livez', interpretResponseDecision(jsonDecision({ service: 'bayn', live: true })))
    yield* router.add('GET', '/readyz', ready)
    yield* router.add('GET', '/metrics', metrics)
    yield* router.add('GET', '/v1/status', status)
    yield* router.add('GET', '/v1/evaluations/:runId', historicalEvaluation)
    yield* router.add('*', '*', fallback)
  })
}

const serveHttpDataFirst = (
  config: HttpConfig,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
  currentTimeMillis: Effect.Effect<number> = Clock.currentTimeMillis,
): Effect.Effect<void, never, HttpServer.HttpServer | Scope.Scope> =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.make
    yield* registerHttpRoutes(
      config,
      state,
      provenance,
      provenanceVerification,
      readEvidence,
      router,
      currentTimeMillis,
    )
    // The router API erases the closed route error set to unknown; the total fallback makes any residue a defect.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const handler = router.asHttpEffect().pipe(Effect.orDie)
    yield* HttpServer.serveEffect(handler)
  })

export const serveHttp = Pipeable.dual(5, serveHttpDataFirst)

export const serveHttpWithCurrentTime = (
  config: HttpConfig,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
  currentTimeMillis: Effect.Effect<number>,
): Effect.Effect<void, never, HttpServer.HttpServer | Scope.Scope> =>
  serveHttpDataFirst(config, state, provenance, provenanceVerification, readEvidence, currentTimeMillis)
