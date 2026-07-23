import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Option, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import { CycleOperationsCondition, CycleOperationsReason } from './cycle-observability'
import { CycleState } from './cycle'
import { Authority } from './paper'
import { isReady, type DependencyHealth, type RuntimeState } from './runtime-state'

type ReadEvidence = (runId: string) => Effect.Effect<Option.Option<unknown>, { readonly message: string }>

const verifiedState = (state: RuntimeState, dependency: DependencyHealth) => {
  if (state.evidence === null || dependency.status === 'UNKNOWN') return 'UNKNOWN'
  return dependency.status === 'AVAILABLE' ? 'CURRENT' : 'INVALID'
}

const publicBrokerState = (state: RuntimeState) =>
  state.broker === null
    ? {
        configured: false,
        expectedAccountId: null,
        accountId: null,
        accountBound: false,
        readAvailable: false,
        checkedAt: null,
        executionEligible: false,
        executionDisabledReason: 'ALPACA_NOT_CONFIGURED',
        error: null,
      }
    : state.broker

const publicCycleState = (state: RuntimeState) =>
  state.cycle.condition === CycleOperationsCondition.Unknown
    ? {
        schemaVersion: state.cycle.schemaVersion,
        observationAvailable: false,
        condition: state.cycle.condition,
        reason: state.cycle.reason,
        checkedAt: state.cycle.checkedAt,
        zeroMutation: null,
        error: state.cycle.error,
      }
    : {
        ...state.cycle,
        observationAvailable: true,
      }

const publicState = (
  state: RuntimeState,
  maximumAuthority: Authority,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
) => {
  let accounting = 'UNKNOWN'
  if (state.evidence !== null) {
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
      executionProvenance: state.evidence?.provenance ?? null,
    },
    accounting: {
      status: accounting,
      reconciliation: state.evidence?.reconciliation ?? null,
    },
    cycle: publicCycleState(state),
    autonomousCycleLoop: state.autonomousCycleLoop,
    broker: publicBrokerState(state),
    authority: {
      maximum: maximumAuthority === Authority.Paper ? 'paper' : 'observe',
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
                maximum: state.cycle.authority.maximum === Authority.Paper ? 'paper' : 'observe',
                effective: state.cycle.authority.effective === Authority.Paper ? 'paper' : 'observe',
                kill: state.cycle.authority.kill.toLowerCase(),
                reason: state.cycle.authority.reason,
                updatedAt: state.cycle.authority.updatedAt,
              },
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
    'cycleStallThresholdMs' | 'maximumAuthority' | 'reconciliationStaleThresholdMs' | 'unknownMutationThresholdMs'
  >,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
): string => {
  const publicBroker = publicBrokerState(state)
  const cycleObservationAvailable = state.cycle.condition !== CycleOperationsCondition.Unknown
  const cyclePhase =
    cycleObservationAvailable === false
      ? 'unknown'
      : (state.cycle.current?.phase ?? state.cycle.last?.phase ?? 'none').toLowerCase()
  const conditions = Object.values(CycleOperationsCondition)
  const reasons = Object.values(CycleOperationsReason)
  const phases = ['unknown', 'none', ...Object.values(CycleState).map((phase) => phase.toLowerCase())]
  const loopResults = ['unknown', 'success', 'failure'] as const
  const loopResult = state.autonomousCycleLoop.lastPass?.result.toLowerCase() ?? 'unknown'
  const loopHealthy =
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
    '# HELP bayn_autonomous_cycle_loop_health_available Whether the scoped loop is live and its latest pass succeeded.',
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
    '# HELP bayn_authority_maximum Configured maximum authority.',
    '# TYPE bayn_authority_maximum gauge',
    `bayn_authority_maximum{authority="observe"} ${config.maximumAuthority === Authority.Observe ? 1 : 0}`,
    `bayn_authority_maximum{authority="paper"} ${config.maximumAuthority === Authority.Paper ? 1 : 0}`,
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
    'bayn_broker_orders_enabled 0',
    '# HELP bayn_capital_promotion_enabled Whether capital promotion is enabled in this runtime.',
    '# TYPE bayn_capital_promotion_enabled gauge',
    'bayn_capital_promotion_enabled 0',
    '# HELP bayn_build_info Verified runtime build provenance.',
    '# TYPE bayn_build_info gauge',
    `bayn_build_info{source_revision="${prometheusLabel(provenance.sourceRevision)}",image_digest="${prometheusLabel(provenance.image.digest)}",verification="${prometheusLabel(provenanceVerification)}"} 1`,
  ]
  return `${lines.join('\n')}\n`
}

