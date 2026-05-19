import { Context, Data, Effect, Layer } from 'effect'

import { assessAgentRunIngestion, getAgentsControllerHealth, type AgentsControllerHealth } from './agents-controller'
import type { GrpcStatus } from './control-plane-grpc'
import { resolveGrpcStatus } from './control-plane-grpc'
import { getLeaderElectionStatus, type LeaderElectionStatus } from './leader-election'
import { getOrchestrationControllerHealth } from './orchestration-controller'
import { resolveRuntimeServiceName } from './runtime-identity'
import { getSupportingControllerHealth } from './supporting-primitives-controller'

type ControllerHealthSnapshot = {
  enabled: boolean
  started: boolean
  namespaces?: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
}

type EnvSource = Record<string, string | undefined>
type ComponentStatus = 'healthy' | 'degraded' | 'disabled' | 'unknown'

export type HeartbeatAuthoritySource = {
  mode: 'heartbeat' | 'local' | 'rollout' | 'unknown'
  namespace: string
  source_deployment: string
  source_pod: string
  observed_at: string | null
  fresh: boolean
  message: string
}

export type ControllerStatus = {
  name: string
  enabled: boolean
  started: boolean
  scope_namespaces: string[]
  crds_ready: boolean
  missing_crds: string[]
  last_checked_at: string
  status: ComponentStatus
  message: string
  authority: HeartbeatAuthoritySource
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: ComponentStatus | 'configured'
  message: string
  endpoint: string
  authority: HeartbeatAuthoritySource
}

export type AgentsControlPlaneStatus = {
  service: string
  generated_at: string
  leader_election: {
    enabled: boolean
    required: boolean
    is_leader: boolean
    lease_name: string
    lease_namespace: string
    identity: string
    last_transition_at: string
    last_attempt_at: string
    last_success_at: string
    last_error: string
  }
  controllers: ControllerStatus[]
  runtime_adapters: RuntimeAdapterStatus[]
  database: {
    configured: boolean
    connected: boolean
    status: 'disabled' | 'healthy' | 'degraded' | 'unknown'
    message: string
    latency_ms: number
    migration_consistency: {
      status: 'unknown'
      migration_table: string | null
      registered_count: number
      applied_count: number
      unapplied_count: number
      unexpected_count: number
      latest_registered: string | null
      latest_applied: string | null
      missing_migrations: string[]
      unexpected_migrations: string[]
      message: string
    }
  }
  grpc: GrpcStatus
  watch_reliability: {
    status: 'unknown'
    window_minutes: number
    observed_streams: number
    total_events: number
    total_errors: number
    total_restarts: number
    streams: unknown[]
  }
  agentrun_ingestion: {
    namespace: string
    status: 'healthy' | 'degraded' | 'unknown'
    message: string
    last_watch_event_at: string | null
    last_resync_at: string | null
    untouched_run_count: number
    oldest_untouched_age_seconds: number | null
  }
  runtime_kits: unknown[]
  admission_passports: unknown[]
  serving_passport_id: string | null
  recovery_warrants: unknown[]
  runtime_proof_cells: unknown[]
  projection_watermarks: unknown[]
  workflows: {
    active_job_runs: number
    recent_failed_jobs: number
    backoff_limit_exceeded_jobs: number
    window_minutes: number
    top_failure_reasons: unknown[]
    data_confidence: 'unknown'
    collection_errors: number
    collected_namespaces: number
    target_namespaces: number
    message: string
  }
  dependency_quorum: { status: 'unknown'; message: string }
  failure_domain_leases: { status: 'unknown'; leases: unknown[]; message: string }
  reconciled_action_clocks: unknown[]
  negative_evidence_router: { status: 'unknown'; routes: unknown[]; message: string }
  action_slo_budgets: unknown[]
  torghut_action_slo_budgets: unknown[]
  dependency_verdict_exchange: { status: 'unknown'; message: string }
  source_serving_contract_verdict_exchange: { status: 'unknown'; message: string }
  control_plane_controller_witness: { status: 'unknown'; message: string }
  controller_ingestion_settlement: { status: 'unknown'; message: string }
  material_action_verdict_epoch: { status: 'unknown'; message: string }
  material_action_verdicts: unknown[]
  material_action_activation_receipts: unknown[]
  action_custody_receipts: unknown[]
  stage_clearance_packets: unknown[]
  projection_foreclosure_notary: unknown | null
  stage_credit_ledger: unknown | null
  ready_truth_arbiter: { serving_readiness: 'unknown'; message: string }
  revenue_repair_settlement_custody: { status: 'unknown'; message: string }
  verify_trust_foreclosure_board: { status: 'unknown'; message: string }
  rollout_proof_passport: { status: 'unknown'; message: string }
  runner_capacity_futures: unknown[]
  stage_launch_tickets: unknown[]
  authority_provenance_settlement: { status: 'unknown'; message: string }
  evidence_pressure_ledger: unknown | null
  terminal_debt_compaction_ledger: unknown | null
  ready_action_exchange: { status: 'unknown'; message: string }
  repair_bid_admission: { status: 'unknown'; message: string }
  material_gate_digest: { status: 'unknown'; message: string }
  material_evidence_settlement_spine: { status: 'unknown'; message: string }
  material_reentry_clearinghouse: unknown | null
  repair_slot_escrow: unknown | null
  repair_warrant_exchange: { status: 'unknown'; message: string }
  consumer_evidence_leases: { status: 'unknown'; leases: unknown[]; message: string }
  clearance_market_ledger: unknown | null
  source_rollout_truth_exchange: { status: 'unknown'; message: string }
  route_stability_escrow: { status: 'unknown'; message: string }
  execution_trust: {
    status: 'unknown'
    reason: string
    last_evaluated_at: string
    blocking_windows: unknown[]
    evidence_summary: string[]
  }
  swarms: unknown[]
  stages: unknown[]
  rollout_health: {
    status: 'unknown'
    observed_deployments: number
    degraded_deployments: number
    deployments: unknown[]
    message: string
  }
  empirical_services: {
    forecast: { status: 'unknown'; endpoint: string; message: string; authoritative: boolean }
    lean: { status: 'unknown'; endpoint: string; message: string; authoritative: boolean }
    jobs: { status: 'unknown'; endpoint: string; message: string; authoritative: boolean }
  }
  torghut_consumer_evidence: { status: 'disabled'; reason_codes: string[]; message: string }
  namespaces: Array<{
    namespace: string
    status: 'healthy' | 'degraded'
    degraded_components: string[]
  }>
}

