import { createServer } from 'node:http'

import { NodeHttpServer, NodeHttpServerRequest } from '@effect/platform-node'
import { Deferred, Effect, Option, Ref, Scope } from 'effect'
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import { CycleOperationsCondition, CycleOperationsReason } from './cycle-observability'
import { CycleState, CycleTerminalReason } from './cycle'
import type { DatabaseError, EvidenceStoreService } from './db/evidence-store'
import type { OperationalError } from './errors'
import { BrokerAccess, CapitalAuthorityKind } from './execution/authority'
import type { ExecutionPolicy } from './execution/configuration'
import { databaseOperation, withinDeadline } from './operations'
import { Authority } from './execution/contracts'
import { makeQualificationDiagnosis } from './qualification-diagnosis'
import { isReady, type DependencyHealth, type RuntimeState } from './runtime-state'

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

const publicAutonomousCycleLoop = (state: RuntimeState) => {
  const lastPass = state.autonomousCycleLoop.lastPass
  return {
    configured: state.autonomousCycleLoop.configured,
    startedAt: state.autonomousCycleLoop.startedAt,
    lastPass:
      lastPass === null || lastPass.result === 'SUCCESS'
        ? lastPass
        : {
            result: lastPass.result,
            observedAt: lastPass.observedAt,
            operation: lastPass.operation,
            failure: lastPass.failure,
            reasonCode: 'AUTONOMOUS_CYCLE_PASS_FAILED',
          },
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

export const statusFacts = (
  state: RuntimeState,
  execution: ExecutionPolicy,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
) => {
  const broker = publicBrokerState(state)
  const dependencies = publicDependencies(state)
  return {
    service: 'bayn',
    operational: {
      status: state.status,
      ready: isReady(state),
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
      diagnosis:
        state.evidence === null
          ? null
          : makeQualificationDiagnosis(state.evidence.evaluation, state.evidence.qualification),
      executionProvenance: state.evidence?.provenance ?? null,
    },
    accounting: {
      status: accountingState(state),
      reconciliation: state.evidence?.reconciliation ?? null,
    },
    cycle: publicCycleState(state),
    autonomousCycleLoop: publicAutonomousCycleLoop(state),
    broker,
    authority: {
      brokerEnvironment: execution.brokerIdentity?.environment ?? null,
      brokerAccess: execution.brokerAccess,
      capitalAuthority: execution.capitalAuthority._tag,
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
                maximum: state.cycle.authority.maximum.toLowerCase(),
                effective: state.cycle.authority.effective.toLowerCase(),
                kill: state.cycle.authority.kill.toLowerCase(),
                reason: state.cycle.authority.reason,
                updatedAt: state.cycle.authority.updatedAt,
              },
      brokerOrders: execution.brokerAccess === BrokerAccess.Mutation,
      capitalPromotion: execution.capitalAuthority._tag !== CapitalAuthorityKind.None,
    },
    build: {
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      verification: provenanceVerification,
    },
    error: publicRuntimeError(state, broker, dependencies),
  } as const
}

export const statusResponseDecision = (
  state: RuntimeState,
  execution: ExecutionPolicy,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
): HttpResponseDecision => jsonDecision(statusFacts(state, execution, provenance, provenanceVerification))

const appendFailure = (failures: readonly string[], name: string, failed: boolean): readonly string[] =>
  failed && !failures.includes(name) ? [...failures, name] : failures

export const readinessResponseDecision = (state: RuntimeState): HttpResponseDecision => {
  const ready = isReady(state)
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
  const failedDependencies = appendFailure(
    cycleFailures,
    'cycleRunner',
    state.autonomousCycleLoop.lastPass?.result === 'FAILURE',
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

export const historicalReadFailureDecision = (runId: string, error: OperationalError) =>
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

export const readHistoricalEvidence = <A, R>(
  read: Effect.Effect<Option.Option<A>, DatabaseError, R>,
  timeoutMs: number,
): Effect.Effect<Option.Option<A>, OperationalError, R> =>
  withinDeadline(databaseOperation(read, 'read-evidence'), timeoutMs, 'database', 'read-evidence')

export const fallbackResponseDecision = (method: string): HttpResponseDecision =>
  method === 'GET'
    ? jsonDecision({ error: 'not_found' }, 404)
    : jsonDecision({ error: 'method_not_allowed' }, 405, { allow: 'GET' })

const prometheusLabel = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')

const prometheusNumber = (value: number): string => (Number.isFinite(value) ? String(value) : '0')

const epochSeconds = (instant: string | null | undefined): number =>
  instant === null || instant === undefined ? 0 : Date.parse(instant) / 1_000

const booleanMetric = (value: boolean | null): number => (value === true ? 1 : 0)

export const renderPrometheusMetrics = (
  state: RuntimeState,
  config: Pick<
    RuntimeConfig,
    'cycleStallThresholdMs' | 'execution' | 'reconciliationStaleThresholdMs' | 'unknownMutationThresholdMs'
  >,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
): string => {
  const publicBroker = publicBrokerState(state)
  const runtimeReady = isReady(state)
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
  const loopResults = ['unknown', 'success', 'failure'] as const
  const loopResult = state.autonomousCycleLoop.lastPass?.result.toLowerCase() ?? 'unknown'
  const loopHealthy =
    state.autonomousCycleLoop.configured &&
    state.health.dependencies.cycleRunner.status === 'AVAILABLE' &&
    state.autonomousCycleLoop.lastPass?.result !== 'FAILURE'
  const loopLastPassAgeMs =
    state.autonomousCycleLoop.lastPass === null || state.health.checkedAt === null
      ? undefined
      : Math.max(0, Date.parse(state.health.checkedAt) - Date.parse(state.autonomousCycleLoop.lastPass.observedAt))
  const effectiveAuthority =
    state.cycle.authority === null
      ? 'unknown'
      : state.cycle.authority.effective === Authority.Paper
        ? 'paper'
        : 'observe'
  const lines = [
    '# HELP bayn_runtime_ready Whether the bounded runtime state and required dependencies are operationally ready.',
    '# TYPE bayn_runtime_ready gauge',
    `bayn_runtime_ready ${runtimeReady ? 1 : 0}`,
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
          '# HELP bayn_cycle_submission_cutoff_timestamp_seconds Bound broker submission cutoff.',
          '# TYPE bayn_cycle_submission_cutoff_timestamp_seconds gauge',
          `bayn_cycle_submission_cutoff_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.current?.submissionCutoffAt))}`,
          '# HELP bayn_cycle_execution_close_timestamp_seconds Bound current execution-session close.',
          '# TYPE bayn_cycle_execution_close_timestamp_seconds gauge',
          `bayn_cycle_execution_close_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.current?.executionCloseAt))}`,
          '# HELP bayn_cycle_last_terminal_timestamp_seconds Latest terminal cycle timestamp.',
          '# TYPE bayn_cycle_last_terminal_timestamp_seconds gauge',
          `bayn_cycle_last_terminal_timestamp_seconds ${prometheusNumber(epochSeconds(state.cycle.last?.terminalAt))}`,
        ]
      : []),
    '# HELP bayn_cycle_stall_threshold_seconds Configured attempt-stall threshold.',
    '# TYPE bayn_cycle_stall_threshold_seconds gauge',
    `bayn_cycle_stall_threshold_seconds ${prometheusNumber(config.cycleStallThresholdMs / 1_000)}`,
    '# HELP bayn_autonomous_cycle_loop_configured Whether the in-process autonomous cycle loop is configured.',
    '# TYPE bayn_autonomous_cycle_loop_configured gauge',
    `bayn_autonomous_cycle_loop_configured ${state.autonomousCycleLoop.configured ? 1 : 0}`,
    '# HELP bayn_autonomous_cycle_loop_health_available Whether the configured scoped loop is live and has not failed or stalled.',
    '# TYPE bayn_autonomous_cycle_loop_health_available gauge',
    `bayn_autonomous_cycle_loop_health_available ${loopHealthy ? 1 : 0}`,
    '# HELP bayn_autonomous_cycle_loop_last_pass Latest bounded autonomous cycle pass result.',
    '# TYPE bayn_autonomous_cycle_loop_last_pass gauge',
    ...loopResults.map(
      (result) => `bayn_autonomous_cycle_loop_last_pass{result="${result}"} ${loopResult === result ? 1 : 0}`,
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
    ...(cycleObservationAvailable
      ? [
          '# HELP bayn_mutation_events_total Durable broker mutation event count.',
          '# TYPE bayn_mutation_events_total counter',
          `bayn_mutation_events_total ${state.cycle.mutations.eventCount}`,
          '# HELP bayn_unresolved_mutations Durable unresolved broker mutation count.',
          '# TYPE bayn_unresolved_mutations gauge',
          `bayn_unresolved_mutations ${state.cycle.mutations.unresolvedCount}`,
          '# HELP bayn_oldest_unresolved_mutation_age_seconds Age of the oldest unresolved broker mutation.',
          '# TYPE bayn_oldest_unresolved_mutation_age_seconds gauge',
          `bayn_oldest_unresolved_mutation_age_seconds ${prometheusNumber((state.cycle.oldestUnresolvedMutationAgeMs ?? 0) / 1_000)}`,
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
    '# HELP bayn_broker_access Configured broker access capability.',
    '# TYPE bayn_broker_access gauge',
    `bayn_broker_access{access="read-only"} ${config.execution.brokerAccess === BrokerAccess.ReadOnly ? 1 : 0}`,
    `bayn_broker_access{access="mutation"} ${config.execution.brokerAccess === BrokerAccess.Mutation ? 1 : 0}`,
    '# HELP bayn_capital_authority Configured capital authority.',
    '# TYPE bayn_capital_authority gauge',
    ...Object.values(CapitalAuthorityKind).map(
      (authority) =>
        `bayn_capital_authority{authority="${authority}"} ${config.execution.capitalAuthority._tag === authority ? 1 : 0}`,
    ),
    ...(cycleObservationAvailable
      ? [
          '# HELP bayn_authority_effective Durable effective authority when initialized.',
          '# TYPE bayn_authority_effective gauge',
          ...(['unknown', 'observe', 'paper'] as const).map(
            (authority) =>
              `bayn_authority_effective{authority="${authority}"} ${effectiveAuthority === authority ? 1 : 0}`,
          ),
          '# HELP bayn_authority_coherent Whether durable and configured authority agree.',
          '# TYPE bayn_authority_coherent gauge',
          `bayn_authority_coherent ${state.cycle.alerts.authorityIncoherent ? 0 : 1}`,
          '# HELP bayn_authority_kill_active Whether the durable paper kill is active.',
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
    `bayn_broker_orders_enabled ${config.execution.brokerAccess === BrokerAccess.Mutation ? 1 : 0}`,
    '# HELP bayn_capital_promotion_enabled Whether capital promotion is enabled in this runtime.',
    '# TYPE bayn_capital_promotion_enabled gauge',
    `bayn_capital_promotion_enabled ${config.execution.capitalAuthority._tag === CapitalAuthorityKind.None ? 0 : 1}`,
    '# HELP bayn_build_info Verified runtime build provenance.',
    '# TYPE bayn_build_info gauge',
    `bayn_build_info{source_revision="${prometheusLabel(provenance.sourceRevision)}",image_digest="${prometheusLabel(provenance.image.digest)}",verification="${prometheusLabel(provenanceVerification)}"} 1`,
  ]
  return `${lines.join('\n')}\n`
}

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
): Effect.Effect<void> => {
  const ready = Ref.get(state).pipe(Effect.map(readinessResponseDecision), Effect.flatMap(interpretResponseDecision))
  const status = Ref.get(state).pipe(
    Effect.map((current) => statusResponseDecision(current, config.execution, provenance, provenanceVerification)),
    Effect.flatMap(interpretResponseDecision),
  )
  const metrics = Ref.get(state).pipe(
    Effect.map((current) =>
      textDecision(
        renderPrometheusMetrics(current, config, provenance, provenanceVerification),
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

export const serveHttp = (
  config: HttpConfig,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
): Effect.Effect<void, never, HttpServer.HttpServer | Scope.Scope> =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.make
    yield* registerHttpRoutes(config, state, provenance, provenanceVerification, readEvidence, router)
    // The router API erases the closed route error set to unknown; the total fallback makes any residue a defect.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const handler = router.asHttpEffect().pipe(Effect.orDie)
    yield* HttpServer.serveEffect(handler)
  })