const jsonResponse = (body: unknown, status = 200, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.json(body, { status, headers }).pipe(Effect.orDie)

export const makeHttpLayer = (
  config: Pick<
    RuntimeConfig,
    | 'cycleStallThresholdMs'
    | 'host'
    | 'maximumAuthority'
    | 'operationTimeoutMs'
    | 'port'
    | 'reconciliationStaleThresholdMs'
    | 'unknownMutationThresholdMs'
  >,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
): ReturnType<typeof NodeHttpServer.layer> => {
  const ready = Ref.get(state).pipe(
    Effect.flatMap((current) => {
      const ready = isReady(current)
      const failedDependencies = Object.entries(current.health.dependencies)
        .filter(([, dependency]) => dependency.status !== 'AVAILABLE')
        .map(([name]) => name)
      if (current.broker !== null && (current.broker.accountBound !== true || current.broker.readAvailable !== true)) {
        failedDependencies.push('broker')
      }
      if (
        current.cycle.condition === CycleOperationsCondition.Unknown ||
        current.cycle.condition === CycleOperationsCondition.Stalled ||
        current.cycle.condition === CycleOperationsCondition.Failed
      ) {
        if (!failedDependencies.includes('cycle')) failedDependencies.push('cycle')
      }
      if (current.autonomousCycleLoop.lastPass?.result === 'FAILURE' && !failedDependencies.includes('cycleRunner')) {
        failedDependencies.push('cycleRunner')
      }
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
    Effect.flatMap((current) =>
      jsonResponse(publicState(current, config.maximumAuthority, provenance, provenanceVerification)),
    ),
  )
  const metrics = Ref.get(state).pipe(
    Effect.map((current) =>
      HttpServerResponse.text(renderPrometheusMetrics(current, config, provenance, provenanceVerification), {
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
      }),
    ),
  )
  const historicalEvaluation = HttpRouter.params.pipe(
    Effect.flatMap(({ runId }) => {
      if (runId === undefined || !/^[0-9a-f]{64}$/.test(runId)) {
        return jsonResponse({ error: 'invalid_run_id' }, 400)
      }
      return readEvidence(runId).pipe(
        Effect.timeoutOrElse({
          duration: config.operationTimeoutMs,
          orElse: () => Effect.fail(new Error(`evidence read timed out after ${config.operationTimeoutMs}ms`)),
        }),
        Effect.flatMap((stored) =>
          Option.match(stored, {
            onNone: () => jsonResponse({ error: 'evaluation_not_found' }, 404),
            onSome: (evidence) => jsonResponse(evidence),
          }),
        ),
        Effect.catch((error) =>
          Effect.logError('Bayn historical evidence read failed').pipe(
            Effect.annotateLogs({ service: 'bayn', runId, error: error.message }),
            Effect.andThen(jsonResponse({ error: 'evidence_unavailable' }, 503)),
          ),
        ),
      )
    }),
  )
  const fallback = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    request.method === 'GET'
      ? jsonResponse({ error: 'not_found' }, 404)
      : jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  const routes = HttpRouter.addAll([
    HttpRouter.route('GET', '/livez', jsonResponse({ service: 'bayn', live: true })),
    HttpRouter.route('GET', '/readyz', ready),
    HttpRouter.route('GET', '/metrics', metrics),
    HttpRouter.route('GET', '/v1/status', status),
    HttpRouter.route('GET', '/v1/evaluations/:runId', historicalEvaluation),
    HttpRouter.route('*', '*', fallback),
  ] as const)

  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: config.host, port: config.port })),
  )
}