export type AgentsControlPlaneStatusView = 'full' | 'schedule-runner'

export class AgentsControlPlaneStatusError extends Data.TaggedError('AgentsControlPlaneStatusError')<{
  readonly operation: string
  readonly message: string
}> {}

export type BuildAgentsControlPlaneStatusInput = {
  namespace: string
  grpc: GrpcStatus
  service?: string
  now?: Date
  env?: EnvSource
}

export type GetAgentsControlPlaneStatusInput = Omit<BuildAgentsControlPlaneStatusInput, 'grpc'> & {
  grpc?: GrpcStatus
}

export type AgentsControlPlaneStatusDependencies = {
  now?: () => Date
  env?: EnvSource
  resolveGrpcStatus?: () => Promise<GrpcStatus>
  getLeaderElectionStatus?: () => LeaderElectionStatus
  getAgentsControllerHealth?: () => AgentsControllerHealth
  getOrchestrationControllerHealth?: () => ControllerHealthSnapshot
  getSupportingControllerHealth?: () => ControllerHealthSnapshot
  assessAgentRunIngestion?: typeof assessAgentRunIngestion
}

export type AgentsControlPlaneStatusService = {
  get: (
    input: GetAgentsControlPlaneStatusInput,
  ) => Effect.Effect<AgentsControlPlaneStatus, AgentsControlPlaneStatusError>
}

export class AgentsControlPlaneStatusApi extends Context.Tag('AgentsControlPlaneStatusApi')<
  AgentsControlPlaneStatusApi,
  AgentsControlPlaneStatusService
>() {}

const compatibilityUnavailableMessage =
  'generic Agents status does not include domain-specific material control-plane evidence'

const buildAuthority = (namespace: string, now: Date, message: string): HeartbeatAuthoritySource => ({
  mode: 'local',
  namespace,
  source_deployment: '',
  source_pod: '',
  observed_at: now.toISOString(),
  fresh: true,
  message,
})

const resolveControllerStatus = (health: ControllerHealthSnapshot): ComponentStatus => {
  if (!health.enabled) return 'disabled'
  if (health.started && health.crdsReady !== false) return 'healthy'
  if (health.crdsReady === false) return 'degraded'
  return 'unknown'
}

const resolveControllerMessage = (health: ControllerHealthSnapshot) => {
  if (!health.enabled) return 'disabled'
  if (health.crdsReady === false) return `missing CRDs: ${health.missingCrds.join(', ')}`
  if (!health.started) return 'controller not started'
  return ''
}

const buildControllerStatus = (
  name: string,
  health: ControllerHealthSnapshot,
  namespace: string,
  now: Date,
): ControllerStatus => ({
  name,
  enabled: health.enabled,
  started: health.started,
  scope_namespaces: health.namespaces ?? [],
  crds_ready: health.crdsReady === true,
  missing_crds: health.missingCrds,
  last_checked_at: health.lastCheckedAt ?? '',
  status: resolveControllerStatus(health),
  message: resolveControllerMessage(health),
  authority: buildAuthority(namespace, now, `${name} local controller state`),
})

const buildLeaderElectionStatus = (leaderElection: LeaderElectionStatus) => ({
  enabled: leaderElection.enabled,
  required: leaderElection.required,
  is_leader: leaderElection.isLeader,
  lease_name: leaderElection.leaseName,
  lease_namespace: leaderElection.leaseNamespace,
  identity: leaderElection.identity,
  last_transition_at: leaderElection.lastTransitionAt ?? '',
  last_attempt_at: leaderElection.lastAttemptAt ?? '',
  last_success_at: leaderElection.lastSuccessAt ?? '',
  last_error: leaderElection.lastError ?? '',
})

const resolveRuntimeAdapterComponentStatus = (controller: ControllerStatus): ComponentStatus | 'configured' => {
  if (controller.status === 'healthy') return 'healthy'
  if (controller.status === 'disabled') return 'disabled'
  return 'unknown'
}

const buildRuntimeAdapterStatus = (
  name: string,
  controller: ControllerStatus,
  namespace: string,
  now: Date,
): RuntimeAdapterStatus => ({
  name,
  available: controller.status === 'healthy',
  status: resolveRuntimeAdapterComponentStatus(controller),
  message: controller.status === 'healthy' ? `${name} runtime via Kubernetes Jobs` : `${name} runtime unavailable`,
  endpoint: '',
  authority: buildAuthority(namespace, now, `${name} runtime derived from local controller state`),
})

const buildDatabaseStatus = (env: EnvSource) => {
  const configured = Boolean(env.DATABASE_URL)
  return {
    configured,
    connected: false,
    status: configured ? ('unknown' as const) : ('disabled' as const),
    message: configured ? 'database connectivity is reported by API calls' : 'DATABASE_URL is not set',
    latency_ms: 0,
    migration_consistency: {
      status: 'unknown' as const,
      migration_table: null,
      registered_count: 0,
      applied_count: 0,
      unapplied_count: 0,
      unexpected_count: 0,
      latest_registered: null,
      latest_applied: null,
      missing_migrations: [],
      unexpected_migrations: [],
      message: 'migration consistency is not evaluated by the generic status builder',
    },
  }
}

const buildAgentRunIngestionStatus = (
  namespace: string,
  health: AgentsControllerHealth,
  deps: Pick<AgentsControlPlaneStatusDependencies, 'assessAgentRunIngestion'>,
) => {
  const assessment = (deps.assessAgentRunIngestion ?? assessAgentRunIngestion)(namespace, health)
  return {
    namespace,
    status: assessment.status,
    message: assessment.message,
    last_watch_event_at: assessment.lastWatchEventAt,
    last_resync_at: assessment.lastResyncAt,
    untouched_run_count: assessment.untouchedRunCount,
    oldest_untouched_age_seconds: assessment.oldestUntouchedAgeSeconds,
  }
}

const buildUnknownDependency = (message = compatibilityUnavailableMessage) => ({
  status: 'unknown' as const,
  message,
})

const buildEmpiricalDependency = () => ({
  status: 'unknown' as const,
  endpoint: '',
  message: compatibilityUnavailableMessage,
  authoritative: false,
})

const buildDegradedComponents = (input: {
  controllers: ControllerStatus[]
  runtimeAdapters: RuntimeAdapterStatus[]
  grpc: GrpcStatus
  agentRunIngestion: AgentsControlPlaneStatus['agentrun_ingestion']
}) => [
  ...input.controllers
    .filter((controller) => controller.status === 'degraded')
    .map((controller) => `controller:${controller.name}`),
  ...input.runtimeAdapters
    .filter((adapter) => adapter.status === 'degraded')
    .map((adapter) => `runtime_adapter:${adapter.name}`),
  ...(input.grpc.status === 'degraded' ? ['grpc'] : []),
  ...(input.agentRunIngestion.status === 'degraded' ? ['agentrun_ingestion'] : []),
]

export const buildAgentsControlPlaneStatus = (
  input: BuildAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
): AgentsControlPlaneStatus => {
  const now = input.now ?? deps.now?.() ?? new Date()
  const env = input.env ?? deps.env ?? process.env
  const namespace = input.namespace
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const controllers = [
    buildControllerStatus('agents-controller', agentsHealth, namespace, now),
    buildControllerStatus(
      'orchestration-controller',
      (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)(),
      namespace,
      now,
    ),
    buildControllerStatus(
      'supporting-controller',
      (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)(),
      namespace,
      now,
    ),
  ]
  const workflowController = controllers.find((controller) => controller.name === 'agents-controller') ?? controllers[0]
  const runtimeAdapters = [
    buildRuntimeAdapterStatus('workflow', workflowController, namespace, now),
    buildRuntimeAdapterStatus('job', workflowController, namespace, now),
    {
      name: 'custom',
      available: true,
      status: 'unknown' as const,
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
      authority: buildAuthority(namespace, now, 'custom runtime is resolved per AgentRun'),
    },
  ]
  const agentRunIngestion = buildAgentRunIngestionStatus(namespace, agentsHealth, deps)
  const degradedComponents = buildDegradedComponents({
    controllers,
    runtimeAdapters,
    grpc: input.grpc,
    agentRunIngestion,
  })

  return {
    service: input.service ?? resolveRuntimeServiceName(),
    generated_at: now.toISOString(),
    leader_election: buildLeaderElectionStatus((deps.getLeaderElectionStatus ?? getLeaderElectionStatus)()),
    controllers,
    runtime_adapters: runtimeAdapters,
    database: buildDatabaseStatus(env),
    grpc: input.grpc,
    watch_reliability: {
      status: 'unknown',
      window_minutes: 0,
      observed_streams: 0,
      total_events: 0,
      total_errors: 0,
      total_restarts: 0,
      streams: [],
    },
    agentrun_ingestion: agentRunIngestion,
    runtime_kits: [],
    admission_passports: [],
    serving_passport_id: null,
    recovery_warrants: [],
    runtime_proof_cells: [],
    projection_watermarks: [],
    workflows: {
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 0,
      top_failure_reasons: [],
      data_confidence: 'unknown',
      collection_errors: 0,
      collected_namespaces: 0,
      target_namespaces: 1,
      message: compatibilityUnavailableMessage,
    },
    dependency_quorum: buildUnknownDependency(),
    failure_domain_leases: { status: 'unknown', leases: [], message: compatibilityUnavailableMessage },
    reconciled_action_clocks: [],
    negative_evidence_router: { status: 'unknown', routes: [], message: compatibilityUnavailableMessage },
    action_slo_budgets: [],
    torghut_action_slo_budgets: [],
    dependency_verdict_exchange: buildUnknownDependency(),
    source_serving_contract_verdict_exchange: buildUnknownDependency(),
    control_plane_controller_witness: buildUnknownDependency(),
    controller_ingestion_settlement: buildUnknownDependency(),
    material_action_verdict_epoch: buildUnknownDependency(),
    material_action_verdicts: [],
    material_action_activation_receipts: [],
    action_custody_receipts: [],
    stage_clearance_packets: [],
    projection_foreclosure_notary: null,
    stage_credit_ledger: null,
    ready_truth_arbiter: { serving_readiness: 'unknown', message: compatibilityUnavailableMessage },
    revenue_repair_settlement_custody: buildUnknownDependency(),
    verify_trust_foreclosure_board: buildUnknownDependency(),
    rollout_proof_passport: buildUnknownDependency(),
    runner_capacity_futures: [],
    stage_launch_tickets: [],
    authority_provenance_settlement: buildUnknownDependency(),
    evidence_pressure_ledger: null,
    terminal_debt_compaction_ledger: null,
    ready_action_exchange: buildUnknownDependency(),
    repair_bid_admission: buildUnknownDependency(),
    material_gate_digest: buildUnknownDependency(),
    material_evidence_settlement_spine: buildUnknownDependency(),
    material_reentry_clearinghouse: null,
    repair_slot_escrow: null,
    repair_warrant_exchange: buildUnknownDependency(),
    consumer_evidence_leases: { status: 'unknown', leases: [], message: compatibilityUnavailableMessage },
    clearance_market_ledger: null,
    source_rollout_truth_exchange: buildUnknownDependency(),
    route_stability_escrow: buildUnknownDependency(),
    execution_trust: {
      status: 'unknown',
      reason: compatibilityUnavailableMessage,
      last_evaluated_at: now.toISOString(),
      blocking_windows: [],
      evidence_summary: [],
    },
    swarms: [],
    stages: [],
    rollout_health: {
      status: 'unknown',
      observed_deployments: 0,
      degraded_deployments: 0,
      deployments: [],
      message: compatibilityUnavailableMessage,
    },
    empirical_services: {
      forecast: buildEmpiricalDependency(),
      lean: buildEmpiricalDependency(),
      jobs: buildEmpiricalDependency(),
    },
    torghut_consumer_evidence: {
      status: 'disabled',
      reason_codes: ['torghut_consumer_evidence_not_owned_by_agents_status'],
      message: 'Torghut consumer evidence is not part of the generic Agents control-plane status contract',
    },
    namespaces: [
      {
        namespace,
        status: degradedComponents.length > 0 ? 'degraded' : 'healthy',
        degraded_components: degradedComponents,
      },
    ],
  }
}

export const resolveAgentsControlPlaneStatusView = (value: string | null | undefined): AgentsControlPlaneStatusView => {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'schedule-runner' || normalized === 'schedule_runner' || normalized === 'runner'
    ? 'schedule-runner'
    : 'full'
}

export const projectAgentsControlPlaneStatus = (
  status: AgentsControlPlaneStatus,
  view: AgentsControlPlaneStatusView | string | null | undefined,
) => {
  if (resolveAgentsControlPlaneStatusView(view) !== 'schedule-runner') return status

  return {
    service: status.service,
    generated_at: status.generated_at,
    runtime_kits: status.runtime_kits,
    admission_passports: status.admission_passports,
    serving_passport_id: status.serving_passport_id,
    recovery_warrants: status.recovery_warrants,
    runtime_proof_cells: status.runtime_proof_cells,
    stage_clearance_packets: status.stage_clearance_packets,
    stage_credit_ledger: status.stage_credit_ledger,
    evidence_pressure_ledger: status.evidence_pressure_ledger,
    clearance_market_ledger: status.clearance_market_ledger,
    material_reentry_clearinghouse: status.material_reentry_clearinghouse,
  }
}

const toStatusError = (operation: string) => (error: unknown) =>
  new AgentsControlPlaneStatusError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  })

export const createAgentsControlPlaneStatusService = (
  deps: AgentsControlPlaneStatusDependencies = {},
): AgentsControlPlaneStatusService => ({
  get: (input) =>
    Effect.gen(function* () {
      const grpc =
        input.grpc ??
        (yield* Effect.tryPromise({
          try: () => (deps.resolveGrpcStatus ?? resolveGrpcStatus)(),
          catch: toStatusError('resolveGrpcStatus'),
        }))

      return yield* Effect.try({
        try: () => buildAgentsControlPlaneStatus({ ...input, grpc }, deps),
        catch: toStatusError('buildControlPlaneStatus'),
      })
    }),
})

export const AgentsControlPlaneStatusApiLive = Layer.succeed(
  AgentsControlPlaneStatusApi,
  createAgentsControlPlaneStatusService(),
)

export const getAgentsControlPlaneStatusEffect = (input: GetAgentsControlPlaneStatusInput) =>
  Effect.flatMap(AgentsControlPlaneStatusApi, (service) => service.get(input))

export const getAgentsControlPlaneStatus = (
  input: GetAgentsControlPlaneStatusInput,
  deps: AgentsControlPlaneStatusDependencies = {},
) => Effect.runPromise(createAgentsControlPlaneStatusService(deps).get(input))
